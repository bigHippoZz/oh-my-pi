/**
 * Automatic backoff-retry of transiently-failed events (port of test_retry.py):
 * Settings backoff parsing, Database retry gating, WorkerPool retry-then-exhaust.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import type { Database } from "../src/db";
import { issueKey } from "../src/db";
import * as sandbox from "../src/sandbox";
import { SlotPool } from "../src/slot-pool";
import { makeDb, makeSettings } from "./helpers";
import { makePool } from "./queue-helpers";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function record(db: Database, delivery = "d1"): void {
	db.recordEvent({
		delivery_id: delivery,
		event_type: "issues",
		repo: "octo/widget",
		issue_key: issueKey("octo/widget", 1),
		payload: { action: "opened" },
	});
}

// ---- Settings: backoff schedule ----

test("event retry delays parsing skips garbage", () => {
	const cfg = makeSettings({ ROBOMP_EVENT_RETRY_DELAYS_SECONDS: "30, 120 ,600,,abc,-5" });
	expect(cfg.event_retry_delays).toEqual([30, 120, 600]);
});

test("event retry delays default when empty", () => {
	expect(makeSettings({ ROBOMP_EVENT_RETRY_DELAYS_SECONDS: "   " }).event_retry_delays).toEqual([30]);
});

test("retry delay escalates and clamps", () => {
	const cfg = makeSettings({ ROBOMP_EVENT_RETRY_DELAYS_SECONDS: "1,2,3" });
	// Pin jitter to its midpoint (0.8 + 0.5*0.4 = 1.0) so we assert exact bases.
	const random = spyOn(Math, "random").mockReturnValue(0.5);
	restores.push(() => random.mockRestore());
	expect(cfg.retryDelaySeconds(1)).toBe(1);
	expect(cfg.retryDelaySeconds(2)).toBe(2);
	expect(cfg.retryDelaySeconds(3)).toBe(3);
	expect(cfg.retryDelaySeconds(4)).toBe(3); // clamps to the last delay
	expect(cfg.retryDelaySeconds(0)).toBe(1); // clamps to the first delay
});

test("retry delay jitter stays in band", () => {
	const cfg = makeSettings({ ROBOMP_EVENT_RETRY_DELAYS_SECONDS: "100" });
	for (let i = 0; i < 200; i++) {
		const delay = cfg.retryDelaySeconds(1);
		expect(delay).toBeGreaterThanOrEqual(80);
		expect(delay).toBeLessThanOrEqual(120);
	}
});

// ---- Database: scheduleRetry + claim gating ----

test("scheduleRetry gates claim until available", () => {
	const db = makeDb();
	record(db);
	expect(db.claimNextEvent()?.attempts).toBe(1);
	expect(db.scheduleRetry("d1", { delay_seconds: 3600, error: "ephemeral boom" })).toBe(true);
	const ev = db.getEvent("d1");
	expect(ev?.state).toBe("queued");
	expect(ev?.attempts).toBe(1); // claim budget preserved, not reset
	expect(ev?.last_error).toBe("ephemeral boom");
	expect(db.claimNextEvent()).toBeNull(); // backed off into the future
});

test("scheduleRetry with zero delay is immediately claimable", () => {
	const db = makeDb();
	record(db);
	db.claimNextEvent();
	expect(db.scheduleRetry("d1", { delay_seconds: 0, error: "boom" })).toBe(true);
	expect(db.claimNextEvent()?.attempts).toBe(2); // re-claim advances the counter
});

test("scheduleRetry only transitions running or failed rows", () => {
	const db = makeDb();
	record(db);
	expect(db.scheduleRetry("d1", { delay_seconds: 0 })).toBe(false);
	expect(db.getEvent("d1")?.state).toBe("queued");
	db.claimNextEvent();
	db.markEvent("d1", "failed", "x");
	expect(db.scheduleRetry("d1", { delay_seconds: 3600, error: "retry me" })).toBe(true);
	expect(db.getEvent("d1")?.state).toBe("queued");
});

test("manual requeue clears retry backoff", () => {
	const db = makeDb();
	record(db);
	db.claimNextEvent();
	db.scheduleRetry("d1", { delay_seconds: 3600, error: "boom" });
	expect(db.claimNextEvent()).toBeNull();
	expect(db.requeueEvent("d1")).toBe(true);
	expect(db.claimNextEvent()).not.toBeNull();
});

// ---- WorkerPool: retry-then-exhaust through the real failure path ----

function retryPool(db: Database, maxRetries: number) {
	const reap = spyOn(sandbox, "reapSlot").mockImplementation(() => {});
	restores.push(() => reap.mockRestore());
	const cfg = makeSettings({
		ROBOMP_EVENT_MAX_RETRIES: String(maxRetries),
		ROBOMP_EVENT_RETRY_DELAYS_SECONDS: "0",
	});
	return makePool(cfg, db, new SlotPool([2001]));
}

test("runEvent retries then marks failed", async () => {
	const db = makeDb();
	const pool = retryPool(db, 1);
	spyOn(pool, "dispatch").mockImplementation(async () => {
		throw new Error("ephemeral boom");
	});
	record(db);
	const row1 = db.claimNextEvent()!;
	expect(row1.attempts).toBe(1);
	await pool.runEvent(row1);
	let ev = db.getEvent("d1");
	expect(ev?.state).toBe("queued");
	expect(ev?.last_error).toContain("ephemeral boom");
	const row2 = db.claimNextEvent()!;
	expect(row2.attempts).toBe(2);
	await pool.runEvent(row2);
	ev = db.getEvent("d1");
	expect(ev?.state).toBe("failed");
	expect(ev?.last_error).toContain("ephemeral boom");
});

test("runEvent succeeds after a transient failure", async () => {
	const db = makeDb();
	const pool = retryPool(db, 3);
	let calls = 0;
	spyOn(pool, "dispatch").mockImplementation(async () => {
		calls += 1;
		if (calls === 1) throw new Error("ephemeral boom");
	});
	record(db);
	await pool.runEvent(db.claimNextEvent()!);
	expect(db.getEvent("d1")?.state).toBe("queued");
	await pool.runEvent(db.claimNextEvent()!);
	expect(db.getEvent("d1")?.state).toBe("done");
	expect(calls).toBe(2);
});
