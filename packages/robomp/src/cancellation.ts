/**
 * Per-event cancellation primitives shared by `WorkerPool` and the workers.
 *
 * The dispatcher opens a scope binding `(pool, deliveryId)` for the lifetime
 * of a single event. Workers call `registerCancelHook` / `unregisterCancelHook`
 * from inside that scope to attach a stop callable the pool can fire on demand.
 * `AsyncLocalStorage` propagates the scope across awaits.
 *
 * Kept in its own module so `worker.ts` doesn't have to import `queue.ts`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Just the slice of `WorkerPool` the helpers below depend on. */
export interface CancelSink {
	armCancel(deliveryId: string, hook: () => void): void;
	disarmCancel(deliveryId: string): void;
}

interface EventScope {
	sink: CancelSink;
	deliveryId: string;
}

const currentEvent = new AsyncLocalStorage<EventScope>();

/** Run `fn` inside a per-event cancellation scope. */
export function runWithCurrentEvent<T>(sink: CancelSink, deliveryId: string, fn: () => T): T {
	return currentEvent.run({ sink, deliveryId }, fn);
}

/** Arm cancellation for the event currently running. No-op outside a scope. */
export function registerCancelHook(hook: () => void): void {
	const ctx = currentEvent.getStore();
	if (!ctx) return;
	ctx.sink.armCancel(ctx.deliveryId, hook);
}

/** Disarm cancellation for the current event. Idempotent. */
export function unregisterCancelHook(): void {
	const ctx = currentEvent.getStore();
	if (!ctx) return;
	ctx.sink.disarmCancel(ctx.deliveryId);
}

/** Delivery id of the event scope currently active, if any. */
export function currentDeliveryId(): string | undefined {
	return currentEvent.getStore()?.deliveryId;
}
