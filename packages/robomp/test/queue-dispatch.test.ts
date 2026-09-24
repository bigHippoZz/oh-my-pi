/** Dispatch action → task mapping in WorkerPool.dispatch (port of test_queue_dispatch.py). */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as tasks from "../src/tasks";
import { makeDb, makeSettings } from "./helpers";
import { eventRow, makePool } from "./queue-helpers";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function recordPayloadAction(fn: "triageIssue" | "reviewPr" | "handleReleaseCi", seen: unknown[]): void {
	const spy = spyOn(tasks, fn).mockImplementation(async args => {
		seen.push(fn === "handleReleaseCi" ? [String(args.payload.action), args.attempts] : String(args.payload.action));
	});
	restores.push(() => spy.mockRestore());
}

function prRow(action: string) {
	return eventRow({
		delivery_id: "pr1",
		event_type: "pull_request",
		issue_key: "octo/widget#7",
		payload: { action, pull_request: { number: 7 } },
	});
}

for (const action of ["opened", "reopened"]) {
	test(`dispatch routes issues.${action} to triageIssue`, async () => {
		const seen: unknown[] = [];
		recordPayloadAction("triageIssue", seen);
		const row = eventRow({
			delivery_id: "is1",
			issue_key: "octo/widget#4",
			payload: { action, issue: { number: 4 } },
		});
		await makePool(makeSettings(), makeDb()).dispatch(row);
		expect(seen).toEqual([action]);
	});
}

for (const action of ["opened", "reopened", "ready_for_review"]) {
	test(`dispatch routes pull_request.${action} to reviewPr`, async () => {
		const seen: unknown[] = [];
		recordPayloadAction("reviewPr", seen);
		await makePool(makeSettings(), makeDb()).dispatch(prRow(action));
		expect(seen).toEqual([action]);
	});
}

test("dispatch pull_request.synchronize is a no-op", async () => {
	const seen: unknown[] = [];
	recordPayloadAction("reviewPr", seen);
	await makePool(makeSettings(), makeDb()).dispatch(prRow("synchronize"));
	expect(seen).toEqual([]);
});

test("dispatch routes completed workflow to the release handler", async () => {
	const seen: unknown[] = [];
	recordPayloadAction("handleReleaseCi", seen);
	const row = eventRow({
		delivery_id: "release-1",
		event_type: "workflow_run",
		issue_key: "octo/widget#release",
		payload: { action: "completed", workflow_run: { id: 10 } },
		attempts: 2,
	});
	await makePool(makeSettings(), makeDb()).dispatch(row);
	expect(seen).toEqual([["completed", 2]]);
});
