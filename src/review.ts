import { ChildProcess, execFile, spawn } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import type { BridgeEndpoint } from './bridge';

const execFileAsync = promisify(execFile);

/** Cursor and colour sequences; the log channel prints them as literal noise. */
const ANSI_ESCAPE = /\u001B\[[0-9;?]*[A-Za-z]/g;
/** Progress frames Sashiko repaints in place, which belong in the progress UI. */
const PROGRESS_FRAME = /^(Overall:|\[Patch \d+\])/;

/** Flat finding produced by `sashiko-vscode-bridge parse-review`. */
export interface Finding {
	file?: string;
	line?: number;
	endLine?: number;
	severity: string;
	title?: string;
	message: string;
	commit?: string;
	/** Absolute path in the user's checkout, filled in once the review completes. */
	resolvedFile?: string;
}

/** Scratch worktree produced by `sashiko-vscode-bridge prepare`. */
export interface PreparedWorktree {
	worktree: string;
	baseline: string;
	range: string;
	commits: number;
}

export interface ReviewContext {
	endpoint: BridgeEndpoint;
	model: vscode.LanguageModelChat;
	settingsPath: string;
	repository: string;
	/** Where findings should be reported, when the review ran in a scratch worktree. */
	diagnosticsRoot?: string;
}

export class ReviewRunner implements vscode.Disposable {
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('sashiko');
	private active?: ChildProcess;

	constructor(
		private readonly bridgePath: string,
		private readonly log: vscode.LogOutputChannel
	) {}

	get isRunning(): boolean {
		return this.active !== undefined;
	}

	/** Renders the Settings.toml that wires Sashiko to the loopback bridge. */
	async writeSettings(
		endpoint: BridgeEndpoint,
		model: vscode.LanguageModelChat,
		repository: string,
		destination: string
	): Promise<void> {
		const config = vscode.workspace.getConfiguration('sashiko');
		const maxInput = Math.min(
			config.get<number>('maxInputTokens', 100000),
			model.maxInputTokens || Number.MAX_SAFE_INTEGER
		);

		await execFileAsync(this.bridgePath, [
			'settings',
			'--base-url', endpoint.baseUrl,
			'--model', model.id,
			'--repository-path', repository,
			'--worktree-dir', config.get<string>('worktreeDir', 'review_trees'),
			'--provider', config.get<string>('provider', 'openai-compatible'),
			'--context-window-size', String(model.maxInputTokens || maxInput),
			'--max-tokens', String(config.get<number>('maxOutputTokens', 16384)),
			'--max-input-tokens', String(maxInput),
			'--concurrency', String(config.get<number>('concurrency', 1)),
			'--out', destination
		]);
		this.log.info(`wrote ${destination} (model ${model.id})`);
	}

	async run(
		range: string,
		context: ReviewContext,
		onOutput?: (line: string) => void
	): Promise<Finding[]> {
		if (this.active) {
			throw new Error('A Sashiko review is already running.');
		}

		const config = vscode.workspace.getConfiguration('sashiko');
		const executable = config.get<string>('executable', 'sashiko');
		const args = config
			.get<string[]>('reviewArgs', [])
			.map((arg) =>
				arg
					.replace('${range}', range)
					.replace('${settings}', context.settingsPath)
					.replace('${repository}', context.repository)
			);

		this.log.info(`$ ${executable} ${args.join(' ')}`);

		const { output, errors, code } = await this.spawnReview(executable, args, context, onOutput);
		const findings = await this.publishFindings(
			output,
			context.diagnosticsRoot ?? context.repository,
			context.diagnosticsRoot ? context.repository : undefined
		);

		// Sashiko exits 1 both for a review that reported high/critical findings and for
		// one that never ran, so the report has to break the tie.
		if (code !== 0 && findings.length === 0) {
			throw new Error(
				reportedError(errors) ??
					`Sashiko exited with code ${code ?? 'unknown'}. See the Sashiko log.`
			);
		}
		return findings;
	}

	/** Stages patch files or uncommitted work as commits in a throwaway worktree. */
	async prepareWorktree(
		repository: string,
		options: { patches?: string[]; workingTree?: boolean }
	): Promise<PreparedWorktree> {
		const args = ['prepare', '--repo', repository];
		for (const patch of options.patches ?? []) {
			args.push('--patch', patch);
		}
		if (options.workingTree) {
			args.push('--working-tree');
		}

		const { stdout } = await execFileAsync(this.bridgePath, args, { maxBuffer: 4 * 1024 * 1024 });
		const prepared = JSON.parse(stdout) as PreparedWorktree;
		this.log.info(`prepared ${prepared.commits} commit(s) in ${prepared.worktree}`);
		return prepared;
	}

	async cleanupWorktree(repository: string, worktree: string): Promise<void> {
		try {
			await execFileAsync(this.bridgePath, [
				'cleanup',
				'--repo',
				repository,
				'--worktree',
				worktree
			]);
			this.log.info(`removed scratch worktree ${worktree}`);
		} catch (error) {
			// A leaked scratch worktree is untidy, not fatal.
			this.log.warn(`could not remove ${worktree}: ${String(error)}`);
		}
	}

	private spawnReview(
		executable: string,
		args: string[],
		context: ReviewContext,
		onOutput?: (line: string) => void
	): Promise<{ output: string; errors: string; code: number | null }> {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, args, {
				cwd: context.repository,
				env: {
					...process.env,
					// The bridge token is the only credential in play; Sashiko never sees a
					// real provider key. The SASHIKO__ overrides keep custom settings files
					// pointed at the bridge as well.
					OPENAI_API_KEY: context.endpoint.token,
					LLM_API_KEY: context.endpoint.token,
					SASHIKO__AI__PROVIDER: vscode.workspace
						.getConfiguration('sashiko')
						.get<string>('provider', 'openai-compatible'),
					SASHIKO__AI__MODEL: context.model.id,
					SASHIKO__AI__OPENAI_COMPAT__BASE_URL: context.endpoint.baseUrl,
					NO_COLOR: '1'
				}
			});
			this.active = child;

			let collected = '';
			let errors = '';
			let stdoutRest = '';
			let stderrRest = '';
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				collected += chunk;
				stdoutRest = this.forwardOutput(stdoutRest + chunk, onOutput);
			});
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => {
				// Sashiko reports fatal failures here, not on the report stream.
				errors += chunk;
				stderrRest = this.forwardOutput(stderrRest + chunk, onOutput);
			});

			child.on('error', (error) => {
				this.active = undefined;
				reject(
					new Error(
						`Failed to launch '${executable}': ${error.message}. Install Sashiko or set sashiko.executable.`
					)
				);
			});
			child.on('close', (code) => {
				this.active = undefined;
				this.forwardOutput(`${stdoutRest}\n${stderrRest}\n`, onOutput);
				resolve({ output: collected, errors, code });
			});
		});
	}

	/** Logs whole lines, keeping Sashiko's redrawn progress frames out of the channel. */
	private forwardOutput(buffered: string, onOutput?: (line: string) => void): string {
		const lines = buffered.split('\n');
		const rest = lines.pop() ?? '';
		for (const raw of lines) {
			const line = raw.replace(ANSI_ESCAPE, '').trim();
			if (!line) {
				continue;
			}
			if (PROGRESS_FRAME.test(line)) {
				onOutput?.(line);
			} else {
				this.log.append(`${line}\n`);
			}
		}
		return rest;
	}

	private async publishFindings(
		report: string,
		root: string,
		rewriteFrom?: string
	): Promise<Finding[]> {
		this.diagnostics.clear();
		const findings = await this.parseReport(report);
		const publish = vscode.workspace
			.getConfiguration('sashiko')
			.get<boolean>('publishDiagnostics', true);
		const byFile = new Map<string, vscode.Diagnostic[]>();

		for (const finding of findings) {
			if (!finding.file) {
				continue;
			}
			// Reviews of patches run in a scratch worktree the user never opened, so point
			// the Problems panel at the equivalent file in their own checkout.
			const relative =
				rewriteFrom && path.isAbsolute(finding.file) && finding.file.startsWith(rewriteFrom)
					? path.relative(rewriteFrom, finding.file)
					: finding.file;
			const file = path.isAbsolute(relative) ? relative : path.join(root, relative);
			finding.resolvedFile = file;
			if (!publish) {
				continue;
			}
			const line = Math.max(0, (finding.line ?? 1) - 1);
			const endLine = Math.max(line, (finding.endLine ?? finding.line ?? 1) - 1);

			const diagnostic = new vscode.Diagnostic(
				new vscode.Range(line, 0, endLine, Number.MAX_SAFE_INTEGER),
				finding.title ? `${finding.title}\n\n${finding.message}` : finding.message,
				toSeverity(finding.severity)
			);
			diagnostic.source = finding.commit ? `sashiko (${finding.commit.slice(0, 12)})` : 'sashiko';
			diagnostic.code = finding.severity;

			const existing = byFile.get(file);
			if (existing) {
				existing.push(diagnostic);
			} else {
				byFile.set(file, [diagnostic]);
			}
		}

		for (const [file, diagnostics] of byFile) {
			this.diagnostics.set(vscode.Uri.file(file), diagnostics);
		}
		this.log.info(`published ${findings.length} finding(s) across ${byFile.size} file(s)`);
		return findings;
	}

	private async parseReport(report: string): Promise<Finding[]> {
		try {
			const child = execFile(this.bridgePath, ['parse-review'], { maxBuffer: 64 * 1024 * 1024 });
			const output = new Promise<string>((resolve, reject) => {
				let collected = '';
				child.stdout?.setEncoding('utf8');
				child.stdout?.on('data', (chunk: string) => (collected += chunk));
				child.on('error', reject);
				child.on('close', () => resolve(collected));
			});
			child.stdin?.end(report);
			return JSON.parse(await output) as Finding[];
		} catch (error) {
			this.log.warn(`could not parse review report: ${String(error)}`);
			return [];
		}
	}

	cancel(): void {
		this.active?.kill('SIGINT');
	}

	dispose(): void {
		this.cancel();
		this.diagnostics.dispose();
	}
}

/** Picks the fatal error Sashiko printed, so the user sees it instead of an exit code. */
function reportedError(errors: string): string | undefined {
	const match = errors.match(/^Error:\s*(.+)$/m);
	return match?.[1].trim();
}

function toSeverity(severity: string): vscode.DiagnosticSeverity {
	switch (severity.toLowerCase()) {
		case 'critical':
		case 'high':
			return vscode.DiagnosticSeverity.Error;
		case 'medium':
			return vscode.DiagnosticSeverity.Warning;
		case 'low':
			return vscode.DiagnosticSeverity.Information;
		default:
			return vscode.DiagnosticSeverity.Hint;
	}
}
