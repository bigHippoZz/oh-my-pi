/**
 * Resume-aware behavior of the worker RPC driver (port of test_worker.py).
 *
 * `workerDeps.createClient` is swapped for a recording fake so we can observe
 * the `extraArgs` and `setTodos` decisions the driver takes based on whether
 * the workspace's omp session directory already holds a JSONL transcript.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cancellation from "../src/cancellation";
import type { Settings } from "../src/config";
import type { Database } from "../src/db";
import type { DirtyState } from "../src/git-ops";
import type { GitHubBackend } from "../src/github-backend";
import * as hostTools from "../src/host-tools";
import { AbortController, ToolBindings } from "../src/host-tools";
import type { NativesCache } from "../src/natives-cache";
import {
	type OmpClient,
	type OmpClientOptions,
	type PromptTurn,
	RpcProcessExitError,
	type TodoPhase,
	type ToolExecutionEnd,
} from "../src/omp-client";
import * as persona from "../src/persona";
import { LocalGitTransport, Workspace } from "../src/sandbox";
import * as subprocess from "../src/subprocess";
import { directiveInfo } from "../src/task-types";
import * as worker from "../src/worker";
import { makeDb, makeSettings, tmpPath } from "./helpers";

class FakeClient implements OmpClient {
	static instances: FakeClient[] = [];
	static onPrompt: ((client: FakeClient, prompt: string) => void) | null = null;
	setTodosCalls: TodoPhase[][] = [];
	getTodosCalls = 0;
	stopCalls = 0;
	markClosedCalls: Error[] = [];
	prompts: string[] = [];
	toolEndCallbacks: ((event: ToolExecutionEnd) => void)[] = [];

	constructor(readonly options: OmpClientOptions) {
		FakeClient.instances.push(this);
	}
	async start(): Promise<void> {}
	async close(): Promise<void> {}
	installHeadlessUi(): void {}
	onToolExecutionEnd(listener: (event: ToolExecutionEnd) => void): void {
		this.toolEndCallbacks.push(listener);
	}
	onMessageUpdate(): void {}
	async stop(): Promise<void> {
		this.stopCalls += 1;
	}
	markClosed(error: Error): void {
		this.markClosedCalls.push(error);
	}
	async setTodos(phases: TodoPhase[]): Promise<void> {
		this.setTodosCalls.push(phases);
	}
	async getTodos(): Promise<TodoPhase[]> {
		this.getTodosCalls += 1;
		return [];
	}
	async promptAndWait(prompt: string): Promise<PromptTurn> {
		this.prompts.push(prompt);
		FakeClient.onPrompt?.(this, prompt);
		return { events: [], messages: [], assistantMessage: null, assistantText: "ok" };
	}
}

const SEEDED_PHASES: persona.TodoPhase[] = [{ name: "Reproduce", tasks: ["do it"] }];
const SEEDED_TODOS: TodoPhase[] = [{ name: "Reproduce", tasks: [{ content: "do it", status: "pending" }] }];

const restores: (() => void)[] = [];
function track<T extends { mockRestore(): void }>(spy: T): T {
	restores.push(() => spy.mockRestore());
	return spy;
}
const originalPaths = { ...worker.workerPaths };

let tmp: string;
beforeEach(() => {
	tmp = tmpPath();
	FakeClient.instances = [];
	FakeClient.onPrompt = null;
	worker.workerPaths.agentHomeStage = path.join(tmp, "missing-agent-home-stage");
	worker.workerPaths.agentHome = path.join(tmp, "missing-agent-home");
	track(spyOn(worker.workerDeps, "createClient").mockImplementation(options => new FakeClient(options)));
	track(spyOn(hostTools, "build").mockImplementation(() => []));
	track(spyOn(persona, "systemAppend").mockImplementation(() => "SYS"));
	track(spyOn(persona, "seedPhases").mockImplementation(() => SEEDED_PHASES.map(p => ({ ...p }))));
});

afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	Object.assign(worker.workerPaths, originalPaths);
});

interface Fixture {
	inputs: worker.TaskInputs;
	bindings: ToolBindings;
	settings: Settings;
	db: Database;
}

function makeInputs(options: { sessionHasJsonl: boolean; slotUid?: number | null; settings?: Settings }): Fixture {
	const settings = options.settings ?? makeSettings();
	const db = makeDb();
	const root = path.join(tmp, "workspace");
	fs.mkdirSync(root);
	const sessionDir = path.join(root, "session");
	fs.mkdirSync(sessionDir);
	if (options.sessionHasJsonl) fs.writeFileSync(path.join(sessionDir, "foo.jsonl"), "{}\n");
	const repoDir = path.join(root, "repo");
	fs.mkdirSync(repoDir);
	const workspace = new Workspace(
		root,
		repoDir,
		sessionDir,
		path.join(root, "context"),
		path.join(root, "artifacts"),
		"robomp/issue-1",
		"acme/widgets",
		1,
	);
	const repo = { full_name: "acme/widgets", default_branch: "main", clone_url: "", private: false };
	const issue = {
		repo: "acme/widgets",
		number: 1,
		title: "bug",
		body: "",
		state: "open",
		author: "alice",
		labels: [],
		is_pull_request: false,
	};
	const github = {} as GitHubBackend;
	const inputs = worker.taskInputs({
		settings,
		db,
		github,
		gitTransport: new LocalGitTransport(null),
		repo,
		issue,
		workspace,
		deliveryId: "d-test",
		slotUid: options.slotUid ?? null,
	});
	const bindings = new ToolBindings({
		db,
		github,
		gitTransport: inputs.gitTransport,
		repo,
		issue,
		workspace,
		authorName: settings.resolved_author_name,
		authorEmail: settings.git_author_email,
	});
	return { inputs, bindings, settings, db };
}

function runRpc(fixture: Fixture, taskKind = "triage_issue", prompt = "x", bindings?: ToolBindings) {
	return worker.runRpc(fixture.inputs, { taskKind, prompt, bindings: bindings ?? fixture.bindings });
}

function fake(): FakeClient {
	return FakeClient.instances[0]!;
}

test("runTask sets implAuthorized from directive", async () => {
	const { inputs } = makeInputs({ sessionHasJsonl: false });
	let captured = null as boolean | null;
	track(spyOn(worker.runTaskDeps, "buildPrompt").mockImplementation(() => "prompt"));
	track(
		spyOn(worker.runTaskDeps, "runRpc").mockImplementation(async (_inputs, args) => {
			captured = args.bindings.implAuthorized;
			return "ok";
		}),
	);
	const result = await worker.runTask({
		taskKind: "triage_issue",
		inputs,
		directive: directiveInfo({ body: "go ahead", author: "can1357", authorizes_impl: true }),
	});
	expect(result).toBe("ok");
	expect(captured).toBe(true);
});

test("runTask preserves implAuthorized when resuming", async () => {
	const { inputs } = makeInputs({ sessionHasJsonl: true });
	let captured = null as boolean | null;
	track(spyOn(worker.runTaskDeps, "buildPrompt").mockImplementation(() => "prompt"));
	track(
		spyOn(hostTools, "build").mockImplementation(bindings => {
			captured = bindings.implAuthorized;
			return [];
		}),
	);
	const result = await worker.runTask({
		taskKind: "handle_comment",
		inputs,
		directive: directiveInfo({ body: "go ahead", author: "can1357", authorizes_impl: true }),
	});
	expect(result).toBe("ok");
	expect(captured).toBe(true);
	expect(fake().options.extraArgs).toEqual(["--continue"]);
});

test("runRpc passes --continue when session jsonl present", async () => {
	const fixture = makeInputs({ sessionHasJsonl: true });
	await runRpc(fixture);
	expect(fake().options.extraArgs).toEqual(["--continue"]);
});

test("runRpc omits --continue when session empty", async () => {
	const agentHome = path.join(tmp, "agent-home");
	fs.mkdirSync(agentHome);
	worker.workerPaths.agentHome = agentHome;
	const fixture = makeInputs({ sessionHasJsonl: false });
	await runRpc(fixture);
	const options = fake().options;
	expect(options.extraArgs).toEqual([]);
	expect(options.env.HOME).toBe(agentHome);
	expect(options.env.GITHUB_TOKEN).toBe("");
	expect(options.env.GITHUB_WEBHOOK_SECRET).toBe("");
	expect(options.env.ROBOMP_REPLAY_TOKEN).toBe("");
	expect(options.env.ROBOMP_GH_PROXY_HMAC_KEY).toBe("");
	expect(options.user).toBeNull();
	expect(options.group).toBeNull();
	expect(options.extraGroups).toBeNull();
});

function mode(p: string): number {
	return fs.statSync(p).mode & 0o777;
}

test("buildExtraEnv stages agent home", () => {
	const stageHome = path.join(tmp, "agent-home-stage");
	const agentHome = path.join(tmp, "agent-home");
	worker.workerPaths.agentHomeStage = stageHome;
	worker.workerPaths.agentHome = agentHome;
	const agentDir = path.join(stageHome, ".agent");
	fs.mkdirSync(path.join(agentDir, "rules"), { recursive: true });
	fs.mkdirSync(path.join(stageHome, ".omp", "agent"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "agent instructions\n");
	fs.writeFileSync(path.join(agentDir, "rules", "rule.md"), "rule\n");
	fs.writeFileSync(path.join(stageHome, ".omp", "agent", "models.yml"), "models: []\n");

	const env = worker.buildExtraEnv(makeSettings());

	expect(env.HOME).toBe(agentHome);
	expect(fs.statSync(path.join(agentHome, ".agent", "AGENTS.md")).isFile()).toBe(true);
	expect(fs.statSync(path.join(agentHome, ".agent", "rules", "rule.md")).isFile()).toBe(true);
	expect(fs.statSync(path.join(agentHome, ".omp", "agent", "models.yml")).isFile()).toBe(true);
	expect(mode(path.join(agentHome, ".agent"))).toBe(0o755);
	expect(mode(path.join(agentHome, ".agent", "AGENTS.md"))).toBe(0o644);
	expect(mode(path.join(agentHome, ".agent", "rules"))).toBe(0o755);
	expect(mode(path.join(agentHome, ".agent", "rules", "rule.md"))).toBe(0o644);
	expect(mode(path.join(agentHome, ".omp", "agent"))).toBe(0o755);
	expect(mode(path.join(agentHome, ".omp", "agent", "models.yml"))).toBe(0o644);
});

test("runRpc omits HOME when agent home absent", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false });
	await runRpc(fixture);
	const env = fake().options.env;
	expect("HOME" in env).toBe(false);
	expect(env.GITHUB_TOKEN).toBe("");
	expect(env.GITHUB_WEBHOOK_SECRET).toBe("");
	expect(env.ROBOMP_REPLAY_TOKEN).toBe("");
	expect(env.ROBOMP_GH_PROXY_HMAC_KEY).toBe("");
});

test("runRpc uses workspace XDG dirs without slot", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false, slotUid: null });
	await runRpc(fixture);
	const env = fake().options.env;
	const root = fixture.inputs.workspace.root;
	const xdgRoot = path.join(root, ".omp-xdg");
	for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
		expect(env[key]!.startsWith(`${xdgRoot}/`)).toBe(true);
		expect(fs.statSync(path.join(env[key]!, "omp")).isDirectory()).toBe(true);
	}
	const tmpdir = path.join(root, ".omp-tmp");
	expect(env.TMPDIR).toBe(tmpdir);
	expect(env.TMP).toBe(tmpdir);
	expect(env.TEMP).toBe(tmpdir);
	expect(env.GIT_CONFIG_COUNT).toBe("1");
	expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
	expect(env.GIT_CONFIG_VALUE_0).toBe(fixture.inputs.workspace.repo_dir);
	expect(env.GIT_AUTHOR_NAME).toBe(fixture.settings.resolved_author_name);
	expect(env.GIT_AUTHOR_EMAIL).toBe(fixture.settings.git_author_email);
	expect(env.GIT_COMMITTER_NAME).toBe(fixture.settings.resolved_author_name);
	expect(env.GIT_COMMITTER_EMAIL).toBe(fixture.settings.git_author_email);
	expect(mode(tmpdir)).toBe(0o700);
});

test("runRpc uses workspace XDG dirs for slot without chown", async () => {
	const chownCalls: unknown[] = [];
	track(spyOn(subprocess.platformInfo, "system").mockReturnValue("linux"));
	track(spyOn(subprocess.platformInfo, "geteuid").mockReturnValue(0));
	track(spyOn(fs, "chownSync").mockImplementation((...args) => void chownCalls.push(args)));
	const fixture = makeInputs({ sessionHasJsonl: false, slotUid: 2001 });
	await runRpc(fixture);
	const env = fake().options.env;
	for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
		expect(fs.statSync(env[key]!).isDirectory()).toBe(true);
		expect(fs.statSync(path.join(env[key]!, "omp")).isDirectory()).toBe(true);
	}
	expect(fs.statSync(env.BUN_INSTALL_CACHE_DIR!).isDirectory()).toBe(true);
	expect(chownCalls).toEqual([]);
});

test("runRpc skips setTodos on resumed triage", async () => {
	const fixture = makeInputs({ sessionHasJsonl: true });
	await runRpc(fixture);
	expect(fake().setTodosCalls).toEqual([]);
});

test("runRpc seeds todos on fresh triage", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false });
	await runRpc(fixture);
	expect(fake().setTodosCalls).toEqual([SEEDED_TODOS]);
});

test("runRpc merges todos on follow-up with resume", async () => {
	const fixture = makeInputs({ sessionHasJsonl: true });
	await runRpc(fixture, "handle_comment");
	expect(fake().getTodosCalls).toBe(1);
	expect(fake().setTodosCalls).toHaveLength(1);
	expect(fake().setTodosCalls[0]).toHaveLength(SEEDED_PHASES.length);
});

test("runRpc passes slot uid as user, slot group and omp extra group", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false, slotUid: 2001 });
	await runRpc(fixture);
	const options = fake().options;
	expect(options.user).toBe(2001);
	expect(options.group).toBe(2001);
	expect(options.extraGroups).toEqual(["omp"]);
});

class FakeTimer implements worker.Timer {
	daemon = false;
	started = false;
	cancelled = false;
	constructor(
		readonly interval: number,
		readonly fn: () => void,
		readonly fireOnStart = false,
	) {}
	start(): void {
		this.started = true;
		if (this.fireOnStart) this.fn();
	}
	cancel(): void {
		this.cancelled = true;
	}
}

test("runRpc arms hard timeout timer", async () => {
	const timers: FakeTimer[] = [];
	track(
		spyOn(worker.workerDeps, "createTimer").mockImplementation((interval, fn) => {
			const timer = new FakeTimer(interval, fn);
			timers.push(timer);
			return timer;
		}),
	);
	const settings = makeSettings({ ROBOMP_TASK_TIMEOUT_SECONDS: "3", ROBOMP_TASK_TIMEOUT_HARD_GRACE_SECONDS: "7" });
	const fixture = makeInputs({ sessionHasJsonl: false, settings });
	await runRpc(fixture);
	expect(timers).toHaveLength(1);
	const timer = timers[0]!;
	expect(timer.interval).toBe(10);
	expect(timer.daemon).toBe(true);
	expect(timer.started).toBe(true);
	expect(timer.cancelled).toBe(true);
});

test("runRpc hard timeout stops client and fails", async () => {
	track(
		spyOn(worker.workerDeps, "createTimer").mockImplementation((interval, fn) => new FakeTimer(interval, fn, true)),
	);
	const fixture = makeInputs({ sessionHasJsonl: false });
	const failure = await runRpc(fixture).then(
		() => null,
		(err: unknown) => err,
	);
	expect(failure).toBeInstanceOf(worker.HardTimeoutError);
	expect((failure as Error).name).toBe("TimeoutError");
	expect((failure as Error).message).toContain("hard timeout");
	expect(fake().stopCalls).toBe(1);
	// The cancel hook (manual cancel and hard timeout) MUST also mark the
	// client closed so an in-flight prompt unblocks immediately.
	expect(fake().markClosedCalls).toHaveLength(1);
	expect(fake().markClosedCalls[0]).toBeInstanceOf(RpcProcessExitError);
});

test("runRpc hard timeout that kills the prompt surfaces the prompt's error", async () => {
	// Python raises `TimeoutError` only when the turn itself returned; a prompt
	// the hard timeout interrupted propagates its own RPC error unchanged.
	let fire: (() => void) | null = null;
	track(
		spyOn(worker.workerDeps, "createTimer").mockImplementation((interval, fn) => {
			fire = fn;
			return new FakeTimer(interval, fn);
		}),
	);
	FakeClient.onPrompt = () => {
		fire!();
		throw new RpcProcessExitError("RPC process stopped");
	};
	const fixture = makeInputs({ sessionHasJsonl: false });
	const failure = await runRpc(fixture).then(
		() => null,
		(err: unknown) => err,
	);
	expect(failure).toBeInstanceOf(RpcProcessExitError);
	expect((failure as Error).message).toBe("RPC process stopped");
	expect(fake().stopCalls).toBe(1);
});

test("runRpc cancel hook stops and marks closed", async () => {
	const captured: (() => void)[] = [];
	track(spyOn(cancellation, "registerCancelHook").mockImplementation(hook => void captured.push(hook)));
	track(spyOn(cancellation, "unregisterCancelHook").mockImplementation(() => {}));
	const fixture = makeInputs({ sessionHasJsonl: false });
	await runRpc(fixture);
	expect(captured).toHaveLength(1);
	const preStop = fake().stopCalls;
	captured[0]!();
	expect(fake().stopCalls).toBe(preStop + 1);
	expect(fake().markClosedCalls).toHaveLength(1);
	expect(fake().markClosedCalls[0]).toBeInstanceOf(RpcProcessExitError);
	expect(fake().markClosedCalls[0]!.message).toContain("cancelled by operator");
});

function makeInputsWithClassification(classification: string | null): Fixture {
	const fixture = makeInputs({ sessionHasJsonl: true });
	const { db, bindings } = fixture;
	db.upsertIssue({ key: bindings.issueKey, repo: "acme/widgets", number: 1, state: "reproducing" });
	if (classification) db.setIssueClassification(bindings.issueKey, classification);
	return fixture;
}

function emitToolEnd(client: FakeClient, event: ToolExecutionEnd): void {
	for (const cb of client.toolEndCallbacks) cb(event);
}

test("runRpc sends reminder when PR-class triage quits early", async () => {
	const fixture = makeInputsWithClassification("bug");
	await runRpc(fixture, "triage_issue", "kickoff");
	const prompts = fake().prompts;
	// kickoff + 2 reminders (default ROBOMP_TASK_COMPLETION_MAX_REMINDERS=2)
	expect(prompts).toHaveLength(1 + fixture.settings.task_completion_max_reminders);
	expect(prompts[0]).toBe("kickoff");
	for (const prompt of prompts.slice(1)) {
		const parts = new Set(prompt.split("`"));
		for (const tool of ["gh_open_pr", "mark_unable_to_reproduce", "abort_task"]) expect(parts.has(tool)).toBe(true);
	}
});

test("runRpc stops reminding after terminal tool", async () => {
	const fixture = makeInputsWithClassification("bug");
	FakeClient.onPrompt = (client, _prompt) => {
		// The first reminder turn "calls" gh_open_pr.
		if (client.prompts.length === 2) emitToolEnd(client, { toolName: "gh_open_pr", result: {}, isError: false });
	};
	await runRpc(fixture, "triage_issue", "kickoff");
	// kickoff + 1 reminder; second reminder NOT sent because gh_open_pr fired.
	expect(fake().prompts).toHaveLength(2);
});

test("runRpc skips reminder for non-PR classification", async () => {
	const fixture = makeInputsWithClassification("question");
	await runRpc(fixture, "triage_issue", "kickoff");
	expect(fake().prompts).toHaveLength(1);
});

test("runRpc skips reminder when unclassified", async () => {
	const fixture = makeInputsWithClassification(null);
	await runRpc(fixture, "triage_issue", "kickoff");
	expect(fake().prompts).toHaveLength(1);
});

test("runRpc review_pr reminds until submit_pr_review", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false });
	await runRpc(fixture, "review_pr", "kickoff");
	const prompts = fake().prompts;
	expect(prompts).toHaveLength(1 + fixture.settings.task_completion_max_reminders);
	expect(prompts[0]).toBe("kickoff");
	for (const prompt of prompts.slice(1)) {
		expect(prompt).toContain("submit_pr_review");
		expect(prompt).not.toContain("gh_open_pr");
	}
});

test("runRpc review_pr stops after submit without dirty probe", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false });
	track(
		spyOn(worker.workerDeps, "probeWorkspaceDirty").mockImplementation(async () => {
			throw new Error("review_pr must not run dirty-state probes");
		}),
	);
	FakeClient.onPrompt = client => emitToolEnd(client, { toolName: "submit_pr_review", result: {}, isError: false });
	await runRpc(fixture, "review_pr", "kickoff");
	expect(fake().prompts).toEqual(["kickoff"]);
});

test("runRpc review_pr still reminds when submit fails", async () => {
	// A rejected submit (isError) does not count as the terminal action.
	const fixture = makeInputs({ sessionHasJsonl: false });
	FakeClient.onPrompt = client =>
		emitToolEnd(client, {
			toolName: "submit_pr_review",
			result: { content: [{ type: "text", text: "GitHub rejected PR review: 422" }] },
			isError: true,
		});
	await runRpc(fixture, "review_pr", "kickoff");
	const prompts = fake().prompts;
	expect(prompts).toHaveLength(1 + fixture.settings.task_completion_max_reminders);
	for (const prompt of prompts.slice(1)) expect(prompt).toContain("submit_pr_review");
});

// ---------------------------------------------------------------------------
// Dirty-state watchdog
// ---------------------------------------------------------------------------

const CLEAN: DirtyState = { uncommitted: 0, unpushed: 0, summary: "" };

test("runRpc sends dirty-state reminder when worktree has unpushed work", async () => {
	// Agent ended its turn with unpushed commits → reminder; clean → loop exits.
	const fixture = makeInputs({ sessionHasJsonl: false });
	const states: DirtyState[] = [{ uncommitted: 2, unpushed: 1, summary: "Unpushed commits (1):\nabc1234 wip" }, CLEAN];
	track(spyOn(worker.workerDeps, "probeWorkspaceDirty").mockImplementation(async () => states.shift() ?? CLEAN));
	await runRpc(fixture, "handle_comment", "kickoff");
	const prompts = fake().prompts;
	expect(prompts).toHaveLength(2);
	expect(prompts[1]).toContain("Unpushed commits");
	expect(prompts[1]).toContain("abc1234");
	expect(prompts[1]).not.toContain("{{");
});

test("runRpc skips dirty-state reminder when worktree is clean", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false });
	track(spyOn(worker.workerDeps, "probeWorkspaceDirty").mockImplementation(async () => CLEAN));
	await runRpc(fixture, "handle_comment", "kickoff");
	expect(fake().prompts).toHaveLength(1);
});

test("runRpc caps dirty-state reminders at budget", async () => {
	const fixture = makeInputs({ sessionHasJsonl: false });
	const dirty: DirtyState = { uncommitted: 1, unpushed: 0, summary: "Uncommitted changes (1):\n?? oops.txt" };
	track(spyOn(worker.workerDeps, "probeWorkspaceDirty").mockImplementation(async () => dirty));
	await runRpc(fixture, "handle_comment", "kickoff");
	expect(fake().prompts).toHaveLength(1 + fixture.settings.task_completion_max_reminders);
});

// ---------------------------------------------------------------------------
// Natives-cache capture-on-success
// ---------------------------------------------------------------------------

class RecordingNativesCache {
	captureCalls: [string, string, string][] = [];
	constructor(readonly raiseOnCapture = false) {}
	async capture(repo: string, key: string, nativeDir: string): Promise<string | null> {
		this.captureCalls.push([repo, key, nativeDir]);
		if (this.raiseOnCapture) throw new Error("simulated cache failure");
		return nativeDir;
	}
}

function makeCaptureInputs(cache: RecordingNativesCache | null, withNativeArtifacts: boolean): worker.TaskInputs {
	const { inputs } = makeInputs({ sessionHasJsonl: false });
	if (withNativeArtifacts) {
		const nativeDir = path.join(inputs.workspace.repo_dir, "packages", "natives", "native");
		fs.mkdirSync(nativeDir, { recursive: true });
		fs.writeFileSync(path.join(nativeDir, "pi_natives.linux-arm64.node"), "ELFx");
		for (const name of ["index.d.ts", "index.js", "embedded-addon.js"])
			fs.writeFileSync(path.join(nativeDir, name), "");
	}
	return { ...inputs, nativesCache: cache as unknown as NativesCache | null };
}

test("captureNativesCache is a no-op without cache", async () => {
	const inputs = makeCaptureInputs(null, true);
	const keySpy = track(spyOn(worker.workerDeps, "nativesComputeKey"));
	await worker.captureNativesCache(inputs);
	expect(keySpy).not.toHaveBeenCalled();
});

test("captureNativesCache skips without artifacts", async () => {
	const cache = new RecordingNativesCache();
	await worker.captureNativesCache(makeCaptureInputs(cache, false));
	expect(cache.captureCalls).toEqual([]);
});

test("captureNativesCache swallows key compute failure", async () => {
	// Repo dir is not a git repo → the key compute fails.
	const cache = new RecordingNativesCache();
	await worker.captureNativesCache(makeCaptureInputs(cache, true));
	expect(cache.captureCalls).toEqual([]);
});

test("captureNativesCache swallows capture exception", async () => {
	const cache = new RecordingNativesCache(true);
	track(spyOn(worker.workerDeps, "nativesComputeKey").mockImplementation(async () => "deadbeef"));
	await worker.captureNativesCache(makeCaptureInputs(cache, true));
	expect(cache.captureCalls).toHaveLength(1);
});

test("captureNativesCache records on success", async () => {
	const cache = new RecordingNativesCache();
	track(spyOn(worker.workerDeps, "nativesComputeKey").mockImplementation(async () => "cafef00d"));
	const inputs = makeCaptureInputs(cache, true);
	await worker.captureNativesCache(inputs);
	expect(cache.captureCalls).toEqual([
		["acme/widgets", "cafef00d", path.join(inputs.workspace.repo_dir, "packages", "natives", "native")],
	]);
});

function releaseFixture(sessionHasJsonl: boolean): Fixture {
	const fixture = makeInputs({ sessionHasJsonl });
	const release = {
		tag: "v17.2.8",
		version: "17.2.8",
		round: 2,
		max_rounds: 5,
		head_sha: "abc",
		default_branch: "main",
		failures_text: "tests failed",
		run_urls: ["https://example/run"],
	};
	const inputs = { ...fixture.inputs, issue: null, release };
	const bindings = new ToolBindings({
		db: fixture.db,
		github: inputs.github,
		gitTransport: inputs.gitTransport,
		repo: inputs.repo,
		issue: null,
		workspace: inputs.workspace,
		authorName: fixture.settings.resolved_author_name,
		authorEmail: fixture.settings.git_author_email,
		abort: new AbortController(),
		release: {
			repo: "acme/widgets",
			tag: "v17.2.8",
			version: "17.2.8",
			key: "acme/widgets#v17.2.8",
			expected_sha: "abc",
			default_branch: "main",
		},
	});
	return { ...fixture, inputs, bindings };
}

test("release prompt routes fresh and resumed sessions", () => {
	const { inputs } = releaseFixture(false);
	track(spyOn(persona, "kickoffRelease").mockImplementation(() => "fresh"));
	track(spyOn(persona, "followupRelease").mockImplementation(() => "resumed"));
	expect(worker.buildPrompt("handle_release_ci", inputs, { resuming: false })).toBe("fresh");
	expect(worker.buildPrompt("handle_release_ci", inputs, { resuming: true })).toBe("resumed");
});

test("release task reminds until terminal tool runs", async () => {
	const fixture = releaseFixture(false);
	track(spyOn(persona, "systemAppendRelease").mockImplementation(() => "SYS RELEASE"));
	track(spyOn(persona, "followupRelease").mockImplementation(() => "retag or abort"));
	await runRpc(fixture, "handle_release_ci", "kickoff");
	expect(fake().options.appendSystemPrompt).toBe("SYS RELEASE");
	expect(fixture.settings.release_model_pool).toContain(fake().options.model);
	expect(fake().prompts).toEqual([
		"kickoff",
		...Array<string>(fixture.settings.task_completion_max_reminders).fill("retag or abort"),
	]);
});
