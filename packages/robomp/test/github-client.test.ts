import { afterEach, expect, test } from "bun:test";
import * as net from "node:net";
import { GitHubClient, GitHubError, TRANSIENT_RETRY_DELAYS } from "../src/github-client";
import { jsonResponse, mockTransport, sendRequest, TooManyRedirectsError, TransportError } from "../src/http";

const originalDelays = TRANSIENT_RETRY_DELAYS.value;
afterEach(() => {
	TRANSIENT_RETRY_DELAYS.value = originalDelays;
});

async function expectGitHubError(promise: Promise<unknown>): Promise<GitHubError> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(GitHubError);
		return err as GitHubError;
	}
	throw new Error("expected GitHubError");
}

test("4xx maps to GitHubError with message", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(() => jsonResponse(404, { message: "Not Found" })),
	});
	const err = await expectGitHubError(client.getRepo("o/r"));
	expect(err.status).toBe(404);
	expect(err.message).toContain("Not Found");
});

test("rate limit retry-after parsed", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(() => jsonResponse(403, { message: "rate limited" }, { "retry-after": "42" })),
	});
	const err = await expectGitHubError(client.getRepo("o/r"));
	expect(err.retry_after).toBe(42);
});

test("redirect to an unreachable target raises GitHubError", async () => {
	const calls: string[] = [];
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			calls.push(request.url);
			if (calls.length === 1) {
				return new Response(null, {
					status: 301,
					headers: { location: "https://api.github.com/repositories/12345" },
				});
			}
			return jsonResponse(410, { message: "Gone" });
		}),
	});
	const err = await expectGitHubError(client.getRepo("old-owner/old-repo"));
	expect([301, 410]).toContain(err.status);
});

test("transient 5xx retries GET but not POST", async () => {
	TRANSIENT_RETRY_DELAYS.value = [0.01, 0.01];
	let getCalls = 0;
	let postCalls = 0;
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			if (request.method === "POST") {
				postCalls++;
				return jsonResponse(500, { message: "boom" });
			}
			getCalls++;
			return getCalls === 1 ? jsonResponse(500, { message: "boom" }) : jsonResponse(200, { ok: true });
		}),
	});
	expect(await client.request("GET", "/x")).toEqual({ ok: true });
	expect(getCalls).toBe(2);
	const err = await expectGitHubError(client.request("POST", "/x", { json: {} }));
	expect(err.status).toBe(500);
	expect(postCalls).toBe(1);
});

test("redirect target succeeds when followable", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			if (new URL(request.url).pathname === "/repos/old/repo") {
				return new Response(null, { status: 301, headers: { location: "https://api.github.com/repos/new/repo" } });
			}
			return jsonResponse(200, {
				full_name: "new/repo",
				default_branch: "main",
				clone_url: "https://github.com/new/repo.git",
				private: false,
			});
		}),
	});
	expect((await client.getRepo("old/repo")).full_name).toBe("new/repo");
});

test("get_pull_request parses head repo and author", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			expect(new URL(request.url).pathname).toBe("/repos/octo/widget/pulls/9");
			return jsonResponse(200, {
				number: 9,
				html_url: "https://github.com/octo/widget/pull/9",
				head: {
					ref: "farm/abc12345/fix",
					sha: "abc1234567890123456789012345678901234567",
					repo: { full_name: "octo/widget" },
				},
				base: { ref: "main" },
				state: "open",
				user: { login: "robomp-bot" },
			});
		}),
	});
	const pr = await client.getPullRequest("octo/widget", 9);
	expect(pr.head_ref).toBe("farm/abc12345/fix");
	expect(pr.head_sha).toBe("abc1234567890123456789012345678901234567");
	expect(pr.head_repo).toBe("octo/widget");
	expect(pr.author).toBe("robomp-bot");
});

test("get_pull_request parses title and body", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			expect(new URL(request.url).pathname).toBe("/repos/octo/widget/pulls/9");
			return jsonResponse(200, {
				number: 9,
				html_url: "https://github.com/octo/widget/pull/9",
				title: "Fix crash",
				body: "Fixes #1",
				head: { ref: "fix", repo: { full_name: "fork/widget" } },
				base: { ref: "main" },
				state: "open",
				user: { login: "alice" },
			});
		}),
	});
	const pr = await client.getPullRequest("octo/widget", 9);
	expect(pr.title).toBe("Fix crash");
	expect(pr.body).toBe("Fixes #1");
});

test("list_pr_files parses changed file summary", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			const url = new URL(request.url);
			expect(url.pathname).toBe("/repos/octo/widget/pulls/9/files");
			expect(url.searchParams.get("per_page")).toBe("100");
			return jsonResponse(200, [
				{
					filename: "src/app.py",
					status: "modified",
					additions: 5,
					deletions: 2,
					patch: "@@ -8,3 +8,5 @@\n ctx\n+added\n ctx2",
				},
			]);
		}),
	});
	const files = await client.listPrFiles("octo/widget", 9);
	expect(files).toHaveLength(1);
	expect(files[0]!.path).toBe("src/app.py");
	expect(files[0]!.additions).toBe(5);
	expect(files[0]!.deletions).toBe(2);
	expect(files[0]!.patch.startsWith("@@ -8,3 +8,5")).toBe(true);
});

test("list_pr_files defaults missing patch to empty", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			expect(new URL(request.url).pathname).toBe("/repos/octo/widget/pulls/9/files");
			return jsonResponse(200, [{ filename: "src/app.py", status: "modified", additions: 5, deletions: 2 }]);
		}),
	});
	expect((await client.listPrFiles("octo/widget", 9))[0]!.patch).toBe("");
});

test("list_pr_files paginates past first page", async () => {
	const seenPages: (string | null)[] = [];
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			const url = new URL(request.url);
			expect(url.pathname).toBe("/repos/octo/widget/pulls/9/files");
			const page = url.searchParams.get("page");
			seenPages.push(page);
			if (page === "1") {
				return jsonResponse(
					200,
					Array.from({ length: 100 }, (_, idx) => ({
						filename: `src/file-${idx}.py`,
						status: "modified",
						additions: 1,
						deletions: 0,
					})),
				);
			}
			expect(page).toBe("2");
			return jsonResponse(200, [{ filename: "src/final.py", status: "added", additions: 2, deletions: 0 }]);
		}),
	});
	const files = await client.listPrFiles("octo/widget", 9);
	expect(seenPages).toEqual(["1", "2"]);
	expect(files).toHaveLength(101);
	expect(files.at(-1)!.path).toBe("src/final.py");
});

const reviewResponse = {
	id: 44,
	user: { login: "robomp-bot" },
	body: "summary",
	state: "COMMENTED",
	submitted_at: "t",
};

test("submit_pr_review posts COMMENT event and inline comments", async () => {
	const captured: { path?: string; body?: unknown } = {};
	const client = new GitHubClient("tok", {
		transport: mockTransport(async request => {
			captured.path = new URL(request.url).pathname;
			captured.body = await request.json();
			return jsonResponse(200, reviewResponse);
		}),
	});
	const review = await client.submitPrReview({
		repo: "octo/widget",
		pr_number: 9,
		body: "summary",
		event: "COMMENT",
		comments: [{ path: "src/app.py", line: 12, side: "RIGHT", body: "finding" }],
	});
	expect(review.id).toBe(44);
	expect(captured.path).toBe("/repos/octo/widget/pulls/9/reviews");
	expect(captured.body).toEqual({
		body: "summary",
		event: "COMMENT",
		comments: [{ path: "src/app.py", line: 12, side: "RIGHT", body: "finding" }],
	});
});

test("submit_pr_review on forgejo uses position payload", async () => {
	const captured: { path?: string; body?: unknown } = {};
	const client = new GitHubClient("tok", {
		platform: "forgejo",
		transport: mockTransport(async request => {
			captured.path = new URL(request.url).pathname;
			captured.body = await request.json();
			return jsonResponse(200, reviewResponse);
		}),
	});
	const review = await client.submitPrReview({
		repo: "octo/widget",
		pr_number: 9,
		body: "summary",
		event: "COMMENT",
		comments: [
			{ path: "src/app.py", line: 12, side: "RIGHT", body: "finding" },
			{ path: "src/old.py", line: 5, side: "LEFT", body: "removed-line finding" },
		],
	});
	expect(review.id).toBe(44);
	expect(captured.path).toBe("/repos/octo/widget/pulls/9/reviews");
	expect(captured.body).toEqual({
		body: "summary",
		event: "COMMENT",
		comments: [
			{ path: "src/app.py", body: "finding", new_position: 12 },
			{ path: "src/old.py", body: "removed-line finding", old_position: 5 },
		],
	});
});

test("204 no content returns none", async () => {
	let calls = 0;
	const client = new GitHubClient("tok", {
		transport: mockTransport(() => {
			calls++;
			return new Response(null, { status: 204 });
		}),
	});
	// addAssignees with an empty list short-circuits without a request; pass one to force the call.
	expect(await client.addAssignees("o/r", 1, ["alice"])).toBeUndefined();
	expect(calls).toBe(1);
});

test("list_closing_pull_requests filters disconnected and closed", async () => {
	const captured: { path?: string; perPage?: string | null } = {};
	const timeline = [
		{ event: "connected", source: { issue: { number: 100, state: "open", pull_request: { url: "..." } } } },
		{ event: "connected", source: { issue: { number: 200, state: "open", pull_request: { url: "..." } } } },
		{ event: "disconnected", source: { issue: { number: 200, state: "open", pull_request: { url: "..." } } } },
		{ event: "connected", source: { issue: { number: 300, state: "closed", pull_request: { url: "..." } } } },
		{ event: "cross-referenced", source: { issue: { number: 400, state: "open", pull_request: { url: "..." } } } },
		{ event: "connected", source: { issue: { number: 500, state: "open" } } },
		{ event: "labeled", label: { name: "bug" } },
	];
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			const url = new URL(request.url);
			captured.path = url.pathname;
			captured.perPage = url.searchParams.get("per_page");
			return jsonResponse(200, timeline);
		}),
	});
	expect(await client.listClosingPullRequests("octo/widget", 42)).toEqual([100]);
	expect(captured.path).toBe("/repos/octo/widget/issues/42/timeline");
	expect(captured.perPage).toBe("100");
});

test("list_closing_pull_requests empty timeline", async () => {
	const client = new GitHubClient("tok", { transport: mockTransport(() => jsonResponse(200, [])) });
	expect(await client.listClosingPullRequests("octo/widget", 7)).toEqual([]);
});

test("list_comment_reactions filters to thumbs down", async () => {
	const captured: Record<string, string | null> = {};
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			const url = new URL(request.url);
			captured.path = url.pathname;
			captured.content = url.searchParams.get("content");
			captured.per_page = url.searchParams.get("per_page");
			return jsonResponse(200, [
				{ content: "-1", user: { login: "Alice", type: "User" } },
				{ content: "-1", user: { login: "rando", type: "User" } },
			]);
		}),
	});
	const reactions = await client.listCommentReactions("octo/widget", 999);
	expect(captured).toEqual({
		path: "/repos/octo/widget/issues/comments/999/reactions",
		content: "-1",
		per_page: "100",
	});
	expect(reactions.map(r => r.user_login)).toEqual(["Alice", "rando"]);
	expect(reactions.every(r => r.content === "-1")).toBe(true);
});

test("close_issue sends completed state_reason", async () => {
	const captured: { method?: string; path?: string; body?: unknown } = {};
	const client = new GitHubClient("tok", {
		transport: mockTransport(async request => {
			captured.method = request.method;
			captured.path = new URL(request.url).pathname;
			captured.body = await request.json();
			return jsonResponse(200, {});
		}),
	});
	expect(await client.closeIssue("octo/widget", 42)).toBeUndefined();
	expect(captured).toEqual({
		method: "PATCH",
		path: "/repos/octo/widget/issues/42",
		body: { state: "closed", state_reason: "completed" },
	});
});

test("close_issue propagates error", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(() => jsonResponse(404, { message: "Not Found" })),
	});
	expect((await expectGitHubError(client.closeIssue("octo/widget", 42))).status).toBe(404);
});

test("release action reads parse runs, jobs and failed steps", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			const url = new URL(request.url);
			if (url.pathname === "/repos/octo/widget/actions/runs") {
				expect(url.searchParams.get("head_sha")).toBe("abc");
				expect(url.searchParams.get("per_page")).toBe("100");
				return jsonResponse(200, {
					workflow_runs: [
						{
							id: 10,
							name: "CI",
							event: "push",
							status: "completed",
							conclusion: "failure",
							head_branch: "main",
							head_sha: "abc",
							html_url: "https://example/runs/10",
							run_attempt: 2,
						},
					],
				});
			}
			expect(url.pathname).toBe("/repos/octo/widget/actions/runs/10/jobs");
			expect(url.searchParams.get("filter")).toBe("latest");
			return jsonResponse(200, {
				jobs: [
					{
						id: 20,
						run_id: 10,
						name: "test",
						status: "completed",
						conclusion: "failure",
						html_url: "https://example/jobs/20",
						steps: [
							{ name: "checkout", conclusion: "success" },
							{ name: "tests", conclusion: "failure" },
							{ name: "cleanup", conclusion: "skipped" },
						],
					},
				],
			});
		}),
	});
	const runs = await client.listWorkflowRuns("octo/widget", "abc");
	const jobs = await client.listWorkflowJobs("octo/widget", runs[0]!.id);
	expect(runs[0]!.run_attempt).toBe(2);
	expect(runs[0]!.head_sha).toBe("abc");
	expect(jobs[0]!.failed_steps).toEqual(["tests"]);
});

test("job log tail follows redirect and caps retained bytes", async () => {
	const payload = `discard\n${"x".repeat(4 * 1024 * 1024)}\nlast\n`;
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/logs")) {
				return new Response(null, { status: 302, headers: { location: "https://logs.example/job.txt" } });
			}
			expect(url.host).toBe("logs.example");
			return new Response(payload, { status: 200 });
		}),
	});
	const tail = await client.getJobLogTail("octo/widget", 20, 2);
	expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4 * 1024 * 1024);
	expect(tail.endsWith("\nlast")).toBe(true);
	expect(tail).not.toContain("discard");
});

test("tag dereference and release metadata", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			const pathname = new URL(request.url).pathname;
			if (pathname.endsWith("/git/ref/tags/v1.2.3"))
				return jsonResponse(200, { object: { type: "tag", sha: "tag-object" } });
			if (pathname.endsWith("/git/tags/tag-object"))
				return jsonResponse(200, { object: { type: "commit", sha: "commit-sha" } });
			expect(pathname.endsWith("/releases/tags/v1.2.3")).toBe(true);
			return jsonResponse(200, {
				tag_name: "v1.2.3",
				name: "1.2.3",
				draft: false,
				prerelease: false,
				html_url: "https://example/releases/v1.2.3",
				assets: [{ name: "omp-darwin-arm64.tar.gz" }],
			});
		}),
	});
	expect(await client.getTagSha("octo/widget", "v1.2.3")).toBe("commit-sha");
	const release = await client.getReleaseByTag("octo/widget", "v1.2.3");
	expect(release?.asset_names).toEqual(["omp-darwin-arm64.tar.gz"]);
});

test("missing tag and release return null", async () => {
	const client = new GitHubClient("tok", {
		transport: mockTransport(() => jsonResponse(404, { message: "Not Found" })),
	});
	expect(await client.getTagSha("octo/widget", "v1.2.3")).toBeNull();
	expect(await client.getReleaseByTag("octo/widget", "v1.2.3")).toBeNull();
});

// ---- transport parity with httpx (redirect credentials, retry classes, limits) ----

test("redirect drops Authorization cross-origin but keeps it same-origin and on https upgrade", async () => {
	const seen: Record<string, string | null> = {};
	const client = new GitHubClient("tok", {
		baseUrl: "http://api.github.com",
		transport: mockTransport(request => {
			const url = new URL(request.url);
			seen[`${url.protocol}//${url.host}${url.pathname}`] = request.headers.get("authorization");
			if (url.pathname.endsWith("/logs")) {
				return new Response(null, { status: 302, headers: { location: "https://blob.example/job.txt" } });
			}
			if (url.protocol === "http:") {
				return new Response(null, { status: 301, headers: { location: "https://api.github.com/repos/new/repo" } });
			}
			if (url.pathname === "/repos/new/repo") {
				return new Response(null, { status: 301, headers: { location: "/repos/newer/repo" } });
			}
			if (url.host === "blob.example") return new Response("log line", { status: 200 });
			return jsonResponse(200, {
				full_name: "newer/repo",
				default_branch: "main",
				clone_url: "https://github.com/newer/repo.git",
				private: false,
			});
		}),
	});
	expect((await client.getRepo("old/repo")).full_name).toBe("newer/repo");
	expect(await client.getJobLogTail("octo/widget", 20, 1)).toBe("log line");
	expect(seen).toEqual({
		"http://api.github.com/repos/old/repo": "Bearer tok",
		"https://api.github.com/repos/new/repo": "Bearer tok",
		"https://api.github.com/repos/newer/repo": "Bearer tok",
		"http://api.github.com/repos/octo/widget/actions/jobs/20/logs": "Bearer tok",
		"https://blob.example/job.txt": null,
	});
});

async function listen(onSocket: (socket: net.Socket) => void): Promise<{ port: number; close: () => void }> {
	const server = net.createServer(onSocket);
	const { promise, resolve } = Promise.withResolvers<number>();
	server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
	const port = await promise;
	return { port, close: () => server.close() };
}

test("connection refused is retried (httpx ConnectError), even for POST", async () => {
	TRANSIENT_RETRY_DELAYS.value = [0.01, 0.01];
	const closed = await listen(() => {});
	closed.close();
	let calls = 0;
	const client = new GitHubClient("tok", {
		transport: mockTransport(async request => {
			calls++;
			// First attempt hits a closed port through real fetch: Bun's own refusal error shape.
			if (calls === 1) return fetch(`http://127.0.0.1:${closed.port}/`, { method: request.method });
			return jsonResponse(201, { id: 1, user: { login: "bot" }, body: "hi", created_at: "t" });
		}),
	});
	expect((await client.postComment("octo/widget", 1, "hi")).id).toBe(1);
	expect(calls).toBe(2);
});

test("connection reset after send is not retried (httpx ReadError propagates)", async () => {
	TRANSIENT_RETRY_DELAYS.value = [0.01, 0.01];
	const server = await listen(socket => socket.once("data", () => socket.destroy()));
	let calls = 0;
	const client = new GitHubClient("tok", {
		baseUrl: `http://127.0.0.1:${server.port}`,
		transport: mockTransport(request => {
			calls++;
			return fetch(request, { redirect: "manual" });
		}),
	});
	try {
		const err = await client.postComment("octo/widget", 1, "hi").then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(TransportError);
		expect(err).not.toBeInstanceOf(GitHubError);
		expect(calls).toBe(1);
	} finally {
		server.close();
	}
});

test("stalled response body raises a retryable read timeout", async () => {
	const stalled = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("partial"));
		},
	});
	const resp = await sendRequest(
		mockTransport(() => new Response(stalled, { status: 200 })),
		"https://api.github.com",
		{ method: "GET", url: "/logs", timeoutMs: 50 },
	);
	const err = await resp.text().then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(TransportError);
	expect((err as TransportError).kind).toBe("timeout");
});

test("more than 20 redirects raises TooManyRedirects without retrying", async () => {
	let calls = 0;
	const client = new GitHubClient("tok", {
		transport: mockTransport(() => {
			calls++;
			return new Response(null, { status: 302, headers: { location: "https://api.github.com/repos/o/r" } });
		}),
	});
	await expect(client.getRepo("o/r")).rejects.toBeInstanceOf(TooManyRedirectsError);
	expect(calls).toBe(21);
});

test("path segments are escaped like quote(safe='')", async () => {
	const urls: string[] = [];
	const client = new GitHubClient("tok", {
		transport: mockTransport(request => {
			urls.push(request.url);
			return new Response(null, { status: 204 });
		}),
	});
	await client.removeIssueLabel("octo/widget", 3, "won't fix (maybe)*!/~");
	expect(urls).toEqual([
		"https://api.github.com/repos/octo/widget/issues/3/labels/won%27t%20fix%20%28maybe%29%2A%21%2F~",
	]);
});
