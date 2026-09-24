/** Minimal typed GitHub REST client (PAT auth). */
import { getLogger } from "./logging";
import { defaultTransport, type HttpTransport, type QueryValue, sendRequest, TransportError } from "./http";

const log = getLogger("robomp.github_client");

export const GITHUB_API = "https://api.github.com";
export const ACCEPT = "application/vnd.github+json";
export const API_VERSION = "2022-11-28";

/** Raised on non-2xx responses from GitHub. */
export class GitHubError extends Error {
	readonly status: number;
	readonly retry_after: number | null;
	constructor(
		status: number,
		readonly detail: string,
		options: { retryAfter?: number | null } = {},
	) {
		super(`GitHub ${status}: ${detail}`);
		this.name = "GitHubError";
		this.status = status;
		this.retry_after = options.retryAfter ?? null;
	}
}

export interface IssueInfo {
	repo: string;
	number: number;
	title: string;
	body: string;
	state: string;
	author: string;
	labels: readonly string[];
	is_pull_request: boolean;
}

export interface CommentInfo {
	id: number;
	author: string;
	body: string;
	created_at: string;
}

export interface RepoInfo {
	full_name: string;
	default_branch: string;
	clone_url: string;
	private: boolean;
}

export interface PullRequestInfo {
	repo: string;
	number: number;
	html_url: string;
	head_ref: string;
	base_ref: string;
	state: string;
	author: string;
	head_repo: string;
	title: string;
	body: string;
	head_sha: string;
}

export function pullRequestInfo(
	init: Pick<PullRequestInfo, "repo" | "number" | "html_url" | "head_ref" | "base_ref" | "state"> &
		Partial<PullRequestInfo>,
): PullRequestInfo {
	return { author: "", head_repo: "", title: "", body: "", head_sha: "", ...init };
}

export interface PullRequestFileInfo {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	patch: string;
}

/** GitHub Actions workflow run for release verdict aggregation. */
export interface WorkflowRunInfo {
	id: number;
	name: string;
	event: string;
	status: string;
	conclusion: string | null;
	head_branch: string | null;
	head_sha: string;
	html_url: string;
	run_attempt: number;
}

/** GitHub Actions job with its failed step names. */
export interface WorkflowJobInfo {
	id: number;
	run_id: number;
	name: string;
	status: string;
	conclusion: string | null;
	html_url: string;
	failed_steps: readonly string[];
}

/** Published GitHub Release metadata for a tag. */
export interface ReleaseInfo {
	tag: string;
	name: string | null;
	draft: boolean;
	prerelease: boolean;
	html_url: string;
	asset_names: readonly string[];
}

/** In-line PR review comment (attached to a file/line). */
export interface ReviewCommentInfo {
	id: number;
	author: string;
	body: string;
	path: string;
	line: number | null;
	created_at: string;
}

/** Top-level PR review (the summary block, not the inline comments). */
export interface PullRequestReviewInfo {
	id: number;
	author: string;
	body: string;
	state: string;
	submitted_at: string;
}

/** Lightweight projection of an issue for list views (no body). */
export interface IssueSummary {
	repo: string;
	number: number;
	title: string;
	state: string;
	author: string;
	labels: readonly string[];
	comments: number;
	updated_at: string;
	created_at: string;
	html_url: string;
	/** `completed` / `not_planned` / `reopened` when closed; empty otherwise. */
	state_reason: string;
	is_pull_request: boolean;
}

/** Full projection of an issue/PR for the local search index (includes body). */
export interface IssueIndexEntry {
	repo: string;
	number: number;
	is_pull_request: boolean;
	title: string;
	body: string;
	state: string;
	state_reason: string;
	merged_at: string;
	author: string;
	labels: readonly string[];
	comments: number;
	created_at: string;
	updated_at: string;
	html_url: string;
}

/** A reaction on an issue/comment. */
export interface ReactionInfo {
	content: string;
	user_login: string;
	user_type: string;
}

export type Json = Record<string, unknown>;

export function isMapping(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `str(x or "")`. */
export function s(value: unknown): string {
	if (value === undefined || value === null || value === false || value === 0 || value === "") return "";
	return String(value);
}

/** Python `int(x or 0)`. */
export function n(value: unknown, fallback = 0): number {
	if (value === undefined || value === null || value === "" || value === false) return fallback;
	if (value === true) return 1;
	const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
	if (Number.isNaN(parsed)) throw new TypeError(`invalid literal for int(): ${JSON.stringify(value)}`);
	return parsed === 0 ? fallback : parsed;
}

function required(data: Json, key: string): unknown {
	if (!(key in data)) throw new TypeError(`missing key ${JSON.stringify(key)}`);
	return data[key];
}

function requiredInt(data: Json, key: string): number {
	const value = required(data, key);
	const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value), 10);
	if (Number.isNaN(parsed)) throw new TypeError(`invalid literal for int(): ${JSON.stringify(value)}`);
	return parsed;
}

function obj(value: unknown): Json {
	return isMapping(value) ? value : {};
}

function labelNames(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.map(lbl => (isMapping(lbl) ? String(lbl.name) : String(lbl)));
}

function parseRetryAfter(resp: Response): number | null {
	const ra = resp.headers.get("retry-after");
	if (ra) {
		const value = Number(ra);
		if (!Number.isNaN(value)) return value;
	}
	const reset = resp.headers.get("x-ratelimit-reset");
	if (reset) {
		const value = Number(reset);
		if (!Number.isNaN(value)) return Math.max(0, value - Date.now() / 1000);
	}
	return null;
}

export interface GitHubClientOptions {
	transport?: HttpTransport;
	platform?: string;
	baseUrl?: string;
}

/** Backoff schedule for transient connection/timeout/5xx errors (seconds). */
export const TRANSIENT_RETRY_DELAYS = { value: [1.0, 3.0, 10.0] as readonly number[] };
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

export interface RequestOptions {
	json?: unknown;
	params?: Record<string, QueryValue>;
}

/** Async facade over a small slice of the GitHub REST API. */
export class GitHubClient {
	readonly #headers: Record<string, string>;
	readonly #transport: HttpTransport;
	readonly #platform: string;
	readonly #baseUrl: string;

	constructor(token: string, options: GitHubClientOptions = {}) {
		this.#headers = {
			Authorization: `Bearer ${token}`,
			Accept: ACCEPT,
			"X-GitHub-Api-Version": API_VERSION,
			"User-Agent": "robomp/0.1",
		};
		this.#transport = options.transport ?? defaultTransport;
		this.#platform = options.platform ?? "github";
		this.#baseUrl = options.baseUrl ?? GITHUB_API;
	}

	get platform(): string {
		return this.#platform;
	}

	async #check(resp: Response): Promise<unknown> {
		if (resp.status >= 400) {
			const retryAfter = parseRetryAfter(resp);
			const text = await resp.text();
			let msg: string = text;
			try {
				const parsed = JSON.parse(text) as unknown;
				if (isMapping(parsed) && "message" in parsed) msg = String(parsed.message);
			} catch {}
			throw new GitHubError(resp.status, msg, { retryAfter });
		}
		if (resp.status >= 300) {
			const location = resp.headers.get("location") ?? "";
			throw new GitHubError(resp.status, `unexpected redirect to '${location}'; resource may have moved`);
		}
		const text = await resp.text();
		if (resp.status === 204 || !text) return null;
		return JSON.parse(text) as unknown;
	}

	#transient5xx(method: string, exc: GitHubError): boolean {
		return IDEMPOTENT_METHODS.has(method.toUpperCase()) && TRANSIENT_STATUSES.has(exc.status);
	}

	async request(method: string, path: string, options: RequestOptions = {}): Promise<any> {
		const delays = [...TRANSIENT_RETRY_DELAYS.value, null];
		let lastExc: unknown;
		for (const [attempt, delay] of delays.entries()) {
			try {
				const resp = await sendRequest(this.#transport, this.#baseUrl, {
					method,
					url: path,
					headers: this.#headers,
					params: options.params,
					json: options.json,
					timeoutMs: 30_000,
				});
				return await this.#check(resp);
			} catch (exc) {
				if (exc instanceof TransportError) {
					lastExc = exc;
					if (delay === null) break;
					log.warning("transient error, retrying", {
						method,
						path,
						attempt: attempt + 1,
						delay,
						error: exc.message,
					});
					await Bun.sleep(delay * 1000);
					continue;
				}
				if (exc instanceof GitHubError) {
					if (delay === null || !this.#transient5xx(method, exc)) throw exc;
					lastExc = exc;
					log.warning("transient github 5xx, retrying", {
						method,
						path,
						attempt: attempt + 1,
						delay,
						status: exc.status,
					});
					await Bun.sleep(delay * 1000);
					continue;
				}
				throw exc;
			}
		}
		throw lastExc;
	}

	/** Stream a text response while retaining at most its final bytes. */
	async #requestTextTail(path: string, maxBytes: number): Promise<string> {
		const delays = [...TRANSIENT_RETRY_DELAYS.value, null];
		let lastExc: unknown;
		for (const [attempt, delay] of delays.entries()) {
			try {
				const resp = await sendRequest(this.#transport, this.#baseUrl, {
					method: "GET",
					url: path,
					headers: this.#headers,
					timeoutMs: 30_000,
				});
				if (resp.status >= 300) await this.#check(resp);
				let tail = new Uint8Array(0);
				if (resp.body) {
					for await (const chunk of resp.body) {
						const merged = new Uint8Array(tail.length + chunk.length);
						merged.set(tail);
						merged.set(chunk, tail.length);
						tail = merged.length > maxBytes ? merged.slice(merged.length - maxBytes) : merged;
					}
				}
				return new TextDecoder("utf-8", { fatal: false }).decode(tail);
			} catch (exc) {
				if (exc instanceof TransportError) {
					lastExc = exc;
					if (delay === null) break;
					log.warning("transient text fetch error, retrying", {
						path,
						attempt: attempt + 1,
						delay,
						error: exc.message,
					});
					await Bun.sleep(delay * 1000);
					continue;
				}
				if (exc instanceof GitHubError) {
					if (delay === null || !this.#transient5xx("GET", exc)) throw exc;
					lastExc = exc;
					log.warning("transient github text fetch 5xx, retrying", {
						path,
						attempt: attempt + 1,
						delay,
						status: exc.status,
					});
					await Bun.sleep(delay * 1000);
					continue;
				}
				throw exc;
			}
		}
		throw lastExc;
	}

	// ---- repos / issues / comments / PRs ----
	async getRepo(repo: string): Promise<RepoInfo> {
		return repoFromPayload(obj(await this.request("GET", `/repos/${repo}`)));
	}

	/** List workflow runs attached to one commit. */
	async listWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRunInfo[]> {
		const data = obj(
			await this.request("GET", `/repos/${repo}/actions/runs`, { params: { head_sha: headSha, per_page: 100 } }),
		);
		return asArray(data.workflow_runs).map(item => workflowRunFromPayload(obj(item)));
	}

	/** List the latest jobs for a workflow run. */
	async listWorkflowJobs(repo: string, runId: number): Promise<WorkflowJobInfo[]> {
		const data = obj(
			await this.request("GET", `/repos/${repo}/actions/runs/${runId}/jobs`, {
				params: { filter: "latest", per_page: 100 },
			}),
		);
		return asArray(data.jobs).map(item => workflowJobFromPayload(obj(item)));
	}

	/** Return the final lines of a GitHub Actions job log. */
	async getJobLogTail(repo: string, jobId: number, tailLines = 200): Promise<string> {
		const limit = Math.max(0, Math.trunc(tailLines));
		if (limit === 0) return "";
		const text = await this.#requestTextTail(`/repos/${repo}/actions/jobs/${jobId}/logs`, 4 * 1024 * 1024);
		return splitLines(text).slice(-limit).join("\n");
	}

	/** Resolve a lightweight or annotated tag to its commit SHA. */
	async getTagSha(repo: string, tag: string): Promise<string | null> {
		const encoded = encodeURIComponent(tag);
		let data: unknown;
		try {
			data = await this.request("GET", `/repos/${repo}/git/ref/tags/${encoded}`);
		} catch (exc) {
			if (exc instanceof GitHubError && exc.status === 404) return null;
			throw exc;
		}
		let object = obj(obj(data).object);
		let sha = s(object.sha);
		if (object.type === "tag" && sha) {
			const annotated = await this.request("GET", `/repos/${repo}/git/tags/${sha}`);
			object = obj(obj(annotated).object);
			sha = s(object.sha);
		}
		return sha || null;
	}

	/** Return the GitHub Release for a tag when one exists. */
	async getReleaseByTag(repo: string, tag: string): Promise<ReleaseInfo | null> {
		const encoded = encodeURIComponent(tag);
		try {
			return releaseFromPayload(obj(await this.request("GET", `/repos/${repo}/releases/tags/${encoded}`)));
		} catch (exc) {
			if (exc instanceof GitHubError && exc.status === 404) return null;
			throw exc;
		}
	}

	async getIssue(repo: string, number: number): Promise<IssueInfo> {
		return issueFromPayload(repo, obj(await this.request("GET", `/repos/${repo}/issues/${number}`)));
	}

	/**
	 * Return open PR numbers currently linked to issue `number` via closing
	 * keywords or the Development panel (net connected − disconnected).
	 */
	async listClosingPullRequests(repo: string, number: number): Promise<number[]> {
		const data = await this.request("GET", `/repos/${repo}/issues/${number}/timeline`, {
			params: { per_page: 100 },
		});
		const linked = new Set<number>();
		const states = new Map<number, string>();
		for (const event of asArray(data)) {
			if (!isMapping(event)) continue;
			const ev = event.event;
			const source = event.source;
			const srcIssue = isMapping(source) ? source.issue : undefined;
			if (!isMapping(srcIssue) || !("pull_request" in srcIssue)) continue;
			const prNumber = srcIssue.number;
			if (typeof prNumber !== "number" || !Number.isInteger(prNumber)) continue;
			states.set(prNumber, s(srcIssue.state) || "open");
			if (ev === "connected") linked.add(prNumber);
			else if (ev === "disconnected") linked.delete(prNumber);
		}
		return [...linked].filter(num => (states.get(num) ?? "open") === "open").sort((a, b) => a - b);
	}

	async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
		return prFromPayload(repo, obj(await this.request("GET", `/repos/${repo}/pulls/${number}`)));
	}

	async listPrFiles(repo: string, prNumber: number): Promise<PullRequestFileInfo[]> {
		const files: PullRequestFileInfo[] = [];
		for (let page = 1; ; page++) {
			const data = await this.request("GET", `/repos/${repo}/pulls/${prNumber}/files`, {
				params: { per_page: 100, page },
			});
			const batch = asArray(data).map(item => prFileFromPayload(obj(item)));
			files.push(...batch);
			if (batch.length < 100) return files;
		}
	}

	/** List recent issues for `repo`, newest-updated first. Excludes pull requests. */
	async listIssues(repo: string, options: { state?: string; limit?: number } = {}): Promise<IssueSummary[]> {
		const state = options.state ?? "open";
		if (!["open", "closed", "all"].includes(state)) throw new Error(`invalid state: '${state}'`);
		const perPage = Math.max(1, Math.min(Math.trunc(options.limit ?? 30), 100));
		const data = await this.request("GET", `/repos/${repo}/issues`, {
			params: { state, per_page: perPage, sort: "updated", direction: "desc" },
		});
		const out: IssueSummary[] = [];
		for (const item of asArray(data)) {
			if (isMapping(item) && "pull_request" in item) continue;
			out.push(summaryFromItem(repo, obj(item)));
		}
		return out;
	}

	/** Search issues AND pull requests in `repo` using GitHub issue-search syntax. */
	async searchIssues(repo: string, query: string, limit = 10): Promise<IssueSummary[]> {
		const perPage = Math.max(1, Math.min(Math.trunc(limit), 30));
		const data = obj(
			await this.request("GET", "/search/issues", {
				params: { q: `repo:${repo} ${query}`.trim(), per_page: perPage },
			}),
		);
		return asArray(data.items).map(item => summaryFromItem(repo, obj(item)));
	}

	/** One page of issues AND PRs (with bodies) for the local search index. */
	async listIssueIndexEntries(
		repo: string,
		options: { since?: string | null; page?: number; per_page?: number } = {},
	): Promise<IssueIndexEntry[]> {
		const params: Record<string, QueryValue> = {
			state: "all",
			per_page: Math.max(1, Math.min(Math.trunc(options.per_page ?? 100), 100)),
			page: Math.max(1, Math.trunc(options.page ?? 1)),
			sort: "updated",
			direction: "asc",
		};
		if (options.since) params.since = options.since;
		const data = await this.request("GET", `/repos/${repo}/issues`, { params });
		return asArray(data).map(item => indexEntryFromIssueObject(repo, obj(item)));
	}

	async listComments(repo: string, number: number): Promise<CommentInfo[]> {
		const data = await this.request("GET", `/repos/${repo}/issues/${number}/comments`, {
			params: { per_page: 100 },
		});
		return asArray(data).map(item => commentFromPayload(obj(item)));
	}

	/** List inline review comments on a PR (the ones attached to a path:line). */
	async listReviewComments(repo: string, prNumber: number): Promise<ReviewCommentInfo[]> {
		const data = await this.request("GET", `/repos/${repo}/pulls/${prNumber}/comments`, {
			params: { per_page: 100 },
		});
		return asArray(data).map(raw => {
			const item = obj(raw);
			const user = obj(item.user);
			let line: number | null = Number.isInteger(item.line) ? (item.line as number) : null;
			if (line === null) line = Number.isInteger(item.original_line) ? (item.original_line as number) : null;
			return {
				id: n(item.id),
				author: s(user.login),
				body: s(item.body),
				path: s(item.path),
				line,
				created_at: s(item.created_at),
			};
		});
	}

	/** List top-level reviews on a PR. Empty-body reviews are skipped. */
	async listPrReviews(repo: string, prNumber: number): Promise<PullRequestReviewInfo[]> {
		const data = await this.request("GET", `/repos/${repo}/pulls/${prNumber}/reviews`, {
			params: { per_page: 100 },
		});
		const out: PullRequestReviewInfo[] = [];
		for (const raw of asArray(data)) {
			const item = obj(raw);
			const user = obj(item.user);
			const body = s(item.body).trim();
			if (!body) continue;
			out.push({
				id: n(item.id),
				author: s(user.login),
				body,
				state: s(item.state),
				submitted_at: s(item.submitted_at) || s(item.created_at),
			});
		}
		return out;
	}

	async postComment(repo: string, number: number, body: string): Promise<CommentInfo> {
		return commentFromPayload(
			obj(await this.request("POST", `/repos/${repo}/issues/${number}/comments`, { json: { body } })),
		);
	}

	async openPullRequest(args: {
		repo: string;
		head: string;
		base: string;
		title: string;
		body: string;
		draft?: boolean;
		maintainer_can_modify?: boolean;
	}): Promise<PullRequestInfo> {
		const data = await this.request("POST", `/repos/${args.repo}/pulls`, {
			json: {
				title: args.title,
				body: args.body,
				head: args.head,
				base: args.base,
				draft: args.draft ?? false,
				maintainer_can_modify: args.maintainer_can_modify ?? true,
			},
		});
		return prFromPayload(args.repo, obj(data));
	}

	async requestReviewers(args: {
		repo: string;
		pr_number: number;
		reviewers?: string[] | null;
		team_reviewers?: string[] | null;
	}): Promise<void> {
		const payload: Json = {};
		if (args.reviewers?.length) payload.reviewers = args.reviewers;
		if (args.team_reviewers?.length) payload.team_reviewers = args.team_reviewers;
		if (Object.keys(payload).length === 0) return;
		await this.request("POST", `/repos/${args.repo}/pulls/${args.pr_number}/requested_reviewers`, {
			json: payload,
		});
	}

	/** Append labels to an issue (or PR). Returns the full label set after the add. */
	async addIssueLabels(repo: string, number: number, labels: string[]): Promise<string[]> {
		if (labels.length === 0) return [];
		const data = await this.request("POST", `/repos/${repo}/issues/${number}/labels`, { json: { labels } });
		return labelNames(asArray(data));
	}

	/** Remove one label from an issue (or PR). */
	async removeIssueLabel(repo: string, number: number, label: string): Promise<void> {
		if (!label) return;
		await this.request("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
	}

	/** Adapt canonical host-tool comment shape to the wire schema for this platform. */
	#reviewCommentsPayload(comments: readonly Json[]): Json[] {
		if (this.#platform !== "forgejo") return comments.map(c => ({ ...c }));
		return comments.map(c => {
			const entry: Json = { path: c.path, body: c.body };
			if (String(c.side ?? "RIGHT").toUpperCase() === "LEFT") entry.old_position = c.line;
			else entry.new_position = c.line;
			return entry;
		});
	}

	async submitPrReview(args: {
		repo: string;
		pr_number: number;
		body: string;
		event: string;
		comments: readonly Json[];
		commit_id?: string | null;
	}): Promise<PullRequestReviewInfo> {
		const payload: Json = {
			body: args.body,
			event: args.event,
			comments: this.#reviewCommentsPayload(args.comments),
		};
		if (args.commit_id) payload.commit_id = args.commit_id;
		const data = await this.request("POST", `/repos/${args.repo}/pulls/${args.pr_number}/reviews`, {
			json: payload,
		});
		return prReviewFromPayload(obj(data));
	}

	async addAssignees(repo: string, number: number, assignees: string[]): Promise<void> {
		if (assignees.length === 0) return;
		await this.request("POST", `/repos/${repo}/issues/${number}/assignees`, { json: { assignees } });
	}

	/** Reactions on an issue comment, filtered server-side to 👎 (`content=-1`). */
	async listCommentReactions(repo: string, commentId: number): Promise<ReactionInfo[]> {
		const data = await this.request("GET", `/repos/${repo}/issues/comments/${commentId}/reactions`, {
			params: { content: "-1", per_page: 100 },
		});
		return asArray(data).map(item => reactionFromPayload(obj(item)));
	}

	/** Close an issue with `state_reason`. */
	async closeIssue(repo: string, number: number, reason = "completed"): Promise<void> {
		await this.request("PATCH", `/repos/${repo}/issues/${number}`, {
			json: { state: "closed", state_reason: reason },
		});
	}

	async getAuthenticatedLogin(): Promise<string> {
		const data = obj(await this.request("GET", "/user"));
		return String(required(data, "login"));
	}
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Python `str.splitlines()` semantics (no trailing empty element). */
export function splitLines(text: string): string[] {
	if (!text) return [];
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function workflowRunFromPayload(data: Json): WorkflowRunInfo {
	return {
		id: n(data.id),
		name: s(data.name),
		event: s(data.event),
		status: s(data.status),
		conclusion: data.conclusion === undefined || data.conclusion === null ? null : String(data.conclusion),
		head_branch: data.head_branch === undefined || data.head_branch === null ? null : String(data.head_branch),
		head_sha: s(data.head_sha),
		html_url: s(data.html_url),
		run_attempt: n(data.run_attempt, 1),
	};
}

export function workflowJobFromPayload(data: Json): WorkflowJobInfo {
	const failedSteps = asArray(data.steps)
		.filter(isMapping)
		.filter(step => step.conclusion !== "success" && step.conclusion !== "skipped")
		.map(step => s(step.name));
	return {
		id: n(data.id),
		run_id: n(data.run_id),
		name: s(data.name),
		status: s(data.status),
		conclusion: data.conclusion === undefined || data.conclusion === null ? null : String(data.conclusion),
		html_url: s(data.html_url),
		failed_steps: failedSteps,
	};
}

export function releaseFromPayload(data: Json): ReleaseInfo {
	return {
		tag: s(data.tag_name),
		name: data.name === undefined || data.name === null ? null : String(data.name),
		draft: Boolean(data.draft),
		prerelease: Boolean(data.prerelease),
		html_url: s(data.html_url),
		asset_names: asArray(data.assets)
			.filter(isMapping)
			.map(asset => s(asset.name)),
	};
}

export function repoFromPayload(data: Json): RepoInfo {
	return {
		full_name: String(required(data, "full_name")),
		default_branch: String(required(data, "default_branch")),
		clone_url: String(required(data, "clone_url")),
		private: Boolean(data.private ?? false),
	};
}

export function issueFromPayload(repo: string, data: Json): IssueInfo {
	const user = obj(data.user);
	return {
		repo,
		number: requiredInt(data, "number"),
		title: s(data.title),
		body: s(data.body),
		state: s(data.state) || "open",
		author: s(user.login),
		labels: labelNames(data.labels),
		is_pull_request: "pull_request" in data,
	};
}

export function prReviewFromPayload(data: Json): PullRequestReviewInfo {
	const user = data.user;
	return {
		id: n(data.id),
		author: isMapping(user) ? s(user.login) : "",
		body: s(data.body).trim(),
		state: s(data.state),
		submitted_at: s(data.submitted_at) || s(data.created_at),
	};
}

/** Build an `IssueSummary` from a REST issue object (list or search shape). */
export function summaryFromItem(repo: string, item: Json): IssueSummary {
	const user = obj(item.user);
	return {
		repo,
		number: requiredInt(item, "number"),
		title: s(item.title),
		state: s(item.state) || "open",
		author: s(user.login),
		labels: labelNames(item.labels),
		comments: n(item.comments),
		updated_at: s(item.updated_at),
		created_at: s(item.created_at),
		html_url: s(item.html_url),
		state_reason: s(item.state_reason),
		is_pull_request: "pull_request" in item,
	};
}

/** Build an `IssueIndexEntry` from a REST *issue-shaped* object. */
export function indexEntryFromIssueObject(repo: string, item: Json): IssueIndexEntry {
	const user = obj(item.user);
	const prObj = item.pull_request;
	const isPr = prObj !== undefined && prObj !== null;
	return {
		repo,
		number: requiredInt(item, "number"),
		is_pull_request: isPr,
		title: s(item.title),
		body: s(item.body),
		state: s(item.state) || "open",
		state_reason: s(item.state_reason),
		merged_at: isMapping(prObj) ? s(prObj.merged_at) : "",
		author: s(user.login),
		labels: labelNames(item.labels),
		comments: n(item.comments),
		created_at: s(item.created_at),
		updated_at: s(item.updated_at),
		html_url: s(item.html_url),
	};
}

/** Build an `IssueIndexEntry` from a REST *pull-request-shaped* object. */
export function indexEntryFromPrObject(repo: string, item: Json): IssueIndexEntry {
	const user = obj(item.user);
	return {
		repo,
		number: requiredInt(item, "number"),
		is_pull_request: true,
		title: s(item.title),
		body: s(item.body),
		state: s(item.state) || "open",
		state_reason: "",
		merged_at: s(item.merged_at),
		author: s(user.login),
		labels: labelNames(item.labels),
		comments: n(item.comments),
		created_at: s(item.created_at),
		updated_at: s(item.updated_at),
		html_url: s(item.html_url),
	};
}

export function prFileFromPayload(data: Json): PullRequestFileInfo {
	return {
		path: s(data.filename) || s(data.path),
		status: s(data.status),
		additions: n(data.additions),
		deletions: n(data.deletions),
		patch: s(data.patch),
	};
}

export function prFromPayload(repo: string, data: Json): PullRequestInfo {
	const head = data.head;
	const base = data.base;
	const user = data.user;
	const headRepo = isMapping(head) ? head.repo : undefined;
	return {
		repo,
		number: requiredInt(data, "number"),
		html_url: String(required(data, "html_url")),
		head_ref: isMapping(head) ? s(head.ref) : "",
		base_ref: isMapping(base) ? s(base.ref) : "",
		state: s(data.state) || "open",
		author: isMapping(user) ? s(user.login) : "",
		head_repo: isMapping(headRepo) ? s(headRepo.full_name) : "",
		title: s(data.title),
		body: s(data.body),
		head_sha: isMapping(head) ? s(head.sha) : "",
	};
}

export function commentFromPayload(data: Json): CommentInfo {
	const user = obj(data.user);
	return {
		id: requiredInt(data, "id"),
		author: s(user.login),
		body: s(data.body),
		created_at: s(data.created_at),
	};
}

export function reactionFromPayload(data: Json): ReactionInfo {
	const user = data.user;
	return {
		content: s(data.content),
		user_login: isMapping(user) ? s(user.login) : "",
		user_type: isMapping(user) ? s(user.type) : "",
	};
}

/** Build typed records from a webhook payload (issues.opened, etc.). */
export function parseIssuePayload(payload: Json): [RepoInfo, IssueInfo] {
	const repo = repoFromPayload(obj(required(payload, "repository")));
	const issue = issueFromPayload(repo.full_name, obj(required(payload, "issue")));
	return [repo, issue];
}
