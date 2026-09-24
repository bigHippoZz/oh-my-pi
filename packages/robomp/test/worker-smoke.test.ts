/**
 * Gated end-to-end smoke test (port of test_worker_smoke.py).
 *
 * Runs only when ROBOMP_INTEGRATION=1 and `omp` is on PATH (or via
 * ROBOMP_OMP_COMMAND). Drives a real `omp --mode rpc` subprocess through
 * `triageIssue` against a local bare repo and a fake GitHub API, asserting a
 * comment, a template-conformant PR, a pushed branch and an `opened` row.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "../src/db";
import { GitHubClient } from "../src/github-client";
import { jsonResponse, mockTransport } from "../src/http";
import { LocalGitTransport, SandboxManager } from "../src/sandbox";
import { triageIssue } from "../src/tasks";
import { makeSettings, tmpPath } from "./helpers";

const INTEGRATION = process.env.ROBOMP_INTEGRATION === "1";

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

function seedFailingRepo(tmp: string): string {
	const bare = path.join(tmp, "upstream.git");
	fs.mkdirSync(bare);
	git(tmp, "init", "--initial-branch=main", "--bare", bare);
	const seed = path.join(tmp, "seed");
	fs.mkdirSync(seed);
	git(seed, "init", "--initial-branch=main");
	fs.writeFileSync(
		path.join(seed, "test.js"),
		"const assert = require('assert');\n// FIXME: this assertion is wrong; the answer is 4.\nassert.strictEqual(2 + 2, 5);\n",
	);
	fs.writeFileSync(path.join(seed, "README.md"), "toy repo\n");
	git(seed, "add", ".");
	git(seed, "commit", "-m", "init");
	git(seed, "remote", "add", "origin", bare);
	git(seed, "push", "origin", "main");
	return bare;
}

const ISSUE_BODY = "Running `node test.js` exits non-zero because the assertion claims 2+2 is 5.";

describe.skipIf(!INTEGRATION)("omp-backed smoke", () => {
	test("triage end to end", async () => {
		const tmp = tmpPath();
		const bare = seedFailingRepo(tmp);
		const cfg = makeSettings(
			{
				GITHUB_WEBHOOK_SECRET: "secret",
				ROBOMP_TASK_TIMEOUT_SECONDS: "300",
				...(process.env.ROBOMP_OMP_COMMAND ? { ROBOMP_OMP_COMMAND: process.env.ROBOMP_OMP_COMMAND } : {}),
			},
			tmp,
		);
		const comments: Record<string, unknown>[] = [];
		const prs: Record<string, unknown>[] = [];
		let nextCommentId = 100;
		const transport = mockTransport(async request => {
			const p = new URL(request.url).pathname;
			const method = request.method;
			if (method === "GET" && p === "/repos/octo/widget") {
				return jsonResponse(200, {
					full_name: "octo/widget",
					default_branch: "main",
					clone_url: bare,
					private: false,
				});
			}
			if (method === "GET" && p === "/repos/octo/widget/issues/1") {
				return jsonResponse(200, {
					number: 1,
					title: "2+2 should be 4",
					body: ISSUE_BODY,
					state: "open",
					user: { login: "alice" },
					labels: [],
				});
			}
			if (method === "GET" && p === "/repos/octo/widget/issues/1/comments") return jsonResponse(200, comments);
			if (method === "POST" && p === "/repos/octo/widget/issues/1/comments") {
				const body = JSON.parse(await request.text());
				nextCommentId += 1;
				const comment = { id: nextCommentId, user: { login: "robomp-bot" }, body: body.body, created_at: "now" };
				comments.push(comment);
				return jsonResponse(201, comment);
			}
			if (method === "POST" && p === "/repos/octo/widget/pulls") {
				const body = JSON.parse(await request.text());
				const pr = {
					number: 7,
					html_url: "https://example.invalid/octo/widget/pull/7",
					head: { ref: body.head },
					base: { ref: body.base },
					state: "open",
					title: body.title,
					body: body.body,
				};
				prs.push(pr);
				return jsonResponse(201, pr);
			}
			return jsonResponse(404, { message: `unmocked ${method} ${p}` });
		});
		const db = new Database(cfg.sqlite_path);
		try {
			await triageIssue({
				settings: cfg,
				db,
				github: new GitHubClient("ghp_test", { transport }),
				gitTransport: new LocalGitTransport(null),
				sandbox: new SandboxManager(cfg.workspace_root),
				payload: {
					action: "opened",
					issue: {
						number: 1,
						title: "2+2 should be 4",
						body: ISSUE_BODY,
						state: "open",
						user: { login: "alice" },
						labels: [],
					},
					repository: { full_name: "octo/widget", default_branch: "main", clone_url: bare, private: false },
				},
				deliveryId: "smoke-test",
			});
			expect(db.getIssue("octo/widget#1")?.state).toBe("opened");
		} finally {
			db.close();
		}
		expect(prs.length).toBeGreaterThan(0);
		const prBody = String(prs[0]!.body);
		for (const section of ["## Repro", "## Cause", "## Fix", "## Verification"]) expect(prBody).toContain(section);
		expect(prBody).toContain("Fixes #1");
		const refs = git(tmp, "-C", bare, "for-each-ref", "--format=%(refname)").split("\n");
		expect(refs.some(r => r.startsWith("refs/heads/farm/"))).toBe(true);
		expect(comments.length).toBeGreaterThan(0);
	}, 900_000);
});
