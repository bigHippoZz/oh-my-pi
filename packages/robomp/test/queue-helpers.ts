/** Shared WorkerPool fixtures for the queue test files. */
import type { Settings } from "../src/config";
import type { Database, EventRow } from "../src/db";
import type { GitHubBackend } from "../src/github-backend";
import { WorkerPool } from "../src/queue";
import type { GitTransport, SandboxManager } from "../src/sandbox";
import { SlotPool } from "../src/slot-pool";

/** Sandbox stub: queue tests never touch the workspace pool. */
export const stubSandbox = {
	nativesCache: null,
	reclaimWorkspaceCaches: async () => false,
	reclaimAllCaches: async () => 0,
} as unknown as SandboxManager;

export function makePool(settings: Settings, db: Database, slotPool: SlotPool | null = new SlotPool()): WorkerPool {
	return new WorkerPool({
		settings,
		db,
		github: {} as GitHubBackend,
		sandbox: stubSandbox,
		gitTransport: {} as GitTransport,
		slotPool,
	});
}

export function eventRow(init: Partial<EventRow> & Pick<EventRow, "delivery_id">): EventRow {
	return {
		event_type: "issues",
		repo: "octo/widget",
		issue_key: "octo/widget#1",
		payload: { action: "opened" },
		received_at: "2026-01-01T00:00:00Z",
		state: "running",
		attempts: 1,
		last_error: null,
		...init,
	};
}

export function recordRunning(db: Database, deliveryId: string, issueKey = "octo/widget#1"): void {
	db.recordEvent({
		delivery_id: deliveryId,
		event_type: "issues",
		repo: "octo/widget",
		issue_key: issueKey,
		payload: { action: "opened" },
		state: "running",
	});
}
