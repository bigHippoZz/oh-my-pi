/** End-to-end coverage for the HTTP surface: dashboard + JSON APIs (port of test_server.py). */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../src/config";
import { tailJsonl } from "../src/dashboard";
import { closeDatabase, type Database, getDatabase, issueKey } from "../src/db";
import type { GitHubBackend } from "../src/github-backend";
import {
	GitHubError,
	type IssueInfo,
	type PullRequestInfo,
	pullRequestInfo,
	type RepoInfo,
	TRANSIENT_RETRY_DELAYS,
} from "../src/github-client";
import { jsonResponse, mockTransport } from "../src/http";
import { awaitTerminalState, InvalidIssueRef, ManualTriageTimeout, parseIssueRef } from "../src/manual-triage";
import { type EnsureWorkspaceArgs, LocalGitTransport, type SandboxManager, type Workspace } from "../src/sandbox";
import { createApp } from "../src/server";
import * as tasks from "../src/tasks";
import type { RunTaskArgs } from "../src/worker";
import { makeDb, makeSettings, tmpPath } from "./helpers";
import {
	type Client,
	ensureDashboardBundle,
	installGithubMock,
	PausedPoolFactory,
	postWebhook,
	withClient,
} from "./server-helpers";

const restores: (() => void)[] = [];
beforeEach(() => {
	ensureDashboardBundle();
});
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

const TOKEN = "trigger-secret";
const ORIGINAL_RETRY_DELAYS = TRANSIENT_RETRY_DELAYS.value;

function replaySettings(overrides: Record<string, string> = {}): Settings {
	return makeSettings({ ROBOMP_REPLAY_TOKEN: TOKEN, ...overrides });
}

const auth = { "X-Robomp-Replay-Token": TOKEN };

test("createApp runs the injected pool lifecycle", async () => {
	const factory = new PausedPoolFactory();
	const settings = makeSettings();
	const server = createApp(settings, { poolFactory: factory.create });
	await server.start();
	expect(factory.pools).toHaveLength(1);
	const pool = factory.pools[0]!;
	expect(pool.started).toBe(true);
	expect(pool.stopped).toBe(false);
	await server.stop();
	closeDatabase();
	expect(pool.stopped).toBe(true);
});

function seedDb(db: Database): void {
	db.recordEvent({
		delivery_id: "d-queued",
		event_type: "issues",
		repo: "octo/widget",
		issue_key: issueKey("octo/widget", 1),
		payload: { action: "opened", issue: { number: 1 } },
	});
	db.recordEvent({
		delivery_id: "d-skipped",
		event_type: "issues",
		repo: "octo/widget",
		issue_key: issueKey("octo/widget", 2),
		payload: { action: "labeled" },
		state: "skipped",
	});
	db.recordEvent({
		delivery_id: "d-running",
		event_type: "issue_comment",
		repo: "octo/widget",
		issue_key: issueKey("octo/widget", 3),
		payload: { action: "created" },
	});
	expect(db.claimNextEvent()).not.toBeNull();
	db.upsertIssue({
		key: issueKey("octo/widget", 3),
		repo: "octo/widget",
		number: 3,
		state: "opened",
		branch: "farm/abc12345/fix",
		pr_number: 42,
	});
	db.setIssueClassification(issueKey("octo/widget", 3), "bug");
	const release = db.upsertRelease({
		repo: "octo/widget",
		tag: "v1.2.3",
		version: "1.2.3",
		current_sha: "a".repeat(40),
		session_dir: "/tmp/release-session",
	});
	db.bumpReleaseRound(release.key, release.current_sha);
}

test("index serves dashboard html", async () => {
	await withClient(makeSettings(), async client => {
		const resp = await client.get("/");
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")?.startsWith("text/html")).toBe(true);
		// Stable anchors only; the sentinel must have been substituted.
		expect(resp.text).toContain("<title>robomp</title>");
		expect(resp.text).toContain('id="app"');
		expect(resp.text).toContain('id="robomp-config"');
		expect(resp.text).not.toContain("__ROBOMP_CONFIG__");
		expect(resp.text).toContain('"replayEnabled":');
	});
});

test("index substitutes the replay token", async () => {
	await withClient(makeSettings({ ROBOMP_REPLAY_TOKEN: "secret-token-7" }), async client => {
		const resp = await client.get("/");
		expect(resp.status).toBe(200);
		expect(resp.text).toContain('"replayEnabled":true');
		expect(resp.text).toContain('"replayToken":"secret-token-7"');
	});
});

test("/api/status reports runtime, counts and inflight", async () => {
	const settings = makeSettings();
	await withClient(settings, async (client, _server, db) => {
		seedDb(db);
		const resp = await client.get("/api/status");
		expect(resp.status).toBe(200);
		const body = resp.json();
		const runtime = body.runtime;
		expect(runtime.bot_login).toBe("robomp-bot");
		expect(runtime.repo_allowlist).toEqual(["octo/widget"]);
		expect(runtime.max_concurrency).toBe(settings.max_concurrency);
		expect(runtime.model).toBe(settings.model);
		expect(runtime.uptime_seconds).toBeGreaterThanOrEqual(0);
		const counts = body.event_counts;
		// All five buckets must be present even when zero — the UI relies on it.
		expect(Object.keys(counts).sort()).toEqual(["done", "failed", "queued", "running", "skipped"]);
		expect(counts.queued + counts.running).toBe(2);
		expect(counts.skipped).toBe(1);
		expect(counts.running).toBeGreaterThanOrEqual(1);
		expect(body.running_events.length).toBeGreaterThan(0);
		for (const r of body.running_events) expect(r.started_at).toBeTruthy();
		expect(Array.isArray(body.inflight)).toBe(true);
		const issues = Object.fromEntries(body.issues.map((i: { key: string }) => [i.key, i]));
		const fixKey = issueKey("octo/widget", 3);
		expect(issues[fixKey].classification).toBe("bug");
		expect(issues[fixKey].pr_number).toBe(42);
		expect(issues[fixKey].branch).toBe("farm/abc12345/fix");
		const releases = Object.fromEntries(body.releases.map((r: { key: string }) => [r.key, r]));
		expect(releases["octo/widget#v1.2.3"].state).toBe("fixing");
		expect(releases["octo/widget#v1.2.3"].rounds).toBe(1);
		expect(releases["octo/widget#v1.2.3"].current_sha).toBe("a".repeat(40));
		const deliveryIds = new Set(body.recent_events.map((e: { delivery_id: string }) => e.delivery_id));
		for (const id of ["d-queued", "d-skipped", "d-running"]) expect(deliveryIds.has(id)).toBe(true);
	});
});

test("/releases returns recent release state", async () => {
	await withClient(makeSettings(), async (client, _server, db) => {
		const row = db.upsertRelease({
			repo: "octo/widget",
			tag: "v2.0.0",
			version: "2.0.0",
			current_sha: "b".repeat(40),
			session_dir: "/tmp/release-v2",
		});
		db.setReleaseState(row.key, "failed", "CI green but GitHub Release missing/draft");
		const updated = db.getRelease(row.key)!;
		const resp = await client.get("/releases?limit=1");
		expect(resp.status).toBe(200);
		expect(resp.json()).toEqual({
			releases: [
				{
					key: "octo/widget#v2.0.0",
					repo: "octo/widget",
					tag: "v2.0.0",
					version: "2.0.0",
					state: "failed",
					current_sha: "b".repeat(40),
					last_failed_sha: null,
					rounds: 0,
					last_error: "CI green but GitHub Release missing/draft",
					session_dir: "/tmp/release-v2",
					created_at: updated.created_at,
					updated_at: updated.updated_at,
				},
			],
		});
	});
});

test("/api/status reports the current issue event state", async () => {
	const fixed = issueKey("octo/widget", 44);
	const failed = issueKey("octo/widget", 69);
	await withClient(makeSettings(), async (client, _server, db) => {
		db.upsertIssue({ key: fixed, repo: "octo/widget", number: 44, state: "closed", pr_number: 1084 });
		db.upsertIssue({ key: failed, repo: "octo/widget", number: 69, state: "reproducing" });
		const rec = (
			delivery_id: string,
			issue_key: string,
			action: string,
			state: "failed" | "done" | "skipped",
			last_error?: string,
		) =>
			db.recordEvent({
				delivery_id,
				event_type: "issues",
				repo: "octo/widget",
				issue_key,
				payload: { action },
				state,
				last_error,
			});
		rec("fixed-old-failure", fixed, "opened", "failed");
		rec("fixed-later-success", fixed, "closed", "done");
		rec("still-failed", failed, "opened", "failed");
		rec("failed-label-noise", failed, "labeled", "skipped", "issues.labeled ignored");
		const body = (await client.get("/api/status")).json();
		expect(body.event_counts.failed).toBe(2);
		expect(body.issue_event_counts.failed).toBe(1);
		expect(body.issue_event_counts.done).toBe(1);
		expect(body.issue_event_counts.skipped).toBe(0);
		const issues = Object.fromEntries(body.issues.map((i: { key: string }) => [i.key, i]));
		expect(issues[fixed].latest_event.delivery_id).toBe("fixed-later-success");
		expect(issues[fixed].latest_event.state).toBe("done");
		expect(issues[failed].latest_event.delivery_id).toBe("still-failed");
		expect(issues[failed].latest_event.state).toBe("failed");
	});
});

test("/api/logs returns empty when the file is missing", async () => {
	await withClient(makeSettings(), async client => {
		const resp = await client.get("/api/logs?limit=10");
		expect(resp.status).toBe(200);
		expect(resp.json()).toEqual({ entries: [], count: 0, limit: 10 });
	});
});

test("/api/logs tails the jsonl file", async () => {
	const settings = makeSettings();
	const logPath = path.join(settings.log_dir, "robomp.log.jsonl");
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const payloads = [
		{ ts: "2026-05-14T21:28:28Z", level: "INFO", logger: "robomp.queue", msg: "dispatch loop online" },
		{
			ts: "2026-05-14T21:28:54Z",
			level: "INFO",
			logger: "robomp.server",
			msg: "skip",
			event: "issues",
			reason: "issues.labeled ignored",
		},
		{ ts: "2026-05-14T21:30:00Z", level: "WARNING", logger: "robomp.queue", msg: "tool_end", ok: false },
	];
	fs.writeFileSync(logPath, `${payloads.map(p => JSON.stringify(p)).join("\n")}\n`);
	await withClient(settings, async client => {
		const body = (await client.get("/api/logs?limit=2")).json();
		expect(body.count).toBe(2);
		expect(body.limit).toBe(2);
		// Oldest of the requested window first.
		expect(body.entries[0].msg).toBe("skip");
		expect(body.entries[1].msg).toBe("tool_end");
		expect(body.entries[1].level).toBe("WARNING");
	});
});

test("/api/logs limit is clamped", async () => {
	await withClient(makeSettings(), async client => {
		expect((await client.get("/api/logs?limit=0")).json().limit).toBe(1);
		expect((await client.get("/api/logs?limit=99999")).json().limit).toBe(2000);
	});
});

test("tailJsonl recovers from garbage lines", () => {
	const file = path.join(tmpPath(), "noisy.jsonl");
	fs.writeFileSync(
		file,
		`${JSON.stringify({ ts: "a", level: "INFO", msg: "ok" })}\n{not json}\n${JSON.stringify({ ts: "b", level: "ERROR", msg: "bang" })}\n`,
	);
	const rows = tailJsonl(file, 10);
	expect(rows).toHaveLength(3);
	expect(rows[0]!.msg).toBe("ok");
	expect(rows[1]!.level).toBe("RAW");
	expect(rows[1]!.msg).toBe("{not json}");
	expect(rows[2]!.level).toBe("ERROR");
});

// ---------- manual_triage helpers ----------

test("parseIssueRef accepts owner/repo#number", () => {
	expect(parseIssueRef("octo/widget#42")).toEqual(["octo/widget", 42]);
	expect(parseIssueRef("  octo/widget#42  ")).toEqual(["octo/widget", 42]);
});

test("parseIssueRef accepts GitHub issue urls", () => {
	for (const ref of [
		"https://github.com/can1357/oh-my-pi/issues/1348",
		"http://github.com/can1357/oh-my-pi/issues/1348",
		"github.com/can1357/oh-my-pi/issues/1348",
		"https://www.github.com/can1357/oh-my-pi/issues/1348",
		"https://github.com/can1357/oh-my-pi/issues/1348/",
		"https://github.com/can1357/oh-my-pi/issues/1348?foo=bar",
		"https://github.com/can1357/oh-my-pi/issues/1348#issuecomment-99",
		"  https://github.com/can1357/oh-my-pi/issues/1348  ",
	]) {
		expect(parseIssueRef(ref)).toEqual(["can1357/oh-my-pi", 1348]);
	}
});

test("parseIssueRef rejects garbage", () => {
	for (const bad of [
		"widget#1",
		"octo/widget",
		"octo/widget#abc",
		"octo widget#1",
		"",
		"https://github.com/octo/widget/pull/1",
		"https://github.com/octo/widget/issues/",
		"https://gitlab.com/octo/widget/issues/1",
	]) {
		expect(() => parseIssueRef(bad)).toThrow(InvalidIssueRef);
	}
});

test("awaitTerminalState times out with the current state", async () => {
	const db = makeDb();
	db.recordEvent({
		delivery_id: "d-wait",
		event_type: "issues",
		repo: "octo/widget",
		issue_key: issueKey("octo/widget", 42),
		payload: { action: "opened" },
	});
	try {
		await awaitTerminalState(db, "d-wait", { pollInterval: 0.001, timeout: 0.001 });
		throw new Error("expected timeout");
	} catch (err) {
		expect(err).toBeInstanceOf(ManualTriageTimeout);
		expect((err as ManualTriageTimeout).deliveryId).toBe("d-wait");
		expect((err as ManualTriageTimeout).state).toBe("queued");
	}
});

// ---------- /api/trigger ----------

function issuePayload(number: number, extra: Record<string, unknown> = {}) {
	return {
		number,
		title: "boom",
		body: "details here",
		state: "open",
		user: { login: "alice" },
		labels: [{ name: "bug" }],
		...extra,
	};
}

const REPO_PAYLOAD = {
	full_name: "octo/widget",
	default_branch: "main",
	clone_url: "https://github.com/octo/widget.git",
	private: false,
};

function issueAndRepoTransport(captured: string[], issue: Record<string, unknown>) {
	return mockTransport(request => {
		const p = new URL(request.url).pathname;
		captured.push(p);
		if (p.endsWith("/issues/7")) return jsonResponse(200, issue);
		if (p.endsWith("/repos/octo/widget")) return jsonResponse(200, REPO_PAYLOAD);
		return new Response(null, { status: 404 });
	});
}

function trigger(client: Client, json: unknown) {
	return client.post("/api/trigger", { json, headers: auth });
}

test("trigger returns 404 when the token is disabled", async () => {
	await withClient(makeSettings(), async client => {
		const resp = await client.post("/api/trigger", { json: { mode: "triage", issue: "octo/widget#1" } });
		expect(resp.status).toBe(404);
		expect(resp.json().detail).toContain("trigger disabled");
	});
});

test("trigger rejects a missing token", async () => {
	await withClient(replaySettings(), async client => {
		const resp = await client.post("/api/trigger", { json: { mode: "triage", issue: "octo/widget#1" } });
		expect(resp.status).toBe(401);
	});
});

test("trigger triage fetches and enqueues", async () => {
	const captured: string[] = [];
	await withClient(replaySettings(), async (client, server) => {
		installGithubMock(server, issueAndRepoTransport(captured, issuePayload(7)));
		const resp = await trigger(client, { mode: "triage", issue: "octo/widget#7" });
		expect(resp.status).toBe(202);
		const body = resp.json();
		expect(body.mode).toBe("triage");
		expect(body.state).toBe("queued");
		expect(body.delivery).toBe("manual-octo__widget-7");
	});
	expect(captured.some(p => p.endsWith("/issues/7"))).toBe(true);
	expect(captured.some(p => p.endsWith("/repos/octo/widget"))).toBe(true);
});

for (const state of ["queued", "running"] as const) {
	test(`trigger triage conflicts when the manual delivery is ${state}`, async () => {
		const delivery = "manual-octo__widget-7";
		const originalPayload = { action: "opened", issue: { number: 7, title: "old" } };
		const calls: string[] = [];
		await withClient(replaySettings(), async (client, server, db) => {
			db.recordEvent({
				delivery_id: delivery,
				event_type: "issues",
				repo: "octo/widget",
				issue_key: issueKey("octo/widget", 7),
				payload: originalPayload,
				state,
			});
			installGithubMock(
				server,
				mockTransport(request => {
					calls.push(new URL(request.url).pathname);
					return jsonResponse(500, { message: "should not fetch active manual event" });
				}),
			);
			const resp = await trigger(client, { mode: "triage", issue: "octo/widget#7" });
			expect(resp.status).toBe(409);
			const row = db.getEvent(delivery);
			expect(row?.state).toBe(state);
			expect(row?.payload).toEqual(originalPayload);
		});
		expect(calls).toEqual([]);
	});
}

for (const state of ["done", "failed", "skipped"] as const) {
	test(`trigger triage replaces an inactive (${state}) manual delivery`, async () => {
		const delivery = "manual-octo__widget-7";
		await withClient(replaySettings(), async (client, server, db) => {
			db.recordEvent({
				delivery_id: "running-octo__widget-7",
				event_type: "issue_comment",
				repo: "octo/widget",
				issue_key: issueKey("octo/widget", 7),
				payload: { action: "created" },
			});
			expect(db.claimNextEvent()?.delivery_id).toBe("running-octo__widget-7");
			db.recordEvent({
				delivery_id: delivery,
				event_type: "issues",
				repo: "octo/widget",
				issue_key: issueKey("octo/widget", 7),
				payload: { action: "opened", issue: { number: 7, title: "old" } },
				state,
			});
			installGithubMock(server, issueAndRepoTransport([], issuePayload(7, { title: "fresh", body: "new details" })));
			const resp = await trigger(client, { mode: "triage", issue: "octo/widget#7" });
			expect(resp.status).toBe(202);
			const row = db.getEvent(delivery);
			expect(row?.state).toBe("queued");
			expect(row?.attempts).toBe(0);
			expect(row?.payload.issue.title).toBe("fresh");
		});
	});
}

test("trigger triage rejects a pull-request issue payload", async () => {
	const captured: string[] = [];
	await withClient(replaySettings(), async (client, server, db) => {
		const pr = issuePayload(7, {
			title: "change",
			pull_request: { url: "https://api.github.com/repos/octo/widget/pulls/7" },
		});
		installGithubMock(server, issueAndRepoTransport(captured, pr));
		const resp = await trigger(client, { mode: "triage", issue: "octo/widget#7" });
		expect(db.getEvent("manual-octo__widget-7")).toBeNull();
		expect(resp.status).toBe(400);
		expect(resp.json().detail).toContain("pull request");
	});
	expect(captured.some(p => p.endsWith("/issues/7"))).toBe(true);
	expect(captured.some(p => p.endsWith("/repos/octo/widget"))).toBe(false);
});

test("trigger triage rejects a repo not in the allowlist", async () => {
	await withClient(replaySettings(), async (client, server) => {
		installGithubMock(
			server,
			mockTransport(() => new Response(null, { status: 500 })),
		);
		const resp = await trigger(client, { mode: "triage", issue: "evil/repo#1" });
		expect(resp.status).toBe(403);
		expect(resp.json().detail).toContain("ROBOMP_REPO_ALLOWLIST");
	});
});

for (const state of ["queued", "running"] as const) {
	test(`trigger retry by delivery rejects ${state} events`, async () => {
		await withClient(replaySettings(), async (client, _server, db) => {
			db.recordEvent({
				delivery_id: `d-${state}`,
				event_type: "issues",
				repo: "octo/widget",
				issue_key: issueKey("octo/widget", 5),
				payload: { action: "opened", issue: { number: 5 } },
				state,
			});
			const resp = await trigger(client, { mode: "retry", delivery_id: `d-${state}` });
			expect(resp.status).toBe(409);
			expect(resp.json().detail).toContain(state);
			expect(db.getEvent(`d-${state}`)?.state).toBe(state);
		});
	});
}

test("trigger triage surfaces a GitHub failure", async () => {
	await withClient(replaySettings(), async (client, server) => {
		installGithubMock(
			server,
			mockTransport(() => jsonResponse(404, { message: "Not Found" })),
		);
		const resp = await trigger(client, { mode: "triage", issue: "octo/widget#999" });
		expect(resp.status).toBe(502);
		expect(resp.json().detail).toContain("github error");
	});
});

test("trigger retry by delivery id requeues", async () => {
	await withClient(replaySettings(), async (client, _server, db) => {
		db.recordEvent({
			delivery_id: "running-widget-4",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: issueKey("octo/widget", 4),
			payload: { action: "created" },
		});
		expect(db.claimNextEvent()?.delivery_id).toBe("running-widget-4");
		db.recordEvent({
			delivery_id: "d-old",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: issueKey("octo/widget", 4),
			payload: { action: "opened", issue: { number: 4 } },
			state: "failed",
		});
		const resp = await trigger(client, { mode: "retry", delivery_id: "d-old" });
		expect(resp.status).toBe(202);
		expect(db.getEvent("d-old")?.state).toBe("queued");
	});
});

test("trigger retry by issue finds the latest non-skipped event", async () => {
	await withClient(replaySettings(), async (client, _server, db) => {
		const key = issueKey("octo/widget", 9);
		db.recordEvent({
			delivery_id: "running-widget-9",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: key,
			payload: { action: "created" },
		});
		expect(db.claimNextEvent()?.delivery_id).toBe("running-widget-9");
		db.recordEvent({
			delivery_id: "d-old-1",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: key,
			payload: { a: 1 },
			state: "failed",
		});
		db.recordEvent({
			delivery_id: "d-old-2",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: key,
			payload: { a: 2 },
			state: "done",
		});
		db.recordEvent({
			delivery_id: "d-label-noise",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: key,
			payload: { a: 3 },
			state: "skipped",
		});
		const resp = await trigger(client, { mode: "retry", issue: "octo/widget#9" });
		expect(resp.status).toBe(202);
		// Most recently received non-skipped row wins.
		expect(resp.json().delivery).toBe("d-old-2");
		expect(db.getEvent("d-old-2")?.state).toBe("queued");
	});
});

test("trigger retry by issue rejects an active latest event", async () => {
	await withClient(replaySettings(), async (client, _server, db) => {
		const key = issueKey("octo/widget", 10);
		db.recordEvent({
			delivery_id: "d-inactive",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: key,
			payload: { a: 1 },
			state: "failed",
		});
		db.recordEvent({
			delivery_id: "d-active",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: key,
			payload: { a: 2 },
			state: "running",
		});
		const resp = await trigger(client, { mode: "retry", issue: "octo/widget#10" });
		expect(resp.status).toBe(409);
		expect(resp.json().detail).toContain("running");
		expect(db.getEvent("d-active")?.state).toBe("running");
		expect(db.getEvent("d-inactive")?.state).toBe("failed");
	});
});

test("trigger retry by issue rejects a repo not in the allowlist", async () => {
	await withClient(replaySettings(), async (client, _server, db) => {
		db.recordEvent({
			delivery_id: "d-evil",
			event_type: "issues",
			repo: "evil/repo",
			issue_key: issueKey("evil/repo", 1),
			payload: { a: 1 },
			state: "failed",
		});
		const resp = await trigger(client, { mode: "retry", issue: "evil/repo#1" });
		expect(resp.status).toBe(403);
		expect(resp.json().detail).toContain("ROBOMP_REPO_ALLOWLIST");
		expect(db.getEvent("d-evil")?.state).toBe("failed");
	});
});

test("trigger retry of an unknown delivery 404s", async () => {
	await withClient(replaySettings(), async client => {
		expect((await trigger(client, { mode: "retry", delivery_id: "nope" })).status).toBe(404);
	});
});

test("trigger rejects a bad mode", async () => {
	await withClient(replaySettings(), async client => {
		expect((await trigger(client, { mode: "explode" })).status).toBe(400);
	});
});

// -------- /webhook/github rate limiting --------

function postIssueOpened(
	client: Client,
	options: { delivery: string; user: string; number: number; association?: string; secret?: string },
) {
	return postWebhook(
		client,
		"issues",
		options.delivery,
		{
			action: "opened",
			issue: {
				number: options.number,
				user: { login: options.user },
				author_association: options.association ?? "NONE",
			},
			repository: { full_name: "octo/widget" },
		},
		options.secret,
	);
}

function postPrIssueComment(
	client: Client,
	options: { delivery: string; user: string; prNumber: number; association?: string },
) {
	return postWebhook(client, "issue_comment", options.delivery, {
		action: "created",
		comment: { user: { login: options.user }, author_association: options.association ?? "NONE", body: "follow-up" },
		issue: {
			number: options.prNumber,
			pull_request: { url: `https://api.github.com/repos/octo/widget/pulls/${options.prNumber}` },
		},
		repository: { full_name: "octo/widget" },
	});
}
function rateLimitedSettings(overrides: Record<string, string> = {}): Settings {
	return makeSettings({
		ROBOMP_RATE_LIMIT_DEFAULT: "2",
		ROBOMP_RATE_LIMIT_CONTRIBUTOR: "4",
		ROBOMP_RATE_LIMIT_WINDOW_SECONDS: "3600",
		ROBOMP_RATE_LIMIT_UNLIMITED: "can1357",
		...overrides,
	});
}

async function openedStates(
	client: Client,
	prefix: string,
	user: string,
	base: number,
	count: number,
	association = "NONE",
) {
	const states: string[] = [];
	for (let i = 0; i < count; i++) {
		const resp = await postIssueOpened(client, { delivery: `${prefix}-${i}`, user, number: base + i, association });
		expect(resp.status).toBe(202);
		states.push(resp.json().state);
	}
	return states;
}

test("webhook rate-limits an unknown submitter at the default cap", async () => {
	await withClient(rateLimitedSettings(), async client => {
		// Default cap is 2 → first two queued, third throttled.
		expect(await openedStates(client, "d", "stranger", 100, 3)).toEqual(["queued", "queued", "skipped"]);
	});
});

test("webhook incoming PR comment without directive skips without counting budget", async () => {
	await withClient(rateLimitedSettings(), async (client, _server, db) => {
		const skipped = await postPrIssueComment(client, { delivery: "pr-unmapped", user: "stranger", prNumber: 900 });
		expect(skipped.status).toBe(202);
		expect(skipped.json().state).toBe("skipped");
		expect(await openedStates(client, "real", "stranger", 100, 3)).toEqual(["queued", "queued", "skipped"]);
		const unmapped = db.getEvent("pr-unmapped");
		expect(unmapped?.issue_key).toBe("octo/widget#900");
		expect(unmapped?.last_error ?? "").toContain("incoming PR comments ignored");
	});
});

test("webhook delivery populates the issue index", async () => {
	// Every issue-carrying delivery upserts the local search index — including
	// ones the router skips (here: a conversation comment on an incoming PR).
	await withClient(makeSettings(), async (client, _server, db) => {
		const resp = await postWebhook(client, "issues", "idx-1", {
			action: "opened",
			issue: {
				number: 501,
				title: "grep misses colon filenames",
				body: "read tool peels the selector suffix",
				state: "open",
				user: { login: "alice" },
				author_association: "NONE",
			},
			repository: { full_name: "octo/widget" },
		});
		expect(resp.status).toBe(202);
		const skipped = await postPrIssueComment(client, { delivery: "idx-2", user: "stranger", prNumber: 502 });
		expect(skipped.json().state).toBe("skipped");
		expect(db.searchIssueIndex("octo/widget", { keywords: ["selector", "suffix"] }).map(e => e.number)).toEqual([
			501,
		]);
		expect(db.searchIssueIndex("octo/widget", { is_pr: true }).map(e => e.number)).toEqual([502]);
	});
});

test("webhook contributor gets a higher cap", async () => {
	await withClient(rateLimitedSettings(), async client => {
		// Default cap (2) would block at i=2; CONTRIBUTOR cap (4) allows it.
		expect(await openedStates(client, "c", "bob", 200, 4, "CONTRIBUTOR")).toEqual(Array(4).fill("queued"));
		const resp = await postIssueOpened(client, {
			delivery: "c-x",
			user: "bob",
			number: 299,
			association: "CONTRIBUTOR",
		});
		expect(resp.json().state).toBe("skipped");
	});
});

test("webhook OWNER association bypasses the limit", async () => {
	await withClient(rateLimitedSettings(), async client => {
		expect(await openedStates(client, "o", "acme-staff", 300, 5, "OWNER")).toEqual(Array(5).fill("queued"));
	});
});

test("webhook unlimited allowlist bypasses the limit", async () => {
	await withClient(rateLimitedSettings(), async client => {
		// NONE association would normally cap at 2, but `can1357` is whitelisted.
		expect(await openedStates(client, "u", "can1357", 400, 5)).toEqual(Array(5).fill("queued"));
	});
});

test("webhook rate limit per user is independent", async () => {
	await withClient(rateLimitedSettings(), async client => {
		expect(await openedStates(client, "a", "alice", 500, 2)).toEqual(["queued", "queued"]);
		const next = await postIssueOpened(client, { delivery: "a-x", user: "alice", number: 599 });
		expect(next.json().state).toBe("skipped");
		// bob is untouched.
		expect(await openedStates(client, "b", "bob", 600, 2)).toEqual(["queued", "queued"]);
	});
});

test("webhook rate-limited event records the reason", async () => {
	await withClient(rateLimitedSettings(), async (client, _server, db) => {
		await openedStates(client, "r", "charlie", 700, 3);
		const skipped = db.getEvent("r-2");
		expect(skipped?.state).toBe("skipped");
		expect(skipped?.last_error).toContain("rate limit");
		expect(skipped?.last_error).toContain("@charlie");
	});
});

// ---------- /api/github/issues ----------

function ghIssue(
	number: number,
	title: string,
	options: {
		state?: string;
		author?: string;
		labels?: { name: string }[];
		comments?: number;
		updated_at?: string;
		created_at?: string;
		repo?: string;
		extra?: Record<string, unknown>;
	} = {},
): Record<string, unknown> {
	const repo = options.repo ?? "octo/widget";
	return {
		number,
		title,
		state: options.state ?? "open",
		user: { login: options.author ?? "alice" },
		labels: options.labels ?? [],
		comments: options.comments ?? 0,
		updated_at: options.updated_at ?? "2026-05-14T10:00:00Z",
		created_at: options.created_at ?? "2026-05-01T10:00:00Z",
		html_url: `https://github.com/${repo}/issues/${number}`,
		...options.extra,
	};
}

function issuesHandler(
	byRepo: Record<string, Record<string, unknown>[]>,
	options: { expectedState?: string; expectedLimit?: number; failingRepos?: string[] } = {},
) {
	const expected: Record<string, string> = {
		state: options.expectedState ?? "open",
		per_page: String(options.expectedLimit ?? 30),
		sort: "updated",
		direction: "desc",
	};
	return mockTransport(request => {
		expect(request.method).toBe("GET");
		const url = new URL(request.url);
		expect([...url.searchParams.keys()].sort()).toEqual(Object.keys(expected).sort());
		for (const [key, value] of Object.entries(expected)) expect(url.searchParams.get(key)).toBe(value);
		for (const [repo, items] of Object.entries(byRepo)) {
			if (url.pathname === `/repos/${repo}/issues`) return jsonResponse(200, items);
		}
		for (const repo of options.failingRepos ?? []) {
			if (url.pathname === `/repos/${repo}/issues`) return jsonResponse(500, { message: "boom" });
		}
		return jsonResponse(404, { message: "not found" });
	});
}

test("browse returns 404 without a token", async () => {
	await withClient(makeSettings(), async client => {
		expect((await client.get("/api/github/issues")).status).toBe(404);
	});
});

test("browse returns 401 with replay enabled but no valid token", async () => {
	await withClient(replaySettings(), async client => {
		expect((await client.get("/api/github/issues")).status).toBe(401);
		const wrong = await client.get("/api/github/issues", { "X-Robomp-Replay-Token": `${TOKEN}-wrong` });
		expect(wrong.status).toBe(401);
	});
});

test("browse fans out across the allowlist and filters PRs", async () => {
	const transport = issuesHandler(
		{
			"octo/widget": [
				ghIssue(7, "newest", { labels: [{ name: "bug" }], comments: 3 }),
				// GitHub /issues returns PRs too.
				{
					...ghIssue(8, "a PR not an issue", { author: "bob", updated_at: "2026-05-14T11:00:00Z" }),
					html_url: "https://github.com/octo/widget/pull/8",
					pull_request: { url: "..." },
				},
			],
			"octo/gadget": [
				ghIssue(2, "older", {
					author: "carol",
					comments: 1,
					updated_at: "2026-05-12T09:00:00Z",
					created_at: "2026-05-12T09:00:00Z",
					repo: "octo/gadget",
				}),
			],
		},
		{ expectedLimit: 20 },
	);
	await withClient(replaySettings({ ROBOMP_REPO_ALLOWLIST: "octo/widget,octo/gadget" }), async (client, server) => {
		installGithubMock(server, transport);
		const resp = await client.get("/api/github/issues?state=open&limit=20", auth);
		expect(resp.status).toBe(200);
		const body = resp.json();
		expect(body.repos).toEqual(["octo/gadget", "octo/widget"]);
		expect(body.errors).toEqual([]);
		// PR row dropped; issues sorted newest-updated first.
		expect(body.issues.map((i: { repo: string; number: number }) => [i.repo, i.number])).toEqual([
			["octo/widget", 7],
			["octo/gadget", 2],
		]);
		const first = body.issues[0];
		expect(first.author).toBe("alice");
		expect(first.labels).toEqual(["bug"]);
		expect(first.comments).toBe(3);
		expect(first.html_url.endsWith("/issues/7")).toBe(true);
	});
});

test("browse reuses the cache until a forced refresh", async () => {
	let calls = 0;
	const transport = mockTransport(request => {
		expect(new URL(request.url).pathname).toBe("/repos/octo/widget/issues");
		calls += 1;
		return jsonResponse(200, [
			ghIssue(1, calls === 1 ? "initial" : "refreshed", {
				updated_at: calls === 1 ? "2026-05-14T10:00:00Z" : "2026-05-14T11:00:00Z",
			}),
		]);
	});
	await withClient(replaySettings(), async (client, server) => {
		installGithubMock(server, transport);
		const first = (await client.get("/api/github/issues?state=open&limit=20", auth)).json();
		const second = (await client.get("/api/github/issues?state=open&limit=20", auth)).json();
		const forced = (await client.get("/api/github/issues?state=open&limit=20&refresh=1", auth)).json();
		expect(calls).toBe(2);
		expect(first.cache.hit).toBe(false);
		expect(first.issues[0].title).toBe("initial");
		expect(second.cache.hit).toBe(true);
		expect(second.issues[0].title).toBe("initial");
		expect(forced.cache.hit).toBe(false);
		expect(forced.issues[0].title).toBe("refreshed");
	});
});

test("browse cache updates from an issue webhook", async () => {
	let calls = 0;
	const transport = mockTransport(request => {
		expect(new URL(request.url).pathname).toBe("/repos/octo/widget/issues");
		calls += 1;
		return jsonResponse(200, [ghIssue(4, "before", { comments: 1 })]);
	});
	await withClient(replaySettings(), async (client, server) => {
		installGithubMock(server, transport);
		expect((await client.get("/api/github/issues?state=open&limit=20", auth)).status).toBe(200);
		const webhook = await postWebhook(client, "issues", "cache-edit", {
			action: "edited",
			issue: ghIssue(4, "after", { labels: [{ name: "bug" }], comments: 3, updated_at: "2026-05-14T12:00:00Z" }),
			repository: { full_name: "octo/widget" },
		});
		expect(webhook.status).toBe(202);
		const body = (await client.get("/api/github/issues?state=open&limit=20", auth)).json();
		expect(calls).toBe(1);
		expect(body.cache.hit).toBe(true);
		expect(body.issues[0].title).toBe("after");
		expect(body.issues[0].comments).toBe(3);
		expect(body.issues[0].labels).toEqual(["bug"]);
	});
});

test("browse per-repo failure does not take down the panel", async () => {
	const transport = issuesHandler(
		{ "octo/widget": [ghIssue(1, "ok", { author: "u", updated_at: "2026-05-14T00:00:00Z" })] },
		{ failingRepos: ["octo/dead"] },
	);
	TRANSIENT_RETRY_DELAYS.value = [0.001, 0.001, 0.001];
	try {
		await withClient(replaySettings({ ROBOMP_REPO_ALLOWLIST: "octo/widget,octo/dead" }), async (client, server) => {
			installGithubMock(server, transport);
			const body = (await client.get("/api/github/issues", auth)).json();
			expect(body.issues).toHaveLength(1);
			expect(body.issues[0].repo).toBe("octo/widget");
			expect(body.errors).toHaveLength(1);
			expect(body.errors[0].repo).toBe("octo/dead");
		});
	} finally {
		TRANSIENT_RETRY_DELAYS.value = ORIGINAL_RETRY_DELAYS;
	}
});

test("browse rejects a bad state", async () => {
	await withClient(replaySettings(), async (client, server) => {
		installGithubMock(
			server,
			mockTransport(() => new Response(null, { status: 500 })),
		);
		expect((await client.get("/api/github/issues?state=garbage", auth)).status).toBe(400);
	});
});

test("browse marks processed issues present in the DB", async () => {
	// `processed` is derived live from the issues table so freshly-triaged work
	// disappears from the "fresh issues" filter without invalidating the cache.
	const settings = replaySettings();
	getDatabase(settings.sqlite_path).upsertIssue({
		key: issueKey("octo/widget", 7),
		repo: "octo/widget",
		number: 7,
		state: "opened",
	});
	const transport = issuesHandler(
		{
			"octo/widget": [
				ghIssue(7, "already triaged", { updated_at: "2026-05-14T10:00:00Z" }),
				ghIssue(8, "fresh", { updated_at: "2026-05-14T11:00:00Z" }),
			],
		},
		{ expectedLimit: 20 },
	);
	await withClient(settings, async (client, server) => {
		installGithubMock(server, transport);
		const resp = await client.get("/api/github/issues?state=open&limit=20", auth);
		expect(resp.status).toBe(200);
		const byNumber = Object.fromEntries(resp.json().issues.map((i: { number: number }) => [i.number, i]));
		expect(byNumber[7].processed).toBe(true);
		expect(byNumber[8].processed).toBe(false);
	});
});

test("browse processed flag is recomputed on a cache hit", async () => {
	let calls = 0;
	const transport = mockTransport(() => {
		calls += 1;
		return jsonResponse(200, [ghIssue(9, "fresh")]);
	});
	await withClient(replaySettings(), async (client, server, db) => {
		installGithubMock(server, transport);
		const first = (await client.get("/api/github/issues?state=open&limit=20", auth)).json();
		expect(first.issues[0].processed).toBe(false);
		// A triage lands between two dashboard polls.
		db.upsertIssue({ key: issueKey("octo/widget", 9), repo: "octo/widget", number: 9, state: "reproducing" });
		const second = (await client.get("/api/github/issues?state=open&limit=20", auth)).json();
		expect(calls).toBe(1);
		expect(second.cache.hit).toBe(true);
		expect(second.issues[0].processed).toBe(true);
	});
});
// -------- maintainer directives --------

function postIssueComment(
	client: Client,
	options: { delivery: string; user: string; number: number; body: string; association?: string },
) {
	return postWebhook(client, "issue_comment", options.delivery, {
		action: "created",
		comment: { user: { login: options.user }, author_association: options.association ?? "NONE", body: options.body },
		issue: { number: options.number },
		repository: { full_name: "octo/widget" },
	});
}

test("webhook directive on an unknown issue is queued with metadata", async () => {
	await withClient(makeSettings(), async (client, _server, db) => {
		const resp = await postIssueComment(client, {
			delivery: "dir-1",
			user: "can1357",
			number: 77,
			body: "@robomp-bot please refactor X",
			association: "OWNER",
		});
		expect(resp.status).toBe(202);
		expect(resp.json().state).toBe("queued");
		const row = db.getEvent("dir-1");
		expect(row?.state).toBe("queued");
		expect(row?.payload._robomp_directive).toEqual({
			body: "please refactor X",
			author: "can1357",
			pragmas: [],
			authorizes_impl: true,
		});
	});
});

test("webhook directive authorizes the deployed app login without author association", async () => {
	const settings = makeSettings({ ROBOMP_BOT_LOGIN: "@roboomp[bot]", ROBOMP_REPO_ALLOWLIST: "can1357/widget" });
	await withClient(settings, async (client, _server, db) => {
		const resp = await postWebhook(client, "issue_comment", "dir-app-login", {
			action: "created",
			comment: { user: { login: "can1357" }, body: "@roboomp go ahead" },
			issue: { number: 3196 },
			repository: { full_name: "can1357/widget", owner: { login: "can1357", type: "User" } },
		});
		expect(resp.status).toBe(202);
		expect(resp.json().state).toBe("queued");
		expect(db.getEvent("dir-app-login")?.payload._robomp_directive).toEqual({
			body: "go ahead",
			author: "can1357",
			pragmas: [],
			authorizes_impl: true,
		});
	});
});

test("webhook maintainer bypasses the rate limit", async () => {
	// Logins in ROBOMP_MAINTAINER_LOGINS are always unlimited, even with NONE association.
	await withClient(rateLimitedSettings({ ROBOMP_MAINTAINER_LOGINS: "can1357" }), async (client, _server, db) => {
		const states: string[] = [];
		for (let i = 0; i < 4; i++) {
			const resp = await postIssueComment(client, {
				delivery: `m-${i}`,
				user: "can1357",
				number: 300 + i,
				body: i === 3 ? "@robomp-bot do X" : "comment",
			});
			expect(resp.status).toBe(202);
			states.push(resp.json().state);
		}
		expect(states).toEqual(Array(4).fill("queued"));
		expect(db.getEvent("m-3")?.payload._robomp_directive).toEqual({
			body: "do X",
			author: "can1357",
			pragmas: [],
			authorizes_impl: true,
		});
	});
});

// -------- handler-level: bootstrap + reopen --------

interface EnsureCall {
	repo: string;
	number: number;
	title: string;
	default_branch: string;
	existing_branch: string | null;
	pr_head: number | null;
	slot_uid: number | null;
}

/** Stand-in for SandboxManager: records calls, hands back a fake Workspace. */
class RecordingSandbox {
	readonly nativesCache = null;
	ensureCalls: EnsureCall[] = [];
	removeCalls: [string, number][] = [];
	constructor(readonly tmpRoot: string) {}
	async ensureWorkspace(args: EnsureWorkspaceArgs): Promise<Workspace> {
		this.ensureCalls.push({
			repo: args.repo,
			number: args.number,
			title: args.title,
			default_branch: args.defaultBranch,
			existing_branch: args.existingBranch ?? null,
			pr_head: args.prHead ?? null,
			slot_uid: args.slotUid ?? null,
		});
		const wid = `${args.repo.replaceAll("/", "__")}__${args.number}`;
		const prHead = args.prHead ?? null;
		return {
			branch: args.existingBranch || (prHead !== null ? `review/pr-${prHead}` : `farm/auto/${wid}`),
			session_dir: path.join(this.tmpRoot, wid, "session"),
			context_dir: path.join(this.tmpRoot, wid, "context"),
			repo_dir: path.join(this.tmpRoot, wid, "repo"),
		} as Workspace;
	}
	async removeWorkspace(args: { repo: string; number: number | string }): Promise<void> {
		this.removeCalls.push([args.repo, Number(args.number)]);
	}
	asManager(): SandboxManager {
		return this as unknown as SandboxManager;
	}
}

function stubRunTask(): RunTaskArgs[] {
	const captured: RunTaskArgs[] = [];
	const spy = spyOn(tasks.tasksDeps, "runTask").mockImplementation(async args => {
		captured.push(args);
		return null;
	});
	restores.push(() => spy.mockRestore());
	return captured;
}

function stubResolve(repo: RepoInfo, issue: IssueInfo): void {
	const spy = spyOn(tasks.tasksDeps, "resolveRepoAndIssue").mockImplementation(async () => [repo, issue]);
	restores.push(() => spy.mockRestore());
}

function fakeGithub(
	methods: Partial<Record<keyof GitHubBackend, (...args: any[]) => Promise<unknown>>>,
): GitHubBackend {
	return methods as unknown as GitHubBackend;
}

const WIDGET_REPO: RepoInfo = {
	full_name: "octo/widget",
	default_branch: "main",
	clone_url: "https://github.com/octo/widget.git",
	private: false,
};

function issueInfo(number: number, init: Partial<IssueInfo> = {}): IssueInfo {
	return {
		repo: "octo/widget",
		number,
		title: "boom",
		body: "details",
		state: "open",
		author: "alice",
		labels: [],
		is_pull_request: false,
		...init,
	};
}

function prInfo(number: number, init: Partial<PullRequestInfo>): PullRequestInfo {
	return pullRequestInfo({
		repo: "octo/widget",
		number,
		html_url: `https://github.com/octo/widget/pull/${number}`,
		head_ref: "",
		base_ref: "main",
		state: "open",
		...init,
	});
}

interface HandlerEnv {
	settings: Settings;
	db: Database;
	sandbox: RecordingSandbox;
	runs: RunTaskArgs[];
}

function handlerEnv(): HandlerEnv {
	const settings = makeSettings();
	return {
		settings,
		db: getDatabase(settings.sqlite_path),
		sandbox: new RecordingSandbox(tmpPath()),
		runs: stubRunTask(),
	};
}

function taskArgs(env: HandlerEnv, github: GitHubBackend, payload: Record<string, unknown>, deliveryId: string) {
	return {
		settings: env.settings,
		db: env.db,
		github,
		gitTransport: new LocalGitTransport(null),
		sandbox: env.sandbox.asManager(),
		payload,
		deliveryId,
	};
}

function threadSummary(run: RunTaskArgs): [string, string, string][] {
	return (run.thread ?? []).map(m => [m.kind, m.author, m.body]);
}

function prConversationGithub(
	env: HandlerEnv,
	pr: PullRequestInfo,
	issues: Record<number, IssueInfo>,
	commentId: number,
) {
	return fakeGithub({
		getPullRequest: async (repo: string, number: number) => {
			expect(repo).toBe("octo/widget");
			expect(number).toBe(900);
			return pr;
		},
		getRepo: async (repo: string) => {
			expect(repo).toBe("octo/widget");
			return WIDGET_REPO;
		},
		getIssue: async (repo: string, number: number) => {
			expect(repo).toBe("octo/widget");
			if (issues[number]) return issues[number];
			throw new Error(`unexpected issue ${number}`);
		},
		listComments: async (repo: string, number: number) => {
			expect(repo).toBe("octo/widget");
			expect(number).toBe(900);
			return [{ id: commentId, author: "can1357", body: "prior PR context", created_at: "2026-05-14T00:00:00Z" }];
		},
		listReviewComments: async () => [],
		listPrReviews: async () => [],
	});
}

const PR_COMMENT_PAYLOAD = (commentId: number) => ({
	action: "created",
	issue: { number: 900, pull_request: { url: "https://api.github.com/repos/octo/widget/pulls/900" } },
	comment: { user: { login: "can1357" }, body: "please fix", id: commentId, created_at: "2026-05-15T00:00:00Z" },
	repository: { full_name: "octo/widget" },
});

test("handle_pr_conversation on an unmapped bot PR uses the PR branch", async () => {
	const env = handlerEnv();
	const bot = env.settings.bot_login;
	const prIssue = issueInfo(900, { title: "Fix flaky parser", body: "PR body", author: bot, is_pull_request: true });
	const pr = prInfo(900, { head_ref: "farm/abc12345/fix-flaky-parser", author: bot, head_repo: "octo/widget" });
	const github = prConversationGithub(env, pr, { 900: prIssue }, 77);
	await tasks.handlePrConversation(taskArgs(env, github, PR_COMMENT_PAYLOAD(10), "test-pr-direct"));
	expect(env.runs).toHaveLength(1);
	const run = env.runs[0]!;
	expect(run.taskKind).toBe("handle_comment");
	expect(run.prNumber).toBe(900);
	expect(run.inputs.issue?.is_pull_request).toBe(true);
	expect(threadSummary(run)).toEqual([
		["pr_body", bot, "PR body"],
		["comment", "can1357", "prior PR context"],
	]);
	expect(env.sandbox.ensureCalls[0]!.number).toBe(900);
	expect(env.sandbox.ensureCalls[0]!.existing_branch).toBe("farm/abc12345/fix-flaky-parser");
	const row = env.db.getIssue("octo/widget#900");
	expect(row?.pr_number).toBe(900);
	expect(row?.branch).toBe("farm/abc12345/fix-flaky-parser");
	closeDatabase();
});

test("handle_pr_conversation repairs a missing PR mapping from the branch", async () => {
	const env = handlerEnv();
	const bot = env.settings.bot_login;
	const branch = "farm/abc12345/fix-flaky-parser";
	env.db.upsertIssue({ key: "octo/widget#42", repo: "octo/widget", number: 42, state: "opened", branch });
	const issue = issueInfo(42, { title: "Parser is flaky", body: "issue body" });
	const prIssue = issueInfo(900, { title: "Fix flaky parser", body: "PR body", author: bot, is_pull_request: true });
	const pr = prInfo(900, { head_ref: branch, author: bot, head_repo: "octo/widget" });
	const github = prConversationGithub(env, pr, { 42: issue, 900: prIssue }, 78);
	await tasks.handlePrConversation(taskArgs(env, github, PR_COMMENT_PAYLOAD(11), "test-pr-repair"));
	expect(env.runs).toHaveLength(1);
	const run = env.runs[0]!;
	expect(run.inputs.issue?.number).toBe(42);
	expect(run.prNumber).toBe(900);
	expect(threadSummary(run)).toEqual([
		["pr_body", bot, "PR body"],
		["comment", "can1357", "prior PR context"],
	]);
	expect(env.sandbox.ensureCalls[0]!.number).toBe(42);
	expect(env.sandbox.ensureCalls[0]!.existing_branch).toBe(branch);
	expect(env.db.getIssue("octo/widget#42")?.pr_number).toBe(900);
	closeDatabase();
});

test("handle_pr_conversation skips review workspace rows", async () => {
	const env = handlerEnv();
	env.db.upsertIssue({
		key: "octo/widget#900",
		repo: "octo/widget",
		number: 900,
		state: "reviewing",
		branch: "review/pr-900",
		pr_number: 900,
	});
	const github = fakeGithub({
		getPullRequest: async () => prInfo(900, { head_ref: "contrib/fix", author: "alice", head_repo: "alice/widget" }),
	});
	await tasks.handlePrConversation(
		taskArgs(
			env,
			github,
			{
				action: "created",
				issue: {
					number: 900,
					user: { login: "alice" },
					pull_request: { url: "https://api.github.com/repos/octo/widget/pulls/900" },
				},
				comment: { user: { login: "can1357" }, body: "@robomp-bot please re-review", id: 12 },
				repository: { full_name: "octo/widget" },
				_robomp_directive: { body: "please re-review", author: "can1357" },
			},
			"test-pr-review-row",
		),
	);
	expect(env.runs).toEqual([]);
	expect(env.sandbox.ensureCalls).toEqual([]);
	closeDatabase();
});

function reviewGithub(labels: string[]) {
	const issue = issueInfo(900, { title: "Fix parser", body: "body", labels, is_pull_request: true });
	const pr = prInfo(900, { head_ref: "alice/fix-parser", author: "alice", head_repo: "alice/widget" });
	return fakeGithub({
		getRepo: async () => WIDGET_REPO,
		getIssue: async (_repo: string, number: number) => {
			expect(number).toBe(900);
			return issue;
		},
		getPullRequest: async () => pr,
	});
}

const REVIEW_PAYLOAD = { pull_request: { number: 900 }, repository: { full_name: "octo/widget" } };

test("review_pr retries when ranked but not submitted", async () => {
	const env = handlerEnv();
	await tasks.reviewPr(taskArgs(env, reviewGithub(["triaged", "review:p1"]), REVIEW_PAYLOAD, "d-review-retry"));
	expect(env.runs).toHaveLength(1);
	expect(env.runs[0]!.taskKind).toBe("review_pr");
	expect(env.sandbox.ensureCalls[0]!.pr_head).toBe(900);
	closeDatabase();
});

test("review_pr skips after a submitted review", async () => {
	const env = handlerEnv();
	env.db.logToolCall({
		issue_key: issueKey("octo/widget", 900),
		tool: "submit_pr_review",
		args: { body: "done" },
		result: { review_id: 12 },
	});
	await tasks.reviewPr(taskArgs(env, reviewGithub(["triaged", "review:p1"]), REVIEW_PAYLOAD, "d-review-skip"));
	expect(env.runs).toEqual([]);
	expect(env.sandbox.ensureCalls).toEqual([]);
	closeDatabase();
});

function commentPayload(number: number, comment: Record<string, unknown>, directive?: Record<string, unknown>) {
	return {
		action: "created",
		issue: { number, user: { login: "alice" }, title: "boom" },
		comment,
		repository: { full_name: "octo/widget" },
		...(directive ? { _robomp_directive: directive } : {}),
	};
}

test("handle_comment directive bootstraps an untriaged issue", async () => {
	const env = handlerEnv();
	stubResolve(WIDGET_REPO, issueInfo(88));
	await tasks.handleComment(
		taskArgs(
			env,
			fakeGithub({ getIssue: async () => issueInfo(88), listComments: async () => [] }),
			commentPayload(
				88,
				{ user: { login: "can1357" }, body: "do it", id: 1, created_at: "2026-05-14T20:00:00Z" },
				{ body: "please refactor X", author: "can1357" },
			),
			"test-delivery-1",
		),
	);
	expect(env.runs).toHaveLength(1);
	const run = env.runs[0]!;
	expect(run.taskKind).toBe("triage_issue");
	expect(run.directive?.body).toBe("please refactor X");
	expect(run.directive?.author).toBe("can1357");
	expect(env.db.getIssue("octo/widget#88")?.state).toBe("reproducing");
	expect(env.sandbox.ensureCalls.length).toBeGreaterThan(0);
	expect(env.sandbox.removeCalls).toEqual([]);
	closeDatabase();
});

test("handle_comment directive reopens a finalized issue", async () => {
	const env = handlerEnv();
	env.db.upsertIssue({
		key: "octo/widget#88",
		repo: "octo/widget",
		number: 88,
		state: "closed",
		branch: "farm/old/branch",
		pr_number: 99,
	});
	stubResolve(WIDGET_REPO, issueInfo(88));
	const posted: unknown[] = [];
	const github = fakeGithub({
		postComment: async (...args: unknown[]) => void posted.push(args),
		getIssue: async () => issueInfo(88),
		listComments: async () => [],
	});
	await tasks.handleComment(
		taskArgs(
			env,
			github,
			commentPayload(
				88,
				{ user: { login: "can1357" }, body: "redo", id: 2, created_at: "2026-05-14T21:00:00Z" },
				{ body: "redo the fix", author: "can1357" },
			),
			"test-delivery-2",
		),
	);
	expect(env.runs).toHaveLength(1);
	expect(env.runs[0]!.taskKind).toBe("handle_comment");
	expect(env.runs[0]!.directive?.body).toBe("redo the fix");
	expect(env.sandbox.removeCalls).toEqual([["octo/widget", 88]]);
	// Reopen branches afresh (no existing branch passed).
	expect(env.sandbox.ensureCalls[0]!.existing_branch).toBeNull();
	expect(posted).toEqual([]);
	expect(env.db.getIssue("octo/widget#88")?.state).toBe("reproducing");
	closeDatabase();
});

test("handle_comment on a finalized issue without a directive still replies", async () => {
	const env = handlerEnv();
	env.db.upsertIssue({
		key: "octo/widget#88",
		repo: "octo/widget",
		number: 88,
		state: "closed",
		branch: "farm/old/branch",
		pr_number: 99,
	});
	stubResolve(WIDGET_REPO, issueInfo(88, { state: "closed" }));
	const posted: unknown[] = [];
	await tasks.handleComment(
		taskArgs(
			env,
			fakeGithub({ postComment: async (...args: unknown[]) => void posted.push(args) }),
			commentPayload(88, {
				user: { login: "stranger" },
				body: "still broken",
				id: 3,
				created_at: "2026-05-14T22:00:00Z",
			}),
			"test-delivery-3",
		),
	);
	expect(env.runs).toEqual([]);
	expect(posted.length).toBeGreaterThan(0);
	expect(env.sandbox.removeCalls).toEqual([]);
	closeDatabase();
});

test("handle_comment resumes needs-info without preemptive cleanup", async () => {
	// A needs-info reply resumes first; host tools clear state only after actionable work.
	const env = handlerEnv();
	env.db.upsertIssue({
		key: "octo/widget#88",
		repo: "octo/widget",
		number: 88,
		state: "needs_info",
		branch: "farm/old/branch",
	});
	stubResolve(WIDGET_REPO, issueInfo(88, { labels: ["needs-info"] }));
	const posted: unknown[] = [];
	const removedLabels: unknown[] = [];
	await tasks.handleComment(
		taskArgs(
			env,
			fakeGithub({
				postComment: async (...args: unknown[]) => void posted.push(args),
				removeIssueLabel: async (...args: unknown[]) => void removedLabels.push(args),
			}),
			commentPayload(88, {
				user: { login: "alice" },
				body: "I am on Bun 1.3.14 and here is the trace",
				id: 4,
				created_at: "2026-05-14T23:00:00Z",
			}),
			"test-delivery-needs-info",
		),
	);
	expect(env.runs).toHaveLength(1);
	expect(env.runs[0]!.taskKind).toBe("handle_comment");
	expect(env.runs[0]!.comment?.body).toBe("I am on Bun 1.3.14 and here is the trace");
	expect(env.sandbox.ensureCalls[0]!.existing_branch).toBe("farm/old/branch");
	expect(removedLabels).toEqual([]);
	expect(posted).toEqual([]);
	expect(env.db.getIssue("octo/widget#88")?.state).toBe("needs_info");
	closeDatabase();
});

test("directive handler attaches the thread from GitHub", async () => {
	const env = handlerEnv();
	const issue = issueInfo(88, { body: "the body" });
	stubResolve(WIDGET_REPO, issue);
	env.db.upsertIssue({
		key: "octo/widget#88",
		repo: "octo/widget",
		number: 88,
		state: "reproducing",
		branch: "farm/x/y",
	});
	const github = fakeGithub({
		getIssue: async () => issue,
		listComments: async () => [
			{ id: 1, author: "alice", body: "me too", created_at: "2026-05-01T10:00:00Z" },
			{ id: 2, author: "bob", body: "confirmed", created_at: "2026-05-02T10:00:00Z" },
		],
	});
	await tasks.handleComment(
		taskArgs(
			env,
			github,
			commentPayload(
				88,
				{ user: { login: "can1357" }, body: "@roboomp do X", id: 10, created_at: "2026-05-03T20:00:00Z" },
				{ body: "do X", author: "can1357" },
			),
			"test-delivery-4",
		),
	);
	expect(env.runs).toHaveLength(1);
	const directive = env.runs[0]!.directive!;
	expect(directive.body).toBe("do X");
	const kinds = directive.thread.map(m => `${m.kind}:${m.author}`);
	for (const expected of ["issue_body:alice", "comment:alice", "comment:bob"]) expect(kinds).toContain(expected);
	closeDatabase();
});

// ---------- triage_issue: closing-PR skip ----------

function triageGithub(closingPrs: number[] | Error) {
	const calls: [string, number][] = [];
	const github = fakeGithub({
		listClosingPullRequests: async (repo: string, number: number) => {
			calls.push([repo, number]);
			if (closingPrs instanceof Error) throw closingPrs;
			return closingPrs;
		},
	});
	return { github, calls };
}

function triagePayload(number: number) {
	return { action: "opened", issue: { number }, repository: { full_name: "octo/widget" } };
}

test("triage_issue skips when a closing PR already exists", async () => {
	// Another author is on it: no triage, labels or workspace.
	const env = handlerEnv();
	stubResolve(WIDGET_REPO, issueInfo(1069, { title: "x", body: "y" }));
	const { github, calls } = triageGithub([1070]);
	await tasks.triageIssue(taskArgs(env, github, triagePayload(1069), "t-skip-1"));
	expect(calls).toEqual([["octo/widget", 1069]]);
	expect(env.runs).toEqual([]);
	expect(env.sandbox.ensureCalls).toEqual([]);
	expect(env.db.getIssue("octo/widget#1069")).toBeNull();
	closeDatabase();
});

test("triage_issue proceeds when there is no closing PR", async () => {
	const env = handlerEnv();
	stubResolve(WIDGET_REPO, issueInfo(42, { title: "x", body: "y" }));
	const { github, calls } = triageGithub([]);
	await tasks.triageIssue(taskArgs(env, github, triagePayload(42), "t-skip-2"));
	expect(calls).toEqual([["octo/widget", 42]]);
	expect(env.runs).toHaveLength(1);
	expect(env.sandbox.ensureCalls.length).toBeGreaterThan(0);
	expect(env.db.getIssue("octo/widget#42")?.state).toBe("reproducing");
	closeDatabase();
});

test("triage_issue fails open when the timeline fetch errors", async () => {
	const env = handlerEnv();
	stubResolve(WIDGET_REPO, issueInfo(99, { title: "x", body: "y" }));
	const { github } = triageGithub(new GitHubError(503, "upstream timeout"));
	await tasks.triageIssue(taskArgs(env, github, triagePayload(99), "t-skip-3"));
	expect(env.runs).toHaveLength(1);
	expect(env.sandbox.ensureCalls.length).toBeGreaterThan(0);
	closeDatabase();
});

test("triage_issue does not recheck when the issue row exists", async () => {
	// A repeat triage (retry/replay) MUST NOT re-query the timeline.
	const env = handlerEnv();
	env.db.upsertIssue({ key: "octo/widget#7", repo: "octo/widget", number: 7, state: "reproducing" });
	stubResolve(WIDGET_REPO, issueInfo(7, { title: "x", body: "y" }));
	const { github, calls } = triageGithub([1070]);
	await tasks.triageIssue(taskArgs(env, github, triagePayload(7), "t-skip-4"));
	expect(calls).toEqual([]);
	expect(env.runs).toHaveLength(1);
	closeDatabase();
});

// -------- /webhook/github cancellation hooks --------

function seedPendingClosure(db: Database, key: string, number: number): void {
	db.upsertPendingClosure({
		issue_key: key,
		repo: "octo/widget",
		number,
		comment_id: 42,
		issue_author: "alice",
		close_at: "2999-01-01T00:00:00.000000Z",
	});
}

test("webhook issue comment cancels a pending closure", async () => {
	const settings = makeSettings();
	const key = issueKey("octo/widget", 7);
	seedPendingClosure(getDatabase(settings.sqlite_path), key, 7);
	await withClient(settings, async (client, _server, db) => {
		const resp = await postIssueComment(client, {
			delivery: "d-cancel-comment",
			user: "alice",
			number: 7,
			body: "follow-up",
		});
		expect(resp.status).toBe(202);
		const row = db.getPendingClosure(key);
		expect(row?.state).toBe("cancelled");
		expect(row?.cancel_reason).toBe("user_replied");
	});
});

test("webhook issues.closed cancels a pending closure", async () => {
	const settings = makeSettings();
	const key = issueKey("octo/widget", 8);
	seedPendingClosure(getDatabase(settings.sqlite_path), key, 8);
	await withClient(settings, async (client, _server, db) => {
		const resp = await postWebhook(client, "issues", "d-cancel-closed", {
			action: "closed",
			issue: { number: 8, user: { login: "alice" } },
			repository: { full_name: "octo/widget" },
		});
		expect(resp.status).toBe(202);
		const row = db.getPendingClosure(key);
		expect(row?.state).toBe("cancelled");
		expect(row?.cancel_reason).toBe("externally_closed");
	});
});

test("webhook PR conversation does not cancel a pending closure", async () => {
	// A PR comment routes to handle_pr_conversation, unrelated to the
	// question auto-close schedule on the originating issue.
	const settings = makeSettings();
	const key = issueKey("octo/widget", 9);
	seedPendingClosure(getDatabase(settings.sqlite_path), key, 9);
	await withClient(settings, async (client, _server, db) => {
		const resp = await postPrIssueComment(client, { delivery: "d-pr-noop", user: "alice", prNumber: 9 });
		expect(resp.status).toBe(202);
		expect(db.getPendingClosure(key)?.state).toBe("pending");
	});
});
