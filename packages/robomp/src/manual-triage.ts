/**
 * Manually enqueue an issue as if a webhook arrived.
 * Shared by the `robomp triage` CLI and the dashboard's POST /api/trigger.
 */
import { type Database, type EventRow, INACTIVE_EVENT_STATES, issueKey } from "./db";
import type { GitHubBackend } from "./github-backend";
import type { Json } from "./github-client";

const ISSUE_REF = /^(?<owner>[^/\s]+)\/(?<repo>[^#\s]+)#(?<number>\d+)$/;
const ISSUE_URL =
	/^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+)\/issues\/(?<number>\d+)(?:[/?#].*)?$/;

/** The user-supplied issue reference can't be parsed. */
export class InvalidIssueRef extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidIssueRef";
	}
}

/** A live GitHub issue cannot be manually triaged. */
export class ManualTriageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManualTriageError";
	}
}

/** A stable manual delivery id is already active. */
export class ManualTriageConflict extends Error {
	constructor(
		readonly deliveryId: string,
		readonly state: string,
	) {
		super(`${deliveryId} is already ${state}`);
		this.name = "ManualTriageConflict";
	}
}

/** A manual CLI waiter stopped before a terminal state. */
export class ManualTriageTimeout extends Error {
	constructor(
		readonly deliveryId: string,
		readonly state: string,
		readonly timeoutSeconds: number,
	) {
		super(`${deliveryId} did not reach a terminal state within ${timeoutSeconds}s (state=${state})`);
		this.name = "ManualTriageTimeout";
	}
}

/** Parse `owner/repo#NN` or a GitHub issue url into `["owner/repo", NN]`. */
export function parseIssueRef(ref: string): [string, number] {
	const cleaned = ref.trim();
	const match = ISSUE_REF.exec(cleaned) ?? ISSUE_URL.exec(cleaned);
	if (!match?.groups) {
		throw new InvalidIssueRef(`expected owner/repo#NN or https://github.com/owner/repo/issues/NN, got '${ref}'`);
	}
	return [`${match.groups.owner}/${match.groups.repo}`, Number.parseInt(match.groups.number!, 10)];
}

/** Stable delivery id for manually-triggered triage. Re-runs reuse it. */
export function manualDeliveryId(repoFull: string, number: number): string {
	return `manual-${repoFull.replaceAll("/", "__")}-${number}`;
}

/** Fetch the issue + repo metadata and synthesize an `issues.opened` payload. */
export async function buildIssuesOpenedPayload(
	github: Pick<GitHubBackend, "getIssue" | "getRepo">,
	repoFull: string,
	number: number,
): Promise<Json> {
	const issue = await github.getIssue(repoFull, number);
	if (issue.is_pull_request) throw new ManualTriageError(`${repoFull}#${number} is a pull request, not an issue`);
	const repo = await github.getRepo(repoFull);
	return {
		action: "opened",
		issue: {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			state: issue.state,
			user: { login: issue.author },
			labels: issue.labels.map(name => ({ name })),
		},
		repository: {
			full_name: repo.full_name,
			default_branch: repo.default_branch,
			clone_url: repo.clone_url,
			private: repo.private,
		},
	};
}

/** Fetch the issue from GitHub and queue it for the worker pool; returns the delivery id. */
export async function enqueueManualTriage(args: {
	db: Database;
	github: Pick<GitHubBackend, "getIssue" | "getRepo">;
	repoFull: string;
	number: number;
}): Promise<string> {
	const { db, repoFull, number } = args;
	const delivery = manualDeliveryId(repoFull, number);
	const existing = db.getEvent(delivery);
	if (existing !== null && (existing.state === "queued" || existing.state === "running")) {
		throw new ManualTriageConflict(delivery, existing.state);
	}
	const payload = await buildIssuesOpenedPayload(args.github, repoFull, number);
	const replaced = db.replaceEventIfStateIn({
		delivery_id: delivery,
		event_type: "issues",
		repo: repoFull,
		issue_key: issueKey(repoFull, number),
		payload,
		state: "queued",
		allowed_existing_states: INACTIVE_EVENT_STATES,
	});
	if (!replaced) throw new ManualTriageConflict(delivery, db.getEvent(delivery)?.state ?? "active");
	return delivery;
}

const TERMINAL_STATES = new Set(["done", "failed", "skipped"]);

/**
 * Block until the event row reaches a terminal state, vanishes (null), or
 * times out (`ManualTriageTimeout`). Pure DB polling.
 */
export async function awaitTerminalState(
	db: Database,
	deliveryId: string,
	options: { pollInterval?: number; timeout?: number | null } = {},
): Promise<EventRow | null> {
	const pollInterval = options.pollInterval ?? 2;
	const timeout = options.timeout ?? null;
	const deadline = timeout === null ? null : performance.now() + timeout * 1000;
	for (;;) {
		const row = db.getEvent(deliveryId);
		if (row === null) return null;
		if (TERMINAL_STATES.has(row.state)) return row;
		let sleepFor = pollInterval;
		if (deadline !== null) {
			const remaining = (deadline - performance.now()) / 1000;
			if (remaining <= 0) throw new ManualTriageTimeout(deliveryId, row.state, timeout!);
			sleepFor = Math.min(pollInterval, remaining);
		}
		await Bun.sleep(sleepFor * 1000);
	}
}
