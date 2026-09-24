/**
 * Graceful shutdown drain + kill behavior on WorkerPool (port of test_queue_shutdown.py).
 *
 * The contract under test is `stop()`'s drain-then-kill sequence and
 * `runEvent`'s shutdown branch that leaves the DB row `running` so
 * `resetStuckRunning()` can requeue it.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import type { GitHubBackend } from "../src/github-backend";
import { WorkerPool } from "../src/queue";
import type { GitTransport } from "../src/sandbox";
import { SlotPool } from "../src/slot-pool";
import * as subprocess from "../src/subprocess";
import { makeDb, makeSettings } from "./helpers";
import { eventRow, makePool, recordRunning, stubSandbox } from "./queue-helpers";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

test("non-root fallback semaphore caps dispatch concurrency", async () => {
	const geteuid = spyOn(subprocess.platformInfo, "geteuid").mockReturnValue(501);
	restores.push(() => geteuid.mockRestore());
	const db = makeDb();
	const pool = new WorkerPool({
		settings: makeSettings({ ROBOMP_MAX_CONCURRENCY: "1" }),
		db,
		github: {} as GitHubBackend,
		sandbox: stubSandbox,
		gitTransport: {} as GitTransport,
	});
	recordRunning(db, "d-one", "octo/widget#1");
	recordRunning(db, "d-two", "octo/widget#2");
	const { promise: dispatchStarted, resolve: markStarted } = Promise.withResolvers<void>();
	const { promise: releaseDispatch, resolve: release } = Promise.withResolvers<void>();
	const started: string[] = [];
	spyOn(pool, "dispatch").mockImplementation(async (row, slotUid) => {
		expect(slotUid).toBeNull();
		started.push(row.delivery_id);
		markStarted();
		await releaseDispatch;
	});
	const first = pool.runEvent(eventRow({ delivery_id: "d-one" }));
	await dispatchStarted;
	const second = pool.runEvent(eventRow({ delivery_id: "d-two" }));
	await Bun.sleep(0);
	expect(started).toEqual(["d-one"]);
	release();
	await Promise.all([first, second]);
	expect(started).toEqual(["d-one", "d-two"]);
});

test("stop drains in-flight work within the timeout", async () => {
	// A short in-flight task finishes during the drain window; no kill hook needed.
	const pool = makePool(makeSettings(), makeDb());
	let done = false;
	const task = Bun.sleep(50).then(() => {
		done = true;
	});
	pool.inflightTasks.set(task, { deliveryId: "d-short", controller: new AbortController() });
	await pool.stop({ drainTimeout: 1, killTimeout: 0.1 });
	expect(pool.shuttingDown).toBe(true);
	expect(done).toBe(true);
});

test("stop fires the kill hook when drain exceeds the timeout", async () => {
	// The DB row stays `running`: only runEvent mutates state.
	const db = makeDb();
	const pool = makePool(makeSettings(), db);
	recordRunning(db, "d-blocked");
	let hookCalled = false;
	pool.cancelHooks.set("d-blocked", () => {
		hookCalled = true;
	});
	const { promise: never } = Promise.withResolvers<void>();
	pool.inflightTasks.set(never, { deliveryId: "d-blocked", controller: new AbortController() });
	await pool.stop({ drainTimeout: 0.05, killTimeout: 0.05 });
	expect(hookCalled).toBe(true);
	expect(db.getEvent("d-blocked")?.state).toBe("running");
});

test("runEvent skips markEvent when shutting down", async () => {
	// A dispatch exception on a deliberately-interrupted delivery leaves the row untouched.
	const db = makeDb();
	const pool = makePool(makeSettings(), db);
	pool.shuttingDown = true;
	pool.shutdownCancelled.add("d-shutdown");
	recordRunning(db, "d-shutdown");
	spyOn(pool, "dispatch").mockImplementation(async () => {
		throw new Error("omp died");
	});
	await pool.runEvent(eventRow({ delivery_id: "d-shutdown" }));
	const stored = db.getEvent("d-shutdown");
	expect(stored?.state).toBe("running");
	expect(stored?.last_error).toBeNull();
});

test("stop aborts a hookless in-flight task", async () => {
	// A task stuck pre-hook (slot/semaphore wait, client startup) MUST be
	// aborted by stop(), not left to spawn omp after stop() returns.
	const pool = makePool(makeSettings(), makeDb());
	let reachedSpawn = false;
	const controller = new AbortController();
	const { promise: preHookStarted, resolve: markStarted } = Promise.withResolvers<void>();
	const task = (async () => {
		markStarted();
		await Promise.race([
			Bun.sleep(5000),
			new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve())),
		]);
		controller.signal.throwIfAborted();
		reachedSpawn = true;
	})();
	let settled = "pending" as "pending" | "fulfilled" | "rejected";
	void task.then(
		() => {
			settled = "fulfilled";
		},
		() => {
			settled = "rejected";
		},
	);
	pool.inflightTasks.set(task, { deliveryId: "d-hookless", controller });
	await preHookStarted;
	await pool.stop({ drainTimeout: 0.05, killTimeout: 0.2 });
	await Bun.sleep(0);
	// stop() must terminate the hookless task (done + cancelled), not leave it running.
	expect(settled).toBe("rejected");
	expect(controller.signal.aborted).toBe(true);
	expect(reachedSpawn).toBe(false);
	expect(pool.shutdownCancelled.has("d-hookless")).toBe(true);
});

test("stop interrupts a runEvent parked on a saturated slot pool", async () => {
	// Python cancels a task waiting in `SlotPool.acquire`; the TS abort must
	// likewise withdraw the wait so dispatch never runs after stop() returns
	// and the row stays `running` for the next start() to requeue.
	const db = makeDb();
	const slotPool = new SlotPool([2001]);
	const pool = makePool(makeSettings(), db, slotPool);
	recordRunning(db, "d-parked", "octo/widget#2");
	const held = await slotPool.acquire();
	const dispatched: string[] = [];
	spyOn(pool, "dispatch").mockImplementation(async row => {
		dispatched.push(row.delivery_id);
	});
	const task = pool.spawnEvent(eventRow({ delivery_id: "d-parked", issue_key: "octo/widget#2" }));
	await Bun.sleep(0);
	await pool.stop({ drainTimeout: 0.05, killTimeout: 0.5 });
	expect(pool.inflightTasks.has(task)).toBe(false);
	slotPool.release(held);
	await Bun.sleep(0);
	expect(dispatched).toEqual([]);
	expect(db.getEvent("d-parked")?.state).toBe("running");
	// The abandoned wait never strands the slot.
	expect(await slotPool.acquire()).toBe(2001);
});

test("runEvent marks failed for an unrelated failure during drain", async () => {
	// Only deliveries in shutdownCancelled are suppressed; an unrelated
	// failure during the drain window must still mark the row failed.
	const db = makeDb();
	const pool = makePool(makeSettings({ ROBOMP_EVENT_MAX_RETRIES: "0" }), db);
	pool.shuttingDown = true;
	recordRunning(db, "d-real-fail");
	spyOn(pool, "dispatch").mockImplementation(async () => {
		throw new Error("genuine bug, not shutdown");
	});
	await pool.runEvent(eventRow({ delivery_id: "d-real-fail" }));
	const stored = db.getEvent("d-real-fail");
	expect(stored?.state).toBe("failed");
	expect(stored?.last_error).toContain("genuine bug, not shutdown");
});
