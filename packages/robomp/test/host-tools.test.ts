/** Host tool tests against a mocked GitHub transport (port of test_host_tools.py). */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { Settings } from "../src/config";
import type { Database } from "../src/db";
import { GitCommandError, type PushResult } from "../src/git-ops";
import {
	GitHubClient,
	type IssueIndexEntry,
	type IssueInfo,
	type RepoInfo,
	TRANSIENT_RETRY_DELAYS,
} from "../src/github-client";
import * as hostTools from "../src/host-tools";
import {
	AbortController,
	build,
	HostToolCommandError,
	hostToolsDeps,
	type ReleaseToolContext,
	ToolBindings,
	type ToolBindingsInit,
} from "../src/host-tools";
import { type HttpTransport, jsonResponse, mockTransport } from "../src/http";
import { pySplitlines } from "../src/pycompat";
import { type GitTransport, LocalGitTransport, SandboxManager, Workspace } from "../src/sandbox";
import * as subprocess from "../src/subprocess";
import type { CompletedProcess, RunOptions } from "../src/subprocess";
import { makeDb, makeSettings, tmpPath } from "./helpers";

const spies: (() => void)[] = [];
const originalRetryDelays = TRANSIENT_RETRY_DELAYS.value;
afterEach(() => {
	for (const restore of spies.splice(0)) restore();
	TRANSIENT_RETRY_DELAYS.value = originalRetryDelays;
});

/** Collapse the client's transient-error backoff so connect failures resolve fast. */
function fastRetries(): void {
	TRANSIENT_RETRY_DELAYS.value = [0.001, 0.001, 0.001];
}

function track<T extends { mockRestore(): void }>(spy: T): T {
	spies.push(() => spy.mockRestore());
	return spy;
}

function stubWorkspace(tmp: string): Workspace {
	const root = path.join(tmp, "ws");
	const repoDir = path.join(root, "repo");
	const sessionDir = path.join(root, ".omp-session");
	const contextDir = path.join(root, "context");
	const artifactsDir = path.join(root, "artifacts");
	for (const p of [root, repoDir, sessionDir, contextDir, path.join(contextDir, "repro"), artifactsDir]) {
		fs.mkdirSync(p, { recursive: true });
	}
	return new Workspace(
		root,
		repoDir,
		sessionDir,
		contextDir,
		artifactsDir,
		"farm/abc12345/some-issue",
		"octo/widget",
		42,
	);
}

function stubIssue(): IssueInfo {
	return {
		repo: "octo/widget",
		number: 42,
		title: "boom",
		body: "b",
		state: "open",
		author: "alice",
		labels: ["bug"],
		is_pull_request: false,
	};
}

function stubRepo(): RepoInfo {
	return { full_name: "octo/widget", default_branch: "main", clone_url: "https://x/octo/widget.git", private: false };
}

// Unified diff whose anchorable lines are RIGHT {10..14} / LEFT {9..12};
// line 15+ is a gap (unanchorable) and RIGHT line 9 is before the hunk.
const PATCH = "@@ -9,5 +10,6 @@ def f():\n ctx1\n-old10\n+new11\n ctx2\n+new13\n ctx3\n";

function prFilesResponse(patch: string = PATCH, status = 200): Response {
	if (status !== 200) return jsonResponse(status, { message: "files fetch failed" });
	return jsonResponse(200, [{ filename: "src/app.py", status: "modified", additions: 1, deletions: 1, patch }]);
}

const fail500: HttpTransport = mockTransport(() => new Response(null, { status: 500 }));

function comment201(id: number, body = "hi"): Response {
	return jsonResponse(201, { id, user: { login: "robomp-bot" }, body, created_at: "t" });
}

function newBindings(db: Database, init: Partial<ToolBindingsInit> & { tmp: string; transport: HttpTransport }) {
	const { tmp, transport, ...rest } = init;
	return new ToolBindings({
		db,
		github: new GitHubClient("token", { transport }),
		gitTransport: new LocalGitTransport(null),
		repo: stubRepo(),
		issue: stubIssue(),
		workspace: stubWorkspace(tmp),
		authorName: "robomp-bot",
		authorEmail: "robomp-bot@example.invalid",
		...rest,
	});
}

/** `_bindings` fixture: bindings plus the issue row the tools key on. */
function bindingsFor(
	db: Database,
	tmp: string,
	transport: HttpTransport,
	extra: Partial<ToolBindingsInit> = {},
): ToolBindings {
	const bindings = newBindings(db, { tmp, transport, ...extra });
	db.upsertIssue({
		key: bindings.issueKey,
		repo: "octo/widget",
		number: 42,
		state: "reproducing",
		branch: bindings.workspace.branch,
		session_dir: bindings.workspace.session_dir,
	});
	return bindings;
}

/** Rebuild bindings with overrides (Python `dataclasses.replace`). */
function replaceBindings(bindings: ToolBindings, overrides: Partial<ToolBindingsInit>): ToolBindings {
	return new ToolBindings({
		db: bindings.db,
		github: bindings.github,
		gitTransport: bindings.gitTransport,
		repo: bindings.repo,
		issue: bindings.issue,
		workspace: bindings.workspace,
		authorName: bindings.authorName,
		authorEmail: bindings.authorEmail,
		settings: bindings.settings,
		inboundThreadNumber: bindings.inboundThreadNumber,
		inboundIsPr: bindings.inboundIsPr,
		reviewMode: bindings.reviewMode,
		implAuthorized: bindings.implAuthorized,
		slotUid: bindings.slotUid,
		abort: bindings.abort,
		release: bindings.release,
		...overrides,
	});
}

function toolNamed(bindings: ToolBindings, name: string): RpcClientCustomTool {
	const tool = build(bindings).find(x => x.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	return tool;
}

const ctx = { toolCallId: "tc-1", signal: new globalThis.AbortController().signal, sendUpdate: () => {} };

/** Execute a tool; results are strings except `release_retag`'s object payload. */
async function run(bindings: ToolBindings, name: string, args: Record<string, unknown>): Promise<string> {
	return (await toolNamed(bindings, name).execute(args, ctx)) as string;
}

async function runRaw(bindings: ToolBindings, name: string, args: Record<string, unknown>): Promise<unknown> {
	return toolNamed(bindings, name).execute(args, ctx);
}

async function expectCommandError(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(HostToolCommandError);
		return (err as Error).message;
	}
	throw new Error("expected HostToolCommandError");
}

function completed(args: readonly string[], returncode: number, stdout = "", stderr = ""): CompletedProcess {
	return { args: [...args], returncode, stdout, stderr, timedOut: false };
}

type RepoCommandFn = (
	bindings: ToolBindings,
	cmd: readonly string[],
	options?: hostTools.RepoCommandOptions,
) => Promise<CompletedProcess>;

function fakeRepoCommands(fn: RepoCommandFn): void {
	track(spyOn(hostToolsDeps, "runRepoCommand").mockImplementation(fn));
}

async function bodyJson(request: Request): Promise<any> {
	return JSON.parse(await request.text());
}

function toolCallRows(
	db: Database,
	tool: string,
): { args_json: string; result_json: string | null; error: string | null }[] {
	return db.conn.query("SELECT args_json, result_json, error FROM tool_calls WHERE tool=? ORDER BY id").all(tool) as {
		args_json: string;
		result_json: string | null;
		error: string | null;
	}[];
}

test("repo command env scrubs secrets and uses workspace cache", () => {
	const db = makeDb();
	const tmp = tmpPath();
	const saved = { ...process.env };
	process.env.GITHUB_TOKEN = "secret-token";
	process.env.GITHUB_WEBHOOK_SECRET = "secret-webhook";
	process.env.ROBOMP_GH_PROXY_HMAC_KEY = "secret-proxy";
	process.env.BUN_INSTALL_CACHE_DIR = "/data/cache/bun-cache";
	let env: Record<string, string>;
	let bindings: ToolBindings;
	try {
		bindings = bindingsFor(db, tmp, fail500, { slotUid: 2001 });
		env = hostTools.repoCommandEnv(bindings);
	} finally {
		for (const key of [
			"GITHUB_TOKEN",
			"GITHUB_WEBHOOK_SECRET",
			"ROBOMP_GH_PROXY_HMAC_KEY",
			"BUN_INSTALL_CACHE_DIR",
		]) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
	const root = bindings.workspace.root;
	expect(env.GITHUB_TOKEN).toBe("");
	expect(env.GITHUB_WEBHOOK_SECRET).toBe("");
	expect(env.ROBOMP_GH_PROXY_HMAC_KEY).toBe("");
	expect(env.BUN_INSTALL_CACHE_DIR).toBe(path.join(root, ".omp-xdg", "cache", "bun-install"));
	expect(env.XDG_CACHE_HOME).toBe(path.join(root, ".omp-xdg", "cache"));
	expect(env.TMPDIR).toBe(path.join(root, ".omp-tmp"));
	expect(env.GIT_CONFIG_COUNT).toBe("1");
	expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
	expect(env.GIT_CONFIG_VALUE_0).toBe(bindings.workspace.repo_dir);
	expect(env.GIT_AUTHOR_NAME).toBe(bindings.authorName);
	expect(env.GIT_AUTHOR_EMAIL).toBe(bindings.authorEmail);
	expect(env.GIT_COMMITTER_NAME).toBe(bindings.authorName);
	expect(env.GIT_COMMITTER_EMAIL).toBe(bindings.authorEmail);
	expect(fs.statSync(path.join(root, ".omp-tmp")).isDirectory()).toBe(true);
});

test("run repo command uses slot identity", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500, { slotUid: 2001 });
	track(spyOn(subprocess.platformInfo, "system").mockReturnValue("linux"));
	track(spyOn(subprocess.platformInfo, "geteuid").mockReturnValue(0));
	let captured: { argv: readonly string[]; options: RunOptions | undefined } | null = null;
	track(
		spyOn(subprocess.processRunner, "run").mockImplementation(async (argv, options) => {
			captured = { argv, options };
			return completed(argv, 0, "ok");
		}),
	);
	const proc = await hostTools.runRepoCommand(bindings, ["git", "status"]);
	expect(proc.stdout).toBe("ok");
	expect(captured!.argv).toEqual(["git", "status"]);
	expect(captured!.options?.cwd).toBe(bindings.workspace.repo_dir);
	expect(captured!.options?.identity).toEqual({ uid: 2001, gid: 2001, groups: [2000], umask: 0o002 });
	expect(captured!.options?.env?.BUN_INSTALL_CACHE_DIR?.endsWith("/.omp-xdg/cache/bun-install")).toBe(true);
});

function writeBunRepo(repoDir: string): void {
	fs.mkdirSync(repoDir, { recursive: true });
	fs.writeFileSync(path.join(repoDir, "package.json"), '{"name":"x"}');
	fs.writeFileSync(path.join(repoDir, "bun.lock"), "{}");
}

test("ensure workspace dependencies installs when missing", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	writeBunRepo(bindings.workspace.repo_dir);
	const captured: string[][] = [];
	fakeRepoCommands(async (_b, cmd) => {
		captured.push([...cmd]);
		return completed(cmd, 0, "449 packages installed");
	});
	await hostTools.ensureWorkspaceDependencies(bindings);
	expect(captured).toEqual([["bun", "install", "--frozen-lockfile", "--ignore-scripts"]]);
});

test("ensure workspace dependencies reinstalls when node_modules present", async () => {
	// A bare node_modules/ dir is NOT a "fully installed" sentinel: a prior
	// install that timed out half-way leaves a partial tree. The frozen install
	// must still run so bun re-links anything missing.
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	writeBunRepo(bindings.workspace.repo_dir);
	fs.mkdirSync(path.join(bindings.workspace.repo_dir, "node_modules"));
	const captured: string[][] = [];
	fakeRepoCommands(async (_b, cmd) => {
		captured.push([...cmd]);
		return completed(cmd, 0, "Checked 449 packages");
	});
	await hostTools.ensureWorkspaceDependencies(bindings);
	expect(captured).toEqual([["bun", "install", "--frozen-lockfile", "--ignore-scripts"]]);
});

test("ensure workspace dependencies skips non-bun repo", async () => {
	// repo_dir exists (created by stubWorkspace) but has no package.json/bun.lock.
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	let called = false;
	fakeRepoCommands(async () => {
		called = true;
		throw new Error("must not install in a non-bun repo");
	});
	await hostTools.ensureWorkspaceDependencies(bindings);
	expect(called).toBe(false);
});

test("ensure workspace dependencies swallows install failure", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	writeBunRepo(bindings.workspace.repo_dir);
	fakeRepoCommands(async (_b, cmd) => completed(cmd, 1, "", "lockfile out of date"));
	// A stale frozen lockfile (e.g. a PR that bumped deps) must not raise.
	await hostTools.ensureWorkspaceDependencies(bindings);
	expect(fs.existsSync(path.join(bindings.workspace.repo_dir, "node_modules"))).toBe(false);
});

class RecordingPushTransport extends LocalGitTransport {
	calls: Record<string, unknown>[] = [];
	constructor() {
		super(null);
	}
	override async pushBranch(args: Parameters<GitTransport["pushBranch"]>[0]): Promise<PushResult> {
		this.calls.push({ ...args });
		return { head: args.expectedHead, branch: args.branch };
	}
}

test("guarded push branch rev-parse runs via repo command and passes slot uid", async () => {
	const db = makeDb();
	const transport = new RecordingPushTransport();
	const bindings = replaceBindings(bindingsFor(db, tmpPath(), fail500, { slotUid: 2001 }), {
		gitTransport: transport,
	});
	const commands: string[][] = [];
	fakeRepoCommands(async (commandBindings, cmd) => {
		expect(commandBindings.slotUid).toBe(2001);
		const command = [...cmd];
		commands.push(command);
		if (command.join(" ") === "git rev-parse HEAD") return completed(command, 0, "abc123\n");
		if (command.slice(0, 3).join(" ") === "git log --format=%H%x09%ae%x09%an") {
			return completed(command, 0, "abc123\trobomp-bot@example.invalid\trobomp-bot\n");
		}
		return completed(command, 0);
	});
	track(spyOn(hostToolsDeps, "shareGitMetadataWithSlots").mockImplementation(() => {}));
	const head = await hostTools.guardedPushBranch(bindings, {}, "gh_push_branch", bindings.workspace.branch);
	expect(head).toBe("abc123");
	expect(commands).toContainEqual(["git", "rev-parse", "HEAD"]);
	expect(transport.calls).toEqual([
		{
			repo: "octo/widget",
			workspaceKey: "octo__widget__42",
			repoDir: bindings.workspace.repo_dir,
			branch: bindings.workspace.branch,
			expectedHead: "abc123",
			slotUid: 2001,
		},
	]);
});

test("gh_post_comment happy path", async () => {
	const db = makeDb();
	const captured: Record<string, unknown> = {};
	const transport = mockTransport(async request => {
		captured.url = request.url;
		captured.body = await bodyJson(request);
		captured.auth = request.headers.get("authorization");
		return comment201(999);
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "gh_post_comment", { body: "hi" });
	expect(result.startsWith("comment posted")).toBe(true);
	expect(String(captured.url).endsWith("/repos/octo/widget/issues/42/comments")).toBe(true);
	expect(captured.body).toEqual({ body: "hi" });
	expect(captured.auth).toBe("Bearer token");
});

test("gh_post_comment validates body", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "gh_post_comment", { body: "" }));
});

test("gh_post_comment defaults to inbound PR thread", async () => {
	// PR conversation/review tasks set inboundThreadNumber to the PR; the reply
	// must land on that PR by default, not the originating issue.
	const db = makeDb();
	let url = "";
	const transport = mockTransport(request => {
		url = request.url;
		return comment201(7);
	});
	const bindings = newBindings(db, { tmp: tmpPath(), transport, inboundThreadNumber: 99 });
	await run(bindings, "gh_post_comment", { body: "hi" });
	expect(url.endsWith("/repos/octo/widget/issues/99/comments")).toBe(true);
});

test("gh_post_comment explicit number overrides inbound", async () => {
	const db = makeDb();
	let url = "";
	const transport = mockTransport(request => {
		url = request.url;
		return comment201(7);
	});
	const bindings = newBindings(db, { tmp: tmpPath(), transport, inboundThreadNumber: 99 });
	await run(bindings, "gh_post_comment", { body: "hi", number: 42 });
	expect(url.endsWith("/repos/octo/widget/issues/42/comments")).toBe(true);
});

test("gh_post_comment propagates GitHub error", async () => {
	const db = makeDb();
	const transport = mockTransport(() => jsonResponse(422, { message: "Validation failed" }));
	const bindings = bindingsFor(db, tmpPath(), transport);
	const msg = await expectCommandError(run(bindings, "gh_post_comment", { body: "hi" }));
	expect(msg).toContain("422");
});

test("gh_open_pr requires template sections", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	db.setIssueClassification(bindings.issueKey, "bug");
	const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "t", body: "no sections" }));
	expect(msg).toContain("Repro");
});

const REPRO_ARGS = {
	title: "panic on empty input",
	command: "bun test foo.test.ts",
	output: "Error: boom",
	exit_code: 1,
};

test("repro_record writes transcript", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	const result = await run(bindings, "repro_record", { ...REPRO_ARGS, reproduced: true });
	expect(result).toBe("recorded");
	const files = fs.readdirSync(bindings.workspace.repro_dir);
	expect(files).toHaveLength(1);
	expect(fs.readFileSync(path.join(bindings.workspace.repro_dir, files[0]!), "utf-8")).toContain("exit_code: 1");
});

test("repro_record clears needs-info after actionable reply", async () => {
	const db = makeDb();
	const removed: [string, string][] = [];
	const transport = mockTransport(request => {
		removed.push([request.method, new URL(request.url).pathname]);
		return new Response(null, { status: 204 });
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	db.setIssueState(bindings.issueKey, "needs_info");
	const result = await run(bindings, "repro_record", REPRO_ARGS);
	expect(result).toBe("recorded");
	expect(removed).toEqual([["DELETE", "/repos/octo/widget/issues/42/labels/needs-info"]]);
	expect(db.getIssue(bindings.issueKey)?.state).toBe("reproducing");
});

test("repro_record advances needs-info when label is missing", async () => {
	const db = makeDb();
	const transport = mockTransport(request => {
		expect(request.method).toBe("DELETE");
		expect(new URL(request.url).pathname).toBe("/repos/octo/widget/issues/42/labels/needs-info");
		return jsonResponse(404, { message: "Label does not exist" });
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	db.setIssueState(bindings.issueKey, "needs_info");
	await run(bindings, "repro_record", REPRO_ARGS);
	expect(db.getIssue(bindings.issueKey)?.state).toBe("reproducing");
});

test("repro_record advances needs-info when cleanup transport fails", async () => {
	fastRetries();
	const db = makeDb();
	const transport = mockTransport(() => {
		throw new TypeError("connection dropped");
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	db.setIssueState(bindings.issueKey, "needs_info");
	const result = await run(bindings, "repro_record", REPRO_ARGS);
	expect(result).toBe("recorded");
	expect(db.getIssue(bindings.issueKey)?.state).toBe("reproducing");
});

test("repro_record chowns to slot when root", async () => {
	const db = makeDb();
	const chowns: [string, number, number][] = [];
	track(
		spyOn(hostToolsDeps, "slotPermissionsActive").mockImplementation(
			((uid: number | null | undefined) =>
				uid !== null && uid !== undefined) as typeof hostToolsDeps.slotPermissionsActive,
		),
	);
	track(spyOn(hostToolsDeps, "chown").mockImplementation((p, uid, gid) => void chowns.push([p, uid, gid])));
	const bindings = bindingsFor(db, tmpPath(), fail500, { slotUid: 2001 });
	const result = await run(bindings, "repro_record", REPRO_ARGS);
	expect(result).toBe("recorded");
	const files = fs.readdirSync(bindings.workspace.repro_dir);
	expect(files).toHaveLength(1);
	expect(chowns).toEqual([[path.join(bindings.workspace.repro_dir, files[0]!), 2001, 2001]]);
});

test("repro_record rejects bad args", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "repro_record", { title: "", command: "x", output: "y", exit_code: 1 }));
	await expectCommandError(run(bindings, "repro_record", { title: "t", command: "x", output: "y", exit_code: "bad" }));
});

const UNABLE_ARGS = { diagnosis: "needed exact version", info_needed: "post bun --version" };

test("mark_unable posts comment, marks needs-info and labels issue", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const transport = mockTransport(async request => {
		if (new URL(request.url).pathname.endsWith("/labels")) {
			captured.labels = await bodyJson(request);
			return jsonResponse(200, [{ name: "bug" }, { name: "needs-info" }]);
		}
		captured.comment = await bodyJson(request);
		return comment201(321, "x");
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "mark_unable_to_reproduce", UNABLE_ARGS);
	expect(result).toContain("needs-info comment");
	expect(captured.labels).toEqual({ labels: ["needs-info"] });
	expect(captured.comment.body).toContain("resume from this context");
	expect(db.getIssue(bindings.issueKey)?.state).toBe("needs_info");
});

test("mark_unable keeps needs-info when label is missing", async () => {
	const db = makeDb();
	const transport = mockTransport(request => {
		if (new URL(request.url).pathname.endsWith("/labels")) {
			return jsonResponse(422, { message: "Label does not exist" });
		}
		return comment201(321, "x");
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	await run(bindings, "mark_unable_to_reproduce", UNABLE_ARGS);
	expect(db.getIssue(bindings.issueKey)?.state).toBe("needs_info");
});

test("mark_unable keeps needs-info when label transport fails", async () => {
	fastRetries();
	const db = makeDb();
	let comments = 0;
	const transport = mockTransport(request => {
		if (new URL(request.url).pathname.endsWith("/labels")) throw new TypeError("connection dropped");
		comments += 1;
		return comment201(321, "x");
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	await run(bindings, "mark_unable_to_reproduce", UNABLE_ARGS);
	expect(comments).toBe(1);
	expect(db.getIssue(bindings.issueKey)?.state).toBe("needs_info");
	const rows = toolCallRows(db, "mark_unable_to_reproduce");
	const result = JSON.parse(rows[rows.length - 1]!.result_json!);
	expect(result.label_error).toContain("TransportError");
});

test("abort_task signals controller and abandons without comment", async () => {
	const db = makeDb();
	// Any HTTP call is a regression: abort_task MUST NOT touch GitHub.
	const transport = mockTransport(request => {
		throw new Error(`abort_task issued an HTTP request to ${request.url}`);
	});
	const controller = new AbortController();
	let stops = 0;
	controller.stop = () => {
		stops += 1;
	};
	const bindings = replaceBindings(bindingsFor(db, tmpPath(), transport), { abort: controller });
	const result = await run(bindings, "abort_task", {
		reason: "ref dir owned by foreign uid; git commit cannot lock HEAD",
	});
	expect(result).toBe("aborted");
	expect(controller.triggered).toBe(true);
	expect(controller.reason).toContain("foreign uid");
	expect(stops).toBe(1);
	expect(db.getIssue(bindings.issueKey)?.state).toBe("abandoned");
	const row = db.conn
		.query("SELECT tool, args_json FROM tool_calls WHERE issue_key=? AND tool=?")
		.get(bindings.issueKey, "abort_task") as { args_json: string } | null;
	expect(row).not.toBeNull();
	expect(row!.args_json).toContain("foreign uid");
});

test("abort_task rejects empty reason", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "abort_task", { reason: "   " }));
	// No state change on rejected validation.
	expect(db.getIssue(bindings.issueKey)?.state).toBe("reproducing");
});

test("abort_task signal is idempotent", () => {
	const controller = new AbortController();
	let fires = 0;
	controller.stop = () => {
		fires += 1;
	};
	controller.signal("first");
	controller.signal("second");
	expect(controller.triggered).toBe(true);
	expect(controller.reason).toBe("first"); // second call must not overwrite
	expect(fires).toBe(1);
});

test("fetch_issue_thread returns markdown", async () => {
	const db = makeDb();
	const transport = mockTransport(request => {
		if (new URL(request.url).pathname.endsWith("/comments")) {
			return jsonResponse(200, [{ id: 1, user: { login: "alice" }, body: "still broken", created_at: "t1" }]);
		}
		return jsonResponse(200, {
			number: 42,
			title: "boom",
			body: "b",
			state: "open",
			user: { login: "alice" },
			labels: [{ name: "bug" }],
		});
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "fetch_issue_thread", {});
	expect(result).toContain("octo/widget#42");
	expect(result).toContain("@alice");
	expect(result).toContain("still broken");
});

function echoLabels(captured: Record<string, any>): HttpTransport {
	return mockTransport(async request => {
		captured.path = new URL(request.url).pathname;
		captured.body = await bodyJson(request);
		return jsonResponse(
			200,
			(captured.body.labels as string[]).map(n => ({ name: n })),
		);
	});
}

test("classify_issue applies labels and persists primary", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = bindingsFor(db, tmpPath(), echoLabels(captured));
	const result = await run(bindings, "classify_issue", {
		primary: "bug",
		priority: "prio:p1",
		functional: ["tool", "agent"],
		provider: "provider:openai",
		platform: "platform:macos",
		rationale: "tool call panics on empty arg on macOS",
	});
	expect(result).toContain("classified as bug");
	expect(result.toLowerCase()).toContain("reproduce");
	expect(captured.path.endsWith("/issues/42/labels")).toBe(true);
	expect(captured.body.labels).toEqual([
		"bug",
		"prio:p1",
		"tool",
		"agent",
		"providers",
		"provider:openai",
		"platform:macos",
		"triaged",
	]);
	expect(db.getIssue(bindings.issueKey)?.classification).toBe("bug");
});

test("classify_issue question skips repro path", async () => {
	const db = makeDb();
	const transport = mockTransport(() => jsonResponse(200, [{ name: "question" }, { name: "triaged" }]));
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "classify_issue", { primary: "question", rationale: "how-to about config" });
	expect(result).toContain("question");
	expect(result).toContain("no PR");
	expect(db.getIssue(bindings.issueKey)?.classification).toBe("question");
});

test("classify_issue wontfix takes comment-only path", async () => {
	// `wontfix` is a non-PR primary: labels land, classification persists, and
	// the echoed next step routes to a single explanatory comment.
	const db = makeDb();
	const transport = mockTransport(() => jsonResponse(200, [{ name: "wontfix" }, { name: "triaged" }]));
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "classify_issue", {
		primary: "wontfix",
		rationale: "intentional design tradeoff, no demonstrated impact",
	});
	expect(result).toContain("wontfix");
	expect(result).toContain("no PR");
	expect(db.getIssue(bindings.issueKey)?.classification).toBe("wontfix");
});

test("gh_search_issues scopes repo and renders matches", async () => {
	// Search auto-prefixes the repo scope, surfaces PR/state_reason, and filters
	// the inbound issue.
	const db = makeDb();
	let q = null as string | null;
	const transport = mockTransport(request => {
		q = new URL(request.url).searchParams.get("q");
		return jsonResponse(200, {
			total_count: 3,
			items: [
				{
					number: 42, // the inbound issue itself — must be filtered
					title: "boom",
					state: "open",
					user: { login: "alice" },
					labels: [],
					comments: 0,
					updated_at: "2026-07-01T00:00:00Z",
					created_at: "2026-07-01T00:00:00Z",
					html_url: "https://example/42",
				},
				{
					number: 30,
					title: "same crash on resize",
					state: "closed",
					state_reason: "not_planned",
					user: { login: "bob" },
					labels: [{ name: "wontfix" }],
					comments: 3,
					updated_at: "2026-06-01T00:00:00Z",
					created_at: "2026-05-01T00:00:00Z",
					html_url: "https://example/30",
				},
				{
					number: 31,
					title: "fix: resize crash",
					state: "closed",
					state_reason: "completed",
					user: { login: "bot" },
					labels: [],
					comments: 1,
					updated_at: "2026-06-02T00:00:00Z",
					created_at: "2026-06-02T00:00:00Z",
					html_url: "https://example/pull/31",
					pull_request: { url: "https://example/pull/31" },
				},
			],
		});
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "gh_search_issues", { query: "resize crash" });
	expect(q).toBe("repo:octo/widget resize crash");
	expect(result).not.toContain("#42"); // inbound issue filtered out
	expect(result).toContain("#30 (issue, closed (not_planned))");
	expect(result).toContain("#31 (PR, closed (completed))");
});

test("gh_search_issues rejects repo qualifier and empty query", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "gh_search_issues", { query: "repo:evil/elsewhere secrets" }));
	await expectCommandError(run(bindings, "gh_search_issues", { query: "   " }));
});

function indexEntry(init: Partial<IssueIndexEntry> & Pick<IssueIndexEntry, "number">): IssueIndexEntry {
	return {
		repo: "octo/widget",
		is_pull_request: false,
		title: "",
		body: "",
		state: "open",
		state_reason: "",
		merged_at: "",
		author: "",
		labels: [],
		comments: 0,
		created_at: "",
		updated_at: "",
		html_url: "",
		...init,
	};
}

test("gh_search_issues serves from local index once synced", async () => {
	// With a sync watermark present the tool answers from SQLite: qualifiers
	// become filters, merged PRs render as `merged`, and NO GitHub call happens.
	const db = makeDb();
	const transport = mockTransport(() => {
		throw new Error("local-index search must not call GitHub");
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	db.setIssueIndexWatermark("octo/widget", "2026-07-01T00:00:00Z");
	db.upsertIssueIndex(
		indexEntry({
			number: 31,
			is_pull_request: true,
			title: "fix: resize crash",
			body: "handles narrow terminals",
			state: "closed",
			merged_at: "2026-06-02T00:00:00Z",
			author: "bot",
			comments: 1,
			created_at: "2026-06-02T00:00:00Z",
			updated_at: "2026-06-02T00:00:00Z",
			html_url: "https://example/pull/31",
		}),
	);
	db.upsertIssueIndex(
		indexEntry({
			number: 30,
			title: "resize crash report",
			state: "closed",
			state_reason: "not_planned",
			author: "bob",
			labels: ["wontfix"],
			comments: 3,
			created_at: "2026-05-01T00:00:00Z",
			updated_at: "2026-06-01T00:00:00Z",
			html_url: "https://example/30",
		}),
	);
	const result = await run(bindings, "gh_search_issues", { query: "resize crash" });
	const prOnly = await run(bindings, "gh_search_issues", { query: "resize crash is:merged" });
	expect(result).toContain("#30 (issue, closed (not_planned))");
	expect(result).toContain("#31 (PR, merged)");
	expect(prOnly).toContain("#31");
	expect(prOnly).not.toContain("#30");
});

function gitOrThrow(args: string[], cwd?: string): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

/** Turn the stub workspace repo_dir into a git repo with two commits. */
function gitRepoWithCommits(bindings: ToolBindings): void {
	const repo = bindings.workspace.repo_dir;
	const ident = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];
	gitOrThrow(["init", "-q", "-b", "main", repo]);
	fs.writeFileSync(path.join(repo, "a.txt"), "plain start\n");
	gitOrThrow(["-C", repo, "add", "."]);
	gitOrThrow(["-C", repo, ...ident, "commit", "-q", "-m", "feat: initial import"]);
	fs.writeFileSync(path.join(repo, "a.txt"), "plain start\nsplitPathAndSel guard\n");
	gitOrThrow(["-C", repo, "add", "."]);
	gitOrThrow(["-C", repo, ...ident, "commit", "-q", "-m", "fix(tools): colon selector literal paths"]);
}

test("search_commits message and patch modes", async () => {
	// message mode greps commit messages; patch mode pickaxes diff content.
	// Without an origin ref the search falls back to HEAD instead of failing.
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	gitRepoWithCommits(bindings);
	const byMessage = await run(bindings, "search_commits", { query: "colon selector" });
	const byPatch = await run(bindings, "search_commits", { query: "splitPathAndSel", mode: "patch" });
	const none = await run(bindings, "search_commits", { query: "nonexistent-topic" });
	await expectCommandError(run(bindings, "search_commits", { query: "x", mode: "bogus" }));
	expect(byMessage).toContain("fix(tools): colon selector literal paths");
	expect(byMessage).not.toContain("feat: initial import");
	expect(byPatch).toContain("fix(tools): colon selector literal paths");
	expect(none.startsWith("No commits")).toBe(true);
});
test("classify_issue rejects bug without priority", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "classify_issue", { primary: "bug", rationale: "yes a bug" }));
});

test("classify_issue drops priority on non-bug", async () => {
	// Non-bug primaries silently drop a stray `priority` rather than rejecting:
	// some models treat every schema property as required and would loop forever.
	const db = makeDb();
	const captured: Record<string, any> = {};
	const transport = mockTransport(async request => {
		captured.body = await bodyJson(request);
		return jsonResponse(200, [{ name: "question" }, { name: "triaged" }]);
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "classify_issue", {
		primary: "question",
		priority: "prio:p3",
		rationale: "how-to",
	});
	expect(result).toContain("question");
	expect(captured.body.labels ?? []).not.toContain("prio:p3");
	expect(db.getIssue(bindings.issueKey)?.classification).toBe("question");
});

test("classify_issue rejects unknown primary", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "classify_issue", { primary: "nonsense", rationale: "x" }));
});

/** Same as bindingsFor but `inboundIsPr` — webhook arrived on a PR. */
function prBindings(db: Database, tmp: string, transport: HttpTransport): ToolBindings {
	const bindings = newBindings(db, { tmp, transport, inboundThreadNumber: 99, inboundIsPr: true });
	db.upsertIssue({
		key: bindings.issueKey,
		repo: "octo/widget",
		number: 42,
		state: "opened",
		branch: bindings.workspace.branch,
		session_dir: bindings.workspace.session_dir,
		pr_number: 99,
	});
	db.setIssueClassification(bindings.issueKey, "bug");
	return bindings;
}

function reviewBindings(db: Database, tmp: string, transport: HttpTransport, platform = "github"): ToolBindings {
	const workspace = stubWorkspace(tmp);
	workspace.issue_number = 99;
	const bindings = new ToolBindings({
		db,
		github: new GitHubClient("token", { transport, platform }),
		gitTransport: new LocalGitTransport(null),
		repo: stubRepo(),
		issue: {
			repo: "octo/widget",
			number: 99,
			title: "contributor PR",
			body: "body",
			state: "open",
			author: "alice",
			labels: [],
			is_pull_request: true,
		},
		workspace,
		authorName: "robomp-bot",
		authorEmail: "robomp-bot@example.invalid",
		inboundThreadNumber: 99,
		inboundIsPr: true,
		reviewMode: true,
	});
	db.upsertIssue({
		key: bindings.issueKey,
		repo: "octo/widget",
		number: 99,
		state: "reviewing",
		branch: bindings.workspace.branch,
		session_dir: bindings.workspace.session_dir,
		pr_number: 99,
	});
	return bindings;
}

function pathOf(request: Request): string {
	return new URL(request.url).pathname;
}

const unrouted = (): Response => jsonResponse(404, { message: "unrouted" });

function reviewOk(id = 44, body = "ok"): Response {
	return jsonResponse(200, { id, user: { login: "robomp-bot" }, body, state: "COMMENTED", submitted_at: "t" });
}

/** Transport serving PR files + capturing the reviews POST. */
function reviewTransport(
	captured: Record<string, any>,
	options: { patch?: string; filesStatus?: number; echoBody?: boolean } = {},
): HttpTransport {
	return mockTransport(async request => {
		const p = pathOf(request);
		if (p === "/repos/octo/widget/pulls/99/files") return prFilesResponse(options.patch, options.filesStatus);
		if (p.endsWith("/reviews")) {
			captured.path = p;
			captured.body = await bodyJson(request);
			return reviewOk(44, options.echoBody ? captured.body.body : "ok");
		}
		return unrouted();
	});
}

test("fetch_pr returns premise and changed files", async () => {
	const db = makeDb();
	const transport = mockTransport(request => {
		const p = pathOf(request);
		if (p === "/repos/octo/widget/pulls/99") {
			return jsonResponse(200, {
				number: 99,
				html_url: "https://github.com/octo/widget/pull/99",
				title: "Fix crash",
				body: "Fixes #42",
				head: { ref: "fix-crash", repo: { full_name: "alice/widget" } },
				base: { ref: "main" },
				state: "open",
				user: { login: "alice" },
			});
		}
		if (p === "/repos/octo/widget/pulls/99/files") {
			return jsonResponse(200, [{ filename: "src/app.py", status: "modified", additions: 5, deletions: 2 }]);
		}
		return unrouted();
	});
	const bindings = reviewBindings(db, tmpPath(), transport);
	const result = await run(bindings, "fetch_pr", {});
	expect(result).toContain("Fix crash");
	expect(result).toContain("#42");
	expect(result).toContain("`src/app.py` (modified, +5/-2)");
});

test("classify_pr applies review labels and persists rank", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), echoLabels(captured));
	const result = await run(bindings, "classify_pr", {
		rank: "review:p1",
		type: "fix",
		area: ["tool", "unknown"],
		provider: "provider:openai",
		rationale: "fixes the tool crash with a scoped guard",
	});
	expect(result).toContain("review:p1");
	expect(captured.path.endsWith("/issues/99/labels")).toBe(true);
	expect(captured.body.labels).toEqual(["triaged", "review:p1", "fix", "tool", "providers", "provider:openai"]);
	expect(db.getIssue(bindings.issueKey)?.classification).toBe("review:p1");
});

test("classify_pr rejects bad rank", async () => {
	const db = makeDb();
	const bindings = reviewBindings(db, tmpPath(), fail500);
	await expectCommandError(
		run(bindings, "classify_pr", { rank: "prio:p1", type: "fix", rationale: "wrong namespace" }),
	);
});

test("pr_review_comment stages and submit flushes one COMMENT review", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured, { echoBody: true }));
	const staged = await run(bindings, "pr_review_comment", {
		path: "src/app.py",
		line: 12,
		side: "RIGHT",
		start_line: 10,
		start_side: "RIGHT",
		body: "blocking: this dereferences cfg before the guard.",
	});
	expect(staged).toContain("staged_count=1");
	const rows = db.listStagedReviewComments(bindings.issueKey);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.path).toBe("src/app.py");

	const result = await run(bindings, "submit_pr_review", { body: "review:p1 — one blocking issue", event: "APPROVE" });
	expect(result).toContain("submitted PR review");
	expect(captured.path.endsWith("/pulls/99/reviews")).toBe(true);
	expect(captured.body).toEqual({
		body: "review:p1 — one blocking issue",
		event: "COMMENT",
		comments: [
			{
				path: "src/app.py",
				line: 12,
				side: "RIGHT",
				body: "blocking: this dereferences cfg before the guard.",
				start_line: 10,
				start_side: "RIGHT",
			},
		],
	});
	expect(db.listStagedReviewComments(bindings.issueKey)).toEqual([]);
});

test("submit_pr_review posts summary only when no staged comments", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const transport = mockTransport(async request => {
		captured.body = await bodyJson(request);
		return reviewOk(45);
	});
	const bindings = reviewBindings(db, tmpPath(), transport);
	const result = await run(bindings, "submit_pr_review", { body: "lgtm — scoped fix" });
	expect(result).toContain("comments=0");
	expect(captured.body.event).toBe("COMMENT");
	expect(captured.body.comments).toEqual([]);
});

test("submit_pr_review failure keeps staged comments", async () => {
	const db = makeDb();
	const transport = mockTransport(request => {
		if (pathOf(request) === "/repos/octo/widget/pulls/99/files") return prFilesResponse();
		return jsonResponse(403, { message: "forbidden" });
	});
	const bindings = reviewBindings(db, tmpPath(), transport);
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "finding" });
	await expectCommandError(run(bindings, "submit_pr_review", { body: "summary" }));
	const rows = db.listStagedReviewComments(bindings.issueKey);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.path).toBe("src/app.py");
});

test("submit_pr_review drops unanchorable comment and folds into summary", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured, { echoBody: true }));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "in-hunk finding" });
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 15, body: "gap finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(captured.body.body).toBe("summary\n\n## Not anchored to diff\n- **`src/app.py:15`** — gap finding");
	expect(captured.body.comments).toEqual([{ path: "src/app.py", line: 12, side: "RIGHT", body: "in-hunk finding" }]);
	expect(result).toContain("submitted PR review");
	expect(result).toContain("dropped=1");
	expect(db.listStagedReviewComments(bindings.issueKey)).toEqual([]);
});

test("submit_pr_review drops all comments and submits summary only", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 15, body: "gap finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(captured.body.comments).toEqual([]);
	expect(captured.body.body.endsWith("## Not anchored to diff\n- **`src/app.py:15`** — gap finding")).toBe(true);
	expect(result).toContain("comments=0");
	expect(result).toContain("dropped=1");
	expect(db.listStagedReviewComments(bindings.issueKey)).toEqual([]);
});

test("submit_pr_review drops comment for path not in diff", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured));
	await run(bindings, "pr_review_comment", { path: "src/other.py", line: 3, body: "stale path finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(captured.body.comments).toEqual([]);
	expect(captured.body.body.endsWith("## Not anchored to diff\n- **`src/other.py:3`** — stale path finding")).toBe(
		true,
	);
	expect(result).toContain("dropped=1");
	expect(db.listStagedReviewComments(bindings.issueKey)).toEqual([]);
});

test("submit_pr_review skips validation when files fetch fails", async () => {
	fastRetries();
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured, { filesStatus: 500 }));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 15, body: "gap finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(captured.body.comments).toEqual([{ path: "src/app.py", line: 15, side: "RIGHT", body: "gap finding" }]);
	expect(captured.body.body).toBe("summary");
	expect(result).toContain("comments=1");
	expect(result).not.toContain("dropped");
});

function fallbackTransport(reviewStatus: number, commentBodies: string[], commentStatus = 200): HttpTransport {
	return mockTransport(async request => {
		const p = pathOf(request);
		if (p === "/repos/octo/widget/pulls/99/files") return prFilesResponse();
		if (p.endsWith("/reviews")) {
			return jsonResponse(reviewStatus, { message: reviewStatus === 422 ? "Validation failed" : "github error" });
		}
		if (p === "/repos/octo/widget/issues/99/comments") {
			if (commentStatus !== 200) return jsonResponse(commentStatus, { message: "internal error" });
			const body = (await bodyJson(request)).body as string;
			commentBodies.push(body);
			return jsonResponse(200, { id: commentBodies.length, body });
		}
		return unrouted();
	});
}

test("submit_pr_review 422 falls back to issue comments", async () => {
	const db = makeDb();
	const commentBodies: string[] = [];
	const bindings = reviewBindings(db, tmpPath(), fallbackTransport(422, commentBodies));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(result).toContain("posted summary + 1 inline comment(s) as issue comments");
	expect(commentBodies).toEqual(["summary", "**`src/app.py:12`**\n\nfinding"]);
	expect(db.listStagedReviewComments(bindings.issueKey)).toEqual([]);
});

test("submit_pr_review 500 falls back to issue comments", async () => {
	// A 500 from Forgejo's reviews endpoint triggers the same fallback as 422;
	// otherwise the model retries and degrades its own review body.
	const db = makeDb();
	const commentBodies: string[] = [];
	const bindings = reviewBindings(db, tmpPath(), fallbackTransport(500, commentBodies));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(result).toContain("posted summary + 1 inline comment(s) as issue comments");
	expect(commentBodies).toEqual(["summary", "**`src/app.py:12`**\n\nfinding"]);
	expect(db.listStagedReviewComments(bindings.issueKey)).toEqual([]);
});

test("submit_pr_review range requires both endpoints anchorable", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured));
	// Reversed range: start_line (15) > line (14) — dropped.
	await run(bindings, "pr_review_comment", {
		path: "src/app.py",
		line: 14,
		start_line: 15,
		start_side: "RIGHT",
		side: "RIGHT",
		body: "reversed range",
	});
	// Valid range: both endpoints (10, 12) are context lines in the hunk — kept.
	await run(bindings, "pr_review_comment", {
		path: "src/app.py",
		line: 12,
		start_line: 10,
		start_side: "RIGHT",
		side: "RIGHT",
		body: "valid range",
	});
	// Cross-side range: start_side LEFT with side RIGHT — dropped.
	await run(bindings, "pr_review_comment", {
		path: "src/app.py",
		line: 11,
		start_line: 10,
		start_side: "LEFT",
		side: "RIGHT",
		body: "cross-side range",
	});
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(captured.body.comments).toEqual([
		{ path: "src/app.py", line: 12, side: "RIGHT", body: "valid range", start_line: 10, start_side: "RIGHT" },
	]);
	expect(captured.body.body).toContain("src/app.py:14");
	expect(captured.body.body).toContain("src/app.py:11");
	expect(result).toContain("dropped=2");
});

function forgejoTransport(captured: Record<string, any>, prStatus: number): HttpTransport {
	return mockTransport(async request => {
		const p = pathOf(request);
		if (p === "/repos/octo/widget/pulls/99") {
			if (prStatus !== 200) return jsonResponse(prStatus, { message: "internal error" });
			return jsonResponse(200, {
				number: 99,
				html_url: "https://x/octo/widget/pull/99",
				head: { ref: "fix-crash", sha: "abc123456789" },
				base: { ref: "main" },
				state: "open",
				user: { login: "alice" },
			});
		}
		if (p === "/repos/octo/widget/pulls/99/files") return prFilesResponse();
		if (p.endsWith("/reviews")) {
			captured.body = await bodyJson(request);
			return reviewOk();
		}
		return unrouted();
	});
}

test("submit_pr_review forgejo fetches commit id", async () => {
	// Forgejo anchors inline comments by commit: submit must include the head
	// sha as commit_id in the reviews POST body.
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), forgejoTransport(captured, 200), "forgejo");
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "in-hunk finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(result).toContain("submitted PR review");
	expect(captured.body.commit_id).toBe("abc123456789");
});

test("submit_pr_review forgejo commit id fetch failure is swallowed", async () => {
	// When the PR fetch fails the commit_id is omitted (fail open).
	TRANSIENT_RETRY_DELAYS.value = [0.01, 0.01];
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), forgejoTransport(captured, 500), "forgejo");
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "in-hunk finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(result).toContain("submitted PR review");
	expect("commit_id" in captured.body).toBe(false);
});

test("submit_pr_review 422 and fallback comment failure raises and keeps staged", async () => {
	fastRetries();
	const db = makeDb();
	const bindings = reviewBindings(db, tmpPath(), fallbackTransport(422, [], 500));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "finding" });
	const msg = await expectCommandError(run(bindings, "submit_pr_review", { body: "summary" }));
	expect(msg).toContain("fallback comment posting failed");
	const rows = db.listStagedReviewComments(bindings.issueKey);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.path).toBe("src/app.py");
});

test("submit_pr_review empty patch fails open", async () => {
	// A file whose patch the platform omitted is not a rejection reason.
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured, { patch: "" }));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 12, body: "binary finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(result).toContain("submitted PR review");
	expect(result).not.toContain("dropped");
	expect(captured.body.comments).toEqual([{ path: "src/app.py", line: 12, side: "RIGHT", body: "binary finding" }]);
	expect(captured.body.body).not.toContain("Not anchored to diff");
});

test("submit_pr_review LEFT side single line anchoring", async () => {
	// LEFT-side comments anchor against the old file's hunk lines (PATCH: LEFT
	// {9..12}): in-hunk kept, out-of-hunk dropped and folded into the summary.
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = reviewBindings(db, tmpPath(), reviewTransport(captured));
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 10, side: "LEFT", body: "old line finding" });
	await run(bindings, "pr_review_comment", { path: "src/app.py", line: 13, side: "LEFT", body: "gap finding" });
	const result = await run(bindings, "submit_pr_review", { body: "summary" });
	expect(result).toContain("dropped=1");
	expect(captured.body.comments).toEqual([{ path: "src/app.py", line: 10, side: "LEFT", body: "old line finding" }]);
	expect(captured.body.body).toContain("## Not anchored to diff");
	expect(captured.body.body).toContain("**`src/app.py:13`** — gap finding");
});

function sorted(set: Set<number>): number[] {
	return [...set].sort((a, b) => a - b);
}

test("diffAnchorableLines parses hunk sides", () => {
	let [right, left] = hostTools.diffAnchorableLines(PATCH);
	expect(sorted(right)).toEqual([10, 11, 12, 13, 14]);
	expect(sorted(left)).toEqual([9, 10, 11, 12]);

	// Gap between hunks: new-file lines 4..30 are unanchorable (the PR 1111
	// smtp.go:106 failure shape).
	[right, left] = hostTools.diffAnchorableLines("@@ -1,2 +1,3 @@\n a\n+x\n b\n@@ -30,2 +31,2 @@\n c\n d\n");
	for (const n of [1, 2, 3, 31, 32]) expect(right.has(n)).toBe(true);
	for (let n = 4; n < 31; n++) expect(right.has(n)).toBe(false);

	expect(hostTools.diffAnchorableLines("").map(sorted)).toEqual([[], []]);
	expect(hostTools.diffAnchorableLines("\0Binary files differ").map(sorted)).toEqual([[], []]);

	[right, left] = hostTools.diffAnchorableLines("@@ -9 +10 @@ x\n+a\n b\n");
	expect(sorted(right)).toEqual([10, 11]);
	expect(sorted(left)).toEqual([9]);

	// `\ No newline at end of file` markers are ignored.
	[right] = hostTools.diffAnchorableLines("@@ -1,2 +1,3 @@\n a\n+b\n\\ No newline at end of file\n");
	expect(sorted(right)).toEqual([1, 2]);

	// File creation: nothing exists on the LEFT; file deletion: RIGHT is empty.
	[right, left] = hostTools.diffAnchorableLines("@@ -0,0 +1,2 @@\n+a\n+b\n");
	expect(sorted(right)).toEqual([1, 2]);
	expect(sorted(left)).toEqual([]);

	[right, left] = hostTools.diffAnchorableLines("@@ -5,3 +5,0 @@\n-a\n-b\n-c\n");
	expect(sorted(right)).toEqual([]);
	expect(sorted(left)).toEqual([5, 6, 7]);
});

test("diffAnchorableLines treats in-hunk ++/-- content as diff lines", () => {
	// Added lines starting with `++` and removed lines starting with `--` are
	// content, not file headers — otherwise the line counters desync.
	const patch = "+++ b/src/app.py\n--- a/src/app.py\n@@ -1,2 +1,3 @@\n ctx\n tail\n--- removed\n+++ added\n";
	const [right, left] = hostTools.diffAnchorableLines(patch);
	expect(sorted(right)).toEqual([1, 2, 3]);
	expect(sorted(left)).toEqual([1, 2, 3]);
});

test("diffAnchorableLines splits patch lines like Python str.splitlines", () => {
	// `\f`, `\v` and U+2028 are line boundaries for Python's `patch.splitlines()`,
	// so each fragment counts as its own diff line. Expected sets were produced by
	// the Python `_diff_anchorable_lines` on the same input.
	let [right, left] = hostTools.diffAnchorableLines("@@ -1,2 +1,3 @@\n ctx\fmore\n+add\n ctx2\n");
	expect(sorted(right)).toEqual([1, 2, 3, 4]);
	expect(sorted(left)).toEqual([1, 2, 3]);
	[right, left] = hostTools.diffAnchorableLines("@@ -5,3 +5,3 @@\n a\v-b\n+c\u2028+d\n e\n");
	expect(sorted(right)).toEqual([5, 6, 7, 8]);
	expect(sorted(left)).toEqual([5, 6, 7]);
});

test("review tools reject outside review mode", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "pr_review_comment", { path: "x.py", line: 1, body: "nit" }));
});
test("review mode rejects push and open PR before repo commands", async () => {
	const db = makeDb();
	const calls: string[][] = [];
	fakeRepoCommands(async (_b, cmd) => {
		calls.push([...cmd]);
		throw new Error("repo command must not run in review mode");
	});
	const bindings = reviewBindings(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "gh_push_branch", {}));
	await expectCommandError(run(bindings, "gh_open_pr", { title: "t", body: "invalid" }));
	expect(calls).toEqual([]);
});

for (const classification of ["enhancement", "proposal"]) {
	test(`impl gate rejects unauthorized ${classification} before repo commands`, async () => {
		const db = makeDb();
		const calls: string[][] = [];
		const bindings = bindingsFor(db, tmpPath(), fail500);
		db.setIssueClassification(bindings.issueKey, classification);
		fakeRepoCommands(async (_b, cmd) => {
			calls.push([...cmd]);
			throw new Error("repo command must not run before implementation authorization");
		});
		const pushMsg = await expectCommandError(run(bindings, "gh_push_branch", {}));
		const prMsg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body: "invalid" }));
		for (const msg of [pushMsg, prMsg]) {
			expect(msg).toContain(`classified \`${classification}\``);
			expect(msg).toContain("OWNER or allowlisted maintainer");
			expect(msg).toContain("gh_post_comment");
		}
		expect(calls).toEqual([]);
		const rows = db.conn
			.query("SELECT tool, error FROM tool_calls WHERE tool IN ('gh_push_branch', 'gh_open_pr') ORDER BY id")
			.all() as { tool: string; error: string }[];
		expect(rows.map(r => r.tool)).toEqual(["gh_push_branch", "gh_open_pr"]);
		for (const row of rows) expect(row.error).toContain(`classified \`${classification}\``);
	});

	test(`impl gate allows authorized ${classification} to reach PR validation`, async () => {
		const db = makeDb();
		const base = bindingsFor(db, tmpPath(), fail500);
		db.setIssueClassification(base.issueKey, classification);
		const bindings = replaceBindings(base, { implAuthorized: true });
		const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body: "" }));
		expect(msg).toContain("requires a non-empty 'body'");
		expect(msg).not.toContain("OWNER or allowlisted maintainer");
	});

	test(`impl gate allows authorized ${classification} push to reach repo commands`, async () => {
		const db = makeDb();
		const calls: string[][] = [];
		const base = bindingsFor(db, tmpPath(), fail500);
		db.setIssueClassification(base.issueKey, classification);
		const bindings = replaceBindings(base, { implAuthorized: true });
		// Python: pytest.raises(RuntimeError) — the repo-command error escapes
		// unwrapped, not as a tool (RpcCommandError) refusal.
		const reached = new Error("authorized non-auto issue reached gh_push_branch repo command");
		fakeRepoCommands(async (_b, cmd) => {
			calls.push([...cmd]);
			throw reached;
		});
		const err = await run(bindings, "gh_push_branch", {}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBe(reached);
		expect(err).not.toBeInstanceOf(HostToolCommandError);
		expect(calls.length).toBeGreaterThan(0);
	});
}

function recordAuthorizingEvent(db: Database, bindings: ToolBindings, deliveryId: string, state?: "skipped"): void {
	db.recordEvent({
		delivery_id: deliveryId,
		event_type: "issue_comment",
		repo: bindings.issue!.repo,
		issue_key: bindings.issueKey,
		payload: {
			_robomp_directive: { body: "go ahead", author: "can1357", pragmas: [], authorizes_impl: true },
		},
		state,
	});
}

test("impl gate allows later authorized event to reach repo commands", async () => {
	const db = makeDb();
	const calls: string[][] = [];
	const bindings = bindingsFor(db, tmpPath(), fail500);
	db.setIssueClassification(bindings.issueKey, "enhancement");
	recordAuthorizingEvent(db, bindings, "auth-event");
	// Python: pytest.raises(RuntimeError) — the repo-command error escapes
	// unwrapped, not as a tool (RpcCommandError) refusal.
	const reached = new Error("later authorized event reached gh_push_branch repo command");
	fakeRepoCommands(async (_b, cmd) => {
		calls.push([...cmd]);
		throw reached;
	});
	const err = await run(bindings, "gh_push_branch", {}).then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBe(reached);
	expect(err).not.toBeInstanceOf(HostToolCommandError);
	expect(calls.length).toBeGreaterThan(0);
});

test("impl gate ignores skipped authorized event", async () => {
	const db = makeDb();
	const calls: string[][] = [];
	const bindings = bindingsFor(db, tmpPath(), fail500);
	db.setIssueClassification(bindings.issueKey, "enhancement");
	recordAuthorizingEvent(db, bindings, "skipped-auth-event", "skipped");
	fakeRepoCommands(async (_b, cmd) => {
		calls.push([...cmd]);
		throw new Error("skipped authorization must not reach repo command");
	});
	const msg = await expectCommandError(run(bindings, "gh_push_branch", {}));
	expect(msg).toContain("OWNER or allowlisted maintainer");
	expect(calls).toEqual([]);
});

test("impl gate allows bug without directive to reach PR validation", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	db.setIssueClassification(bindings.issueKey, "bug");
	const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body: "" }));
	expect(msg).toContain("requires a non-empty 'body'");
	expect(msg).not.toContain("OWNER or allowlisted maintainer");
});

test("impl gate allows existing proposal PR to reach PR validation", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	db.setIssueClassification(bindings.issueKey, "proposal");
	db.setIssuePr(bindings.issueKey, 7);
	const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body: "" }));
	expect(msg).toContain("requires a non-empty 'body'");
	expect(msg).not.toContain("OWNER or allowlisted maintainer");
});

function recordingTransport(calls: string[], status = 500, data?: unknown): HttpTransport {
	return mockTransport(request => {
		calls.push(pathOf(request));
		return data === undefined ? new Response(null, { status }) : jsonResponse(status, data);
	});
}

test("classify_issue on PR thread is no-op", async () => {
	// On PR threads the tool must not hit GitHub and must not raise.
	const db = makeDb();
	const calls: string[] = [];
	const bindings = prBindings(db, tmpPath(), recordingTransport(calls));
	const result = await run(bindings, "classify_issue", { primary: "documentation", rationale: "docs only" });
	expect(result.toLowerCase()).toContain("no-op");
	expect(calls).toEqual([]);
	// Classification must remain whatever it was before — not overwritten.
	expect(db.getIssue(bindings.issueKey)?.classification).toBe("bug");
});

test("classify_issue already classified is no-op", async () => {
	const db = makeDb();
	const calls: string[] = [];
	const bindings = bindingsFor(db, tmpPath(), recordingTransport(calls));
	db.setIssueClassification(bindings.issueKey, "bug");
	const result = await run(bindings, "classify_issue", { primary: "question", rationale: "actually a question" });
	expect(result.toLowerCase()).toContain("no-op");
	expect(result.toLowerCase()).toContain("already classified");
	expect(calls).toEqual([]);
	expect(db.getIssue(bindings.issueKey)?.classification).toBe("bug");
});

test("set_issue_labels on PR thread is no-op", async () => {
	const db = makeDb();
	const calls: string[] = [];
	const bindings = prBindings(db, tmpPath(), recordingTransport(calls));
	const result = await run(bindings, "set_issue_labels", { labels: ["wontfix"] });
	expect(result.toLowerCase()).toContain("no-op");
	expect(calls).toEqual([]);
});

const TEST_GIT_IDENTITY = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

/** Initialize a minimal git repo at `repoDir` with `branch` checked out. */
function initGitRepo(repoDir: string, branch: string): void {
	fs.mkdirSync(repoDir, { recursive: true });
	gitOrThrow(["init", `--initial-branch=${branch}`, repoDir]);
	fs.writeFileSync(path.join(repoDir, "README.md"), "hi\n");
	gitOrThrow(["-C", repoDir, "add", "."]);
	const proc = Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: repoDir,
		env: { ...process.env, ...TEST_GIT_IDENTITY },
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

test("classify_issue renames branch when slug provided", async () => {
	const db = makeDb();
	const transport = mockTransport(() =>
		jsonResponse(200, [{ name: "bug" }, { name: "prio:p1" }, { name: "triaged" }]),
	);
	const bindings = bindingsFor(db, tmpPath(), transport);
	// The stub workspace's initial branch matches `stubWorkspace`.
	initGitRepo(bindings.workspace.repo_dir, bindings.workspace.branch);
	const result = await run(bindings, "classify_issue", {
		primary: "bug",
		priority: "prio:p1",
		rationale: "powershell env colon-var parsing on win is broken",
		branch_slug: "fix-windows-env-colon-vars",
	});
	expect(result.toLowerCase()).toContain("branch renamed to");
	expect(bindings.workspace.branch).toBe("farm/abc12345/fix-windows-env-colon-vars");
	expect(db.getIssue(bindings.issueKey)?.branch).toBe("farm/abc12345/fix-windows-env-colon-vars");
	const head = gitOrThrow(["symbolic-ref", "HEAD"], bindings.workspace.repo_dir).trim();
	expect(head).toBe("refs/heads/farm/abc12345/fix-windows-env-colon-vars");
});

test("classify_issue rejects invalid branch slug before GitHub", async () => {
	const db = makeDb();
	const requests: string[] = [];
	const bindings = bindingsFor(db, tmpPath(), recordingTransport(requests));
	await expectCommandError(
		run(bindings, "classify_issue", { primary: "bug", priority: "prio:p1", rationale: "x", branch_slug: "Has-Caps" }),
	);
	expect(requests).toEqual([]); // no GitHub call attempted
	expect(bindings.workspace.branch).toBe("farm/abc12345/some-issue");
});

test("classify_issue rename failure does not apply labels or classification", async () => {
	const db = makeDb();
	const requests: string[] = [];
	const bindings = bindingsFor(db, tmpPath(), recordingTransport(requests, 200, []));
	track(
		spyOn(hostToolsDeps, "renameWorkspaceBranch").mockImplementation(async () => {
			throw new GitCommandError(["git", "branch", "-m"], 128, "", "fatal: detected dubious ownership");
		}),
	);
	await expectCommandError(
		run(bindings, "classify_issue", {
			primary: "bug",
			priority: "prio:p1",
			rationale: "x",
			branch_slug: "fix-orphan-tool-output",
		}),
	);
	expect(requests).toEqual([]);
	const row = db.getIssue(bindings.issueKey);
	expect(row?.classification).toBeNull();
	expect(row?.branch).toBe("farm/abc12345/some-issue");
	expect(bindings.workspace.branch).toBe("farm/abc12345/some-issue");
});

test("classify_issue omitting branch slug is a no-op", async () => {
	const db = makeDb();
	const transport = mockTransport(() => jsonResponse(200, [{ name: "question" }, { name: "triaged" }]));
	const bindings = bindingsFor(db, tmpPath(), transport);
	const result = await run(bindings, "classify_issue", { primary: "question", rationale: "how-to" });
	expect(result.toLowerCase()).not.toContain("branch renamed");
	expect(bindings.workspace.branch).toBe("farm/abc12345/some-issue");
});

test("set_issue_labels appends", async () => {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const bindings = bindingsFor(db, tmpPath(), echoLabels(captured));
	const result = await run(bindings, "set_issue_labels", { labels: ["wontfix"] });
	expect(result).toContain("wontfix");
	expect(captured.body.labels).toEqual(["wontfix"]);
});

test("set_issue_labels rejects empty", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	await expectCommandError(run(bindings, "set_issue_labels", { labels: [] }));
	await expectCommandError(run(bindings, "set_issue_labels", { labels: ["   ", ""] }));
});
const BOT_IDENTITY = {
	GIT_AUTHOR_NAME: "robomp-bot",
	GIT_AUTHOR_EMAIL: "robomp-bot@example.invalid",
	GIT_COMMITTER_NAME: "robomp-bot",
	GIT_COMMITTER_EMAIL: "robomp-bot@example.invalid",
};
const SEED_IDENTITY = {
	GIT_AUTHOR_NAME: "seed",
	GIT_AUTHOR_EMAIL: "seed@x",
	GIT_COMMITTER_NAME: "seed",
	GIT_COMMITTER_EMAIL: "seed@x",
};
const WRONG_IDENTITY = {
	GIT_AUTHOR_NAME: "wrong",
	GIT_AUTHOR_EMAIL: "wrong@nope",
	GIT_COMMITTER_NAME: "wrong",
	GIT_COMMITTER_EMAIL: "wrong@nope",
};
type GitIdentity = typeof BOT_IDENTITY;

function gitWith(identity: GitIdentity, args: string[]): string {
	const proc = Bun.spawnSync(
		["git", "-c", `user.email=${identity.GIT_AUTHOR_EMAIL}`, "-c", `user.name=${identity.GIT_AUTHOR_NAME}`, ...args],
		{ env: { ...process.env, ...identity }, stdout: "pipe", stderr: "pipe" },
	);
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

/** Real bare upstream seeded with one `init` commit on main. */
function seededUpstream(tmp: string, identity: GitIdentity = BOT_IDENTITY): string {
	const bare = path.join(tmp, "upstream.git");
	fs.mkdirSync(bare);
	gitOrThrow(["init", "--bare", "--initial-branch=main", bare]);
	const seed = path.join(tmp, "seed");
	fs.mkdirSync(seed);
	gitOrThrow(["init", "--initial-branch=main", seed]);
	fs.writeFileSync(path.join(seed, "README.md"), "init\n");
	gitWith(identity, ["-C", seed, "add", "."]);
	gitWith(identity, ["-C", seed, "commit", "-m", "init"]);
	gitWith(identity, ["-C", seed, "remote", "add", "origin", bare]);
	gitWith(identity, ["-C", seed, "push", "origin", "main"]);
	return bare;
}

async function realWorkspace(
	tmp: string,
	title: string,
	seedIdentity: GitIdentity = BOT_IDENTITY,
): Promise<{ bare: string; ws: Workspace }> {
	const bare = seededUpstream(tmp, seedIdentity);
	const mgr = new SandboxManager(path.join(tmp, "workspaces"));
	const ws = await mgr.ensureWorkspace({
		repo: "octo/widget",
		number: 42,
		title,
		cloneUrl: bare,
		defaultBranch: "main",
		authorName: "robomp-bot",
		authorEmail: "robomp-bot@example.invalid",
	});
	return { bare, ws };
}

function writeFiles(ws: Workspace, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(ws.repo_dir, name), content);
}

function commitFiles(ws: Workspace, files: string[], message: string, identity: GitIdentity = BOT_IDENTITY): void {
	gitOrThrow(["-C", ws.repo_dir, "add", ...files]);
	gitWith(identity, ["-C", ws.repo_dir, "commit", "-m", message]);
}

function farmRefs(bare: string): string[] {
	return pySplitlines(gitOrThrow(["-C", bare, "for-each-ref", "--format=%(refname)"])).filter(r =>
		r.startsWith("refs/heads/farm/"),
	);
}

function refNames(bare: string): string[] {
	return pySplitlines(gitOrThrow(["-C", bare, "for-each-ref", "--format=%(refname)"]));
}

/** Install a fake `bun` at the front of PATH for this test. */
function fakeBun(tmp: string, script: string): string {
	const fakebin = path.join(tmp, "fakebin");
	fs.mkdirSync(fakebin, { recursive: true });
	const bun = path.join(fakebin, "bun");
	fs.writeFileSync(bun, script);
	fs.chmodSync(bun, 0o755);
	const saved = process.env.PATH;
	process.env.PATH = `${fakebin}${path.delimiter}${saved ?? ""}`;
	spies.push(() => {
		process.env.PATH = saved;
	});
	return fakebin;
}

function packageJson(scripts: Record<string, string>): string {
	return `${JSON.stringify({ scripts })}\n`;
}

/** Bindings over a real workspace, classified `bug` so the impl gate passes. */
function realBindings(db: Database, ws: Workspace, transport: HttpTransport): ToolBindings {
	const bindings = new ToolBindings({
		db,
		github: new GitHubClient("tok", { transport }),
		gitTransport: new LocalGitTransport(null),
		repo: stubRepo(),
		issue: {
			repo: "octo/widget",
			number: 42,
			title: "t",
			body: "",
			state: "open",
			author: "alice",
			labels: [],
			is_pull_request: false,
		},
		workspace: ws,
		authorName: "robomp-bot",
		authorEmail: "robomp-bot@example.invalid",
	});
	db.upsertIssue({
		key: bindings.issueKey,
		repo: "octo/widget",
		number: 42,
		state: "reproducing",
		branch: ws.branch,
		session_dir: ws.session_dir,
	});
	db.setIssueClassification(bindings.issueKey, "bug");
	return bindings;
}

const PR_BODY = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n\nFixes #42\n";

function prCreated(branch: string): Response {
	return jsonResponse(201, {
		number: 7,
		html_url: "https://github.com/octo/widget/pull/7",
		head: { ref: branch },
		base: { ref: "main" },
		state: "open",
	});
}

function lastToolRow(db: Database, tool: string): { error: string | null; result_json: string | null } | null {
	return db.conn
		.query("SELECT error, result_json FROM tool_calls WHERE tool=? ORDER BY id DESC LIMIT 1")
		.get(tool) as { error: string | null; result_json: string | null } | null;
}

function skippedStages(db: Database, tool: string): string[] {
	return toolCallRows(db, tool)
		.map(r => JSON.parse(r.result_json || "{}").skipped)
		.filter((s): s is string => typeof s === "string");
}

test("gh_push_branch rejects wrong identity", async () => {
	// Pre-push gate refuses commits authored by anyone other than the bot.
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "identity test", SEED_IDENTITY);
	writeFiles(ws, { "x.txt": "hi\n" });
	commitFiles(ws, ["."], "bad", WRONG_IDENTITY);
	const bindings = realBindings(db, ws, fail500);
	const msg = await expectCommandError(run(bindings, "gh_push_branch", {}));
	expect(msg).toContain("identity mismatch");
	expect(msg).toContain("wrong <wrong@nope>");
	expect(msg).toContain("robomp-bot <robomp-bot@example.invalid>");
	// Branch must NOT have been pushed.
	expect(farmRefs(bare)).toEqual([]);
});

test("gh_open_pr rejects wrong identity before push or PR", async () => {
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "identity test", SEED_IDENTITY);
	writeFiles(ws, { "x.txt": "hi\n" });
	commitFiles(ws, ["."], "bad", WRONG_IDENTITY);
	let openedPr = false;
	const transport = mockTransport(() => {
		openedPr = true;
		return prCreated(ws.branch);
	});
	const bindings = realBindings(db, ws, transport);
	const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body: PR_BODY }));
	expect(msg).toContain("identity mismatch");
	expect(openedPr).toBe(false);
	expect(farmRefs(bare)).toEqual([]);
});

test("gh_push_branch rejects invalid identity scan range", async () => {
	// A failing git-log author scan is a push rejection, not an empty scan.
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "missing base ref");
	gitOrThrow(["-C", ws.repo_dir, "update-ref", "-d", "refs/remotes/origin/main"]);
	writeFiles(ws, { "x.txt": "hi\n" });
	commitFiles(ws, ["x.txt"], "ok");
	const bindings = realBindings(db, ws, fail500);
	const msg = await expectCommandError(run(bindings, "gh_push_branch", {}));
	expect(msg).toContain("could not inspect commit authors");
	expect(msg).toContain("origin/main..HEAD");
	expect(farmRefs(bare)).toEqual([]);
	const row = lastToolRow(db, "gh_push_branch");
	expect(row?.error).toContain("could not inspect commit authors");
	expect(row?.error).toContain("origin/main..HEAD");
});

test("gh_open_pr requires closes keyword", async () => {
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	db.setIssueClassification(bindings.issueKey, "bug");
	const body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n";
	const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body }));
	expect(msg).toContain("Fixes #42");
});

test("gh_open_pr refuses failed bun check before push or PR", async () => {
	const db = makeDb();
	const tmp = tmpPath();
	let openedPr = false;
	const transport = mockTransport(() => {
		openedPr = true;
		return prCreated("farm/abc12345/some-issue");
	});
	const bindings = bindingsFor(db, tmp, transport);
	db.setIssueClassification(bindings.issueKey, "bug");
	fakeBun(
		tmp,
		"#!/bin/sh\n" +
			'if [ "$1" != "check" ]; then printf "wrong command: %s\\n" "$1" >&2; exit 2; fi\n' +
			'printf "TypeError: property missing\\n" >&2\n' +
			"exit 1\n",
	);
	fs.writeFileSync(path.join(bindings.workspace.repo_dir, "package.json"), packageJson({ check: "tsc --noEmit" }));
	const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body: PR_BODY }));
	expect(msg).toContain("refusing to open PR");
	expect(msg).toContain("`bun check` failed before open PR");
	expect(msg).toContain("TypeError: property missing");
	expect(openedPr).toBe(false);
	expect(lastToolRow(db, "gh_open_pr")?.error).toContain("TypeError: property missing");
});

test("gh_open_pr refuses failed bun run test before push or PR", async () => {
	// A red suite aborts PR creation: `bun run test` runs after `bun check`.
	const db = makeDb();
	const tmp = tmpPath();
	let openedPr = false;
	const transport = mockTransport(() => {
		openedPr = true;
		return prCreated("farm/abc12345/some-issue");
	});
	const bindings = bindingsFor(db, tmp, transport);
	db.setIssueClassification(bindings.issueKey, "bug");
	fakeBun(
		tmp,
		"#!/bin/sh\n" +
			'if [ "$1" = "check" ]; then exit 0; fi\n' +
			'if [ "$1" = "run" ] && [ "$2" = "test" ]; then\n' +
			'    printf "1 fail\\nexpect(received).toBe(expected)\\n" >&2\n' +
			"    exit 1\n" +
			"fi\n" +
			'printf "unexpected bun call: %s\\n" "$*" >&2\n' +
			"exit 2\n",
	);
	fs.writeFileSync(
		path.join(bindings.workspace.repo_dir, "package.json"),
		packageJson({ check: "tsc --noEmit", test: "bun test" }),
	);
	const msg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body: PR_BODY }));
	expect(msg).toContain("refusing to open PR");
	expect(msg).toContain("`bun run test` failed before open PR");
	expect(msg).toContain("expect(received).toBe(expected)");
	expect(openedPr).toBe(false);
	expect(lastToolRow(db, "gh_open_pr")?.error).toContain("expect(received).toBe(expected)");
});

test("gh_push_branch rejects dirty worktree", async () => {
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "dirty test");
	// Make a proper commit (so the identity gate passes), then dirty the tree.
	writeFiles(ws, { "a.txt": "a\n" });
	commitFiles(ws, ["a.txt"], "ok");
	writeFiles(ws, { "a.txt": "a-modified\n" });
	const bindings = realBindings(db, ws, fail500);
	const msg = await expectCommandError(run(bindings, "gh_push_branch", {}));
	expect(msg).toContain("working tree is dirty");
	expect(farmRefs(bare)).toEqual([]);
});

function fixCheckRecorderScript(fixCalls: string, checkCalls: string, rewrite = true): string {
	return (
		"#!/bin/sh\n" +
		'if [ "$1" = "run" ] && [ "$2" = "fix" ]; then\n' +
		`    printf called >> ${fixCalls}\n` +
		(rewrite ? '    printf "formatted\\n" > src.txt\n' : "") +
		"    exit 0\n" +
		"fi\n" +
		'if [ "$1" = "check" ]; then\n' +
		`    printf called >> ${checkCalls}\n` +
		"    exit 0\n" +
		"fi\n" +
		(rewrite ? 'printf "unexpected bun call: %s\\n" "$*" >&2\n' : "") +
		"exit 2\n"
	);
}

test("gh_push_branch runs fix and check before pushing", async () => {
	// Same gate as gh_open_pr so a follow-up commit can't break CI.
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "push gate");
	const fixCalls = path.join(tmp, "fix-calls");
	const checkCalls = path.join(tmp, "check-calls");
	fakeBun(tmp, fixCheckRecorderScript(fixCalls, checkCalls));
	writeFiles(ws, { "package.json": packageJson({ fix: "...", check: "..." }), "src.txt": "original\n" });
	commitFiles(ws, ["package.json", "src.txt"], "feat: follow-up");
	const bindings = realBindings(db, ws, fail500);
	const result = await run(bindings, "gh_push_branch", {});

	// Both gates ran once.
	expect(fs.readFileSync(fixCalls, "utf-8")).toBe("called");
	expect(fs.readFileSync(checkCalls, "utf-8")).toBe("called");
	// The formatter diff was amended into HEAD — no standalone `style:` commit.
	const lines = pySplitlines(gitOrThrow(["-C", ws.repo_dir, "log", "--format=%an <%ae> %s", "-n", "2"]).trim());
	expect(lines[0]).toBe("robomp-bot <robomp-bot@example.invalid> feat: follow-up");
	expect(lines[1]).toBe("robomp-bot <robomp-bot@example.invalid> init");
	expect(fs.readFileSync(path.join(ws.repo_dir, "src.txt"), "utf-8")).toBe("formatted\n");
	expect(gitOrThrow(["-C", ws.repo_dir, "show", "HEAD:src.txt"])).toBe("formatted\n");
	expect(result.startsWith(`pushed ${ws.branch} `)).toBe(true);
	expect(refNames(bare)).toContain(`refs/heads/${ws.branch}`);
});

test("gh_push_branch force-with-lease recovers after amend", async () => {
	// Plain `git push` rejects a rewritten history as non-fast-forward;
	// `--force-with-lease` accepts it because origin still matches our fetch.
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "amend recover");
	writeFiles(ws, { "feature.txt": "original\n" });
	commitFiles(ws, ["feature.txt"], "feat: original");
	const bindings = realBindings(db, ws, fail500);
	await run(bindings, "gh_push_branch", {});
	const firstRemote = gitOrThrow(["-C", bare, "rev-parse", `refs/heads/${ws.branch}`]).trim();

	writeFiles(ws, { "feature.txt": "amended\n" });
	gitOrThrow(["-C", ws.repo_dir, "add", "feature.txt"]);
	gitWith(BOT_IDENTITY, ["-C", ws.repo_dir, "commit", "--amend", "--no-edit"]);
	const newLocal = gitOrThrow(["-C", ws.repo_dir, "rev-parse", "HEAD"]).trim();
	expect(newLocal).not.toBe(firstRemote);

	const result = await run(bindings, "gh_push_branch", {});
	expect(result.startsWith(`pushed ${ws.branch} `)).toBe(true);
	expect(gitOrThrow(["-C", bare, "rev-parse", `refs/heads/${ws.branch}`]).trim()).toBe(newLocal);
});

test("gh_push_branch aborts on failed bun check", async () => {
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "push aborted");
	fakeBun(
		tmp,
		'#!/bin/sh\nif [ "$1" = "check" ]; then\n    printf "TypeError: property missing\\n" >&2\n    exit 1\nfi\nexit 0\n',
	);
	writeFiles(ws, { "package.json": packageJson({ check: "tsc --noEmit" }), "feature.txt": "feature\n" });
	commitFiles(ws, ["package.json", "feature.txt"], "ok");
	const bindings = realBindings(db, ws, fail500);
	const msg = await expectCommandError(run(bindings, "gh_push_branch", {}));
	expect(msg).toContain("refusing to push");
	expect(msg).toContain("`bun check` failed before push");
	expect(msg).toContain("TypeError: property missing");
	expect(farmRefs(bare)).toEqual([]);
	// Audit row attributes the failure to gh_push_branch, not gh_open_pr.
	expect(lastToolRow(db, "gh_push_branch")?.error).toContain("TypeError: property missing");
});

test("gh_push_branch skip_checks bypasses failing bun check", async () => {
	// Models a broken `main`: re-running the gate forever would never succeed.
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "skip checks");
	const bunLog = path.join(tmp, "fakebin", "bun.log");
	// Both `fix` and `check` would fail — skip_checks must short-circuit them.
	fakeBun(tmp, `#!/bin/sh\necho "$@" >> "${bunLog}"\nexit 1\n`);
	writeFiles(ws, {
		"package.json": packageJson({ fix: "ruff format", check: "tsc --noEmit" }),
		"feature.txt": "feature\n",
	});
	commitFiles(ws, ["package.json", "feature.txt"], "ok");
	const bindings = realBindings(db, ws, fail500);
	const result = await run(bindings, "gh_push_branch", { skip_checks: true });
	expect(result).toContain("pushed");
	expect(result).toContain("pre-push checks skipped");
	expect(fs.existsSync(bunLog)).toBe(false);
	expect(farmRefs(bare).length).toBeGreaterThan(0);
	const skipped = skippedStages(db, "gh_push_branch");
	expect(skipped).toContain("bun_run_fix");
	expect(skipped).toContain("bun_check");
});

test("gh_push_branch skip_checks still refuses dirty worktree", async () => {
	// Uncommitted diff never leaks into a remote ref, even with skip_checks.
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "dirty");
	// scripts.fix present so the dirty-tree gate inside the fix stage runs.
	writeFiles(ws, { "package.json": packageJson({ fix: "ruff format" }) });
	commitFiles(ws, ["package.json"], "wip");
	writeFiles(ws, { "dirty.txt": "uncommitted\n" });
	const bindings = realBindings(db, ws, fail500);
	const msg = await expectCommandError(run(bindings, "gh_push_branch", { skip_checks: true }));
	expect(msg).toContain("dirty worktree");
	expect(farmRefs(bare)).toEqual([]);
});

test("gh_open_pr runs fix then check and amends formatter diff", async () => {
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "fix runs before check");
	const fixCalls = path.join(tmp, "fix-calls");
	const checkCalls = path.join(tmp, "check-calls");
	fakeBun(tmp, fixCheckRecorderScript(fixCalls, checkCalls));
	writeFiles(ws, { "package.json": packageJson({ fix: "...", check: "..." }), "src.txt": "original\n" });
	commitFiles(ws, ["package.json", "src.txt"], "feat: initial change");
	let openedUrl = "";
	const transport = mockTransport(request => {
		openedUrl = request.url;
		return prCreated(ws.branch);
	});
	const bindings = realBindings(db, ws, transport);
	const result = await run(bindings, "gh_open_pr", { title: "fix: x", body: PR_BODY });

	expect(fs.readFileSync(fixCalls, "utf-8")).toBe("called");
	expect(fs.readFileSync(checkCalls, "utf-8")).toBe("called");
	const lines = pySplitlines(gitOrThrow(["-C", ws.repo_dir, "log", "--format=%an|%ae|%s", "-2"]).trim());
	expect(lines[0]).toBe("robomp-bot|robomp-bot@example.invalid|feat: initial change");
	expect(lines[1]!.endsWith("|init")).toBe(true);
	expect(gitOrThrow(["-C", ws.repo_dir, "show", "HEAD:src.txt"])).toBe("formatted\n");
	expect(gitOrThrow(["-C", ws.repo_dir, "status", "--porcelain"])).toBe("");
	expect(result).toContain("opened #7");
	expect(openedUrl.endsWith("/repos/octo/widget/pulls")).toBe(true);
	expect(refNames(bare)).toContain(`refs/heads/${ws.branch}`);
});

test("gh_open_pr skip_checks bypasses failing bun run test", async () => {
	// Every bun stage would fail, yet the PR opens and each skip is audited.
	const db = makeDb();
	const tmp = tmpPath();
	const { ws } = await realWorkspace(tmp, "skip checks bypasses tests");
	const bunLog = path.join(tmp, "fakebin", "bun.log");
	fakeBun(tmp, `#!/bin/sh\necho "$@" >> "${bunLog}"\nexit 1\n`);
	writeFiles(ws, {
		"package.json": packageJson({ fix: "biome", check: "tsc --noEmit", test: "bun test" }),
		"feature.txt": "feature\n",
	});
	commitFiles(ws, ["package.json", "feature.txt"], "fix: something");
	const bindings = realBindings(
		db,
		ws,
		mockTransport(() => prCreated(ws.branch)),
	);
	const body =
		"## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\n`bun run test` red on main\n\nFixes #42\n";
	const result = await run(bindings, "gh_open_pr", { title: "fix: x", body, skip_checks: true });
	expect(result).toContain("opened #7");
	expect(fs.existsSync(bunLog)).toBe(false);
	const skipped = skippedStages(db, "gh_open_pr");
	expect(skipped).toContain("bun_run_fix");
	expect(skipped).toContain("bun_check");
	expect(skipped).toContain("bun_run_test");
});

test("gh_open_pr refuses dirty worktree before fix", async () => {
	// A pre-existing uncommitted edit must be refused BEFORE `bun run fix`,
	// otherwise `git add -A` would amend it into HEAD and ship it in the PR.
	const db = makeDb();
	const tmp = tmpPath();
	const { bare, ws } = await realWorkspace(tmp, "dirty before fix");
	fakeBun(tmp, "#!/bin/sh\nexit 0\n");
	writeFiles(ws, { "package.json": packageJson({ fix: "...", check: "..." }), "src.txt": "clean\n" });
	commitFiles(ws, ["package.json", "src.txt"], "feat: committed work");
	const headBefore = gitOrThrow(["-C", ws.repo_dir, "rev-parse", "HEAD"]).trim();
	writeFiles(ws, { "src.txt": "STOWAWAY uncommitted edit\n" });
	const bindings = realBindings(db, ws, fail500);
	const pushMsg = await expectCommandError(run(bindings, "gh_push_branch", {}));
	expect(pushMsg.toLowerCase()).toContain("dirty worktree");
	const body = "## Repro\nr\n\n## Cause\nc\n\n## Fix\nf\n\n## Verification\nv\n\nFixes #42\n";
	const prMsg = await expectCommandError(run(bindings, "gh_open_pr", { title: "fix: x", body }));
	expect(prMsg.toLowerCase()).toContain("dirty worktree");
	expect(gitOrThrow(["-C", ws.repo_dir, "rev-parse", "HEAD"]).trim()).toBe(headBefore);
	expect(gitOrThrow(["-C", ws.repo_dir, "status", "--porcelain"])).toContain("src.txt");
	expect(farmRefs(bare)).toEqual([]);
});

test("gh_open_pr skips fix when no script", async () => {
	const db = makeDb();
	const tmp = tmpPath();
	const { ws } = await realWorkspace(tmp, "no fix script");
	const fixCalls = path.join(tmp, "fix-calls");
	const checkCalls = path.join(tmp, "check-calls");
	fakeBun(tmp, fixCheckRecorderScript(fixCalls, checkCalls, false));
	writeFiles(ws, { "package.json": packageJson({ check: "..." }) });
	commitFiles(ws, ["package.json"], "feat: x");
	const bindings = realBindings(
		db,
		ws,
		mockTransport(() => prCreated(ws.branch)),
	);
	const result = await run(bindings, "gh_open_pr", { title: "fix: x", body: PR_BODY });
	expect(fs.existsSync(fixCalls)).toBe(false);
	expect(fs.readFileSync(checkCalls, "utf-8")).toBe("called");
	expect(result).toContain("opened #7");
});
// -------- gh_post_comment + question auto-close ---------------------------

function stubSettings(options: { enabled?: boolean; hours?: number } = {}): Settings {
	return makeSettings({
		ROBOMP_QUESTION_AUTOCLOSE_ENABLED: String(options.enabled ?? true),
		ROBOMP_QUESTION_AUTOCLOSE_HOURS: String(options.hours ?? 4),
	});
}

function questionTransport(captured: Record<string, any>): HttpTransport {
	return mockTransport(async request => {
		captured.url = request.url;
		captured.body = await bodyJson(request);
		return comment201(4242, "x");
	});
}

async function postWithSettings(
	classification: string,
	settings: Settings,
	args: Record<string, unknown>,
): Promise<{ db: Database; bindings: ToolBindings; captured: Record<string, any> }> {
	const db = makeDb();
	const captured: Record<string, any> = {};
	const base = bindingsFor(db, tmpPath(), questionTransport(captured));
	db.setIssueClassification(base.issueKey, classification);
	const bindings = replaceBindings(base, { settings });
	await run(bindings, "gh_post_comment", args);
	return { db, bindings, captured };
}

test("gh_post_comment appends suffix and schedules for question", async () => {
	const { db, bindings, captured } = await postWithSettings("question", stubSettings(), {
		body: "Here's the answer",
	});
	const body: string = captured.body.body;
	expect(body.startsWith("Here's the answer")).toBe(true);
	// Suffix appended exactly once.
	expect(body.split("react 👎").length - 1).toBe(1);
	expect(body).toContain("auto-close in 4 hours");
	const row = db.getPendingClosure(bindings.issueKey);
	expect(row?.state).toBe("pending");
	expect(row?.comment_id).toBe(4242);
	// `stubIssue()` opens the issue as `alice`.
	expect(row?.issue_author).toBe("alice");
});

test("gh_post_comment skips suffix for non-question", async () => {
	const { db, bindings, captured } = await postWithSettings("bug", stubSettings(), { body: "Here's the diagnosis" });
	expect(captured.body).toEqual({ body: "Here's the diagnosis" });
	expect(db.getPendingClosure(bindings.issueKey)).toBeNull();
});

test("gh_post_comment skips suffix when target differs from origin", async () => {
	// Posting to a different `number` (e.g. cross-issue reply) must not schedule.
	const { db, bindings, captured } = await postWithSettings("question", stubSettings(), {
		body: "see other issue",
		number: 99,
	});
	expect(captured.body).toEqual({ body: "see other issue" });
	expect(db.getPendingClosure(bindings.issueKey)).toBeNull();
});

test("gh_post_comment skips suffix when feature disabled", async () => {
	const { db, bindings, captured } = await postWithSettings("question", stubSettings({ enabled: false }), {
		body: "Here's the answer",
	});
	expect(captured.body).toEqual({ body: "Here's the answer" });
	expect(db.getPendingClosure(bindings.issueKey)).toBeNull();
});

/** Local release transport that records publication attempts. */
class RecordingReleaseTransport extends LocalGitTransport {
	calls: Record<string, unknown>[] = [];
	constructor() {
		super(null);
	}
	override pushRelease(args: Parameters<GitTransport["pushRelease"]>[0]): Promise<PushResult> {
		this.calls.push({ ...args });
		return super.pushRelease(args);
	}
}

function releaseGit(args: string[], cwd?: string): string {
	return gitOrThrow(cwd === undefined ? args : ["-C", cwd, ...args]).trim();
}

interface ReleaseFixture {
	bindings: ToolBindings;
	transport: RecordingReleaseTransport;
	expectedSha: string;
	bare: string;
}

function releaseBindings(
	db: Database,
	tmp: string,
	settings: Settings,
	options: {
		subject?: string;
		authorName?: string;
		authorEmail?: string;
		dirty?: boolean;
		remoteTagSha?: string | null;
		createFix?: boolean;
	} = {},
): ReleaseFixture {
	const subject = options.subject ?? "chore: bump version to 1.2.3";
	const authorName = options.authorName ?? "robomp-bot";
	const authorEmail = options.authorEmail ?? "robomp-bot@example.invalid";
	const bare = path.join(tmp, "release-origin.git");
	const seed = path.join(tmp, "release-seed");
	releaseGit(["init", "--bare", "--initial-branch=main", bare]);
	releaseGit(["init", "--initial-branch=main", seed]);
	fs.writeFileSync(path.join(seed, "README.md"), "release\n");
	releaseGit(["add", "README.md"], seed);
	releaseGit(
		[
			"-c",
			"user.name=release-owner",
			"-c",
			"user.email=release-owner@example.invalid",
			"commit",
			"-m",
			"chore: bump version to 1.2.3",
		],
		seed,
	);
	const expectedSha = releaseGit(["rev-parse", "HEAD"], seed);
	releaseGit(["remote", "add", "origin", bare], seed);
	releaseGit(["push", "origin", "main", `${expectedSha}:refs/tags/v1.2.3`], seed);

	const root = path.join(tmp, "release-workspace");
	fs.mkdirSync(root);
	const repoDir = path.join(root, "repo");
	releaseGit(["clone", "--branch", "main", bare, repoDir]);
	releaseGit(["config", "user.name", "robomp-bot"], repoDir);
	releaseGit(["config", "user.email", "robomp-bot@example.invalid"], repoDir);
	if (options.createFix ?? true) {
		fs.writeFileSync(path.join(repoDir, "fix.txt"), "fixed\n");
		releaseGit(["add", "fix.txt"], repoDir);
		releaseGit(
			["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", subject],
			repoDir,
		);
	}
	if (options.dirty) fs.writeFileSync(path.join(repoDir, "fix.txt"), "uncommitted\n");

	const sessionDir = path.join(root, ".omp-session-v1.2.3");
	const contextDir = path.join(root, "context");
	const artifactsDir = path.join(root, "artifacts");
	for (const dir of [sessionDir, contextDir, path.join(contextDir, "repro"), artifactsDir]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const workspace = new Workspace(
		root,
		repoDir,
		sessionDir,
		contextDir,
		artifactsDir,
		"main",
		"octo/widget",
		"release",
	);
	const key = "octo/widget#v1.2.3";
	db.upsertRelease({
		repo: "octo/widget",
		tag: "v1.2.3",
		version: "1.2.3",
		current_sha: expectedSha,
		session_dir: sessionDir,
	});
	db.bumpReleaseRound(key, expectedSha);

	const remoteTagSha = options.remoteTagSha ?? null;
	const github = new GitHubClient("token", {
		transport: mockTransport(request => {
			const p = pathOf(request);
			if (p === "/repos/octo/widget/git/ref/tags/v1.2.3") {
				return jsonResponse(200, { object: { type: "commit", sha: remoteTagSha ?? expectedSha } });
			}
			return jsonResponse(500, { message: `unexpected ${p}` });
		}),
	});
	const transport = new RecordingReleaseTransport();
	const release: ReleaseToolContext = {
		repo: "octo/widget",
		tag: "v1.2.3",
		version: "1.2.3",
		key,
		expected_sha: expectedSha,
		default_branch: "main",
	};
	const bindings = new ToolBindings({
		db,
		github,
		gitTransport: transport,
		repo: { full_name: "octo/widget", default_branch: "main", clone_url: bare, private: false },
		issue: null,
		workspace,
		authorName: "robomp-bot",
		authorEmail: "robomp-bot@example.invalid",
		settings,
		abort: new AbortController(),
		release,
	});
	return { bindings, transport, expectedSha, bare };
}

test("release_retag refuses dirty tree", async () => {
	const db = makeDb();
	const { bindings, transport } = releaseBindings(db, tmpPath(), makeSettings(), { dirty: true });
	const msg = await expectCommandError(run(bindings, "release_retag", { summary: "fixed release" }));
	expect(msg).toContain("working tree is dirty");
	expect(transport.calls).toEqual([]);
});

test("release_retag requires release subject prefix", async () => {
	const db = makeDb();
	const { bindings, transport } = releaseBindings(db, tmpPath(), makeSettings(), {
		subject: "fix(ci): repair release",
	});
	const msg = await expectCommandError(run(bindings, "release_retag", { summary: "fixed release" }));
	expect(msg.startsWith("refusing to retag: HEAD subject must start with 'chore: bump version to '")).toBe(true);
	expect(msg).toContain("#2564");
	expect(transport.calls).toEqual([]);
});

test("release_retag refuses wrong author", async () => {
	const db = makeDb();
	const { bindings, transport } = releaseBindings(db, tmpPath(), makeSettings(), {
		authorName: "wrong",
		authorEmail: "wrong@example.invalid",
	});
	const msg = await expectCommandError(run(bindings, "release_retag", { summary: "fixed release" }));
	expect(msg).toContain("commit author identity mismatch");
	expect(transport.calls).toEqual([]);
});

test("release_retag refuses remote tag drift", async () => {
	const db = makeDb();
	const { bindings, transport } = releaseBindings(db, tmpPath(), makeSettings(), {
		remoteTagSha: "human-retagged-sha",
	});
	const msg = await expectCommandError(run(bindings, "release_retag", { summary: "fixed release" }));
	expect(msg).toContain("tag moved remotely");
	expect(transport.calls).toEqual([]);
});

test("release_retag atomically publishes and awaits CI", async () => {
	const db = makeDb();
	const { bindings, transport, expectedSha, bare } = releaseBindings(db, tmpPath(), makeSettings());
	const newHead = releaseGit(["rev-parse", "HEAD"], bindings.workspace.repo_dir);
	expect(newHead).not.toBe(expectedSha);
	const result = await runRaw(bindings, "release_retag", { summary: "fixed the failing check" });
	expect(result).toEqual({ pushed: newHead, tag: "v1.2.3", round: 1 });
	expect(transport.calls).toHaveLength(1);
	expect(transport.calls[0]!.workspaceKey).toBe("octo__widget__release");
	const row = db.getRelease("octo/widget#v1.2.3");
	expect(row?.state).toBe("awaiting_ci");
	expect(row?.current_sha).toBe(newHead);
	expect(releaseGit(["--git-dir", bare, "rev-parse", "refs/heads/main"])).toBe(newHead);
	expect(releaseGit(["--git-dir", bare, "rev-parse", "refs/tags/v1.2.3"])).toBe(newHead);
});

test("abort_task marks release failed", async () => {
	const db = makeDb();
	const { bindings } = releaseBindings(db, tmpPath(), makeSettings(), { createFix: false });
	expect(await run(bindings, "abort_task", { reason: "runner credentials require human repair" })).toBe("aborted");
	const row = db.getRelease("octo/widget#v1.2.3");
	expect(row?.state).toBe("failed");
	expect(row?.last_error).toBe("runner credentials require human repair");
	expect(bindings.abort?.triggered).toBe(true);
});

test("release status and job log are scoped to expected sha", async () => {
	const db = makeDb();
	const expectedSha = "a".repeat(40);
	const seen: [string, string][] = [];
	const logLines = Array.from({ length: 1005 }, (_, i) => `line-${i}`);
	const transport = mockTransport(request => {
		const url = new URL(request.url);
		seen.push([url.pathname, url.search.replace(/^\?/, "")]);
		if (url.pathname === "/repos/octo/widget/actions/runs") {
			return jsonResponse(200, {
				workflow_runs: [
					{
						id: 10,
						name: "CI",
						event: "push",
						status: "completed",
						conclusion: "failure",
						head_branch: "main",
						head_sha: expectedSha,
						html_url: "https://example.invalid/runs/10",
						run_attempt: 1,
					},
				],
			});
		}
		if (url.pathname === "/repos/octo/widget/actions/runs/10/jobs") {
			return jsonResponse(200, {
				jobs: [
					{
						id: 20,
						run_id: 10,
						name: "check",
						status: "completed",
						conclusion: "failure",
						html_url: "https://example.invalid/jobs/20",
						steps: [
							{ name: "install", conclusion: "success" },
							{ name: "bun check", conclusion: "failure" },
						],
					},
				],
			});
		}
		if (url.pathname === "/repos/octo/widget/actions/jobs/20/logs") return new Response(logLines.join("\n"));
		return jsonResponse(500, { message: `unexpected ${url.pathname}` });
	});
	const workspace = stubWorkspace(tmpPath());
	workspace.branch = "main";
	workspace.issue_number = "release";
	const key = "octo/widget#v1.2.3";
	db.upsertRelease({
		repo: "octo/widget",
		tag: "v1.2.3",
		version: "1.2.3",
		current_sha: expectedSha,
		session_dir: workspace.session_dir,
	});
	const bindings = new ToolBindings({
		db,
		github: new GitHubClient("token", { transport }),
		gitTransport: new LocalGitTransport(null),
		repo: stubRepo(),
		issue: null,
		workspace,
		authorName: "robomp-bot",
		authorEmail: "robomp-bot@example.invalid",
		settings: makeSettings(),
		release: {
			repo: "octo/widget",
			tag: "v1.2.3",
			version: "1.2.3",
			key,
			expected_sha: expectedSha,
			default_branch: "main",
		},
	});
	const status = JSON.parse(await run(bindings, "release_ci_status", {}));
	const logTail = await run(bindings, "release_job_log", { job_id: 20, tail_lines: 5000 });
	expect(status.sha).toBe(expectedSha);
	expect(status.runs[0].failed_jobs[0].failed_steps).toEqual(["bun check"]);
	expect(seen[0]).toEqual(["/repos/octo/widget/actions/runs", `head_sha=${expectedSha}&per_page=100`]);
	expect(pySplitlines(logTail)).toEqual(logLines.slice(-1000));
});

/** Release-session bindings: no issue context, audit rows keyed by the release. */
function releaseContextBindings(db: Database, transport: HttpTransport): ToolBindings {
	const workspace = stubWorkspace(tmpPath());
	workspace.branch = "main";
	workspace.issue_number = "release";
	db.upsertRelease({
		repo: "octo/widget",
		tag: "v1.2.3",
		version: "1.2.3",
		current_sha: "a".repeat(40),
		session_dir: workspace.session_dir,
	});
	return new ToolBindings({
		db,
		github: new GitHubClient("token", { transport }),
		gitTransport: new LocalGitTransport(null),
		repo: stubRepo(),
		issue: null,
		workspace,
		authorName: "robomp-bot",
		authorEmail: "robomp-bot@example.invalid",
		settings: makeSettings(),
		release: {
			repo: "octo/widget",
			tag: "v1.2.3",
			version: "1.2.3",
			key: "octo/widget#v1.2.3",
			expected_sha: "a".repeat(40),
			default_branch: "main",
		},
	});
}

function searchItem(number: number, isPr: boolean): Record<string, unknown> {
	return {
		number,
		title: `item ${number}`,
		state: "closed",
		state_reason: "completed",
		user: { login: "bot" },
		labels: [],
		comments: 0,
		updated_at: "2026-06-02T00:00:00Z",
		created_at: "2026-06-02T00:00:00Z",
		html_url: `https://example/${number}`,
		...(isPr ? { pull_request: { url: `https://example/pull/${number}` } } : {}),
	};
}

test("gh_search_issues without issue context only needs it to self-filter an issue row", async () => {
	// Python resolves `_require_issue` inside the per-row self-filter, and PR rows
	// short-circuit it: a release session can search as long as no issue row needs
	// filtering, and an issue row surfaces the missing-context refusal.
	const db = makeDb();
	let items: Record<string, unknown>[] = [searchItem(31, true)];
	const transport = mockTransport(() => jsonResponse(200, { total_count: items.length, items }));
	const bindings = releaseContextBindings(db, transport);
	const result = await run(bindings, "gh_search_issues", { query: "resize crash" });
	expect(result).toContain("#31 (PR, closed (completed))");
	items = [];
	expect(await run(bindings, "gh_search_issues", { query: "resize crash" })).toBe(
		"No issues or PRs in octo/widget match 'resize crash'.",
	);
	items = [searchItem(30, false)];
	const msg = await expectCommandError(run(bindings, "gh_search_issues", { query: "resize crash" }));
	expect(msg).toBe("this tool requires issue context");
});

test("search_commits fails the tool when the origin probe times out", async () => {
	// Python's rev-parse probe has no TimeoutExpired handler: the timeout escapes
	// the tool (unwrapped, unaudited) instead of silently falling back to HEAD.
	const db = makeDb();
	const bindings = bindingsFor(db, tmpPath(), fail500);
	const calls: string[][] = [];
	fakeRepoCommands(async (_b, cmd, options) => {
		calls.push([...cmd]);
		expect(options?.timeout).toBe(30);
		return { ...completed(cmd, 124, "", ""), timedOut: true };
	});
	const err = await run(bindings, "search_commits", { query: "colon selector" }).then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(hostTools.TimeoutExpiredError);
	expect(err).not.toBeInstanceOf(HostToolCommandError);
	expect((err as Error).message).toBe(
		"Command '['git', 'rev-parse', '--verify', '--quiet', 'origin/main']' timed out after 30.0 seconds",
	);
	expect(calls).toEqual([["git", "rev-parse", "--verify", "--quiet", "origin/main"]]);
	expect(toolCallRows(db, "search_commits")).toEqual([]);
});

test("integer args accept booleans where Python's isinstance(x, int) does", async () => {
	// `bool` subclasses `int` in Python: `number=True` targets #1, `exit_code=True`
	// renders as `True`, and a `True` review line stages as line 1. Only
	// release_job_log excludes bools explicitly.
	const db = makeDb();
	let url = "";
	const transport = mockTransport(request => {
		url = request.url;
		return comment201(7);
	});
	const bindings = bindingsFor(db, tmpPath(), transport);
	await run(bindings, "gh_post_comment", { body: "hi", number: true });
	expect(url.endsWith("/repos/octo/widget/issues/1/comments")).toBe(true);

	expect(await run(bindings, "repro_record", { ...REPRO_ARGS, exit_code: true })).toBe("recorded");
	const files = fs.readdirSync(bindings.workspace.repro_dir);
	expect(files).toHaveLength(1);
	expect(fs.readFileSync(path.join(bindings.workspace.repro_dir, files[0]!), "utf-8")).toContain(
		"- exit_code: True\n",
	);
	const reproRows = toolCallRows(db, "repro_record");
	expect(JSON.parse(reproRows[reproRows.length - 1]!.args_json).exit_code).toBe(true);

	const review = reviewBindings(makeDb(), tmpPath(), fail500);
	expect(await run(review, "pr_review_comment", { path: "src/app.py", line: true, body: "nit" })).toContain(
		"staged_count=1",
	);
	expect(review.db.listStagedReviewComments(review.issueKey).map(c => c.line)).toEqual([1]);
	// `False <= 0`, so a False start_line is refused like 0.
	const msg = await expectCommandError(
		run(review, "pr_review_comment", { path: "src/app.py", line: 2, start_line: false, body: "nit" }),
	);
	expect(msg).toBe("pr_review_comment 'start_line' must be a positive integer when provided.");
});

test("release_job_log rejects booleans as job ids", async () => {
	const db = makeDb();
	const bindings = releaseContextBindings(db, fail500);
	const msg = await expectCommandError(run(bindings, "release_job_log", { job_id: true }));
	expect(msg).toBe("release_job_log requires an integer 'job_id'.");
	const tailMsg = await expectCommandError(run(bindings, "release_job_log", { job_id: 20, tail_lines: null }));
	expect(tailMsg).toBe("release_job_log 'tail_lines' must be an integer.");
});
