/**
 * `RpcOmpClient` against a scripted RPC agent: the adapter-owned frames
 * (`set_todos`, headless extension UI replies) that bypass `RpcClient`.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { buildPromptTurn, type OmpClientOptions, RpcOmpClient, RpcProcessExitError } from "../src/omp-client";
import { tmpPath } from "./helpers";

const FIXTURE = path.join(import.meta.dir, "fixtures", "fake-omp-rpc.ts");

let client: RpcOmpClient | null = null;

afterEach(async () => {
	await client?.close();
	client = null;
});

async function startClient(): Promise<RpcOmpClient> {
	const dir = tmpPath();
	const executable = path.join(dir, "omp");
	fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`, { mode: 0o755 });
	const options: OmpClientOptions = {
		executable,
		cwd: dir,
		sessionDir: path.join(dir, "session"),
		env: {},
		noTitle: true,
		model: "test/model",
		provider: null,
		thinking: null,
		appendSystemPrompt: "",
		customTools: [],
		requestTimeout: 10,
		startupTimeout: 10,
		extraArgs: [],
		user: null,
		group: null,
		extraGroups: null,
	};
	client = new RpcOmpClient(options);
	await client.start();
	return client;
}

test("setTodos reaches the agent and getTodos reads the stored phases back", async () => {
	const omp = await startClient();
	const phases = [{ name: "Classify", tasks: [{ content: "Read the issue", status: "pending" as const }] }];
	await omp.setTodos(phases);
	expect(await omp.getTodos()).toEqual(phases);
});

test("setTodos surfaces a failed set_todos response", async () => {
	const omp = await startClient();
	await expect(omp.setTodos([{ name: "reject", tasks: [] }])).rejects.toThrow("set_todos failed: todo rejected");
});

test("headless UI declines confirms, cancels value prompts and leaves the rest unanswered", async () => {
	// Python `install_headless_ui()` defaults: confirm → false; select/input/
	// editor → cancelled; passive, `cancel` and unknown methods → no reply
	// (the fixture fails the turn if any of those is answered).
	const omp = await startClient();
	omp.installHeadlessUi();
	const turn = await omp.promptAndWait("go", 10);
	expect(JSON.parse(turn.assistantText ?? "null")).toEqual([
		{ type: "extension_ui_response", id: "ui-confirm", confirmed: false },
		{ type: "extension_ui_response", id: "ui-select", cancelled: true },
		{ type: "extension_ui_response", id: "ui-input", cancelled: true },
		{ type: "extension_ui_response", id: "ui-editor", cancelled: true },
	]);
});

test("stop rejects an in-flight prompt with RpcProcessExitError('RPC process stopped')", async () => {
	// Without headless UI the fixture's turn never ends; stop() must unblock
	// the wait with Python's stop() error rather than the exit watcher's.
	const omp = await startClient();
	const pending = omp.promptAndWait("go", 10).then(
		() => null,
		(err: unknown) => err,
	);
	await Bun.sleep(50);
	await omp.stop();
	const failure = await pending;
	expect(failure).toBeInstanceOf(RpcProcessExitError);
	expect((failure as Error).message).toBe("RPC process stopped");
});

test("a rejected prompt surfaces its error and leaves no dangling wait", async () => {
	const omp = await startClient();
	await expect(omp.promptAndWait("reject", 0.2)).rejects.toThrow("prompt rejected");
	// Outlive the collector's timeout: it must not reject unhandled.
	await Bun.sleep(400);
});

test("buildPromptTurn rebuilds a compacted agent_end from streamed message_end events", () => {
	const user = { role: "user", content: "hi", timestamp: 1 };
	const assistant = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 };
	const events = [
		{ type: "agent_start" },
		{ type: "message_end", message: user },
		{ type: "message_end", message: assistant },
		{ type: "agent_end", messages: [], messageCount: 2 },
	] as unknown as AgentEvent[];
	const turn = buildPromptTurn(events);
	expect(turn.messages).toEqual([user, assistant] as unknown as AgentMessage[]);
	expect(turn.assistantText).toBe("done");
	const truncated = [events[0], events[2], { type: "agent_end", messages: [], messageCount: 3 }] as AgentEvent[];
	expect(() => buildPromptTurn(truncated)).toThrow(
		"Compacted agent_end references 3 streamed messages, but only 1 were retained",
	);
});
