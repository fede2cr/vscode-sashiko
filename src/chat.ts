import * as path from 'node:path';
import * as vscode from 'vscode';

import { contextShortfall, pinnedModel, type ModelSelection } from './model';
import type { Finding } from './review';
import type { ReviewSpec, ReviewTools } from './tools';

const PATCH_EXTENSIONS = new Set(['.patch', '.diff', '.mbox', '.eml']);

/** Looks like a git revision or range rather than prose. */
const REVISION = /^[\w.\-/^~@{}]+(\.\.\.?[\w.\-/^~@{}]+)?$/;

/**
 * `@sashiko` in the chat view. This runs on the model selected in VS Code's own
 * picker, and remembers it so the command palette and MCP tools follow suit.
 */
export function registerChatParticipant(
	tools: ReviewTools,
	models: ModelSelection,
	log: vscode.LogOutputChannel
): vscode.ChatParticipant {
	const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
		if (tools.isRunning) {
			stream.markdown('A Sashiko review is already running. Cancel it before starting another.');
			return {};
		}

		models.remember(request.model);

		let spec: ReviewSpec;
		try {
			spec = resolveSpec(request);
		} catch (error) {
			stream.markdown(error instanceof Error ? error.message : String(error));
			return {};
		}

		const pinned = pinnedModel();
		if (pinned && pinned !== request.model.id) {
			stream.markdown(
				`Note: \`sashiko.model\` is pinned to \`${pinned}\`, so this review ignores the model picker. ` +
					'Clear the setting to follow it.\n\n'
			);
		}
		const model = pinned ? undefined : request.model;
		const shortfall = model && contextShortfall(model);
		if (shortfall) {
			stream.markdown(`Note: ${shortfall}\n\n`);
		}

		stream.progress(`Reviewing ${describe(spec)} with ${model?.name ?? pinned}…`);
		token.onCancellationRequested(() => tools.cancel());

		try {
			const outcome = await tools.run(spec, {
				model,
				onOutput: (chunk) => {
					const line = lastLine(chunk);
					if (line) {
						stream.progress(line.slice(0, 120));
					}
				}
			});

			if (token.isCancellationRequested) {
				stream.markdown('Review cancelled.');
				return {};
			}
			render(stream, spec, outcome.findings, outcome.commits);
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(message);
			stream.markdown(`Sashiko review failed: ${message}`);
			stream.button({ command: 'sashiko.showLog', title: 'Show Sashiko Log' });
			return { errorDetails: { message } };
		}
	};

	const participant = vscode.chat.createChatParticipant('sashiko.review', handler);
	participant.iconPath = new vscode.ThemeIcon('search-fuzzy');
	return participant;
}

function resolveSpec(request: vscode.ChatRequest): ReviewSpec {
	const prompt = request.prompt.trim();
	const attached = patchFiles(request);

	switch (request.command) {
		case 'changes':
			return { kind: 'workingTree' };
		case 'patch': {
			const patches = attached.length > 0 ? attached : activePatch();
			if (patches.length === 0) {
				throw new Error(
					'Attach the .patch or .mbox files to review, or open one in the active editor.'
				);
			}
			return { kind: 'patch', patches };
		}
		case 'commits':
			return { kind: 'range', range: prompt || 'HEAD' };
		default:
			break;
	}

	// No slash command: prefer attached patches, then a revision, then HEAD.
	if (attached.length > 0) {
		return { kind: 'patch', patches: attached };
	}
	if (prompt && REVISION.test(prompt)) {
		return { kind: 'range', range: prompt };
	}
	const active = activePatch();
	if (active.length > 0) {
		return { kind: 'patch', patches: active };
	}
	return { kind: 'range', range: 'HEAD' };
}

function patchFiles(request: vscode.ChatRequest): string[] {
	const paths: string[] = [];
	for (const reference of request.references) {
		const uri =
			reference.value instanceof vscode.Uri
				? reference.value
				: reference.value instanceof vscode.Location
					? reference.value.uri
					: undefined;
		if (uri?.scheme === 'file' && isPatch(uri)) {
			paths.push(uri.fsPath);
		}
	}
	// References arrive in reverse prompt order; patch series must apply in order.
	return paths.reverse();
}

function activePatch(): string[] {
	const document = vscode.window.activeTextEditor?.document;
	if (document?.uri.scheme === 'file' && isPatch(document.uri)) {
		return [document.uri.fsPath];
	}
	return [];
}

function isPatch(uri: vscode.Uri): boolean {
	return PATCH_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

function describe(spec: ReviewSpec): string {
	switch (spec.kind) {
		case 'range':
			return `\`${spec.range}\``;
		case 'workingTree':
			return 'your uncommitted changes';
		case 'patch':
			return spec.patches.length === 1
				? path.basename(spec.patches[0])
				: `${spec.patches.length} patches`;
	}
}

function render(
	stream: vscode.ChatResponseStream,
	spec: ReviewSpec,
	findings: Finding[],
	commits?: number
): void {
	const scope = commits === undefined ? describe(spec) : `${commits} commit(s)`;

	if (findings.length === 0) {
		stream.markdown(`Sashiko reviewed ${scope} and found no issues.`);
		return;
	}

	stream.markdown(`Sashiko reviewed ${scope} and found **${findings.length}** issue(s).\n\n`);

	for (const finding of findings) {
		stream.markdown(`**${finding.severity.toUpperCase()}** — ${finding.title ?? 'Finding'}\n\n`);
		const file = finding.resolvedFile ?? finding.file;
		if (file) {
			const line = Math.max(0, (finding.line ?? 1) - 1);
			stream.anchor(
				new vscode.Location(vscode.Uri.file(file), new vscode.Position(line, 0)),
				`${finding.file}:${finding.line ?? 1}`
			);
			stream.markdown('\n\n');
		}
		stream.markdown(`${finding.message}\n\n`);
	}

	stream.markdown('_All findings are also in the Problems panel._');
}

function lastLine(chunk: string): string | undefined {
	const lines = chunk
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1);
}
