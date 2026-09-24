/**
 * Client half of the roboomp ↔ gh-proxy channel.
 *
 * `GitHubProxyClient` implements `GitHubBackend` by HMAC-signing each request
 * and forwarding it to gh-proxy. `ProxyGitTransport` implements `GitTransport`
 * by routing clone/fetch/push through the proxy too — roboomp never holds the
 * PAT. Tests inject a transport to short-circuit the network.
 */
import { GitCommandError, HeadDriftError, type PushResult } from "./git-ops";
import type { GitHubBackend } from "./github-backend";
import {
	type CommentInfo,
	GitHubError,
	type IssueIndexEntry,
	type IssueInfo,
	type IssueSummary,
	isMapping,
	type Json,
	type PullRequestFileInfo,
	type PullRequestInfo,
	type PullRequestReviewInfo,
	type ReactionInfo,
	type ReleaseInfo,
	type RepoInfo,
	type ReviewCommentInfo,
	s,
	type WorkflowJobInfo,
	type WorkflowRunInfo,
} from "./github-client";
import { buildUrl, defaultTransport, type HttpTransport, type QueryValue, sendRequest, TransportError } from "./http";
import { getLogger } from "./logging";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, sign } from "./proxy-hmac";
import type { GitTransport } from "./sandbox";

const log = getLogger("robomp.proxy_client");

/** Map a non-2xx response from gh-proxy back to a domain exception. */
async function decodeError(resp: Response): Promise<Error> {
	const text = await resp.text();
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {}
	if (isMapping(body) && isMapping(body.error)) {
		const err = body.error;
		const kind = err.kind;
		if (kind === "github") {
			const retryAfter = typeof err.retry_after === "number" ? err.retry_after : null;
			return new GitHubError(Number(err.status) || resp.status, s(err.message) || "github error", { retryAfter });
		}
		if (kind === "git" || kind === "head_drift") {
			const cmd = Array.isArray(err.cmd) && err.cmd.length > 0 ? err.cmd.map(String) : ["git"];
			const Klass = kind === "head_drift" ? HeadDriftError : GitCommandError;
			return new Klass(cmd, Number(err.returncode) || 1, s(err.stdout), s(err.stderr));
		}
	}
	return new GitHubError(resp.status, text || "proxy error");
}

function signedHeaders(method: string, target: string, body: string, key: Uint8Array): Record<string, string> {
	const [ts, sig] = sign({ method, path: target, body, key });
	return { [HEADER_TIMESTAMP]: ts, [HEADER_SIGNATURE]: sig };
}

function keyBytes(key: string | Uint8Array): Uint8Array {
	return typeof key === "string" ? new TextEncoder().encode(key) : key;
}

/** Canonical signing target for a URL: path plus raw query when present. */
function requestTarget(url: URL): string {
	return url.search ? `${url.pathname}${url.search}` : url.pathname;
}

async function sendSigned(
	transport: HttpTransport,
	baseUrl: string,
	key: Uint8Array,
	timeoutSeconds: number,
	method: string,
	pathname: string,
	params: Record<string, QueryValue> | undefined,
	jsonBody: unknown,
): Promise<Response> {
	const url = buildUrl(baseUrl, pathname, params);
	const body = jsonBody === undefined ? "" : JSON.stringify(jsonBody);
	const headers = signedHeaders(method, requestTarget(url), body, key);
	if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
	// httpx clients here use the default `follow_redirects=False`.
	return sendRequest(transport, baseUrl, {
		method,
		url: url.href,
		headers,
		body: jsonBody === undefined ? undefined : body,
		timeoutMs: timeoutSeconds * 1000,
		followRedirects: false,
	});
}

function items(data: unknown): unknown[] {
	const list = isMapping(data) ? data.items : undefined;
	return Array.isArray(list) ? list : [];
}

export const PROXY_CLIENT_RETRY_DELAYS = { value: [1.0, 3.0, 10.0] as readonly number[] };
export const PROXY_TRANSPORT_RETRY_DELAYS = { value: [2.0, 5.0, 15.0] as readonly number[] };

/** HMAC-signed REST client speaking to a gh-proxy instance. */
export class GitHubProxyClient implements GitHubBackend {
	readonly #baseUrl: string;
	readonly #key: Uint8Array;
	readonly #transport: HttpTransport;
	readonly #timeout: number;

	constructor(args: {
		baseUrl: string;
		hmacKey: string | Uint8Array;
		transport?: HttpTransport | null;
		timeout?: number;
	}) {
		this.#baseUrl = args.baseUrl.replace(/\/+$/, "");
		this.#key = keyBytes(args.hmacKey);
		this.#transport = args.transport ?? defaultTransport;
		this.#timeout = args.timeout ?? 30;
	}

	async #request(
		method: string,
		pathname: string,
		options: { params?: Record<string, QueryValue>; json?: unknown } = {},
	): Promise<any> {
		const delays = [...PROXY_CLIENT_RETRY_DELAYS.value, null];
		let lastExc: unknown;
		for (const [attempt, delay] of delays.entries()) {
			try {
				const resp = await sendSigned(
					this.#transport,
					this.#baseUrl,
					this.#key,
					this.#timeout,
					method,
					pathname,
					options.params,
					options.json,
				);
				if (resp.status >= 400) throw await decodeError(resp);
				const text = await resp.text();
				if (resp.status === 204 || !text) return null;
				return JSON.parse(text) as unknown;
			} catch (exc) {
				if (!(exc instanceof TransportError)) throw exc;
				lastExc = exc;
				if (delay === null) break;
				log.warning("proxy client transient error, retrying", {
					method,
					path: pathname,
					attempt: attempt + 1,
					delay,
					error: exc.message,
				});
				await Bun.sleep(delay * 1000);
			}
		}
		throw lastExc;
	}

	// ---- reads ----
	async getRepo(repo: string): Promise<RepoInfo> {
		return repoFrom(await this.#request("GET", "/gh/v1/repo", { params: { repo } }));
	}

	async listWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRunInfo[]> {
		const data = await this.#request("GET", "/gh/v1/workflow_runs", { params: { repo, head_sha: headSha } });
		return items(data).map(workflowRunFrom);
	}

	async listWorkflowJobs(repo: string, runId: number): Promise<WorkflowJobInfo[]> {
		const data = await this.#request("GET", "/gh/v1/workflow_jobs", { params: { repo, run_id: runId } });
		return items(data).map(workflowJobFrom);
	}

	async getJobLogTail(repo: string, jobId: number, tailLines = 200): Promise<string> {
		const data = await this.#request("GET", "/gh/v1/job_log_tail", {
			params: { repo, job_id: jobId, tail: tailLines },
		});
		return isMapping(data) ? s(data.text) : "";
	}

	async getTagSha(repo: string, tag: string): Promise<string | null> {
		const data = await this.#request("GET", "/gh/v1/tag_ref", { params: { repo, tag } });
		if (!isMapping(data) || data.sha === null || data.sha === undefined) return null;
		return String(data.sha);
	}

	async getReleaseByTag(repo: string, tag: string): Promise<ReleaseInfo | null> {
		const data = await this.#request("GET", "/gh/v1/release_by_tag", { params: { repo, tag } });
		return data === null ? null : releaseFrom(data);
	}

	async getIssue(repo: string, number: number): Promise<IssueInfo> {
		return issueFrom(await this.#request("GET", "/gh/v1/issue", { params: { repo, number } }));
	}

	async listClosingPullRequests(repo: string, number: number): Promise<number[]> {
		const data = await this.#request("GET", "/gh/v1/closing_prs", { params: { repo, number } });
		const list = isMapping(data) && Array.isArray(data.pr_numbers) ? data.pr_numbers : [];
		return list.filter((n): n is number => Number.isInteger(n));
	}

	async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
		return prFrom(await this.#request("GET", "/gh/v1/pull_request", { params: { repo, number } }));
	}

	async listPrFiles(repo: string, prNumber: number): Promise<PullRequestFileInfo[]> {
		const data = await this.#request("GET", "/gh/v1/pr_files", { params: { repo, pr_number: prNumber } });
		return items(data).map(prFileFrom);
	}

	async listIssues(repo: string, options: { state?: string; limit?: number } = {}): Promise<IssueSummary[]> {
		const data = await this.#request("GET", "/gh/v1/issues", {
			params: { repo, state: options.state ?? "open", limit: options.limit ?? 30 },
		});
		return items(data).map(issueSummaryFrom);
	}

	async searchIssues(repo: string, query: string, limit = 10): Promise<IssueSummary[]> {
		const data = await this.#request("GET", "/gh/v1/search_issues", { params: { repo, q: query, limit } });
		return items(data).map(issueSummaryFrom);
	}

	async listIssueIndexEntries(
		repo: string,
		options: { since?: string | null; page?: number; per_page?: number } = {},
	): Promise<IssueIndexEntry[]> {
		const params: Record<string, QueryValue> = {
			repo,
			page: options.page ?? 1,
			per_page: options.per_page ?? 100,
		};
		if (options.since) params.since = options.since;
		const data = await this.#request("GET", "/gh/v1/issue_index_entries", { params });
		return items(data).map(indexEntryFrom);
	}

	async listComments(repo: string, number: number): Promise<CommentInfo[]> {
		const data = await this.#request("GET", "/gh/v1/comments", { params: { repo, number } });
		return items(data).map(commentFrom);
	}

	async listReviewComments(repo: string, prNumber: number): Promise<ReviewCommentInfo[]> {
		const data = await this.#request("GET", "/gh/v1/review_comments", { params: { repo, pr_number: prNumber } });
		return items(data).map(reviewCommentFrom);
	}

	async listPrReviews(repo: string, prNumber: number): Promise<PullRequestReviewInfo[]> {
		const data = await this.#request("GET", "/gh/v1/pr_reviews", { params: { repo, pr_number: prNumber } });
		return items(data).map(prReviewFrom);
	}

	async getAuthenticatedLogin(): Promise<string> {
		const data = await this.#request("GET", "/gh/v1/authenticated_login");
		return isMapping(data) ? String(data.login) : "";
	}

	// ---- writes ----
	async postComment(repo: string, number: number, body: string): Promise<CommentInfo> {
		return commentFrom(await this.#request("POST", "/gh/v1/post_comment", { json: { repo, number, body } }));
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
		return prFrom(
			await this.#request("POST", "/gh/v1/open_pull_request", {
				json: {
					repo: args.repo,
					head: args.head,
					base: args.base,
					title: args.title,
					body: args.body,
					draft: args.draft ?? false,
					maintainer_can_modify: args.maintainer_can_modify ?? true,
				},
			}),
		);
	}

	async requestReviewers(args: {
		repo: string;
		pr_number: number;
		reviewers?: string[] | null;
		team_reviewers?: string[] | null;
	}): Promise<void> {
		if (!args.reviewers?.length && !args.team_reviewers?.length) return;
		await this.#request("POST", "/gh/v1/request_reviewers", {
			json: {
				repo: args.repo,
				pr_number: args.pr_number,
				reviewers: args.reviewers ?? null,
				team_reviewers: args.team_reviewers ?? null,
			},
		});
	}

	async addIssueLabels(repo: string, number: number, labels: string[]): Promise<string[]> {
		if (labels.length === 0) return [];
		const data = await this.#request("POST", "/gh/v1/add_issue_labels", { json: { repo, number, labels } });
		const list = isMapping(data) && Array.isArray(data.labels) ? data.labels : [];
		return list.map(String);
	}

	async removeIssueLabel(repo: string, number: number, label: string): Promise<void> {
		if (!label) return;
		await this.#request("POST", "/gh/v1/remove_issue_label", { json: { repo, number, label } });
	}

	async submitPrReview(args: {
		repo: string;
		pr_number: number;
		body: string;
		event: string;
		comments: readonly Json[];
		commit_id?: string | null;
	}): Promise<PullRequestReviewInfo> {
		const json: Json = {
			repo: args.repo,
			pr_number: args.pr_number,
			body: args.body,
			event: args.event,
			comments: args.comments,
		};
		if (args.commit_id) json.commit_id = args.commit_id;
		return prReviewFrom(await this.#request("POST", "/gh/v1/submit_pr_review", { json }));
	}

	async addAssignees(repo: string, number: number, assignees: string[]): Promise<void> {
		if (assignees.length === 0) return;
		await this.#request("POST", "/gh/v1/add_assignees", { json: { repo, number, assignees } });
	}

	async listCommentReactions(repo: string, commentId: number): Promise<ReactionInfo[]> {
		const data = await this.#request("GET", "/gh/v1/comment_reactions", {
			params: { repo, comment_id: commentId },
		});
		return items(data).map(reactionFrom);
	}

	async closeIssue(repo: string, number: number, reason = "completed"): Promise<void> {
		await this.#request("POST", "/gh/v1/close_issue", { json: { repo, number, reason } });
	}
}

/** Routes clone/fetch/push to gh-proxy over the same HMAC channel. */
export class ProxyGitTransport implements GitTransport {
	readonly #baseUrl: string;
	readonly #key: Uint8Array;
	readonly #transport: HttpTransport;
	readonly #timeout: number;

	constructor(args: {
		baseUrl: string;
		hmacKey: string | Uint8Array;
		transport?: HttpTransport | null;
		timeout?: number;
	}) {
		this.#baseUrl = args.baseUrl.replace(/\/+$/, "");
		this.#key = keyBytes(args.hmacKey);
		this.#transport = args.transport ?? defaultTransport;
		this.#timeout = args.timeout ?? 120;
	}

	async #post(pathname: string, body: Json): Promise<Json> {
		const delays = [...PROXY_TRANSPORT_RETRY_DELAYS.value, null];
		let lastExc: unknown;
		for (const [attempt, delay] of delays.entries()) {
			try {
				const resp = await sendSigned(
					this.#transport,
					this.#baseUrl,
					this.#key,
					this.#timeout,
					"POST",
					pathname,
					undefined,
					body,
				);
				if (resp.status >= 400) throw await decodeError(resp);
				const text = await resp.text();
				if (resp.status === 204 || !text) return {};
				const data = JSON.parse(text) as unknown;
				return isMapping(data) ? data : {};
			} catch (exc) {
				if (!(exc instanceof TransportError)) throw exc;
				lastExc = exc;
				if (delay === null) break;
				log.warning("proxy transport transient error, retrying", {
					path: pathname,
					attempt: attempt + 1,
					delay,
					error: exc.message,
				});
				await Bun.sleep(delay * 1000);
			}
		}
		throw lastExc;
	}

	async clonePool(args: { repo: string; cloneUrl: string; defaultBranch: string; target?: string }): Promise<void> {
		await this.#post("/gh/v1/git/clone", {
			repo: args.repo,
			clone_url: args.cloneUrl,
			default_branch: args.defaultBranch,
		});
	}

	async fetchPool(args: { repo: string; poolDir?: string }): Promise<void> {
		await this.#post("/gh/v1/git/fetch", { repo: args.repo });
	}

	async fetchBaseRef(args: { repo: string; poolDir?: string; ref: string }): Promise<void> {
		await this.#post("/gh/v1/git/fetch_ref", { repo: args.repo, ref: args.ref });
	}

	async fetchPrHead(args: { repo: string; poolDir?: string; prNumber: number }): Promise<void> {
		await this.#post("/gh/v1/git/fetch_pr_head", { repo: args.repo, pr_number: args.prNumber });
	}

	async pushBranch(args: {
		repo: string;
		workspaceKey: string;
		repoDir?: string;
		branch: string;
		expectedHead: string;
		slotUid?: number | null;
	}): Promise<PushResult> {
		const body: Json = {
			repo: args.repo,
			workspace_key: args.workspaceKey,
			branch: args.branch,
			expected_head: args.expectedHead,
		};
		if (args.slotUid !== undefined && args.slotUid !== null) body.slot_uid = args.slotUid;
		const data = await this.#post("/gh/v1/git/push", body);
		return { head: s(data.head) || args.expectedHead, branch: s(data.branch) || args.branch };
	}

	async pushRelease(args: {
		repo: string;
		workspaceKey: string;
		repoDir?: string;
		branch: string;
		tag: string;
		expectedHead: string;
		slotUid?: number | null;
	}): Promise<PushResult> {
		const body: Json = {
			repo: args.repo,
			workspace_key: args.workspaceKey,
			branch: args.branch,
			tag: args.tag,
			expected_head: args.expectedHead,
		};
		if (args.slotUid !== undefined && args.slotUid !== null) body.slot_uid = args.slotUid;
		const data = await this.#post("/gh/v1/git/push_release", body);
		return { head: s(data.head) || args.expectedHead, branch: s(data.branch) || args.branch };
	}
}

// ---------- payload helpers ----------

function expectMapping(data: unknown, what: string): Json {
	if (!isMapping(data)) throw new GitHubError(500, `proxy returned malformed ${what} payload`);
	return data;
}

function int(value: unknown, fallback = 0): number {
	const parsed = Number(value);
	return value === undefined || value === null || value === "" || Number.isNaN(parsed) || parsed === 0
		? fallback
		: Math.trunc(parsed);
}

function requiredInt(data: Json, key: string): number {
	if (!(key in data)) throw new TypeError(`missing key '${key}'`);
	const parsed = Number(data[key]);
	if (Number.isNaN(parsed)) throw new TypeError(`invalid int for '${key}'`);
	return Math.trunc(parsed);
}

function requiredStr(data: Json, key: string): string {
	if (!(key in data)) throw new TypeError(`missing key '${key}'`);
	return String(data[key]);
}

function strList(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : [];
}

function nullableStr(value: unknown): string | null {
	return value === undefined || value === null ? null : String(value);
}

function workflowRunFrom(raw: unknown): WorkflowRunInfo {
	const d = expectMapping(raw, "workflow run");
	return {
		id: int(d.id),
		name: s(d.name),
		event: s(d.event),
		status: s(d.status),
		conclusion: nullableStr(d.conclusion),
		head_branch: nullableStr(d.head_branch),
		head_sha: s(d.head_sha),
		html_url: s(d.html_url),
		run_attempt: int(d.run_attempt, 1),
	};
}

function workflowJobFrom(raw: unknown): WorkflowJobInfo {
	const d = expectMapping(raw, "workflow job");
	return {
		id: int(d.id),
		run_id: int(d.run_id),
		name: s(d.name),
		status: s(d.status),
		conclusion: nullableStr(d.conclusion),
		html_url: s(d.html_url),
		failed_steps: strList(d.failed_steps),
	};
}

function releaseFrom(raw: unknown): ReleaseInfo {
	const d = expectMapping(raw, "release");
	return {
		tag: s(d.tag),
		name: nullableStr(d.name),
		draft: Boolean(d.draft),
		prerelease: Boolean(d.prerelease),
		html_url: s(d.html_url),
		asset_names: strList(d.asset_names),
	};
}

function repoFrom(raw: unknown): RepoInfo {
	const d = expectMapping(raw, "repo");
	return {
		full_name: requiredStr(d, "full_name"),
		default_branch: requiredStr(d, "default_branch"),
		clone_url: requiredStr(d, "clone_url"),
		private: Boolean(d.private ?? false),
	};
}

function issueFrom(raw: unknown): IssueInfo {
	const d = expectMapping(raw, "issue");
	return {
		repo: requiredStr(d, "repo"),
		number: requiredInt(d, "number"),
		title: s(d.title),
		body: s(d.body),
		state: s(d.state) || "open",
		author: s(d.author),
		labels: strList(d.labels),
		is_pull_request: Boolean(d.is_pull_request ?? false),
	};
}

function issueSummaryFrom(raw: unknown): IssueSummary {
	const d = expectMapping(raw, "issue summary");
	return {
		repo: requiredStr(d, "repo"),
		number: requiredInt(d, "number"),
		title: s(d.title),
		state: s(d.state),
		author: s(d.author),
		labels: strList(d.labels),
		comments: int(d.comments),
		updated_at: s(d.updated_at),
		created_at: s(d.created_at),
		html_url: s(d.html_url),
		state_reason: s(d.state_reason),
		is_pull_request: Boolean(d.is_pull_request),
	};
}

function indexEntryFrom(raw: unknown): IssueIndexEntry {
	const d = expectMapping(raw, "issue index");
	return {
		repo: requiredStr(d, "repo"),
		number: requiredInt(d, "number"),
		is_pull_request: Boolean(d.is_pull_request),
		title: s(d.title),
		body: s(d.body),
		state: s(d.state),
		state_reason: s(d.state_reason),
		merged_at: s(d.merged_at),
		author: s(d.author),
		labels: strList(d.labels),
		comments: int(d.comments),
		created_at: s(d.created_at),
		updated_at: s(d.updated_at),
		html_url: s(d.html_url),
	};
}

function commentFrom(raw: unknown): CommentInfo {
	const d = expectMapping(raw, "comment");
	return { id: requiredInt(d, "id"), author: s(d.author), body: s(d.body), created_at: s(d.created_at) };
}

function reactionFrom(raw: unknown): ReactionInfo {
	const d = expectMapping(raw, "reaction");
	return { content: s(d.content), user_login: s(d.user_login), user_type: s(d.user_type) };
}

function reviewCommentFrom(raw: unknown): ReviewCommentInfo {
	const d = expectMapping(raw, "review_comment");
	return {
		id: int(d.id),
		author: s(d.author),
		body: s(d.body),
		path: s(d.path),
		line: Number.isInteger(d.line) ? (d.line as number) : null,
		created_at: s(d.created_at),
	};
}

function prReviewFrom(raw: unknown): PullRequestReviewInfo {
	const d = expectMapping(raw, "pr_review");
	return {
		id: int(d.id),
		author: s(d.author),
		body: s(d.body),
		state: s(d.state),
		submitted_at: s(d.submitted_at),
	};
}

function prFileFrom(raw: unknown): PullRequestFileInfo {
	const d = expectMapping(raw, "pr_file");
	return {
		path: s(d.path),
		status: s(d.status),
		additions: int(d.additions),
		deletions: int(d.deletions),
		patch: s(d.patch),
	};
}

function prFrom(raw: unknown): PullRequestInfo {
	const d = expectMapping(raw, "pr");
	return {
		repo: requiredStr(d, "repo"),
		number: requiredInt(d, "number"),
		html_url: requiredStr(d, "html_url"),
		head_ref: s(d.head_ref),
		base_ref: s(d.base_ref),
		state: s(d.state) || "open",
		author: s(d.author),
		head_repo: s(d.head_repo),
		title: s(d.title),
		body: s(d.body),
		head_sha: s(d.head_sha),
	};
}
