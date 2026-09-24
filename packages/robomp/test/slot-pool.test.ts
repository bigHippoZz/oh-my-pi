import { expect, test } from "bun:test";
import { SlotPool } from "../src/slot-pool";

test("empty pool is noop", async () => {
	const pool = new SlotPool();
	expect(await pool.acquire()).toBeNull();
	pool.release(null);
});

test("acquire/release reuses uid", async () => {
	const pool = new SlotPool([2001]);
	expect(await pool.acquire()).toBe(2001);
	pool.release(2001);
	expect(await pool.acquire()).toBe(2001);
});

test("double release rejected", async () => {
	const pool = new SlotPool([2001]);
	const slotUid = await pool.acquire();
	pool.release(slotUid);
	expect(() => pool.release(slotUid)).toThrow(RangeError);
	expect(() => pool.release(slotUid)).toThrow(/not acquired/);
});

test("duplicate slots rejected", () => {
	expect(() => new SlotPool([2001, 2001])).toThrow(RangeError);
	expect(() => new SlotPool([2001, 2001])).toThrow(/unique/);
});

test("concurrent acquire waits until release", async () => {
	const pool = new SlotPool([2001]);
	const first = await pool.acquire();
	let done = false;
	const second = pool.acquire().then(uid => {
		done = true;
		return uid;
	});
	await Bun.sleep(0);
	expect(done).toBe(false);
	pool.release(first);
	expect(await second).toBe(2001);
});
