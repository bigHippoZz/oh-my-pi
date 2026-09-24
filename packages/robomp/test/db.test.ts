import { Database as SqliteDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Database, isoSecondsAgo, issueKey } from "../src/db";
import { makeDb, tmpPath } from "./helpers";

describe("events", () => {
	test("record_event dedupes by delivery", () => {
		const db = makeDb();
		const payload = { action: "opened", issue: { number: 1 } };
		const args = {
			delivery_id: "abc",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: issueKey("octo/widget", 1),
			payload,
		};
		expect(db.recordEvent(args)).toBe(true);
		expect(db.recordEvent(args)).toBe(false);
	});

	test("claim_next_event hands each event to exactly one claimer", async () => {
		const db = makeDb();
		for (let i = 0; i < 5; i++) {
			db.recordEvent({
				delivery_id: `d-${i}`,
				event_type: "issues",
				repo: "octo/widget",
				issue_key: issueKey("octo/widget", i),
				payload: { i },
			});
		}
		const winners: string[] = [];
		for (let round = 0; round < 5; round++) {
			const claims = await Promise.all(Array.from({ length: 8 }, async () => db.claimNextEvent()));
			for (const row of claims) if (row) winners.push(row.delivery_id);
		}
		expect(winners.sort()).toEqual([0, 1, 2, 3, 4].map(i => `d-${i}`));
		for (let i = 0; i < 5; i++) expect(db.getEvent(`d-${i}`)!.state).toBe("running");
	});

	test("claim leaves same issue queued while running", () => {
		const db = makeDb();
		const key = issueKey("octo/widget", 4);
		db.recordEvent({
			delivery_id: "running",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: key,
			payload: { action: "created" },
			state: "running",
		});
		db.recordEvent({
			delivery_id: "queued",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: key,
			payload: { action: "created" },
		});
		expect(db.claimNextEvent()).toBeNull();
		expect(db.getEvent("queued")!.state).toBe("queued");
		db.markEvent("running", "done");
		const claimed = db.claimNextEvent();
		expect(claimed?.delivery_id).toBe("queued");
		expect(db.getEvent("queued")!.state).toBe("running");
	});

	test("claim skips blocked issue without stalling others", () => {
		const db = makeDb();
		const blocked = issueKey("octo/widget", 4);
		const ready = issueKey("octo/widget", 5);
		db.recordEvent({
			delivery_id: "running",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: blocked,
			payload: { action: "created" },
			state: "running",
		});
		db.recordEvent({
			delivery_id: "blocked",
			event_type: "issue_comment",
			repo: "octo/widget",
			issue_key: blocked,
			payload: { action: "created" },
		});
		db.recordEvent({
			delivery_id: "ready",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: ready,
			payload: { action: "opened" },
		});
		expect(db.claimNextEvent()?.delivery_id).toBe("ready");
		expect(db.getEvent("blocked")!.state).toBe("queued");
	});

	test("requeue can be restricted by source state", () => {
		const db = makeDb();
		db.recordEvent({
			delivery_id: "done-event",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: issueKey("octo/widget", 1),
			payload: {},
			state: "done",
		});
		db.recordEvent({
			delivery_id: "running-event",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: issueKey("octo/widget", 2),
			payload: {},
			state: "running",
		});
		expect(db.requeueEvent("done-event", { from_states: ["done", "failed", "skipped"] })).toBe(true);
		expect(db.getEvent("done-event")!.state).toBe("queued");
		expect(db.requeueEvent("running-event", { from_states: ["done", "failed", "skipped"] })).toBe(false);
		expect(db.getEvent("running-event")!.state).toBe("running");
	});

	test("latest issue events ignore skipped noise", () => {
		const db = makeDb();
		const fixed = issueKey("octo/widget", 1);
		const stillFailed = issueKey("octo/widget", 2);
		db.recordEvent({
			delivery_id: "fixed-failed",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: fixed,
			payload: { action: "opened" },
			state: "failed",
		});
		db.recordEvent({
			delivery_id: "fixed-done",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: fixed,
			payload: { action: "opened" },
			state: "done",
		});
		db.recordEvent({
			delivery_id: "failed-run",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: stillFailed,
			payload: { action: "opened" },
			state: "failed",
		});
		db.recordEvent({
			delivery_id: "label-noise",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: stillFailed,
			payload: { action: "labeled" },
			state: "skipped",
			last_error: "issues.labeled ignored",
		});
		expect(db.latestEventForIssue(stillFailed)?.delivery_id).toBe("failed-run");
		expect(db.latestEventForIssue(stillFailed, { include_skipped: true })?.delivery_id).toBe("label-noise");
		const latest = db.latestEventsForIssues([fixed, stillFailed]);
		expect(latest.get(fixed)?.delivery_id).toBe("fixed-done");
		expect(latest.get(stillFailed)?.delivery_id).toBe("failed-run");
		const counts = db.latestIssueEventStateCounts();
		expect(counts.done).toBe(1);
		expect(counts.failed).toBe(1);
		expect(counts.skipped).toBe(0);
	});

	test("reset_stuck_running recovers and preserves started_at", () => {
		const db = makeDb();
		db.recordEvent({
			delivery_id: "d1",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: "octo/widget#1",
			payload: {},
		});
		expect(db.claimNextEvent()).not.toBeNull();
		const startedAt = () =>
			(db.conn.query("SELECT started_at FROM events WHERE delivery_id=?").get("d1") as { started_at: string | null })
				.started_at;
		const before = startedAt();
		expect(before).not.toBeNull();
		expect(db.resetStuckRunning()).toBe(1);
		expect(db.getEvent("d1")!.state).toBe("queued");
		expect(startedAt()).toBe(before);
	});

	test("set_event_model persists on running event", () => {
		const db = makeDb();
		db.recordEvent({
			delivery_id: "d-model",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: issueKey("octo/widget", 42),
			payload: { action: "opened" },
		});
		expect(db.claimNextEvent()?.delivery_id).toBe("d-model");
		db.setEventModel("d-model", "claude-sonnet-4-5");
		let running = db.listRunningEvents();
		expect(running).toHaveLength(1);
		expect(running[0]!.model).toBe("claude-sonnet-4-5");
		db.setEventModel("d-model", "claude-opus-4-5");
		running = db.listRunningEvents();
		expect(running[0]!.model).toBe("claude-opus-4-5");
	});

	test("list_running_events surfaces last tool since start only", async () => {
		const db = makeDb();
		const key = issueKey("octo/widget", 7);
		db.upsertIssue({ key, repo: "octo/widget", number: 7, state: "reproducing" });
		db.logToolCall({ issue_key: key, tool: "stale_tool", args: {} });
		await Bun.sleep(2);
		db.recordEvent({
			delivery_id: "d-7",
			event_type: "issues",
			repo: "octo/widget",
			issue_key: key,
			payload: { action: "opened" },
		});
		db.claimNextEvent();
		let running = db.listRunningEvents();
		expect(running).toHaveLength(1);
		expect(running[0]!.last_tool).toBeNull();
		expect(running[0]!.last_tool_ts).toBeNull();
		await Bun.sleep(2);
		db.logToolCall({ issue_key: key, tool: "gh_post_comment", args: { body: "hi" } });
		await Bun.sleep(2);
		db.logToolCall({ issue_key: key, tool: "set_issue_labels", args: { labels: ["bug"] } });
		running = db.listRunningEvents();
		expect(running[0]!.last_tool).toBe("set_issue_labels");
		expect(running[0]!.last_tool_ts).not.toBeNull();
	});
});

describe("issues", () => {
	test("upsert round trip", () => {
		const db = makeDb();
		const key = issueKey("octo/widget", 7);
		expect(db.upsertIssue({ key, repo: "octo/widget", number: 7, state: "new" }).state).toBe("new");
		const row = db.upsertIssue({
			key,
			repo: "octo/widget",
			number: 7,
			state: "opened",
			branch: "farm/abcd1234/some-issue",
			session_dir: "/tmp/s",
			pr_number: 42,
		});
		expect(row.state).toBe("opened");
		expect(row.branch).toBe("farm/abcd1234/some-issue");
		expect(row.pr_number).toBe(42);
		expect(db.getIssue(key)?.pr_number).toBe(42);
		expect(db.findIssueByPr("octo/widget", 42)?.key).toBe(key);
		expect(db.findIssueByBranch("octo/widget", "farm/abcd1234/some-issue")?.key).toBe(key);
	});

	test("log_tool_call returns row id", () => {
		const db = makeDb();
		db.upsertIssue({ key: "octo/widget#1", repo: "octo/widget", number: 1, state: "new" });
		expect(
			db.logToolCall({
				issue_key: "octo/widget#1",
				tool: "gh_post_comment",
				args: { body: "hi" },
				result: { comment_id: 9 },
			}),
		).toBeGreaterThan(0);
	});

	test("pr review comment staging round trip", () => {
		const db = makeDb();
		const first = db.stageReviewComment({
			issue_key: "octo/widget#9",
			path: "src/app.py",
			line: 12,
			side: "RIGHT",
			start_line: 10,
			start_side: "RIGHT",
			body: "blocking finding",
		});
		db.stageReviewComment({ issue_key: "octo/widget#9", path: "src/other.py", line: 3, body: "nit" });
		db.stageReviewComment({ issue_key: "octo/widget#10", path: "x.py", line: 1, body: "other" });
		const rows = db.listStagedReviewComments("octo/widget#9");
		expect(rows.map(r => r.id)).toEqual([first.id, first.id + 1]);
		expect(rows[0]!.path).toBe("src/app.py");
		expect(rows[0]!.start_line).toBe(10);
		expect(rows[0]!.start_side).toBe("RIGHT");
		expect(rows[1]!.side).toBe("RIGHT");
		expect(db.clearStagedReviewComments("octo/widget#9")).toBe(2);
		expect(db.listStagedReviewComments("octo/widget#9")).toEqual([]);
		expect(db.listStagedReviewComments("octo/widget#10")).toHaveLength(1);
	});

	test("processed_issue_keys returns only known", () => {
		const db = makeDb();
		db.upsertIssue({ key: issueKey("octo/widget", 1), repo: "octo/widget", number: 1, state: "new" });
		db.upsertIssue({ key: issueKey("octo/widget", 2), repo: "octo/widget", number: 2, state: "reproducing" });
		const result = db.processedIssueKeys([
			issueKey("octo/widget", 1),
			issueKey("octo/widget", 2),
			issueKey("octo/widget", 3),
			issueKey("octo/other", 7),
		]);
		expect(result).toEqual(new Set([issueKey("octo/widget", 1), issueKey("octo/widget", 2)]));
	});

	test("processed_issue_keys empty input", () => {
		const db = makeDb();
		expect(db.processedIssueKeys([])).toEqual(new Set());
		expect(db.processedIssueKeys(["", ""])).toEqual(new Set());
	});

	test("processed_issue_keys handles large batch", () => {
		const db = makeDb();
		const keys = Array.from({ length: 749 }, (_, i) => issueKey("octo/widget", i + 1));
		for (let n = 1; n < 750; n++) {
			if (n % 3 === 0) db.upsertIssue({ key: keys[n - 1]!, repo: "octo/widget", number: n, state: "new" });
		}
		const expected = new Set(keys.filter((_, i) => (i + 1) % 3 === 0));
		expect(db.processedIssueKeys([...keys, "bogus#1"])).toEqual(expected);
	});

	test("classification round trip", () => {
		const db = makeDb();
		const key = issueKey("octo/widget", 7);
		db.upsertIssue({ key, repo: "octo/widget", number: 7, state: "new" });
		expect(db.getIssue(key)?.classification).toBeNull();
		db.setIssueClassification(key, "question");
		expect(db.getIssue(key)?.classification).toBe("question");
		expect(db.listIssues().some(r => r.key === key && r.classification === "question")).toBe(true);
	});

	test("migration adds classification to existing db", () => {
		const file = path.join(tmpPath(), "legacy.sqlite");
		const conn = new SqliteDatabase(file, { create: true });
		conn.exec(`
			CREATE TABLE events (delivery_id TEXT PRIMARY KEY, event_type TEXT, payload_json TEXT,
			  received_at TEXT, state TEXT CHECK(state IN ('queued','running','done','failed','skipped')),
			  attempts INTEGER DEFAULT 0, last_error TEXT, repo TEXT, issue_key TEXT,
			  started_at TEXT, finished_at TEXT);
			CREATE TABLE issues (key TEXT PRIMARY KEY, repo TEXT, number INTEGER, branch TEXT,
			  session_dir TEXT, pr_number INTEGER, state TEXT, updated_at TEXT);
			CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT,
			  tool TEXT, args_json TEXT, result_json TEXT, error TEXT, ts TEXT);
			INSERT INTO issues VALUES ('octo/widget#1', 'octo/widget', 1, 'farm/x', '/tmp/s', NULL,
			  'reproducing', '2026-01-01T00:00:00Z');
		`);
		conn.close();
		const database = new Database(file);
		try {
			expect(database.getIssue("octo/widget#1")?.classification).toBeNull();
			database.setIssueClassification("octo/widget#1", "bug");
			expect(database.getIssue("octo/widget#1")?.classification).toBe("bug");
		} finally {
			database.close();
		}
	});
});

describe("submissions", () => {
	test("record_submission dedupes by delivery", () => {
		const db = makeDb();
		expect(db.recordSubmission({ delivery_id: "d-1", login: "Alice", repo: "octo/widget" })).toBe(true);
		expect(db.recordSubmission({ delivery_id: "d-1", login: "alice", repo: "octo/widget" })).toBe(false);
	});

	test("admit_submission dedupes by delivery before rate limit", () => {
		const db = makeDb();
		const since = isoSecondsAgo(60);
		const first = db.admitSubmission({ delivery_id: "d-1", login: "Alice", repo: "octo/widget", since, cap: 1 });
		expect(first).toEqual({ accepted: true, duplicate: false, used: 1 });
		const duplicate = db.admitSubmission({ delivery_id: "d-1", login: "alice", repo: "octo/widget", since, cap: 1 });
		expect(duplicate).toEqual({ accepted: true, duplicate: true, used: 1 });
		const rejected = db.admitSubmission({ delivery_id: "d-2", login: "ALICE", repo: "octo/widget", since, cap: 1 });
		expect(rejected).toEqual({ accepted: false, duplicate: false, used: 1 });
		expect(db.countSubmissionsSince("alice", since)).toBe(1);
	});

	test("admit_submission enforces cap atomically across connections", async () => {
		const file = path.join(tmpPath(), "admission.sqlite");
		new Database(file).close();
		const sab = new SharedArrayBuffer(4);
		const workers = [0, 1].map(() => new Worker(new URL("./fixtures/admit-worker.ts", import.meta.url).href));
		try {
			const results = await Promise.all(
				workers.map((worker, i) => {
					const { promise, resolve, reject } = Promise.withResolvers<boolean>();
					worker.onmessage = (event: MessageEvent<{ accepted: boolean }>) => resolve(event.data.accepted);
					worker.onerror = event => reject(new Error(event.message));
					worker.postMessage({ path: file, deliveryId: `d-${i}`, sab });
					return promise;
				}),
			);
			expect(results.sort()).toEqual([false, true]);
		} finally {
			for (const worker of workers) worker.terminate();
		}
		const verifier = new Database(file);
		try {
			expect(verifier.countSubmissionsSince("alice", isoSecondsAgo(60))).toBe(1);
		} finally {
			verifier.close();
		}
	});

	test("count_submissions_since is case-insensitive", () => {
		const db = makeDb();
		db.recordSubmission({ delivery_id: "d-1", login: "Alice", repo: "octo/widget" });
		db.recordSubmission({ delivery_id: "d-2", login: "ALICE", repo: "octo/widget" });
		db.recordSubmission({ delivery_id: "d-3", login: "bob", repo: "octo/widget" });
		const since = isoSecondsAgo(60);
		expect(db.countSubmissionsSince("alice", since)).toBe(2);
		expect(db.countSubmissionsSince("ALICE", since)).toBe(2);
		expect(db.countSubmissionsSince("bob", since)).toBe(1);
		expect(db.countSubmissionsSince("nobody", since)).toBe(0);
	});

	test("count_submissions_since respects window", () => {
		const db = makeDb();
		db.recordSubmission({ delivery_id: "d-1", login: "alice", repo: "octo/widget" });
		expect(db.countSubmissionsSince("alice", isoSecondsAgo(-60))).toBe(0);
	});
});

describe("pending_closures", () => {
	const KEY = issueKey("octo/widget", 42);
	const seedPending = (db: Database, closeAt = "2026-05-15T00:00:00.000000Z") =>
		db.upsertPendingClosure({
			issue_key: KEY,
			repo: "octo/widget",
			number: 42,
			comment_id: 999,
			issue_author: "Alice",
			close_at: closeAt,
		});

	test("upsert lowercases author and starts pending", () => {
		const db = makeDb();
		seedPending(db);
		const row = db.getPendingClosure(KEY)!;
		expect(row.state).toBe("pending");
		expect(row.cancel_reason).toBeNull();
		expect(row.issue_author).toBe("alice");
		expect(row.comment_id).toBe(999);
	});

	test("upsert overwrites prior schedule", () => {
		const db = makeDb();
		seedPending(db);
		db.finalizeClosure(KEY, { state: "cancelled", reason: "user_replied" });
		db.upsertPendingClosure({
			issue_key: KEY,
			repo: "octo/widget",
			number: 42,
			comment_id: 1234,
			issue_author: "alice",
			close_at: "2030-01-01T00:00:00.000000Z",
		});
		const row = db.getPendingClosure(KEY)!;
		expect(row.state).toBe("pending");
		expect(row.cancel_reason).toBeNull();
		expect(row.comment_id).toBe(1234);
		expect(row.close_at).toBe("2030-01-01T00:00:00.000000Z");
	});

	test("claim_due_closures only returns due pending", () => {
		const db = makeDb();
		seedPending(db, "2000-01-01T00:00:00.000000Z");
		db.upsertPendingClosure({
			issue_key: issueKey("octo/widget", 7),
			repo: "octo/widget",
			number: 7,
			comment_id: 10,
			issue_author: "bob",
			close_at: "2999-01-01T00:00:00.000000Z",
		});
		const claimed = db.claimDueClosures({ now: "2026-05-15T00:00:00.000000Z" });
		expect(claimed.map(r => r.issue_key)).toEqual([KEY]);
		expect(claimed.every(r => r.state === "claimed")).toBe(true);
		expect(db.claimDueClosures({ now: "2026-05-15T00:00:00.000000Z" })).toEqual([]);
	});

	test("claim_due_closures hands out disjoint rows", async () => {
		const db = makeDb();
		for (let n = 0; n < 5; n++) {
			db.upsertPendingClosure({
				issue_key: issueKey("octo/widget", n),
				repo: "octo/widget",
				number: n,
				comment_id: 100 + n,
				issue_author: "alice",
				close_at: "2000-01-01T00:00:00.000000Z",
			});
		}
		const seen: string[] = [];
		for (let round = 0; round < 4; round++) {
			const batches = await Promise.all(
				Array.from({ length: 4 }, async () =>
					db.claimDueClosures({ now: "2026-05-15T00:00:00.000000Z", limit: 2 }),
				),
			);
			for (const rows of batches) seen.push(...rows.map(r => r.issue_key));
		}
		expect(seen.sort()).toEqual([0, 1, 2, 3, 4].map(n => issueKey("octo/widget", n)).sort());
	});

	test("cancel only fires when pending", () => {
		const db = makeDb();
		seedPending(db);
		expect(db.cancelPendingClosure(KEY, "user_replied")).toBe(true);
		const row = db.getPendingClosure(KEY)!;
		expect(row.state).toBe("cancelled");
		expect(row.cancel_reason).toBe("user_replied");
		expect(db.cancelPendingClosure(KEY, "user_replied")).toBe(false);
	});

	test("cancel skips claimed rows", () => {
		const db = makeDb();
		seedPending(db, "2000-01-01T00:00:00.000000Z");
		const claimed = db.claimDueClosures({ now: "2026-05-15T00:00:00.000000Z" });
		expect(claimed[0]?.state).toBe("claimed");
		expect(db.cancelPendingClosure(KEY, "user_replied")).toBe(false);
		expect(db.getPendingClosure(KEY)?.state).toBe("claimed");
	});

	test("finalize rejects non-terminal state", () => {
		const db = makeDb();
		seedPending(db);
		expect(() => db.finalizeClosure(KEY, { state: "pending", reason: null })).toThrow(RangeError);
	});

	test("requeue_claimed only flips claimed", () => {
		const db = makeDb();
		seedPending(db, "2000-01-01T00:00:00.000000Z");
		db.claimDueClosures({ now: "2026-05-15T00:00:00.000000Z" });
		expect(db.requeueClaimedClosure(KEY)).toBe(true);
		expect(db.getPendingClosure(KEY)?.state).toBe("pending");
		expect(db.requeueClaimedClosure(KEY)).toBe(false);
	});
});

test("release lifecycle and active selection", async () => {
	const db = makeDb();
	const first = db.upsertRelease({
		repo: "octo/widget",
		tag: "v1.2.3",
		version: "1.2.3",
		current_sha: "sha-1",
		session_dir: "/sessions/v1.2.3",
	});
	expect(first.state).toBe("awaiting_ci");
	expect(db.getActiveRelease("octo/widget")).toEqual(first);
	const fixing = db.bumpReleaseRound(first.key, "sha-1");
	expect(fixing.rounds).toBe(1);
	expect(fixing.state).toBe("fixing");
	expect(fixing.last_failed_sha).toBe("sha-1");
	db.setReleaseSha(first.key, "sha-2");
	db.setReleaseState(first.key, "awaiting_ci");
	const updated = db.getRelease(first.key)!;
	expect(updated.current_sha).toBe("sha-2");
	expect(updated.last_error).toBeNull();
	await Bun.sleep(2);
	const second = db.upsertRelease({
		repo: "octo/widget",
		tag: "v1.2.4",
		version: "1.2.4",
		current_sha: "sha-3",
		session_dir: "/sessions/v1.2.4",
	});
	expect(db.getActiveRelease("octo/widget")).toEqual(second);
	await Bun.sleep(2);
	db.setReleaseState(second.key, "superseded");
	expect(db.getActiveRelease("octo/widget")?.key).toBe(first.key);
	db.setReleaseState(first.key, "green");
	expect(db.getActiveRelease("octo/widget")).toBeNull();
	expect(new Set(db.listReleases().map(r => r.state))).toEqual(new Set(["green", "superseded"]));
});
