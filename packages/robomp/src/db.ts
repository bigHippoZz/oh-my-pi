/**
 * SQLite-backed durable event queue + bot state.
 *
 * Schema, migrations, and timestamp format are byte-compatible with the
 * Python orchestrator so an existing `/data/robomp.sqlite` keeps working.
 */
import { Database as SqliteDatabase, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IssueIndexEntry } from "./github-client";

export type EventState = "queued" | "running" | "done" | "failed" | "skipped";
export const INACTIVE_EVENT_STATES: readonly EventState[] = ["done", "failed", "skipped"];

export type IssueState =
	| "new"
	| "reproducing"
	| "fixing"
	| "reviewing"
	| "opened"
	| "merged"
	| "closed"
	| "needs_info"
	| "abandoned";

export type ReleaseState = "awaiting_ci" | "fixing" | "green" | "failed" | "superseded";

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  delivery_id   TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  repo          TEXT,
  issue_key     TEXT,
  payload_json  TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  state         TEXT NOT NULL
    CHECK (state IN ('queued','running','done','failed','skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  model         TEXT
);

CREATE INDEX IF NOT EXISTS events_state_received
  ON events(state, received_at);

CREATE INDEX IF NOT EXISTS events_issue_state
  ON events(issue_key, state);

CREATE TABLE IF NOT EXISTS issues (
  key            TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  branch         TEXT,
  session_dir    TEXT,
  pr_number      INTEGER,
  state          TEXT NOT NULL,
  classification TEXT,         -- bug|enhancement|question|proposal|documentation|wontfix|invalid|duplicate
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS releases (
  key             TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,
  tag             TEXT NOT NULL,
  version         TEXT NOT NULL,
  state           TEXT NOT NULL
    CHECK (state IN ('awaiting_ci','fixing','green','failed','superseded')),
  current_sha     TEXT NOT NULL,
  last_failed_sha TEXT,
  rounds          INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  session_dir     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS releases_repo ON releases(repo, updated_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key     TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  result_json   TEXT,
  error         TEXT,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_issue ON tool_calls(issue_key, ts);

CREATE TABLE IF NOT EXISTS pr_review_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key   TEXT NOT NULL,
  path        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  side        TEXT NOT NULL DEFAULT 'RIGHT',
  start_line  INTEGER,
  start_side  TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_review_comments_key
  ON pr_review_comments(issue_key);

CREATE TABLE IF NOT EXISTS submissions (
  delivery_id   TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  repo          TEXT,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_login_ts ON submissions(login, ts);

CREATE TABLE IF NOT EXISTS pending_closures (
  issue_key     TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  number        INTEGER NOT NULL,
  comment_id    INTEGER NOT NULL,
  issue_author  TEXT NOT NULL,
  close_at      TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','claimed','closed','cancelled')),
  cancel_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_closures_state_close_at
  ON pending_closures(state, close_at);

-- Local mirror of every issue/PR in allowlisted repos, kept fresh by webhook
-- upserts plus the periodic \`IssueIndexSync\` reconciler. \`gh_search_issues\`
-- serves from here so triage lookups cost no GitHub API calls.
CREATE TABLE IF NOT EXISTS issue_index (
  repo         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  is_pr        INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'open',
  state_reason TEXT NOT NULL DEFAULT '',
  merged_at    TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  labels_json  TEXT NOT NULL DEFAULT '[]',
  comments     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT '',
  html_url     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS issue_index_repo_updated
  ON issue_index(repo, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS issue_index_fts USING fts5(
  title, body, content='issue_index', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS issue_index_ai AFTER INSERT ON issue_index BEGIN
  INSERT INTO issue_index_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS issue_index_ad AFTER DELETE ON issue_index BEGIN
  INSERT INTO issue_index_fts(issue_index_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS issue_index_au AFTER UPDATE ON issue_index BEGIN
  INSERT INTO issue_index_fts(issue_index_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO issue_index_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Per-repo reconcile watermark: the max \`updated_at\` the sync has fully
-- ingested. Absent row = repo never backfilled.
CREATE TABLE IF NOT EXISTS issue_index_sync (
  repo        TEXT PRIMARY KEY,
  last_synced TEXT NOT NULL
);
`;

/** Microsecond-precision wall clock (epoch µs). */
function nowMicros(): number {
	return Math.floor((performance.timeOrigin + performance.now()) * 1000);
}

/** Format epoch µs as `%Y-%m-%dT%H:%M:%S.%fZ` (Python's sortable UTC format). */
export function formatMicros(micros: number): string {
	const ms = Math.floor(micros / 1000);
	const base = new Date(ms).toISOString().slice(0, 19);
	const frac = String(((micros % 1_000_000) + 1_000_000) % 1_000_000).padStart(6, "0");
	return `${base}.${frac}Z`;
}

export function utcNow(): string {
	return formatMicros(nowMicros());
}

/** UTC timestamp `seconds` in the future, same sortable format as `utcNow`. */
export function utcAfter(seconds: number): string {
	return formatMicros(nowMicros() + Math.round(Math.max(seconds, 0) * 1_000_000));
}

/** ISO-UTC timestamp for `seconds` ago, matching the format `utcNow` writes. */
export function isoSecondsAgo(seconds: number): string {
	return formatMicros(nowMicros() - Math.round(seconds * 1_000_000));
}

export interface EventRow {
	delivery_id: string;
	event_type: string;
	repo: string | null;
	issue_key: string | null;
	payload: Record<string, any>;
	received_at: string;
	state: EventState;
	attempts: number;
	last_error: string | null;
}

export interface IssueRow {
	key: string;
	repo: string;
	number: number;
	branch: string | null;
	session_dir: string | null;
	pr_number: number | null;
	state: IssueState;
	updated_at: string;
	classification: string | null;
}

/** Durable state for one release tag's CI repair loop. */
export interface ReleaseRow {
	key: string;
	repo: string;
	tag: string;
	version: string;
	state: ReleaseState;
	current_sha: string;
	last_failed_sha: string | null;
	rounds: number;
	last_error: string | null;
	session_dir: string | null;
	created_at: string;
	updated_at: string;
}

export interface StagedReviewComment {
	id: number;
	issue_key: string;
	path: string;
	line: number;
	side: string;
	body: string;
	created_at: string;
	start_line: number | null;
	start_side: string | null;
}

export interface SubmissionAdmission {
	accepted: boolean;
	duplicate: boolean;
	used: number;
}

export type PendingClosureState = "pending" | "claimed" | "closed" | "cancelled";

export interface PendingClosureRow {
	issue_key: string;
	repo: string;
	number: number;
	comment_id: number;
	issue_author: string;
	close_at: string;
	state: PendingClosureState;
	cancel_reason: string | null;
	created_at: string;
	updated_at: string;
}

export interface RunningEventSnapshot {
	delivery_id: string;
	event_type: string;
	repo: string | null;
	issue_key: string | null;
	received_at: string;
	started_at: string | null;
	attempts: number;
	model: string | null;
	last_tool: string | null;
	last_tool_ts: string | null;
}

type Row = Record<string, any>;

function eventRowFromDb(row: Row): EventRow {
	return {
		delivery_id: row.delivery_id,
		event_type: row.event_type,
		repo: row.repo,
		issue_key: row.issue_key,
		payload: JSON.parse(row.payload_json),
		received_at: row.received_at,
		state: row.state,
		attempts: Number(row.attempts),
		last_error: row.last_error,
	};
}

function releaseRowFromDb(row: Row): ReleaseRow {
	return {
		key: row.key,
		repo: row.repo,
		tag: row.tag,
		version: row.version,
		state: row.state,
		current_sha: row.current_sha,
		last_failed_sha: row.last_failed_sha,
		rounds: Number(row.rounds),
		last_error: row.last_error,
		session_dir: row.session_dir,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function issueRowFromDb(row: Row): IssueRow {
	return {
		key: row.key,
		repo: row.repo,
		number: Number(row.number),
		branch: row.branch,
		session_dir: row.session_dir,
		pr_number: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
		state: row.state,
		updated_at: row.updated_at,
		classification: row.classification ?? null,
	};
}

function stagedFromDb(row: Row): StagedReviewComment {
	return {
		id: Number(row.id),
		issue_key: row.issue_key,
		path: row.path,
		line: Number(row.line),
		side: row.side,
		body: row.body,
		created_at: row.created_at,
		start_line: row.start_line === null ? null : Number(row.start_line),
		start_side: row.start_side,
	};
}

function pendingClosureFromDb(row: Row): PendingClosureRow {
	return {
		issue_key: row.issue_key,
		repo: row.repo,
		number: Number(row.number),
		comment_id: Number(row.comment_id),
		issue_author: row.issue_author,
		close_at: row.close_at,
		state: row.state,
		cancel_reason: row.cancel_reason,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function indexEntryFromDb(row: Row): IssueIndexEntry {
	let labels: string[] = [];
	try {
		const parsed = JSON.parse(row.labels_json) as unknown;
		if (Array.isArray(parsed)) labels = parsed.map(x => String(x));
	} catch {
		labels = [];
	}
	return {
		repo: String(row.repo),
		number: Number(row.number),
		is_pull_request: Boolean(row.is_pr),
		title: String(row.title),
		body: String(row.body),
		state: String(row.state),
		state_reason: String(row.state_reason),
		merged_at: String(row.merged_at),
		author: String(row.author),
		labels,
		comments: Number(row.comments),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at),
		html_url: String(row.html_url),
	};
}

export function issueKey(repo: string, number: number): string {
	return `${repo}#${number}`;
}

/** Compact JSON (`separators=(",", ":")`) with Python-style `default=str` for non-JSON values. */
export function compactJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (typeof v === "bigint") return v.toString();
		if (v instanceof Set) return [...v];
		return v;
	});
}

const EVENT_COLUMNS =
	"delivery_id, event_type, repo, issue_key, payload_json, received_at, state, attempts, last_error";
const RELEASE_COLUMNS =
	"key, repo, tag, version, state, current_sha, last_failed_sha, rounds, last_error, session_dir, created_at, updated_at";
const ISSUE_COLUMNS = "key, repo, number, branch, session_dir, pr_number, state, classification, updated_at";
const STAGED_COLUMNS = "id, issue_key, path, line, side, start_line, start_side, body, created_at";
const CLOSURE_COLUMNS =
	"issue_key, repo, number, comment_id, issue_author, close_at, state, cancel_reason, created_at, updated_at";

/** Single-connection sqlite wrapper. */
export class Database {
	readonly path: string;
	readonly conn: SqliteDatabase;

	constructor(dbPath: string) {
		this.path = dbPath;
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.conn = new SqliteDatabase(dbPath, { create: true });
		// Python's sqlite3 default busy timeout is 5s.
		this.conn.exec("PRAGMA busy_timeout = 5000;");
		this.conn.exec(SCHEMA);
		this.#migrate();
	}

	#migrate(): void {
		const issueCols = new Set(this.#all("PRAGMA table_info(issues)").map(r => r.name as string));
		if (!issueCols.has("classification")) this.conn.exec("ALTER TABLE issues ADD COLUMN classification TEXT");
		const eventCols = new Set(this.#all("PRAGMA table_info(events)").map(r => r.name as string));
		if (!eventCols.has("model")) this.conn.exec("ALTER TABLE events ADD COLUMN model TEXT");
		if (!eventCols.has("available_at")) this.conn.exec("ALTER TABLE events ADD COLUMN available_at TEXT");
	}

	close(): void {
		this.conn.close();
	}

	#all(sql: string, ...params: SQLQueryBindings[]): Row[] {
		return this.conn.query(sql).all(...params) as Row[];
	}

	#get(sql: string, ...params: SQLQueryBindings[]): Row | null {
		return (this.conn.query(sql).get(...params) as Row | null) ?? null;
	}

	#run(sql: string, ...params: SQLQueryBindings[]): { changes: number; lastInsertRowid: number } {
		const result = this.conn.query(sql).run(...params);
		return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
	}

	/** `BEGIN IMMEDIATE` transaction; rolls back on throw. */
	#txn<T>(fn: () => T): T {
		this.conn.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			this.conn.exec("COMMIT");
			return out;
		} catch (err) {
			this.conn.exec("ROLLBACK");
			throw err;
		}
	}

	// ---- events ----

	/** Insert a webhook event. Returns false if duplicate (by delivery id). */
	recordEvent(args: {
		delivery_id: string;
		event_type: string;
		repo: string | null;
		issue_key: string | null;
		payload: Record<string, unknown>;
		state?: EventState;
		last_error?: string | null;
	}): boolean {
		const result = this.#run(
			`INSERT OR IGNORE INTO events
			  (delivery_id, event_type, repo, issue_key, payload_json, received_at, state, last_error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			args.delivery_id,
			args.event_type,
			args.repo,
			args.issue_key,
			compactJson(args.payload),
			utcNow(),
			args.state ?? "queued",
			args.last_error ?? null,
		);
		return result.changes > 0;
	}

	/** Atomically dequeue one unblocked queued event into running state. */
	claimNextEvent(): EventRow | null {
		return this.#txn(() => {
			const now = utcNow();
			const row = this.#get(
				`SELECT queued.delivery_id, queued.event_type, queued.repo, queued.issue_key,
				       queued.payload_json, queued.received_at, queued.state, queued.attempts,
				       queued.last_error
				FROM events AS queued
				WHERE queued.state = 'queued'
				  AND (queued.available_at IS NULL OR queued.available_at <= ?)
				  AND (
				    queued.issue_key IS NULL
				    OR NOT EXISTS (
				      SELECT 1
				      FROM events AS running
				      WHERE running.state = 'running'
				        AND running.issue_key = queued.issue_key
				    )
				  )
				ORDER BY queued.received_at
				LIMIT 1`,
				now,
			);
			if (row === null) return null;
			this.#run(
				"UPDATE events SET state='running', attempts=attempts+1, started_at=? WHERE delivery_id=?",
				now,
				row.delivery_id,
			);
			return { ...eventRowFromDb(row), state: "running", attempts: Number(row.attempts) + 1 };
		});
	}

	markEvent(deliveryId: string, state: EventState, error: string | null = null): void {
		this.#run(
			"UPDATE events SET state=?, last_error=?, finished_at=? WHERE delivery_id=?",
			state,
			error,
			utcNow(),
			deliveryId,
		);
	}

	/** Persist the model the worker actually picked for this event. */
	setEventModel(deliveryId: string, model: string): void {
		this.#run("UPDATE events SET model=? WHERE delivery_id=?", model, deliveryId);
	}

	/** Recover events that were running at shutdown. */
	resetStuckRunning(): number {
		return this.#run("UPDATE events SET state='queued', available_at=NULL WHERE state='running'").changes;
	}

	listEvents(limit = 50): EventRow[] {
		return this.#all(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY received_at DESC LIMIT ?`, limit).map(
			eventRowFromDb,
		);
	}

	/** Hard-delete an event row. */
	removeEvent(deliveryId: string): void {
		this.#run("DELETE FROM events WHERE delivery_id=?", deliveryId);
	}

	/** Replace an existing event only when its current state is permitted. */
	replaceEventIfStateIn(args: {
		delivery_id: string;
		event_type: string;
		repo: string | null;
		issue_key: string | null;
		payload: Record<string, unknown>;
		state?: EventState;
		allowed_existing_states: readonly EventState[];
	}): boolean {
		const now = utcNow();
		return this.#txn(() => {
			const row = this.#get("SELECT state FROM events WHERE delivery_id = ?", args.delivery_id);
			if (row !== null) {
				if (!args.allowed_existing_states.includes(row.state)) return false;
				this.#run("DELETE FROM events WHERE delivery_id = ?", args.delivery_id);
			}
			this.#run(
				`INSERT INTO events
				  (delivery_id, event_type, repo, issue_key, payload_json, received_at, state)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args.delivery_id,
				args.event_type,
				args.repo,
				args.issue_key,
				compactJson(args.payload),
				now,
				args.state ?? "queued",
			);
			return true;
		});
	}

	/** Return the newest event for an issue (ignores `skipped` unless asked). */
	latestEventForIssue(key: string, options: { include_skipped?: boolean } = {}): EventRow | null {
		const stateFilter = options.include_skipped ? "" : "AND state <> 'skipped'";
		const row = this.#get(
			`SELECT ${EVENT_COLUMNS}
			FROM events
			WHERE issue_key = ?
			  ${stateFilter}
			ORDER BY received_at DESC, rowid DESC
			LIMIT 1`,
			key,
		);
		return row === null ? null : eventRowFromDb(row);
	}

	/** Return newest event rows keyed by issue key for a bounded issue set. */
	latestEventsForIssues(keys: Iterable<string>, options: { include_skipped?: boolean } = {}): Map<string, EventRow> {
		const unique = [...new Set([...keys].filter(Boolean))];
		const out = new Map<string, EventRow>();
		if (unique.length === 0) return out;
		const stateFilter = options.include_skipped ? "" : "AND state <> 'skipped'";
		for (let start = 0; start < unique.length; start += 500) {
			const batch = unique.slice(start, start + 500);
			const placeholders = batch.map(() => "?").join(",");
			const rows = this.#all(
				`SELECT ${EVENT_COLUMNS}
				FROM events
				WHERE issue_key IN (${placeholders})
				  ${stateFilter}
				ORDER BY issue_key ASC, received_at DESC, rowid DESC`,
				...batch,
			);
			for (const row of rows) {
				if (!out.has(row.issue_key)) out.set(row.issue_key, eventRowFromDb(row));
			}
		}
		return out;
	}

	/** Current row counts per event state, including states with zero rows. */
	eventStateCounts(): Record<EventState, number> {
		const counts: Record<EventState, number> = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
		for (const row of this.#all("SELECT state, COUNT(*) AS n FROM events GROUP BY state")) {
			counts[row.state as EventState] = Number(row.n);
		}
		return counts;
	}

	/** Count each issue by its newest non-skipped event state. */
	latestIssueEventStateCounts(): Record<EventState, number> {
		const counts: Record<EventState, number> = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
		const seen = new Set<string>();
		const rows = this.#all(
			`SELECT issue_key, state
			FROM events
			WHERE issue_key IS NOT NULL
			  AND state <> 'skipped'
			ORDER BY issue_key ASC, received_at DESC, rowid DESC`,
		);
		for (const row of rows) {
			if (seen.has(row.issue_key)) continue;
			seen.add(row.issue_key);
			counts[row.state as EventState] += 1;
		}
		return counts;
	}

	/** Snapshot of currently-running events with per-run telemetry. */
	listRunningEvents(): RunningEventSnapshot[] {
		const rows = this.#all(
			`SELECT e.delivery_id, e.event_type, e.repo, e.issue_key, e.received_at,
			       e.started_at, e.attempts, e.model,
			       (SELECT tool FROM tool_calls
			          WHERE issue_key = e.issue_key AND ts >= e.started_at
			          ORDER BY ts DESC LIMIT 1) AS last_tool,
			       (SELECT ts FROM tool_calls
			          WHERE issue_key = e.issue_key AND ts >= e.started_at
			          ORDER BY ts DESC LIMIT 1) AS last_tool_ts
			FROM events e
			WHERE e.state = 'running'
			ORDER BY COALESCE(e.started_at, e.received_at)`,
		);
		return rows.map(r => ({
			delivery_id: r.delivery_id,
			event_type: r.event_type,
			repo: r.repo,
			issue_key: r.issue_key,
			received_at: r.received_at,
			started_at: r.started_at,
			attempts: Number(r.attempts),
			model: r.model,
			last_tool: r.last_tool,
			last_tool_ts: r.last_tool_ts,
		}));
	}

	getEvent(deliveryId: string): EventRow | null {
		const row = this.#get(`SELECT ${EVENT_COLUMNS} FROM events WHERE delivery_id = ?`, deliveryId);
		return row === null ? null : eventRowFromDb(row);
	}

	/** Whether a non-skipped event on this issue carried implementation authorization. */
	hasAuthorizedImplEvent(key: string): boolean {
		const rows = this.#all(
			`SELECT payload_json
			FROM events
			WHERE issue_key = ?
			  AND state <> 'skipped'
			ORDER BY received_at DESC`,
			key,
		);
		for (const row of rows) {
			const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			const directive = payload._robomp_directive;
			if (
				typeof directive === "object" &&
				directive !== null &&
				(directive as Record<string, unknown>).authorizes_impl === true
			) {
				return true;
			}
		}
		return false;
	}

	/** Move an event back to queued without clobbering last_error. */
	requeueEvent(deliveryId: string, options: { from_states?: readonly EventState[] | null } = {}): boolean {
		const fromStates = options.from_states;
		if (fromStates === undefined || fromStates === null) {
			return (
				this.#run("UPDATE events SET state='queued', available_at=NULL WHERE delivery_id=?", deliveryId).changes > 0
			);
		}
		if (fromStates.length === 0) return false;
		const placeholders = fromStates.map(() => "?").join(",");
		return (
			this.#run(
				`UPDATE events SET state='queued', available_at=NULL WHERE delivery_id=? AND state IN (${placeholders})`,
				deliveryId,
				...fromStates,
			).changes > 0
		);
	}

	/** Re-queue a delivery for a future retry with backoff. */
	scheduleRetry(deliveryId: string, options: { delay_seconds: number; error?: string | null }): boolean {
		return (
			this.#run(
				"UPDATE events SET state='queued', last_error=?, available_at=?, finished_at=NULL " +
					"WHERE delivery_id=? AND state IN ('running','failed')",
				options.error ?? null,
				utcAfter(options.delay_seconds),
				deliveryId,
			).changes > 0
		);
	}

	// ---- releases ----

	/** Create release state once and preserve later lifecycle transitions. */
	upsertRelease(args: {
		repo: string;
		tag: string;
		version: string;
		current_sha: string;
		session_dir: string | null;
	}): ReleaseRow {
		const key = `${args.repo}#${args.tag}`;
		const now = utcNow();
		this.#run(
			`INSERT OR IGNORE INTO releases
			  (key, repo, tag, version, state, current_sha, session_dir, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'awaiting_ci', ?, ?, ?, ?)`,
			key,
			args.repo,
			args.tag,
			args.version,
			args.current_sha,
			args.session_dir,
			now,
			now,
		);
		return this.getRelease(key)!;
	}

	getRelease(key: string): ReleaseRow | null {
		const row = this.#get(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE key=?`, key);
		return row === null ? null : releaseRowFromDb(row);
	}

	/** Return the newest release still awaiting or repairing CI. */
	getActiveRelease(repo: string): ReleaseRow | null {
		const row = this.#get(
			`SELECT ${RELEASE_COLUMNS}
			FROM releases
			WHERE repo=? AND state IN ('awaiting_ci','fixing')
			ORDER BY updated_at DESC, rowid DESC
			LIMIT 1`,
			repo,
		);
		return row === null ? null : releaseRowFromDb(row);
	}

	setReleaseState(key: string, state: ReleaseState, error: string | null = null): void {
		this.#run("UPDATE releases SET state=?, last_error=?, updated_at=? WHERE key=?", state, error, utcNow(), key);
	}

	setReleaseSha(key: string, sha: string): void {
		this.#run("UPDATE releases SET current_sha=?, updated_at=? WHERE key=?", sha, utcNow(), key);
	}

	/** Start another fix round for a failing release commit. */
	bumpReleaseRound(key: string, failedSha: string): ReleaseRow {
		this.#run(
			`UPDATE releases
			SET rounds=rounds+1, last_failed_sha=?, state='fixing', last_error=NULL, updated_at=?
			WHERE key=?`,
			failedSha,
			utcNow(),
			key,
		);
		return this.getRelease(key)!;
	}

	listReleases(limit = 50): ReleaseRow[] {
		return this.#all(
			`SELECT ${RELEASE_COLUMNS} FROM releases ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
			limit,
		).map(releaseRowFromDb);
	}

	// ---- issues ----

	upsertIssue(args: {
		key: string;
		repo: string;
		number: number;
		state: IssueState;
		branch?: string | null;
		session_dir?: string | null;
		pr_number?: number | null;
	}): IssueRow {
		this.#run(
			`INSERT INTO issues (key, repo, number, branch, session_dir, pr_number, state, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
			  branch = COALESCE(excluded.branch, issues.branch),
			  session_dir = COALESCE(excluded.session_dir, issues.session_dir),
			  pr_number = COALESCE(excluded.pr_number, issues.pr_number),
			  state = excluded.state,
			  updated_at = excluded.updated_at`,
			args.key,
			args.repo,
			args.number,
			args.branch ?? null,
			args.session_dir ?? null,
			args.pr_number ?? null,
			args.state,
			utcNow(),
		);
		return this.getIssue(args.key)!;
	}

	setIssueState(key: string, state: IssueState): void {
		this.#run("UPDATE issues SET state=?, updated_at=? WHERE key=?", state, utcNow(), key);
	}

	setIssuePr(key: string, prNumber: number): void {
		this.#run("UPDATE issues SET pr_number=?, updated_at=? WHERE key=?", prNumber, utcNow(), key);
	}

	setIssueClassification(key: string, classification: string): void {
		this.#run("UPDATE issues SET classification=?, updated_at=? WHERE key=?", classification, utcNow(), key);
	}

	setIssueBranch(key: string, branch: string): void {
		this.#run("UPDATE issues SET branch=?, updated_at=? WHERE key=?", branch, utcNow(), key);
	}

	getIssue(key: string): IssueRow | null {
		const row = this.#get(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE key=?`, key);
		return row === null ? null : issueRowFromDb(row);
	}

	findIssueByPr(repo: string, prNumber: number): IssueRow | null {
		const row = this.#get(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE repo=? AND pr_number=?`, repo, prNumber);
		return row === null ? null : issueRowFromDb(row);
	}

	findIssueByBranch(repo: string, branch: string): IssueRow | null {
		const row = this.#get(
			`SELECT ${ISSUE_COLUMNS}
			FROM issues
			WHERE repo=? AND branch=?
			ORDER BY updated_at DESC
			LIMIT 1`,
			repo,
			branch,
		);
		return row === null ? null : issueRowFromDb(row);
	}

	listIssues(limit = 100): IssueRow[] {
		return this.#all(`SELECT ${ISSUE_COLUMNS} FROM issues ORDER BY updated_at DESC LIMIT ?`, limit).map(
			issueRowFromDb,
		);
	}

	/** Subset of `keys` that have a row in the `issues` table. */
	processedIssueKeys(keys: Iterable<string>): Set<string> {
		const unique = [...new Set([...keys].filter(Boolean))];
		const out = new Set<string>();
		for (let start = 0; start < unique.length; start += 500) {
			const batch = unique.slice(start, start + 500);
			const placeholders = batch.map(() => "?").join(",");
			for (const row of this.#all(`SELECT key FROM issues WHERE key IN (${placeholders})`, ...batch)) {
				out.add(row.key);
			}
		}
		return out;
	}

	// ---- tool_calls ----

	logToolCall(args: {
		issue_key: string;
		tool: string;
		args: unknown;
		result?: unknown;
		error?: string | null;
	}): number {
		const result = this.#run(
			"INSERT INTO tool_calls (issue_key, tool, args_json, result_json, error, ts) VALUES (?, ?, ?, ?, ?, ?)",
			args.issue_key,
			args.tool,
			compactJson(args.args),
			args.result === undefined || args.result === null ? null : compactJson(args.result),
			args.error ?? null,
			utcNow(),
		);
		return result.lastInsertRowid || 0;
	}

	hasSuccessfulToolCall(key: string, tool: string): boolean {
		return (
			this.#get(
				`SELECT 1
				FROM tool_calls
				WHERE issue_key=? AND tool=? AND error IS NULL
				ORDER BY id DESC
				LIMIT 1`,
				key,
				tool,
			) !== null
		);
	}

	// ---- PR review comment staging ----

	stageReviewComment(args: {
		issue_key: string;
		path: string;
		line: number;
		body: string;
		side?: string;
		start_line?: number | null;
		start_side?: string | null;
	}): StagedReviewComment {
		const result = this.#run(
			`INSERT INTO pr_review_comments
			  (issue_key, path, line, side, start_line, start_side, body, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			args.issue_key,
			args.path,
			args.line,
			args.side ?? "RIGHT",
			args.start_line ?? null,
			args.start_side ?? null,
			args.body,
			utcNow(),
		);
		return stagedFromDb(
			this.#get(`SELECT ${STAGED_COLUMNS} FROM pr_review_comments WHERE id=?`, result.lastInsertRowid)!,
		);
	}

	listStagedReviewComments(key: string): StagedReviewComment[] {
		return this.#all(`SELECT ${STAGED_COLUMNS} FROM pr_review_comments WHERE issue_key=? ORDER BY id`, key).map(
			stagedFromDb,
		);
	}

	clearStagedReviewComments(key: string): number {
		return this.#run("DELETE FROM pr_review_comments WHERE issue_key=?", key).changes;
	}

	// ---- submissions (per-user rate limiting) ----

	/** Atomically check a submitter's rolling cap and record this delivery. */
	admitSubmission(args: {
		delivery_id: string;
		login: string;
		repo: string | null;
		since: string;
		cap: number | null;
	}): SubmissionAdmission {
		const login = args.login.toLowerCase();
		return this.#txn(() => {
			const countRow = (): number =>
				Number(
					this.#get("SELECT COUNT(*) AS n FROM submissions WHERE login=? AND ts>=?", login, args.since)?.n ?? 0,
				);
			if (this.#get("SELECT 1 FROM submissions WHERE delivery_id=?", args.delivery_id) !== null) {
				return { accepted: true, duplicate: true, used: countRow() };
			}
			const used = countRow();
			if (args.cap !== null && used >= args.cap) return { accepted: false, duplicate: false, used };
			this.#run(
				"INSERT INTO submissions (delivery_id, login, repo, ts) VALUES (?, ?, ?, ?)",
				args.delivery_id,
				login,
				args.repo,
				utcNow(),
			);
			return { accepted: true, duplicate: false, used: used + 1 };
		});
	}

	/** Idempotently log a queue-worthy submission by `login`. */
	recordSubmission(args: { delivery_id: string; login: string; repo: string | null }): boolean {
		return (
			this.#run(
				"INSERT OR IGNORE INTO submissions (delivery_id, login, repo, ts) VALUES (?, ?, ?, ?)",
				args.delivery_id,
				args.login.toLowerCase(),
				args.repo,
				utcNow(),
			).changes > 0
		);
	}

	/** Count submissions by `login` (case-insensitive) with ts >= `since`. */
	countSubmissionsSince(login: string, since: string): number {
		return Number(
			this.#get("SELECT COUNT(*) AS n FROM submissions WHERE login=? AND ts>=?", login.toLowerCase(), since)?.n ?? 0,
		);
	}

	// ---- pending_closures ----

	/** Schedule (or reschedule) a question issue to auto-close. */
	upsertPendingClosure(args: {
		issue_key: string;
		repo: string;
		number: number;
		comment_id: number;
		issue_author: string;
		close_at: string;
	}): void {
		const now = utcNow();
		this.#run(
			`INSERT INTO pending_closures
			  (issue_key, repo, number, comment_id, issue_author, close_at,
			   state, cancel_reason, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
			ON CONFLICT(issue_key) DO UPDATE SET
			  repo = excluded.repo,
			  number = excluded.number,
			  comment_id = excluded.comment_id,
			  issue_author = excluded.issue_author,
			  close_at = excluded.close_at,
			  state = 'pending',
			  cancel_reason = NULL,
			  updated_at = excluded.updated_at`,
			args.issue_key,
			args.repo,
			args.number,
			args.comment_id,
			args.issue_author.toLowerCase(),
			args.close_at,
			now,
			now,
		);
	}

	/** Atomically flip due `pending` rows to `claimed` and return them. */
	claimDueClosures(args: { now: string; limit?: number }): PendingClosureRow[] {
		return this.#txn(() =>
			this.#all(
				`UPDATE pending_closures
				SET state = 'claimed', updated_at = ?
				WHERE issue_key IN (
				  SELECT issue_key FROM pending_closures
				  WHERE state = 'pending' AND close_at <= ?
				  ORDER BY close_at
				  LIMIT ?
				)
				RETURNING ${CLOSURE_COLUMNS}`,
				args.now,
				args.now,
				Math.trunc(args.limit ?? 50),
			).map(pendingClosureFromDb),
		);
	}

	/** Mark a claimed row terminal (`closed` / `cancelled`). */
	finalizeClosure(key: string, args: { state: PendingClosureState; reason: string | null }): void {
		if (args.state !== "closed" && args.state !== "cancelled") {
			throw new RangeError(`finalize_closure: invalid terminal state '${args.state}'`);
		}
		this.#run(
			`UPDATE pending_closures
			SET state = ?, cancel_reason = ?, updated_at = ?
			WHERE issue_key = ?`,
			args.state,
			args.reason,
			utcNow(),
			key,
		);
	}

	/** Return a `claimed` row to `pending` so the next tick retries it. */
	requeueClaimedClosure(key: string): boolean {
		return (
			this.#run(
				`UPDATE pending_closures
				SET state = 'pending', updated_at = ?
				WHERE issue_key = ? AND state = 'claimed'`,
				utcNow(),
				key,
			).changes > 0
		);
	}

	/** Cancel a scheduled close. No-op when state is not `pending`. */
	cancelPendingClosure(key: string, reason: string): boolean {
		return (
			this.#run(
				`UPDATE pending_closures
				SET state = 'cancelled', cancel_reason = ?, updated_at = ?
				WHERE issue_key = ? AND state = 'pending'`,
				reason,
				utcNow(),
				key,
			).changes > 0
		);
	}

	getPendingClosure(key: string): PendingClosureRow | null {
		const row = this.#get(`SELECT ${CLOSURE_COLUMNS} FROM pending_closures WHERE issue_key = ?`, key);
		return row === null ? null : pendingClosureFromDb(row);
	}

	// ---- issue search index ----

	/** Insert or refresh one issue/PR in the local search index. */
	upsertIssueIndex(entry: IssueIndexEntry): void {
		this.#run(
			`INSERT INTO issue_index
			  (repo, number, is_pr, title, body, state, state_reason, merged_at,
			   author, labels_json, comments, created_at, updated_at, html_url)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(repo, number) DO UPDATE SET
			  is_pr = excluded.is_pr,
			  title = excluded.title,
			  body = excluded.body,
			  state = excluded.state,
			  state_reason = excluded.state_reason,
			  merged_at = excluded.merged_at,
			  author = excluded.author,
			  labels_json = excluded.labels_json,
			  comments = excluded.comments,
			  created_at = excluded.created_at,
			  updated_at = excluded.updated_at,
			  html_url = excluded.html_url`,
			entry.repo,
			entry.number,
			entry.is_pull_request ? 1 : 0,
			entry.title,
			entry.body,
			entry.state,
			entry.state_reason,
			entry.merged_at,
			entry.author,
			JSON.stringify([...entry.labels]),
			entry.comments,
			entry.created_at,
			entry.updated_at,
			entry.html_url,
		);
	}

	/** Query the local index. Keywords go through FTS5 (bm25-ranked, AND semantics). */
	searchIssueIndex(
		repo: string,
		options: {
			keywords?: Iterable<string>;
			is_pr?: boolean | null;
			state?: string | null;
			merged?: boolean | null;
			label?: string | null;
			author?: string | null;
			limit?: number;
		} = {},
	): IssueIndexEntry[] {
		const conds = ["i.repo = ?"];
		const params: SQLQueryBindings[] = [repo];
		if (options.is_pr !== undefined && options.is_pr !== null) {
			conds.push("i.is_pr = ?");
			params.push(options.is_pr ? 1 : 0);
		}
		if (options.state !== undefined && options.state !== null) {
			conds.push("i.state = ?");
			params.push(options.state);
		}
		if (options.merged !== undefined && options.merged !== null) {
			conds.push(options.merged ? "i.merged_at != ''" : "i.merged_at = ''");
		}
		if (options.label !== undefined && options.label !== null) {
			conds.push("EXISTS (SELECT 1 FROM json_each(i.labels_json) WHERE json_each.value = ?)");
			params.push(options.label);
		}
		if (options.author !== undefined && options.author !== null) {
			conds.push("i.author = ?");
			params.push(options.author);
		}
		const terms = [...(options.keywords ?? [])].filter(t => t.trim());
		const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 10), 50));
		let rows: Row[];
		if (terms.length > 0) {
			// Quote every term so reporter text can never inject FTS5 syntax.
			const match = terms.map(t => `"${t.replaceAll('"', '""')}"`).join(" ");
			rows = this.#all(
				"SELECT i.* FROM issue_index_fts f JOIN issue_index i ON i.rowid = f.rowid " +
					`WHERE issue_index_fts MATCH ? AND ${conds.join(" AND ")} ` +
					"ORDER BY bm25(issue_index_fts) LIMIT ?",
				match,
				...params,
				limit,
			);
		} else {
			rows = this.#all(
				`SELECT i.* FROM issue_index i WHERE ${conds.join(" AND ")} ORDER BY i.updated_at DESC LIMIT ?`,
				...params,
				limit,
			);
		}
		return rows.map(indexEntryFromDb);
	}

	/** Max `updated_at` fully ingested for `repo`; null = never backfilled. */
	issueIndexWatermark(repo: string): string | null {
		const row = this.#get("SELECT last_synced FROM issue_index_sync WHERE repo = ?", repo);
		return row === null ? null : String(row.last_synced);
	}

	setIssueIndexWatermark(repo: string, lastSynced: string): void {
		this.#run(
			`INSERT INTO issue_index_sync (repo, last_synced) VALUES (?, ?)
			ON CONFLICT(repo) DO UPDATE SET last_synced = excluded.last_synced`,
			repo,
			lastSynced,
		);
	}
}

let singleton: Database | null = null;

export function getDatabase(dbPath: string): Database {
	if (singleton === null || singleton.path !== dbPath) {
		singleton?.close();
		singleton = new Database(dbPath);
	}
	return singleton;
}

export function closeDatabase(): void {
	singleton?.close();
	singleton = null;
}
