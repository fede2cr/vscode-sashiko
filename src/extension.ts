import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { LanguageModelBridge } from './bridge';
import { registerChatParticipant } from './chat';
import { registerMcpProvider } from './mcp';
import { contextShortfall, ModelSelection, pinnedModel } from './model';
import { ReviewRunner } from './review';
import { resolveRepository, ReviewTools, type ReviewSpec } from './tools';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const log = vscode.window.createOutputChannel('Sashiko', { log: true });
	const bridgePath = resolveBridgePath(context);
	const bridge = new LanguageModelBridge(bridgePath, log);
	const runner = new ReviewRunner(bridgePath, log, context.extension.packageJSON.version);
	const models = new ModelSelection(context.globalState, log);
	const tools = new ReviewTools(context.globalStorageUri.fsPath, bridge, runner, models, log);

	// The MCP tools run in the extension host rather than a server process, because
	// they need the workspace configuration and the Problems panel.
	bridge.setToolHandler((name, args) => tools.invoke(name, args));

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.command = 'sashiko.reviewHead';
	status.text = '$(search-fuzzy) Sashiko';
	status.tooltip = 'Review the HEAD commit with Sashiko';
	status.show();

	context.subscriptions.push(log, bridge, runner, status);

	context.subscriptions.push(
		vscode.commands.registerCommand('sashiko.reviewHead', () =>
			review({ kind: 'range', range: 'HEAD' }, tools, status, log)
		),
		vscode.commands.registerCommand('sashiko.reviewRange', async () => {
			const range = await vscode.window.showInputBox({
				title: 'Sashiko: Review Commit Range',
				prompt: 'Git revision or range to review',
				value: 'HEAD~1..HEAD',
				ignoreFocusOut: true
			});
			if (range) {
				await review({ kind: 'range', range }, tools, status, log);
			}
		}),
		vscode.commands.registerCommand('sashiko.reviewWorkingTree', () =>
			review({ kind: 'workingTree' }, tools, status, log)
		),
		vscode.commands.registerCommand('sashiko.reviewOpenPatch', async () => {
			const document = vscode.window.activeTextEditor?.document;
			if (document?.uri.scheme !== 'file') {
				void vscode.window.showWarningMessage('Open a patch or mbox file to review it.');
				return;
			}
			await review({ kind: 'patch', patches: [document.uri.fsPath] }, tools, status, log);
		}),
		vscode.commands.registerCommand('sashiko.cancelReview', () => tools.cancel()),
		vscode.commands.registerCommand('sashiko.selectModel', () => selectModel(bridge, models)),
		vscode.commands.registerCommand('sashiko.writeSettings', async () => {
			const endpoint = await bridge.start();
			const model = await models.resolve();
			const repository = resolveRepository();
			const destination = path.join(repository, 'Settings.toml');
			await runner.writeSettings(endpoint, model, repository, destination);
			await vscode.window.showTextDocument(vscode.Uri.file(destination));
		}),
		vscode.commands.registerCommand('sashiko.restartBridge', async () => {
			bridge.dispose();
			const endpoint = await bridge.start();
			void vscode.window.showInformationMessage(`Sashiko bridge restarted on ${endpoint.baseUrl}.`);
		}),
		vscode.commands.registerCommand('sashiko.showLog', () => log.show()),
		vscode.lm.onDidChangeChatModels(() => void bridge.publishModels()),
		registerChatParticipant(tools, models, log),
		registerMcpProvider(context, bridge, log)
	);

	try {
		await bridge.start();
	} catch (error) {
		log.error(`bridge unavailable: ${String(error)}`);
	}
}

export function deactivate(): void {
	// Disposables registered on the extension context handle teardown.
}

async function review(
	spec: ReviewSpec,
	tools: ReviewTools,
	status: vscode.StatusBarItem,
	log: vscode.LogOutputChannel
): Promise<void> {
	if (tools.isRunning) {
		void vscode.window.showWarningMessage('A Sashiko review is already running.');
		return;
	}

	status.text = '$(sync~spin) Sashiko';
	try {
		log.show(true);
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Sashiko: reviewing ${label(spec)}`,
				cancellable: true
			},
			async (progress, token) => {
				token.onCancellationRequested(() => tools.cancel());
				await tools.run(spec, {
					onOutput: (line) => progress.report({ message: line.slice(0, 120) })
				});
			}
		);

		void vscode.window.showInformationMessage(
			'Sashiko review finished. Findings are in the Problems panel.'
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error(message);
		void vscode.window.showErrorMessage(`Sashiko: ${message}`, 'Show Log').then((choice) => {
			if (choice === 'Show Log') {
				log.show();
			}
		});
	} finally {
		status.text = '$(search-fuzzy) Sashiko';
	}
}

function label(spec: ReviewSpec): string {
	switch (spec.kind) {
		case 'range':
			return spec.range;
		case 'workingTree':
			return 'uncommitted changes';
		case 'patch':
			return spec.patches.map((file) => path.basename(file)).join(', ');
	}
}

async function selectModel(bridge: LanguageModelBridge, models: ModelSelection): Promise<void> {
	const available = await vscode.lm.selectChatModels();
	if (available.length === 0) {
		void vscode.window.showErrorMessage(
			'No language model is available. Sign in to GitHub Copilot and try again.'
		);
		return;
	}

	const pinned = pinnedModel();
	const following = models.remembered
		? `Currently ${models.remembered}`
		: 'No chat model seen yet; the first available one is used';

	type Item = vscode.QuickPickItem & { id?: string };
	const items: Item[] = [
		{
			label: 'Follow the chat model picker',
			description: pinned ? undefined : 'current',
			detail: following
		},
		{ label: 'Pin a model', kind: vscode.QuickPickItemKind.Separator },
		// Widest context first: Sashiko truncates kernel context on small models.
		...[...available]
			.sort((a, b) => b.maxInputTokens - a.maxInputTokens)
			.map((model) => ({
				label: model.name,
				description: `${model.vendor} · ${model.id}${model.id === pinned ? ' · current' : ''}`,
				detail:
					contextShortfall(model) ??
					`${model.maxInputTokens.toLocaleString()} input tokens`,
				id: model.id
			}))
	];

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Sashiko: Select Language Model',
		placeHolder: 'Model used for kernel reviews'
	});
	if (!picked) {
		return;
	}

	await vscode.workspace
		.getConfiguration('sashiko')
		.update('model', picked.id, vscode.ConfigurationTarget.Global);
	await bridge.publishModels();
}

function resolveBridgePath(context: vscode.ExtensionContext): string {
	const configured = vscode.workspace.getConfiguration('sashiko').get<string>('bridgePath');
	if (configured) {
		return configured;
	}
	const name = process.platform === 'win32' ? 'sashiko-vscode-bridge.exe' : 'sashiko-vscode-bridge';
	const bundled = path.join(context.extensionPath, 'bin', name);
	if (fs.existsSync(bundled)) {
		return bundled;
	}
	// Development checkout: fall back to the cargo build output.
	return path.join(context.extensionPath, 'rust', 'target', 'release', name);
}
