/** Cancellation primitives on WorkerPool (port of test_queue_cancel.py). */
import { afterEach, expect, spyOn, test } from "bun:test";
import { registerCancelHook, runWithCurrentEvent, unregisterCancelHook } from "../src/cancellation";
import * as sandbox from "../src/sandbox";
import { SlotPool } from "../src/slot-pool";
import { makeDb, makeSettings } from "./helpers";
import { eventRow, makePool, recordRunning } from "./queue-helpers";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function stubReap(calls: (number | null | undefined)[]): void {
	const spy = spyOn(sandbox, "reapSlot").mockImplementation(uid => void calls.push(uid));
	restores.push(() => spy.mockRestore());
}

test("cancel fires the hook armed by the worker", async () => {
	const pool = makePool(makeSettings(), makeDb());
	const { promise: fired, resolve: fire } = Promise.withResolvers<void>();
	const worker = runWithCurrentEvent(pool, "d1", async () => {
		registerCancelHook(() => fire());
		try {
			await fired;
		} finally {
			unregisterCancelHook();
		}
	});
	expect(pool.cancelHooks.has("d1")).toBe(true);
	expect(await pool.cancelEvent("d1")).toBe(true);
	await worker;
	expect(pool.cancelled.has("d1")).toBe(true);
	// Hook is consumed.
	expect(pool.cancelHooks.has("d1")).toBe(false);
});

test("cancel before arm fires immediately on register", async () => {
	const pool = makePool(makeSettings(), makeDb());
	expect(await pool.cancelEvent("d2")).toBe(false);
	expect(pool.cancelled.has("d2")).toBe(true);
	const calls: number[] = [];
	runWithCurrentEvent(pool, "d2", () => registerCancelHook(() => calls.push(1)));
	expect(calls).toEqual([1]);
	// Late-armed hook is NOT retained; cancel state is one-shot.
	expect(pool.cancelHooks.has("d2")).toBe(false);
});

test("dispatch that observed cancellation marks the row failed with the marker", async () => {
	const db = makeDb();
	const pool = makePool(makeSettings(), db);
	recordRunning(db, "d3");
	spyOn(pool, "dispatch").mockImplementation(async row => {
		await pool.cancelEvent(row.delivery_id);
		throw new Error("subprocess died");
	});
	await pool.runEvent(eventRow({ delivery_id: "d3" }));
	const stored = db.getEvent("d3");
	expect(stored?.state).toBe("failed");
	expect(stored?.last_error).toBe("cancelled by operator");
	expect(pool.cancelled.has("d3")).toBe(false);
	expect(pool.cancelHooks.has("d3")).toBe(false);
});

test("non-cancelled failure keeps the real traceback", async () => {
	const db = makeDb();
	const pool = makePool(makeSettings({ ROBOMP_EVENT_MAX_RETRIES: "0" }), db);
	recordRunning(db, "d4");
	spyOn(pool, "dispatch").mockImplementation(async () => {
		throw new RangeError("boom 42");
	});
	await pool.runEvent(eventRow({ delivery_id: "d4" }));
	const stored = db.getEvent("d4");
	expect(stored?.state).toBe("failed");
	expect(stored?.last_error).toContain("boom 42");
	expect(stored?.last_error).not.toContain("cancelled by operator");
});

test("runEvent marks failed when not shutting down", async () => {
	const db = makeDb();
	const pool = makePool(makeSettings({ ROBOMP_EVENT_MAX_RETRIES: "0" }), db);
	expect(pool.shuttingDown).toBe(false);
	recordRunning(db, "d5");
	spyOn(pool, "dispatch").mockImplementation(async () => {
		throw new Error("regular failure");
	});
	await pool.runEvent(eventRow({ delivery_id: "d5" }));
	const stored = db.getEvent("d5");
	expect(stored?.state).toBe("failed");
	expect(stored?.last_error).toContain("regular failure");
});

test("cancel of an unknown delivery returns false but records the request", async () => {
	const pool = makePool(makeSettings(), makeDb());
	expect(await pool.cancelEvent("never-existed")).toBe(false);
	expect(pool.cancelled.has("never-existed")).toBe(true);
});

test("start reaps the configured slot uids", async () => {
	const calls: (number | null | undefined)[] = [];
	stubReap(calls);
	const pool = makePool(makeSettings(), makeDb(), new SlotPool([2001, 2002]));
	await pool.start();
	try {
		expect([...calls].sort()).toEqual([2001, 2002]);
	} finally {
		await pool.stop({ drainTimeout: 0.01, killTimeout: 0.01 });
	}
});

test("runEvent reaps the slot before releasing it", async () => {
	const slotPool = new SlotPool([2001]);
	const db = makeDb();
	const pool = makePool(makeSettings(), db, slotPool);
	recordRunning(db, "d-slot");
	const order: [string, number | null | undefined][] = [];
	const reap = spyOn(sandbox, "reapSlot").mockImplementation(uid => void order.push(["reap", uid]));
	restores.push(() => reap.mockRestore());
	const release = slotPool.release.bind(slotPool);
	spyOn(slotPool, "release").mockImplementation(uid => {
		order.push(["release", uid]);
		release(uid);
	});
	spyOn(pool, "dispatch").mockImplementation(async (row, slotUid) => {
		expect(row.delivery_id).toBe("d-slot");
		expect(slotUid).toBe(2001);
	});
	await pool.runEvent(eventRow({ delivery_id: "d-slot" }));
	expect(db.getEvent("d-slot")?.state).toBe("done");
	expect(order).toEqual([
		["reap", 2001],
		["release", 2001],
	]);
});
