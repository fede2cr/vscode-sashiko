import * as vscode from 'vscode';

import { resolveModel } from './bridge';

const REMEMBERED = 'sashiko.chatModel';

/**
 * Decides which chat model reviews run on.
 *
 * VS Code only reveals the model behind its own picker on a `ChatRequest`, so the
 * model `@sashiko` last ran with is remembered and reused by the command palette and
 * the MCP tools. An explicit `sashiko.model` pin overrides that.
 */
export class ModelSelection {
	private readonly warned = new Set<string>();

	constructor(
		private readonly state: vscode.Memento,
		private readonly log: vscode.LogOutputChannel
	) {}

	/** Called for every chat turn, so later reviews follow VS Code's model picker. */
	remember(model: vscode.LanguageModelChat): void {
		if (this.state.get<string>(REMEMBERED) === model.id) {
			return;
		}
		this.log.info(`following chat model ${model.id}`);
		void this.state.update(REMEMBERED, model.id);
	}

	get remembered(): string | undefined {
		return this.state.get<string>(REMEMBERED);
	}

	async resolve(): Promise<vscode.LanguageModelChat> {
		const model = await resolveModel(pinnedModel() ?? this.remembered);
		this.warnOnce(model);
		return model;
	}

	/** One notification per model per session; the chat participant renders its own. */
	private warnOnce(model: vscode.LanguageModelChat): void {
		const shortfall = contextShortfall(model);
		if (!shortfall || this.warned.has(model.id)) {
			return;
		}
		this.warned.add(model.id);
		this.log.warn(shortfall);
		void vscode.window
			.showWarningMessage(shortfall, 'Select Another Model')
			.then((choice) => {
				if (choice === 'Select Another Model') {
					void vscode.commands.executeCommand('sashiko.selectModel');
				}
			});
	}
}

export function pinnedModel(): string | undefined {
	return vscode.workspace.getConfiguration('sashiko').get<string>('model') || undefined;
}

/** How much context Sashiko is configured to feed each review stage. */
export function reviewBudget(): number {
	return vscode.workspace.getConfiguration('sashiko').get<number>('maxInputTokens', 100000);
}

/**
 * Kernel reviews replay whole patches plus surrounding source through eleven stages,
 * so a small context window silently truncates the evidence a finding rests on.
 */
export function contextShortfall(model: vscode.LanguageModelChat): string | undefined {
	const budget = reviewBudget();
	if (!model.maxInputTokens || model.maxInputTokens >= budget) {
		return undefined;
	}
	return (
		`${model.name} accepts ${model.maxInputTokens.toLocaleString()} input tokens, ` +
		`below the ${budget.toLocaleString()} Sashiko is configured to use. Kernel context ` +
		`will be truncated and findings may be unreliable.`
	);
}
