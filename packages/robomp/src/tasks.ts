/**
 * Task entry points dispatched off the durable event queue.
 *
 * Python cancelled a task by cancelling its asyncio.Task; here each task takes
 * an optional `AbortSignal` the queue aborts on shutdown.
 */
import * as path from "node:path";
import type { Settings } from "./config";
import { type Database, type IssueRow, type IssueState, issueKey } from "./db";
import { revParseHead } from "./git-ops";
import type { GitHubBackend } from "./github-backend";
import {
	type CommentInfo,
	GitHubError,
	type IssueInfo,
	type Json,
	type PullRequestInfo,
	parseIssuePayload,
	type RepoInfo,
} from "./github-client";
import { getLogger } from "./logging";
import * as persona from "./persona";
import type { GitTransport, SandboxManager, Workspace } from "./sandbox";
import { type DirectiveInfo, directiveInfo, type ThreadMessage, threadMessage } from "./task-types";
import { type ReleaseTaskContext, type RunTaskArgs, runTask, type TaskInputs, taskInputs } from "./worker";

const log = getLogger("robomp.tasks");

/** Thrown when the caller's signal aborts (Python `asyncio.CancelledError`). */
export class TaskCancelledError extends Error {
	constructor(message = "task cancelled") {
		super(message);
		this.name = "CancelledError";
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Run a workspace op (git clone/fetch, worktree add/remove, chown) so that an
 * abort of the caller never detaches it: the op holds the per-repo lock and
 * owns the slot mid-setup, and the dispatcher reaps/releases that slot once
 * the task settles. On abort we therefore drain the op to completion, log
 * its own failure, and only then throw.
 */
export async function runWorkspaceOp<T>(op: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
	const inner = op();
	if (!signal) return inner;
	if (signal.aborted) {
		await inner.catch(() => {});
		throw new TaskCancelledError();
	}
	const { promise: aborted, resolve } = Promise.withResolvers<"aborted">();
	const onAbort = (): void => resolve("aborted");
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const outcome = await Promise.race([inner.then(value => ({ value })), aborted]);
		if (outcome !== "aborted") return outcome.value;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	try {
		await inner;
	} catch (err) {
		log.warning("workspace op raised during caller cancellation", { error: errMessage(err) }, err);
	}
	throw new TaskCancelledError();
}

/** Python `isinstance(value, Mapping)`: a JSON object, not an array. */
function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Record<string, unknown> {
	return isMapping(value) ? value : {};
}

function commentFromPayload(payload: Json): CommentInfo {
	const c = obj(payload.comment);
	const user = obj(c.user);
	return {
		id: Number(c.id || 0),
		author: String(user.login || ""),
		body: String(c.body || ""),
		created_at: String(c.created_at || ""),
	};
}

/** Extract the maintainer directive the webhook handler stashed, if any. */
export function directiveFromPayload(payload: Json): DirectiveInfo | null {
	const raw = payload._robomp_directive;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const { body, author } = raw as Record<string, unknown>;
	if (typeof body !== "string" || !body.trim()) return null;
	if (typeof author !== "string" || !author.trim()) return null;
	const pragmas: [string, string][] = [];
	const rawPragmas = (raw as Record<string, unknown>).pragmas;
	if (Array.isArray(rawPragmas)) {
		for (const entry of rawPragmas) {
			if (Array.isArray(entry) && entry.length === 2) {
				const [k, v] = entry;
				if (typeof k === "string" && typeof v === "string") pragmas.push([k, v]);
			}
		}
	}
	return directiveInfo({
		body,
		author,
		pragmas,
		authorizes_impl: Boolean((raw as Record<string, unknown>).authorizes_impl),
	});
}

/**
 * Pull the full conversation thread (body + comments + reviews) for `number`.
 * Best-effort: any failing sub-fetch is logged and dropped.
 */
async function fetchThreadImpl(
	github: GitHubBackend,
	repo: string,
	number: number,
	options: { isPr: boolean },
): Promise<ThreadMessage[]> {
	const messages: ThreadMessage[] = [];
	try {
		const item = await github.getIssue(repo, number);
		if (item.body?.trim()) {
			messages.push(
				threadMessage({
					kind: options.isPr ? "pr_body" : "issue_body",
					author: item.author || "",
					body: item.body,
					created_at: "",
				}),
			);
		}
	} catch (err) {
		if (!(err instanceof GitHubError)) throw err;
		log.warning("thread body fetch failed", { repo, n: number, err: err.message });
	}
	try {
		for (const c of await github.listComments(repo, number)) {
			messages.push(threadMessage({ kind: "comment", author: c.author, body: c.body, created_at: c.created_at }));
		}
	} catch (err) {
		if (!(err instanceof GitHubError)) throw err;
		log.warning("thread comments fetch failed", { err: err.message });
	}
	if (options.isPr) {
		try {
			for (const r of await github.listReviewComments(repo, number)) {
				messages.push(
					threadMessage({
						kind: "review_comment",
						author: r.author,
						body: r.body,
						created_at: r.created_at,
						path: r.path,
						line: r.line,
					}),
				);
			}
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			log.warning("thread review-comments fetch failed", { err: err.message });
		}
		try {
			for (const rv of await github.listPrReviews(repo, number)) {
				messages.push(
					threadMessage({
						kind: "review",
						author: rv.author,
						body: rv.body,
						created_at: rv.submitted_at,
						state: rv.state,
					}),
				);
			}
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			log.warning("thread reviews fetch failed", { err: err.message });
		}
	}
	// ISO 8601 strings sort chronologically; the body has no timestamp and sorts first.
	return messages
		.map((message, index) => ({ message, index }))
		.sort((a, b) => {
			const ka = a.message.created_at || "";
			const kb = b.message.created_at || "";
			return ka < kb ? -1 : ka > kb ? 1 : a.index - b.index;
		})
		.map(entry => entry.message);
}

/** Hydrate a directive with the live conversation thread (or no-op if null). */
async function attachThreadImpl(
	github: GitHubBackend,
	directive: DirectiveInfo | null,
	repo: string,
	number: number,
	options: { isPr: boolean },
): Promise<DirectiveInfo | null> {
	if (directive === null) return null;
	const thread = await tasksDeps.fetchThread(github, repo, number, options);
	return { ...directive, thread };
}

async function resolveRepoAndIssueImpl(github: GitHubBackend, payload: Json): Promise<[RepoInfo, IssueInfo]> {
	const [repo, parsed] = parseIssuePayload(payload);
	let issue = parsed;
	if (!issue.body) {
		// Webhook payloads sometimes omit body; refetch to be safe.
		try {
			issue = await github.getIssue(repo.full_name, issue.number);
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			log.warning("issue refetch failed", { err: err.message });
		}
	}
	return [repo, issue];
}

/** Test seams (Python module-level monkeypatch targets). */
export const tasksDeps = {
	runTask: (args: RunTaskArgs): Promise<string | null> => runTask(args),
	resolveRepoAndIssue: resolveRepoAndIssueImpl,
	fetchThread: fetchThreadImpl,
	attachThread: attachThreadImpl,
};

/** Find the originating issue row for a PR, repairing stale mappings when possible. */
async function resolveIssueRowForPr(args: {
	db: Database;
	github: GitHubBackend;
	repoFull: string;
	prNumber: number;
}): Promise<[IssueRow | null, PullRequestInfo | null]> {
	const { db, github, repoFull, prNumber } = args;
	let issueRow = db.findIssueByPr(repoFull, prNumber);
	let prInfo: PullRequestInfo | null = null;
	if (issueRow === null || issueRow.branch === null) {
		try {
			prInfo = await github.getPullRequest(repoFull, prNumber);
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			log.warning("PR metadata fetch failed", { repo: repoFull, pr: prNumber, err: err.message });
			return [issueRow, null];
		}
	}
	if (issueRow === null && prInfo !== null && prInfo.head_ref) {
		issueRow = db.findIssueByBranch(repoFull, prInfo.head_ref);
		if (issueRow !== null) {
			db.setIssuePr(issueRow.key, prNumber);
			issueRow = db.getIssue(issueRow.key) ?? issueRow;
		}
	} else if (issueRow !== null && issueRow.branch === null && prInfo !== null && prInfo.head_ref) {
		db.setIssueBranch(issueRow.key, prInfo.head_ref);
		issueRow = db.getIssue(issueRow.key) ?? issueRow;
	}
	return [issueRow, prInfo];
}

/** Only bot-owned same-repo PR branches are safe to amend directly. */
function canHandlePrDirectly(settings: Settings, repoFull: string, pr: PullRequestInfo): boolean {
	if (!pr.head_ref) {
		log.info("skip: PR has no head ref", { repo: repoFull, pr: pr.number });
		return false;
	}
	if (pr.author.toLowerCase() !== settings.bot_login.toLowerCase()) {
		log.info("skip: unmapped PR not authored by bot", { repo: repoFull, pr: pr.number, author: pr.author });
		return false;
	}
	if (pr.head_repo.toLowerCase() !== repoFull.toLowerCase()) {
		log.info("skip: unmapped PR head is not this repo", { repo: repoFull, pr: pr.number, head_repo: pr.head_repo });
		return false;
	}
	return true;
}

const BLOCKING_RELEASE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const FAILED_RELEASE_JOB_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** Collect bounded failing-job diagnostics for one release commit. */
async function releaseFailureDossier(
	github: GitHubBackend,
	repo: string,
	headSha: string,
): Promise<[string, string[]]> {
	const runs = await github.listWorkflowRuns(repo, headSha);
	const sections: string[] = [];
	const overflow: string[] = [];
	const runUrls: string[] = [];
	let included = 0;
	for (const run of runs) {
		if (!BLOCKING_RELEASE_CONCLUSIONS.has(run.conclusion ?? "")) continue;
		if (run.html_url) runUrls.push(run.html_url);
		for (const job of await github.listWorkflowJobs(repo, run.id)) {
			if (FAILED_RELEASE_JOB_CONCLUSIONS.has(job.conclusion ?? "")) continue;
			if (included >= 5) {
				overflow.push(`- ${run.name} / ${job.name} (job ${job.id}) — ${job.html_url}`);
				continue;
			}
			included += 1;
			const logTail = await github.getJobLogTail(repo, job.id, 120);
			const failedSteps = job.failed_steps.length > 0 ? job.failed_steps.join(", ") : "(not reported)";
			sections.push(
				`## ${run.name} / ${job.name} (${job.conclusion || job.status}) — ${job.html_url}\n` +
					`Failed steps: ${failedSteps}\n\n` +
					`\`\`\`\`text\n${logTail}\n\`\`\`\``,
			);
		}
	}
	if (overflow.length > 0) sections.push(`## Additional failing jobs\n${overflow.join("\n")}`);
	if (sections.length === 0) sections.push("No failing jobs were reported by the Actions jobs API.");
	return [sections.join("\n\n"), [...new Set(runUrls)]];
}

/** Common task arguments (Python keyword-only params). */
export interface TaskArgs {
	settings: Settings;
	db: Database;
	github: GitHubBackend;
	sandbox: SandboxManager;
	gitTransport: GitTransport;
	payload: Json;
	deliveryId: string;
	attempts?: number;
	slotUid?: number | null;
	signal?: AbortSignal | null;
}

function inputsFor(
	args: TaskArgs,
	repo: RepoInfo,
	workspace: Workspace,
	extra: { issue?: IssueInfo | null; release?: ReleaseTaskContext | null } = {},
): TaskInputs {
	return taskInputs({
		settings: args.settings,
		db: args.db,
		github: args.github,
		gitTransport: args.gitTransport,
		repo,
		workspace,
		deliveryId: args.deliveryId,
		attempts: args.attempts ?? 0,
		slotUid: args.slotUid ?? null,
		nativesCache: args.sandbox.nativesCache,
		issue: extra.issue ?? null,
		release: extra.release ?? null,
	});
}

function ensureWorkspace(
	args: TaskArgs,
	init: {
		repo: string;
		number: number;
		title: string;
		cloneUrl: string;
		defaultBranch: string;
		existingBranch?: string | null;
		prHead?: number | null;
	},
): Promise<Workspace> {
	return runWorkspaceOp(
		() =>
			args.sandbox.ensureWorkspace({
				...init,
				authorName: args.settings.resolved_author_name,
				authorEmail: args.settings.git_author_email,
				slotUid: args.slotUid ?? null,
			}),
		args.signal,
	);
}

function removeWorkspace(args: TaskArgs, repo: string, number: number): Promise<void> {
	return runWorkspaceOp(() => args.sandbox.removeWorkspace({ repo, number }), args.signal);
}

function startTask(args: TaskArgs, run: RunTaskArgs): Promise<string | null> {
	args.signal?.throwIfAborted();
	return tasksDeps.runTask(run);
}

/** Advance one release tag from a completed GitHub Actions verdict. */
export async function handleReleaseCi(args: TaskArgs): Promise<void> {
	const { settings, db, github, sandbox, payload } = args;
	const run = payload.workflow_run;
	const repository = payload.repository;
	if (!isMapping(run) || !isMapping(repository)) {
		log.info("skip: incomplete release workflow payload");
		return;
	}
	const runObj = run;
	const repoObj = repository;
	const repoFull = String(repoObj.full_name || "");
	const defaultBranch = String(repoObj.default_branch || "");
	const headSha = String(runObj.head_sha || "");
	const runName = String(runObj.name || "");
	const runUrl = String(runObj.html_url || "");
	const conclusion = String(runObj.conclusion || "");
	const headCommit = runObj.head_commit;
	const message = isMapping(headCommit) ? String(headCommit.message || "") : "";
	if (!repoFull || !defaultBranch || !headSha || !message.startsWith(settings.release_commit_prefix)) {
		log.info("skip: unparseable release workflow", { repo: repoFull, sha: headSha });
		return;
	}
	const remainder = message.slice(settings.release_commit_prefix.length).trim();
	const versionToken = remainder ? remainder.split(/\s+/, 1)[0]! : "";
	const version = versionToken.startsWith("v") ? versionToken.slice(1) : versionToken;
	if (!version) {
		log.info("skip: release message missing version", { repo: repoFull, sha: headSha });
		return;
	}
	const tag = `v${version}`;

	const remoteTagSha = await github.getTagSha(repoFull, tag);
	if (remoteTagSha === null) {
		log.info("skip: release tag absent", { repo: repoFull, tag });
		return;
	}
	if (headSha !== remoteTagSha) {
		log.info("skip: stale release workflow", { repo: repoFull, tag, event_sha: headSha, tag_sha: remoteTagSha });
		return;
	}

	const key = `${repoFull}#${tag}`;
	const active = db.getActiveRelease(repoFull);
	let row = db.getRelease(key);
	if (row === null) {
		const sessionDir = path.join(sandbox.workspaceRoot(repoFull, "release"), `.omp-session-${tag}`);
		row = db.upsertRelease({ repo: repoFull, tag, version, current_sha: headSha, session_dir: sessionDir });
	}
	if (active !== null && active.key !== key) db.setReleaseState(active.key, "superseded");
	if (row.state === "green" || row.state === "failed" || row.state === "superseded") {
		log.info("skip: release already terminal", { key, state: row.state });
		return;
	}
	if (row.current_sha !== headSha) {
		db.setReleaseSha(key, headSha);
		row = db.getRelease(key) ?? row;
	}

	if (conclusion === "success") {
		const runs = await github.listWorkflowRuns(repoFull, headSha);
		if (runs.some(other => other.status !== "completed")) {
			log.info("release waiting on workflow runs", { key });
			return;
		}
		if (runs.some(other => BLOCKING_RELEASE_CONCLUSIONS.has(other.conclusion ?? ""))) {
			log.info("release waiting on failed workflow event", { key });
			return;
		}
		const release = await github.getReleaseByTag(repoFull, tag);
		if (release === null || release.draft) {
			db.setReleaseState(key, "failed", "CI green but GitHub Release missing/draft");
			return;
		}
		db.setReleaseState(key, "green");
		return;
	}

	if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") {
		if (!(row.state === "fixing" && row.last_failed_sha === headSha)) {
			if (row.rounds >= settings.release_max_rounds) {
				db.setReleaseState(
					key,
					"failed",
					`round cap ${settings.release_max_rounds} reached; last: ${runName} ${runUrl}`,
				);
				return;
			}
			row = db.bumpReleaseRound(key, headSha);
		}
		const cloneUrl = String(repoObj.clone_url || "");
		const repoInfo: RepoInfo = cloneUrl
			? {
					full_name: repoFull,
					default_branch: defaultBranch,
					clone_url: cloneUrl,
					private: Boolean(repoObj.private),
				}
			: await github.getRepo(repoFull);
		const workspace = await runWorkspaceOp(
			() =>
				sandbox.ensureReleaseWorkspace({
					repo: repoFull,
					cloneUrl: repoInfo.clone_url,
					defaultBranch,
					tag,
					authorName: settings.resolved_author_name,
					authorEmail: settings.git_author_email,
					slotUid: args.slotUid ?? null,
				}),
			args.signal,
		);
		const workspaceHead = await revParseHead(workspace.repo_dir, { safeDirectory: workspace.repo_dir });
		if (workspaceHead !== headSha) {
			db.setReleaseState(key, "failed", "main moved past release sha; human intervention");
			return;
		}
		const [failuresText, runUrls] = await releaseFailureDossier(github, repoFull, headSha);
		const releaseContext: ReleaseTaskContext = {
			tag,
			version,
			round: row.rounds,
			max_rounds: settings.release_max_rounds,
			head_sha: headSha,
			default_branch: defaultBranch,
			failures_text: failuresText,
			run_urls: runUrls,
		};
		await startTask(args, {
			taskKind: "handle_release_ci",
			inputs: inputsFor(args, repoInfo, workspace, { release: releaseContext }),
		});
		const updated = db.getRelease(key);
		if (updated !== null && updated.state === "fixing") {
			db.setReleaseState(key, "failed", "agent ended round without retagging");
		}
		return;
	}

	if (conclusion === "action_required") {
		db.setReleaseState(key, "failed", "run needs manual approval");
		return;
	}
	log.info("release conclusion ignored", { key, conclusion });
}

export async function triageIssue(args: TaskArgs): Promise<void> {
	const { db, github } = args;
	const [repo, issue] = await tasksDeps.resolveRepoAndIssue(github, args.payload);
	if (issue.is_pull_request) {
		log.info("skip: triage on PR-like issue", { repo: repo.full_name, n: issue.number });
		return;
	}
	const key = issueKey(repo.full_name, issue.number);
	const existing = db.getIssue(key);
	if (existing === null) {
		// First-time triage: bail if a PR already claims to close this issue.
		let closingPrs: number[];
		try {
			closingPrs = await github.listClosingPullRequests(repo.full_name, issue.number);
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			// Fail-open: a transient timeline failure shouldn't block triage.
			log.warning("closing-PR check failed; proceeding with triage", { key, err: err.message });
			closingPrs = [];
		}
		if (closingPrs.length > 0) {
			log.info("skip: issue already covered by an open PR", { key, prs: [...closingPrs] });
			return;
		}
	} else if (existing.state === "merged" || existing.state === "closed" || existing.state === "abandoned") {
		// Reopen of a finalized issue: the prior branch is stale, so tear the
		// workspace down and branch afresh from default.
		log.info("reopen re-triage", { key, from_state: existing.state });
		await removeWorkspace(args, repo.full_name, issue.number);
	}
	db.upsertIssue({ key, repo: repo.full_name, number: issue.number, state: "reproducing" });
	const workspace = await ensureWorkspace(args, {
		repo: repo.full_name,
		number: issue.number,
		title: issue.title,
		cloneUrl: repo.clone_url,
		defaultBranch: repo.default_branch,
	});
	db.upsertIssue({
		key,
		repo: repo.full_name,
		number: issue.number,
		state: "reproducing",
		branch: workspace.branch,
		session_dir: workspace.session_dir,
	});
	await startTask(args, { taskKind: "triage_issue", inputs: inputsFor(args, repo, workspace, { issue }) });
}

export async function reviewPr(args: TaskArgs): Promise<void> {
	const { db, github, payload } = args;
	const prNode = obj(payload.pull_request);
	const prNumber = Number(prNode.number || 0);
	const repoFull = String(obj(payload.repository).full_name || "");
	if (prNumber <= 0 || !repoFull) {
		log.info("skip: review_pr missing repo/number");
		return;
	}
	let repo: RepoInfo;
	let issue: IssueInfo;
	let pr: PullRequestInfo;
	try {
		repo = await github.getRepo(repoFull);
		issue = await github.getIssue(repoFull, prNumber);
		pr = await github.getPullRequest(repoFull, prNumber);
	} catch (err) {
		if (!(err instanceof GitHubError)) throw err;
		log.warning("review_pr fetch failed", { repo: repoFull, pr: prNumber, err: err.message });
		return;
	}
	const labels = new Set(issue.labels.map(label => label.toLowerCase()));
	const key = issueKey(repo.full_name, prNumber);
	const reviewLabeled = labels.has("triaged") || [...labels].some(label => label.startsWith("review:"));
	if (db.hasSuccessfulToolCall(key, "submit_pr_review")) {
		log.info("skip: PR review already submitted", { repo: repoFull, pr: prNumber });
		return;
	}
	if (reviewLabeled) {
		log.info("review labels present without submitted review; retrying", {
			repo: repoFull,
			pr: prNumber,
			labels: [...labels].sort(),
		});
	}
	db.upsertIssue({ key, repo: repo.full_name, number: prNumber, state: "reviewing", pr_number: prNumber });
	const workspace = await ensureWorkspace(args, {
		repo: repo.full_name,
		number: prNumber,
		title: issue.title,
		cloneUrl: repo.clone_url,
		defaultBranch: repo.default_branch,
		prHead: prNumber,
	});
	db.upsertIssue({
		key,
		repo: repo.full_name,
		number: prNumber,
		state: "reviewing",
		branch: workspace.branch,
		session_dir: workspace.session_dir,
		pr_number: prNumber,
	});
	await startTask(args, {
		taskKind: "review_pr",
		inputs: inputsFor(args, repo, workspace, { issue }),
		prNumber,
		pr,
	});
}

const FINALIZED_STATES = new Set<IssueState>(["merged", "closed", "abandoned"]);

export async function handleComment(args: TaskArgs): Promise<void> {
	const { db, github, payload } = args;
	const [repo, issue] = await tasksDeps.resolveRepoAndIssue(github, payload);
	const key = issueKey(repo.full_name, issue.number);
	const existing = db.getIssue(key);
	let directive = directiveFromPayload(payload);
	const comment = commentFromPayload(payload);
	const bootstrap = async (): Promise<TaskInputs> => {
		db.upsertIssue({ key, repo: repo.full_name, number: issue.number, state: "reproducing" });
		const workspace = await ensureWorkspace(args, {
			repo: repo.full_name,
			number: issue.number,
			title: issue.title,
			cloneUrl: repo.clone_url,
			defaultBranch: repo.default_branch,
		});
		db.upsertIssue({
			key,
			repo: repo.full_name,
			number: issue.number,
			state: "reproducing",
			branch: workspace.branch,
			session_dir: workspace.session_dir,
		});
		return inputsFor(args, repo, workspace, { issue });
	};

	if (existing === null) {
		if (directive === null) {
			log.info("skip: comment on unknown issue", { key });
			return;
		}
		// Maintainer summon on an untriaged issue: bootstrap a row + workspace
		// and route through triage-with-directive.
		log.info("directive bootstrap", { key, author: directive.author });
		const inputs = await bootstrap();
		directive = await tasksDeps.attachThread(github, directive, repo.full_name, issue.number, { isPr: false });
		await startTask(args, { taskKind: "triage_issue", inputs, directive });
		return;
	}

	if (FINALIZED_STATES.has(existing.state)) {
		if (directive === null) {
			log.info("skip: comment on finalized issue", { key, state: existing.state });
			try {
				await github.postComment(repo.full_name, issue.number, persona.finalizedIssueComment());
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				log.warning("ack comment failed", { err: err.message });
			}
			return;
		}
		// Maintainer reopen: tear down the stale workspace and branch afresh.
		log.info("directive reopen", { key, from_state: existing.state, author: directive.author });
		await removeWorkspace(args, repo.full_name, issue.number);
		const inputs = await bootstrap();
		directive = await tasksDeps.attachThread(github, directive, repo.full_name, issue.number, { isPr: false });
		await startTask(args, { taskKind: "handle_comment", inputs, comment, directive });
		return;
	}

	const workspace = await ensureWorkspace(args, {
		repo: repo.full_name,
		number: issue.number,
		title: issue.title,
		cloneUrl: repo.clone_url,
		defaultBranch: repo.default_branch,
		existingBranch: existing.branch,
	});
	const inputs = inputsFor(args, repo, workspace, { issue });
	directive = await tasksDeps.attachThread(github, directive, repo.full_name, issue.number, { isPr: false });
	await startTask(args, { taskKind: "handle_comment", inputs, comment, directive });
}

export async function handleReview(args: TaskArgs): Promise<void> {
	const { settings, db, github, payload } = args;
	const pr = obj(payload.pull_request);
	const prNumber = Number(pr.number || 0);
	if (prNumber <= 0) {
		log.info("skip: review without PR number");
		return;
	}
	const repoFull = String(obj(payload.repository).full_name || "");
	if (!repoFull) {
		log.info("skip: review without repo");
		return;
	}
	const [issueRow, prInfo] = await resolveIssueRowForPr({ db, github, repoFull, prNumber });
	let issueNumber: number;
	let existingBranch: string;
	if (issueRow === null) {
		if (prInfo === null || !canHandlePrDirectly(settings, repoFull, prInfo)) return;
		issueNumber = prNumber;
		existingBranch = prInfo.head_ref;
	} else {
		if (issueRow.branch === null) {
			log.info("skip: review PR missing branch mapping", { repo: repoFull, pr: prNumber });
			return;
		}
		issueNumber = issueRow.number;
		existingBranch = issueRow.branch;
	}
	let repo: RepoInfo;
	let issue: IssueInfo;
	try {
		repo = await github.getRepo(repoFull);
		issue = await github.getIssue(repoFull, issueNumber);
	} catch (err) {
		if (!(err instanceof GitHubError)) throw err;
		log.warning("review fetch failed", { err: err.message });
		return;
	}
	const workspace = await ensureWorkspace(args, {
		repo: repo.full_name,
		number: issue.number,
		title: issue.title,
		cloneUrl: repo.clone_url,
		defaultBranch: repo.default_branch,
		existingBranch,
	});
	if (issueRow === null) {
		db.upsertIssue({
			key: issueKey(repoFull, prNumber),
			repo: repoFull,
			number: prNumber,
			state: "opened",
			branch: workspace.branch,
			session_dir: workspace.session_dir,
			pr_number: prNumber,
		});
	}
	const comment = obj(payload.comment);
	const user = obj(comment.user);
	const reviewPayload = {
		author: String(user.login || ""),
		body: String(comment.body || ""),
		path: String(comment.path || ""),
		line: comment.line ?? null,
		start_line: comment.start_line ?? null,
		original_line: comment.original_line ?? null,
	};
	await startTask(args, {
		taskKind: "handle_review",
		inputs: inputsFor(args, repo, workspace, { issue }),
		prNumber,
		reviewPayload,
	});
}

/**
 * Handle a regular (non-review) comment on a bot-authored PR. The payload's
 * `issue.number` IS the PR number; resolve back to the originating issue and
 * drive `handle_comment` on the same session/branch.
 */
export async function handlePrConversation(args: TaskArgs): Promise<void> {
	const { settings, db, github, payload } = args;
	const repoFull = String(obj(payload.repository).full_name || "");
	const prNumber = obj(payload.issue).number;
	if (!repoFull || typeof prNumber !== "number" || !Number.isInteger(prNumber)) {
		log.info("skip: pr-conversation missing repo/number");
		return;
	}
	const [resolvedRow, prInfo] = await resolveIssueRowForPr({ db, github, repoFull, prNumber });
	let issueRow = resolvedRow;
	if (issueRow === null && (prInfo === null || !canHandlePrDirectly(settings, repoFull, prInfo))) return;
	let directive = directiveFromPayload(payload);
	if (issueRow !== null && issueRow.state === "reviewing") {
		log.info("skip: incoming PR conversation unsupported", { key: issueRow.key, pr: prNumber });
		return;
	}
	if (issueRow !== null && FINALIZED_STATES.has(issueRow.state)) {
		if (directive === null) {
			log.info("skip: pr-conversation on finalized issue", { key: issueRow.key, state: issueRow.state });
			// Still acknowledge so the reporter knows the bot saw it.
			try {
				await github.postComment(repoFull, prNumber, persona.finalizedPrComment());
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				log.warning("ack comment failed", { err: err.message });
			}
			return;
		}
		// Maintainer reopen on a finalized PR: branch afresh on the originating issue.
		log.info("directive reopen (pr)", { key: issueRow.key, from_state: issueRow.state, author: directive.author });
		await removeWorkspace(args, issueRow.repo, issueRow.number);
		db.upsertIssue({ key: issueRow.key, repo: issueRow.repo, number: issueRow.number, state: "reproducing" });
		issueRow = db.getIssue(issueRow.key) ?? issueRow;
	}
	// Bare @mention with no request body: the route stashes an empty directive;
	// reply cheaply without omp.
	if (directive === null && payload._robomp_directive !== undefined && payload._robomp_directive !== null) {
		const comment = commentFromPayload(payload);
		log.info("bare mention, prompting for request", { repo: repoFull, pr: prNumber, author: comment.author });
		try {
			await github.postComment(repoFull, prNumber, persona.bareMentionReply());
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			log.warning("bare mention reply failed", { err: err.message });
		}
		return;
	}
	const issueNumber = issueRow !== null ? issueRow.number : prNumber;
	let repo: RepoInfo;
	let issue: IssueInfo;
	try {
		repo = await github.getRepo(repoFull);
		issue = await github.getIssue(repoFull, issueNumber);
	} catch (err) {
		if (!(err instanceof GitHubError)) throw err;
		log.warning("pr-conversation fetch failed", { err: err.message });
		return;
	}
	let existingBranch: string | null;
	if (issueRow === null) {
		existingBranch = prInfo!.head_ref;
	} else {
		// On a reopen the prior branch is stale, so branch from default;
		// otherwise reuse the existing branch.
		const reopening = directive !== null && issueRow.state === "reproducing";
		existingBranch = reopening && issueRow.branch === null ? null : issueRow.branch;
		if (existingBranch === null && !reopening) {
			log.info("skip: pr-conversation PR missing branch mapping", { repo: repoFull, pr: prNumber });
			return;
		}
	}
	const workspace = await ensureWorkspace(args, {
		repo: repo.full_name,
		number: issue.number,
		title: issue.title,
		cloneUrl: repo.clone_url,
		defaultBranch: repo.default_branch,
		existingBranch,
	});
	if (issueRow === null) {
		db.upsertIssue({
			key: issueKey(repoFull, prNumber),
			repo: repoFull,
			number: prNumber,
			state: "opened",
			branch: workspace.branch,
			session_dir: workspace.session_dir,
			pr_number: prNumber,
		});
	} else if (directive !== null && (issueRow.branch === null || issueRow.branch !== workspace.branch)) {
		db.upsertIssue({
			key: issueRow.key,
			repo: issueRow.repo,
			number: issueRow.number,
			state: "reproducing",
			branch: workspace.branch,
			session_dir: workspace.session_dir,
		});
	}
	const comment = commentFromPayload(payload);
	const inputs = inputsFor(args, repo, workspace, { issue });
	let thread: ThreadMessage[] = [];
	if (directive === null) thread = await tasksDeps.fetchThread(github, repoFull, prNumber, { isPr: true });
	else directive = await tasksDeps.attachThread(github, directive, repoFull, prNumber, { isPr: true });
	await startTask(args, { taskKind: "handle_comment", inputs, comment, prNumber, directive, thread });
}

/** Tear down the workspace for a finished issue/PR. */
export async function cleanupWorkspace(args: {
	db: Database;
	sandbox: SandboxManager;
	payload: Json;
	targetState: IssueState;
	signal?: AbortSignal | null;
}): Promise<void> {
	const { db, sandbox, payload, targetState } = args;
	const repoFull = String(obj(payload.repository).full_name || "");
	if (!repoFull) return;
	// Python `payload.get("issue") or payload.get("pull_request") or {}`.
	const issuePayload = obj(payload.issue || payload.pull_request);
	const number = issuePayload.number;
	if (typeof number !== "number" || !Number.isInteger(number)) return;
	// A PR close maps to the originating issue.
	const issueRow =
		"pull_request" in payload ? db.findIssueByPr(repoFull, number) : db.getIssue(issueKey(repoFull, number));
	if (issueRow === null) return;
	await runWorkspaceOp(() => sandbox.removeWorkspace({ repo: issueRow.repo, number: issueRow.number }), args.signal);
	db.setIssueState(issueRow.key, targetState);
	log.info("cleanup", { key: issueRow.key, state: targetState });
}
