/**
 * Host tools exposed to the agent through the RPC client's `host_tool_call`.
 *
 * The agent uses these for any side effect that touches GitHub, the
 * reproduction transcript store, or the orchestrator's bookkeeping.
 *
 * Python ran these synchronously on the RPC reader thread and bounced every
 * GitHub call back onto the worker loop; here every tool is plainly `async`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcClientCustomTool, RpcClientToolResult } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { Settings } from "./config";
import { type Database, type IssueState, issueKey, type StagedReviewComment, utcAfter } from "./db";
import { AGENT_HOME, GitCommandError, HeadDriftError } from "./git-ops";
import type { GitHubBackend } from "./github-backend";
import {
	type CommentInfo,
	GitHubError,
	type IssueInfo,
	type IssueSummary,
	type Json,
	type PullRequestFileInfo,
	type PullRequestInfo,
	type PullRequestReviewInfo,
	type RepoInfo,
} from "./github-client";
import { parseSearchQuery } from "./issue-index";
import { getLogger } from "./logging";
import * as persona from "./persona";
import {
	pyInt,
	pyIsInt,
	pyIterOrEmpty,
	pyJsonDumps,
	pyRepr,
	pySplitlines,
	pySplitWhitespace,
	pyStr,
	pyTruthy,
	pyTupleRepr,
} from "./pycompat";
import {
	type GitTransport,
	prepareSlotRuntimeEnv,
	renameWorkspaceBranch,
	safeDirectoryEnv,
	shareGitMetadataWithSlots,
	validateBranchSlug,
	type Workspace,
	workspaceKey,
} from "./sandbox";
import { type CompletedProcess, processEnv, runProcess, slotIdentity, slotPermissionsActive } from "./subprocess";

const log = getLogger("robomp.host_tools");

const PRE_PR_FIX_COMMAND = ["bun", "run", "fix"] as const;
const PRE_PR_CHECK_COMMAND = ["bun", "check"] as const;
const PRE_PR_TEST_COMMAND = ["bun", "run", "test"] as const;
const BUN_INSTALL_COMMAND = ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] as const;
const BUN_INSTALL_TIMEOUT_SECONDS = 300;
const REPO_COMMAND_SCRUBBED_ENV_KEYS = [
	"GITHUB_TOKEN",
	"GITHUB_WEBHOOK_SECRET",
	"ROBOMP_REPLAY_TOKEN",
	"ROBOMP_GH_PROXY_HMAC_KEY",
] as const;
const NEEDS_INFO_LABEL = "needs-info";
const PRE_PR_FIX_TIMEOUT_SECONDS = 600;
const PRE_PR_CHECK_TIMEOUT_SECONDS = 600;
const PRE_PR_CHECK_MAX_OUTPUT = 12_000;
// The suite is the slowest gate by an order of magnitude — CI splits this repo's
// run across five 20-25 minute jobs — so it gets its own budget rather than
// sharing the formatter/typecheck one.
const PRE_PR_TEST_TIMEOUT_SECONDS = 3600;
const DIFF_HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

type Args = Record<string, unknown>;

/**
 * Mutable handoff between the `abort_task` host tool and the worker.
 *
 * The worker pre-populates `stop` with the terminator used for queue
 * cancellation and the hard-timeout watchdog, and inspects `triggered` after
 * the prompt settles to decide whether the RPC failure is an intentional
 * abort (swallow, mark event `done`) or a real failure (propagate).
 */
export class AbortController {
	triggered = false;
	reason = "";
	stop: (() => void) | null = null;

	signal(reason: string): void {
		// Idempotent. Only the first call records its reason so a retry inside
		// the tool can't overwrite the original diagnosis.
		if (this.triggered) return;
		this.triggered = true;
		this.reason = reason;
		this.stop?.();
	}
}

/** Release identity and remote-drift snapshot for host tools. */
export interface ReleaseToolContext {
	repo: string;
	tag: string;
	version: string;
	key: string;
	expected_sha: string;
	default_branch: string;
}

export interface ToolBindingsInit {
	db: Database;
	github: GitHubBackend;
	gitTransport: GitTransport;
	repo: RepoInfo;
	issue: IssueInfo | null;
	workspace: Workspace;
	authorName: string;
	authorEmail: string;
	settings?: Settings | null;
	/**
	 * Number of the GitHub thread the inbound webhook arrived on (issue for an
	 * issue comment, PR for a PR conversation/review comment). `gh_post_comment`
	 * defaults its target here. `null` falls back to the originating issue.
	 */
	inboundThreadNumber?: number | null;
	/** Inbound thread is a PR: triage tools no-op there. */
	inboundIsPr?: boolean;
	/** Incoming-PR review task: review tools require it; publish tools reject it. */
	reviewMode?: boolean;
	/** Current task is driven by an authorizing maintainer directive. */
	implAuthorized?: boolean;
	slotUid?: number | null;
	/** Carries the abort-task signal back to the worker; `null` in unit tests. */
	abort?: AbortController | null;
	release?: ReleaseToolContext | null;
}

/** Per-task closure that the host tools capture. */
export class ToolBindings {
	readonly db: Database;
	readonly github: GitHubBackend;
	readonly gitTransport: GitTransport;
	readonly repo: RepoInfo;
	readonly issue: IssueInfo | null;
	readonly workspace: Workspace;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly settings: Settings | null;
	readonly inboundThreadNumber: number | null;
	readonly inboundIsPr: boolean;
	readonly reviewMode: boolean;
	readonly implAuthorized: boolean;
	readonly slotUid: number | null;
	readonly abort: AbortController | null;
	readonly release: ReleaseToolContext | null;

	constructor(init: ToolBindingsInit) {
		this.db = init.db;
		this.github = init.github;
		this.gitTransport = init.gitTransport;
		this.repo = init.repo;
		this.issue = init.issue;
		this.workspace = init.workspace;
		this.authorName = init.authorName;
		this.authorEmail = init.authorEmail;
		this.settings = init.settings ?? null;
		this.inboundThreadNumber = init.inboundThreadNumber ?? null;
		this.inboundIsPr = init.inboundIsPr ?? false;
		this.reviewMode = init.reviewMode ?? false;
		this.implAuthorized = init.implAuthorized ?? false;
		this.slotUid = init.slotUid ?? null;
		this.abort = init.abort ?? null;
		this.release = init.release ?? null;
	}

	get issueKey(): string {
		if (this.release !== null) return this.release.key;
		const issue = requireIssue(this);
		return issueKey(issue.repo, issue.number);
	}

	get defaultCommentNumber(): number {
		const issue = requireIssue(this);
		return this.inboundThreadNumber ?? issue.number;
	}
}

/** Error surfaced to the agent as a failed tool call (Python `RpcCommandError`). */
export class HostToolCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostToolCommandError";
	}
}

/** Raised by `runRepoCommand` when the executable is not on the command PATH. */
export class CommandNotFoundError extends Error {
	constructor(readonly command: string) {
		super(`command not found: ${command}`);
		this.name = "CommandNotFoundError";
	}
}

/** Python float `str()` for the whole-second timeouts used here (`30` → `30.0`). */
function pyFloatStr(value: number): string {
	return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * Python `subprocess.TimeoutExpired` for an uncaught command timeout; the
 * message is `str(exc)` byte-for-byte so the agent sees Python's tool error.
 */
export class TimeoutExpiredError extends Error {
	constructor(
		readonly cmd: readonly string[],
		readonly timeout: number,
	) {
		super(`Command '${pyRepr([...cmd])}' timed out after ${pyFloatStr(timeout)} seconds`);
		this.name = "TimeoutExpired";
	}
}

function raiseCommand(message: string): never {
	throw new HostToolCommandError(message);
}

function requireIssue(bindings: ToolBindings): IssueInfo {
	if (bindings.issue === null) raiseCommand("this tool requires issue context");
	return bindings.issue;
}

function requireRelease(bindings: ToolBindings): ReleaseToolContext {
	if (bindings.release === null) raiseCommand("this tool requires release context");
	return bindings.release;
}

function errorName(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}

function issueNeedsInfo(bindings: ToolBindings): boolean {
	const row = bindings.db.getIssue(bindings.issueKey);
	return row !== null && row.state === "needs_info";
}

async function removeNeedsInfoLabel(bindings: ToolBindings): Promise<boolean> {
	try {
		await bindings.github.removeIssueLabel(bindings.repo.full_name, requireIssue(bindings).number, NEEDS_INFO_LABEL);
	} catch (err) {
		if (err instanceof GitHubError) {
			if (err.status === 404) return true;
			log.warning("needs-info label cleanup failed", { issue: bindings.issueKey, err: err.message });
			return false;
		}
		// Best-effort optional label cleanup.
		log.warning("needs-info label cleanup failed", { issue: bindings.issueKey, err: errorName(err) });
		return false;
	}
	return true;
}

async function advanceNeedsInfo(bindings: ToolBindings, state: IssueState): Promise<boolean> {
	if (!issueNeedsInfo(bindings)) return false;
	const labelCleared = await removeNeedsInfoLabel(bindings);
	bindings.db.setIssueState(bindings.issueKey, state);
	return labelCleared;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function audit(
	bindings: ToolBindings,
	name: string,
	args: Args,
	outcome: { result?: unknown; error?: string | null } = {},
): void {
	const { result, error } = outcome;
	bindings.db.logToolCall({
		issue_key: bindings.issueKey,
		tool: name,
		args,
		result: isPlainObject(result) ? result : result !== undefined && result !== null ? { value: result } : null,
		error: error ?? null,
	});
}

function gitIdentityEnv(authorName: string, authorEmail: string): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: authorName,
		GIT_AUTHOR_EMAIL: authorEmail,
		GIT_COMMITTER_NAME: authorName,
		GIT_COMMITTER_EMAIL: authorEmail,
	};
}

/**
 * Environment for repo-owned commands (`bun`, formatter, local git).
 *
 * These commands execute code from the checked-out repository, so they must
 * not inherit GitHub credentials from the orchestrator. They also need the
 * exact same HOME/XDG/TMP/Bun cache paths as the agent process; otherwise
 * host-side pre-publish gates validate a different machine than the agent saw.
 */
export function repoCommandEnv(bindings: ToolBindings): Record<string, string> {
	const env = processEnv();
	for (const key of REPO_COMMAND_SCRUBBED_ENV_KEYS) env[key] = "";
	if (isDirectory(AGENT_HOME)) env.HOME = AGENT_HOME;
	Object.assign(env, prepareSlotRuntimeEnv(bindings.workspace));
	Object.assign(env, safeDirectoryEnv(bindings.workspace.repo_dir));
	Object.assign(env, gitIdentityEnv(bindings.authorName, bindings.authorEmail));
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

export interface RepoCommandOptions {
	/** Seconds; `null`/omitted means no timeout. */
	timeout?: number | null;
	extraEnv?: Record<string, string>;
}

/**
 * Run a repo-local command with agent-equivalent permissions and env.
 *
 * Throws `CommandNotFoundError` when the executable is not on the command's
 * PATH (Python's `FileNotFoundError`); a timeout is reported via `timedOut`.
 */
async function runRepoCommandImpl(
	bindings: ToolBindings,
	cmd: readonly string[],
	options: RepoCommandOptions = {},
): Promise<CompletedProcess> {
	const env = repoCommandEnv(bindings);
	if (options.extraEnv) Object.assign(env, options.extraEnv);
	const exe = cmd[0];
	if (exe !== undefined && Bun.which(exe, { PATH: env.PATH ?? "", cwd: bindings.workspace.repo_dir }) === null) {
		throw new CommandNotFoundError(exe);
	}
	return runProcess(cmd, {
		cwd: bindings.workspace.repo_dir,
		env,
		timeout: options.timeout ?? null,
		identity: slotIdentity(bindings.slotUid),
	});
}

/** Test seams (`spyOn(hostToolsDeps, ...)`), mirroring Python's module-level monkeypatch targets. */
export const hostToolsDeps = {
	runRepoCommand: runRepoCommandImpl,
	shareGitMetadataWithSlots,
	slotPermissionsActive,
	renameWorkspaceBranch,
	chown: (target: string, uid: number, gid: number): void => fs.chownSync(target, uid, gid),
};

export function runRepoCommand(
	bindings: ToolBindings,
	cmd: readonly string[],
	options?: RepoCommandOptions,
): Promise<CompletedProcess> {
	return hostToolsDeps.runRepoCommand(bindings, cmd, options);
}

/**
 * Return true iff `package.json` defines a `scripts.<name>` entry.
 *
 * A malformed or unreadable `package.json` is treated as "present" so the
 * repository-native error surfaces from `bun` instead of being swallowed here.
 */
function hasBunScript(repoDir: string, name: string): boolean {
	const packageJson = path.join(repoDir, "package.json");
	if (!isFile(packageJson)) return false;
	let pkg: unknown;
	try {
		pkg = JSON.parse(fs.readFileSync(packageJson, "utf-8"));
	} catch {
		return true;
	}
	if (!isPlainObject(pkg)) return true;
	const scripts = pkg.scripts;
	return isPlainObject(scripts) && typeof scripts[name] === "string";
}

function formatProcessOutput(stdout: string | null | undefined, stderr: string | null | undefined): string {
	const parts: string[] = [];
	for (const stream of [stdout, stderr]) {
		if (stream === null || stream === undefined) continue;
		const text = stream.trim();
		if (text) parts.push(text);
	}
	const output = parts.join("\n");
	if (!output) return "(no output)";
	if (output.length <= PRE_PR_CHECK_MAX_OUTPUT) return output;
	return `... output truncated to last ${PRE_PR_CHECK_MAX_OUTPUT} characters ...\n${output.slice(-PRE_PR_CHECK_MAX_OUTPUT)}`;
}

function procErr(proc: CompletedProcess): string {
	return (proc.stderr || proc.stdout).trim();
}

/**
 * Bootstrap `node_modules` so the agent can resolve workspace packages.
 *
 * A per-issue worktree is a bare source checkout: it has `package.json` and
 * `bun.lock` but no `node_modules`, so any `bun test`/`bun check` the agent
 * runs would fail with "Cannot find package". `--frozen-lockfile` keeps the
 * lockfile pristine and `--ignore-scripts` keeps an untrusted PR's lifecycle
 * scripts from running. Runs on every launch (a frozen install on an intact
 * tree is ~20ms and self-heals a half-finished one). Best-effort: failures
 * are logged and swallowed.
 */
export async function ensureWorkspaceDependencies(bindings: ToolBindings): Promise<void> {
	const repoDir = bindings.workspace.repo_dir;
	if (!isFile(path.join(repoDir, "package.json")) || !isFile(path.join(repoDir, "bun.lock"))) return;
	let proc: CompletedProcess;
	try {
		proc = await runRepoCommand(bindings, BUN_INSTALL_COMMAND, { timeout: BUN_INSTALL_TIMEOUT_SECONDS });
	} catch (err) {
		if (err instanceof CommandNotFoundError) {
			log.warning("bun_install bootstrap skipped: bun not on PATH", { issue: bindings.issueKey });
			return;
		}
		log.warning("bun_install bootstrap failed", {
			issue: bindings.issueKey,
			err: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	if (proc.timedOut) {
		log.warning("bun_install bootstrap failed", {
			issue: bindings.issueKey,
			err: new TimeoutExpiredError(BUN_INSTALL_COMMAND, BUN_INSTALL_TIMEOUT_SECONDS).message,
		});
		return;
	}
	if (proc.returncode !== 0) {
		log.warning("bun_install bootstrap nonzero exit", {
			issue: bindings.issueKey,
			code: proc.returncode,
			output: formatProcessOutput(proc.stdout, proc.stderr),
		});
		return;
	}
	log.info("bun_install bootstrap ok", { issue: bindings.issueKey });
}

export interface GateOptions {
	toolName: string;
	stage: string;
	skipChecks?: boolean;
}

function refuseWith(bindings: ToolBindings, toolName: string, args: Args, msg: string): never {
	audit(bindings, toolName, args, { error: msg });
	raiseCommand(msg);
}

/** Run a gate command, mapping missing-binary to a refusal. */
async function runGateCommand(
	bindings: ToolBindings,
	args: Args,
	cmd: readonly string[],
	timeout: number,
	opts: GateOptions,
	label: string,
): Promise<CompletedProcess> {
	try {
		return await runRepoCommand(bindings, cmd, { timeout });
	} catch (err) {
		if (err instanceof CommandNotFoundError) {
			refuseWith(
				bindings,
				opts.toolName,
				args,
				`refusing to ${opts.stage}: \`${label}\` is required before ${opts.stage}, but \`bun\` is not on PATH.`,
			);
		}
		throw err;
	}
}

/**
 * Run `bun run fix` then amend any working-tree diff into HEAD.
 *
 * No-ops when the repository defines no `scripts.fix`. The formatter diff is
 * folded into the agent's HEAD commit (safe: pushes use force-with-lease).
 * When no bot-authored commit may absorb the diff the tool refuses instead of
 * guessing. `skipChecks` skips the formatter but keeps the dirty-tree gate.
 */
async function runPrePublishBunFix(bindings: ToolBindings, args: Args, opts: GateOptions): Promise<void> {
	const { toolName, stage } = opts;
	if (!hasBunScript(bindings.workspace.repo_dir, "fix")) return;
	// Dirty-tree gate BEFORE the formatter so a pre-existing uncommitted edit
	// isn't swept into the formatter amend by the `git add -A` below.
	const preStatus = await runRepoCommand(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"]);
	if (preStatus.stdout.trim()) {
		const dirty = pySplitlines(preStatus.stdout.trim()).join("\n  ");
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: dirty worktree before \`bun run fix\`.\n  ${dirty}\n` +
				"Commit (or `git stash`) every change before invoking the formatter — " +
				"anything left uncommitted would be amended into your HEAD commit " +
				"and silently land in the PR.",
		);
	}
	if (opts.skipChecks) {
		audit(bindings, toolName, args, { result: { skipped: "bun_run_fix", reason: "skip_checks=true" } });
		return;
	}
	const proc = await runGateCommand(
		bindings,
		args,
		PRE_PR_FIX_COMMAND,
		PRE_PR_FIX_TIMEOUT_SECONDS,
		opts,
		"bun run fix",
	);
	if (proc.timedOut) {
		const output = formatProcessOutput(proc.stdout, proc.stderr);
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun run fix\` timed out before ${stage}.\n${output}\n\n` +
				"Investigate the hang, rerun the formatter, commit any resulting changes, and retry.",
		);
	}
	if (proc.returncode !== 0) {
		const output = formatProcessOutput(proc.stdout, proc.stderr);
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun run fix\` failed before ${stage} (exit ${proc.returncode}).\n${output}\n\n` +
				"Resolve the formatter failure, rerun `bun run fix` successfully, commit any " +
				"resulting changes, and retry.",
		);
	}

	const status = await runRepoCommand(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"]);
	if (!status.stdout.trim()) return;

	// The formatter produced a diff. Fold it into the agent's HEAD commit — but
	// only when HEAD is a bot-authored commit not already on the base branch.
	const base = bindings.repo.default_branch;
	const ahead = await runRepoCommand(bindings, ["git", "rev-list", "-n", "1", `origin/${base}..HEAD`]);
	if (ahead.returncode !== 0 || !ahead.stdout.trim()) {
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun run fix\` changed files, but there is no commit of ` +
				`yours to fold them into — the checkout matches \`origin/${base}\`, so the ` +
				`formatter drift pre-exists on \`${base}\`. Inspect with \`git status\` / \`git diff\`; ` +
				"either commit the formatter output yourself or discard it " +
				"(`git checkout -- . && git clean -fd`) and retry with `skip_checks=true`, " +
				"documenting the bypass.",
		);
	}
	const headIdentity = await runRepoCommand(bindings, ["git", "log", "-1", "--format=%an%x1f%ae", "HEAD"]);
	const identityText = stripChars(headIdentity.stdout, "\n");
	const identityFields = identityText.split("\x1f");
	if (
		headIdentity.returncode !== 0 ||
		identityFields.length !== 2 ||
		identityFields[0] !== bindings.authorName ||
		identityFields[1] !== bindings.authorEmail
	) {
		const author = `${identityText.replaceAll("\x1f", " <")}>`;
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun run fix\` changed files, but HEAD is authored by ` +
				`${author} — refusing to fold the formatter diff into a foreign commit. ` +
				"Fix the identity first (`git commit --amend --reset-author --no-edit`) and retry.",
		);
	}

	const add = await runRepoCommand(bindings, ["git", "add", "-A"]);
	if (add.returncode !== 0) {
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`git add -A\` failed after \`bun run fix\`: ${procErr(add)}`,
		);
	}
	const commit = await runRepoCommand(bindings, ["git", "commit", "--amend", "--no-edit"]);
	if (commit.returncode !== 0) {
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: failed to amend \`bun run fix\` changes into HEAD: ${procErr(commit)}`,
		);
	}
}

/** Python `str.strip(chars)`. */
function stripChars(text: string, chars: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && chars.includes(text[start]!)) start++;
	while (end > start && chars.includes(text[end - 1]!)) end--;
	return text.slice(start, end);
}

/**
 * Run `bun check` before publishing. `skipChecks` bypasses it to escape
 * pre-existing breakage on `main` that the agent's diff did not cause.
 */
export async function runPrePublishBunCheck(bindings: ToolBindings, args: Args, opts: GateOptions): Promise<void> {
	const { toolName, stage } = opts;
	if (opts.skipChecks) {
		audit(bindings, toolName, args, { result: { skipped: "bun_check", reason: "skip_checks=true" } });
		return;
	}
	if (!hasBunScript(bindings.workspace.repo_dir, "check")) return;
	const proc = await runGateCommand(
		bindings,
		args,
		PRE_PR_CHECK_COMMAND,
		PRE_PR_CHECK_TIMEOUT_SECONDS,
		opts,
		"bun check",
	);
	if (proc.timedOut) {
		const output = formatProcessOutput(proc.stdout, proc.stderr);
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun check\` timed out before ${stage}.\n${output}\n\n` +
				"Fix the check hang/failure, rerun `bun check`, commit any resulting changes, and retry.",
		);
	}
	if (proc.returncode !== 0) {
		const output = formatProcessOutput(proc.stdout, proc.stderr);
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun check\` failed before ${stage} (exit ${proc.returncode}).\n${output}\n\n` +
				"Fix the reported failures, rerun `bun check` successfully, commit any resulting changes, and retry.",
		);
	}
}

/**
 * Run `bun run test` before opening a PR. Same shape as the `bun check` gate:
 * no-op without `scripts.test`, bypassed by `skipChecks`, any failure is
 * returned to the agent instead of becoming a red PR.
 */
async function runPrePublishBunTest(bindings: ToolBindings, args: Args, opts: GateOptions): Promise<void> {
	const { toolName, stage } = opts;
	if (opts.skipChecks) {
		audit(bindings, toolName, args, { result: { skipped: "bun_run_test", reason: "skip_checks=true" } });
		return;
	}
	if (!hasBunScript(bindings.workspace.repo_dir, "test")) return;
	const proc = await runGateCommand(
		bindings,
		args,
		PRE_PR_TEST_COMMAND,
		PRE_PR_TEST_TIMEOUT_SECONDS,
		opts,
		"bun run test",
	);
	if (proc.timedOut) {
		const output = formatProcessOutput(proc.stdout, proc.stderr);
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun run test\` timed out after ${PRE_PR_TEST_TIMEOUT_SECONDS}s.\n${output}\n\n` +
				"Investigate the hang (a test that never exits blocks every future run), " +
				"rerun `bun run test`, and retry.",
		);
	}
	if (proc.returncode !== 0) {
		const output = formatProcessOutput(proc.stdout, proc.stderr);
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to ${stage}: \`bun run test\` failed before ${stage} (exit ${proc.returncode}).\n${output}\n\n` +
				"Fix the failing tests, commit, and retry — no PR is opened while the suite is red.",
		);
	}
}

const AUTOCLOSE_INELIGIBLE_STATES = new Set(["closed", "merged", "needs_info", "abandoned"]);

/**
 * Close window (hours) when this comment should schedule the question
 * auto-close job: feature enabled, same issue, classified `question`, and the
 * issue is not already terminal or waiting on the reporter.
 */
function shouldScheduleAutoclose(bindings: ToolBindings, targetNumber: number): number | null {
	const settings = bindings.settings;
	if (settings === null || !settings.question_autoclose_enabled) return null;
	const hours = Number(settings.question_autoclose_hours);
	if (hours <= 0) return null;
	if (targetNumber !== requireIssue(bindings).number) return null;
	if (bindings.inboundIsPr) return null;
	const row = bindings.db.getIssue(bindings.issueKey);
	if (row === null || row.classification !== "question") return null;
	if (AUTOCLOSE_INELIGIBLE_STATES.has(row.state)) return null;
	return hours;
}

/**
 * Insert (or refresh) a `pending_closures` row for the bot's answer. Failures
 * are logged, never surfaced to the agent.
 */
function scheduleAutoclose(bindings: ToolBindings, commentId: number, hours: number): string | null {
	const closeAt = utcAfter(hours * 3600);
	try {
		const issue = requireIssue(bindings);
		bindings.db.upsertPendingClosure({
			issue_key: bindings.issueKey,
			repo: issue.repo,
			number: issue.number,
			comment_id: commentId,
			issue_author: issue.author,
			close_at: closeAt,
		});
	} catch (err) {
		log.exception("autoclose schedule failed", err, {
			issue_key: bindings.issueKey,
			comment_id: commentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	return closeAt;
}

type ToolResult = RpcClientToolResult<unknown>;

function hostTool(
	name: string,
	parameters: Record<string, unknown>,
	execute: (args: Args) => Promise<ToolResult>,
): RpcClientCustomTool {
	return {
		name,
		description: persona.hostToolDescription(name),
		parameters,
		execute: (params: Args) => execute(params ?? {}),
	};
}

function param(tool: string, name: string): string {
	return persona.hostToolParameterDescription(tool, name);
}

/** `isinstance(value, int) and not isinstance(value, bool)` — only `release_job_log` excludes bools. */
function isStrictInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

// ---------- gh_post_comment ----------
function buildPostComment(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"gh_post_comment",
		{
			type: "object",
			properties: {
				body: { type: "string", description: param("gh_post_comment", "body") },
				number: { type: "integer", description: param("gh_post_comment", "number") },
			},
			required: ["body"],
			additionalProperties: false,
		},
		async args => {
			const body = args.body;
			if (!nonEmptyString(body)) raiseCommand("gh_post_comment requires a non-empty 'body'.");
			let targetNumber = bindings.defaultCommentNumber;
			if (pyIsInt(args.number)) targetNumber = pyInt(args.number);
			// If this comment answers the originating question issue, append the
			// 👎-to-keep-open suffix so the auto-close scheduler has a reaction surface.
			const scheduleClose = shouldScheduleAutoclose(bindings, targetNumber);
			let bodyToPost = body;
			if (scheduleClose !== null) {
				bodyToPost = `${body.trimEnd()}\n\n${persona.questionAutocloseSuffix(scheduleClose)}`;
			}
			let commentId: number;
			try {
				commentId = (await bindings.github.postComment(bindings.repo.full_name, targetNumber, bodyToPost)).id;
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, "gh_post_comment", args, { error: err.message });
				raiseCommand(`GitHub rejected comment: ${err.status} ${err.detail}`);
			}
			const auditResult: Record<string, unknown> = { comment_id: commentId };
			if (scheduleClose !== null) {
				const scheduledAt = scheduleAutoclose(bindings, commentId, scheduleClose);
				if (scheduledAt !== null) auditResult.scheduled_close_at = scheduledAt;
			}
			audit(bindings, "gh_post_comment", args, { result: auditResult });
			return `comment posted: id=${commentId}`;
		},
	);
}

/**
 * Convert shell-literal `\n` escapes in a commit message to newlines.
 *
 * Agents regularly run `git commit -m 'subject\n\nbody'` with single quotes,
 * recording backslash-n instead of a newline. Escapes inside backtick code
 * spans are genuine content and are preserved. Returns `null` when nothing
 * needs repair.
 */
export function repairMessageEscapes(message: string): string | null {
	if (!message.includes("\\n")) return null;
	const parts = message.split("`");
	let changed = false;
	for (let i = 0; i < parts.length; i += 2) {
		// Even indexes sit outside code spans.
		const fixed = parts[i]!.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
		if (fixed !== parts[i]) {
			parts[i] = fixed;
			changed = true;
		}
	}
	return changed ? parts.join("`") : null;
}

/**
 * Rewrite unpushed commits whose messages carry literal `\n` escapes.
 *
 * Rebuilds `origin/<base>..HEAD` with `git commit-tree`, preserving every tree,
 * parent topology, identity, and date — only messages change. The branch ref
 * only moves via the compare-and-swap `update-ref` at the very end, so a
 * refusal never leaves partial state.
 */
async function repairCommitMessageEscapes(bindings: ToolBindings, args: Args, toolName: string): Promise<void> {
	const fail: (step: string, proc: CompletedProcess) => never = (step, proc) => {
		const err = procErr(proc) || `exit ${proc.returncode}`;
		refuseWith(
			bindings,
			toolName,
			args,
			"refusing to push: commit messages contain literal `\\n` escapes and the " +
				`automatic repair failed at \`${step}\`: ${err}\n` +
				`Reword the affected commits yourself (\`git rebase -i origin/${bindings.repo.default_branch}\`, ` +
				"real newlines via `git commit -F <file>` or multiple `-m` flags) and retry.",
		);
	};

	const base = bindings.repo.default_branch;
	const revList = await runRepoCommand(bindings, ["git", "rev-list", "--reverse", `origin/${base}..HEAD`]);
	if (revList.returncode !== 0) return;
	const shas = pySplitWhitespace(revList.stdout);
	if (shas.length === 0) return;
	const messages = new Map<string, string>();
	const repaired: string[] = [];
	for (const sha of shas) {
		const show = await runRepoCommand(bindings, ["git", "log", "-1", "--format=%B", sha]);
		if (show.returncode !== 0) {
			if (repaired.length > 0) fail("git log", show);
			return;
		}
		let message = show.stdout;
		const fixed = repairMessageEscapes(message);
		if (fixed !== null) {
			message = fixed;
			repaired.push(sha);
		}
		messages.set(sha, message);
	}
	if (repaired.length === 0) return;

	const needsFix = new Set(repaired);
	const rewritten = new Map<string, string>();
	for (const sha of shas) {
		const meta = await runRepoCommand(bindings, [
			"git",
			"log",
			"-1",
			"--format=%T%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI",
			sha,
		]);
		if (meta.returncode !== 0) fail("git log", meta);
		const fields = stripChars(meta.stdout, "\n").split("\x1f");
		if (fields.length !== 8) fail("git log", meta);
		const [tree, parentsRaw, aName, aEmail, aDate, cName, cEmail, cDate] = fields as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		const parentsOld = pySplitWhitespace(parentsRaw);
		const parentsNew = parentsOld.map(p => rewritten.get(p) ?? p);
		if (!needsFix.has(sha) && parentsNew.every((p, i) => p === parentsOld[i])) {
			rewritten.set(sha, sha);
			continue;
		}
		const cmd = ["git", "commit-tree", tree];
		for (const parent of parentsNew) cmd.push("-p", parent);
		cmd.push("-m", messages.get(sha)!.replace(/\n+$/, ""));
		const made = await runRepoCommand(bindings, cmd, {
			extraEnv: {
				GIT_AUTHOR_NAME: aName,
				GIT_AUTHOR_EMAIL: aEmail,
				GIT_AUTHOR_DATE: aDate,
				GIT_COMMITTER_NAME: cName,
				GIT_COMMITTER_EMAIL: cEmail,
				GIT_COMMITTER_DATE: cDate,
			},
		});
		if (made.returncode !== 0 || !made.stdout.trim()) fail("git commit-tree", made);
		rewritten.set(sha, made.stdout.trim());
	}

	const oldHead = shas[shas.length - 1]!;
	const newHead = rewritten.get(oldHead)!;
	const update = await runRepoCommand(bindings, [
		"git",
		"update-ref",
		"-m",
		"robomp: repaired commit message escapes",
		"HEAD",
		newHead,
		oldHead,
	]);
	if (update.returncode !== 0) fail("git update-ref", update);
	const short = repaired.map(sha => sha.slice(0, 12));
	audit(bindings, toolName, args, { result: { repaired_commit_messages: short } });
	log.info("repaired commit message escapes", { issue: bindings.issueKey, commits: short });
}

function identityOffenders(stdout: string, bindings: ToolBindings): string[] {
	const offending: string[] = [];
	for (const line of pySplitlines(stdout.trim())) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const [sha, email, name] = parts as [string, string, string];
		if (email !== bindings.authorEmail || name !== bindings.authorName) {
			offending.push(`${sha.slice(0, 12)} ${name} <${email}>`);
		}
	}
	return offending;
}

/** Push failure → agent-facing message (shared by branch push and release retag). */
function pushFailureMessage(err: unknown, driftMessage: string): string | null {
	if (err instanceof HeadDriftError) return driftMessage;
	if (err instanceof GitCommandError) {
		return `git push failed: ${(err.stderr || err.stdout).trim() || `exit ${err.returncode}`}`;
	}
	if (err instanceof GitHubError) return `gh-proxy rejected push: ${err.status} ${err.detail}`;
	return null;
}

export async function guardedPushBranch(
	bindings: ToolBindings,
	args: Args,
	toolName: string,
	branch: string,
): Promise<string> {
	if (bindings.reviewMode) {
		refuseWith(bindings, toolName, args, "refusing to push: PR review worktrees are read-only.");
	}
	if (branch !== bindings.workspace.branch) {
		raiseCommand(
			`refusing to push: branch=${pyRepr(branch)} does not match workspace branch ${pyRepr(bindings.workspace.branch)}.`,
		);
	}
	// Re-pin the configured identity right before push (cheap; idempotent).
	await runRepoCommand(bindings, ["git", "config", "user.email", bindings.authorEmail]);
	await runRepoCommand(bindings, ["git", "config", "user.name", bindings.authorName]);
	// Cosmetic repair BEFORE the head snapshot: commits whose messages carry
	// shell-literal `\n` escapes are rewritten in place (message-only).
	await repairCommitMessageEscapes(bindings, args, toolName);
	const repoDir = bindings.workspace.repo_dir;
	const headProc = await runRepoCommand(bindings, ["git", "rev-parse", "HEAD"]);
	if (headProc.returncode !== 0) {
		const err = procErr(headProc) || `exit ${headProc.returncode}`;
		audit(bindings, toolName, args, { error: err });
		raiseCommand(`git rev-parse failed: ${err}`);
	}
	const headSha = headProc.stdout.trim();

	// Identity gate: every commit between the base branch and HEAD must carry
	// the configured author.
	const base = bindings.repo.default_branch;
	const identities = await runRepoCommand(bindings, [
		"git",
		"log",
		"--format=%H%x09%ae%x09%an",
		`origin/${base}..HEAD`,
	]);
	if (identities.returncode !== 0) {
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to push: could not inspect commit authors for origin/${base}..HEAD: ${procErr(identities)}`,
		);
	}
	const offending = identityOffenders(identities.stdout || "", bindings);
	if (offending.length > 0) {
		const details = offending.join("\n  ");
		refuseWith(
			bindings,
			toolName,
			args,
			"refusing to push: commit author identity mismatch. " +
				`Expected \`${bindings.authorName} <${bindings.authorEmail}>\`. ` +
				`Offending commits:\n  ${details}\n` +
				"Amend each commit with `git commit --amend --reset-author --no-edit` " +
				`(or rebase with \`git rebase -i origin/${base} --exec ` +
				"'git commit --amend --reset-author --no-edit'`) and try again.",
		);
	}

	// Working-tree cleanliness gate: uncommitted changes would land in the PR
	// review delta but not in the commit history.
	const status = await runRepoCommand(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"]);
	if (status.stdout.trim()) {
		const dirty = pySplitlines(status.stdout.trim()).join("\n  ");
		refuseWith(
			bindings,
			toolName,
			args,
			`refusing to push: working tree is dirty.\n  ${dirty}\n` +
				"Commit (or `git stash`) every change before pushing — anything in the " +
				"worktree that isn't in a commit won't appear in the PR.",
		);
	}

	let result: { head: string; branch: string };
	try {
		result = await bindings.gitTransport.pushBranch({
			repo: bindings.repo.full_name,
			workspaceKey: workspaceKey(bindings.repo.full_name, requireIssue(bindings).number),
			repoDir,
			branch,
			expectedHead: headSha,
			slotUid: bindings.slotUid,
		});
	} catch (err) {
		const msg = pushFailureMessage(
			err,
			"refusing to push: HEAD changed between preflight and push " +
				"(another commit landed; rerun the gate by re-issuing the push).",
		);
		if (msg === null) throw err;
		if (err instanceof GitCommandError && !(err instanceof HeadDriftError)) {
			// Python audits the bare stderr for git failures.
			audit(bindings, toolName, args, { error: msg.slice("git push failed: ".length) });
			raiseCommand(msg);
		}
		refuseWith(bindings, toolName, args, msg);
	}
	hostToolsDeps.shareGitMetadataWithSlots(repoDir, bindings.slotUid);
	audit(bindings, toolName, args, { result: { head: result.head, branch: result.branch } });
	return result.head;
}

const NON_FAILURE_JOB_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

// ---------- release_ci_status ----------
function buildReleaseCiStatus(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool("release_ci_status", { type: "object", properties: {}, additionalProperties: false }, async args => {
		const release = requireRelease(bindings);
		const renderedRuns: Record<string, unknown>[] = [];
		try {
			const runs = await bindings.github.listWorkflowRuns(release.repo, release.expected_sha);
			for (const run of runs) {
				const jobs = await bindings.github.listWorkflowJobs(release.repo, run.id);
				const failedJobs = jobs
					.filter(job => !NON_FAILURE_JOB_CONCLUSIONS.has(job.conclusion as string))
					.map(job => ({
						id: job.id,
						name: job.name,
						conclusion: job.conclusion,
						failed_steps: [...job.failed_steps],
						url: job.html_url,
					}));
				renderedRuns.push({
					id: run.id,
					name: run.name,
					status: run.status,
					conclusion: run.conclusion,
					url: run.html_url,
					failed_jobs: failedJobs,
				});
			}
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			refuseWith(bindings, "release_ci_status", args, `GitHub Actions lookup failed: ${err.status} ${err.detail}`);
		}
		const result = { sha: release.expected_sha, runs: renderedRuns };
		audit(bindings, "release_ci_status", args, { result });
		return pyJsonDumps(result);
	});
}

// ---------- release_job_log ----------
function buildReleaseJobLog(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"release_job_log",
		{
			type: "object",
			properties: {
				job_id: { type: "integer", description: param("release_job_log", "job_id") },
				tail_lines: { type: "integer", description: param("release_job_log", "tail_lines") },
			},
			required: ["job_id"],
			additionalProperties: false,
		},
		async args => {
			const release = requireRelease(bindings);
			const jobId = args.job_id;
			if (!isStrictInt(jobId)) raiseCommand("release_job_log requires an integer 'job_id'.");
			const tailRaw = args.tail_lines === undefined ? 200 : args.tail_lines;
			if (!isStrictInt(tailRaw)) raiseCommand("release_job_log 'tail_lines' must be an integer.");
			const tailLines = Math.max(1, Math.min(tailRaw, 1000));
			let logTail: string;
			try {
				logTail = await bindings.github.getJobLogTail(release.repo, jobId, tailLines);
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				refuseWith(
					bindings,
					"release_job_log",
					args,
					`GitHub Actions log lookup failed: ${err.status} ${err.detail}`,
				);
			}
			audit(bindings, "release_job_log", args, {
				result: { job_id: jobId, tail_lines: tailLines, returned_lines: pySplitlines(logTail).length },
			});
			return logTail;
		},
	);
}

// ---------- release_retag ----------
function buildReleaseRetag(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "release_retag";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				summary: { type: "string", description: param(tool, "summary") },
				skip_checks: { type: "boolean", description: param(tool, "skip_checks") },
			},
			required: ["summary"],
			additionalProperties: false,
		},
		async args => {
			const refuse: (message: string) => never = message => refuseWith(bindings, tool, args, message);
			const release = requireRelease(bindings);
			const summaryRaw = args.summary;
			if (!nonEmptyString(summaryRaw)) raiseCommand("release_retag requires a non-empty 'summary'.");
			const summary = summaryRaw.trim();
			if (bindings.workspace.branch !== release.default_branch) {
				refuse(
					"refusing to retag: workspace branch " +
						`${pyRepr(bindings.workspace.branch)} does not match release branch ${pyRepr(release.default_branch)}.`,
				);
			}

			const skipChecks = pyTruthy(args.skip_checks);
			await runPrePublishBunFix(bindings, args, { toolName: tool, stage: "retag", skipChecks });
			await runPrePublishBunCheck(bindings, args, { toolName: tool, stage: "retag", skipChecks });

			const status = await runRepoCommand(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"]);
			if (status.returncode !== 0) {
				refuse(
					`refusing to retag: could not inspect working tree: ${procErr(status) || `exit ${status.returncode}`}`,
				);
			}
			if (status.stdout.trim()) {
				const dirty = pySplitlines(status.stdout.trim()).join("\n  ");
				refuse(
					`refusing to retag: working tree is dirty.\n  ${dirty}\n` +
						"Commit (or `git stash`) every change before retagging.",
				);
			}

			const identities = await runRepoCommand(bindings, [
				"git",
				"log",
				"--format=%H%x09%ae%x09%an",
				`origin/${release.default_branch}..HEAD`,
			]);
			if (identities.returncode !== 0) {
				const err = procErr(identities) || `exit ${identities.returncode}`;
				refuse(
					`refusing to retag: could not inspect commit authors for origin/${release.default_branch}..HEAD: ${err}`,
				);
			}
			const offending = identityOffenders(identities.stdout, bindings);
			if (offending.length > 0) {
				const details = offending.join("\n  ");
				refuse(
					"refusing to retag: commit author identity mismatch. " +
						`Expected \`${bindings.authorName} <${bindings.authorEmail}>\`. ` +
						`Offending commits:\n  ${details}\n` +
						"Amend each commit with `git commit --amend --reset-author --no-edit` " +
						`(or rebase with \`git rebase -i origin/${release.default_branch} --exec ` +
						"'git commit --amend --reset-author --no-edit'`) and try again.",
				);
			}

			const subjectProc = await runRepoCommand(bindings, ["git", "log", "-1", "--format=%s"]);
			if (subjectProc.returncode !== 0) {
				refuse(
					`refusing to retag: could not inspect HEAD subject: ${procErr(subjectProc) || `exit ${subjectProc.returncode}`}`,
				);
			}
			const prefix = bindings.settings?.release_commit_prefix ?? "chore: bump version to ";
			if (!subjectProc.stdout.trim().startsWith(prefix)) {
				refuse(
					`refusing to retag: HEAD subject must start with ${pyRepr(prefix)} — ` +
						"CI's release concurrency group keys on it (#2564); reword the body, not the subject.",
				);
			}

			const headProc = await runRepoCommand(bindings, ["git", "rev-parse", "HEAD"]);
			if (headProc.returncode !== 0) {
				refuse(`refusing to retag: git rev-parse failed: ${procErr(headProc) || `exit ${headProc.returncode}`}`);
			}
			const newHead = headProc.stdout.trim();
			if (newHead === release.expected_sha) {
				refuse("refusing to retag: HEAD still points at the failing release sha; commit the fix first.");
			}

			let remoteTagSha: string | null;
			try {
				remoteTagSha = await bindings.github.getTagSha(release.repo, release.tag);
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				refuse(`GitHub tag lookup failed: ${err.status} ${err.detail}`);
			}
			if (remoteTagSha !== release.expected_sha) {
				refuse("refusing to retag: tag moved remotely — a human intervened; aborting.");
			}

			let pushed: { head: string };
			try {
				pushed = await bindings.gitTransport.pushRelease({
					repo: release.repo,
					workspaceKey: workspaceKey(release.repo, "release"),
					repoDir: bindings.workspace.repo_dir,
					branch: release.default_branch,
					tag: release.tag,
					expectedHead: newHead,
					slotUid: bindings.slotUid,
				});
			} catch (err) {
				const msg = pushFailureMessage(
					err,
					"refusing to retag: HEAD changed between preflight and push " +
						"(another commit landed; rerun the gate by re-issuing release_retag).",
				);
				if (msg === null) throw err;
				refuse(msg);
			}

			hostToolsDeps.shareGitMetadataWithSlots(bindings.workspace.repo_dir, bindings.slotUid);
			const row = bindings.db.getRelease(release.key);
			if (row === null) refuse(`release state missing for ${release.key}`);
			bindings.db.setReleaseSha(release.key, pushed.head);
			bindings.db.setReleaseState(release.key, "awaiting_ci");
			const result = { pushed: pushed.head, tag: release.tag, round: row.rounds };
			audit(bindings, tool, args, { result: { ...result, summary } });
			// Python returned the dict itself as the host-tool payload; keep the
			// wire shape identical.
			return result as unknown as ToolResult;
		},
	);
}

// ---------- gh_push_branch ----------
function buildPushBranch(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"gh_push_branch",
		{
			type: "object",
			properties: {
				branch: { type: "string", description: param("gh_push_branch", "branch") },
				skip_checks: { type: "boolean", description: param("gh_push_branch", "skip_checks") },
			},
			additionalProperties: false,
		},
		async args => {
			if (bindings.reviewMode) {
				refuseWith(bindings, "gh_push_branch", args, "refusing to push: PR review worktrees are read-only.");
			}
			enforceImplAuthorization(bindings, "gh_push_branch", args, "push branch");
			const branch = pyTruthy(args.branch) ? pyStr(args.branch) : bindings.workspace.branch;
			const skip = pyTruthy(args.skip_checks);
			// Formatter + check before bytes leave the workstation. The suite is
			// gated at `gh_open_pr`, not here: a push is not yet a PR.
			await runPrePublishBunFix(bindings, args, { toolName: "gh_push_branch", stage: "push", skipChecks: skip });
			await runPrePublishBunCheck(bindings, args, { toolName: "gh_push_branch", stage: "push", skipChecks: skip });
			const head = await guardedPushBranch(bindings, args, "gh_push_branch", branch);
			const suffix = skip ? " (pre-push checks skipped)" : "";
			return `pushed ${branch} at ${head.slice(0, 12)} as ${bindings.authorName} <${bindings.authorEmail}>${suffix}`;
		},
	);
}

// ---------- gh_open_pr ----------
function buildOpenPr(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"gh_open_pr",
		{
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string", description: param("gh_open_pr", "body") },
				base: { type: "string", description: param("gh_open_pr", "base") },
				draft: { type: "boolean", default: false },
				skip_checks: { type: "boolean", description: param("gh_open_pr", "skip_checks") },
			},
			required: ["title", "body"],
			additionalProperties: false,
		},
		async args => {
			if (bindings.reviewMode) {
				refuseWith(bindings, "gh_open_pr", args, "refusing to open PR: PR review tasks are read-only.");
			}
			enforceImplAuthorization(bindings, "gh_open_pr", args, "open PR");
			const title = args.title;
			const body = args.body;
			if (!nonEmptyString(title)) raiseCommand("gh_open_pr requires a non-empty 'title'.");
			if (!nonEmptyString(body)) raiseCommand("gh_open_pr requires a non-empty 'body'.");
			for (const required of ["## Repro", "## Cause", "## Fix", "## Verification"]) {
				if (!body.includes(required)) {
					raiseCommand(
						`PR body missing required section header ${pyRepr(required)}. ` +
							"Follow the template in the system prompt verbatim.",
					);
				}
			}
			// GitHub closes the linked issue on merge only with a closing keyword.
			const n = requireIssue(bindings).number;
			const accepted = ["Fixes", "Closes", "Resolves", "fixes", "closes", "resolves"].map(kw => `${kw} #${n}`);
			if (!accepted.some(form => body.includes(form))) {
				raiseCommand(
					`PR body must include \`Fixes #${n}\` (or \`Closes #${n}\` / \`Resolves #${n}\`) so ` +
						"GitHub auto-closes the issue when the PR merges. Put it at the end of the " +
						"Verification section per the template.",
				);
			}
			const skip = pyTruthy(args.skip_checks);
			const gate = { toolName: "gh_open_pr", stage: "open PR", skipChecks: skip };
			await runPrePublishBunFix(bindings, args, gate);
			await runPrePublishBunCheck(bindings, args, gate);
			// Last and slowest: the suite runs against the tree that is actually
			// published, after the formatter amend, so a red PR cannot be created.
			await runPrePublishBunTest(bindings, args, gate);
			// Make sure the branch is pushed (idempotent) using the same preflight.
			await guardedPushBranch(bindings, args, "gh_open_pr", bindings.workspace.branch);
			const base = pyTruthy(args.base) ? args.base : bindings.repo.default_branch;
			const wasNeedsInfo = issueNeedsInfo(bindings);
			let pr: PullRequestInfo;
			try {
				pr = await bindings.github.openPullRequest({
					repo: bindings.repo.full_name,
					head: bindings.workspace.branch,
					base: String(base),
					title,
					body,
					draft: pyTruthy(args.draft),
				});
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, "gh_open_pr", args, { error: err.message });
				raiseCommand(`GitHub rejected PR: ${err.status} ${err.detail}`);
			}
			bindings.db.setIssuePr(bindings.issueKey, pr.number);
			bindings.db.setIssueState(bindings.issueKey, "opened");
			const needsInfoLabelCleared = wasNeedsInfo ? await removeNeedsInfoLabel(bindings) : false;
			await Bun.write(
				path.join(bindings.workspace.artifacts_dir, "pr.json"),
				pyJsonDumps(
					{ repo: pr.repo, number: pr.number, url: pr.html_url, head: pr.head_ref, base: pr.base_ref },
					{ indent: 2 },
				),
			);
			const result: Record<string, unknown> = { pr_number: pr.number, url: pr.html_url };
			if (needsInfoLabelCleared) result.cleared_needs_info = true;
			audit(bindings, "gh_open_pr", args, { result });
			return `opened #${pr.number}: ${pr.html_url}`;
		},
	);
}

// ---------- gh_request_review ----------
function buildRequestReview(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"gh_request_review",
		{
			type: "object",
			properties: {
				reviewers: { type: "array", items: { type: "string" } },
				assignees: { type: "array", items: { type: "string" } },
			},
			additionalProperties: false,
		},
		async args => {
			const reviewers = pyTruthy(args.reviewers) ? args.reviewers : [];
			const assignees = pyTruthy(args.assignees) ? args.assignees : [];
			if (!Array.isArray(reviewers) || !Array.isArray(assignees)) {
				raiseCommand("gh_request_review expects 'reviewers' and 'assignees' to be arrays of logins.");
			}
			const issueRow = bindings.db.getIssue(bindings.issueKey);
			const prNumber = issueRow ? issueRow.pr_number : null;
			if (prNumber === null) raiseCommand("no PR recorded for this issue yet; call gh_open_pr first.");
			try {
				if (reviewers.length > 0) {
					await bindings.github.requestReviewers({
						repo: bindings.repo.full_name,
						pr_number: prNumber,
						reviewers: reviewers.map(String),
					});
				}
				if (assignees.length > 0) {
					await bindings.github.addAssignees(bindings.repo.full_name, prNumber, assignees.map(String));
				}
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, "gh_request_review", args, { error: err.message });
				raiseCommand(`GitHub rejected review request: ${err.status} ${err.detail}`);
			}
			audit(bindings, "gh_request_review", args, { result: { pr: prNumber } });
			return `updated review/assignees on #${prNumber}`;
		},
	);
}

/** Python `str.isalnum()` for one code point. */
function isAlnum(ch: string): boolean {
	return /^[\p{L}\p{N}]$/u.test(ch);
}

// ---------- repro_record ----------
function buildReproRecord(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"repro_record",
		{
			type: "object",
			properties: {
				title: { type: "string" },
				command: { type: "string" },
				output: { type: "string" },
				exit_code: { type: "integer" },
				reproduced: { type: "boolean", description: param("repro_record", "reproduced") },
			},
			required: ["title", "command", "output", "exit_code"],
			additionalProperties: false,
		},
		async args => {
			const { title, command, output, exit_code: exitCode } = args;
			if (!nonEmptyString(title)) raiseCommand("repro_record requires a non-empty 'title'.");
			if (!nonEmptyString(command)) raiseCommand("repro_record requires a non-empty 'command'.");
			if (typeof output !== "string") raiseCommand("repro_record requires 'output' (may be empty string).");
			if (!pyIsInt(exitCode)) raiseCommand("repro_record requires an integer 'exit_code'.");
			const reproDir = bindings.workspace.repro_dir;
			fs.mkdirSync(reproDir, { recursive: true });
			const slugChars = Array.from(title.toLowerCase(), c => (isAlnum(c) ? c : "-")).join("");
			const slug = Array.from(stripChars(slugChars, "-")).slice(0, 48).join("") || "repro";
			const ts = Math.floor(Date.now() / 1000);
			const target = path.join(reproDir, `${ts}-${slug}.md`);
			await Bun.write(
				target,
				`# ${title}\n\n- exit_code: ${pyStr(exitCode)}\n- command:\n\n\`\`\`\n${command}\n\`\`\`\n\n## Output\n\n\`\`\`\n${output}\n\`\`\`\n`,
			);
			// Single-ownership invariant: workspace files belong to the active
			// slot. Hand the root-written file over so the agent can edit it.
			if (hostToolsDeps.slotPermissionsActive(bindings.slotUid)) {
				hostToolsDeps.chown(target, bindings.slotUid!, bindings.slotUid!);
			}
			const result: Record<string, unknown> = { path: path.relative(bindings.workspace.root, target) };
			if (await advanceNeedsInfo(bindings, "reproducing")) result.cleared_needs_info = true;
			audit(bindings, "repro_record", args, { result });
			return "recorded";
		},
	);
}

// ---------- mark_unable_to_reproduce ----------
function buildMarkUnable(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"mark_unable_to_reproduce",
		{
			type: "object",
			properties: { diagnosis: { type: "string" }, info_needed: { type: "string" } },
			required: ["diagnosis", "info_needed"],
			additionalProperties: false,
		},
		async args => {
			const diagnosis = args.diagnosis;
			const needed = args.info_needed;
			if (!nonEmptyString(diagnosis)) raiseCommand("mark_unable_to_reproduce requires a 'diagnosis'.");
			if (!nonEmptyString(needed)) {
				raiseCommand("mark_unable_to_reproduce requires 'info_needed' explaining what to ask for.");
			}
			const body = persona.unableToReproduceComment({ diagnosis, infoNeeded: needed });
			const number = requireIssue(bindings).number;
			let commentId: number;
			try {
				commentId = (await bindings.github.postComment(bindings.repo.full_name, number, body)).id;
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, "mark_unable_to_reproduce", args, { error: err.message });
				raiseCommand(`GitHub rejected comment: ${err.status} ${err.detail}`);
			}
			const result: Record<string, unknown> = { comment_id: commentId, state: "needs_info" };
			try {
				result.labels = [
					...(await bindings.github.addIssueLabels(bindings.repo.full_name, number, [NEEDS_INFO_LABEL])),
				];
			} catch (err) {
				// Some repos have not created the optional status label yet. The
				// durable behavior is the sqlite state plus the visible comment.
				if (err instanceof GitHubError) {
					log.warning("needs-info label failed", { issue: bindings.issueKey, err: err.message });
					result.label_error = `${err.status} ${err.detail}`;
				} else {
					const error = errorName(err);
					log.warning("needs-info label failed", { issue: bindings.issueKey, err: error });
					result.label_error = error;
				}
			}
			bindings.db.setIssueState(bindings.issueKey, "needs_info");
			audit(bindings, "mark_unable_to_reproduce", args, { result });
			return `posted needs-info comment id=${commentId}`;
		},
	);
}

// ---------- abort_task ----------
function buildAbortTask(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"abort_task",
		{
			type: "object",
			properties: { reason: { type: "string" } },
			required: ["reason"],
			additionalProperties: false,
		},
		async args => {
			const reasonRaw = args.reason;
			if (!nonEmptyString(reasonRaw)) raiseCommand("abort_task requires a non-empty 'reason' string.");
			const reason = reasonRaw.trim();
			// Audit FIRST so the diagnosis is durable even if anything below
			// races against the imminent omp teardown.
			audit(bindings, "abort_task", args, { result: { reason } });
			log.warning("task_aborted", { issue: bindings.issueKey, reason });
			if (bindings.release !== null) {
				bindings.db.setReleaseState(bindings.release.key, "failed", reason);
			} else {
				bindings.db.setIssueState(bindings.issueKey, "abandoned");
			}
			bindings.abort?.signal(reason);
			return "aborted";
		},
	);
}

// ---------- fetch_issue_thread ----------
function buildFetchThread(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool(
		"fetch_issue_thread",
		{ type: "object", properties: {}, additionalProperties: false },
		async args => {
			const number = requireIssue(bindings).number;
			let issue: IssueInfo;
			let comments: CommentInfo[];
			try {
				issue = await bindings.github.getIssue(bindings.repo.full_name, number);
				comments = await bindings.github.listComments(bindings.repo.full_name, number);
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, "fetch_issue_thread", args, { error: err.message });
				raiseCommand(`GitHub fetch failed: ${err.status} ${err.detail}`);
			}
			const lines = [
				`# ${issue.repo}#${issue.number} (${issue.state})`,
				`title: ${issue.title}`,
				`author: @${issue.author}`,
				`labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}`,
				"",
				"## Body",
				issue.body.trim() || "(empty)",
				"",
				`## Comments (${comments.length})`,
			];
			for (const c of comments) lines.push("", `### @${c.author} at ${c.created_at}`, c.body.trim());
			audit(bindings, "fetch_issue_thread", args, { result: { comments: comments.length } });
			return lines.join("\n");
		},
	);
}

// ---------- gh_search_issues ----------
const REPO_QUALIFIER_RE = /\brepo:/i;

type SearchRow = [boolean, number, string, string, string, readonly string[], string];

function renderSearchMatches(query: string, repo: string, rows: readonly SearchRow[]): string {
	const lines = [`# ${rows.length} match(es) for ${pyRepr(query)} in ${repo}`];
	for (const [isPr, number, state, title, author, labels, updated] of rows) {
		const kind = isPr ? "PR" : "issue";
		const labelSfx = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
		lines.push(`- #${number} (${kind}, ${state}) ${title} — @${author}, updated ${updated.slice(0, 10)}${labelSfx}`);
	}
	return lines.join("\n");
}

/**
 * Issue/PR search scoped to the current repo, served from the local index.
 *
 * Queries hit the webhook-fed SQLite FTS index (zero API cost); the GitHub
 * search API is only used before the repo's first reconcile completes. The
 * inbound issue is filtered out of results.
 */
function buildSearchIssues(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "gh_search_issues";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				query: { type: "string", description: param(tool, "query") },
				limit: { type: "integer", description: param(tool, "limit") },
			},
			required: ["query"],
			additionalProperties: false,
		},
		async args => {
			const queryRaw = args.query;
			if (!nonEmptyString(queryRaw))
				refuseWith(bindings, tool, args, "gh_search_issues requires a non-empty 'query'.");
			const query = queryRaw.trim();
			if (REPO_QUALIFIER_RE.test(query)) {
				refuseWith(
					bindings,
					tool,
					args,
					"gh_search_issues scopes to the current repo automatically; drop the 'repo:' qualifier.",
				);
			}
			const limitRaw = args.limit;
			const limit = pyIsInt(limitRaw) ? Math.max(1, Math.min(pyInt(limitRaw), 20)) : 10;
			const repo = bindings.repo.full_name;
			// Python resolves the inbound issue lazily inside the self-filter, so
			// a missing issue context only fails once there is a row to filter.
			const isSelf = (entry: { is_pull_request: boolean; number: number }): boolean =>
				!entry.is_pull_request && entry.number === requireIssue(bindings).number;

			let rows: SearchRow[];
			let source: string;
			if (bindings.db.issueIndexWatermark(repo) !== null) {
				const parsed = parseSearchQuery(query);
				const entries = bindings.db
					.searchIssueIndex(repo, {
						keywords: parsed.keywords,
						is_pr: parsed.is_pr,
						state: parsed.state,
						merged: parsed.merged,
						label: parsed.label,
						author: parsed.author,
						limit: limit + 1, // headroom for the self-filter below
					})
					.filter(e => !isSelf(e))
					.slice(0, limit);
				rows = entries.map(e => {
					let state: string;
					if (e.is_pull_request && e.merged_at) state = "merged";
					else if (e.state_reason) state = `${e.state} (${e.state_reason})`;
					else state = e.state;
					return [e.is_pull_request, e.number, state, e.title, e.author, e.labels, e.updated_at];
				});
				source = "local";
			} else {
				// Index not backfilled yet — fall through to the GitHub search API.
				let found: IssueSummary[];
				try {
					found = await bindings.github.searchIssues(repo, query, limit);
				} catch (err) {
					if (!(err instanceof GitHubError)) throw err;
					audit(bindings, tool, args, { error: err.message });
					raiseCommand(`GitHub search failed: ${err.status} ${err.detail}`);
				}
				rows = found
					.filter(s => !isSelf(s))
					.map(s => [
						s.is_pull_request,
						s.number,
						s.state_reason ? `${s.state} (${s.state_reason})` : s.state,
						s.title,
						s.author,
						s.labels,
						s.updated_at,
					]);
				source = "remote";
			}
			if (rows.length === 0) {
				audit(bindings, tool, args, { result: { matches: 0, source } });
				return `No issues or PRs in ${repo} match ${pyRepr(query)}.`;
			}
			audit(bindings, tool, args, { result: { matches: rows.length, source } });
			return renderSearchMatches(query, repo, rows);
		},
	);
}

// ---------- search_commits ----------
const COMMIT_SEARCH_TIMEOUT_SECONDS = 120;
const PROBE_TIMEOUT_SECONDS = 30;

/**
 * Local `git log` search over the default branch's history. `message` greps
 * commit subjects/bodies (case-insensitive regex); `patch` runs the pickaxe
 * (`-S`) — the sharp tool for "was this already fixed".
 */
function buildSearchCommits(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "search_commits";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				query: { type: "string", description: param(tool, "query") },
				mode: { type: "string", enum: ["message", "patch"], description: param(tool, "mode") },
				paths: { type: "array", items: { type: "string" }, description: param(tool, "paths") },
				limit: { type: "integer", description: param(tool, "limit") },
			},
			required: ["query"],
			additionalProperties: false,
		},
		async args => {
			const queryRaw = args.query;
			if (!nonEmptyString(queryRaw))
				refuseWith(bindings, tool, args, "search_commits requires a non-empty 'query'.");
			const query = queryRaw.trim();
			const mode = pyTruthy(args.mode) ? args.mode : "message";
			if (mode !== "message" && mode !== "patch") {
				refuseWith(bindings, tool, args, "search_commits 'mode' must be 'message' or 'patch'.");
			}
			const limitRaw = args.limit;
			const limit = pyIsInt(limitRaw) ? Math.max(1, Math.min(pyInt(limitRaw), 30)) : 10;
			const paths = pyIterOrEmpty(args.paths).filter(nonEmptyString);

			let rev = `origin/${bindings.repo.default_branch}`;
			const probeCmd = ["git", "rev-parse", "--verify", "--quiet", rev];
			const probe = await runRepoCommand(bindings, probeCmd, { timeout: PROBE_TIMEOUT_SECONDS });
			// Python's probe has no TimeoutExpired handler: a hung rev-parse fails the tool.
			if (probe.timedOut) throw new TimeoutExpiredError(probeCmd, PROBE_TIMEOUT_SECONDS);
			if (probe.returncode !== 0) rev = "HEAD";
			const cmd = ["git", "log", rev, "-n", String(limit), "--date=short", "--pretty=format:%h %ad %an — %s"];
			if (mode === "message") cmd.push(`--grep=${query}`, "--regexp-ignore-case");
			else cmd.push("-S", query);
			if (paths.length > 0) cmd.push("--", ...paths);
			const proc = await runRepoCommand(bindings, cmd, { timeout: COMMIT_SEARCH_TIMEOUT_SECONDS });
			if (proc.timedOut) {
				refuseWith(
					bindings,
					tool,
					args,
					`search_commits timed out after ${COMMIT_SEARCH_TIMEOUT_SECONDS}s; narrow with 'paths' or a shorter history window.`,
				);
			}
			if (proc.returncode !== 0) {
				refuseWith(bindings, tool, args, `git log failed: ${procErr(proc).slice(0, 500)}`);
			}
			const out = proc.stdout.trim();
			if (!out) {
				audit(bindings, tool, args, { result: { matches: 0 } });
				return `No commits on ${rev} match ${pyRepr(query)} (mode=${mode}).`;
			}
			const matches = pySplitlines(out);
			audit(bindings, tool, args, { result: { matches: matches.length } });
			const header = `# ${matches.length} commit(s) on ${rev} matching ${pyRepr(query)} (mode=${mode})`;
			return [header, ...matches].join("\n");
		},
	);
}

const PRIMARY_TYPES = [
	"bug",
	"enhancement",
	"question",
	"proposal",
	"documentation",
	"wontfix",
	"invalid",
	"duplicate",
] as const;
const AUTO_PR_CLASSIFICATIONS = new Set(["bug", "documentation"]);
const PRIORITIES = ["prio:p0", "prio:p1", "prio:p2", "prio:p3"] as const;
const FUNCTIONAL = ["agent", "tool", "tui", "cli", "prompting", "sdk", "auth", "setup", "ux", "providers"] as const;
const PLATFORMS = ["platform:linux", "platform:macos", "platform:windows", "platform:wsl"] as const;
const PR_RANKS = ["review:p0", "review:p1", "review:p2", "review:p3"] as const;
const PR_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build"] as const;
const CLOSING_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Refuse first publish on issue classes that require maintainer authorization. */
function enforceImplAuthorization(bindings: ToolBindings, toolName: string, args: Args, action: string): void {
	if (bindings.implAuthorized) return;
	if (bindings.db.hasAuthorizedImplEvent(bindings.issueKey)) return;
	const row = bindings.db.getIssue(bindings.issueKey);
	let classification: string | null = null;
	if (row !== null) {
		if (row.pr_number !== null) return;
		classification = row.classification;
		if (classification !== null && AUTO_PR_CLASSIFICATIONS.has(classification)) return;
	}
	const phrase = classification ? `classified \`${classification}\`` : "not classified";
	refuseWith(
		bindings,
		toolName,
		args,
		`refusing to ${action}: issue #${requireIssue(bindings).number} is ${phrase}; ` +
			"a repo OWNER or allowlisted maintainer must @-mention you with an explicit go-ahead " +
			"before any branch/PR. Post your analysis with `gh_post_comment` and stop.",
	);
}

function requireReviewMode(bindings: ToolBindings, name: string, args: Args): void {
	if (bindings.reviewMode) return;
	refuseWith(bindings, name, args, `${name} is only available during incoming PR review tasks.`);
}

function formatPrFile(file: PullRequestFileInfo): string {
	return `- \`${file.path}\` (${file.status}, +${file.additions}/-${file.deletions})`;
}

function buildFetchPr(bindings: ToolBindings): RpcClientCustomTool {
	return hostTool("fetch_pr", { type: "object", properties: {}, additionalProperties: false }, async args => {
		requireReviewMode(bindings, "fetch_pr", args);
		const prNumber = bindings.defaultCommentNumber;
		let pr: PullRequestInfo;
		let files: PullRequestFileInfo[];
		try {
			pr = await bindings.github.getPullRequest(bindings.repo.full_name, prNumber);
			files = await bindings.github.listPrFiles(bindings.repo.full_name, prNumber);
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			audit(bindings, "fetch_pr", args, { error: err.message });
			raiseCommand(`GitHub fetch failed: ${err.status} ${err.detail}`);
		}
		const linked = [...new Set(Array.from(pr.body.matchAll(CLOSING_ISSUE_RE), m => Number(m[1])))].sort(
			(a, b) => a - b,
		);
		const lines = [
			`# ${pr.repo}#${pr.number} (${pr.state})`,
			`title: ${pr.title || "(untitled)"}`,
			`author: @${pr.author}`,
			`head: ${pr.head_repo || pr.repo}:${pr.head_ref}`,
			`base: ${pr.base_ref}`,
			`url: ${pr.html_url}`,
			"",
			"## Body",
			pr.body.trim() || "(empty)",
			"",
			"## Linked issues",
			linked.length > 0 ? linked.map(n => `#${n}`).join(", ") : "(none found in PR body)",
			"",
			`## Changed files (${files.length})`,
			...files.map(formatPrFile),
		];
		audit(bindings, "fetch_pr", args, { result: { files: files.length, linked_issues: linked } });
		return lines.join("\n");
	});
}

function buildClassifyPr(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "classify_pr";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				rank: { type: "string", enum: [...PR_RANKS], description: param(tool, "rank") },
				type: { type: "string", enum: [...PR_TYPES], description: param(tool, "type") },
				area: {
					type: "array",
					items: { type: "string", enum: [...FUNCTIONAL] },
					description: param(tool, "area"),
				},
				provider: { type: "string", description: param(tool, "provider") },
				rationale: { type: "string", description: param(tool, "rationale") },
			},
			required: ["rank", "type", "rationale"],
			additionalProperties: false,
		},
		async args => {
			requireReviewMode(bindings, tool, args);
			const rank = args.rank;
			if (!oneOf(PR_RANKS, rank)) {
				refuseWith(
					bindings,
					tool,
					args,
					`classify_pr 'rank' must be one of ${pyTupleRepr(PR_RANKS)}; got ${pyRepr(rank)}.`,
				);
			}
			const prType = args.type;
			if (!oneOf(PR_TYPES, prType)) {
				refuseWith(
					bindings,
					tool,
					args,
					`classify_pr 'type' must be one of ${pyTupleRepr(PR_TYPES)}; got ${pyRepr(prType)}.`,
				);
			}
			const rationale = args.rationale;
			if (!nonEmptyString(rationale))
				refuseWith(bindings, tool, args, "classify_pr requires a one-sentence 'rationale'.");

			const labels: string[] = ["triaged", rank, prType];
			for (const area of pyIterOrEmpty(args.area)) {
				if (oneOf(FUNCTIONAL, area)) labels.push(area);
			}
			const provider = args.provider;
			if (nonEmptyString(provider) && provider.startsWith("provider:")) labels.push("providers", provider);
			let applied: string[];
			try {
				applied = await bindings.github.addIssueLabels(
					bindings.repo.full_name,
					bindings.defaultCommentNumber,
					labels,
				);
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, tool, args, { error: err.message });
				raiseCommand(`GitHub rejected labels: ${err.status} ${err.detail}`);
			}
			bindings.db.setIssueClassification(bindings.issueKey, rank);
			audit(bindings, tool, args, { result: { rank, type: prType, labels: [...applied], rationale } });
			return `classified PR as ${rank}; labels applied: ${applied.join(", ")}.`;
		},
	);
}

function reviewCommentToPayload(comment: StagedReviewComment): Json {
	const payload: Json = {
		path: comment.path,
		line: comment.line,
		side: comment.side,
		body: comment.body,
	};
	if (comment.start_line !== null) payload.start_line = comment.start_line;
	if (comment.start_side !== null) payload.start_side = comment.start_side;
	return payload;
}

function buildPrReviewComment(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "pr_review_comment";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				path: { type: "string", description: param(tool, "path") },
				line: { type: "integer", description: param(tool, "line") },
				body: { type: "string", description: param(tool, "body") },
				side: { type: "string", enum: ["RIGHT", "LEFT"], default: "RIGHT", description: param(tool, "side") },
				start_line: { type: "integer", description: param(tool, "start_line") },
				start_side: { type: "string", enum: ["RIGHT", "LEFT"], description: param(tool, "start_side") },
			},
			required: ["path", "line", "body"],
			additionalProperties: false,
		},
		async args => {
			requireReviewMode(bindings, tool, args);
			const refuse: (msg: string) => never = msg => refuseWith(bindings, tool, args, msg);
			const { path: filePath, line, body } = args;
			if (!nonEmptyString(filePath)) refuse("pr_review_comment requires a non-empty 'path'.");
			if (!pyIsInt(line) || pyInt(line) <= 0) refuse("pr_review_comment requires a positive integer 'line'.");
			if (!nonEmptyString(body)) refuse("pr_review_comment requires a non-empty 'body'.");
			const side = pyTruthy(args.side) ? pyStr(args.side) : "RIGHT";
			if (side !== "RIGHT" && side !== "LEFT") refuse("pr_review_comment 'side' must be RIGHT or LEFT.");
			const startLine = args.start_line ?? null;
			if (startLine !== null && (!pyIsInt(startLine) || pyInt(startLine) <= 0)) {
				refuse("pr_review_comment 'start_line' must be a positive integer when provided.");
			}
			const startSideRaw = args.start_side ?? null;
			const startSide = startSideRaw !== null ? pyStr(startSideRaw) : null;
			if (startSide !== null && startSide !== "RIGHT" && startSide !== "LEFT") {
				refuse("pr_review_comment 'start_side' must be RIGHT or LEFT when provided.");
			}
			const staged = bindings.db.stageReviewComment({
				issue_key: bindings.issueKey,
				path: (filePath as string).trim(),
				// sqlite stores Python's `True`/`False` as 1/0.
				line: pyInt(line as number | boolean),
				side,
				start_line: startLine === null ? null : pyInt(startLine as number | boolean),
				start_side: startSide,
				body: (body as string).trim(),
			});
			const count = bindings.db.listStagedReviewComments(bindings.issueKey).length;
			audit(bindings, tool, args, { result: { id: staged.id, staged: count } });
			return `staged review comment #${staged.id}; staged_count=${count}`;
		},
	);
}

/**
 * Map a unified-diff patch to (RIGHT, LEFT) anchorable line sets.
 *
 * RIGHT = new-file line numbers of added (+) and in-hunk context lines; LEFT =
 * old-file line numbers of deleted (-) and in-hunk context lines. GitHub only
 * anchors review comments inside a hunk; a comment elsewhere 422s the review.
 */
export function diffAnchorableLines(patch: string): [Set<number>, Set<number>] {
	const right = new Set<number>();
	const left = new Set<number>();
	let newLine: number | null = null;
	let oldLine: number | null = null;
	for (const raw of pySplitlines(patch)) {
		const m = DIFF_HUNK_RE.exec(raw);
		if (m) {
			oldLine = Number(m[1]);
			newLine = Number(m[2]);
			continue;
		}
		if (raw.startsWith("\\")) continue;
		// `+++`/`---` are file headers only before the first hunk. Inside a hunk
		// a line's content may start with `++`/`--` and must advance counters.
		if (newLine === null || oldLine === null) continue;
		if (raw.startsWith("+")) {
			right.add(newLine);
			newLine += 1;
		} else if (raw.startsWith("-")) {
			left.add(oldLine);
			oldLine += 1;
		} else {
			right.add(newLine);
			left.add(oldLine);
			newLine += 1;
			oldLine += 1;
		}
	}
	return [right, left];
}

/** Partition staged comments into (anchorable, dropped) by diff hunk membership. */
function filterAnchorableComments(
	staged: readonly StagedReviewComment[],
	files: readonly PullRequestFileInfo[],
): [StagedReviewComment[], StagedReviewComment[]] {
	const byPath = new Map(files.map(f => [f.path, f]));
	const cache = new Map<string, [Set<number>, Set<number>]>();
	const anchorable: StagedReviewComment[] = [];
	const dropped: StagedReviewComment[] = [];
	for (const c of staged) {
		const entry = byPath.get(c.path);
		if (entry === undefined) {
			dropped.push(c); // path not in the PR diff (stale/renamed path)
			continue;
		}
		if (!cache.has(entry.path)) cache.set(entry.path, diffAnchorableLines(entry.patch));
		const [right, left] = cache.get(entry.path)!;
		if (!entry.patch) {
			// Platform omitted the patch (binary file, no-op, API gap) — fail
			// open; a genuine rejection is caught by the 422/500 fallback.
			anchorable.push(c);
			continue;
		}
		const side = String(c.side || "RIGHT").toUpperCase();
		const lines = side === "RIGHT" ? right : left;
		if (c.start_line !== null) {
			const startSide = String(c.start_side || side).toUpperCase();
			if (startSide !== side || c.start_line > c.line) {
				dropped.push(c);
				continue;
			}
			if (!lines.has(c.start_line) || !lines.has(c.line)) {
				dropped.push(c);
				continue;
			}
		} else if (!lines.has(c.line)) {
			dropped.push(c);
			continue;
		}
		anchorable.push(c);
	}
	return [anchorable, dropped];
}

function backendPlatform(github: GitHubBackend): string {
	const platform = (github as { platform?: unknown }).platform;
	return typeof platform === "string" ? platform : "github";
}

function buildSubmitPrReview(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "submit_pr_review";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				body: { type: "string", description: param(tool, "body") },
				event: { type: "string", enum: ["COMMENT"], default: "COMMENT", description: param(tool, "event") },
			},
			required: ["body"],
			additionalProperties: false,
		},
		async args => {
			requireReviewMode(bindings, tool, args);
			const bodyRaw = args.body;
			if (!nonEmptyString(bodyRaw))
				refuseWith(bindings, tool, args, "submit_pr_review requires a non-empty 'body'.");
			const repo = bindings.repo.full_name;
			const prNumber = bindings.defaultCommentNumber;
			const staged = bindings.db.listStagedReviewComments(bindings.issueKey);
			let comments = staged.map(reviewCommentToPayload);
			// commit_id is only needed by Forgejo to anchor inline review comments.
			let commitId: string | null = null;
			if (backendPlatform(bindings.github) === "forgejo") {
				try {
					const pr = await bindings.github.getPullRequest(repo, prNumber);
					commitId = pr.head_sha || null;
				} catch (err) {
					if (!(err instanceof GitHubError)) throw err;
					commitId = null;
				}
			}
			let body = bodyRaw.trim();
			let dropped: StagedReviewComment[] = [];
			if (staged.length > 0) {
				let prFiles: PullRequestFileInfo[] | null = null;
				try {
					prFiles = await bindings.github.listPrFiles(repo, prNumber);
				} catch (err) {
					if (!(err instanceof GitHubError)) throw err;
					// Fail open: submit unfiltered — the 422/500 fallback still
					// catches a bad batch.
					audit(bindings, tool, args, { error: `anchor validation skipped: ${err.status} ${err.detail}` });
				}
				if (prFiles !== null) {
					const [filtered, droppedComments] = filterAnchorableComments(staged, prFiles);
					dropped = droppedComments;
					if (dropped.length > 0) {
						audit(bindings, tool, args, { result: { dropped: dropped.map(c => `${c.path}:${c.line}`) } });
						body += "\n\n## Not anchored to diff";
						for (const c of dropped) body += `\n- **\`${c.path}:${c.line}\`** — ${c.body}`;
						comments = filtered.map(reviewCommentToPayload);
					}
				}
			}
			let review: PullRequestReviewInfo;
			try {
				review = await bindings.github.submitPrReview({
					repo,
					pr_number: prNumber,
					body,
					event: "COMMENT",
					comments,
					commit_id: commitId,
				});
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, tool, args, { error: err.message });
				// 422 = validation rejection (e.g. Forgejo can't anchor inline
				// comments); 500 = Forgejo internal error on the reviews endpoint.
				// Both mean the batch can't land as-is: degrade to visible issue
				// comments so findings still surface and the model doesn't
				// retry-and-simplify its own output.
				if (err.status !== 422 && err.status !== 500) {
					raiseCommand(`GitHub rejected PR review: ${err.status} ${err.detail}`);
				}
				let postedInline = 0;
				try {
					await bindings.github.postComment(repo, prNumber, body);
					for (const comment of staged) {
						await bindings.github.postComment(
							repo,
							prNumber,
							`**\`${comment.path}:${comment.line}\`**\n\n${comment.body}`,
						);
						postedInline += 1;
					}
				} catch (fallbackErr) {
					if (!(fallbackErr instanceof GitHubError)) throw fallbackErr;
					audit(bindings, tool, args, { error: fallbackErr.message });
					raiseCommand(
						`Review rejected (${err.status}) and fallback comment posting failed: ${fallbackErr.status} ${fallbackErr.detail}`,
					);
				}
				const cleared = bindings.db.clearStagedReviewComments(bindings.issueKey);
				audit(bindings, tool, args, {
					result: { fallback: "issue_comments", summary: true, inline: postedInline, cleared },
				});
				return `review rejected (${err.status}); posted summary + ${postedInline} inline comment(s) as issue comments`;
			}
			const cleared = bindings.db.clearStagedReviewComments(bindings.issueKey);
			audit(bindings, tool, args, {
				result: {
					review_id: review.id,
					comments: comments.length,
					dropped: dropped.length,
					cleared,
					event: "COMMENT",
				},
			});
			if (dropped.length > 0) {
				return `submitted PR review id=${review.id}; comments=${comments.length}; dropped=${dropped.length} not anchored to diff`;
			}
			return `submitted PR review id=${review.id}; comments=${comments.length}`;
		},
	);
}

/** Append labels to the originating issue (or PR). */
function buildSetIssueLabels(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "set_issue_labels";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				labels: { type: "array", items: { type: "string" } },
				number: { type: "integer", description: param(tool, "number") },
			},
			required: ["labels"],
			additionalProperties: false,
		},
		async args => {
			if (bindings.inboundIsPr) {
				audit(bindings, tool, args, { result: { skipped: "pr_thread" } });
				return (
					"no-op: set_issue_labels is not applicable on PR threads — PR labels are " +
					"not used for triage. Proceed with the requested change."
				);
			}
			const labels = args.labels;
			if (!Array.isArray(labels) || labels.length === 0) {
				raiseCommand("set_issue_labels requires a non-empty 'labels' array.");
			}
			const cleaned = labels.filter(nonEmptyString).map(l => l.trim());
			if (cleaned.length === 0) raiseCommand("set_issue_labels requires at least one non-empty label.");
			let targetNumber = requireIssue(bindings).number;
			if (pyIsInt(args.number)) targetNumber = pyInt(args.number);
			let applied: string[];
			try {
				applied = await bindings.github.addIssueLabels(bindings.repo.full_name, targetNumber, cleaned);
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, tool, args, { error: err.message });
				raiseCommand(`GitHub rejected labels: ${err.status} ${err.detail}`);
			}
			audit(bindings, tool, args, { result: { labels: [...applied] } });
			return `labels now: ${applied.join(", ")}`;
		},
	);
}

/**
 * Triage step. Pick a primary type, optional priority/functional/provider/
 * platform, apply labels on GitHub, persist the primary type in sqlite, and
 * signal which workflow branch the agent should follow.
 */
function buildClassifyIssue(bindings: ToolBindings): RpcClientCustomTool {
	const tool = "classify_issue";
	return hostTool(
		tool,
		{
			type: "object",
			properties: {
				primary: { type: "string", enum: [...PRIMARY_TYPES], description: param(tool, "primary") },
				priority: { type: "string", enum: [...PRIORITIES], description: param(tool, "priority") },
				functional: {
					type: "array",
					items: { type: "string", enum: [...FUNCTIONAL] },
					description: param(tool, "functional"),
				},
				provider: { type: "string", description: param(tool, "provider") },
				platform: { type: "string", enum: [...PLATFORMS], description: param(tool, "platform") },
				rationale: { type: "string", description: param(tool, "rationale") },
				branch_slug: { type: "string", description: param(tool, "branch_slug") },
			},
			required: ["primary", "rationale"],
			additionalProperties: false,
		},
		async args => {
			const refuse: (msg: string) => never = msg => refuseWith(bindings, tool, args, msg);
			const existing = bindings.db.getIssue(bindings.issueKey);
			if (bindings.inboundIsPr) {
				let note =
					"no-op: classify_issue is not applicable on PR threads. " +
					`Issue #${requireIssue(bindings).number} is already classified`;
				if (existing?.classification) note += ` as ${pyRepr(existing.classification)}`;
				note += ". Proceed with the requested change (amend the branch and push, or post a comment).";
				audit(bindings, tool, args, { result: { skipped: "pr_thread" } });
				return note;
			}
			if (existing?.classification) {
				audit(bindings, tool, args, { result: { skipped: "already_classified" } });
				return (
					`no-op: issue #${requireIssue(bindings).number} is already classified as ` +
					`${pyRepr(existing.classification)}. Continue with that workflow; do not re-classify.`
				);
			}
			const primary = args.primary;
			if (!oneOf(PRIMARY_TYPES, primary)) {
				refuse(`classify_issue 'primary' must be one of ${pyTupleRepr(PRIMARY_TYPES)}; got ${pyRepr(primary)}.`);
			}
			const rationale = args.rationale;
			if (!nonEmptyString(rationale)) refuse("classify_issue requires a one-sentence 'rationale'.");
			let priority = args.priority;
			if (primary === "bug") {
				if (!oneOf(PRIORITIES, priority)) {
					refuse(`classify_issue requires 'priority' in ${pyTupleRepr(PRIORITIES)} when primary=='bug'.`);
				}
			} else {
				// Non-bug primaries: silently drop any priority rather than
				// rejecting — some models treat every property as required and
				// loop forever on a hard error.
				priority = null;
			}
			let branchSlug: string | null = null;
			if (nonEmptyString(args.branch_slug)) {
				try {
					branchSlug = validateBranchSlug(args.branch_slug);
				} catch (err) {
					refuse(`classify_issue rejected branch_slug: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			const labels: string[] = [primary];
			if (primary === "bug" && typeof priority === "string") labels.push(priority);
			for (const fn of pyIterOrEmpty(args.functional)) {
				// Unknown functional tags are dropped silently.
				if (oneOf(FUNCTIONAL, fn)) labels.push(fn);
			}
			const provider = args.provider;
			if (nonEmptyString(provider) && provider.startsWith("provider:")) labels.push("providers", provider);
			if (oneOf(PLATFORMS, args.platform)) labels.push(args.platform);
			labels.push("triaged");

			let renamedTo: string | null = null;
			if (branchSlug) {
				try {
					renamedTo = await hostToolsDeps.renameWorkspaceBranch(bindings.workspace, branchSlug, {
						prNumber: existing?.pr_number ?? null,
						slotUid: bindings.slotUid,
					});
				} catch (err) {
					if (err instanceof GitCommandError) {
						audit(bindings, tool, args, { error: err.message });
						raiseCommand(`classify_issue could not rename branch: ${err.message}`);
					}
					if (err instanceof RangeError) {
						audit(bindings, tool, args, { error: err.message });
						raiseCommand(`classify_issue rejected branch_slug: ${err.message}`);
					}
					throw err;
				}
				if (renamedTo !== bindings.workspace.branch) {
					// renameWorkspaceBranch already mutated workspace.branch on
					// success; purely defensive against a future refactor.
					raiseCommand("classify_issue internal: branch rename inconsistent.");
				}
				bindings.db.setIssueBranch(bindings.issueKey, renamedTo);
			}

			let applied: string[];
			try {
				applied = await bindings.github.addIssueLabels(
					bindings.repo.full_name,
					requireIssue(bindings).number,
					labels,
				);
			} catch (err) {
				if (!(err instanceof GitHubError)) throw err;
				audit(bindings, tool, args, { error: err.message });
				raiseCommand(`GitHub rejected labels: ${err.status} ${err.detail}`);
			}

			bindings.db.setIssueClassification(bindings.issueKey, primary);
			audit(bindings, tool, args, {
				result: { primary, labels: [...applied], rationale, branch: renamedTo },
			});
			// Echo back the workflow the agent should now follow.
			const nextStep = persona.classifyNextStep(primary);
			const suffix = renamedTo ? ` Branch renamed to \`${renamedTo}\`.` : "";
			return `classified as ${primary}; labels applied: ${applied.join(", ")}.${suffix} Next: ${nextStep}.`;
		},
	);
}

/**
 * Return the full set of host tools bound to one task's context.
 *
 * The toolset is intentionally identical across all task kinds so the LLM
 * prompt cache stays warm across triage → follow-up → PR-conversation
 * transitions. Triage tools enforce their own scope at execution time.
 */
export function build(bindings: ToolBindings): RpcClientCustomTool[] {
	return [
		buildClassifyIssue(bindings),
		buildSetIssueLabels(bindings),
		buildFetchPr(bindings),
		buildClassifyPr(bindings),
		buildPrReviewComment(bindings),
		buildSubmitPrReview(bindings),
		buildPostComment(bindings),
		buildPushBranch(bindings),
		buildReleaseCiStatus(bindings),
		buildReleaseJobLog(bindings),
		buildReleaseRetag(bindings),
		buildOpenPr(bindings),
		buildRequestReview(bindings),
		buildReproRecord(bindings),
		buildMarkUnable(bindings),
		buildAbortTask(bindings),
		buildFetchThread(bindings),
		buildSearchIssues(bindings),
		buildSearchCommits(bindings),
	];
}
