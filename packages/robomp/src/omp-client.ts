/**
 * Thin adapter over the coding-agent `RpcClient` exposing the slice of the
 * Python `omp_rpc.RpcClient` surface the worker drives.
 *
 * Differences it papers over:
 * - Slot identity: `Bun.spawn` ignores uid/gid, so the agent is launched via
 *   the same setpriv trampoline as every other slot subprocess.
 * - `promptAndWait` only settles on `agent_end`; `markClosed` (and a child
 *   exit) reject the in-flight wait so cancellation never waits out the
 *   request timeout.
 * - Host tools reached through an `xd://` device report the transport tool
 *   (`write`) in `tool_execution_end`; events are renamed to the host tool
 *   that actually ran, keyed by the dispatch's `toolCallId`.
 * - `set_todos` and extension UI replies are not on the `RpcClient` surface,
 *   and `RpcClient.prompt` drops a failed response: the adapter owns the
 *   spawned process, so it tees the agent's stdout to observe those frames and
 *   writes its own `set_todos` / `prompt` / UI frames to stdin. Responses carry
 *   `robomp_`-prefixed ids, which `RpcClient` ignores as uncorrelated.
 */
import * as fs from "node:fs";
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { RpcAgentProcess, RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import { type ProcessIdentity, SHARED_OMP_GID, wrapWithIdentity } from "./subprocess";

export type { TodoPhase };

/** Construction options (Python `RpcClient(**kwargs)` analogue). */
export interface OmpClientOptions {
	executable: string;
	cwd: string;
	sessionDir: string;
	env: Record<string, string>;
	noTitle: boolean;
	model: string;
	provider: string | null;
	thinking: string | null;
	appendSystemPrompt: string;
	customTools: RpcClientCustomTool[];
	/** Seconds. */
	requestTimeout: number;
	/** Seconds. */
	startupTimeout: number;
	extraArgs: readonly string[];
	user: number | null;
	group: number | null;
	extraGroups: readonly string[] | null;
}

export interface ToolExecutionEnd {
	toolName: string;
	isError: boolean;
	result: unknown;
}

/** One finished prompt (Python `PromptTurn`). */
export interface PromptTurn {
	events: AgentEvent[];
	messages: AgentMessage[];
	assistantMessage: Record<string, unknown> | null;
	assistantText: string | null;
}

/** Surface the worker drives; tests substitute a recording fake. */
export interface OmpClient {
	start(): Promise<void>;
	close(): Promise<void>;
	installHeadlessUi(): void;
	onToolExecutionEnd(listener: (event: ToolExecutionEnd) => void): void;
	onMessageUpdate(listener: (event: AgentEvent) => void): void;
	stop(): Promise<void>;
	markClosed(error: Error): void;
	setTodos(phases: TodoPhase[]): Promise<void>;
	getTodos(): Promise<TodoPhase[]>;
	/** `timeout` in seconds. */
	promptAndWait(prompt: string, timeout: number): Promise<PromptTurn>;
}

/** Raised when the agent process is gone (Python `RpcProcessExitError`). */
export class RpcProcessExitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcProcessExitError";
	}
}

/** Interactive extension UI methods that take a value; headless hosts cancel them. */
const VALUE_UI_METHODS = new Set(["select", "input", "editor"]);

/** Command frames the adapter sends itself, bypassing `RpcClient`. */
type OwnCommand = Extract<RpcCommand, { type: "set_todos" } | { type: "prompt" }>;

/** An `OwnCommand` before the adapter assigns its request id. */
type OwnCommandBody = OwnCommand extends infer C ? (C extends OwnCommand ? Omit<C, "id"> : never) : never;

/** Prefix for adapter-owned request ids (never collides with `RpcClient`'s `req_N`). */
const OWN_ID_PREFIX = "robomp_";

/**
 * Headless answer to an extension UI request (Python `install_headless_ui()`
 * defaults): confirms are declined, select/input/editor are cancelled, and
 * everything else (passive, `cancel`, unknown methods) goes unanswered.
 */
export function headlessUiResponse(request: RpcExtensionUIRequest): RpcExtensionUIResponse | null {
	if (request.method === "confirm") return { type: "extension_ui_response", id: request.id, confirmed: false };
	if (VALUE_UI_METHODS.has(request.method)) return { type: "extension_ui_response", id: request.id, cancelled: true };
	return null;
}

/** Resolve a group name via /etc/group (Python `grp.getgrnam`). */
export function groupId(name: string): number | null {
	try {
		for (const line of fs.readFileSync("/etc/group", "utf-8").split("\n")) {
			const [group, , gid] = line.split(":");
			if (group === name && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
		}
	} catch {}
	return null;
}

function identityFor(options: OmpClientOptions): ProcessIdentity | null {
	if (options.user === null) return null;
	const groups = (options.extraGroups ?? []).map(name => groupId(name) ?? (name === "omp" ? SHARED_OMP_GID : -1));
	return {
		uid: options.user,
		gid: options.group ?? options.user,
		groups: groups.filter(gid => gid >= 0),
		umask: 0o002,
	};
}

function messageText(message: Record<string, unknown>): string | null {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Full message list of a terminal `agent_end`. An oversized frame is compacted
 * on the wire to its non-streamed tail plus `messageCount`; the streamed
 * prefix is rebuilt from the run's `message_end` events (Python
 * `_complete_agent_end_messages`).
 */
function completeAgentEndMessages(events: AgentEvent[], terminal: AgentEvent & { type: "agent_end" }): AgentMessage[] {
	const messageCount = (terminal as { messageCount?: unknown }).messageCount;
	if (typeof messageCount !== "number" || messageCount <= terminal.messages.length) return terminal.messages;
	let runStart = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]!.type === "agent_start") {
			runStart = i + 1;
			break;
		}
	}
	const streamed: AgentMessage[] = [];
	for (const event of events.slice(runStart)) if (event.type === "message_end") streamed.push(event.message);
	const prefixCount = messageCount - terminal.messages.length;
	if (prefixCount > streamed.length) {
		throw new Error(
			`Compacted agent_end references ${prefixCount} streamed messages, but only ${streamed.length} were retained`,
		);
	}
	return [...streamed.slice(0, prefixCount), ...terminal.messages];
}

/** Build a `PromptTurn` from the events of one prompt. */
export function buildPromptTurn(events: AgentEvent[]): PromptTurn {
	let messages: AgentMessage[] = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]!;
		if (event.type === "agent_end") {
			messages = completeAgentEndMessages(events.slice(0, i), event);
			break;
		}
	}
	let assistantMessage: Record<string, unknown> | null = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as unknown as Record<string, unknown>;
		if (message.role === "assistant") {
			assistantMessage = message;
			break;
		}
	}
	if (assistantMessage === null) {
		for (let i = events.length - 1; i >= 0; i--) {
			const message = (events[i] as { message?: unknown }).message;
			if (typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant") {
				assistantMessage = message as Record<string, unknown>;
				break;
			}
		}
	}
	return {
		events,
		messages,
		assistantMessage,
		assistantText: assistantMessage === null ? null : messageText(assistantMessage),
	};
}

/** Real `OmpClient` over the coding-agent RPC client. */
export class RpcOmpClient implements OmpClient {
	readonly #options: OmpClientOptions;
	readonly #client: RpcClient;
	readonly #dispatchNames = new Map<string, string>();
	readonly #ownPending = new Map<string, PromiseWithResolvers<RpcResponse>>();
	#ownRequestId = 0;
	#process: RpcAgentProcess | null = null;
	#headless = false;
	#closed: { promise: Promise<never>; reject: (error: Error) => void; error: Error | null };
	#started = false;

	constructor(options: OmpClientOptions) {
		this.#options = options;
		this.#closed = this.#newClosed();
		const customTools = options.customTools.map(tool => this.#trackDispatch(tool));
		const args: string[] = [];
		if (options.thinking !== null) args.push("--thinking", options.thinking);
		args.push("--append-system-prompt", options.appendSystemPrompt);
		if (options.noTitle) args.push("--no-title");
		args.push(...options.extraArgs);
		this.#client = new RpcClient({
			cwd: options.cwd,
			env: options.env,
			provider: options.provider ?? undefined,
			model: options.model,
			sessionDir: options.sessionDir,
			args,
			customTools,
			spawn: agentArgs => this.#spawn(agentArgs),
		});
	}

	#newClosed(): { promise: Promise<never>; reject: (error: Error) => void; error: Error | null } {
		const { promise, reject } = Promise.withResolvers<never>();
		// Only observed through races; never surface as an unhandled rejection.
		promise.catch(() => {});
		return { promise, reject, error: null };
	}

	#trackDispatch(tool: RpcClientCustomTool): RpcClientCustomTool {
		return {
			...tool,
			execute: (params, context) => {
				this.#dispatchNames.set(context.toolCallId, tool.name);
				return tool.execute(params, context);
			},
		};
	}

	#spawn(agentArgs: string[]): RpcAgentProcess {
		const argv = [this.#options.executable, ...agentArgs];
		const identity = identityFor(this.#options);
		const child = ptree.spawn(identity ? wrapWithIdentity(argv, identity) : argv, {
			cwd: this.#options.cwd,
			env: { ...Bun.env, ...this.#options.env },
			stdin: "pipe",
		});
		void child.exited.then(
			code => this.markClosed(new RpcProcessExitError(`omp exited with code ${code}`)),
			() => this.markClosed(new RpcProcessExitError("omp exited")),
		);
		const [clientStdout, tapStdout] = child.stdout.tee();
		const proc: RpcAgentProcess = {
			stdin: child.stdin,
			stdout: clientStdout,
			peekStderr: () => child.peekStderr(),
			kill: (signal, graceMs) => child.kill(signal, graceMs),
			exited: child.exited,
		};
		this.#process = proc;
		void this.#observe(tapStdout, proc);
		return proc;
	}

	/** Watch the agent's output for adapter-owned responses and extension UI requests. */
	async #observe(stdout: ReadableStream<Uint8Array>, proc: RpcAgentProcess): Promise<void> {
		let decoder = new RpcFrameDecoder();
		try {
			for await (const line of readJsonl<unknown>(stdout)) {
				let frame: object | undefined;
				try {
					frame = decoder.push(line);
				} catch {
					// Malformed chunking is `RpcClient`'s to report; just resync.
					decoder = new RpcFrameDecoder();
					continue;
				}
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && typeof frame.id === "string") {
					const pending = this.#ownPending.get(frame.id);
					if (pending) {
						this.#ownPending.delete(frame.id);
						pending.resolve(frame as unknown as RpcResponse);
					}
					continue;
				}
				if (this.#headless && frame.type === "extension_ui_request" && typeof frame.id === "string") {
					const response = headlessUiResponse(frame as unknown as RpcExtensionUIRequest);
					if (response !== null) this.#write(proc, response);
				}
			}
		} catch {
			// Output failures surface through `RpcClient` and the exit watcher.
		} finally {
			if (this.#process === proc) this.#process = null;
			const error = new RpcProcessExitError("omp output stream ended");
			for (const pending of this.#ownPending.values()) pending.reject(error);
			this.#ownPending.clear();
		}
	}

	#write(proc: RpcAgentProcess, frame: OwnCommand | RpcExtensionUIResponse): void {
		try {
			proc.stdin.write(`${JSON.stringify(frame)}\n`);
			const stdin = proc.stdin as { flush?: () => unknown };
			const flushed = stdin.flush?.();
			if (flushed instanceof Promise) flushed.catch(() => {});
		} catch {
			// The agent is gone; the pending request is rejected by the output tap.
		}
	}

	async #command(command: OwnCommandBody): Promise<RpcResponse> {
		const proc = this.#process;
		if (proc === null) throw new RpcProcessExitError("omp is not running");
		const id = `${OWN_ID_PREFIX}${++this.#ownRequestId}`;
		const pending = Promise.withResolvers<RpcResponse>();
		this.#ownPending.set(id, pending);
		this.#write(proc, { ...command, id } as OwnCommand);
		try {
			return await this.#request(pending.promise);
		} finally {
			this.#ownPending.delete(id);
		}
	}

	async start(): Promise<void> {
		const startup = this.#client.start();
		const { promise: timeout, resolve } = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => resolve("timeout"), this.#options.startupTimeout * 1000);
		try {
			const outcome = await Promise.race([startup.then(() => "ok" as const), timeout]);
			if (outcome === "timeout") {
				await this.#client.stop();
				throw new RpcProcessExitError(`omp did not become ready within ${this.#options.startupTimeout}s`);
			}
		} finally {
			clearTimeout(timer);
		}
		this.#started = true;
	}

	async close(): Promise<void> {
		if (!this.#started) return;
		await this.stop();
	}

	installHeadlessUi(): void {
		this.#headless = true;
	}

	onToolExecutionEnd(listener: (event: ToolExecutionEnd) => void): void {
		this.#client.onEvent(event => {
			if (event.type !== "tool_execution_end") return;
			const dispatched = this.#dispatchNames.get(event.toolCallId);
			this.#dispatchNames.delete(event.toolCallId);
			listener({ toolName: dispatched ?? event.toolName, isError: event.isError === true, result: event.result });
		});
	}

	onMessageUpdate(listener: (event: AgentEvent) => void): void {
		this.#client.onEvent(event => {
			if (event.type === "message_update") listener(event);
		});
	}

	/**
	 * Kill the agent. Like Python `RpcClient.stop()`, a running client is first
	 * marked closed with "RPC process stopped", so an in-flight prompt rejects
	 * with that error rather than the exit watcher's.
	 */
	stop(): Promise<void> {
		if (this.#started) this.markClosed(new RpcProcessExitError("RPC process stopped"));
		return this.#client.stop();
	}

	markClosed(error: Error): void {
		if (this.#closed.error !== null) return;
		this.#closed.error = error;
		this.#closed.reject(error);
	}

	async setTodos(phases: TodoPhase[]): Promise<void> {
		const response = await this.#command({ type: "set_todos", phases });
		if (!response.success) throw new Error(`set_todos failed: ${response.error}`);
	}

	async getTodos(): Promise<TodoPhase[]> {
		const state = await this.#request(this.#client.getState());
		return state.todoPhases ?? [];
	}

	#request<T>(promise: Promise<T>): Promise<T> {
		const { promise: timeout, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => reject(new Error(`RPC request timed out after ${this.#options.requestTimeout}s`)),
			this.#options.requestTimeout * 1000,
		);
		return Promise.race([promise, timeout, this.#closed.promise]).finally(() => clearTimeout(timer));
	}

	async promptAndWait(prompt: string, timeout: number): Promise<PromptTurn> {
		if (this.#closed.error !== null) throw this.#closed.error;
		// Subscribe before sending (Python snapshots the event index first). The
		// collector is observed here so a rejected `prompt` never leaves it to
		// reject unhandled when its timeout lapses.
		const collected = this.#client.collectEvents(Math.max(1, Math.round(timeout * 1000)));
		collected.catch(() => {});
		// The prompt goes out as an adapter-owned command: `RpcClient.prompt`
		// ignores a failed response, which would park the turn until the
		// timeout, while Python's `prompt()` raises on it immediately.
		const response = await this.#command({ type: "prompt", message: prompt });
		if (!response.success) throw new Error(`prompt failed: ${response.error}`);
		const events = await Promise.race([collected, this.#closed.promise]);
		return buildPromptTurn(events);
	}
}
