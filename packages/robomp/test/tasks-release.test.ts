/** Release CI state machine (port of test_tasks_release.py). */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../src/config";
import type { Database } from "../src/db";
import { GitHubClient } from "../src/github-client";
import { jsonResponse, mockTransport } from "../src/http";
import { SandboxManager } from "../src/sandbox";
import * as tasks from "../src/tasks";
import type { RunTaskArgs } from "../src/worker";
import { makeDb, makeSettings, tmpPath } from "./helpers";

const REPO = "octo/widget";
const TAG = "v17.2.8";
const VERSION = "17.2.8";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "release-test",
			GIT_AUTHOR_EMAIL: "release-test@example.invalid",
			GIT_COMMITTER_NAME: "release-test",
			GIT_COMMITTER_EMAIL: "release-test@example.invalid",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function releaseRepo(tmp: string): [string, string] {
	const origin = path.join(tmp, "origin.git");
	const seed = path.join(tmp, "seed");
	git(tmp, "init", "--bare", "--initial-branch=main", origin);
	git(tmp, "init", "--initial-branch=main", seed);
	fs.writeFileSync(path.join(seed, "README.md"), "release\n");
	git(seed, "add", "README.md");
	git(seed, "commit", "-m", `chore: bump version to ${VERSION}`);
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "--set-upstream", "origin", "main");
	return [origin, git(seed, "rev-parse", "HEAD")];
}

function run(
	id: number,
	options: { conclusion: string | null; status?: string; name?: string; headSha: string },
): Record<string, unknown> {
	return {
		id,
		name: options.name ?? "CI",
		event: "push",
		status: options.status ?? "completed",
		conclusion: options.conclusion,
		head_branch: "main",
		head_sha: options.headSha,
		html_url: `https://example/runs/${id}`,
		run_attempt: 1,
	};
}

function payload(headSha: string, cloneUrl: string, conclusion: string): Record<string, unknown> {
	return {
		action: "completed",
		repository: { full_name: REPO, default_branch: "main", clone_url: cloneUrl, private: false },
		workflow_run: {
			id: 1,
			name: "CI",
			head_branch: "main",
			head_sha: headSha,
			html_url: "https://example/runs/1",
			conclusion,
			head_commit: { message: `chore: bump version to ${VERSION}` },
		},
	};
}

function github(options: {
	headSha: string;
	runs?: Record<string, unknown>[];
	tagSha?: string;
	releaseExists?: boolean;
}): GitHubClient {
	const tagSha = options.tagSha ?? options.headSha;
	return new GitHubClient("token", {
		transport: mockTransport(request => {
			const p = new URL(request.url).pathname;
			if (p.endsWith(`/git/ref/tags/${TAG}`)) return jsonResponse(200, { object: { type: "commit", sha: tagSha } });
			if (p.endsWith("/actions/runs")) return jsonResponse(200, { workflow_runs: options.runs ?? [] });
			if (p.endsWith("/jobs")) return jsonResponse(200, { jobs: [] });
			if (p.endsWith("/logs")) return new Response("failure");
			if (p.endsWith(`/releases/tags/${TAG}`)) {
				if (options.releaseExists === false) return jsonResponse(404, { message: "Not Found" });
				return jsonResponse(200, {
					tag_name: TAG,
					name: VERSION,
					draft: false,
					prerelease: false,
					html_url: "https://example/release",
					assets: [],
				});
			}
			throw new Error(`unexpected GitHub request: ${request.url}`);
		}),
	});
}

interface Env {
	settings: Settings;
	db: Database;
	sandbox: SandboxManager;
	origin: string;
	head: string;
}

function env(): Env {
	const tmp = tmpPath();
	const settings = makeSettings({}, tmp);
	const [origin, head] = releaseRepo(tmp);
	return { settings, db: makeDb(tmp), sandbox: new SandboxManager(settings.workspace_root), origin, head };
}

function handle(e: Env, gh: GitHubClient, body: Record<string, unknown>): Promise<void> {
	return tasks.handleReleaseCi({
		settings: e.settings,
		db: e.db,
		github: gh,
		sandbox: e.sandbox,
		gitTransport: e.sandbox.transport,
		payload: body,
		deliveryId: "delivery-1",
	});
}

function fakeRunTask(fn: (args: RunTaskArgs) => void): void {
	const spy = spyOn(tasks.tasksDeps, "runTask").mockImplementation(async args => {
		fn(args);
		return null;
	});
	restores.push(() => spy.mockRestore());
}

test("stale release event does not create a round", async () => {
	const e = env();
	await handle(e, github({ headSha: e.head, tagSha: "new-tag-sha" }), payload(e.head, e.origin, "failure"));
	expect(e.db.getRelease(`${REPO}#${TAG}`)).toBeNull();
});

test("success marks release green when all runs and release exist", async () => {
	const e = env();
	const runs = [run(1, { conclusion: "success", headSha: e.head })];
	await handle(e, github({ headSha: e.head, runs }), payload(e.head, e.origin, "success"));
	expect(e.db.getRelease(`${REPO}#${TAG}`)?.state).toBe("green");
});

test("success waits for an in-progress run", async () => {
	const e = env();
	const runs = [
		run(1, { conclusion: "success", headSha: e.head }),
		run(2, { conclusion: null, status: "in_progress", name: "Nix", headSha: e.head }),
	];
	await handle(e, github({ headSha: e.head, runs }), payload(e.head, e.origin, "success"));
	expect(e.db.getRelease(`${REPO}#${TAG}`)?.state).toBe("awaiting_ci");
});

test("green CI without release marks failed", async () => {
	const e = env();
	const runs = [run(1, { conclusion: "success", headSha: e.head })];
	await handle(e, github({ headSha: e.head, runs, releaseExists: false }), payload(e.head, e.origin, "success"));
	const row = e.db.getRelease(`${REPO}#${TAG}`);
	expect(row?.state).toBe("failed");
	expect(row?.last_error).toBe("CI green but GitHub Release missing/draft");
});

test("cancelled Nix run does not block green", async () => {
	const e = env();
	const runs = [
		run(1, { conclusion: "success", headSha: e.head }),
		run(2, { conclusion: "cancelled", name: "Nix", headSha: e.head }),
	];
	await handle(e, github({ headSha: e.head, runs }), payload(e.head, e.origin, "success"));
	expect(e.db.getRelease(`${REPO}#${TAG}`)?.state).toBe("green");
});

test("failure bumps round and runs agent", async () => {
	const e = env();
	const calls: number[] = [];
	fakeRunTask(args => {
		expect(args.taskKind).toBe("handle_release_ci");
		calls.push(args.inputs.release!.round);
		args.inputs.db.setReleaseState(`${REPO}#${TAG}`, "awaiting_ci");
	});
	const runs = [run(1, { conclusion: "failure", headSha: e.head })];
	await handle(e, github({ headSha: e.head, runs }), payload(e.head, e.origin, "failure"));
	const row = e.db.getRelease(`${REPO}#${TAG}`);
	expect(calls).toEqual([1]);
	expect(row?.rounds).toBe(1);
	expect(row?.state).toBe("awaiting_ci");
});

test("failure at round cap marks failed without agent", async () => {
	const e = env();
	const key = `${REPO}#${TAG}`;
	e.db.upsertRelease({ repo: REPO, tag: TAG, version: VERSION, current_sha: e.head, session_dir: "/session" });
	for (let i = 0; i < e.settings.release_max_rounds; i++) e.db.bumpReleaseRound(key, `older-${i}`);
	let called = false;
	fakeRunTask(() => {
		called = true;
	});
	await handle(e, github({ headSha: e.head }), payload(e.head, e.origin, "failure"));
	const row = e.db.getRelease(key);
	expect(called).toBe(false);
	expect(row?.state).toBe("failed");
	expect(row?.last_error?.startsWith(`round cap ${e.settings.release_max_rounds} reached`)).toBe(true);
});

test("fixing same sha resumes without round bump", async () => {
	const e = env();
	const key = `${REPO}#${TAG}`;
	e.db.upsertRelease({ repo: REPO, tag: TAG, version: VERSION, current_sha: e.head, session_dir: "/session" });
	e.db.bumpReleaseRound(key, e.head);
	const calls: number[] = [];
	fakeRunTask(args => {
		calls.push(args.inputs.release!.round);
		args.inputs.db.setReleaseState(key, "awaiting_ci");
	});
	const runs = [run(1, { conclusion: "failure", headSha: e.head })];
	await handle(e, github({ headSha: e.head, runs }), payload(e.head, e.origin, "failure"));
	expect(calls).toEqual([1]);
	expect(e.db.getRelease(key)?.rounds).toBe(1);
});
