/** Pragmas survive the payload round-trip server → durable queue → tasks (port of test_tasks_directive.py). */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitHubBackend } from "../src/github-backend";
import type { IssueInfo, RepoInfo } from "../src/github-client";
import type { GitTransport, SandboxManager, Workspace } from "../src/sandbox";
import { directiveInfo } from "../src/task-types";
import * as tasks from "../src/tasks";
import type { RunTaskArgs } from "../src/worker";
import { makeDb, makeSettings, tmpPath } from "./helpers";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

test("directiveFromPayload parses pragmas", () => {
	const directive = tasks.directiveFromPayload({
		_robomp_directive: {
			body: "do the thing",
			author: "can1357",
			pragmas: [
				["model", "gpt"],
				["thinking", "low"],
			],
		},
	});
	expect(directive?.body).toBe("do the thing");
	expect(directive?.author).toBe("can1357");
	expect(directive?.pragmas).toEqual([
		["model", "gpt"],
		["thinking", "low"],
	]);
	expect(directive?.authorizes_impl).toBe(false);
});

test("directiveFromPayload missing pragmas is empty", () => {
	const directive = tasks.directiveFromPayload({ _robomp_directive: { body: "x", author: "can1357" } });
	expect(directive?.pragmas).toEqual([]);
	expect(directive?.authorizes_impl).toBe(false);
});

test("directiveFromPayload drops malformed pragma entries", () => {
	const directive = tasks.directiveFromPayload({
		_robomp_directive: {
			body: "x",
			author: "can1357",
			pragmas: [["model", "gpt"], ["bad"], [1, "v"], "string-instead-of-pair"],
		},
	});
	expect(directive?.pragmas).toEqual([["model", "gpt"]]);
});

test("directiveFromPayload parses implementation authorization", () => {
	const directive = tasks.directiveFromPayload({
		_robomp_directive: { body: "do the thing", author: "can1357", authorizes_impl: true },
	});
	expect(directive?.authorizes_impl).toBe(true);
});

test("directiveFromPayload returns null for missing directive", () => {
	expect(tasks.directiveFromPayload({})).toBeNull();
	expect(tasks.directiveFromPayload({ _robomp_directive: "not-a-mapping" })).toBeNull();
});

test("attachThread preserves authorizes_impl", async () => {
	const spy = spyOn(tasks.tasksDeps, "fetchThread").mockImplementation(async () => []);
	restores.push(() => spy.mockRestore());
	const directive = directiveInfo({ body: "test body", author: "test_author", authorizes_impl: true });
	const hydrated = await tasks.tasksDeps.attachThread({} as GitHubBackend, directive, "owner/repo", 42, {
		isPr: false,
	});
	expect(hydrated?.body).toBe("test body");
	expect(hydrated?.author).toBe("test_author");
	expect(hydrated?.authorizes_impl).toBe(true);
});

function payloadWithDirective(issueNumber: number, body = "@robomp-bot ship it"): Record<string, unknown> {
	return {
		repository: {
			full_name: "octo/widget",
			default_branch: "main",
			clone_url: "https://x/octo/widget.git",
			private: false,
		},
		issue: {
			number: issueNumber,
			title: "proposal",
			body: "issue body",
			state: "open",
			user: { login: "alice" },
			labels: [{ name: "proposal" }],
		},
		comment: { id: 99, body, created_at: "2026-01-01T00:00:00Z", user: { login: "owner" } },
		_robomp_directive: { body, author: "owner", authorizes_impl: true },
	};
}

function workspaceStub(tmp: string): Workspace {
	const repoDir = path.join(tmp, "repo");
	const sessionDir = path.join(tmp, "session");
	fs.mkdirSync(repoDir, { recursive: true });
	fs.mkdirSync(sessionDir, { recursive: true });
	return { root: tmp, repo_dir: repoDir, session_dir: sessionDir, branch: "robomp/issue-42" } as Workspace;
}

function captureRun(captured: Record<string, unknown>): void {
	const spy = spyOn(tasks.tasksDeps, "runTask").mockImplementation(async (args: RunTaskArgs) => {
		captured.task_kind = args.taskKind;
		if (args.prNumber !== undefined) captured.pr_number = args.prNumber;
		captured.run_task_authorizes_impl = args.directive ? args.directive.authorizes_impl : null;
		return null;
	});
	restores.push(() => spy.mockRestore());
}

test("handle_comment preserves authorizes_impl to runTask", async () => {
	const tmp = tmpPath();
	const workspace = workspaceStub(tmp);
	const captured: Record<string, unknown> = {};
	const attach = spyOn(tasks.tasksDeps, "attachThread").mockImplementation(async (_g, directive, _r, _n, options) => {
		expect(directive).not.toBeNull();
		expect(options.isPr).toBe(false);
		captured.attached_authorizes_impl = directive!.authorizes_impl;
		return directive;
	});
	restores.push(() => attach.mockRestore());
	captureRun(captured);
	await tasks.handleComment({
		settings: makeSettings(),
		db: makeDb(),
		github: {} as GitHubBackend,
		sandbox: { nativesCache: null, ensureWorkspace: async () => workspace } as unknown as SandboxManager,
		gitTransport: {} as GitTransport,
		payload: payloadWithDirective(42),
		deliveryId: "d-comment",
	});
	expect(captured).toEqual({
		attached_authorizes_impl: true,
		task_kind: "triage_issue",
		run_task_authorizes_impl: true,
	});
});

test("handle_pr_conversation preserves authorizes_impl to runTask", async () => {
	const tmp = tmpPath();
	const workspace = workspaceStub(tmp);
	const db = makeDb();
	db.upsertIssue({
		key: "octo/widget#42",
		repo: "octo/widget",
		number: 42,
		state: "opened",
		branch: workspace.branch,
		session_dir: workspace.session_dir,
		pr_number: 7,
	});
	const captured: Record<string, unknown> = {};
	const github = {
		getRepo: async (repo: string): Promise<RepoInfo> => {
			expect(repo).toBe("octo/widget");
			return { full_name: repo, default_branch: "main", clone_url: "https://x/octo/widget.git", private: false };
		},
		getIssue: async (repo: string, number: number): Promise<IssueInfo> => {
			expect(repo).toBe("octo/widget");
			expect(number).toBe(42);
			return {
				repo,
				number,
				title: "proposal",
				body: "issue body",
				state: "open",
				author: "alice",
				labels: ["proposal"],
				is_pull_request: false,
			};
		},
	} as unknown as GitHubBackend;
	const attach = spyOn(tasks.tasksDeps, "attachThread").mockImplementation(
		async (_g, directive, repo, number, options) => {
			expect(repo).toBe("octo/widget");
			expect(number).toBe(7);
			expect(options.isPr).toBe(true);
			captured.attached_authorizes_impl = directive!.authorizes_impl;
			return directive;
		},
	);
	restores.push(() => attach.mockRestore());
	captureRun(captured);
	const payload = payloadWithDirective(7);
	(payload.issue as Record<string, unknown>).pull_request = {
		url: "https://api.github.com/repos/octo/widget/pulls/7",
	};
	await tasks.handlePrConversation({
		settings: makeSettings(),
		db,
		github,
		sandbox: { nativesCache: null, ensureWorkspace: async () => workspace } as unknown as SandboxManager,
		gitTransport: {} as GitTransport,
		payload,
		deliveryId: "d-pr-comment",
	});
	expect(captured).toEqual({
		attached_authorizes_impl: true,
		task_kind: "handle_comment",
		pr_number: 7,
		run_task_authorizes_impl: true,
	});
});
