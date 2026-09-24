/**
 * `RpcOmpClient` against a scripted RPC agent: the adapter-owned frames
 * (`set_todos`, headless extension UI replies) that bypass `RpcClient`.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type OmpClientOptions, RpcOmpClient } from "../src/omp-client";
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

test("headless UI declines confirms, cancels other prompts and leaves passive requests unanswered", async () => {
	const omp = await startClient();
	omp.installHeadlessUi();
	const turn = await omp.promptAndWait("go", 10);
	expect(JSON.parse(turn.assistantText ?? "null")).toEqual([
		{ type: "extension_ui_response", id: "ui-confirm", confirmed: false },
		{ type: "extension_ui_response", id: "ui-select", cancelled: true },
	]);
});
