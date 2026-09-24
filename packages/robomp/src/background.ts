/** Stoppable periodic background loop (asyncio task + stop Event analogue). */
import { getLogger } from "./logging";

export class StopEvent {
	#set = false;
	#waiters: (() => void)[] = [];

	get isSet(): boolean {
		return this.#set;
	}

	set(): void {
		if (this.#set) return;
		this.#set = true;
		for (const wake of this.#waiters.splice(0)) wake();
	}

	/** Resolve true when set, false when `seconds` elapse first. */
	wait(seconds: number): Promise<boolean> {
		if (this.#set) return Promise.resolve(true);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(
			() => {
				this.#waiters = this.#waiters.filter(w => w !== wake);
				resolve(false);
			},
			Math.max(0, seconds * 1000),
		);
		const wake = () => {
			clearTimeout(timer);
			resolve(true);
		};
		this.#waiters.push(wake);
		return promise;
	}
}

/**
 * Run `tick` every `intervalSeconds` until stopped. Tick errors are logged
 * and never kill the loop. `stop()` waits up to 5s for the current tick.
 */
export class PeriodicLoop {
	#stop: StopEvent | null = null;
	#task: Promise<void> | null = null;

	constructor(
		readonly name: string,
		readonly intervalSeconds: () => number,
		readonly tick: () => Promise<void>,
		readonly options: { errorMessage: string; loggerName: string; initialDelay?: boolean },
	) {}

	get running(): boolean {
		return this.#task !== null;
	}

	start(): void {
		if (this.#task !== null) return;
		const stop = new StopEvent();
		this.#stop = stop;
		const log = getLogger(this.options.loggerName);
		this.#task = (async () => {
			if (this.options.initialDelay && (await stop.wait(this.intervalSeconds()))) return;
			while (!stop.isSet) {
				try {
					await this.tick();
				} catch (err) {
					log.exception(this.options.errorMessage, err);
				}
				if (await stop.wait(this.intervalSeconds())) return;
			}
		})();
	}

	async stop(): Promise<void> {
		if (this.#task === null) return;
		this.#stop?.set();
		const task = this.#task;
		let timer: Timer | undefined;
		try {
			await Promise.race([task, new Promise<void>(resolve => (timer = setTimeout(resolve, 5000)))]);
		} finally {
			clearTimeout(timer);
			this.#task = null;
			this.#stop = null;
		}
	}
}
