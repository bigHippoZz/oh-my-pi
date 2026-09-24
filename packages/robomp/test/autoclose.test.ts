import { expect, test } from "bun:test";
import { AutocloseScheduler } from "../src/autoclose";
import { type Database, issueKey } from "../src/db";
import { GitHubError, type ReactionInfo } from "../src/github-client";
import { makeDb } from "./helpers";

const settings = (overrides: { enabled?: boolean; hours?: number; scan?: number } = {}) => ({
	question_autoclose_enabled: overrides.enabled ?? true,
	question_autoclose_hours: overrides.hours ?? 4,
	question_autoclose_scan_seconds: overrides.scan ?? 60,
});

class FakeGitHub {
	closeCalls: [string, number, string | undefined][] = [];
	reactionCalls: [string, number][] = [];
	constructor(
		readonly reactions: ReactionInfo[] = [],
		readonly closeError: GitHubError | null = null,
	) {}
	async listCommentReactions(repo: string, commentId: number): Promise<ReactionInfo[]> {
		this.reactionCalls.push([repo, commentId]);
		return this.reactions;
	}
	async closeIssue(repo: string, number: number, reason?: string): Promise<void> {
		this.closeCalls.push([repo, number, reason]);
		if (this.closeError) throw this.closeError;
	}
}

const KEY = issueKey("octo/widget", 42);
const seed = (db: Database, closeAt = "2000-01-01T00:00:00.000000Z") =>
	db.upsertPendingClosure({
		issue_key: KEY,
		repo: "octo/widget",
		number: 42,
		comment_id: 999,
		issue_author: "alice",
		close_at: closeAt,
	});

test("closes when there is no author downvote", async () => {
	const db = makeDb();
	seed(db);
	const gh = new FakeGitHub();
	expect(await new AutocloseScheduler({ settings: settings(), db, github: gh }).tick()).toEqual({
		closed: 1,
		cancelled: 0,
		retried: 0,
	});
	expect(gh.closeCalls).toEqual([["octo/widget", 42, "completed"]]);
	expect(db.getPendingClosure(KEY)).toMatchObject({ state: "closed", cancel_reason: null });
});

test("cancels when the author downvotes", async () => {
	const db = makeDb();
	seed(db);
	const gh = new FakeGitHub([{ content: "-1", user_login: "Alice", user_type: "User" }]);
	expect(await new AutocloseScheduler({ settings: settings(), db, github: gh }).tick()).toEqual({
		closed: 0,
		cancelled: 1,
		retried: 0,
	});
	expect(gh.closeCalls).toEqual([]);
	expect(db.getPendingClosure(KEY)).toMatchObject({ state: "cancelled", cancel_reason: "author_downvoted" });
});

test("ignores downvotes from non-authors", async () => {
	const db = makeDb();
	seed(db);
	const gh = new FakeGitHub([
		{ content: "-1", user_login: "rando", user_type: "User" },
		{ content: "-1", user_login: "some-bot", user_type: "Bot" },
	]);
	expect(await new AutocloseScheduler({ settings: settings(), db, github: gh }).tick()).toEqual({
		closed: 1,
		cancelled: 0,
		retried: 0,
	});
	expect(gh.closeCalls).toEqual([["octo/widget", 42, "completed"]]);
});

test("retries after a transient close error", async () => {
	const db = makeDb();
	seed(db);
	const gh = new FakeGitHub([], new GitHubError(502, "Bad Gateway"));
	expect(await new AutocloseScheduler({ settings: settings(), db, github: gh }).tick()).toEqual({
		closed: 0,
		cancelled: 0,
		retried: 1,
	});
	expect(db.getPendingClosure(KEY)?.state).toBe("pending");
});

test("treats a 404 close as already closed", async () => {
	const db = makeDb();
	seed(db);
	const gh = new FakeGitHub([], new GitHubError(404, "Not Found"));
	expect(await new AutocloseScheduler({ settings: settings(), db, github: gh }).tick()).toEqual({
		closed: 0,
		cancelled: 1,
		retried: 0,
	});
	expect(db.getPendingClosure(KEY)).toMatchObject({ state: "cancelled", cancel_reason: "already_closed" });
});

test("retries when listing reactions fails", async () => {
	const db = makeDb();
	seed(db);
	const gh = new FakeGitHub();
	gh.listCommentReactions = async () => {
		throw new GitHubError(503, "Service Unavailable");
	};
	expect(await new AutocloseScheduler({ settings: settings(), db, github: gh }).tick()).toEqual({
		closed: 0,
		cancelled: 0,
		retried: 1,
	});
	expect(db.getPendingClosure(KEY)?.state).toBe("pending");
});

test("skips future rows", async () => {
	const db = makeDb();
	seed(db, "2999-01-01T00:00:00.000000Z");
	const gh = new FakeGitHub();
	expect(await new AutocloseScheduler({ settings: settings(), db, github: gh }).tick()).toEqual({
		closed: 0,
		cancelled: 0,
		retried: 0,
	});
	expect(gh.closeCalls).toEqual([]);
	expect(db.getPendingClosure(KEY)?.state).toBe("pending");
});

test("disabled when the feature is off or hours is zero", () => {
	const db = makeDb();
	expect(
		new AutocloseScheduler({ settings: settings({ enabled: false }), db, github: new FakeGitHub() }).enabled,
	).toBe(false);
	expect(new AutocloseScheduler({ settings: settings({ hours: 0 }), db, github: new FakeGitHub() }).enabled).toBe(
		false,
	);
});

test("start is a noop when disabled", async () => {
	const sched = new AutocloseScheduler({
		settings: settings({ enabled: false }),
		db: makeDb(),
		github: new FakeGitHub(),
	});
	await sched.start();
	expect(sched.running).toBe(false);
	await sched.stop();
});
