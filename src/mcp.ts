import * as vscode from 'vscode';

import type { LanguageModelBridge } from './bridge';

/**
 * Points VS Code's MCP client at the bridge's own loopback listener.
 *
 * The bridge already holds the stdio link to this extension host, so serving MCP
 * from it means tool calls reach the workspace without a second process.
 */
export function registerMcpProvider(
	context: vscode.ExtensionContext,
	bridge: LanguageModelBridge,
	log: vscode.LogOutputChannel
): vscode.Disposable {
	const version = String(context.extension.packageJSON.version ?? '0.0.0');

	return vscode.lm.registerMcpServerDefinitionProvider('sashiko.bridge', {
		onDidChangeMcpServerDefinitions: bridge.onDidChangeEndpoint,
		provideMcpServerDefinitions: async () => {
			const endpoint = await bridge.start();
			log.info(`offering MCP server at ${endpoint.mcpUrl}`);
			return [
				new vscode.McpHttpServerDefinition(
					'Sashiko',
					vscode.Uri.parse(endpoint.mcpUrl),
					{ Authorization: `Bearer ${endpoint.token}` },
					version
				)
			];
		}
	});
}
