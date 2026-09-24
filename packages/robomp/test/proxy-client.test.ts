import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SecretStr, Settings } from "../src/config";
import { HeadDriftError } from "../src/git-ops";
import { GitHubClient, GitHubError } from "../src/github-client";
import { type HttpTransport, jsonResponse, mockTransport } from "../src/http";
import { createProxyApp, type ProxyApp } from "../src/proxy/server";
import { GitHubProxyClient, ProxyGitTransport, requestTarget } from "../src/proxy-client";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, sign, verify } from "../src/proxy-hmac";
import { workspaceKey } from "../src/sandbox";
import { gitSync, tmpPath } from "./helpers";

const HMAC = "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "ghp_test_token_value";

function buildSettings(tmp: string): Settings {
	const cfg = Settings.construct({
		github_token: new SecretStr(TOKEN),
		github_webhook_secret: new SecretStr("webhook-secret"),
		bot_login: "robomp-bot",
		git_author_email: "robomp-bot@example.invalid",
		repo_allowlist_raw: "octo/widget",
		gh_proxy_url: null,
		gh_proxy_hmac_key: new SecretStr(HMAC),
		workspace_root: path.join(tmp, "workspaces"),
		sqlite_path: path.join(tmp, "robomp.sqlite"),
		log_dir: path.join(tmp, "logs"),
	});
	cfg.ensurePaths();
	return cfg;
}

const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args: string[], cwd: string) => gitSync(cwd, args, { env: gitEnv });

function upstreamRepo(tmp: string): string {
	const repo = path.join(tmp, "upstream.git");
	fs.mkdirSync(repo);
	git(["init", "--initial-branch=main", "--bare", repo], tmp);
	const seed = path.join(tmp, "seed");
	fs.mkdirSync(seed);
	git(["init", "--initial-branch=main", seed], tmp);
	fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
	git(["-C", seed, "add", "."], tmp);
	git(["-C", seed, "commit", "-m", "init"], tmp);
	git(["-C", seed, "remote", "add", "origin", repo], tmp);
	git(["-C", seed, "push", "origin", "main"], tmp);
	return repo;
}

function stageWorkspace(cfg: Settings, upstream: string, branch: string): string {
	const wsDir = path.join(cfg.workspace_root, workspaceKey("octo/widget", 1));
	fs.mkdirSync(wsDir, { recursive: true });
	const repoDir = path.join(wsDir, "repo");
	git(["clone", upstream, repoDir], wsDir);
	git(["-C", repoDir, "checkout", "-b", branch], wsDir);
	fs.writeFileSync(path.join(repoDir, "x.txt"), "x");
	git(["-C", repoDir, "add", "."], wsDir);
	git(["-C", repoDir, "commit", "-m", "x"], wsDir);
	return git(["-C", repoDir, "rev-parse", "HEAD"], wsDir);
}

function bareHasBranch(bare: string, branch: string): boolean {
	return Boolean(gitSync(bare, ["-C", bare, "branch", "--list", branch], { check: false }));
}

function appWithGh(cfg: Settings, gh: (req: Request) => Response | Promise<Response>): ProxyApp {
	return createProxyApp(cfg, { github: new GitHubClient(TOKEN, { transport: mockTransport(gh) }) });
}

/** In-process transport into a proxy app (httpx ASGITransport analogue). */
function appTransport(app: ProxyApp): HttpTransport {
	return request => app.fetch(request);
}

function proxyClient(transport: HttpTransport): GitHubProxyClient {
	return new GitHubProxyClient({ baseUrl: "http://proxy.test", hmacKey: HMAC, transport });
}

test("signed headers are present and verify", async () => {
	const captured: { req?: Request; body?: string } = {};
	const client = proxyClient(async req => {
		captured.req = req;
		captured.body = await req.text();
		return jsonResponse(200, {
			full_name: "octo/widget",
			default_branch: "main",
			clone_url: "https://example/octo/widget.git",
			private: false,
		});
	});
	expect((await client.getRepo("octo/widget")).full_name).toBe("octo/widget");
	const req = captured.req!;
	const result = verify({
		method: req.method,
		path: requestTarget(new URL(req.url)),
		body: captured.body ?? "",
		timestamp: req.headers.get(HEADER_TIMESTAMP),
		signature: req.headers.get(HEADER_SIGNATURE),
		key: HMAC,
	});
	expect(result).toEqual({ ok: true, reason: "" });
});

test("round trip every endpoint through a real proxy app", async () => {
	const app = appWithGh(buildSettings(tmpPath()), async req => {
		const p = new URL(req.url).pathname;
		const m = req.method;
		if (p === "/repos/octo/widget")
			return jsonResponse(200, {
				full_name: "octo/widget",
				default_branch: "main",
				clone_url: "https://example/octo/widget.git",
				private: false,
			});
		if (p === "/repos/octo/widget/issues/1" && m === "GET")
			return jsonResponse(200, {
				number: 1,
				title: "T",
				body: "B",
				state: "open",
				user: { login: "alice" },
				labels: [{ name: "bug" }],
			});
		if (p === "/repos/octo/widget/issues" && m === "GET") {
			return jsonResponse(200, [
				{
					number: 1,
					title: "first",
					state: "open",
					user: { login: "alice" },
					labels: [],
					comments: 0,
					updated_at: "2026-01-01T00:00:00Z",
					created_at: "2026-01-01T00:00:00Z",
					html_url: "https://example/1",
				},
			]);
		}
		if (p === "/search/issues" && m === "GET") {
			expect(new URL(req.url).searchParams.get("q")!.startsWith("repo:octo/widget ")).toBe(true);
			return jsonResponse(200, {
				total_count: 1,
				items: [
					{
						number: 9,
						title: "fixed it",
						state: "closed",
						state_reason: "completed",
						user: { login: "bob" },
						labels: [{ name: "bug" }],
						comments: 2,
						updated_at: "2026-02-01T00:00:00Z",
						created_at: "2026-01-15T00:00:00Z",
						html_url: "https://example/9",
						pull_request: { url: "https://example/pull/9" },
					},
				],
			});
		}
		if (p === "/repos/octo/widget/issues/1/comments" && m === "GET")
			return jsonResponse(200, [{ id: 7, user: { login: "u" }, body: "hi", created_at: "2026-01-01T00:00:00Z" }]);
		if (p === "/repos/octo/widget/issues/1/comments" && m === "POST")
			return jsonResponse(201, {
				id: 11,
				user: { login: "bot" },
				body: "posted",
				created_at: "2026-01-01T00:00:00Z",
			});
		if (p === "/repos/octo/widget/pulls/2/comments")
			return jsonResponse(200, [
				{ id: 9, user: { login: "rev" }, body: "nit", path: "a.py", line: 5, created_at: "2026-01-01T00:00:00Z" },
			]);
		if (p === "/repos/octo/widget/pulls/2/reviews" && m === "GET")
			return jsonResponse(200, [
				{
					id: 12,
					user: { login: "rev" },
					body: "approved",
					state: "APPROVED",
					submitted_at: "2026-01-01T00:00:00Z",
				},
			]);
		if (p === "/repos/octo/widget/pulls/2/files")
			return jsonResponse(200, [
				{
					filename: "src/app.py",
					status: "modified",
					additions: 2,
					deletions: 1,
					patch: "@@ -8,5 +8,6 @@\n ctx\n-old\n+new\n",
				},
			]);
		if (p === "/repos/octo/widget/pulls/2/reviews" && m === "POST") {
			const body = (await req.json()) as { body: string; event: string; comments: unknown };
			expect(body.event).toBe("COMMENT");
			expect(body.comments).toEqual([{ path: "src/app.py", line: 12, side: "RIGHT", body: "finding" }]);
			return jsonResponse(200, {
				id: 55,
				user: { login: "robomp-bot" },
				body: body.body,
				state: "COMMENTED",
				submitted_at: "2026-01-01T00:00:00Z",
			});
		}
		if (p === "/user") return jsonResponse(200, { login: "robomp-bot" });
		if (p === "/repos/octo/widget/pulls/4" && m === "GET") {
			return jsonResponse(200, {
				number: 4,
				html_url: "https://example/4",
				head: { ref: "feat", sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", repo: { full_name: "octo/widget" } },
				base: { ref: "main" },
				state: "open",
				user: { login: "robomp-bot" },
			});
		}
		if (p === "/repos/octo/widget/pulls" && m === "POST")
			return jsonResponse(201, {
				number: 4,
				html_url: "https://example/4",
				head: { ref: "feat" },
				base: { ref: "main" },
				state: "open",
			});
		if (p === "/repos/octo/widget/pulls/4/requested_reviewers") return jsonResponse(201, {});
		if (p === "/repos/octo/widget/issues/1/labels") return jsonResponse(200, [{ name: "triage" }]);
		if (p === "/repos/octo/widget/issues/1/labels/needs-info" && m === "DELETE") return jsonResponse(200, {});
		if (p === "/repos/octo/widget/issues/1/assignees") return jsonResponse(201, {});
		return jsonResponse(404, { message: `unrouted ${m} ${p}` });
	});
	const client = proxyClient(appTransport(app));
	expect((await client.getRepo("octo/widget")).full_name).toBe("octo/widget");
	expect((await client.getIssue("octo/widget", 1)).labels).toEqual(["bug"]);
	expect(await client.listIssues("octo/widget")).toHaveLength(1);
	const found = await client.searchIssues("octo/widget", "colon selector is:pr");
	expect(found).toHaveLength(1);
	expect(found[0]!.is_pull_request).toBe(true);
	expect(found[0]!.state_reason).toBe("completed");
	expect(await client.listComments("octo/widget", 1)).toHaveLength(1);
	const rcs = await client.listReviewComments("octo/widget", 2);
	expect(rcs[0]!.line).toBe(5);
	expect(await client.listPrReviews("octo/widget", 2)).toHaveLength(1);
	const files = await client.listPrFiles("octo/widget", 2);
	expect(files[0]!.path).toBe("src/app.py");
	expect(files[0]!.patch).toBe("@@ -8,5 +8,6 @@\n ctx\n-old\n+new\n");
	const submitted = await client.submitPrReview({
		repo: "octo/widget",
		pr_number: 2,
		body: "summary",
		event: "COMMENT",
		comments: [{ path: "src/app.py", line: 12, side: "RIGHT", body: "finding" }],
	});
	expect(submitted.id).toBe(55);
	expect(await client.getAuthenticatedLogin()).toBe("robomp-bot");
	const existing = await client.getPullRequest("octo/widget", 4);
	expect(existing.head_ref).toBe("feat");
	expect(existing.head_sha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
	expect(existing.author).toBe("robomp-bot");
	expect((await client.postComment("octo/widget", 1, "hi")).id).toBe(11);
	expect(
		(await client.openPullRequest({ repo: "octo/widget", head: "feat", base: "main", title: "t", body: "b" })).number,
	).toBe(4);
	expect(await client.requestReviewers({ repo: "octo/widget", pr_number: 4, reviewers: ["alice"] })).toBeUndefined();
	expect(await client.addIssueLabels("octo/widget", 1, ["triage"])).toEqual(["triage"]);
	expect(await client.removeIssueLabel("octo/widget", 1, "needs-info")).toBeUndefined();
	expect(await client.addAssignees("octo/widget", 1, ["alice"])).toBeUndefined();
});

test("comment reactions round trip", async () => {
	const app = appWithGh(buildSettings(tmpPath()), req => {
		const url = new URL(req.url);
		if (url.pathname === "/repos/octo/widget/issues/comments/999/reactions") {
			expect(url.searchParams.get("content")).toBe("-1");
			return jsonResponse(200, [{ content: "-1", user: { login: "alice", type: "User" } }]);
		}
		return jsonResponse(404, { message: "unrouted" });
	});
	expect(await proxyClient(appTransport(app)).listCommentReactions("octo/widget", 999)).toEqual([
		{ content: "-1", user_login: "alice", user_type: "User" },
	]);
});

test("close issue round trip", async () => {
	const captured: { body?: unknown } = {};
	const app = appWithGh(buildSettings(tmpPath()), async req => {
		if (new URL(req.url).pathname === "/repos/octo/widget/issues/7" && req.method === "PATCH") {
			captured.body = await req.json();
			return jsonResponse(200, {});
		}
		return jsonResponse(404, { message: "unrouted" });
	});
	expect(await proxyClient(appTransport(app)).closeIssue("octo/widget", 7)).toBeUndefined();
	expect(captured.body).toEqual({ state: "closed", state_reason: "completed" });
});

describe("submit_pr_review commit_id", () => {
	const reviewResp = { id: 55, user: { login: "robomp-bot" }, body: "summary", state: "COMMENTED", submitted_at: "t" };

	test("reaches the proxy wire and GitHub", async () => {
		const upstream: { body?: Record<string, unknown> } = {};
		const app = appWithGh(buildSettings(tmpPath()), async req => {
			if (new URL(req.url).pathname === "/repos/octo/widget/pulls/2/reviews" && req.method === "POST") {
				upstream.body = (await req.json()) as Record<string, unknown>;
				return jsonResponse(200, reviewResp);
			}
			return jsonResponse(404, { message: "unrouted" });
		});
		const wireBodies: Record<string, unknown>[] = [];
		const client = proxyClient(async req => {
			if (new URL(req.url).pathname === "/gh/v1/submit_pr_review") {
				const raw = await req.clone().text();
				wireBodies.push(JSON.parse(raw) as Record<string, unknown>);
			}
			return app.fetch(req);
		});
		const comments = [{ path: "src/app.py", line: 12, side: "RIGHT", body: "finding" }];
		const review = await client.submitPrReview({
			repo: "octo/widget",
			pr_number: 2,
			body: "summary",
			event: "COMMENT",
			comments,
			commit_id: "abc123",
		});
		expect(review.id).toBe(55);
		expect(wireBodies).toEqual([
			{ repo: "octo/widget", pr_number: 2, body: "summary", event: "COMMENT", comments, commit_id: "abc123" },
		]);
		expect(upstream.body!.commit_id).toBe("abc123");
		await client.submitPrReview({
			repo: "octo/widget",
			pr_number: 2,
			body: "summary",
			event: "COMMENT",
			comments: [],
		});
		expect("commit_id" in wireBodies[1]!).toBe(false);
	});

	test.each([12345, ""])("server drops a non-string/empty commit_id %p", async badCommitId => {
		const upstream: { body?: Record<string, unknown> } = {};
		const app = appWithGh(buildSettings(tmpPath()), async req => {
			if (new URL(req.url).pathname === "/repos/octo/widget/pulls/3/reviews" && req.method === "POST") {
				upstream.body = (await req.json()) as Record<string, unknown>;
				return jsonResponse(200, { ...reviewResp, id: 56 });
			}
			return jsonResponse(404, { message: "unrouted" });
		});
		const body = JSON.stringify({
			repo: "octo/widget",
			pr_number: 3,
			body: "summary",
			event: "COMMENT",
			comments: [],
			commit_id: badCommitId,
		});
		const [ts, sig] = sign({ method: "POST", path: "/gh/v1/submit_pr_review", body, key: HMAC });
		const resp = await app.fetch(
			new Request("http://proxy.test/gh/v1/submit_pr_review", {
				method: "POST",
				body,
				headers: { [HEADER_TIMESTAMP]: ts, [HEADER_SIGNATURE]: sig, "Content-Type": "application/json" },
			}),
		);
		expect(resp.status).toBe(200);
		expect("commit_id" in upstream.body!).toBe(false);
	});
});

test("error decode maps github 422", async () => {
	const client = proxyClient(() => jsonResponse(422, { error: { kind: "github", status: 422, message: "x" } }));
	try {
		await client.postComment("octo/widget", 1, "hi");
		throw new Error("expected GitHubError");
	} catch (err) {
		expect(err).toBeInstanceOf(GitHubError);
		expect((err as GitHubError).status).toBe(422);
		expect((err as GitHubError).detail).toBe("x");
	}
});

describe("ProxyGitTransport", () => {
	const gitTransport = (transport: HttpTransport) =>
		new ProxyGitTransport({ baseUrl: "http://proxy.test", hmacKey: HMAC, transport });

	test("push happy path through a real proxy", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/feat";
		const head = stageWorkspace(cfg, upstream, branch);
		const app = appWithGh(cfg, () => jsonResponse(500, { message: "should not be hit" }));
		const key = workspaceKey("octo/widget", 1);
		const result = await gitTransport(appTransport(app)).pushBranch({
			repo: "octo/widget",
			workspaceKey: key,
			repoDir: path.join(cfg.workspace_root, key, "repo"),
			branch,
			expectedHead: head,
		});
		expect(result).toEqual({ head, branch });
		expect(bareHasBranch(upstream, branch)).toBe(true);
	});

	test("push head drift raises HeadDriftError", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/drift";
		stageWorkspace(cfg, upstream, branch);
		const app = appWithGh(cfg, () => jsonResponse(500, { message: "should not be hit" }));
		const key = workspaceKey("octo/widget", 1);
		await expect(
			gitTransport(appTransport(app)).pushBranch({
				repo: "octo/widget",
				workspaceKey: key,
				repoDir: path.join(cfg.workspace_root, key, "repo"),
				branch,
				expectedHead: "0".repeat(40),
			}),
		).rejects.toBeInstanceOf(HeadDriftError);
		expect(bareHasBranch(upstream, branch)).toBe(false);
	});

	test("push includes slot_uid only when given", async () => {
		const captured: Record<string, unknown>[] = [];
		const transport = gitTransport(async req => {
			captured.push((await req.json()) as Record<string, unknown>);
			return jsonResponse(200, { head: "abc123", branch: "farm/abc/feat" });
		});
		const base = {
			repo: "octo/widget",
			workspaceKey: "octo__widget__1",
			repoDir: "/unused",
			branch: "farm/abc/feat",
			expectedHead: "abc123",
		};
		await transport.pushBranch({ ...base, slotUid: 2001 });
		await transport.pushBranch(base);
		expect(captured[0]!.slot_uid).toBe(2001);
		expect("slot_uid" in captured[1]!).toBe(false);
	});

	test("push_release body", async () => {
		const captured: { path?: string; body?: unknown } = {};
		const transport = gitTransport(async req => {
			captured.path = new URL(req.url).pathname;
			captured.body = await req.json();
			return jsonResponse(200, { head: "abc123", branch: "main", tag: "v1.2.3" });
		});
		const result = await transport.pushRelease({
			repo: "octo/widget",
			workspaceKey: "octo__widget__release",
			repoDir: "/unused",
			branch: "main",
			tag: "v1.2.3",
			expectedHead: "abc123",
			slotUid: 2001,
		});
		expect(result.head).toBe("abc123");
		expect(captured.path).toBe("/gh/v1/git/push_release");
		expect(captured.body).toEqual({
			repo: "octo/widget",
			workspace_key: "octo__widget__release",
			branch: "main",
			tag: "v1.2.3",
			expected_head: "abc123",
			slot_uid: 2001,
		});
	});

	test("signed POST headers verify", async () => {
		const captured: { req?: Request; body?: string } = {};
		const transport = gitTransport(async req => {
			captured.req = req;
			captured.body = await req.text();
			return jsonResponse(200, { pool_dir: "/tmp/x" });
		});
		await transport.clonePool({ repo: "octo/widget", cloneUrl: "https://example/widget.git", defaultBranch: "main" });
		const req = captured.req!;
		const result = verify({
			method: "POST",
			path: "/gh/v1/git/clone",
			body: captured.body!,
			timestamp: req.headers.get(HEADER_TIMESTAMP),
			signature: req.headers.get(HEADER_SIGNATURE),
			key: HMAC,
		});
		expect(result.ok).toBe(true);
		expect((JSON.parse(captured.body!) as { repo: string }).repo).toBe("octo/widget");
	});
});

test("release read payloads deserialize", async () => {
	const client = proxyClient(req => {
		const p = new URL(req.url).pathname;
		if (p === "/gh/v1/workflow_runs") {
			return jsonResponse(200, {
				items: [
					{
						id: 1,
						name: "CI",
						event: "push",
						status: "completed",
						conclusion: "failure",
						head_branch: "main",
						head_sha: "abc",
						html_url: "https://example/run",
						run_attempt: 1,
					},
				],
			});
		}
		if (p === "/gh/v1/workflow_jobs") {
			return jsonResponse(200, {
				items: [
					{
						id: 2,
						run_id: 1,
						name: "test",
						status: "completed",
						conclusion: "failure",
						html_url: "https://example/job",
						failed_steps: ["tests"],
					},
				],
			});
		}
		if (p === "/gh/v1/job_log_tail") return jsonResponse(200, { text: "failure" });
		if (p === "/gh/v1/tag_ref") return jsonResponse(200, { sha: "abc" });
		expect(p).toBe("/gh/v1/release_by_tag");
		return jsonResponse(200, {
			tag: "v1.2.3",
			name: "1.2.3",
			draft: false,
			prerelease: false,
			html_url: "https://example/release",
			asset_names: ["omp.tar.gz"],
		});
	});
	expect((await client.listWorkflowRuns("octo/widget", "abc"))[0]!.head_sha).toBe("abc");
	expect((await client.listWorkflowJobs("octo/widget", 1))[0]!.failed_steps).toEqual(["tests"]);
	expect(await client.getJobLogTail("octo/widget", 2, 120)).toBe("failure");
	expect(await client.getTagSha("octo/widget", "v1.2.3")).toBe("abc");
	expect((await client.getReleaseByTag("octo/widget", "v1.2.3"))?.asset_names).toEqual(["omp.tar.gz"]);
});
