import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as vscode from 'vscode';

/** Chat request forwarded by the Rust bridge, mirroring `protocol::ChatRequest`. */
interface ChatRequest {
	model?: string;
	messages: ChatMessage[];
	tools?: ToolDef[];
	temperature?: number;
	jsonOutput?: boolean;
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

const JSON_ONLY_INSTRUCTION =
	'Reply with a single valid JSON document and nothing else: no prose, no explanation, no markdown code fences.';

/** How many times a turn that streamed nothing is replayed before it is reported. */
const EMPTY_RESPONSE_ATTEMPTS = 3;
/** Multiplied by the attempt number, so the provider gets a widening pause. */
const EMPTY_RESPONSE_BACKOFF_MS = 2000;
/** Below this, the turn was refused locally rather than answered with nothing. */
const EMPTY_RESPONSE_MIN_RETRY_MS = 1000;
/** How long to stop calling the model once Copilot starts refusing this extension. */
const BLOCKED_COOLDOWN_MS = 120_000;
const BLOCKED_MESSAGE =
	'GitHub Copilot has temporarily blocked this extension for sending too many requests. ' +
	'Every review turn will fail until the block clears, so wait a few minutes before ' +
	'retrying, and raise sashiko.requestIntervalMs to spread requests further apart.';

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
	private blockedUntil = 0;
	private nextRequestAt = 0;
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
			if (Date.now() < this.blockedUntil) {
				this.send({ type: 'error', id, message: BLOCKED_MESSAGE });
				return;
			}
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

			const messages = toChatMessages(request.messages, request.jsonOutput);
			// Sashiko builds its own prompts and does not always honour the budget in
			// Settings.toml, so an oversized turn would otherwise fail without a reason.
			const tokens = await countPromptTokens(model, messages, cancellation.token);
			if (tokens > model.maxInputTokens) {
				const message =
					`The prompt is ${tokens.toLocaleString()} tokens but '${model.id}' accepts at most ` +
					`${model.maxInputTokens.toLocaleString()}. Pick a model with a larger context window, ` +
					'or lower sashiko.maxInputTokens so Sashiko sends less context.';
				this.log.error(message);
				this.send({ type: 'error', id, message });
				return;
			}

			await this.waitForSlot(cancellation.token);

			// A model that streams nothing is usually a transient provider hiccup. Sashiko
			// retries with no backoff at all, so absorb it here rather than let a whole
			// review collapse into a burst of failed turns.
			const shape =
				`${messages.length} messages, ${tokens.toLocaleString()}/` +
				`${model.maxInputTokens.toLocaleString()} tokens, ${options.tools?.length ?? 0} tools`;
			for (let attempt = 1; ; attempt++) {
				const started = Date.now();
				const response = await model.sendRequest(messages, options, cancellation.token);

				let toolCalls = 0;
				let textLength = 0;
				const ignored = new Set<string>();
				for await (const part of response.stream) {
					if (part instanceof vscode.LanguageModelTextPart) {
						textLength += part.value.length;
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
					} else {
						// Reasoning models stream parts this bridge has no wire format for.
						ignored.add((part as object)?.constructor?.name ?? 'unknown');
					}
				}

				if (textLength > 0 || toolCalls > 0) {
					if (ignored.size > 0) {
						this.log.debug(`ignored response parts: ${[...ignored].join(', ')}`);
					}
					this.send({ type: 'done', id, finishReason: toolCalls > 0 ? 'tool_calls' : 'stop' });
					return;
				}

				// Nothing was streamed, so nothing was forwarded either and the turn can be
				// replayed safely. Sashiko parses the body as JSON, so giving up here at
				// least surfaces the real cause instead of a parse error several retries on.
				const elapsed = Date.now() - started;
				const detail = ignored.size > 0 ? ` (only ${[...ignored].join(', ')} parts)` : '';
				const message =
					`The language model '${model.id}' returned an empty response${detail} ` +
					`after ${elapsed}ms.`;
				// An instant empty stream is the provider refusing the turn without asking the
				// model, so replaying it only spends quota against whatever refused it.
				const worthRetrying = elapsed >= EMPTY_RESPONSE_MIN_RETRY_MS;
				if (!worthRetrying && (await this.isRefusingTurns(model))) {
					this.blockedUntil = Date.now() + BLOCKED_COOLDOWN_MS;
					this.log.error(BLOCKED_MESSAGE);
					this.send({ type: 'error', id, message: BLOCKED_MESSAGE });
					return;
				}
				if (
					!worthRetrying ||
					attempt >= EMPTY_RESPONSE_ATTEMPTS ||
					cancellation.token.isCancellationRequested
				) {
					this.log.warn(`${message} [${shape}]`);
					this.send({ type: 'error', id, message });
					return;
				}
				this.log.warn(`${message} [${shape}] Retrying (${attempt}/${EMPTY_RESPONSE_ATTEMPTS - 1}).`);
				await delay(attempt * EMPTY_RESPONSE_BACKOFF_MS, cancellation.token);
			}
		} catch (error) {
			const message = describeError(error);
			this.log.error(`language model request failed: ${message}`);
			this.send({ type: 'error', id, message });
		} finally {
			this.inflight.delete(id);
			cancellation.dispose();
		}
	}

	/** Spaces requests out: Copilot temporarily blocks extensions that burst. */
	private async waitForSlot(token: vscode.CancellationToken): Promise<void> {
		const interval = vscode.workspace
			.getConfiguration('sashiko')
			.get<number>('requestIntervalMs', 250);
		if (interval <= 0) {
			return;
		}
		const now = Date.now();
		const slot = Math.max(now, this.nextRequestAt);
		this.nextRequestAt = slot + interval;
		if (slot > now) {
			await delay(slot - now, token);
		}
	}

	/**
	 * Sends one trivial turn to tell a rejected prompt apart from a refused extension.
	 * Copilot blocks an extension that sends too many requests and VS Code surfaces that
	 * as an empty stream rather than an error, so a tiny prompt failing too is the tell.
	 */
	private async isRefusingTurns(model: vscode.LanguageModelChat): Promise<boolean> {
		const cancellation = new vscode.CancellationTokenSource();
		const started = Date.now();
		try {
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User('Reply with OK.')],
				{ justification: 'Sashiko is checking whether the language model still answers.' },
				cancellation.token
			);
			let text = '';
			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					text += part.value;
				}
			}
			this.log.warn(`probe: '${model.id}' returned ${text.length} chars in ${Date.now() - started}ms`);
			return text.length === 0;
		} catch (error) {
			this.log.warn(`probe: '${model.id}' failed after ${Date.now() - started}ms: ${describeError(error)}`);
			return false;
		} finally {
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
function toChatMessages(
	messages: ChatMessage[],
	jsonOutput?: boolean
): vscode.LanguageModelChatMessage[] {
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
	// The chat API has no equivalent of OpenAI's `response_format`, so the only way to
	// hold the model to JSON is to say so in the prompt.
	if (jsonOutput) {
		result.push(vscode.LanguageModelChatMessage.User(JSON_ONLY_INSTRUCTION));
	}
	return result;
}

/** Sleeps between retries, waking early when the request is cancelled. */
function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			subscription.dispose();
			resolve();
		};
		const timer = setTimeout(done, ms);
		const subscription = token.onCancellationRequested(done);
	});
}

/** Adds up the prompt's token count, which the chat API only reports per message. */
async function countPromptTokens(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
	token: vscode.CancellationToken
): Promise<number> {
	const counts = await Promise.all(
		messages.map((message) => model.countTokens(message, token))
	);
	return counts.reduce((total, count) => total + count, 0);
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
