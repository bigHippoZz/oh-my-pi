/**
 * Prompt template loader + renderer.
 *
 * Templates use a tiny mustache-style `{{path.to.value}}` placeholder. The
 * substitution rules are deliberately restrictive (no escaping, no logic) so
 * a malformed prompt is impossible to render with surprising side-effects,
 * and rendered output stays byte-identical to the Python orchestrator.
 */
import completionReminderMd from "./prompts/completion_reminder.md" with { type: "text" };
import directiveMd from "./prompts/directive.md" with { type: "text" };
import dirtyStateReminderMd from "./prompts/dirty_state_reminder.md" with { type: "text" };
import finalizedIssueCommentMd from "./prompts/finalized_issue_comment.md" with { type: "text" };
import finalizedPrCommentMd from "./prompts/finalized_pr_comment.md" with { type: "text" };
import followupCommentMd from "./prompts/followup_comment.md" with { type: "text" };
import followupReleaseMd from "./prompts/followup_release.md" with { type: "text" };
import followupReviewMd from "./prompts/followup_review.md" with { type: "text" };
import hostToolsToml from "./prompts/host_tools.toml" with { type: "text" };
import kickoffDirectiveMd from "./prompts/kickoff_directive.md" with { type: "text" };
import kickoffIssueMd from "./prompts/kickoff_issue.md" with { type: "text" };
import kickoffPrReviewMd from "./prompts/kickoff_pr_review.md" with { type: "text" };
import kickoffReleaseMd from "./prompts/kickoff_release.md" with { type: "text" };
import questionAutocloseSuffixMd from "./prompts/question_autoclose_suffix.md" with { type: "text" };
import resumeTriageMd from "./prompts/resume_triage.md" with { type: "text" };
import reviewCompletionReminderMd from "./prompts/review_completion_reminder.md" with { type: "text" };
import systemAppendMd from "./prompts/system_append.md" with { type: "text" };
import systemAppendPrReviewMd from "./prompts/system_append_pr_review.md" with { type: "text" };
import systemAppendReleaseMd from "./prompts/system_append_release.md" with { type: "text" };
import todoPhasesToml from "./prompts/todo_phases.toml" with { type: "text" };
import unableToReproduceCommentMd from "./prompts/unable_to_reproduce_comment.md" with { type: "text" };
import type { DirtyState } from "./git-ops";
import type { CommentInfo, IssueInfo, PullRequestInfo, RepoInfo } from "./github-client";
import type { DirectiveInfo, ReleaseTaskContext, ThreadMessage } from "./task-types";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

type Scope = Record<string, unknown>;

function lookup(dotted: string, scope: Scope): string {
	let value: unknown = scope;
	for (const part of dotted.split(".")) {
		if (value === null || value === undefined) return "";
		value = (value as Record<string, unknown>)[part];
		if (value === null || value === undefined) return "";
	}
	if (Array.isArray(value)) return value.map(item => String(item)).join(", ");
	if (typeof value === "boolean") return value ? "True" : "False";
	return String(value);
}

export function render(template: string, scope: Scope): string {
	return template.replace(PLACEHOLDER, (_match, dotted: string) => lookup(dotted, scope));
}

type TomlTable = Record<string, unknown>;

let hostToolsTable: TomlTable | undefined;
let todoPhasesTable: TomlTable | undefined;

function hostTools(): TomlTable {
	hostToolsTable ??= Bun.TOML.parse(hostToolsToml) as TomlTable;
	return hostToolsTable;
}

function todoPhases(): TomlTable {
	todoPhasesTable ??= Bun.TOML.parse(todoPhasesToml) as TomlTable;
	return todoPhasesTable;
}

function requireMapping(value: unknown, context: string): TomlTable {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${context} must be a table`);
	return value as TomlTable;
}

function requireNonEmptyStr(value: unknown, context: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${context} must be a non-empty string`);
	return value;
}

export interface TodoPhase {
	name: string;
	tasks: string[];
}

export function seedPhases(taskKind: string): TodoPhase[] {
	const raw = todoPhases()[taskKind] ?? [];
	if (!Array.isArray(raw)) throw new Error(`todo_phases.toml['${taskKind}'] must be a list of phases`);
	return raw.map((rawPhase, phaseIndex) => {
		const phase = requireMapping(rawPhase, `todo_phases.toml['${taskKind}'][${phaseIndex}]`);
		const name = requireNonEmptyStr(phase.name, `todo_phases.toml['${taskKind}'][${phaseIndex}].name`);
		const rawTasks = phase.tasks;
		if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
			throw new Error(`todo_phases.toml['${taskKind}'][${phaseIndex}].tasks must be a non-empty list`);
		}
		const tasks = rawTasks.map((task, taskIndex) =>
			requireNonEmptyStr(task, `todo_phases.toml['${taskKind}'][${phaseIndex}].tasks[${taskIndex}]`),
		);
		return { name, tasks };
	});
}

function hostToolEntry(toolName: string): TomlTable {
	return requireMapping(hostTools()[toolName], `host_tools.toml['${toolName}']`);
}

export function hostToolDescription(toolName: string): string {
	return requireNonEmptyStr(hostToolEntry(toolName).description, `host_tools.toml['${toolName}'].description`);
}

export function hostToolParameterDescription(toolName: string, parameterName: string): string {
	const parameters = requireMapping(hostToolEntry(toolName).parameters, `host_tools.toml['${toolName}'].parameters`);
	return requireNonEmptyStr(
		parameters[parameterName],
		`host_tools.toml['${toolName}'].parameters['${parameterName}']`,
	);
}

export function classifyNextStep(primary: string): string {
	const steps = requireMapping(
		hostToolEntry("classify_issue").next_steps,
		"host_tools.toml['classify_issue'].next_steps",
	);
	return requireNonEmptyStr(steps[primary], `host_tools.toml['classify_issue'].next_steps['${primary}']`);
}

/** Structural slice of a `Workspace` the prompts read. */
export interface PromptWorkspace {
	branch: string;
	repo_dir: string;
}

type RepoLike = Pick<RepoInfo, "full_name" | "default_branch"> & Partial<RepoInfo>;
type IssueLike = Pick<IssueInfo, "number" | "title"> & Partial<IssueInfo>;

export function systemAppend(args: {
	repo: RepoLike;
	issue: IssueLike;
	workspace: PromptWorkspace;
	botLogin: string;
}): string {
	return render(systemAppendMd, {
		repo: args.repo,
		issue: args.issue,
		workspace: args.workspace,
		bot_login: args.botLogin,
	});
}

export function systemAppendPrReview(args: {
	repo: RepoLike;
	issue: IssueLike;
	workspace: PromptWorkspace;
	botLogin: string;
}): string {
	return render(systemAppendPrReviewMd, {
		repo: args.repo,
		issue: args.issue,
		workspace: args.workspace,
		bot_login: args.botLogin,
	});
}

/** Render the invariant release-repair instructions for every round. */
export function systemAppendRelease(args: {
	repo: RepoLike;
	release: ReleaseTaskContext;
	workspace: PromptWorkspace;
	releaseCommitPrefix: string;
}): string {
	return render(systemAppendReleaseMd, {
		repo: args.repo,
		release: args.release,
		workspace: args.workspace,
		release_commit_prefix: args.releaseCommitPrefix,
	});
}

/** Render the first failed-CI round for a release. */
export function kickoffRelease(args: {
	repo: RepoLike;
	release: ReleaseTaskContext;
	workspace: PromptWorkspace;
}): string {
	return render(kickoffReleaseMd, { ...args });
}

/** Render a later or crash-resumed failed-CI release round. */
export function followupRelease(args: {
	repo: RepoLike;
	release: ReleaseTaskContext;
	workspace: PromptWorkspace;
}): string {
	return render(followupReleaseMd, { ...args });
}

export function kickoff(args: { repo: RepoLike; issue: IssueLike; workspace: PromptWorkspace }): string {
	return render(kickoffIssueMd, { ...args });
}

type PrLike = Pick<PullRequestInfo, "number"> & Partial<PullRequestInfo>;

export function kickoffPrReview(args: { repo: RepoLike; pr: PrLike; workspace: PromptWorkspace }): string {
	return render(kickoffPrReviewMd, { ...args });
}

/** Resume prompt for a `triage_issue` task whose omp session already exists. */
export function resumeTriage(args: { repo: RepoLike; issue: IssueLike; workspace: PromptWorkspace }): string {
	return render(resumeTriageMd, { ...args });
}

/** Reminder injected when a triage turn ends before a terminal tool fired. */
export function completionReminder(args: { repo: RepoLike; issue: IssueLike; workspace: PromptWorkspace }): string {
	return render(completionReminderMd, { ...args });
}

/** Reminder injected when a PR review turn ends before submission. */
export function reviewCompletionReminder(args: {
	repo: RepoLike;
	issue: IssueLike;
	workspace: PromptWorkspace;
}): string {
	return render(reviewCompletionReminderMd, { ...args });
}

/** Reminder injected when the worktree has uncommitted or unpushed work. */
export function dirtyStateReminder(args: {
	repo: RepoLike;
	issue: IssueLike;
	workspace: PromptWorkspace;
	dirty: DirtyState;
}): string {
	return render(dirtyStateReminderMd, {
		repo: args.repo,
		issue: args.issue,
		workspace: args.workspace,
		dirty: { uncommitted: args.dirty.uncommitted, unpushed: args.dirty.unpushed, summary: args.dirty.summary },
	});
}

/** Render a thread as a markdown block for prompt embed. */
export function renderThread(messages: readonly ThreadMessage[]): string {
	if (messages.length === 0) return "(no prior conversation)";
	const parts: string[] = [];
	for (const m of messages) {
		const kind = m.kind || "comment";
		const author = m.author || "unknown";
		const body = m.body || "";
		const ts = m.created_at || "";
		let header: string;
		if (kind === "issue_body" || kind === "pr_body") {
			header = `### @${author} — ${kind === "pr_body" ? "PR body" : "issue body"}`;
		} else if (kind === "review_comment") {
			const anchor = `\`${m.path ?? "None"}\`${Number.isInteger(m.line) ? `:L${m.line}` : ""}`;
			header = `### @${author} — review comment on ${anchor}`;
		} else if (kind === "review") {
			header = `### @${author} — review (${m.state || "COMMENTED"})`;
		} else {
			header = `### @${author} — comment`;
		}
		if (ts) header += ` *(${ts})*`;
		parts.push(header, "", body.trimEnd(), "");
	}
	return parts.join("\n").trimEnd();
}

type DirectiveLike = Pick<DirectiveInfo, "body" | "author"> & { thread?: readonly ThreadMessage[] };

/** Kickoff for an untriaged issue that arrived via a maintainer mention. */
export function kickoffDirective(args: {
	repo: RepoLike;
	issue: IssueLike;
	workspace: PromptWorkspace;
	directive: DirectiveLike;
}): string {
	return render(kickoffDirectiveMd, {
		repo: args.repo,
		issue: args.issue,
		workspace: args.workspace,
		directive: { body: args.directive.body, author: args.directive.author },
		thread: renderThread(args.directive.thread ?? []),
	});
}

/** Describe the thread the inbound webhook arrived on. */
function inboundScope(issue: IssueLike, prNumber: number | null | undefined): Scope {
	if (prNumber !== null && prNumber !== undefined) return { kind: "PR", number: prNumber };
	return { kind: "issue", number: issue.number };
}

function originScope(issue: IssueLike): Scope {
	if (issue.is_pull_request) return { description: "originating issue unknown; handling this PR directly" };
	return { description: `originating issue #${issue.number}` };
}

export function followupComment(args: {
	repo: RepoLike;
	issue: IssueLike;
	comment: Partial<CommentInfo>;
	workspace: PromptWorkspace;
	prStatus: string;
	prNumber?: number | null;
	thread?: readonly ThreadMessage[];
}): string {
	return render(followupCommentMd, {
		repo: args.repo,
		issue: args.issue,
		workspace: args.workspace,
		comment: args.comment,
		thread: renderThread(args.thread ?? []),
		state: { pr_status: args.prStatus },
		inbound: inboundScope(args.issue, args.prNumber),
		origin: originScope(args.issue),
	});
}

/** Follow-up flavor for a comment that is a maintainer directive. */
export function directive(args: {
	repo: RepoLike;
	issue: IssueLike;
	comment: Partial<CommentInfo>;
	workspace: PromptWorkspace;
	directive: DirectiveLike;
	prStatus: string;
	prNumber?: number | null;
}): string {
	return render(directiveMd, {
		repo: args.repo,
		issue: args.issue,
		workspace: args.workspace,
		comment: args.comment,
		directive: { body: args.directive.body, author: args.directive.author },
		thread: renderThread(args.directive.thread ?? []),
		state: { pr_status: args.prStatus },
		inbound: inboundScope(args.issue, args.prNumber),
		origin: originScope(args.issue),
	});
}

export function followupReview(args: {
	repo: RepoLike;
	workspace: PromptWorkspace;
	prNumber: number;
	commentAuthor: string;
	commentBody: string;
	commentPath: string;
	commentLineRange: string;
}): string {
	return render(followupReviewMd, {
		repo: args.repo,
		workspace: args.workspace,
		pr: { number: args.prNumber },
		comment: {
			author: args.commentAuthor,
			body: args.commentBody,
			path: args.commentPath,
			line_range: args.commentLineRange,
		},
	});
}

export function unableToReproduceComment(args: { diagnosis: string; infoNeeded: string }): string {
	return render(unableToReproduceCommentMd, { diagnosis: args.diagnosis, info_needed: args.infoNeeded });
}

export function finalizedIssueComment(): string {
	return finalizedIssueCommentMd.trim();
}

export function finalizedPrComment(): string {
	return finalizedPrCommentMd.trim();
}

export function bareMentionReply(): string {
	return "What would you like me to do?";
}

/** Format a float like Python's `f"{x:g}"` (6 significant digits, no trailing zeros). */
export function formatG(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (value === 0) return "0";
	const exp = Math.floor(Math.log10(Math.abs(value)));
	if (exp < -4 || exp >= 6) {
		const [mantissa, e] = value.toExponential(5).split("e") as [string, string];
		const m = mantissa.replace(/\.?0+$/, "");
		const expNum = Number(e);
		return `${m}e${expNum < 0 ? "-" : "+"}${String(Math.abs(expNum)).padStart(2, "0")}`;
	}
	return String(Number(value.toPrecision(6)));
}

/** Render the 👎-to-keep-open suffix appended to the bot's question answers. */
export function questionAutocloseSuffix(hours: number): string {
	const rendered = Number.isInteger(hours) ? String(hours) : formatG(hours);
	return render(questionAutocloseSuffixMd.trimEnd(), { hours: rendered });
}
