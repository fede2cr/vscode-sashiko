import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as vscode from 'vscode';

/** Chat request forwarded by the Rust bridge, mirroring `protocol::ChatRequest`. */
interface ChatRequest {
	model?: string;
	messages: ChatMessage[];
	tools?: ToolDef[];
	temperature?: number;
}

interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: { id: string; name: string; arguments: string }[];
	toolCallId?: string;
}

interface ToolDef {
	name: string;
	description: string;
	inputSchema: object;
}

type HostBound =
	| { type: 'ready'; port: number; token: string }
	| ({ type: 'request'; id: string } & ChatRequest)
	| { type: 'cancel'; id: string }
	| { type: 'tool'; id: string; name: string; arguments: Record<string, unknown> }
	| { type: 'log'; level: string; message: string };

export interface BridgeEndpoint {
	port: number;
	token: string;
	baseUrl: string;
	/** Streamable HTTP endpoint VS Code connects the MCP client to. */
	mcpUrl: string;
}

/** Runs one MCP tool invocation on behalf of the bridge. */
export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * Owns the `sashiko-vscode-bridge serve` child process and answers its completion
 * requests with `vscode.lm`. This is the only place the extension touches the
 * language model; everything else in the pipeline is Rust.
 */
export class LanguageModelBridge implements vscode.Disposable {
	private child?: ChildProcessWithoutNullStreams;
	private endpoint?: BridgeEndpoint;
	private ready?: Promise<BridgeEndpoint>;
	private toolHandler?: ToolHandler;
	private readonly inflight = new Map<string, vscode.CancellationTokenSource>();
	private readonly endpointChanged = new vscode.EventEmitter<void>();

	/** Fires whenever the listener moves, so the MCP server definition can be refreshed. */
	readonly onDidChangeEndpoint = this.endpointChanged.event;

	constructor(
		private readonly binaryPath: string,
		private readonly log: vscode.LogOutputChannel
	) {}

	setToolHandler(handler: ToolHandler): void {
		this.toolHandler = handler;
	}

	/** Starts the bridge if needed and resolves once the HTTP endpoint is listening. */
	async start(): Promise<BridgeEndpoint> {
		if (this.endpoint) {
			return this.endpoint;
		}
		this.ready ??= this.spawnBridge();
		return this.ready;
	}

	private spawnBridge(): Promise<BridgeEndpoint> {
		return new Promise<BridgeEndpoint>((resolve, reject) => {
			let child: ChildProcessWithoutNullStreams;
			try {
				child = spawn(this.binaryPath, ['serve'], { stdio: 'pipe' });
			} catch (error) {
				reject(error);
				return;
			}
			this.child = child;

			child.on('error', (error) => {
				this.log.error(`bridge failed to start: ${error.message}`);
				this.reset();
				reject(error);
			});
			child.on('exit', (code, signal) => {
				this.log.warn(`bridge exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
				this.reset();
			});

			readline.createInterface({ input: child.stderr }).on('line', (line) => {
				this.log.warn(`bridge: ${line}`);
			});

			readline.createInterface({ input: child.stdout }).on('line', (line) => {
				let message: HostBound;
				try {
					message = JSON.parse(line) as HostBound;
				} catch {
					this.log.warn(`bridge emitted non-JSON output: ${line}`);
					return;
				}
				this.handle(message, resolve);
			});
		});
	}

	private handle(message: HostBound, onReady: (endpoint: BridgeEndpoint) => void): void {
		switch (message.type) {
			case 'ready': {
				const endpoint: BridgeEndpoint = {
					port: message.port,
					token: message.token,
					baseUrl: `http://127.0.0.1:${message.port}/v1`,
					mcpUrl: `http://127.0.0.1:${message.port}/mcp`
				};
				this.endpoint = endpoint;
				this.log.info(`bridge listening on ${endpoint.baseUrl}`);
				void this.publishModels();
				onReady(endpoint);
				this.endpointChanged.fire();
				break;
			}
			case 'log':
				this.log.appendLine(`[bridge] ${message.level}: ${message.message}`);
				break;
			case 'cancel':
				this.inflight.get(message.id)?.cancel();
				break;
			case 'tool':
				void this.runTool(message.id, message.name, message.arguments);
				break;
			case 'request':
				void this.answer(message.id, message);
				break;
		}
	}

	private async runTool(
		id: string,
		name: string,
		args: Record<string, unknown>
	): Promise<void> {
		if (!this.toolHandler) {
			this.send({ type: 'toolResult', id, text: 'Sashiko tools are not ready yet.', isError: true });
			return;
		}
		try {
			this.send({ type: 'toolResult', id, text: await this.toolHandler(name, args), isError: false });
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.log.error(`tool ${name} failed: ${text}`);
			this.send({ type: 'toolResult', id, text, isError: true });
		}
	}

	private send(payload: unknown): void {
		this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	/** Publishes the model catalogue so Sashiko's `GET /v1/models` returns something useful. */
	async publishModels(): Promise<void> {
		const models = await vscode.lm.selectChatModels();
		this.send({
			type: 'models',
			models: models.map((model) => ({
				id: model.id,
				name: model.name,
				vendor: model.vendor,
				family: model.family,
				maxInputTokens: model.maxInputTokens
			}))
		});
	}

	private async answer(id: string, request: ChatRequest): Promise<void> {
		const cancellation = new vscode.CancellationTokenSource();
		this.inflight.set(id, cancellation);
		try {
			const model = await resolveModel(request.model);
			const options: vscode.LanguageModelChatRequestOptions = {
				justification: 'Sashiko is reviewing Linux kernel patches on your behalf.'
			};
			if (request.tools?.length) {
				options.tools = request.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema
				}));
				options.toolMode = vscode.LanguageModelChatToolMode.Auto;
			}

			const response = await model.sendRequest(
				toChatMessages(request.messages),
				options,
				cancellation.token
			);

			let toolCalls = 0;
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					this.send({ type: 'chunk', id, delta: part.value });
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls += 1;
					this.send({
						type: 'toolCall',
						id,
						call: {
							id: part.callId,
							name: part.name,
							arguments: JSON.stringify(part.input ?? {})
						}
					});
				}
			}
			this.send({ type: 'done', id, finishReason: toolCalls > 0 ? 'tool_calls' : 'stop' });
		} catch (error) {
			this.send({ type: 'error', id, message: describeError(error) });
		} finally {
			this.inflight.delete(id);
			cancellation.dispose();
		}
	}

	private reset(): void {
		for (const cancellation of this.inflight.values()) {
			cancellation.cancel();
			cancellation.dispose();
		}
		this.inflight.clear();
		this.child = undefined;
		this.endpoint = undefined;
		this.ready = undefined;
	}

	dispose(): void {
		this.child?.kill();
		this.reset();
		this.endpointChanged.dispose();
	}
}

/**
 * Resolves the model Sashiko asked for, falling back to any available chat model so a
 * stale id in Settings.toml does not break the review.
 */
export async function resolveModel(id?: string): Promise<vscode.LanguageModelChat> {
	if (id) {
		const exact = await vscode.lm.selectChatModels({ id });
		if (exact.length > 0) {
			return exact[0];
		}
		const byFamily = await vscode.lm.selectChatModels({ family: id });
		if (byFamily.length > 0) {
			return byFamily[0];
		}
	}
	const any = await vscode.lm.selectChatModels();
	if (any.length === 0) {
		throw new Error(
			'No language model is available in VS Code. Sign in to GitHub Copilot (or another chat provider) and try again.'
		);
	}
	return any[0];
}

/**
 * Maps OpenAI-shaped messages onto the VS Code chat API. The API has no system role,
 * so system prompts are folded into the leading user turn.
 */
function toChatMessages(messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
	const result: vscode.LanguageModelChatMessage[] = [];

	for (const message of messages) {
		switch (message.role) {
			case 'assistant': {
				const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
				if (message.content) {
					parts.push(new vscode.LanguageModelTextPart(message.content));
				}
				for (const call of message.toolCalls ?? []) {
					parts.push(
						new vscode.LanguageModelToolCallPart(call.id, call.name, parseArguments(call.arguments))
					);
				}
				if (parts.length > 0) {
					result.push(vscode.LanguageModelChatMessage.Assistant(parts));
				}
				break;
			}
			case 'tool': {
				if (!message.toolCallId) {
					break;
				}
				result.push(
					vscode.LanguageModelChatMessage.User([
						new vscode.LanguageModelToolResultPart(message.toolCallId, [
							new vscode.LanguageModelTextPart(message.content)
						])
					])
				);
				break;
			}
			default: {
				if (message.content.trim()) {
					result.push(vscode.LanguageModelChatMessage.User(message.content));
				}
				break;
			}
		}
	}

	if (result.length === 0) {
		result.push(vscode.LanguageModelChatMessage.User('Continue.'));
	}
	return result;
}

function parseArguments(raw: string): object {
	try {
		const parsed: unknown = JSON.parse(raw || '{}');
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function describeError(error: unknown): string {
	if (error instanceof vscode.LanguageModelError) {
		return `${error.code}: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}
