/**
 * Local issue/PR search index: webhook ingest, periodic reconcile, query parsing.
 *
 * `issue_index` mirrors every issue and PR of the allowlisted repos so
 * `gh_search_issues` answers from SQLite FTS5 instead of the GitHub search
 * API. Webhooks upsert in real time; `IssueIndexSync` reconciles each repo
 * periodically (backfilling on first run).
 */
import { PeriodicLoop } from "./background";
import type { Settings } from "./config";
import type { Database } from "./db";
import type { GitHubBackend } from "./github-backend";
import { GitHubError, indexEntryFromIssueObject, indexEntryFromPrObject, isMapping, type Json } from "./github-client";
import { getLogger } from "./logging";

const log = getLogger("robomp.issue_index");

/** Overlap subtracted from the watermark on every reconcile. */
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_TICK = 30;

/** Structured form of a GitHub-issue-search style query string. */
export interface ParsedSearchQuery {
	keywords: readonly string[];
	is_pr: boolean | null;
	state: string | null;
	merged: boolean | null;
	label: string | null;
	author: string | null;
}

/**
 * Split a GitHub-search style string into keywords + structured filters.
 * Supported: `is:pr|issue|open|closed|merged`, `label:<name>`, `author:<login>`.
 * Other `key:value` qualifiers are dropped rather than fed to FTS5.
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
	const out: ParsedSearchQuery = { keywords: [], is_pr: null, state: null, merged: null, label: null, author: null };
	const keywords: string[] = [];
	for (const token of query.split(/\s+/).filter(Boolean)) {
		const idx = token.indexOf(":");
		const rawKey = idx < 0 ? token : token.slice(0, idx);
		const value = idx < 0 ? "" : token.slice(idx + 1);
		if (idx < 0 || !value || rawKey.includes(" ")) {
			keywords.push(token);
			continue;
		}
		const key = rawKey.toLowerCase();
		if (key === "is") {
			const v = value.toLowerCase();
			if (v === "pr") out.is_pr = true;
			else if (v === "issue") out.is_pr = false;
			else if (v === "open" || v === "closed") out.state = v;
			else if (v === "merged") {
				out.is_pr = true;
				out.merged = true;
			}
		} else if (key === "label") {
			out.label = value.replace(/^"+|"+$/g, "");
		} else if (key === "author") {
			out.author = value.replace(/^@+/, "");
		}
	}
	return { ...out, keywords };
}

/**
 * Upsert the issue/PR carried by a webhook delivery into the index. Returns
 * true when the payload contained an indexable object.
 */
export function ingestWebhookPayload(db: Database, repo: string, eventType: string, payload: Json): boolean {
	if (eventType === "issues" || eventType === "issue_comment") {
		const obj = payload.issue;
		if (isMapping(obj) && obj.number !== null && obj.number !== undefined) {
			db.upsertIssueIndex(indexEntryFromIssueObject(repo, obj));
			return true;
		}
		return false;
	}
	if (eventType.startsWith("pull_request")) {
		const obj = payload.pull_request;
		if (isMapping(obj) && obj.number !== null && obj.number !== undefined) {
			db.upsertIssueIndex(indexEntryFromPrObject(repo, obj));
			return true;
		}
		return false;
	}
	return false;
}

function isoSeconds(date: Date): string {
	return `${date.toISOString().slice(0, 19)}Z`;
}

/** Rewind an ISO watermark by the sync overlap; fall back to the raw value. */
function overlapped(watermark: string): string {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(watermark)) return watermark;
	const parsed = Date.parse(watermark);
	if (Number.isNaN(parsed)) return watermark;
	return isoSeconds(new Date(parsed - SYNC_OVERLAP_MS));
}

type SyncSettings = Pick<Settings, "issue_index_sync_seconds" | "repo_allowlist">;

/** Background reconciler for the local issue index. */
export class IssueIndexSync {
	readonly #settings: SyncSettings;
	readonly #db: Database;
	readonly #github: Pick<GitHubBackend, "listIssueIndexEntries">;
	readonly #loop: PeriodicLoop;

	constructor(args: { settings: SyncSettings; db: Database; github: Pick<GitHubBackend, "listIssueIndexEntries"> }) {
		this.#settings = args.settings;
		this.#db = args.db;
		this.#github = args.github;
		this.#loop = new PeriodicLoop(
			"issue-index-sync",
			() => this.#settings.issue_index_sync_seconds,
			() => this.tick(),
			{
				errorMessage: "issue index sync tick failed",
				loggerName: "robomp.issue_index",
			},
		);
	}

	get enabled(): boolean {
		return this.#settings.issue_index_sync_seconds > 0;
	}

	async start(): Promise<void> {
		if (!this.enabled) {
			log.info("issue index sync disabled");
			return;
		}
		if (this.#loop.running) return;
		this.#loop.start();
		log.info("issue index sync started", { interval_seconds: this.#settings.issue_index_sync_seconds });
	}

	stop(): Promise<void> {
		return this.#loop.stop();
	}

	/** Reconcile every allowlisted repo once. */
	async tick(): Promise<void> {
		for (const repo of this.#settings.repo_allowlist) {
			try {
				await this.syncRepo(repo);
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				log.warning("issue index sync failed; will retry next tick", {
					repo,
					status: err.status,
					gh_message: err.detail,
				});
			}
		}
	}

	/** Pull updated issues/PRs for one repo into the index. Returns count ingested. */
	async syncRepo(repo: string): Promise<number> {
		const startedAt = isoSeconds(new Date());
		const watermark = this.#db.issueIndexWatermark(repo);
		const since = watermark ? overlapped(watermark) : null;
		let ingested = 0;
		let exhausted = false;
		let lastSeen = "";
		for (let page = 1; page <= MAX_PAGES_PER_TICK; page++) {
			const batch = await this.#github.listIssueIndexEntries(repo, { since, page, per_page: PAGE_SIZE });
			for (const entry of batch) {
				this.#db.upsertIssueIndex(entry);
				if (entry.updated_at > lastSeen) lastSeen = entry.updated_at;
			}
			ingested += batch.length;
			if (batch.length < PAGE_SIZE) {
				exhausted = true;
				break;
			}
		}
		if (exhausted) this.#db.setIssueIndexWatermark(repo, startedAt);
		else if (lastSeen) this.#db.setIssueIndexWatermark(repo, lastSeen);
		log.info("issue index synced", { repo, ingested, backfill: watermark === null, complete: exhausted });
		return ingested;
	}
}
