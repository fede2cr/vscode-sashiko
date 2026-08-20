import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { type LanguageModelBridge } from './bridge';
import type { ModelSelection } from './model';
import type { Finding, ReviewContext, ReviewRunner } from './review';

/** What to review. Patch and working-tree reviews are staged into a scratch worktree. */
export type ReviewSpec =
	| { kind: 'range'; range: string }
	| { kind: 'patch'; patches: string[] }
	| { kind: 'workingTree' };

export interface ReviewOutcome {
	summary: string;
	findings: Finding[];
	commits?: number;
}

/** Findings included verbatim in the tool result, to keep the agent's context sane. */
const SUMMARY_LIMIT = 25;
const MESSAGE_LIMIT = 300;

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

/**
 * The single path every entry point funnels through: the command palette, the
 * `@sashiko` chat participant, and the MCP tools all call `run`.
 */
export class ReviewTools {
	constructor(
		private readonly storageDir: string,
		private readonly bridge: LanguageModelBridge,
		private readonly runner: ReviewRunner,
		private readonly models: ModelSelection,
		private readonly log: vscode.LogOutputChannel
	) {}

	/** Executes an MCP `tools/call`, returning text for the agent. */
	async invoke(name: string, args: Record<string, unknown>): Promise<string> {
		const spec = toSpec(name, args);
		const outcome = await this.run(spec);
		return outcome.summary;
	}

	async run(
		spec: ReviewSpec,
		options: { model?: vscode.LanguageModelChat; onOutput?: (chunk: string) => void } = {}
	): Promise<ReviewOutcome> {
		const endpoint = await this.bridge.start();
		const model = options.model ?? (await this.models.resolve());
		const repository = resolveRepository();

		let reviewRoot = repository;
		let range = spec.kind === 'range' ? spec.range : 'HEAD';
		let scratch: string | undefined;
		let commits: number | undefined;

		if (spec.kind !== 'range') {
			const prepared = await this.runner.prepareWorktree(repository, {
				patches: spec.kind === 'patch' ? spec.patches : undefined,
				workingTree: spec.kind === 'workingTree'
			});
			reviewRoot = prepared.worktree;
			range = prepared.range;
			scratch = prepared.worktree;
			commits = prepared.commits;
		}

		try {
			const settingsPath = path.join(this.storageDir, 'Settings.toml');
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			await this.runner.writeSettings(endpoint, model, reviewRoot, settingsPath);

			const context: ReviewContext = {
				endpoint,
				model,
				settingsPath,
				repository: reviewRoot,
				diagnosticsRoot: scratch ? repository : undefined
			};

			this.log.info(`reviewing ${range} in ${reviewRoot} with ${model.id}`);
			const findings = await this.runner.run(range, context, options.onOutput);
			return { summary: summarize(findings, range, commits), findings, commits };
		} finally {
			if (scratch) {
				await this.runner.cleanupWorktree(repository, scratch);
			}
		}
	}

	cancel(): void {
		this.runner.cancel();
	}

	get isRunning(): boolean {
		return this.runner.isRunning;
	}
}

function toSpec(name: string, args: Record<string, unknown>): ReviewSpec {
	switch (name) {
		case 'sashiko_review_range':
			return { kind: 'range', range: asString(args.range) || 'HEAD' };
		case 'sashiko_review_patch': {
			const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
			if (paths.length === 0) {
				throw new Error('sashiko_review_patch requires at least one patch file path.');
			}
			return { kind: 'patch', patches: paths };
		}
		case 'sashiko_review_working_tree':
			return { kind: 'workingTree' };
		default:
			throw new Error(`Unknown Sashiko tool '${name}'.`);
	}
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Renders findings for a language model. A raw kernel review report is far too
 * large to hand back to an agent, so this stays severity-ranked and capped.
 */
function summarize(findings: Finding[], range: string, commits?: number): string {
	const scope = commits === undefined ? range : `${commits} commit(s)`;
	if (findings.length === 0) {
		return `Sashiko reviewed ${scope} and found no issues.`;
	}

	const ranked = [...findings].sort(
		(a, b) => severityRank(a.severity) - severityRank(b.severity)
	);
	const counts = new Map<string, number>();
	for (const finding of findings) {
		const key = finding.severity.toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const breakdown = [...counts.entries()]
		.sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
		.map(([severity, count]) => `${count} ${severity}`)
		.join(', ');

	const lines = ranked.slice(0, SUMMARY_LIMIT).map((finding) => {
		const where = finding.file
			? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
			: 'general';
		const title = finding.title ? `${finding.title} — ` : '';
		return `- [${finding.severity}] ${where}: ${title}${truncate(finding.message)}`;
	});

	const omitted = findings.length - lines.length;
	const footer =
		omitted > 0
			? `\n\n${omitted} further finding(s) omitted. All ${findings.length} are in the VS Code Problems panel.`
			: '\n\nFull details are in the VS Code Problems panel.';

	return `Sashiko reviewed ${scope} and found ${findings.length} issue(s) (${breakdown}).\n\n${lines.join('\n')}${footer}`;
}

function severityRank(severity: string): number {
	const index = SEVERITY_ORDER.indexOf(severity.toLowerCase());
	return index === -1 ? SEVERITY_ORDER.length : index;
}

function truncate(message: string): string {
	const flat = message.replace(/\s+/g, ' ').trim();
	return flat.length > MESSAGE_LIMIT ? `${flat.slice(0, MESSAGE_LIMIT)}…` : flat;
}

export function resolveRepository(): string {
	const configured = vscode.workspace.getConfiguration('sashiko').get<string>('repositoryPath');
	if (configured) {
		return configured;
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		throw new Error(
			'Open the kernel repository as a workspace folder, or set sashiko.repositoryPath.'
		);
	}
	return folder.uri.fsPath;
}
