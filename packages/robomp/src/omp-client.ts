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
 */
import * as fs from "node:fs";
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { RpcAgentProcess, RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { ptree } from "@oh-my-pi/pi-utils";
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

/** Passive extension UI methods (notifications/status) need no response. */
const PASSIVE_UI_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"]);

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

/** Build a `PromptTurn` from the events of one prompt. */
export function buildPromptTurn(events: AgentEvent[]): PromptTurn {
	let messages: AgentMessage[] = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]!;
		if (event.type === "agent_end") {
			messages = event.messages;
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
		return child;
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
		this.#client.onExtensionUiRequest((request: RpcExtensionUIRequest) => {
			if (request.method === "cancel" || PASSIVE_UI_METHODS.has(request.method)) return;
			if (request.method === "confirm") {
				this.#client.sendExtensionUiResponse({ type: "extension_ui_response", id: request.id, confirmed: false });
				return;
			}
			this.#client.sendExtensionUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
		});
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

	stop(): Promise<void> {
		return this.#client.stop();
	}

	markClosed(error: Error): void {
		if (this.#closed.error !== null) return;
		this.#closed.error = error;
		this.#closed.reject(error);
	}

	async setTodos(phases: TodoPhase[]): Promise<void> {
		await this.#request(this.#client.setTodos(phases));
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
		const events = await Promise.race([
			this.#client.promptAndWait(prompt, undefined, Math.max(1, Math.round(timeout * 1000))),
			this.#closed.promise,
		]);
		return buildPromptTurn(events);
	}
}
