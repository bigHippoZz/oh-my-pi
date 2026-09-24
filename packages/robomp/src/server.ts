/** HTTP receiver for GitHub webhooks plus the dashboard JSON APIs. */
import * as path from "node:path";
import { AutocloseScheduler } from "./autoclose";
import { getSettings, type Settings } from "./config";
import { renderIndex, staticFile, tailJsonl } from "./dashboard";
import {
	type Database,
	getDatabase,
	INACTIVE_EVENT_STATES,
	isoSecondsAgo,
	issueKey as makeIssueKey,
	type ReleaseRow,
} from "./db";
import type { GitHubBackend } from "./github-backend";
import { GitHubError, type IssueSummary, type Json } from "./github-client";
import * as githubEvents from "./github-events";
import { App, HttpError, html, json, type Query, validationError } from "./http-app";
import * as issueIndex from "./issue-index";
import { IssueIndexSync } from "./issue-index";
import { getLogger } from "./logging";
import {
	enqueueManualTriage,
	InvalidIssueRef,
	ManualTriageConflict,
	ManualTriageError,
	parseIssueRef,
} from "./manual-triage";
import { NativesCache } from "./natives-cache";
import { GitHubProxyClient, ProxyGitTransport } from "./proxy-client";
import { WorkerPool } from "./queue";
import { SandboxManager } from "./sandbox";

const log = getLogger("robomp.server");

/** Slice of WorkerPool the app drives (tests inject a paused fake). */
export interface AppPool {
	start(): Promise<void>;
	stop(options?: { drainTimeout?: number; killTimeout?: number }): Promise<void>;
	wake(): void;
	cancelEvent(deliveryId: string): Promise<boolean>;
	inflightSnapshot(): string[] | Promise<string[]>;
}

export type PoolFactory = (
	settings: Settings,
	db: Database,
	github: GitHubBackend,
	sandbox: SandboxManager,
	gitTransport: ProxyGitTransport,
) => AppPool;

function releasePayload(row: ReleaseRow): Record<string, unknown> {
	return {
		key: row.key,
		repo: row.repo,
		tag: row.tag,
		version: row.version,
		state: row.state,
		current_sha: row.current_sha,
		last_failed_sha: row.last_failed_sha,
		rounds: row.rounds,
		last_error: row.last_error,
		session_dir: row.session_dir,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

interface IssueBrowseCacheEntry {
	repos: string[];
	issues: IssueSummary[];
	errors: { repo: string; error: string }[];
	fetchedAt: number;
}

function nowSeconds(): number {
	return Date.now() / 1000;
}

function byUpdatedDesc(a: IssueSummary, b: IssueSummary): number {
	return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

/**
 * In-process cache for the dashboard's GitHub issue browser. Webhooks keep
 * warmed entries fresh; the dashboard Refresh button can force a live pull.
 */
export class IssueBrowseCache {
	readonly #entries = new Map<string, { state: string; limit: number; entry: IssueBrowseCacheEntry }>();

	async getOrFetch(args: {
		state: string;
		limit: number;
		repos: string[];
		force: boolean;
		fetch: () => Promise<[IssueSummary[], { repo: string; error: string }[]]>;
	}): Promise<[IssueBrowseCacheEntry, boolean]> {
		const key = JSON.stringify([args.state, args.limit, args.repos]);
		if (!args.force) {
			const cached = this.#entries.get(key);
			if (cached) return [cached.entry, true];
		}
		const [issues, errors] = await args.fetch();
		const entry: IssueBrowseCacheEntry = {
			repos: args.repos,
			issues: [...issues].sort(byUpdatedDesc).slice(0, args.limit),
			errors,
			fetchedAt: nowSeconds(),
		};
		if (!args.force) {
			const current = this.#entries.get(key);
			if (current) return [current.entry, true];
		}
		this.#entries.set(key, { state: args.state, limit: args.limit, entry });
		return [entry, false];
	}

	applyWebhook(args: { eventType: string; payload: Json; allowlist: ReadonlySet<string> }): void {
		const mutation = issueCacheMutation(args.eventType, args.payload, args.allowlist);
		if (mutation === null) return;
		const [repo, number, summary] = mutation;
		for (const { state, limit, entry } of this.#entries.values()) {
			if (!entry.repos.includes(repo)) continue;
			entry.issues = entry.issues.filter(item => !(item.repo === repo && item.number === number));
			if (summary !== null && (state === "all" || summary.state === state)) {
				entry.issues.push(summary);
				entry.issues.sort(byUpdatedDesc);
				entry.issues.splice(limit);
			}
		}
	}
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoFullName(payload: Json): string | null {
	const repo = payload.repository;
	if (isMapping(repo) && typeof repo.full_name === "string" && repo.full_name) return repo.full_name;
	return null;
}

function labelNames(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(label => (isMapping(label) ? String(label.name || "") : String(label)));
}

function issueSummaryFromPayload(repo: string, issue: Record<string, unknown>): IssueSummary | null {
	const number = issue.number;
	if (typeof number !== "number" || !Number.isInteger(number)) return null;
	let state = String(issue.state || "open").toLowerCase();
	if (state !== "open" && state !== "closed") state = "open";
	const comments = typeof issue.comments === "number" && Number.isInteger(issue.comments) ? issue.comments : 0;
	const user = issue.user;
	return {
		repo,
		number,
		title: String(issue.title || ""),
		state,
		author: isMapping(user) ? String(user.login || "") : "",
		labels: labelNames(issue.labels),
		comments,
		updated_at: String(issue.updated_at || issue.created_at || ""),
		created_at: String(issue.created_at || ""),
		html_url: String(issue.html_url || `https://github.com/${repo}/issues/${number}`),
		state_reason: "",
		is_pull_request: false,
	};
}

function issueCacheMutation(
	eventType: string,
	payload: Json,
	allowlist: ReadonlySet<string>,
): [string, number, IssueSummary | null] | null {
	if (eventType !== "issues" && eventType !== "issue_comment") return null;
	const repo = repoFullName(payload);
	if (repo === null || !allowlist.has(repo.toLowerCase())) return null;
	const issue = payload.issue;
	if (!isMapping(issue)) return null;
	const number = issue.number;
	if (typeof number !== "number" || !Number.isInteger(number)) return null;
	if ("pull_request" in issue) return [repo, number, null];
	if (String(payload.action || "") === "deleted") return [repo, number, null];
	const summary = issueSummaryFromPayload(repo, issue);
	if (summary === null) return null;
	return [repo, number, summary];
}

function issueBrowsePayload(entry: IssueBrowseCacheEntry, cacheHit: boolean, processed: ReadonlySet<string>) {
	return {
		issues: entry.issues.map(s => ({
			repo: s.repo,
			number: s.number,
			title: s.title,
			state: s.state,
			author: s.author,
			labels: [...s.labels],
			comments: s.comments,
			updated_at: s.updated_at,
			created_at: s.created_at,
			html_url: s.html_url,
			processed: processed.has(makeIssueKey(s.repo, s.number)),
		})),
		errors: entry.errors.map(error => ({ ...error })),
		repos: [...entry.repos],
		cache: { hit: cacheHit, fetched_at: entry.fetchedAt },
	};
}

/** Fatal configuration error (Python `SystemExit(message)`). */
export class ConfigurationExit extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigurationExit";
	}
}

export function requireProxyMode(cfg: Settings): [string, string] {
	if (cfg.github_token !== null) {
		throw new ConfigurationExit(
			"robomp orchestrator refuses to start with GITHUB_TOKEN set in env. " +
				"The PAT must live only in the gh-proxy container.",
		);
	}
	if (!cfg.gh_proxy_url || cfg.gh_proxy_hmac_key === null) {
		throw new ConfigurationExit(
			"robomp orchestrator requires ROBOMP_GH_PROXY_URL and " +
				"ROBOMP_GH_PROXY_HMAC_KEY (run gh-proxy in a sibling container).",
		);
	}
	return [cfg.gh_proxy_url, cfg.gh_proxy_hmac_key.getSecretValue()];
}

export const defaultPoolFactory: PoolFactory = (settings, db, github, sandbox, gitTransport) =>
	new WorkerPool({ settings, db, github, sandbox, gitTransport });

export interface ServerState {
	settings: Settings;
	db: Database;
	github: GitHubBackend;
	gitTransport: ProxyGitTransport;
	sandbox: SandboxManager;
	nativesCache: NativesCache | null;
	pool: AppPool;
	issueBrowseCache: IssueBrowseCache;
	autoclose: AutocloseScheduler;
	issueIndexSync: IssueIndexSync;
	startedAt: number;
}

function buildState(settings: Settings, poolFactory: PoolFactory): ServerState {
	const db = getDatabase(settings.sqlite_path);
	const [baseUrl, key] = requireProxyMode(settings);
	const github = new GitHubProxyClient({ baseUrl, hmacKey: key });
	const gitTransport = new ProxyGitTransport({ baseUrl, hmacKey: key });
	const nativesCache = settings.natives_cache_enabled
		? new NativesCache(settings.natives_cache_root, {
				maxEntriesPerRepo: settings.natives_cache_max_entries_per_repo,
				maxBytes: settings.natives_cache_max_bytes,
			})
		: null;
	const sandbox = new SandboxManager(settings.workspace_root, { transport: gitTransport, nativesCache });
	return {
		settings,
		db,
		github,
		gitTransport,
		sandbox,
		nativesCache,
		pool: poolFactory(settings, db, github, sandbox, gitTransport),
		issueBrowseCache: new IssueBrowseCache(),
		autoclose: new AutocloseScheduler({ settings, db, github }),
		issueIndexSync: new IssueIndexSync({ settings, db, github }),
		startedAt: nowSeconds(),
	};
}

/** Parse a JSON object request body (FastAPI `dict = Body(...)`). */
async function jsonObjectBody(request: Request): Promise<Record<string, unknown>> {
	const text = await request.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw validationError(["body", 0], "JSON decode error", "json_invalid");
	}
	if (!isMapping(parsed)) throw validationError(["body"], "Input should be a valid dictionary", "dict_type");
	return parsed;
}

function requiredHeader(request: Request, name: string): string {
	const value = request.headers.get(name);
	if (value === null) throw validationError(["header", name], "Field required", "missing");
	return value;
}

function requireTriggerToken(cfg: Settings, token: string | null): void {
	if (cfg.replay_token === null) throw new HttpError(404, "trigger disabled (set ROBOMP_REPLAY_TOKEN to enable)");
	if (token !== cfg.replay_token.getSecretValue()) throw new HttpError(401, "invalid replay token");
}

const TOKEN_HEADER = "X-Robomp-Replay-Token";

/** The orchestrator HTTP server: app routes + the worker lifecycle. */
export class RobompServer {
	readonly app: App<RobompServer>;
	#state: ServerState | null = null;

	constructor(
		readonly settings: Settings | null = null,
		readonly options: { poolFactory?: PoolFactory } = {},
	) {
		this.app = new App<RobompServer>(this);
		this.#routes();
	}

	get state(): ServerState {
		if (this.#state === null) throw new HttpError(503, "not initialized");
		return this.#state;
	}

	fetch = (request: Request): Promise<Response> => this.app.fetch(request);

	/** FastAPI lifespan startup. */
	async start(): Promise<void> {
		const cfg = this.settings ?? getSettings();
		cfg.ensurePaths();
		const state = buildState(cfg, this.options.poolFactory ?? defaultPoolFactory);
		this.#state = state;
		state.startedAt = nowSeconds();
		await state.pool.start();
		await state.autoclose.start();
		await state.issueIndexSync.start();
	}

	/** FastAPI lifespan shutdown. */
	async stop(): Promise<void> {
		const state = this.#state;
		if (state === null) return;
		await state.issueIndexSync.stop();
		await state.autoclose.stop();
		await state.pool.stop({
			drainTimeout: state.settings.shutdown_drain_timeout_seconds,
			killTimeout: state.settings.shutdown_kill_timeout_seconds,
		});
	}

	#routes(): void {
		const app = this.app;
		app.get("/healthz", () => json({ status: "ok" }));
		app.get("/readyz", () => {
			if (this.#state === null) throw new HttpError(503, "not initialized");
			return json({ status: "ready" });
		});
		app.post("/webhook/github", ({ request }) => this.#webhook(request));
		app.post("/replay", ({ request, query }) => {
			const state = this.state;
			const cfg = state.settings;
			const deliveryId = query.str("delivery_id", "");
			if (cfg.replay_token === null) throw new HttpError(404, "replay disabled");
			if (request.headers.get(TOKEN_HEADER) !== cfg.replay_token.getSecretValue()) {
				throw new HttpError(401, "invalid replay token");
			}
			const row = state.db.getEvent(deliveryId);
			if (row === null) throw new HttpError(404, "unknown delivery");
			if (!state.db.requeueEvent(deliveryId, { from_states: INACTIVE_EVENT_STATES })) {
				throw new HttpError(409, `delivery ${deliveryId} is ${row.state}; only inactive events can be replayed`);
			}
			state.pool.wake();
			return json({ delivery: deliveryId, state: "queued" });
		});
		app.get("/api/github/issues", ({ request, query }) => this.#browseIssues(request, query));
		app.post("/api/trigger", ({ request }) => this.#trigger(request));
		app.post("/api/cancel", ({ request }) => this.#cancel(request));
		app.get("/events", ({ query }) => {
			const rows = this.state.db.listEvents(query.int("limit", 50));
			return json({
				events: rows.map(r => ({
					delivery_id: r.delivery_id,
					event_type: r.event_type,
					repo: r.repo,
					issue_key: r.issue_key,
					state: r.state,
					attempts: r.attempts,
					received_at: r.received_at,
					last_error: r.last_error,
				})),
			});
		});
		app.get("/issues", ({ query }) => {
			const rows = this.state.db.listIssues(query.int("limit", 100));
			return json({
				issues: rows.map(r => ({
					key: r.key,
					repo: r.repo,
					number: r.number,
					branch: r.branch,
					pr_number: r.pr_number,
					state: r.state,
					classification: r.classification,
					updated_at: r.updated_at,
				})),
			});
		});
		app.get("/releases", ({ query }) => {
			const capped = Math.max(1, Math.min(query.int("limit", 50), 500));
			return json({ releases: this.state.db.listReleases(capped).map(releasePayload) });
		});
		app.get("/", () => {
			const cfg = this.state.settings;
			return html(renderIndex(cfg.replay_token ? cfg.replay_token.getSecretValue() : null));
		});
		app.get("/api/status", () => this.#status());
		app.get("/api/logs", ({ query }) => {
			const cfg = this.state.settings;
			const capped = Math.max(1, Math.min(query.int("limit", 400), 2000));
			const entries = tailJsonl(path.join(cfg.log_dir, "robomp.log.jsonl"), capped);
			return json({ entries, count: entries.length, limit: capped });
		});
		// Built dashboard bundle; `index.html` itself is served by `/` so the
		// replay token can be substituted.
		app.get("/static/{path:path}", ({ params }) => {
			const file = staticFile(params.path!);
			if (file === null) throw new HttpError(404, "Not Found");
			return new Response(file);
		});
	}

	async #webhook(request: Request): Promise<Response> {
		const state = this.state;
		const cfg = state.settings;
		const eventType = requiredHeader(request, "X-GitHub-Event");
		const deliveryId = requiredHeader(request, "X-GitHub-Delivery");
		const signature = request.headers.get("X-Hub-Signature-256");
		const body = new Uint8Array(await request.arrayBuffer());
		if (!githubEvents.verifySignature(cfg.github_webhook_secret.getSecretValue(), body, signature)) {
			throw new HttpError(401, "invalid signature");
		}
		let payload: Json;
		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
			payload = parsed as Json;
		} catch (err) {
			throw new HttpError(400, `invalid json: ${err instanceof Error ? err.message : String(err)}`);
		}
		const db = state.db;
		state.issueBrowseCache.applyWebhook({ eventType, payload, allowlist: cfg.repo_allowlist });
		// Keep the local search index fresh from every delivery carrying an
		// issue/PR object — including ones the router will skip.
		if (eventType === "issues" || eventType === "issue_comment" || eventType.startsWith("pull_request")) {
			const repoFull = String((isMapping(payload.repository) && payload.repository.full_name) || "");
			if (repoFull && cfg.repo_allowlist.has(repoFull)) {
				try {
					issueIndex.ingestWebhookPayload(db, repoFull, eventType, payload);
				} catch (err) {
					log.exception("issue index webhook ingest failed", err, { repo: repoFull });
				}
			}
		}

		const decision = githubEvents.route(eventType, payload, {
			allowlist: cfg.repo_allowlist,
			botLogin: cfg.bot_login,
			maintainers: cfg.maintainer_logins,
			reviewerBots: cfg.reviewer_bots,
			prReviewEnabled: cfg.pr_review_enabled,
			releaseSentinelEnabled: cfg.release_sentinel_enabled,
			releaseCommitPrefix: cfg.release_commit_prefix,
			resolveIssueFromPr: (repoFull, prNumber) => db.findIssueByPr(repoFull, prNumber)?.key ?? null,
		});

		// Auto-close cancellation: any human signal (a follow-up comment, an
		// external close) cancels a pending question-issue closure.
		if (decision.issue_key) {
			const action = String(payload.action || "");
			let cancelReason: string | null = null;
			if (eventType === "issue_comment" && action === "created" && decision.task === "handle_comment") {
				cancelReason = "user_replied";
			} else if (eventType === "issues" && action === "closed") {
				cancelReason = "externally_closed";
			}
			if (cancelReason !== null && db.cancelPendingClosure(decision.issue_key, cancelReason)) {
				log.info("autoclose cancelled", { issue_key: decision.issue_key, reason: cancelReason, event: eventType });
			}
		}

		// Persist directive metadata on the stored payload so the durable queue
		// (and any replay) carries the maintainer signal forward.
		if (decision.directive) {
			payload = {
				...payload,
				_robomp_directive: {
					body: decision.directive_body,
					author: decision.directive_author,
					pragmas: decision.directive_pragmas.map(item => [...item]),
					authorizes_impl: decision.directive_authorizes_impl,
				},
			};
		}

		if (!githubEvents.shouldQueue(decision)) {
			log.info("skip", { event: eventType, reason: decision.reason });
			db.recordEvent({
				delivery_id: deliveryId,
				event_type: eventType,
				repo: decision.repo,
				issue_key: decision.issue_key,
				payload,
				state: "skipped",
				last_error: decision.reason,
			});
			return json({ delivery: deliveryId, state: "skipped" }, 202);
		}

		// Per-user rate limiting; lifecycle events carry no submitter.
		const submitter = decision.submitter;
		if (submitter) {
			const cap = githubEvents.rateLimitCap(submitter, decision.association, {
				unlimited: new Set([...cfg.rate_limit_unlimited, ...cfg.maintainer_logins]),
				default: cfg.rate_limit_default,
				contributor: cfg.rate_limit_contributor,
			});
			const admission = db.admitSubmission({
				delivery_id: deliveryId,
				login: submitter,
				repo: decision.repo,
				since: isoSecondsAgo(cfg.rate_limit_window_seconds),
				cap,
			});
			if (!admission.accepted) {
				const window = Math.trunc(cfg.rate_limit_window_seconds);
				const reason = `rate limit: @${submitter} has used ${admission.used}/${cap} submissions in the last ${window}s`;
				log.info("rate_limited", {
					event: eventType,
					delivery: deliveryId,
					login: submitter,
					association: decision.association,
					used: admission.used,
					cap,
				});
				db.recordEvent({
					delivery_id: deliveryId,
					event_type: eventType,
					repo: decision.repo,
					issue_key: decision.issue_key,
					payload,
					state: "skipped",
					last_error: reason,
				});
				return json({ delivery: deliveryId, state: "skipped", reason: "rate_limited" }, 202);
			}
		}

		const inserted = db.recordEvent({
			delivery_id: deliveryId,
			event_type: eventType,
			repo: decision.repo,
			issue_key: decision.issue_key,
			payload,
			state: "queued",
		});
		if (inserted) {
			state.pool.wake();
			log.info("queued", { event: eventType, delivery: deliveryId, key: decision.issue_key });
		} else {
			log.info("duplicate", { event: eventType, delivery: deliveryId });
		}
		return json({ delivery: deliveryId, state: "queued" }, 202);
	}

	/**
	 * Browse issues across the allowlist for the trigger picker. Token-gated
	 * like `/api/trigger` (it can expose private titles); normal loads use the
	 * server cache, only misses and explicit refreshes hit GitHub.
	 */
	async #browseIssues(request: Request, query: Query): Promise<Response> {
		const state = this.state;
		const cfg = state.settings;
		const issueState = query.str("state", "open");
		const limit = query.int("limit", 30);
		const refresh = query.bool("refresh", false);
		requireTriggerToken(cfg, request.headers.get(TOKEN_HEADER));
		if (issueState !== "open" && issueState !== "closed" && issueState !== "all") {
			throw new HttpError(400, "state must be open|closed|all");
		}
		const capped = Math.max(1, Math.min(limit, 100));
		const repos = [...cfg.repo_allowlist].sort();
		if (repos.length === 0)
			return json({ issues: [], errors: [], repos: [], cache: { hit: false, fetched_at: nowSeconds() } });
		const fetch = async (): Promise<[IssueSummary[], { repo: string; error: string }[]]> => {
			// Fan out; per-repo failures don't take down the panel.
			const results = await Promise.all(
				repos.map(async repo => {
					try {
						return [
							repo,
							await state.github.listIssues(repo, { state: issueState, limit: capped }),
							null,
						] as const;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						log.warning("list_issues failed", { repo, err: message });
						return [repo, [] as IssueSummary[], message] as const;
					}
				}),
			);
			const merged: IssueSummary[] = [];
			const errors: { repo: string; error: string }[] = [];
			for (const [repo, items, err] of results) {
				if (err !== null) errors.push({ repo, error: err });
				merged.push(...items);
			}
			return [merged, errors];
		};
		const [entry, cacheHit] = await state.issueBrowseCache.getOrFetch({
			state: issueState,
			limit: capped,
			repos,
			force: refresh,
			fetch,
		});
		// `processed` is not cached: a freshly-triaged issue must disappear from
		// the "fresh issues" filter on the next refresh.
		const processed = state.db.processedIssueKeys(entry.issues.map(s => makeIssueKey(s.repo, s.number)));
		return json(issueBrowsePayload(entry, cacheHit, processed));
	}

	/** Manually queue an issue: `triage` (fetch fresh + enqueue) or `retry` (requeue a stored event). */
	async #trigger(request: Request): Promise<Response> {
		const payload = await jsonObjectBody(request);
		const state = this.state;
		const cfg = state.settings;
		requireTriggerToken(cfg, request.headers.get(TOKEN_HEADER));
		const { db, github, pool } = state;
		const mode = String(payload.mode || "")
			.trim()
			.toLowerCase();
		if (mode !== "triage" && mode !== "retry") throw new HttpError(400, "mode must be 'triage' or 'retry'");
		const issueRef = payload.issue;
		const deliveryIdRaw = payload.delivery_id;

		const parseRef = (ref: string): [string, number] => {
			try {
				return parseIssueRef(ref);
			} catch (err) {
				if (err instanceof InvalidIssueRef) throw new HttpError(400, err.message);
				throw err;
			}
		};

		if (mode === "triage") {
			if (typeof issueRef !== "string" || !issueRef) {
				throw new HttpError(400, "triage requires 'issue' = 'owner/repo#NN'");
			}
			const [repoFull, number] = parseRef(issueRef);
			if (!cfg.allows(repoFull)) throw new HttpError(403, `${repoFull} not in ROBOMP_REPO_ALLOWLIST`);
			let delivery: string;
			try {
				delivery = await enqueueManualTriage({ db, github, repoFull, number });
			} catch (err) {
				if (err instanceof ManualTriageConflict) throw new HttpError(409, err.message);
				if (err instanceof ManualTriageError) throw new HttpError(400, err.message);
				if (err instanceof GitHubError) throw new HttpError(502, `github error: ${err.status} ${err.detail}`);
				throw err;
			}
			pool.wake();
			log.info("manual triage", { delivery, issue: `${repoFull}#${number}` });
			return json({ delivery, state: "queued", mode: "triage" }, 202);
		}

		let target: string;
		if (typeof deliveryIdRaw === "string" && deliveryIdRaw) {
			target = deliveryIdRaw;
		} else if (typeof issueRef === "string" && issueRef) {
			const [repoFull, number] = parseRef(issueRef);
			if (!cfg.allows(repoFull)) throw new HttpError(403, `${repoFull} not in ROBOMP_REPO_ALLOWLIST`);
			const row = db.latestEventForIssue(makeIssueKey(repoFull, number));
			if (row === null) throw new HttpError(404, `no retryable stored event for ${repoFull}#${number}`);
			target = row.delivery_id;
		} else {
			throw new HttpError(400, "retry requires 'delivery_id' or 'issue'");
		}
		const event = db.getEvent(target);
		if (event === null) throw new HttpError(404, `unknown delivery ${target}`);
		if (!db.requeueEvent(target, { from_states: INACTIVE_EVENT_STATES })) {
			throw new HttpError(409, `delivery ${target} is ${event.state}; only inactive events can be retried`);
		}
		pool.wake();
		log.info("manual retry", { delivery: target });
		return json({ delivery: target, state: "queued", mode: "retry" }, 202);
	}

	/** Stop a running event: the omp subprocess is killed; the row lands `failed`. */
	async #cancel(request: Request): Promise<Response> {
		const payload = await jsonObjectBody(request);
		const state = this.state;
		requireTriggerToken(state.settings, request.headers.get(TOKEN_HEADER));
		const deliveryId = payload.delivery_id;
		if (typeof deliveryId !== "string" || !deliveryId) throw new HttpError(400, "cancel requires 'delivery_id'");
		const event = state.db.getEvent(deliveryId);
		if (event === null) throw new HttpError(404, `unknown delivery ${deliveryId}`);
		if (event.state !== "running") {
			throw new HttpError(409, `delivery ${deliveryId} is ${event.state}; only running deliveries can be cancelled`);
		}
		const fired = await state.pool.cancelEvent(deliveryId);
		log.info("manual cancel", { delivery: deliveryId, fired, state: event.state });
		return json({ delivery: deliveryId, fired, previous_state: event.state }, 202);
	}

	async #status(): Promise<Response> {
		const state = this.state;
		const { settings: cfg, db, pool } = state;
		const issuesRows = db.listIssues(200);
		const releaseRows = db.listReleases(50);
		const latestEvents = db.latestEventsForIssues(issuesRows.map(r => r.key));
		const latestEventPayload = (key: string) => {
			const latest = latestEvents.get(key);
			if (latest === undefined) return null;
			return {
				delivery_id: latest.delivery_id,
				event_type: latest.event_type,
				state: latest.state,
				attempts: latest.attempts,
				received_at: latest.received_at,
				last_error: latest.last_error,
			};
		};
		const eventsRows = db.listEvents(25);
		// Recent events can reference issues outside the 200-issue window;
		// surface each event's current issue state so the dashboard can
		// suppress failures for issues that have since gone terminal.
		const issueStateByKey = new Map<string, string | null>(issuesRows.map(r => [r.key, r.state]));
		const recentIssueState = (key: string | null): string | null => {
			if (!key) return null;
			if (!issueStateByKey.has(key)) issueStateByKey.set(key, db.getIssue(key)?.state ?? null);
			return issueStateByKey.get(key) ?? null;
		};
		const collected = {
			event_counts: db.eventStateCounts(),
			issue_event_counts: db.latestIssueEventStateCounts(),
			running_events: db.listRunningEvents(),
			issues: issuesRows.map(r => ({
				key: r.key,
				repo: r.repo,
				number: r.number,
				branch: r.branch,
				pr_number: r.pr_number,
				state: r.state,
				classification: r.classification,
				updated_at: r.updated_at,
				latest_event: latestEventPayload(r.key),
			})),
			releases: releaseRows.map(releasePayload),
			recent_events: eventsRows.map(r => ({
				delivery_id: r.delivery_id,
				event_type: r.event_type,
				repo: r.repo,
				issue_key: r.issue_key,
				state: r.state,
				attempts: r.attempts,
				received_at: r.received_at,
				last_error: r.last_error,
				issue_state: recentIssueState(r.issue_key),
			})),
		};
		const inflight = await pool.inflightSnapshot();
		return json({
			runtime: {
				bot_login: cfg.bot_login,
				repo_allowlist: [...cfg.repo_allowlist].sort(),
				max_concurrency: cfg.max_concurrency,
				model: cfg.model,
				thinking_level: cfg.thinking_level,
				uptime_seconds: Math.max(0, nowSeconds() - state.startedAt),
			},
			inflight,
			...collected,
		});
	}
}

/** Build the server (FastAPI `create_app` analogue); call `start()` to run the lifespan. */
export function createApp(settings: Settings | null = null, options: { poolFactory?: PoolFactory } = {}): RobompServer {
	return new RobompServer(settings, options);
}
