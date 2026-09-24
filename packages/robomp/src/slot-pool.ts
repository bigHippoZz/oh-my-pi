/**
 * FIFO pool of per-task slot UIDs (`omp-N` users). An empty pool is a no-op.
 * Misuse throws `RangeError` (Python `ValueError`).
 */
export class SlotPool {
	readonly #slotUids: readonly number[];
	readonly #available: number[] = [];
	readonly #waiters: PromiseWithResolvers<number>[] = [];
	readonly #checkedOut = new Set<number>();

	constructor(slotUids: Iterable<number> = []) {
		this.#slotUids = [...slotUids];
		if (new Set(this.#slotUids).size !== this.#slotUids.length) {
			throw new RangeError("slot UIDs must be unique");
		}
		this.#available.push(...this.#slotUids);
	}

	get slotUids(): readonly number[] {
		return this.#slotUids;
	}

	async acquire(): Promise<number | null> {
		if (this.#slotUids.length === 0) return null;
		const next = this.#available.shift();
		if (next !== undefined) {
			this.#checkedOut.add(next);
			return next;
		}
		const waiter = Promise.withResolvers<number>();
		this.#waiters.push(waiter);
		const slotUid = await waiter.promise;
		this.#checkedOut.add(slotUid);
		return slotUid;
	}

	release(slotUid: number | null): void {
		if (this.#slotUids.length === 0 && slotUid === null) return;
		if (slotUid === null || !this.#checkedOut.has(slotUid)) {
			throw new RangeError("slot UID was not acquired");
		}
		this.#checkedOut.delete(slotUid);
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve(slotUid);
		else this.#available.push(slotUid);
	}
}
