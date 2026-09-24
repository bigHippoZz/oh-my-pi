/** Port of test_tasks.py. */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import type { GitHubBackend } from "../src/github-backend";
import type { IssueInfo, RepoInfo } from "../src/github-client";
import * as logging from "../src/logging";
import type { GitTransport, SandboxManager, Workspace } from "../src/sandbox";
import * as tasks from "../src/tasks";
import { makeDb, makeSettings, tmpPath } from "./helpers";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function stubRepoAndIssue(): [RepoInfo, IssueInfo] {
	return [
		{ full_name: "octo/widget", default_branch: "main", clone_url: "https://x/octo/widget.git", private: false },
		{
			repo: "octo/widget",
			number: 1,
			title: "bug",
			body: "b",
			state: "open",
			author: "alice",
			labels: [],
			is_pull_request: false,
		},
	];
}

function stubTasks(): void {
	const resolve = spyOn(tasks.tasksDeps, "resolveRepoAndIssue").mockImplementation(async () => stubRepoAndIssue());
	const run = spyOn(tasks.tasksDeps, "runTask").mockImplementation(async () => null);
	restores.push(
		() => resolve.mockRestore(),
		() => run.mockRestore(),
	);
}

function fakeWorkspace(tmp: string): Workspace {
	return { branch: "farm/x/y", session_dir: path.join(tmp, "sess") } as Workspace;
}

test("triage_issue keeps the event loop live while workspace setup is pending", async () => {
	stubTasks();
	const tmp = tmpPath();
	const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
	const { promise: released, resolve: release } = Promise.withResolvers<void>();
	let releaseSeenInTime = false;
	const sandbox = {
		nativesCache: null,
		ensureWorkspace: async () => {
			enter();
			// True ONLY if a concurrent task released us while setup was pending.
			releaseSeenInTime = await Promise.race([released.then(() => true), Bun.sleep(1000).then(() => false)]);
			return fakeWorkspace(tmp);
		},
	} as unknown as SandboxManager;
	const github = { listClosingPullRequests: async () => [] } as unknown as GitHubBackend;
	const triage = tasks.triageIssue({
		settings: makeSettings(),
		db: makeDb(),
		github,
		sandbox,
		gitTransport: {} as GitTransport,
		payload: {},
		deliveryId: "d1",
	});
	const releaser = (async () => {
		await entered;
		release();
	})();
	await triage;
	await releaser;
	expect(releaseSeenInTime).toBe(true);
});

test("runWorkspaceOp drains the op before propagating an abort", async () => {
	const { promise: started, resolve: start } = Promise.withResolvers<void>();
	const { promise: proceed, resolve: goOn } = Promise.withResolvers<void>();
	let finished = false;
	const controller = new AbortController();
	const task = tasks.runWorkspaceOp(async () => {
		start();
		await proceed;
		finished = true;
		return "done";
	}, controller.signal);
	let settled = false;
	void task.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await started;
	try {
		// Abort mid-flight, twice: the op must not be abandoned.
		controller.abort();
		for (let i = 0; i < 20; i++) await Bun.sleep(0);
		expect(settled).toBe(false);
		controller.abort();
		for (let i = 0; i < 20; i++) await Bun.sleep(0);
		expect(finished).toBe(false);
		expect(settled).toBe(false);
	} finally {
		goOn();
	}
	await expect(task).rejects.toBeInstanceOf(tasks.TaskCancelledError);
	expect(finished).toBe(true);
});

test("runWorkspaceOp logs the op's exception on concurrent abort", async () => {
	const warnings: { msg: string; exc: string | undefined }[] = [];
	const remove = logging.addLogHandler(record => {
		if (record.level === "WARNING") warnings.push({ msg: record.msg, exc: record.exc });
	});
	restores.push(remove);
	const { promise: started, resolve: start } = Promise.withResolvers<void>();
	const { promise: proceed, resolve: goOn } = Promise.withResolvers<void>();
	const controller = new AbortController();
	const task = tasks.runWorkspaceOp(async () => {
		start();
		await proceed;
		throw new Error("git exploded");
	}, controller.signal);
	await started;
	controller.abort();
	await Bun.sleep(50);
	goOn();
	await expect(task).rejects.toBeInstanceOf(tasks.TaskCancelledError);
	expect(warnings.some(w => w.exc?.includes("git exploded"))).toBe(true);
});

test("triage_issue reopen tears down the finalized workspace", async () => {
	// Re-triage of a finalized (reopened) issue must clear the stale workspace
	// first: the prior branch was merged/deleted, so a reopen branches afresh.
	stubTasks();
	const tmp = tmpPath();
	const db = makeDb();
	db.upsertIssue({ key: "octo/widget#1", repo: "octo/widget", number: 1, state: "closed" });
	const calls: string[] = [];
	const sandbox = {
		nativesCache: null,
		ensureWorkspace: async () => {
			calls.push("ensure");
			return fakeWorkspace(tmp);
		},
		removeWorkspace: async () => {
			calls.push("remove");
		},
	} as unknown as SandboxManager;
	const github = {
		listClosingPullRequests: async () => {
			throw new Error("closing-PR guard must not run when a DB row already exists");
		},
	} as unknown as GitHubBackend;
	await tasks.triageIssue({
		settings: makeSettings(),
		db,
		github,
		sandbox,
		gitTransport: {} as GitTransport,
		payload: {},
		deliveryId: "d1",
	});
	expect(calls).toEqual(["remove", "ensure"]);
	expect(db.getIssue("octo/widget#1")?.state).toBe("reproducing");
});
