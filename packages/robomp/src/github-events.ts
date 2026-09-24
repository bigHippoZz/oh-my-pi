/** Typed webhook payload parsing + dispatch routing. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { issueKey } from "./db";
import { isMapping, type Json } from "./github-client";
import { type Pragma, parsePragmas } from "./pragmas";

export type Decision = "queue" | "skip";

export interface RouteDecision {
	decision: Decision;
	task: string | null;
	repo: string | null;
	issue_key: string | null;
	reason: string;
	submitter: string | null;
	association: string | null;
	directive: boolean;
	directive_body: string | null;
	directive_author: string | null;
	directive_pragmas: readonly Pragma[];
	directive_authorizes_impl: boolean;
}

export function shouldQueue(decision: RouteDecision): boolean {
	return decision.decision === "queue";
}

interface DirectiveFields {
	directive?: boolean;
	directive_body?: string | null;
	directive_author?: string | null;
	directive_pragmas?: readonly Pragma[];
	directive_authorizes_impl?: boolean;
}

export function routeDecision(
	decision: Decision,
	task: string | null,
	repo: string | null,
	key: string | null,
	reason: string,
	extra: { submitter?: string | null; association?: string | null } & DirectiveFields = {},
): RouteDecision {
	return {
		decision,
		task,
		repo,
		issue_key: key,
		reason,
		submitter: extra.submitter ?? null,
		association: extra.association ?? null,
		directive: extra.directive ?? false,
		directive_body: extra.directive_body ?? null,
		directive_author: extra.directive_author ?? null,
		directive_pragmas: extra.directive_pragmas ?? [],
		directive_authorizes_impl: extra.directive_authorizes_impl ?? false,
	};
}

/** Constant-time HMAC-SHA256 verification of `X-Hub-Signature-256`. */
export function verifySignature(secret: string, body: Uint8Array | string, signatureHeader: string | null): boolean {
	if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	const provided = signatureHeader.slice("sha256=".length);
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

function repoFullName(payload: Json): string | null {
	const repo = payload.repository;
	if (isMapping(repo) && typeof repo.full_name === "string") return repo.full_name;
	return null;
}

function normalizeBotLogin(login: unknown): string {
	if (typeof login !== "string") return "";
	let cleaned = login.trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	if (cleaned.toLowerCase().endsWith("[bot]")) cleaned = cleaned.slice(0, -5);
	return cleaned.toLowerCase();
}

function loginMatchesBot(login: unknown, botLogin: string): boolean {
	const normalized = normalizeBotLogin(login);
	return Boolean(normalized) && normalized === normalizeBotLogin(botLogin);
}

/** Whether `login` owns this personal-account repository. */
function loginMatchesPersonalRepoOwner(login: string | null, repository: unknown): boolean {
	if (!login) return false;
	let ownerLogin: string | null = null;
	let ownerType: string | null = null;
	if (isMapping(repository) && isMapping(repository.owner)) {
		const owner = repository.owner;
		if (typeof owner.login === "string" && owner.login) ownerLogin = owner.login;
		if (typeof owner.type === "string" && owner.type) ownerType = owner.type;
	}
	if (ownerType === null || ownerType.toLowerCase() !== "user") return false;
	if (!ownerLogin) return false;
	return login.toLowerCase() === ownerLogin.toLowerCase();
}

function effectiveAssociation(login: string | null, association: string | null, repository: unknown): string | null {
	if (association) return association;
	if (loginMatchesPersonalRepoOwner(login, repository)) return "OWNER";
	return association;
}

export type PrIssueResolver = ((repo: string, prNumber: number) => string | null) | null;

function isBotAccount(user: unknown, botLogin: string): boolean {
	if (!isMapping(user)) return false;
	const login = user.login ? String(user.login) : "";
	if (!login) return false;
	if (loginMatchesBot(login, botLogin)) return true;
	if (login.toLowerCase().endsWith("[bot]")) return true;
	return (user.type ? String(user.type) : "") === "Bot";
}

/** Extract `[login, author_association]` from an issue/comment object. */
function submitterInfo(obj: unknown): [string | null, string | null] {
	if (!isMapping(obj)) return [null, null];
	let login: string | null = null;
	if (isMapping(obj.user) && typeof obj.user.login === "string" && obj.user.login) login = obj.user.login;
	const assoc = obj.author_association;
	return [login, typeof assoc === "string" && assoc ? assoc : null];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Return `body` with `@<botLogin>` mentions stripped, or null if no mention.
 * Case-insensitive and word-boundary aware (`@robomp-bot` does not match
 * `@robomp-bot-extra`).
 */
export function extractMention(body: unknown, botLogin: string): string | null {
	if (typeof body !== "string" || !body) return null;
	const login = normalizeBotLogin(botLogin);
	if (!login) return null;
	const pattern = new RegExp(
		`(?<![A-Za-z0-9_-])@${escapeRegExp(login)}(?:\\[bot\\](?![A-Za-z0-9_-])|(?![A-Za-z0-9_\\[-]))`,
		"gi",
	);
	if (!pattern.test(body)) return null;
	pattern.lastIndex = 0;
	let stripped = body.replace(pattern, "");
	stripped = stripped.replace(/[ \t]+/g, " ");
	stripped = stripped.replace(/\n[ \t]+/g, "\n");
	return stripped.trim();
}

/** GitHub `author_association` values that bypass per-user rate limiting. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** A maintainer is anyone in `maintainers` or with a trusted association. */
export function isMaintainer(
	login: string | null,
	association: string | null,
	maintainers: ReadonlySet<string>,
): boolean {
	if (login && maintainers.has(login.toLowerCase())) return true;
	return Boolean(association && TRUSTED_ASSOCIATIONS.has(association.toUpperCase()));
}

/** Whether this author may authorize implementation work. */
export function isImplementationAuthorizer(
	login: string | null,
	association: string | null,
	maintainers: ReadonlySet<string>,
): boolean {
	if (login && maintainers.has(login.toLowerCase())) return true;
	return Boolean(association && association.toUpperCase() === "OWNER");
}

function prReviewPr(pr: Json, repo: string, action: string, botLogin: string): RouteDecision {
	if ((pr.state ? String(pr.state) : "open") !== "open") return routeDecision("skip", null, repo, null, "PR not open");
	if (pr.draft) return routeDecision("skip", null, repo, null, "draft PR");
	if (isBotAccount(pr.user ?? {}, botLogin)) return routeDecision("skip", null, repo, null, "bot-authored PR");
	const number = pr.number;
	if (!Number.isInteger(number)) return routeDecision("skip", null, repo, null, "PR missing number");
	const [login, assoc] = submitterInfo(pr);
	return routeDecision("queue", "review_pr", repo, issueKey(repo, number as number), `pull_request.${action}`, {
		submitter: login,
		association: assoc,
	});
}

export interface RouteOptions {
	allowlist: ReadonlySet<string>;
	botLogin: string;
	maintainers?: ReadonlySet<string>;
	reviewerBots?: ReadonlySet<string>;
	resolveIssueFromPr?: PrIssueResolver;
	prReviewEnabled?: boolean;
	releaseSentinelEnabled?: boolean;
	releaseCommitPrefix?: string;
}

/**
 * Decide whether and how to handle a webhook event.
 *
 * `resolveIssueFromPr(repo, prNumber)` maps a PR number back to its
 * originating-issue key so follow-ups serialize with the original issue;
 * without a mapping the PR's own issue key is used.
 */
export function route(eventType: string, payload: Json, options: RouteOptions): RouteDecision {
	const { allowlist, botLogin } = options;
	const maintainers = options.maintainers ?? new Set<string>();
	const reviewerBots = options.reviewerBots ?? new Set<string>();
	const resolveIssueFromPr = options.resolveIssueFromPr ?? null;
	const prReviewEnabled = options.prReviewEnabled ?? true;
	const releaseSentinelEnabled = options.releaseSentinelEnabled ?? false;
	const releaseCommitPrefix = options.releaseCommitPrefix ?? "chore: bump version to ";

	const repo = repoFullName(payload);
	if (repo === null || !allowlist.has(repo.toLowerCase())) {
		return routeDecision("skip", null, repo, null, "repo not on allowlist");
	}
	const action = payload.action ? String(payload.action) : "";

	if (eventType === "workflow_run") {
		if (action !== "completed") return routeDecision("skip", null, repo, null, `workflow_run.${action} ignored`);
		if (!releaseSentinelEnabled) return routeDecision("skip", null, repo, null, "release sentinel disabled");
		const run = payload.workflow_run;
		const repository = payload.repository;
		if (!isMapping(run) || !isMapping(repository)) {
			return routeDecision("skip", null, repo, null, "workflow_run payload incomplete");
		}
		const defaultBranch = repository.default_branch ? String(repository.default_branch) : "";
		const headBranch = run.head_branch ? String(run.head_branch) : "";
		if (headBranch !== defaultBranch && !/^v[0-9]/.test(headBranch)) {
			return routeDecision("skip", null, repo, null, "not a default-branch/tag run");
		}
		const headCommit = run.head_commit;
		const message = isMapping(headCommit) && headCommit.message ? String(headCommit.message) : "";
		if (!message.startsWith(releaseCommitPrefix))
			return routeDecision("skip", null, repo, null, "not a release commit");
		return routeDecision(
			"queue",
			"handle_release_ci",
			repo,
			`${repo}#release`,
			`workflow_run ${run.name ? String(run.name) : ""} ${run.conclusion ? String(run.conclusion) : ""}`,
		);
	}

	const resolvePrKey = (prNumber: number): string => {
		if (resolveIssueFromPr !== null) {
			const resolved = resolveIssueFromPr(repo, prNumber);
			if (resolved) return resolved;
		}
		return issueKey(repo, prNumber);
	};

	/** Normalized login when this user is a configured reviewer bot. */
	const reviewerBotLogin = (user: unknown): string | null => {
		if (!isMapping(user)) return null;
		const rawLogin = (user.login ? String(user.login) : "").toLowerCase();
		if (!rawLogin) return null;
		const login = rawLogin.endsWith("[bot]") ? rawLogin.slice(0, -5) : rawLogin;
		if (reviewerBots.has(login)) return login;
		return reviewerBots.has(rawLogin) ? rawLogin : null;
	};

	/** Decide whether this comment is a directive (reviewer-bot OR maintainer-mention). */
	const directiveFields = (comment: unknown, login: string | null, assoc: string | null): DirectiveFields => {
		if (!isMapping(comment)) return {};
		const body = comment.body ? String(comment.body) : "";
		const rbLogin = reviewerBotLogin(comment.user);
		if (rbLogin !== null) {
			const [cleaned, pragmas] = parsePragmas(body);
			return {
				directive: true,
				directive_body: cleaned,
				directive_author: rbLogin,
				directive_pragmas: pragmas,
				directive_authorizes_impl: false,
			};
		}
		if (!isMaintainer(login, assoc, maintainers)) return {};
		const stripped = extractMention(body, botLogin);
		if (stripped === null) return {};
		const [cleaned, pragmas] = parsePragmas(stripped);
		return {
			directive: true,
			directive_body: cleaned,
			directive_author: login,
			directive_pragmas: pragmas,
			directive_authorizes_impl: isImplementationAuthorizer(login, assoc, maintainers),
		};
	};

	if (eventType === "issues") {
		const issue = isMapping(payload.issue) ? payload.issue : {};
		if ("pull_request" in issue) return routeDecision("skip", null, repo, null, "issue is a pull request");
		const number = issue.number;
		if (!Number.isInteger(number)) return routeDecision("skip", null, repo, null, "issue missing number");
		const key = issueKey(repo, number as number);
		if (action === "opened" || action === "reopened") {
			const [login, assoc] = submitterInfo(issue);
			return routeDecision("queue", "triage_issue", repo, key, `issues.${action}`, {
				submitter: login,
				association: assoc,
			});
		}
		if (action === "closed") return routeDecision("queue", "cleanup_workspace", repo, key, "issues.closed");
		return routeDecision("skip", null, repo, key, `issues.${action} ignored`);
	}

	if (eventType === "issue_comment" && action === "created") {
		const comment = isMapping(payload.comment) ? payload.comment : {};
		const rbLogin = reviewerBotLogin(comment.user);
		if (rbLogin === null && isBotAccount(comment.user, botLogin)) {
			return routeDecision("skip", null, repo, null, "bot/self comment");
		}
		const issue = isMapping(payload.issue) ? payload.issue : {};
		const number = issue.number;
		if (!Number.isInteger(number)) return routeDecision("skip", null, repo, null, "comment missing issue number");
		if ("pull_request" in issue) {
			const key = resolvePrKey(number as number);
			const [login, rawAssoc] = submitterInfo(comment);
			const assoc = effectiveAssociation(login, rawAssoc, payload.repository);
			const issueUser = isMapping(issue.user) ? issue.user : {};
			if (loginMatchesBot(issueUser.login ? String(issueUser.login) : "", botLogin)) {
				return routeDecision(
					"queue",
					"handle_pr_conversation",
					repo,
					key,
					`issue_comment.created on PR #${number}`,
					{
						submitter: login,
						association: assoc,
						...directiveFields(comment, login, assoc),
					},
				);
			}
			return routeDecision("skip", null, repo, issueKey(repo, number as number), "incoming PR comments ignored");
		}
		const key = issueKey(repo, number as number);
		const [login, rawAssoc] = submitterInfo(comment);
		const assoc = effectiveAssociation(login, rawAssoc, payload.repository);
		return routeDecision("queue", "handle_comment", repo, key, "issue_comment.created", {
			submitter: login,
			association: assoc,
			...directiveFields(comment, login, assoc),
		});
	}

	if (eventType === "pull_request" && ["opened", "reopened", "ready_for_review"].includes(action)) {
		if (!prReviewEnabled) return routeDecision("skip", null, repo, null, "PR review disabled");
		return prReviewPr(isMapping(payload.pull_request) ? payload.pull_request : {}, repo, action, botLogin);
	}

	if (eventType === "pull_request_review_comment" && action === "created") {
		const comment = isMapping(payload.comment) ? payload.comment : {};
		const rbLogin = reviewerBotLogin(comment.user);
		if (rbLogin === null && isBotAccount(comment.user, botLogin)) {
			return routeDecision("skip", null, repo, null, "bot/self review comment");
		}
		const pr = isMapping(payload.pull_request) ? payload.pull_request : {};
		const prUser = isMapping(pr.user) ? pr.user : {};
		if (!loginMatchesBot(prUser.login ? String(prUser.login) : "", botLogin)) {
			return routeDecision("skip", null, repo, null, "PR not authored by bot");
		}
		const number = pr.number;
		if (!Number.isInteger(number)) return routeDecision("skip", null, repo, null, "PR missing number");
		const key = resolvePrKey(number as number);
		const [login, rawAssoc] = submitterInfo(comment);
		const assoc = effectiveAssociation(login, rawAssoc, payload.repository);
		return routeDecision("queue", "handle_review", repo, key, "pull_request_review_comment.created", {
			submitter: login,
			association: assoc,
			...directiveFields(comment, login, assoc),
		});
	}

	if (eventType === "pull_request" && action === "closed") {
		const pr = isMapping(payload.pull_request) ? payload.pull_request : {};
		const number = pr.number;
		if (!Number.isInteger(number)) return routeDecision("skip", null, repo, null, "PR missing number");
		const reason = pr.merged ? "pull_request.merged" : "pull_request.closed";
		return routeDecision("queue", "cleanup_workspace", repo, resolvePrKey(number as number), reason);
	}

	return routeDecision("skip", null, repo, null, `${eventType}.${action} not handled`);
}

/**
 * Per-window submission cap for a submitter, or null for unlimited.
 * Precedence: explicit `unlimited` allowlist > trusted association >
 * `CONTRIBUTOR` tier > default tier.
 */
export function rateLimitCap(
	login: string,
	association: string | null,
	options: { unlimited: ReadonlySet<string>; default: number; contributor: number },
): number | null {
	if (options.unlimited.has(login.toLowerCase())) return null;
	if (association) {
		const upper = association.toUpperCase();
		if (TRUSTED_ASSOCIATIONS.has(upper)) return null;
		if (upper === "CONTRIBUTOR") return options.contributor;
	}
	return options.default;
}
