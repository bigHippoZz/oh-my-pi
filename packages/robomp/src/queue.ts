/** Async worker pool draining the durable sqlite event queue. */
import { type CancelSink, runWithCurrentEvent } from "./cancellation";
import type { Settings } from "./config";
import type { Database, EventRow } from "./db";
import type { GitHubBackend } from "./github-backend";
import type { Json } from "./github-client";
import { formatException, getLogger } from "./logging";
import * as sandboxMod from "./sandbox";
import type { GitTransport, SandboxManager } from "./sandbox";
import { SlotPool } from "./slot-pool";
import { currentEuid } from "./subprocess";
import * as tasks from "./tasks";

const log = getLogger("robomp.queue");

/** Minimal counting semaphore (Python `asyncio.Semaphore`). */
class Semaphore {
	#available: number;
	readonly #waiters: (() => void)[] = [];
	constructor(count: number) {
		this.#available = count;
	}
	async acquire(): Promise<void> {
		if (this.#available > 0) {
			this.#available -= 1;
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push(resolve);
		await promise;
	}
	release(): void {
		const next = this.#waiters.shift();
		if (next) next();
		else this.#available += 1;
	}
}

/** Sleep that resolves early when `signal` fires; returns true if interrupted. */
async function sleepUnless(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return true;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const onAbort = (): void => resolve(true);
	signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => resolve(false), ms);
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/** Bookkeeping for one spawned `runEvent` task. */
export interface InflightTask {
	deliveryId: string | null;
	/** Aborting it is the TS analogue of cancelling the asyncio task. */
	controller: AbortController;
}

export interface WorkerPoolOptions {
	settings: Settings;
	db: Database;
	github: GitHubBackend;
	sandbox: SandboxManager;
	gitTransport: GitTransport;
	slotPool?: SlotPool | null;
}

/** Long-lived dispatcher: drains queued events into per-task coroutines. */
export class WorkerPool implements CancelSink {
	readonly settings: Settings;
	readonly db: Database;
	readonly github: GitHubBackend;
	readonly sandbox: SandboxManager;
	readonly gitTransport: GitTransport;
	readonly slotPool: SlotPool | null;
	readonly #semaphore: Semaphore | null;
	readonly #workers: Promise<void>[] = [];
	#wakeup = Promise.withResolvers<void>();
	readonly #stop = new AbortController();
	readonly #inflight = new Set<string>();
	/** Worker-armed stop hooks, fired by `cancelEvent` / shutdown. */
	readonly cancelHooks = new Map<string, () => void>();
	readonly cancelled = new Set<string>();
	/** Every spawned `runEvent` task, so `stop()` can drain in-flight work. */
	readonly inflightTasks = new Map<Promise<unknown>, InflightTask>();
	shuttingDown = false;
	/**
	 * Deliveries `stop()` deliberately interrupted. Only these suppress
	 * `markEvent(..., 'failed')`; an unrelated failure during the drain
	 * window still marks failed.
	 */
	readonly shutdownCancelled = new Set<string>();

	constructor(options: WorkerPoolOptions) {
		this.settings = options.settings;
		this.db = options.db;
		this.github = options.github;
		this.sandbox = options.sandbox;
		this.gitTransport = options.gitTransport;
		if (options.slotPool) {
			this.slotPool = options.slotPool;
			this.#semaphore = null;
		} else if (currentEuid() === 0) {
			this.slotPool = new SlotPool(Array.from({ length: options.settings.max_concurrency }, (_, i) => 2001 + i));
			this.#semaphore = null;
		} else {
			this.slotPool = null;
			this.#semaphore = new Semaphore(options.settings.max_concurrency);
		}
	}

	/** Signal that new work is available. */
	wake(): void {
		this.#wakeup.resolve();
	}

	/** Stable, sorted snapshot of currently in-flight issue keys. */
	inflightSnapshot(): string[] {
		return [...this.#inflight].sort();
	}

	#reapAllSlots(): void {
		if (this.slotPool === null) return;
		for (const uid of this.slotPool.slotUids) sandboxMod.reapSlot(uid);
	}

	async start(): Promise<void> {
		this.#reapAllSlots();
		if (this.settings.reclaim_workspace_caches) {
			// Crash leftovers: strip dependency caches before the dispatcher runs.
			const swept = await this.sandbox.reclaimAllCaches();
			if (swept) log.info("workspace cache sweep", { workspaces: swept });
		}
		const recovered = this.db.resetStuckRunning();
		if (recovered) log.info("recovered stuck events", { count: recovered });
		this.#workers.push(this.#dispatchLoop());
		// Periodic natives-cache GC; sleep-first so a restart doesn't burn CPU.
		if (this.sandbox.nativesCache !== null && this.settings.natives_cache_gc_interval_seconds > 0) {
			this.#workers.push(this.#nativesCacheGcLoop());
		}
	}

	/**
	 * Halt the dispatcher, then drain (or kill) in-flight `runEvent` tasks.
	 *
	 * Interrupted tasks leave their DB row `running` so the next `start()`
	 * requeues them via `resetStuckRunning()`; the resumed omp session picks up
	 * via `--continue`.
	 */
	async stop(options: { drainTimeout?: number; killTimeout?: number } = {}): Promise<void> {
		const drainTimeout = options.drainTimeout ?? 25;
		const killTimeout = options.killTimeout ?? 5;
		this.shuttingDown = true;
		this.#stop.abort();
		this.#wakeup.resolve();
		// 1. Halt the dispatcher (no new claims).
		await Promise.allSettled(this.#workers.splice(0));
		// 2. Give in-flight tasks a chance to drain.
		const pending = [...this.inflightTasks.keys()];
		if (pending.length === 0) return;
		log.info("draining in-flight tasks", { count: pending.length, timeout: drainTimeout });
		const stillRunning = await waitAll(pending, drainTimeout);
		if (stillRunning.length === 0) return;
		// 3. Time's up — fire each task's cancel hook if armed (kills omp);
		//    otherwise abort the task itself so a worker stuck pre-hook cannot
		//    spawn a fresh subprocess after stop() returns.
		log.warning("shutdown timeout; interrupting in-flight tasks", { count: stillRunning.length });
		for (const task of stillRunning) {
			const entry = this.inflightTasks.get(task);
			if (entry === undefined || entry.deliveryId === null) {
				entry?.controller.abort();
				continue;
			}
			const deliveryId = entry.deliveryId;
			this.shutdownCancelled.add(deliveryId);
			const hook = this.cancelHooks.get(deliveryId);
			this.cancelHooks.delete(deliveryId);
			if (hook !== undefined) {
				try {
					hook();
				} catch (err) {
					log.exception("shutdown hook raised", err, { delivery: deliveryId });
				}
				continue;
			}
			entry.controller.abort();
		}
		// 4. Brief wait for the exception path / cancellation to settle.
		await waitAll(stillRunning, killTimeout);
	}

	async #nativesCacheGcLoop(): Promise<void> {
		const cache = this.sandbox.nativesCache;
		if (cache === null) return;
		const interval = this.settings.natives_cache_gc_interval_seconds;
		log.info("natives_cache gc loop online", { interval });
		while (!this.#stop.signal.aborted) {
			if (await sleepUnless(interval * 1000, this.#stop.signal)) return;
			try {
				const evicted = await cache.gc();
				if (evicted) log.info("natives_cache gc swept", { evicted });
			} catch (err) {
				log.exception("natives_cache gc raised", err);
			}
		}
	}

	async #dispatchLoop(): Promise<void> {
		log.info("dispatch loop online");
		try {
			while (!this.#stop.signal.aborted) {
				const row = await this.#claimNextUnique();
				if (row === null) {
					this.#wakeup = Promise.withResolvers<void>();
					await Promise.race([this.#wakeup.promise, sleepUnless(10_000, this.#stop.signal)]);
					continue;
				}
				// The slot pool caps concurrent execution.
				this.spawnEvent(row);
			}
		} catch (err) {
			log.exception("dispatch loop crashed", err);
		}
	}

	/** Schedule `runEvent(row)` and track it for shutdown draining. */
	spawnEvent(row: EventRow): Promise<void> {
		const controller = new AbortController();
		const task = this.runEvent(row, controller.signal);
		this.inflightTasks.set(task, { deliveryId: row.delivery_id, controller });
		void task.finally(() => this.inflightTasks.delete(task));
		return task;
	}

	/** Claim the next event whose issue isn't already in flight. */
	async #claimNextUnique(): Promise<EventRow | null> {
		const row = this.db.claimNextEvent();
		if (row === null) return null;
		const key = row.issue_key || row.delivery_id;
		if (this.#inflight.has(key)) {
			// Another in-flight task is touching the same issue; put it back.
			this.db.requeueEvent(row.delivery_id, { from_states: ["running"] });
			await sleepUnless(500, this.#stop.signal);
			return null;
		}
		this.#inflight.add(key);
		return row;
	}

	#release(row: EventRow): void {
		this.#inflight.delete(row.issue_key || row.delivery_id);
	}

	/** Worker-side: install the cancel hook, firing it at once if already cancelled. */
	armCancel(deliveryId: string, hook: () => void): void {
		if (this.cancelled.has(deliveryId)) {
			try {
				hook();
			} catch (err) {
				log.exception("late cancel fire failed", err, { delivery: deliveryId });
			}
			return;
		}
		this.cancelHooks.set(deliveryId, hook);
	}

	/** Worker-side: clear the cancel hook (the resource is gone). */
	disarmCancel(deliveryId: string): void {
		this.cancelHooks.delete(deliveryId);
	}

	/**
	 * Request cancellation of a running event. Returns whether a hook fired.
	 * The request is recorded regardless so a late-armed hook still sees it.
	 */
	async cancelEvent(deliveryId: string): Promise<boolean> {
		this.cancelled.add(deliveryId);
		const hook = this.cancelHooks.get(deliveryId);
		if (hook === undefined) return false;
		this.cancelHooks.delete(deliveryId);
		try {
			hook();
		} catch (err) {
			log.exception("cancel hook raised", err, { delivery: deliveryId });
		}
		return true;
	}

	/** Run one claimed event end to end (slot acquire → dispatch → mark → cleanup). */
	runEvent(row: EventRow, signal?: AbortSignal): Promise<void> {
		return runWithCurrentEvent(this, row.delivery_id, () => this.#runEventScoped(row, signal));
	}

	async #runEventScoped(row: EventRow, signal: AbortSignal | undefined): Promise<void> {
		let slotUid: number | null = null;
		let slotAcquired = false;
		try {
			if (this.slotPool !== null) {
				slotUid = await this.slotPool.acquire();
				slotAcquired = true;
				signal?.throwIfAborted();
				await this.#dispatchAndMark(row, slotUid, signal);
			} else if (this.#semaphore !== null) {
				await this.#semaphore.acquire();
				try {
					signal?.throwIfAborted();
					await this.#dispatchAndMark(row, null, signal);
				} finally {
					this.#semaphore.release();
				}
			} else {
				await this.#dispatchAndMark(row, null, signal);
			}
		} catch (err) {
			if (this.shutdownCancelled.has(row.delivery_id)) {
				// stop() interrupted this delivery: leave the row `running` so the
				// next start() requeues it and omp resumes via `--continue`.
				log.info("event interrupted by shutdown", { delivery: row.delivery_id, key: row.issue_key });
			} else if (this.cancelled.has(row.delivery_id)) {
				log.info("event cancelled", { delivery: row.delivery_id });
				this.db.markEvent(row.delivery_id, "failed", "cancelled by operator");
			} else {
				const message = err instanceof Error ? err.message : String(err);
				const error = `${message}\n${formatException(err)}`;
				const maxRetries = this.settings.event_max_retries;
				const delay = this.settings.retryDelaySeconds(row.attempts);
				if (
					row.attempts > 0 &&
					row.attempts <= maxRetries &&
					this.db.scheduleRetry(row.delivery_id, { delay_seconds: delay, error })
				) {
					log.warning("event retry scheduled", {
						delivery: row.delivery_id,
						key: row.issue_key,
						attempt: row.attempts,
						max_retries: maxRetries,
						retry_in_seconds: Math.round(delay * 10) / 10,
					});
				} else {
					log.exception("event handler failed", err, { delivery: row.delivery_id });
					this.db.markEvent(row.delivery_id, "failed", error);
				}
			}
		} finally {
			this.cancelled.delete(row.delivery_id);
			this.shutdownCancelled.delete(row.delivery_id);
			this.cancelHooks.delete(row.delivery_id);
			if (slotAcquired && this.slotPool !== null) {
				try {
					sandboxMod.reapSlot(slotUid);
				} finally {
					this.slotPool.release(slotUid);
				}
			}
			await this.#reclaimEventCaches(row);
			this.#release(row);
		}
	}

	/**
	 * Drop the workspace's dependency caches now that its event is over. Runs
	 * before release so nothing can re-enter `ensureWorkspace` mid-reclaim;
	 * skipped during shutdown; best-effort.
	 */
	async #reclaimEventCaches(row: EventRow): Promise<void> {
		if (!this.settings.reclaim_workspace_caches || this.shuttingDown) return;
		const key = row.issue_key || "";
		const sep = key.lastIndexOf("#");
		if (sep < 0) return;
		const repo = key.slice(0, sep);
		const number = key.slice(sep + 1);
		if (!repo || !/^\d+$/.test(number)) return;
		let reclaimed: boolean;
		try {
			reclaimed = await this.sandbox.reclaimWorkspaceCaches({ repo, number: Number(number) });
		} catch (err) {
			log.warning("workspace cache reclaim failed", {
				key: row.issue_key,
				err: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		if (reclaimed) log.info("workspace caches reclaimed", { key: row.issue_key });
	}

	async #dispatchAndMark(row: EventRow, slotUid: number | null, signal: AbortSignal | undefined): Promise<void> {
		await this.dispatch(row, slotUid, signal);
		if (this.cancelled.has(row.delivery_id)) {
			this.db.markEvent(row.delivery_id, "failed", "cancelled by operator");
		} else {
			this.db.markEvent(row.delivery_id, "done");
		}
	}

	/** Route one event to its task handler. */
	async dispatch(row: EventRow, slotUid: number | null = null, signal?: AbortSignal): Promise<void> {
		const event = row.event_type;
		const payload = row.payload as Json;
		const action = String(payload.action || "");
		log.info("dispatch", {
			event,
			action,
			delivery: row.delivery_id,
			key: row.issue_key,
			attempts: row.attempts,
			recovered: row.attempts >= 2,
		});
		const args: tasks.TaskArgs = {
			settings: this.settings,
			db: this.db,
			github: this.github,
			sandbox: this.sandbox,
			gitTransport: this.gitTransport,
			payload,
			deliveryId: row.delivery_id,
			attempts: row.attempts,
			slotUid,
			signal: signal ?? null,
		};
		if (event === "issues" && (action === "opened" || action === "reopened")) {
			await tasks.triageIssue(args);
		} else if (event === "workflow_run" && action === "completed") {
			await tasks.handleReleaseCi(args);
		} else if (event === "issue_comment" && action === "created") {
			const issue = payload.issue;
			if (typeof issue === "object" && issue !== null && "pull_request" in issue) {
				await tasks.handlePrConversation(args);
			} else {
				await tasks.handleComment(args);
			}
		} else if (
			event === "pull_request" &&
			(action === "opened" || action === "reopened" || action === "ready_for_review" || action === "labeled")
		) {
			await tasks.reviewPr(args);
		} else if (event === "pull_request_review_comment" && action === "created") {
			await tasks.handleReview(args);
		} else if (event === "issues" && action === "closed") {
			await tasks.cleanupWorkspace({
				db: this.db,
				sandbox: this.sandbox,
				payload,
				targetState: "closed",
				signal,
			});
		} else if (event === "pull_request" && action === "closed") {
			const pr = payload.pull_request;
			const merged = typeof pr === "object" && pr !== null && Boolean((pr as Record<string, unknown>).merged);
			await tasks.cleanupWorkspace({
				db: this.db,
				sandbox: this.sandbox,
				payload,
				targetState: merged ? "merged" : "closed",
				signal,
			});
		} else {
			log.info("no-op dispatch", { event, action });
		}
	}
}

/** Wait up to `timeoutSeconds` for `tasks`; return those still unsettled. */
async function waitAll(pending: Promise<unknown>[], timeoutSeconds: number): Promise<Promise<unknown>[]> {
	const done = new Set<Promise<unknown>>();
	for (const task of pending) {
		void task.then(
			() => done.add(task),
			() => done.add(task),
		);
	}
	const all = Promise.allSettled(pending);
	await Promise.race([all, Bun.sleep(timeoutSeconds * 1000)]);
	// Let settle callbacks registered above run.
	await Bun.sleep(0);
	return pending.filter(task => !done.has(task));
}
