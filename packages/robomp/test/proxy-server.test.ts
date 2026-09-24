import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SecretStr, Settings } from "../src/config";
import { GitHubClient } from "../src/github-client";
import { jsonResponse, mockTransport } from "../src/http";
import { createProxyApp, type ProxyApp, proxyGitOps, readRemoteUrls } from "../src/proxy/server";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, sign } from "../src/proxy-hmac";
import { workspaceKey } from "../src/sandbox";
import * as subprocess from "../src/subprocess";
import { gitSync, tmpPath } from "./helpers";

const HMAC = "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "ghp_test_token_value";

afterEach(() => {
	for (const fn of Object.values(proxyGitOps)) (fn as { mockRestore?: () => void }).mockRestore?.();
});

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

function git(args: string[], cwd: string): string {
	return gitSync(cwd, args, {
		env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
}

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

function stageWorkspace(
	cfg: Settings,
	upstream: string,
	repo: string,
	number: number,
	branch: string,
): [string, string] {
	const wsDir = path.join(cfg.workspace_root, workspaceKey(repo, number));
	fs.mkdirSync(wsDir, { recursive: true });
	const repoDir = path.join(wsDir, "repo");
	git(["clone", upstream, repoDir], wsDir);
	git(["-C", repoDir, "config", "user.email", "t@t"], wsDir);
	git(["-C", repoDir, "config", "user.name", "t"], wsDir);
	git(["-C", repoDir, "checkout", "-b", branch], wsDir);
	fs.writeFileSync(path.join(repoDir, "x.txt"), "x");
	git(["-C", repoDir, "add", "."], wsDir);
	git(["-C", repoDir, "commit", "-m", "x"], wsDir);
	return [repoDir, git(["-C", repoDir, "rev-parse", "HEAD"], wsDir)];
}

function stagePool(cfg: Settings, upstream: string, repo = "octo/widget"): string {
	const pool = path.join(cfg.workspace_root, "_pool", repo.replaceAll("/", "__"));
	fs.mkdirSync(path.dirname(pool), { recursive: true });
	git(["clone", "--filter=blob:none", upstream, pool], cfg.workspace_root);
	return pool;
}

function bareHasBranch(bare: string, branch: string): boolean {
	return Boolean(gitSync(bare, ["-C", bare, "branch", "--list", branch], { check: false }));
}

function withParams(p: string, params?: Record<string, string | number>): string {
	if (!params) return p;
	const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();
	return qs ? `${p}?${qs}` : p;
}

function signed(
	method: string,
	p: string,
	body = "",
	options: { params?: Record<string, string | number>; ts?: string; key?: string } = {},
): Record<string, string> {
	const target = withParams(p, options.params);
	const [ts, sig] = sign({ method, path: target, body, key: options.key ?? HMAC, timestamp: options.ts });
	return { [HEADER_TIMESTAMP]: ts, [HEADER_SIGNATURE]: sig };
}

function buildApp(cfg: Settings, gh?: (req: Request) => Response | Promise<Response>): ProxyApp {
	const transport = gh ? mockTransport(gh) : mockTransport(() => jsonResponse(500, { message: "no gh" }));
	return createProxyApp(cfg, { github: new GitHubClient(TOKEN, { transport }) });
}

function call(
	app: ProxyApp,
	method: string,
	target: string,
	init: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	return app.fetch(new Request(`http://proxy.test${target}`, { method, body: init.body, headers: init.headers }));
}

function signedGet(app: ProxyApp, p: string, params?: Record<string, string | number>): Promise<Response> {
	return call(app, "GET", withParams(p, params), { headers: signed("GET", p, "", { params }) });
}

function signedPost(app: ProxyApp, p: string, body: string): Promise<Response> {
	return call(app, "POST", p, { body, headers: { ...signed("POST", p, body), "Content-Type": "application/json" } });
}

test("readRemoteUrls uses safe.directory and slot identity", async () => {
	const repoDir = path.join(tmpPath(), "repo");
	const prevToken = process.env.GITHUB_TOKEN;
	const prevAuth = process.env.ROBOMP_GIT_HTTP_AUTH;
	process.env.GITHUB_TOKEN = "parent-token";
	process.env.ROBOMP_GIT_HTTP_AUTH = "parent-auth";
	const captured: { cmd?: readonly string[]; options?: subprocess.RunOptions } = {};
	const run = spyOn(subprocess.processRunner, "run").mockImplementation(async (cmd, options) => {
		captured.cmd = cmd;
		captured.options = options;
		return {
			args: [...cmd],
			returncode: 0,
			stdout: "https://github.com/octo/widget.git\n",
			stderr: "",
			timedOut: false,
		};
	});
	const identity = spyOn(subprocess, "slotIdentity").mockImplementation(uid =>
		uid === null || uid === undefined ? null : { uid, gid: uid, groups: [2000], umask: 0o002 },
	);
	try {
		expect(await readRemoteUrls(repoDir, { slotUid: 2001 })).toContain("https://github.com/octo/widget.git");
	} finally {
		run.mockRestore();
		identity.mockRestore();
		if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
		else process.env.GITHUB_TOKEN = prevToken;
		if (prevAuth === undefined) delete process.env.ROBOMP_GIT_HTTP_AUTH;
		else process.env.ROBOMP_GIT_HTTP_AUTH = prevAuth;
	}
	const env = captured.options!.env!;
	expect(env.GIT_CONFIG_COUNT).toBe("1");
	expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
	expect(env.GIT_CONFIG_VALUE_0).toBe(repoDir);
	expect("GITHUB_TOKEN" in env).toBe(false);
	expect("ROBOMP_GIT_HTTP_AUTH" in env).toBe(false);
	expect(captured.options!.identity).toEqual({ uid: 2001, gid: 2001, groups: [2000], umask: 0o002 });
});

describe("HMAC behavior", () => {
	test("accepts a signed post_comment round trip", async () => {
		const captured: { req?: Request } = {};
		const app = buildApp(buildSettings(tmpPath()), req => {
			captured.req = req;
			return jsonResponse(201, {
				id: 42,
				user: { login: "robomp-bot" },
				body: "hello",
				created_at: "2026-01-01T00:00:00Z",
			});
		});
		const resp = await signedPost(app, "/gh/v1/post_comment", '{"repo":"octo/widget","number":1,"body":"hello"}');
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({
			id: 42,
			author: "robomp-bot",
			body: "hello",
			created_at: "2026-01-01T00:00:00Z",
		});
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/issues/1/comments");
	});

	test("rejects missing headers", async () => {
		const app = buildApp(buildSettings(tmpPath()), () => jsonResponse(200, {}));
		expect((await call(app, "GET", "/gh/v1/repo?repo=octo%2Fwidget")).status).toBe(401);
	});

	test("rejects bad signature", async () => {
		const app = buildApp(buildSettings(tmpPath()), () => jsonResponse(200, {}));
		const resp = await call(app, "GET", "/gh/v1/repo?repo=octo%2Fwidget", {
			headers: { [HEADER_TIMESTAMP]: String(Math.floor(Date.now() / 1000)), [HEADER_SIGNATURE]: "0".repeat(64) },
		});
		expect(resp.status).toBe(401);
	});

	test("rejects stale timestamp", async () => {
		const app = buildApp(buildSettings(tmpPath()), () => jsonResponse(200, {}));
		const stale = String(Math.floor(Date.now() / 1000) - 120);
		const resp = await call(app, "GET", "/gh/v1/repo?repo=octo%2Fwidget", {
			headers: signed("GET", "/gh/v1/repo", "", { ts: stale }),
		});
		expect(resp.status).toBe(401);
	});

	test("binds the raw query string (query mutation → 401)", async () => {
		const captured: Request[] = [];
		const app = buildApp(buildSettings(tmpPath()), req => {
			captured.push(req);
			return jsonResponse(200, {
				number: 1,
				title: "T",
				body: "B",
				state: "open",
				user: { login: "x" },
				labels: [],
			});
		});
		const headers = signed("GET", "/gh/v1/issue", "", { params: { repo: "octo/widget", number: 1 } });
		const resp = await call(app, "GET", withParams("/gh/v1/issue", { repo: "octo/widget", number: 2 }), { headers });
		expect(resp.status).toBe(401);
		expect(captured).toEqual([]);
	});
});

describe("GET endpoints", () => {
	test("repo", async () => {
		const app = buildApp(buildSettings(tmpPath()), req => {
			expect(new URL(req.url).pathname).toBe("/repos/octo/widget");
			return jsonResponse(200, {
				full_name: "octo/widget",
				default_branch: "main",
				clone_url: "https://github.com/octo/widget.git",
				private: false,
			});
		});
		const resp = await signedGet(app, "/gh/v1/repo", { repo: "octo/widget" });
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({
			full_name: "octo/widget",
			default_branch: "main",
			clone_url: "https://github.com/octo/widget.git",
			private: false,
		});
	});

	test("issue", async () => {
		const app = buildApp(buildSettings(tmpPath()), req => {
			expect(new URL(req.url).pathname).toBe("/repos/octo/widget/issues/1");
			return jsonResponse(200, {
				number: 1,
				title: "T",
				body: "B",
				state: "open",
				user: { login: "alice" },
				labels: [{ name: "bug" }],
			});
		});
		const resp = await signedGet(app, "/gh/v1/issue", { repo: "octo/widget", number: 1 });
		expect(resp.status).toBe(200);
		const payload = (await resp.json()) as Record<string, unknown>;
		expect(payload.repo).toBe("octo/widget");
		expect(payload.number).toBe(1);
		expect(payload.labels).toEqual(["bug"]);
		expect(payload.is_pull_request).toBe(false);
	});

	test("issues filters out PRs", async () => {
		const app = buildApp(buildSettings(tmpPath()), req => {
			expect(new URL(req.url).pathname).toBe("/repos/octo/widget/issues");
			return jsonResponse(200, [
				{
					number: 1,
					title: "first",
					state: "open",
					user: { login: "alice" },
					labels: [{ name: "bug" }],
					comments: 0,
					updated_at: "2026-01-01T00:00:00Z",
					created_at: "2026-01-01T00:00:00Z",
					html_url: "https://example/1",
				},
				{ number: 2, title: "pr", pull_request: { url: "x" }, user: { login: "alice" } },
			]);
		});
		const resp = await signedGet(app, "/gh/v1/issues", { repo: "octo/widget" });
		expect(resp.status).toBe(200);
		const items = ((await resp.json()) as { items: { number: number }[] }).items;
		expect(items).toHaveLength(1);
		expect(items[0]!.number).toBe(1);
	});

	test("comments", async () => {
		const app = buildApp(buildSettings(tmpPath()), req => {
			expect(new URL(req.url).pathname).toBe("/repos/octo/widget/issues/1/comments");
			return jsonResponse(200, [{ id: 1, user: { login: "u" }, body: "hi", created_at: "2026-01-01T00:00:00Z" }]);
		});
		const resp = await signedGet(app, "/gh/v1/comments", { repo: "octo/widget", number: 1 });
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({
			items: [{ id: 1, author: "u", body: "hi", created_at: "2026-01-01T00:00:00Z" }],
		});
	});

	test("review comments", async () => {
		const app = buildApp(buildSettings(tmpPath()), req => {
			expect(new URL(req.url).pathname).toBe("/repos/octo/widget/pulls/1/comments");
			return jsonResponse(200, [
				{ id: 9, user: { login: "rev" }, body: "nit", path: "a.py", line: 5, created_at: "2026-01-01T00:00:00Z" },
			]);
		});
		const resp = await signedGet(app, "/gh/v1/review_comments", { repo: "octo/widget", pr_number: 1 });
		expect(resp.status).toBe(200);
		const items = ((await resp.json()) as { items: { path: string; line: number }[] }).items;
		expect(items[0]!.path).toBe("a.py");
		expect(items[0]!.line).toBe(5);
	});

	test("pr reviews drop empty bodies", async () => {
		const app = buildApp(buildSettings(tmpPath()), req => {
			expect(new URL(req.url).pathname).toBe("/repos/octo/widget/pulls/1/reviews");
			return jsonResponse(200, [
				{
					id: 11,
					user: { login: "rev" },
					body: "looks good",
					state: "APPROVED",
					submitted_at: "2026-01-01T00:00:00Z",
				},
				{ id: 12, user: { login: "rev" }, body: "  ", state: "COMMENTED" },
			]);
		});
		const resp = await signedGet(app, "/gh/v1/pr_reviews", { repo: "octo/widget", pr_number: 1 });
		expect(resp.status).toBe(200);
		const items = ((await resp.json()) as { items: { state: string }[] }).items;
		expect(items).toHaveLength(1);
		expect(items[0]!.state).toBe("APPROVED");
	});

	test("authenticated login", async () => {
		const app = buildApp(buildSettings(tmpPath()), req => {
			expect(new URL(req.url).pathname).toBe("/user");
			return jsonResponse(200, { login: "robomp-bot" });
		});
		const resp = await signedGet(app, "/gh/v1/authenticated_login");
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ login: "robomp-bot" });
	});

	test("comment reactions with a pre-encoded target", async () => {
		const captured: { req?: Request } = {};
		const app = buildApp(buildSettings(tmpPath()), req => {
			captured.req = req;
			return jsonResponse(200, [{ content: "-1", user: { login: "alice", type: "User" } }]);
		});
		const target = "/gh/v1/comment_reactions?repo=octo%2Fwidget&comment_id=999";
		const [ts, sig] = sign({ method: "GET", path: target, body: "", key: HMAC });
		const resp = await call(app, "GET", target, { headers: { [HEADER_TIMESTAMP]: ts, [HEADER_SIGNATURE]: sig } });
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ items: [{ content: "-1", user_login: "alice", user_type: "User" }] });
		const url = new URL(captured.req!.url);
		expect(url.pathname).toBe("/repos/octo/widget/issues/comments/999/reactions");
		expect(url.searchParams.get("content")).toBe("-1");
	});

	test("release read endpoints proxy typed GitHub shapes", async () => {
		const upstream: string[] = [];
		const app = buildApp(buildSettings(tmpPath()), req => {
			upstream.push(req.url);
			const pathname = new URL(req.url).pathname;
			if (pathname === "/repos/octo/widget/actions/runs") {
				return jsonResponse(200, {
					workflow_runs: [
						{
							id: 7,
							name: "CI",
							event: "push",
							status: "completed",
							conclusion: "failure",
							head_branch: "main",
							head_sha: "abc",
							html_url: "https://example.invalid/run/7",
							run_attempt: 2,
						},
					],
				});
			}
			if (pathname === "/repos/octo/widget/actions/runs/7/jobs") {
				return jsonResponse(200, {
					jobs: [
						{
							id: 8,
							run_id: 7,
							name: "check",
							status: "completed",
							conclusion: "failure",
							html_url: "https://example.invalid/job/8",
							steps: [
								{ name: "install", conclusion: "success" },
								{ name: "bun check", conclusion: "failure" },
							],
						},
					],
				});
			}
			if (pathname === "/repos/octo/widget/actions/jobs/8/logs") return new Response("install ok\nbun check failed");
			if (pathname === "/repos/octo/widget/git/ref/tags/v1.2.3")
				return jsonResponse(200, { object: { type: "commit", sha: "abc" } });
			if (pathname === "/repos/octo/widget/releases/tags/v1.2.3") {
				return jsonResponse(200, {
					tag_name: "v1.2.3",
					name: "1.2.3",
					draft: false,
					prerelease: false,
					html_url: "https://example.invalid/release/v1.2.3",
					assets: [{ name: "omp.tar.gz" }],
				});
			}
			return jsonResponse(500, { message: `unexpected ${pathname}` });
		});
		const runs = await signedGet(app, "/gh/v1/workflow_runs", { repo: "octo/widget", head_sha: "abc" });
		const jobs = await signedGet(app, "/gh/v1/workflow_jobs", { repo: "octo/widget", run_id: 7 });
		const logTail = await signedGet(app, "/gh/v1/job_log_tail", { repo: "octo/widget", job_id: 8, tail: 5000 });
		const tag = await signedGet(app, "/gh/v1/tag_ref", { repo: "octo/widget", tag: "v1.2.3" });
		const release = await signedGet(app, "/gh/v1/release_by_tag", { repo: "octo/widget", tag: "v1.2.3" });
		expect(((await runs.json()) as { items: { head_sha: string }[] }).items[0]!.head_sha).toBe("abc");
		expect(((await jobs.json()) as { items: { failed_steps: string[] }[] }).items[0]!.failed_steps).toEqual([
			"bun check",
		]);
		expect(await logTail.json()).toEqual({ text: "install ok\nbun check failed" });
		expect(await tag.json()).toEqual({ sha: "abc" });
		expect(((await release.json()) as { asset_names: string[] }).asset_names).toEqual(["omp.tar.gz"]);
		expect(upstream[0]).toContain("head_sha=abc");
	});
});

describe("POST endpoints", () => {
	const capture = () => {
		const captured: { req?: Request; body?: unknown } = {};
		const handler = (status: number, data: unknown) => async (req: Request) => {
			captured.req = req;
			const text = await req.text();
			captured.body = text ? JSON.parse(text) : undefined;
			return jsonResponse(status, data);
		};
		return { captured, handler };
	};

	test("post_comment forwards body", async () => {
		const { captured, handler } = capture();
		const app = buildApp(
			buildSettings(tmpPath()),
			handler(201, { id: 7, user: { login: "b" }, body: "hi", created_at: "2026-01-01T00:00:00Z" }),
		);
		expect(
			(await signedPost(app, "/gh/v1/post_comment", '{"repo":"octo/widget","number":1,"body":"hi"}')).status,
		).toBe(200);
		expect(captured.req!.method).toBe("POST");
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/issues/1/comments");
		expect(captured.body).toEqual({ body: "hi" });
	});

	test("add_issue_labels", async () => {
		const { captured, handler } = capture();
		const app = buildApp(buildSettings(tmpPath()), handler(200, [{ name: "triage" }, { name: "bug" }]));
		const resp = await signedPost(
			app,
			"/gh/v1/add_issue_labels",
			'{"repo":"octo/widget","number":1,"labels":["triage","bug"]}',
		);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ labels: ["triage", "bug"] });
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/issues/1/labels");
		expect(captured.body).toEqual({ labels: ["triage", "bug"] });
	});

	test("remove_issue_label", async () => {
		const { captured, handler } = capture();
		const app = buildApp(buildSettings(tmpPath()), handler(200, {}));
		const resp = await signedPost(
			app,
			"/gh/v1/remove_issue_label",
			'{"repo":"octo/widget","number":1,"label":"needs-info"}',
		);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ ok: true });
		expect(captured.req!.method).toBe("DELETE");
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/issues/1/labels/needs-info");
	});

	test("add_assignees", async () => {
		const { captured, handler } = capture();
		const app = buildApp(buildSettings(tmpPath()), handler(201, {}));
		const resp = await signedPost(
			app,
			"/gh/v1/add_assignees",
			'{"repo":"octo/widget","number":1,"assignees":["alice"]}',
		);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ ok: true });
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/issues/1/assignees");
		expect(captured.body).toEqual({ assignees: ["alice"] });
	});

	test("close_issue", async () => {
		const { captured, handler } = capture();
		const app = buildApp(buildSettings(tmpPath()), handler(200, {}));
		const resp = await signedPost(
			app,
			"/gh/v1/close_issue",
			'{"repo":"octo/widget","number":7,"reason":"completed"}',
		);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ ok: true });
		expect(captured.req!.method).toBe("PATCH");
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/issues/7");
		expect(captured.body).toEqual({ state: "closed", state_reason: "completed" });
	});

	test("close_issue defaults reason to completed", async () => {
		const { captured, handler } = capture();
		const app = buildApp(buildSettings(tmpPath()), handler(200, {}));
		expect((await signedPost(app, "/gh/v1/close_issue", '{"repo":"octo/widget","number":7}')).status).toBe(200);
		expect(captured.body).toEqual({ state: "closed", state_reason: "completed" });
	});

	test("open_pull_request", async () => {
		const { captured, handler } = capture();
		const app = buildApp(
			buildSettings(tmpPath()),
			handler(201, {
				number: 4,
				html_url: "https://example/4",
				head: { ref: "feature" },
				base: { ref: "main" },
				state: "open",
			}),
		);
		const resp = await signedPost(
			app,
			"/gh/v1/open_pull_request",
			'{"repo":"octo/widget","head":"feature","base":"main","title":"t","body":"b","draft":false,"maintainer_can_modify":true}',
		);
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as { number: number }).number).toBe(4);
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/pulls");
		expect(captured.body).toMatchObject({ head: "feature", base: "main", title: "t" });
	});

	test("request_reviewers", async () => {
		const { captured, handler } = capture();
		const app = buildApp(buildSettings(tmpPath()), handler(201, {}));
		const resp = await signedPost(
			app,
			"/gh/v1/request_reviewers",
			'{"repo":"octo/widget","pr_number":4,"reviewers":["alice"],"team_reviewers":null}',
		);
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ ok: true });
		expect(new URL(captured.req!.url).pathname).toBe("/repos/octo/widget/pulls/4/requested_reviewers");
		expect(captured.body).toEqual({ reviewers: ["alice"] });
	});

	test.each([
		["", "invalid json: Expecting value: line 1 column 1 (char 0)"],
		[
			'{"repo": "octo/widget",\n "number": 1,}',
			"invalid json: Expecting property name enclosed in double quotes: line 2 column 14 (char 37)",
		],
		['{"repo": "octo/widget"} x', "invalid json: Extra data: line 1 column 25 (char 24)"],
		["[1, 2]", "json body must be an object"],
	])("malformed body %p → 400 with Python json.loads detail", async (body, detail) => {
		const app = buildApp(buildSettings(tmpPath()));
		const resp = await signedPost(app, "/gh/v1/post_comment", body);
		expect(resp.status).toBe(400);
		expect(await resp.json()).toEqual({ detail });
	});

	test("GitHub error passthrough 422", async () => {
		const app = buildApp(buildSettings(tmpPath()), () => jsonResponse(422, { message: "validation failed" }));
		const resp = await signedPost(app, "/gh/v1/post_comment", '{"repo":"octo/widget","number":1,"body":"hi"}');
		expect(resp.status).toBe(422);
		const err = ((await resp.json()) as { error: Record<string, unknown> }).error;
		expect(err.kind).toBe("github");
		expect(err.status).toBe(422);
		expect(err.message).toBe("validation failed");
	});
});

describe("body cap", () => {
	test("oversized content-length rejected with 413", async () => {
		const cfg = buildSettings(tmpPath());
		cfg.gh_proxy_max_body_bytes = 256;
		const app = buildApp(cfg, () => jsonResponse(500, {}));
		const payload = "x".repeat(1024);
		const resp = await call(app, "POST", "/gh/v1/post_comment", {
			body: payload,
			headers: {
				...signed("POST", "/gh/v1/post_comment", payload),
				"Content-Type": "application/json",
				"Content-Length": String(1024 * 1024 * 64),
			},
		});
		expect(resp.status).toBe(413);
	});

	test("streamed body above cap rejected with 413", async () => {
		const cfg = buildSettings(tmpPath());
		cfg.gh_proxy_max_body_bytes = 64;
		const app = buildApp(cfg, () => jsonResponse(500, {}));
		const payload = `{"repo":"octo/widget","number":1,"body":"${"y".repeat(200)}"}`;
		expect((await signedPost(app, "/gh/v1/post_comment", payload)).status).toBe(413);
	});
});

describe("git transport endpoints", () => {
	test("clone creates pool dir", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const resp = await signedPost(
			buildApp(cfg),
			"/gh/v1/git/clone",
			JSON.stringify({ repo: "octo/widget", clone_url: upstream, default_branch: "main" }),
		);
		expect(resp.status).toBe(200);
		const poolDir = ((await resp.json()) as { pool_dir: string }).pool_dir;
		expect(poolDir).toBe(path.join(cfg.workspace_root, "_pool", "octo__widget"));
		expect(fs.existsSync(path.join(poolDir, "HEAD")) || fs.existsSync(path.join(poolDir, ".git", "HEAD"))).toBe(true);
	});

	test("clone of a github url passes the scoped token", async () => {
		const captured: Record<string, unknown> = {};
		spyOn(proxyGitOps, "clone").mockImplementation(async (target, options) => {
			captured.target = target;
			Object.assign(captured, options);
		});
		const resp = await signedPost(
			buildApp(buildSettings(tmpPath())),
			"/gh/v1/git/clone",
			'{"repo":"octo/widget","clone_url":"https://github.com/octo/widget","default_branch":"main"}',
		);
		expect(resp.status).toBe(200);
		expect(captured.cloneUrl).toBe("https://github.com/octo/widget.git");
		expect(captured.token).toBe(TOKEN);
		expect(captured.authUrl).toBe("https://github.com/octo/widget.git");
	});

	test("fetch repairs a missing alternate and a bad ref", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const pool = stagePool(cfg, upstream);
		const badRef = path.join(pool, ".git", "refs", "heads", "farm", "bad");
		fs.mkdirSync(path.dirname(badRef), { recursive: true });
		fs.writeFileSync(badRef, "0123456789012345678901234567890123456789\n");
		const alternates = path.join(pool, ".git", "objects", "info", "alternates");
		fs.writeFileSync(alternates, `${path.join(cfg.workspace_root, "missing-objects")}\n`);
		const resp = await signedPost(buildApp(cfg), "/gh/v1/git/fetch", '{"repo":"octo/widget"}');
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as { pool_dir: string }).pool_dir).toBe(pool);
		expect(fs.existsSync(badRef)).toBe(false);
		expect(fs.existsSync(alternates)).toBe(false);
	});

	test("fetch of a github origin uses the explicit scoped remote", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const pool = stagePool(cfg, upstreamRepo(tmp));
		git(["-C", pool, "remote", "set-url", "origin", "https://github.com/octo/widget"], pool);
		const captured: Record<string, unknown> = {};
		spyOn(proxyGitOps, "fetchPrune").mockImplementation(async (p, options) => {
			git(["-C", p, "remote", "set-url", "origin", "ext::sh -c env"], p);
			captured.path = p;
			Object.assign(captured, options);
		});
		const resp = await signedPost(buildApp(cfg), "/gh/v1/git/fetch", '{"repo":"octo/widget"}');
		expect(resp.status).toBe(200);
		expect(captured.path).toBe(pool);
		expect(captured.remoteUrl).toBe("https://github.com/octo/widget.git");
		expect(captured.token).toBe(TOKEN);
		expect(captured.authUrl).toBe("https://github.com/octo/widget.git");
	});

	const pushBody = (branch: string, head: string, extra: Record<string, unknown> = {}) =>
		JSON.stringify({ repo: "octo/widget", workspace_key: "octo__widget__1", branch, expected_head: head, ...extra });

	test("push happy path", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/feature";
		const [, head] = stageWorkspace(cfg, upstream, "octo/widget", 1, branch);
		const resp = await signedPost(buildApp(cfg), "/gh/v1/git/push", pushBody(branch, head));
		expect(resp.status).toBe(200);
		expect(await resp.json()).toEqual({ head, branch });
		expect(bareHasBranch(upstream, branch)).toBe(true);
	});

	test("push passes slot_uid through to git push", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/slot";
		const [repoDir, head] = stageWorkspace(cfg, upstream, "octo/widget", 1, branch);
		if (subprocess.slotPermissionsActive(2001)) {
			Bun.spawnSync(["chown", "-R", "2001:2001", path.dirname(repoDir)]);
			// Traverse bits for the slot on root-owned ancestors.
			let cursor = path.dirname(path.dirname(repoDir));
			while (cursor !== path.dirname(cursor)) {
				const st = fs.statSync(cursor);
				if (!(st.mode & 0o001)) fs.chmodSync(cursor, st.mode | 0o001);
				cursor = path.dirname(cursor);
			}
		}
		const captured: Record<string, unknown> = {};
		spyOn(proxyGitOps, "push").mockImplementation(async (p, options) => {
			captured.path = p;
			Object.assign(captured, options);
			return { head, branch };
		});
		const resp = await signedPost(buildApp(cfg), "/gh/v1/git/push", pushBody(branch, head, { slot_uid: 2001 }));
		expect(resp.status).toBe(200);
		expect(captured.path).toBe(repoDir);
		expect(captured.slotUid).toBe(2001);
	});

	test.each([0, -1, 65536])("push rejects invalid slot_uid %p", async slotUid => {
		const resp = await signedPost(
			buildApp(buildSettings(tmpPath())),
			"/gh/v1/git/push",
			pushBody("x", "0".repeat(40), { slot_uid: slotUid }),
		);
		expect(resp.status).toBe(400);
		expect(await resp.text()).toContain("slot_uid");
	});

	test("push head drift → 409 and nothing pushed", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/drift";
		stageWorkspace(cfg, upstream, "octo/widget", 1, branch);
		const resp = await signedPost(buildApp(cfg), "/gh/v1/git/push", pushBody(branch, "0".repeat(40)));
		expect(resp.status).toBe(409);
		expect(((await resp.json()) as { error: { kind: string } }).error.kind).toBe("head_drift");
		expect(bareHasBranch(upstream, branch)).toBe(false);
	});

	test("push workspace_key mismatch → 400", async () => {
		const resp = await signedPost(
			buildApp(buildSettings(tmpPath())),
			"/gh/v1/git/push",
			JSON.stringify({
				repo: "octo/widget",
				workspace_key: "other__repo__1",
				branch: "x",
				expected_head: "0".repeat(40),
			}),
		);
		expect(resp.status).toBe(400);
		expect(await resp.text()).toContain("workspace_key");
	});

	const releaseBody = (overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			repo: "octo/widget",
			workspace_key: "octo__widget__release",
			branch: "main",
			tag: "v1.2.3",
			expected_head: "0".repeat(40),
			...overrides,
		});

	test("push_release requires HMAC", async () => {
		const resp = await call(buildApp(buildSettings(tmpPath())), "POST", "/gh/v1/git/push_release", {
			body: releaseBody(),
			headers: { "Content-Type": "application/json" },
		});
		expect(resp.status).toBe(401);
	});

	test("push_release rejects workspace_key mismatch", async () => {
		const resp = await signedPost(
			buildApp(buildSettings(tmpPath())),
			"/gh/v1/git/push_release",
			releaseBody({ workspace_key: "other__repo__release" }),
		);
		expect(resp.status).toBe(400);
		expect(await resp.text()).toContain("workspace_key");
	});

	test("push_release rejects invalid tag", async () => {
		const resp = await signedPost(
			buildApp(buildSettings(tmpPath())),
			"/gh/v1/git/push_release",
			releaseBody({ tag: "release/1.2.3" }),
		);
		expect(resp.status).toBe(400);
		expect(await resp.text()).toContain("tag");
	});

	test("push rejects attacker origin", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/evil";
		const [repoDir, head] = stageWorkspace(cfg, upstream, "octo/widget", 1, branch);
		git(["-C", repoDir, "remote", "set-url", "origin", "https://evil.example.com/octo/widget.git"], repoDir);
		expect((await signedPost(buildApp(cfg), "/gh/v1/git/push", pushBody(branch, head))).status).toBe(400);
		expect(bareHasBranch(upstream, branch)).toBe(false);
	});

	test("push rejects origin with wrong repo", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/mismatch";
		const [repoDir, head] = stageWorkspace(cfg, upstream, "octo/widget", 1, branch);
		git(["-C", repoDir, "remote", "set-url", "origin", "https://github.com/attacker/other.git"], repoDir);
		expect((await signedPost(buildApp(cfg), "/gh/v1/git/push", pushBody(branch, head))).status).toBe(400);
		expect(bareHasBranch(upstream, branch)).toBe(false);
	});

	test.each([
		["/gh/v1/git/fetch", '{"repo":"octo/widget"}'],
		["/gh/v1/git/fetch_ref", '{"repo":"octo/widget","ref":"refs/heads/main"}'],
		["/gh/v1/git/fetch_pr_head", '{"repo":"octo/widget","pr_number":1}'],
	])("%s rejects attacker origin", async (endpoint, body) => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const pool = stagePool(cfg, upstreamRepo(tmp));
		git(["-C", pool, "remote", "set-url", "origin", "https://evil.example.com/octo/widget.git"], pool);
		expect((await signedPost(buildApp(cfg), endpoint, body)).status).toBe(400);
	});

	test("fetch rejects ext:: remote helper", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const pool = stagePool(cfg, upstreamRepo(tmp));
		git(["-C", pool, "remote", "set-url", "origin", "ext::sh -c env"], pool);
		expect((await signedPost(buildApp(cfg), "/gh/v1/git/fetch", '{"repo":"octo/widget"}')).status).toBe(400);
	});

	test("fetch rejects option-shaped origin", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const pool = stagePool(cfg, upstream);
		const configPath = path.join(pool, ".git", "config");
		fs.writeFileSync(
			configPath,
			fs.readFileSync(configPath, "utf-8").replace(`\turl = ${upstream}\n`, "\turl = --upload-pack=env\n"),
		);
		expect((await signedPost(buildApp(cfg), "/gh/v1/git/fetch", '{"repo":"octo/widget"}')).status).toBe(400);
	});

	test.each([
		"https://evil.example.com/octo/widget.git",
		"https://github.com/attacker/other.git",
		"https://user:pass@github.com/octo/widget.git",
		"http://github.com/octo/widget.git",
		"https://github.com/octo/widget.git%0dhost=evil.example",
		"ext::sh -c env",
		"--upload-pack=env",
	])("clone rejects unsafe url %p", async cloneUrl => {
		const cfg = buildSettings(tmpPath());
		const resp = await signedPost(
			buildApp(cfg),
			"/gh/v1/git/clone",
			JSON.stringify({ repo: "octo/widget", clone_url: cloneUrl, default_branch: "main" }),
		);
		expect(resp.status).toBe(400);
		expect(fs.existsSync(path.join(cfg.workspace_root, "_pool", "octo__widget"))).toBe(false);
	});

	test("push rejects attacker pushurl", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc/pushurl";
		const [repoDir, head] = stageWorkspace(cfg, upstream, "octo/widget", 1, branch);
		git(
			["-C", repoDir, "remote", "set-url", "--push", "origin", "https://evil.example.com/octo/widget.git"],
			repoDir,
		);
		expect((await signedPost(buildApp(cfg), "/gh/v1/git/push", pushBody(branch, head))).status).toBe(400);
		expect(bareHasBranch(upstream, branch)).toBe(false);
	});

	test.each([
		"refs/heads/x:refs/heads/evil",
		"--upload-pack=env",
		"+refs/heads/*:refs/remotes/origin/x",
		"refs/heads/*",
		"a..b",
		"ref with space",
		"feature/",
	])("fetch_ref rejects injection ref %p", async badRef => {
		const resp = await signedPost(
			buildApp(buildSettings(tmpPath())),
			"/gh/v1/git/fetch_ref",
			JSON.stringify({ repo: "octo/widget", ref: badRef }),
		);
		expect(resp.status).toBe(400);
	});

	test("fetch_ref allows slashy branch name", async () => {
		const tmp = tmpPath();
		const cfg = buildSettings(tmp);
		stagePool(cfg, upstreamRepo(tmp));
		const resp = await signedPost(
			buildApp(cfg),
			"/gh/v1/git/fetch_ref",
			JSON.stringify({ repo: "octo/widget", ref: "contrib/fix-parser" }),
		);
		expect(resp.status).toBe(200);
	});
});
