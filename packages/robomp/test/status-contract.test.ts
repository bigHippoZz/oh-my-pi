/**
 * Contract test for the server API vs web/test/fixtures/status-contract.json
 * (port of test_status_contract.py). The same fixture backs the web client's
 * contract tests, so both sides agree on the payload shape.
 *
 * Regenerate the committed fixture with:
 *   ROBOMP_UPDATE_STATUS_CONTRACT=1 bun test test/status-contract.test.ts
 */
import { beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../src/config";
import { closeDatabase, getDatabase } from "../src/db";
import { pyJsonDumps } from "../src/pycompat";
import { createApp, type RobompServer } from "../src/server";
import { makeSettings } from "./helpers";
import { ensureDashboardBundle } from "./server-helpers";

// Runtime/timestamp fields vary every run; normalize them so the live payload
// compares against (or regenerates) a byte-stable committed fixture.
const VOLATILE_TS_KEYS = new Set(["received_at", "started_at", "last_tool_ts", "updated_at"]);
const FIXED_TS = "2024-01-01T00:00:00+00:00";
const FIXTURE = path.join(import.meta.dir, "..", "web", "test", "fixtures", "status-contract.json");

beforeEach(() => {
	ensureDashboardBundle();
});

function normalizeForFixture(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForFixture);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === "uptime_seconds") out[key] = 0;
			else if (VOLATILE_TS_KEYS.has(key) && item !== null) out[key] = FIXED_TS;
			else out[key] = normalizeForFixture(item);
		}
		return out;
	}
	return value;
}

/** Real server (default WorkerPool) for the duration of `fn` (TestClient lifespan). */
async function withServer(settings: Settings, fn: (server: RobompServer) => Promise<void>): Promise<void> {
	const server = createApp(settings);
	await server.start();
	try {
		await fn(server);
	} finally {
		await server.stop();
		closeDatabase();
	}
}

async function call(
	server: RobompServer,
	method: string,
	url: string,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	const init: RequestInit = { method, headers: { ...headers } };
	if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)["content-type"] = "application/json";
	}
	const res = await server.fetch(new Request(`http://testserver${url}`, init));
	const text = await res.text();
	return { status: res.status, json: () => JSON.parse(text) };
}

test("status contract", async () => {
	const settings = makeSettings();
	await withServer(settings, async server => {
		// Seed AFTER startup.
		const db = getDatabase(settings.sqlite_path);
		// 1. A running issue with live detail.
		db.upsertIssue({
			key: "octo/widget#1",
			state: "reproducing",
			repo: "octo/widget",
			number: 1,
			branch: "farm/abc12345/fix",
			pr_number: 77,
		});
		db.recordEvent({
			delivery_id: "run-x",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: "octo/widget#1",
			payload: { action: "created" },
		});
		expect(db.claimNextEvent()?.delivery_id).toBe("run-x");
		db.setEventModel("run-x", "anthropic/claude-3-5-sonnet");
		db.logToolCall({ issue_key: "octo/widget#1", tool: "edit", args: {} });
		// 2. A failed issue.
		db.upsertIssue({ key: "octo/widget#2", state: "fixing", repo: "octo/widget", number: 2 });
		db.recordEvent({
			delivery_id: "failed-x",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#2",
			state: "failed",
			last_error: "repro diverged",
			payload: { action: "opened" },
		});
		// 3. A superseded failed issue (older failed + newer done event).
		db.upsertIssue({ key: "octo/widget#3", state: "fixing", repo: "octo/widget", number: 3 });
		db.recordEvent({
			delivery_id: "superseded-failed",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#3",
			state: "failed",
			last_error: "old error",
			payload: { action: "opened" },
		});
		db.recordEvent({
			delivery_id: "new-done",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#3",
			state: "done",
			payload: { action: "opened" },
		});
		// 4. An issue-less (orphan) failure.
		db.recordEvent({
			delivery_id: "orphan-failed-x",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: null,
			state: "failed",
			last_error: "orphan failed error",
			payload: { action: "opened" },
		});
		// 5. A terminal issue.
		db.upsertIssue({ key: "octo/widget#4", state: "merged", repo: "octo/widget", number: 4 });
		db.recordEvent({
			delivery_id: "terminal-done",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#4",
			state: "done",
			payload: { action: "opened" },
		});
		// 6. A queued issue.
		db.upsertIssue({ key: "octo/widget#5", state: "new", repo: "octo/widget", number: 5 });
		db.recordEvent({
			delivery_id: "queued-x",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#5",
			state: "queued",
			payload: { action: "opened" },
		});
		// 7. An active issue with no latest event.
		db.upsertIssue({ key: "octo/widget#6", state: "new", repo: "octo/widget", number: 6 });

		const resp = await call(server, "GET", "/api/status");
		expect(resp.status).toBe(200);
		const data = resp.json();
		expect(Object.keys(data).sort()).toEqual([
			"event_counts",
			"inflight",
			"issue_event_counts",
			"issues",
			"recent_events",
			"releases",
			"running_events",
			"runtime",
		]);
		const running = data.running_events;
		expect(running).toHaveLength(1);
		expect(Object.keys(running[0]).sort()).toEqual([
			"attempts",
			"delivery_id",
			"event_type",
			"issue_key",
			"last_tool",
			"last_tool_ts",
			"model",
			"received_at",
			"repo",
			"started_at",
		]);
		expect(running[0].model).toBe("anthropic/claude-3-5-sonnet");
		expect(running[0].last_tool).toBe("edit");
		for (const issue of data.issues) {
			expect(Object.keys(issue).sort()).toEqual([
				"branch",
				"classification",
				"key",
				"latest_event",
				"number",
				"pr_number",
				"repo",
				"state",
				"updated_at",
			]);
			if (issue.latest_event !== null) {
				expect(Object.keys(issue.latest_event).sort()).toEqual([
					"attempts",
					"delivery_id",
					"event_type",
					"last_error",
					"received_at",
					"state",
				]);
			}
		}
		expect(data.runtime.repo_allowlist).toEqual(["octo/widget"]);

		const actual = normalizeForFixture(data);
		if (process.env.ROBOMP_UPDATE_STATUS_CONTRACT === "1") {
			fs.writeFileSync(FIXTURE, pyJsonDumps(actual, { indent: 2 }));
		} else {
			expect(actual).toEqual(JSON.parse(fs.readFileSync(FIXTURE, "utf-8")));
		}
	});
});

const TOKEN = "trigger-secret";
const auth = { "X-Robomp-Replay-Token": TOKEN };

test("cancel happy path", async () => {
	const settings = makeSettings({ ROBOMP_REPLAY_TOKEN: TOKEN });
	await withServer(settings, async server => {
		const db = getDatabase(settings.sqlite_path);
		db.recordEvent({
			delivery_id: "run-cancel-1",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#1",
			payload: { action: "opened" },
		});
		expect(db.claimNextEvent()?.delivery_id).toBe("run-cancel-1");
		const resp = await call(server, "POST", "/api/cancel", { delivery_id: "run-cancel-1" }, auth);
		expect(resp.status).toBe(202);
		expect(resp.json()).toEqual({ delivery: "run-cancel-1", fired: false, previous_state: "running" });
	});
});

test("cancel errors and gating", async () => {
	const settings = makeSettings({ ROBOMP_REPLAY_TOKEN: TOKEN });
	await withServer(settings, async server => {
		const db = getDatabase(settings.sqlite_path);
		db.recordEvent({
			delivery_id: "run-cancel-2",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#1",
			payload: { action: "opened" },
		});
		expect((await call(server, "POST", "/api/cancel", { delivery_id: "nope" }, auth)).status).toBe(404);
		// Queued (non-running) delivery: 409, and the pool's cancelled set stays clean.
		expect((await call(server, "POST", "/api/cancel", { delivery_id: "run-cancel-2" }, auth)).status).toBe(409);
		expect(db.getEvent("run-cancel-2")?.state).toBe("queued");
		expect(
			(
				await call(
					server,
					"POST",
					"/api/cancel",
					{ delivery_id: "run-cancel-2" },
					{ "X-Robomp-Replay-Token": "bad-token" },
				)
			).status,
		).toBe(401);
		expect((await call(server, "POST", "/api/cancel", { delivery_id: "run-cancel-2" })).status).toBe(401);
	});
	// Replay disabled (token not set) → 404.
	await withServer(makeSettings({ ROBOMP_REPLAY_TOKEN: "" }), async server => {
		expect((await call(server, "POST", "/api/cancel", { delivery_id: "run-cancel-2" }, auth)).status).toBe(404);
	});
});

test("retry state transition", async () => {
	const settings = makeSettings({ ROBOMP_REPLAY_TOKEN: TOKEN });
	await withServer(settings, async server => {
		const db = getDatabase(settings.sqlite_path);
		db.recordEvent({
			delivery_id: "running-same-issue",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: "octo/widget#1",
			payload: { action: "created" },
		});
		expect(db.claimNextEvent()?.delivery_id).toBe("running-same-issue");
		db.recordEvent({
			delivery_id: "failed-retry-1",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#1",
			state: "failed",
			last_error: "error",
			payload: { action: "opened" },
		});
		const resp = await call(server, "POST", "/api/trigger", { mode: "retry", delivery_id: "failed-retry-1" }, auth);
		expect(resp.status).toBe(202);
		expect(resp.json()).toEqual({ delivery: "failed-retry-1", state: "queued", mode: "retry" });
		expect(db.getEvent("failed-retry-1")?.state).toBe("queued");
	});
});
