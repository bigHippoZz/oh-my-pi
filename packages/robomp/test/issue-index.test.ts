import { describe, expect, test } from "bun:test";
import type { IssueIndexEntry } from "../src/github-client";
import { IssueIndexSync, ingestWebhookPayload, parseSearchQuery } from "../src/issue-index";
import { makeDb } from "./helpers";

function entry(number: number, overrides: Partial<IssueIndexEntry> = {}): IssueIndexEntry {
	return {
		repo: "octo/widget",
		number,
		is_pull_request: false,
		title: `issue ${number}`,
		body: "",
		state: "open",
		state_reason: "",
		merged_at: "",
		author: "alice",
		labels: [],
		comments: 0,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		html_url: `https://example/${number}`,
		...overrides,
	};
}

describe("parseSearchQuery", () => {
	test("extracts supported qualifiers", () => {
		const parsed = parseSearchQuery("colon selector is:pr is:merged label:bug author:@alice in:title");
		expect(parsed).toMatchObject({
			keywords: ["colon", "selector"],
			is_pr: true,
			merged: true,
			label: "bug",
			author: "alice",
		});
	});
	test("state and issue kind", () => {
		expect(parseSearchQuery("is:issue is:closed crash")).toMatchObject({
			is_pr: false,
			state: "closed",
			keywords: ["crash"],
		});
	});
});

describe("db index", () => {
	test("matches body text and ranks", () => {
		const db = makeDb();
		db.upsertIssueIndex(entry(1, { title: "TUI crash on resize", body: "stack trace mentions overlay" }));
		db.upsertIssueIndex(entry(2, { title: "unrelated docs typo", body: "readme wording" }));
		expect(db.searchIssueIndex("octo/widget", { keywords: ["resize", "crash"] }).map(e => e.number)).toEqual([1]);
		expect(db.searchIssueIndex("octo/widget", { keywords: ["overlay"] }).map(e => e.number)).toEqual([1]);
	});

	test("filters", () => {
		const db = makeDb();
		db.upsertIssueIndex(
			entry(1, { title: "fix crash", is_pull_request: true, merged_at: "2026-02-01T00:00:00Z", state: "closed" }),
		);
		db.upsertIssueIndex(
			entry(2, { title: "crash report", state: "closed", state_reason: "not_planned", labels: ["wontfix"] }),
		);
		db.upsertIssueIndex(entry(3, { title: "crash report open", state: "open" }));
		expect(
			db.searchIssueIndex("octo/widget", { keywords: ["crash"], is_pr: true, merged: true }).map(e => e.number),
		).toEqual([1]);
		expect(db.searchIssueIndex("octo/widget", { keywords: ["crash"], label: "wontfix" }).map(e => e.number)).toEqual([
			2,
		]);
		expect(db.searchIssueIndex("octo/widget", { keywords: ["crash"], state: "open" }).map(e => e.number)).toEqual([
			3,
		]);
	});

	test("upsert refreshes FTS so stale text stops matching", () => {
		const db = makeDb();
		db.upsertIssueIndex(entry(1, { title: "original scrollback wipe" }));
		db.upsertIssueIndex(entry(1, { title: "renamed: alternate screen request", state: "closed" }));
		expect(db.searchIssueIndex("octo/widget", { keywords: ["scrollback"] })).toEqual([]);
		const found = db.searchIssueIndex("octo/widget", { keywords: ["alternate"] });
		expect(found).toHaveLength(1);
		expect(found[0]!.state).toBe("closed");
	});

	test("quotes FTS metacharacters", () => {
		const db = makeDb();
		db.upsertIssueIndex(entry(1, { title: 'crash with "quoted" AND (parens)' }));
		expect(
			db.searchIssueIndex("octo/widget", { keywords: ['"quoted"', "AND", "(parens)"] }).map(e => e.number),
		).toEqual([1]);
	});

	test("watermark round trip", () => {
		const db = makeDb();
		expect(db.issueIndexWatermark("octo/widget")).toBeNull();
		db.setIssueIndexWatermark("octo/widget", "2026-07-01T00:00:00Z");
		expect(db.issueIndexWatermark("octo/widget")).toBe("2026-07-01T00:00:00Z");
		db.setIssueIndexWatermark("octo/widget", "2026-07-02T00:00:00Z");
		expect(db.issueIndexWatermark("octo/widget")).toBe("2026-07-02T00:00:00Z");
	});
});

test("webhook ingest for issue and PR payloads", () => {
	const db = makeDb();
	expect(
		ingestWebhookPayload(db, "octo/widget", "issues", {
			issue: { number: 5, title: "boom", body: "b", state: "open", user: { login: "alice" } },
		}),
	).toBe(true);
	ingestWebhookPayload(db, "octo/widget", "issue_comment", {
		issue: {
			number: 6,
			title: "fixes boom",
			state: "closed",
			user: { login: "bob" },
			pull_request: { merged_at: "2026-03-01T00:00:00Z" },
		},
	});
	ingestWebhookPayload(db, "octo/widget", "pull_request", {
		pull_request: { number: 7, title: "another fix", state: "closed", merged_at: "2026-04-01T00:00:00Z" },
	});
	expect(ingestWebhookPayload(db, "octo/widget", "push", { ref: "refs/heads/main" })).toBe(false);
	const boom = db.searchIssueIndex("octo/widget", { keywords: ["boom"] });
	expect(new Set(boom.map(e => e.number))).toEqual(new Set([5, 6]));
	const pr6 = boom.find(e => e.number === 6)!;
	expect(pr6.is_pull_request).toBe(true);
	expect(pr6.merged_at).toBe("2026-03-01T00:00:00Z");
	const pr7 = db.searchIssueIndex("octo/widget", { keywords: ["another"] })[0]!;
	expect(pr7.is_pull_request).toBe(true);
	expect(pr7.merged_at).toBe("2026-04-01T00:00:00Z");
});

test("syncRepo backfills pages and sets the watermark", async () => {
	const db = makeDb();
	const calls: [string | null | undefined, number | undefined][] = [];
	let pages: Record<number, IssueIndexEntry[]> = {
		1: Array.from({ length: 100 }, (_, i) =>
			entry(i + 1, { updated_at: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
		),
		2: [entry(101, { updated_at: "2026-07-01T00:00:00Z" })],
	};
	const backend = {
		listIssueIndexEntries: async (_repo: string, options: { since?: string | null; page?: number } = {}) => {
			calls.push([options.since, options.page]);
			return pages[options.page ?? 1] ?? [];
		},
	};
	const sync = new IssueIndexSync({
		settings: { issue_index_sync_seconds: 900, repo_allowlist: new Set(["octo/widget"]) },
		db,
		github: backend,
	});
	expect(await sync.syncRepo("octo/widget")).toBe(101);
	expect(calls).toEqual([
		[null, 1],
		[null, 2],
	]);
	expect(db.issueIndexWatermark("octo/widget")).not.toBeNull();
	expect(db.searchIssueIndex("octo/widget", { keywords: ["issue"], limit: 5 }).length).toBeGreaterThan(0);
	calls.length = 0;
	pages = { 1: [] };
	await sync.syncRepo("octo/widget");
	expect(calls.length).toBeGreaterThan(0);
	expect(calls[0]![0]).not.toBeNull();
});
