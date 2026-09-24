/**
 * Per-task omp RPC driver.
 *
 * `runTask(...)` spins up an omp RPC subprocess for one task, drives the
 * kickoff/follow-up prompt (plus completion/dirty-state reminders), and
 * returns when the agent finishes. Host tools call back into the
 * orchestrator's GitHub client and DB in-process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as cancellation from "./cancellation";
import type { Settings, ThinkingLevel } from "./config";
import { type Database, issueKey } from "./db";
import { type DirtyState, inspectDirtyState, isDirty } from "./git-ops";
import type { GitHubBackend } from "./github-backend";
import type { CommentInfo, IssueInfo, PullRequestInfo, RepoInfo } from "./github-client";
import * as hostTools from "./host-tools";
import { AbortController, type ReleaseToolContext, ToolBindings } from "./host-tools";
import { getLogger } from "./logging";
import { computeKey as nativesComputeKey, type NativesCache } from "./natives-cache";
import {
	groupId,
	type OmpClient,
	type OmpClientOptions,
	type PromptTurn,
	RpcOmpClient,
	RpcProcessExitError,
	type TodoPhase,
} from "./omp-client";
import * as persona from "./persona";
import { chmodFull } from "./posix";
import * as pragmas from "./pragmas";
import { type GitTransport, prepareSlotRuntimeEnv, safeDirectoryEnv, type Workspace } from "./sandbox";
import { currentEuid } from "./subprocess";
import type { DirectiveInfo, ReleaseTaskContext, ThreadMessage } from "./task-types";

export type { DirectiveInfo, ReleaseTaskContext, ThreadMessage };

const log = getLogger("robomp.worker");

/** Common context shared by every task type. */
export interface TaskInputs {
	settings: Settings;
	db: Database;
	github: GitHubBackend;
	gitTransport: GitTransport;
	repo: RepoInfo;
	workspace: Workspace;
	deliveryId: string;
	attempts: number;
	slotUid: number | null;
	nativesCache: NativesCache | null;
	issue: IssueInfo | null;
	release: ReleaseTaskContext | null;
}

export function taskInputs(
	init: Omit<TaskInputs, "attempts" | "slotUid" | "nativesCache" | "issue" | "release"> & Partial<TaskInputs>,
): TaskInputs {
	return { attempts: 0, slotUid: null, nativesCache: null, issue: null, release: null, ...init };
}

/**
 * Return `[modelOverride, thinkingOverride]` for the current directive.
 *
 * `null` means "no override, use the settings default". Aliases that match
 * nothing in the pool / level set are dropped.
 */
export function resolvePragmaOverrides(
	directive: DirectiveInfo | null,
	settings: Settings,
): [string | null, ThinkingLevel | null] {
	if (directive === null || directive.pragmas.length === 0) return [null, null];
	const modelValue = pragmas.pragmaValue(directive.pragmas, "model");
	const thinkingValue = pragmas.pragmaValue(directive.pragmas, "thinking");
	const modelOverride = modelValue ? pragmas.resolveModelAlias(modelValue, settings.model_pool) : null;
	const thinkingOverride = thinkingValue ? pragmas.resolveThinkingLevel(thinkingValue) : null;
	return [modelOverride, thinkingOverride];
}

// Secrets that MUST NOT reach the agent subprocess; an agent with the `bash`
// tool could otherwise `printenv` them out of robomp's env.
const SCRUBBED_ENV_KEYS = ["GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "ROBOMP_REPLAY_TOKEN", "ROBOMP_GH_PROXY_HMAC_KEY"];

/** Runtime HOME locations (test seam: tests point these at tmp dirs). */
export const workerPaths = {
	agentHome: "/srv/agent-home",
	agentHomeStage: "/srv/agent-home-stage",
};

function lexists(p: string): boolean {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Copy late-appearing staged agent config into the runtime HOME. */
export function stageAgentHome(): void {
	const { agentHome, agentHomeStage } = workerPaths;
	if (!fs.existsSync(agentHomeStage)) return;

	for (const rel of [".agent", ".omp/agent"]) {
		const src = path.join(agentHomeStage, rel);
		if (!fs.existsSync(src)) continue;
		const dst = path.join(agentHome, rel);
		try {
			if (lexists(dst)) {
				const st = fs.lstatSync(dst);
				if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(dst, { recursive: true, force: true });
				else fs.unlinkSync(dst);
			}
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			// `shutil.copytree(symlinks=False)`: links are copied as their targets.
			fs.cpSync(src, dst, { recursive: true, force: true, dereference: true });
		} catch (err) {
			log.warning(`Failed to stage agent home path ${rel}: ${errMessage(err)}`);
		}
	}

	if (!fs.existsSync(agentHome)) return;

	const chownToRoot = currentEuid() === 0;
	const normalize = (p: string, mode: number, kind: string): void => {
		try {
			fs.chmodSync(p, mode);
			if (chownToRoot) fs.chownSync(p, 0, 0);
		} catch (err) {
			log.warning(`Failed to normalize agent home ${kind} ${p}: ${errMessage(err)}`);
		}
	};
	const walk = (dir: string): void => {
		normalize(dir, 0o755, "directory");
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = path.join(dir, entry.name);
			// `os.walk` lists a symlink to a directory with the directories
			// (normalized as one, following the link) but never descends it.
			const linkedDir = entry.isSymbolicLink() && isDirectory(child);
			const isDir = entry.isDirectory() || linkedDir;
			// ~/.omp/run is slot-writable daemon presence state, not template
			// config; keep it out of the read-only normalization.
			if (isDir && dir === path.join(agentHome, ".omp") && entry.name === "run") continue;
			if (linkedDir) normalize(child, 0o755, "directory");
			else if (isDir) walk(child);
			else normalize(child, 0o644, "file");
		}
	};
	walk(agentHome);
}

/** Keep `~/.omp/run` writable by every sandbox slot (group omp, setgid 2770). */
export function ensureAgentRunDir(): void {
	if (currentEuid() !== 0) return;
	const runDir = path.join(workerPaths.agentHome, ".omp", "run");
	const gid = groupId("omp");
	if (gid === null) return;
	try {
		fs.mkdirSync(runDir, { recursive: true });
		const walk = (dir: string): void => {
			const st = fs.statSync(dir);
			fs.chownSync(dir, st.uid, gid);
			chmodFull(dir, 0o2770);
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const child = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(child);
					// `os.walk` neither descends nor normalizes a linked directory.
				} else if (!(entry.isSymbolicLink() && isDirectory(child))) {
					fs.chownSync(child, fs.statSync(child).uid, gid);
					fs.chmodSync(child, 0o660);
				}
			}
		};
		walk(runDir);
	} catch (err) {
		log.warning(`Failed to prepare agent run dir ${runDir}: ${errMessage(err)}`);
	}
}

/**
 * Env overlay passed to the omp subprocess: sensitive keys overlaid with empty
 * strings (the client merges this on top of the parent env).
 */
export function buildExtraEnv(_settings: Settings): Record<string, string> {
	stageAgentHome();
	ensureAgentRunDir();
	const env: Record<string, string> = {};
	for (const key of SCRUBBED_ENV_KEYS) env[key] = "";
	// Usage attribution: the gateway forwards this label (x-omp-app).
	env.OMP_APP_NAME = "robomp";
	if (isDirectory(workerPaths.agentHome)) env.HOME = workerPaths.agentHome;
	return env;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

const TERMINAL_TRIAGE_TOOLS = new Set(["gh_open_pr", "mark_unable_to_reproduce", "abort_task"]);
const TERMINAL_REVIEW_TOOLS = new Set(["submit_pr_review", "abort_task"]);
const TERMINAL_RELEASE_TOOLS = new Set(["release_retag", "abort_task"]);
const PR_REQUIRING_CLASSIFICATIONS = new Set(["bug", "documentation"]);

/** Turn timeout (seconds) for a task kind. */
export function taskTimeout(settings: Settings, taskKind: string): number {
	return taskKind === "handle_release_ci" ? settings.release_task_timeout_seconds : settings.task_timeout_seconds;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	for (const item of a) if (b.has(item)) return true;
	return false;
}

/** Minimal bindings slice the driver reads (tests pass a plain object). */
export interface DriverBindings {
	workspace: Workspace;
	issueKey: string;
	abort: AbortController | null;
}

/** True iff a task turn ended before reaching its terminal tool. */
export function needsCompletionReminder(args: {
	taskKind: string;
	inputs: TaskInputs;
	bindings: DriverBindings;
	toolsCalled: ReadonlySet<string>;
}): boolean {
	const { taskKind, inputs, bindings, toolsCalled } = args;
	if (bindings.abort?.triggered) return false;
	if (taskKind === "review_pr") return !intersects(toolsCalled, TERMINAL_REVIEW_TOOLS);
	if (taskKind === "handle_release_ci") return !intersects(toolsCalled, TERMINAL_RELEASE_TOOLS);
	if (taskKind !== "triage_issue") return false;
	const row = inputs.db.getIssue(bindings.issueKey);
	if (row === null || row.classification === null || !PR_REQUIRING_CLASSIFICATIONS.has(row.classification)) {
		return false;
	}
	return !intersects(toolsCalled, TERMINAL_TRIAGE_TOOLS);
}

/** Workspace dirty state; inspection errors count as clean. */
async function probeWorkspaceDirtyImpl(workspace: Workspace, slotUid: number | null): Promise<DirtyState> {
	try {
		return await inspectDirtyState(workspace.repo_dir, { slotUid, safeDirectory: workspace.repo_dir });
	} catch (err) {
		log.debug("workspace dirty probe failed", { error: errMessage(err) });
		return { uncommitted: 0, unpushed: 0, summary: "" };
	}
}

/** Python `threading.Timer`: armed by `start()`, disarmed by `cancel()`. */
export interface Timer {
	readonly interval: number;
	/** Python `Timer.daemon`: a daemon timer never keeps the process alive. */
	daemon: boolean;
	start(): void;
	cancel(): void;
}

class TimeoutTimer implements Timer {
	daemon = false;
	#handle: NodeJS.Timeout | null = null;
	constructor(
		readonly interval: number,
		readonly fn: () => void,
	) {}
	start(): void {
		this.#handle = setTimeout(this.fn, this.interval * 1000);
		if (this.daemon) this.#handle.unref();
	}
	cancel(): void {
		if (this.#handle !== null) clearTimeout(this.#handle);
		this.#handle = null;
	}
}

/** Test seams (Python module-level monkeypatch targets). */
export const workerDeps = {
	createClient: (options: OmpClientOptions): OmpClient => new RpcOmpClient(options),
	/** Python `threading.Timer(interval, fn)`; `interval` in seconds. */
	createTimer: (interval: number, fn: () => void): Timer => new TimeoutTimer(interval, fn),
	probeWorkspaceDirty: probeWorkspaceDirtyImpl,
	nativesComputeKey: (repoDir: string): Promise<string> => nativesComputeKey(repoDir),
};

/**
 * Run the initial prompt and, if the agent stopped early, send reminders.
 *
 * Returns the final turn, or `null` when the agent pulled the plug via
 * `abort_task`.
 */
export async function driveTurn(
	client: OmpClient,
	initialPrompt: string,
	args: { taskKind: string; inputs: TaskInputs; bindings: DriverBindings; toolsCalled: Set<string> },
): Promise<PromptTurn | null> {
	const { taskKind, inputs, bindings, toolsCalled } = args;
	const settings = inputs.settings;
	const maxReminders = settings.task_completion_max_reminders;

	const runPrompt = async (prompt: string): Promise<PromptTurn | null> => {
		try {
			return await client.promptAndWait(prompt, taskTimeout(settings, taskKind));
		} catch (err) {
			// Intentional `abort_task` teardown is a clean exit, not a failure.
			if (bindings.abort?.triggered) {
				log.info("rpc_aborted_by_tool", {
					issue: bindings.issueKey,
					task: taskKind,
					reason: bindings.abort.reason,
				});
				return null;
			}
			throw err;
		}
	};

	let turn = await runPrompt(initialPrompt);
	if (turn === null) return null;

	let remindersUsed = 0;
	while (remindersUsed < maxReminders) {
		const needsCompletion = needsCompletionReminder({ taskKind, inputs, bindings, toolsCalled });
		let dirty: DirtyState | null = null;
		if (!needsCompletion) {
			if (taskKind === "review_pr") break;
			dirty = await workerDeps.probeWorkspaceDirty(inputs.workspace, inputs.slotUid);
			if (!isDirty(dirty)) break;
		}
		remindersUsed += 1;
		let reminder: string;
		if (needsCompletion) {
			log.warning("rpc_completion_reminder", {
				issue: bindings.issueKey,
				task: taskKind,
				attempt: remindersUsed,
				max: maxReminders,
			});
			if (taskKind === "handle_release_ci") {
				reminder = persona.followupRelease({
					repo: inputs.repo,
					release: inputs.release!,
					workspace: inputs.workspace,
				});
			} else if (taskKind === "review_pr") {
				reminder = persona.reviewCompletionReminder({
					repo: inputs.repo,
					issue: inputs.issue!,
					workspace: inputs.workspace,
				});
			} else {
				reminder = persona.completionReminder({
					repo: inputs.repo,
					issue: inputs.issue!,
					workspace: inputs.workspace,
				});
			}
		} else {
			log.warning("rpc_dirty_state_reminder", {
				issue: bindings.issueKey,
				task: taskKind,
				attempt: remindersUsed,
				max: maxReminders,
				uncommitted: dirty!.uncommitted,
				unpushed: dirty!.unpushed,
			});
			if (taskKind === "handle_release_ci") {
				reminder = persona.followupRelease({
					repo: inputs.repo,
					release: inputs.release!,
					workspace: inputs.workspace,
				});
			} else {
				reminder = persona.dirtyStateReminder({
					repo: inputs.repo,
					issue: inputs.issue!,
					workspace: inputs.workspace,
					dirty: dirty!,
				});
			}
		}
		const nextTurn = await runPrompt(reminder);
		if (nextTurn === null) return null;
		turn = nextTurn;
	}

	if (remindersUsed > 0 && needsCompletionReminder({ taskKind, inputs, bindings, toolsCalled })) {
		log.warning("rpc_completion_unfinished", {
			issue: bindings.issueKey,
			task: taskKind,
			reminders: remindersUsed,
			tools_called: [...toolsCalled].sort(),
		});
	}
	if (remindersUsed > 0 && taskKind !== "review_pr") {
		const finalDirty = await workerDeps.probeWorkspaceDirty(inputs.workspace, inputs.slotUid);
		if (isDirty(finalDirty)) {
			log.warning("rpc_dirty_state_unfinished", {
				issue: bindings.issueKey,
				task: taskKind,
				reminders: remindersUsed,
				uncommitted: finalDirty.uncommitted,
				unpushed: finalDirty.unpushed,
			});
		}
	}
	return turn;
}

/** True iff `sessionDir` already contains an omp JSONL transcript (`--continue` resumes it). */
export function hasPriorSession(sessionDir: string): boolean {
	try {
		return fs.readdirSync(sessionDir).some(name => name.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

export interface PromptArgs {
	comment?: CommentInfo | null;
	prNumber?: number | null;
	reviewPayload?: Record<string, unknown> | null;
	pr?: PullRequestInfo | null;
	directive?: DirectiveInfo | null;
	thread?: readonly ThreadMessage[];
	resuming?: boolean;
}

export function buildPrompt(taskKind: string, inputs: TaskInputs, args: PromptArgs = {}): string {
	const { comment = null, prNumber = null, reviewPayload = null, pr = null, directive = null } = args;
	const thread = args.thread ?? [];
	const resuming = args.resuming ?? false;
	if (taskKind === "handle_release_ci") {
		const renderer = resuming ? persona.followupRelease : persona.kickoffRelease;
		return renderer({ repo: inputs.repo, release: inputs.release!, workspace: inputs.workspace });
	}
	if (taskKind === "triage_issue") {
		const issue = inputs.issue!;
		if (resuming) return persona.resumeTriage({ repo: inputs.repo, issue, workspace: inputs.workspace });
		if (directive !== null) {
			return persona.kickoffDirective({ repo: inputs.repo, issue, workspace: inputs.workspace, directive });
		}
		return persona.kickoff({ repo: inputs.repo, issue, workspace: inputs.workspace });
	}
	if (taskKind === "review_pr") {
		return persona.kickoffPrReview({ repo: inputs.repo, pr: pr!, workspace: inputs.workspace });
	}
	if (taskKind === "handle_comment") {
		const issue = inputs.issue!;
		const issueRow = inputs.db.getIssue(issueKey(inputs.repo.full_name, issue.number));
		let prStatus: string;
		if (issueRow === null || issueRow.pr_number === null) prStatus = "no PR opened yet";
		else if (issueRow.state === "merged") prStatus = `PR #${issueRow.pr_number} was merged`;
		else if (issueRow.state === "closed" || issueRow.state === "abandoned") {
			prStatus = `PR #${issueRow.pr_number} was closed without merge`;
		} else prStatus = `PR #${issueRow.pr_number} is open`;
		if (directive !== null) {
			return persona.directive({
				repo: inputs.repo,
				issue,
				workspace: inputs.workspace,
				comment: comment!,
				directive,
				prStatus,
				prNumber,
			});
		}
		return persona.followupComment({
			repo: inputs.repo,
			issue,
			workspace: inputs.workspace,
			comment: comment!,
			prStatus,
			prNumber,
			thread,
		});
	}
	if (taskKind === "handle_review") {
		const payload = reviewPayload!;
		const filePath = String(payload.path || "");
		const start = payload.start_line || payload.line;
		const end = payload.line || payload.original_line;
		let lineRange: string;
		if (Number.isInteger(start) && Number.isInteger(end) && start !== end) lineRange = `:L${start}-L${end}`;
		else if (Number.isInteger(end)) lineRange = `:L${end}`;
		else lineRange = "";
		return persona.followupReview({
			repo: inputs.repo,
			workspace: inputs.workspace,
			prNumber: Number(prNumber || 0),
			commentAuthor: String(payload.author || ""),
			commentBody: String(payload.body || ""),
			commentPath: filePath,
			commentLineRange: lineRange,
		});
	}
	throw new RangeError(`unknown task kind: '${taskKind}'`);
}

function gitIdentityEnv(authorName: string, authorEmail: string): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: authorName,
		GIT_AUTHOR_EMAIL: authorEmail,
		GIT_COMMITTER_NAME: authorName,
		GIT_COMMITTER_EMAIL: authorEmail,
	};
}

/** Seed phases → server todo shape (every task starts `pending`). */
function toTodoPhases(phases: persona.TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(content => ({ content, status: "pending" })),
	}));
}

/** Run a full RPC session for one task. Returns the final assistant text (or null). */
export async function runRpc(
	inputs: TaskInputs,
	args: { taskKind: string; prompt: string; bindings: ToolBindings; directive?: DirectiveInfo | null },
): Promise<string | null> {
	const { taskKind, prompt, bindings } = args;
	const directive = args.directive ?? null;
	const settings = inputs.settings;
	const toolsCalled = new Set<string>();

	const rpcEnv = buildExtraEnv(settings);
	Object.assign(rpcEnv, prepareSlotRuntimeEnv(inputs.workspace));
	Object.assign(rpcEnv, safeDirectoryEnv(bindings.workspace.repo_dir));
	Object.assign(rpcEnv, gitIdentityEnv(settings.resolved_author_name, settings.git_author_email));
	// Bare worktrees have no node_modules; install (idempotently) so the agent
	// can resolve workspace packages and actually run tests.
	await hostTools.ensureWorkspaceDependencies(bindings);
	const resuming = hasPriorSession(bindings.workspace.session_dir);
	const extraArgs = resuming ? ["--continue"] : [];
	log.info("rpc_resume", {
		issue: bindings.issueKey,
		task: taskKind,
		resuming,
		session_dir: bindings.workspace.session_dir,
		attempts: inputs.attempts,
	});
	const [modelOverride, thinkingOverride] = resolvePragmaOverrides(directive, settings);
	const chosenModel =
		modelOverride ?? (taskKind === "handle_release_ci" ? settings.pickReleaseModel() : settings.pickModel());
	const chosenThinking = thinkingOverride ?? settings.thinking_level;
	log.info("rpc_model_pick", {
		issue: bindings.issueKey,
		model: chosenModel,
		pool: [...(taskKind === "handle_release_ci" ? settings.release_model_pool : settings.model_pool)],
		thinking: chosenThinking,
		pragma_model: modelOverride,
		pragma_thinking: thinkingOverride,
	});
	inputs.db.setEventModel(inputs.deliveryId, chosenModel);
	let appendSystemPrompt: string;
	if (taskKind === "handle_release_ci") {
		appendSystemPrompt = persona.systemAppendRelease({
			repo: inputs.repo,
			release: inputs.release!,
			workspace: inputs.workspace,
			releaseCommitPrefix: settings.release_commit_prefix,
		});
	} else if (taskKind === "review_pr") {
		appendSystemPrompt = persona.systemAppendPrReview({
			repo: inputs.repo,
			issue: inputs.issue!,
			workspace: inputs.workspace,
			botLogin: settings.bot_login,
		});
	} else {
		appendSystemPrompt = persona.systemAppend({
			repo: inputs.repo,
			issue: inputs.issue!,
			workspace: inputs.workspace,
			botLogin: settings.bot_login,
		});
	}

	const client = workerDeps.createClient({
		executable: settings.omp_command,
		cwd: bindings.workspace.repo_dir,
		sessionDir: bindings.workspace.session_dir,
		env: rpcEnv,
		noTitle: true,
		model: chosenModel,
		provider: settings.provider,
		thinking: chosenThinking !== "off" ? chosenThinking : null,
		appendSystemPrompt,
		customTools: hostTools.build(bindings),
		requestTimeout: settings.request_timeout_seconds,
		startupTimeout: 60,
		extraArgs,
		user: inputs.slotUid,
		group: inputs.slotUid,
		extraGroups: inputs.slotUid !== null ? ["omp"] : null,
	});
	await client.start();
	try {
		// From here the API can kill the omp subprocess under us; `markClosed`
		// rejects the in-flight prompt immediately instead of waiting out the
		// request timeout.
		const cancelHook = (): void => {
			try {
				client.stop().catch(err => log.exception("omp client stop failed", err, { issue: bindings.issueKey }));
			} finally {
				client.markClosed(new RpcProcessExitError("cancelled by operator"));
			}
		};
		if (bindings.abort !== null) bindings.abort.stop = cancelHook;
		cancellation.registerCancelHook(cancelHook);
		try {
			client.installHeadlessUi();
			client.onToolExecutionEnd(event => {
				// A failed execution does not count as reaching the terminal
				// action — a rejected submit must still trigger the reminder.
				const ok = event.result !== null && event.result !== undefined && !event.isError;
				if (ok) toolsCalled.add(event.toolName);
				log.info("tool_end", { issue: bindings.issueKey, tool: event.toolName, ok });
			});
			client.onMessageUpdate(event => {
				if (event.type !== "message_update") return;
				const ev = event.assistantMessageEvent as { type?: string; delta?: unknown };
				if (ev.type === "text_delta") {
					log.debug("delta", { issue: bindings.issueKey, delta: String(ev.delta ?? "").slice(0, 200) });
				}
			});

			const phases = toTodoPhases(persona.seedPhases(taskKind));
			if (phases.length > 0) {
				try {
					if ((taskKind === "triage_issue" || taskKind === "review_pr") && !resuming) {
						// Fresh kickoff tasks seed the full plan.
						await client.setTodos(phases);
					} else if (taskKind === "triage_issue" || taskKind === "review_pr") {
						// Resumed kickoff tasks keep prior todo state from the
						// transcript; re-seeding would clobber progress.
						log.info("set_todos skipped (resume)", { issue: bindings.issueKey, task: taskKind });
					} else {
						// Follow-up: keep prior phases and append the follow-up phase.
						const existing = await client.getTodos();
						await client.setTodos([...existing, ...phases]);
					}
				} catch (err) {
					log.warning("set_todos failed", { err: errMessage(err) });
				}
			}

			log.info("rpc_start", { issue: bindings.issueKey, task: taskKind, branch: bindings.workspace.branch });
			const hardTimeoutSeconds = taskTimeout(settings, taskKind) + settings.task_timeout_hard_grace_seconds;
			let hardTimeoutFired = false;
			const hardTimer = workerDeps.createTimer(hardTimeoutSeconds, () => {
				hardTimeoutFired = true;
				log.warning("rpc_hard_timeout", { issue: bindings.issueKey, task: taskKind, timeout: hardTimeoutSeconds });
				try {
					cancelHook();
				} catch (err) {
					log.exception("rpc hard timeout stop failed", err, { issue: bindings.issueKey, task: taskKind });
				}
			});
			hardTimer.daemon = true;
			hardTimer.start();
			let turn: PromptTurn | null;
			try {
				// A prompt the hard timeout killed rejects with the client's
				// closed error, which propagates as-is (Python parity).
				turn = await driveTurn(client, prompt, { taskKind, inputs, bindings, toolsCalled });
				if (turn === null) return null;
			} finally {
				hardTimer.cancel();
			}
			if (hardTimeoutFired) throw new HardTimeoutError("omp task exceeded hard timeout");
			if (turn.assistantMessage !== null && turn.assistantMessage.stopReason === "error") {
				const errorMsg = turn.assistantMessage.errorMessage || "model returned error";
				throw new Error(`omp agent error (stopReason=error): ${errorMsg}`);
			}
			log.info("rpc_done", {
				issue: bindings.issueKey,
				task: taskKind,
				messages: turn.messages.length,
				events: turn.events.length,
			});
			return turn.assistantText;
		} finally {
			cancellation.unregisterCancelHook();
		}
	} finally {
		await client.close();
	}
}

/** Python `TimeoutError("omp task exceeded hard timeout")`. */
export class HardTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

export interface RunTaskArgs {
	taskKind: string;
	inputs: TaskInputs;
	comment?: CommentInfo | null;
	prNumber?: number | null;
	reviewPayload?: Record<string, unknown> | null;
	pr?: PullRequestInfo | null;
	directive?: DirectiveInfo | null;
	thread?: readonly ThreadMessage[];
}

/** Seams for `runTask` (Python monkeypatches `_build_prompt` / `_run_rpc_blocking`). */
export const runTaskDeps = {
	buildPrompt,
	runRpc,
};

/** Drive one task end to end; on success captures fresh natives into the cache. */
export async function runTask(args: RunTaskArgs): Promise<string | null> {
	const { taskKind, inputs } = args;
	const prNumber = args.prNumber ?? null;
	const directive = args.directive ?? null;
	const reviewMode = taskKind === "review_pr" || inputs.workspace.branch.startsWith("review/pr-");
	let releaseBinding: ReleaseToolContext | null = null;
	if (inputs.release !== null) {
		const releaseKey = `${inputs.repo.full_name}#${inputs.release.tag}`;
		const releaseRow = inputs.db.getRelease(releaseKey);
		if (releaseRow === null) throw new Error(`release state missing for ${releaseKey}`);
		releaseBinding = {
			repo: inputs.repo.full_name,
			tag: inputs.release.tag,
			version: inputs.release.version,
			key: releaseKey,
			expected_sha: releaseRow.current_sha,
			default_branch: inputs.release.default_branch,
		};
	}
	const bindings = new ToolBindings({
		db: inputs.db,
		github: inputs.github,
		gitTransport: inputs.gitTransport,
		repo: inputs.repo,
		issue: inputs.issue,
		workspace: inputs.workspace,
		settings: inputs.settings,
		authorName: inputs.settings.resolved_author_name,
		authorEmail: inputs.settings.git_author_email,
		inboundThreadNumber: prNumber,
		inboundIsPr: prNumber !== null,
		reviewMode,
		implAuthorized: directive?.authorizes_impl ?? false,
		slotUid: inputs.slotUid,
		abort: new AbortController(),
		release: releaseBinding,
	});
	const resuming = hasPriorSession(inputs.workspace.session_dir);
	const prompt = runTaskDeps.buildPrompt(taskKind, inputs, {
		comment: args.comment ?? null,
		prNumber,
		reviewPayload: args.reviewPayload ?? null,
		pr: args.pr ?? null,
		directive,
		thread: args.thread ?? [],
		resuming,
	});
	// A failed/aborted task NEVER captures: its artifacts may be inconsistent
	// with the source state and would poison the cache.
	const result = await runTaskDeps.runRpc(inputs, { taskKind, prompt, bindings, directive });
	await captureNativesCache(inputs);
	return result;
}

/**
 * Best-effort: store the workspace's fresh natives under its current key.
 * ANY failure is logged and swallowed — cache errors NEVER fail a task.
 */
export async function captureNativesCache(inputs: TaskInputs): Promise<void> {
	const cache = inputs.nativesCache;
	if (cache === null) return;
	const workspace = inputs.workspace;
	const nativeDir = path.join(workspace.repo_dir, "packages", "natives", "native");
	if (!fs.existsSync(nativeDir)) return;
	let key: string;
	try {
		key = await workerDeps.nativesComputeKey(workspace.repo_dir);
	} catch (err) {
		log.debug("natives_cache capture key compute failed", {
			workspace: workspace.workspace_key,
			err: errMessage(err),
		});
		return;
	}
	let stored: string | null;
	try {
		stored = await cache.capture(workspace.repo_full_name, key, nativeDir, {
			sourceWorkspace: workspace.workspace_key,
		});
	} catch (err) {
		log.warning("natives_cache capture failed", { workspace: workspace.workspace_key, key, err: errMessage(err) });
		return;
	}
	log.info("natives_cache", {
		action: stored !== null ? "stored" : "skip",
		workspace: workspace.workspace_key,
		repo: workspace.repo_full_name,
		key,
		cache_dir: stored,
	});
}
