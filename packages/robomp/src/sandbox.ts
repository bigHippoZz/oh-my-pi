/**
 * Per-issue workspace lifecycle: clone pool + git worktrees.
 *
 * Remote-facing git operations (clone, fetch, push) go through a pluggable
 * `GitTransport` so a deploy can keep the PAT entirely in a separate gh-proxy
 * container. Per-issue worktree add/remove stays local.
 *
 * Permission model (four ownership zones; see the Python module docstring):
 * 1. Workspace tree (`/data/workspaces/<key>/`): single-owner, the active slot
 *    UID/GID (`omp-N`) or the orchestrator itself; modes `u=rwX,g=rwX,o=`.
 * 2. Clone pool (`/data/workspaces/_pool/<owner>__<repo>/`): `root:omp` setgid
 *    `02770`; cross-slot writes bridged by `shareGitMetadataWithSlots`.
 * 3. Language tool caches (`/data/cache/*`): `root:omp` setgid, provisioned
 *    by the entrypoint.
 * 4. Agent HOME template (`/srv/agent-home`): read-only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	GitCommandError,
	type PushResult,
	redactCredentials,
	clone as gitClone,
	fetchPrHead as gitFetchPrHead,
	fetchPrune as gitFetchPrune,
	fetchRef as gitFetchRef,
	push as gitPush,
	pushRelease as gitPushRelease,
} from "./git-ops";
import { getLogger } from "./logging";
import { chmodFull } from "./posix";
import { type CacheHit, computeKey as nativesComputeKey, type NativesCache } from "./natives-cache";
import {
	type CompletedProcess,
	currentEgid,
	currentEuid,
	platformInfo,
	processEnv,
	type RunOptions,
	runProcess,
	SHARED_OMP_GID,
	slotIdentity,
	slotPermissionsActive,
} from "./subprocess";

const log = getLogger("robomp.sandbox");

/** Resolved per-issue scratch space. */
export class Workspace {
	constructor(
		public root: string,
		public repo_dir: string,
		public session_dir: string,
		public context_dir: string,
		public artifacts_dir: string,
		public branch: string,
		public repo_full_name: string,
		public issue_number: number | string,
	) {}

	get repro_dir(): string {
		return path.join(this.context_dir, "repro");
	}

	get workspace_key(): string {
		return workspaceKey(this.repo_full_name, this.issue_number);
	}
}

function slug(text: string, length = 40): string {
	let cleaned = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!cleaned) cleaned = "issue";
	return cleaned.slice(0, length);
}

function shortHex(seed?: string | null): string {
	if (seed) return new Bun.CryptoHasher("sha1").update(seed).digest("hex").slice(0, 8);
	return crypto.getRandomValues(new Uint8Array(4)).toHex();
}

export function workspaceKey(repo: string, number: number | string): string {
	return `${repo.replaceAll("/", "__")}__${number}`;
}

/** Git config env overlay whitelisting `repoDir` as safe. */
export function safeDirectoryEnv(repoDir: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "safe.directory",
		GIT_CONFIG_VALUE_0: repoDir,
	};
}

export function gitEnvForRepo(repoDir: string): Record<string, string> {
	return { ...processEnv(), ...safeDirectoryEnv(repoDir), GIT_TERMINAL_PROMPT: "0" };
}

export function makeBranch(args: { issueNumber: number; title: string; seed?: string | null }): string {
	return `farm/${shortHex(args.seed || `${args.issueNumber}-${args.title}`)}/${slug(args.title || `issue-${args.issueNumber}`)}`;
}

const BRANCH_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Return `slug` if it is a valid kebab-case branch slug (1-50 chars), else throw. */
export function validateBranchSlug(value: unknown): string {
	if (typeof value !== "string" || !BRANCH_SLUG_RE.test(value) || value.length > 50) {
		throw new RangeError(
			`invalid branch slug ${pyRepr(value)}: expected kebab-case [a-z0-9-], 1-50 chars, no leading/trailing/double hyphen`,
		);
	}
	return value;
}

/** Python-ish `repr()` for error messages. */
export function pyRepr(value: unknown): string {
	if (typeof value === "string") return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
	if (value === null || value === undefined) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Rename the workspace's local branch to `farm/<hex>/<newSlug>`.
 *
 * No-op when an open PR already tracks the branch (`prNumber` non-null) or
 * when the computed name already matches. Mutates `workspace.branch`.
 */
export async function renameWorkspaceBranch(
	workspace: Workspace,
	newSlug: string,
	options: { prNumber?: number | null; slotUid?: number | null } = {},
): Promise<string> {
	validateBranchSlug(newSlug);
	const parts = splitN(workspace.branch, "/", 2);
	if (parts.length !== 3 || parts[0] !== "farm" || !parts[1]) {
		throw new RangeError(`refusing to rename non-farm branch ${pyRepr(workspace.branch)}`);
	}
	const newBranch = `farm/${parts[1]}/${newSlug}`;
	if (newBranch === workspace.branch) return newBranch;
	if (options.prNumber !== undefined && options.prNumber !== null) {
		log.warning(
			`rename_workspace_branch skipped: PR #${options.prNumber} already tracks ${pyRepr(workspace.branch)}; refusing to rename to ${pyRepr(newBranch)}`,
		);
		return workspace.branch;
	}
	const cmd = ["git", "branch", "-m", workspace.branch, newBranch];
	const proc = await sandboxDeps.safeRun(cmd, {
		cwd: workspace.repo_dir,
		env: sandboxDeps.gitEnvForRepo(workspace.repo_dir),
		identity: slotIdentity(options.slotUid),
	});
	if (proc.returncode !== 0) throw new GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr);
	sandboxDeps.shareGitMetadataWithSlots(workspace.repo_dir, options.slotUid ?? null);
	workspace.branch = newBranch;
	return newBranch;
}

/** Python `str.split(sep, maxsplit)`. */
export function splitN(text: string, sep: string, maxSplit: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (out.length < maxSplit) {
		const idx = rest.indexOf(sep);
		if (idx < 0) break;
		out.push(rest.slice(0, idx));
		rest = rest.slice(idx + sep.length);
	}
	out.push(rest);
	return out;
}

// ---------- GitTransport ----------

/** Pluggable remote-facing git operations. */
export interface GitTransport {
	clonePool(args: { repo: string; cloneUrl: string; defaultBranch: string; target: string }): Promise<void>;
	fetchPool(args: { repo: string; poolDir: string }): Promise<void>;
	fetchBaseRef(args: { repo: string; poolDir: string; ref: string }): Promise<void>;
	fetchPrHead(args: { repo: string; poolDir: string; prNumber: number }): Promise<void>;
	pushBranch(args: {
		repo: string;
		workspaceKey: string;
		repoDir: string;
		branch: string;
		expectedHead: string;
		slotUid?: number | null;
	}): Promise<PushResult>;
	pushRelease(args: {
		repo: string;
		workspaceKey: string;
		repoDir: string;
		branch: string;
		tag: string;
		expectedHead: string;
		slotUid?: number | null;
	}): Promise<PushResult>;
}

/** Default GitTransport: run git in-process with ephemeral PAT injection. */
export class LocalGitTransport implements GitTransport {
	readonly #token: string | null;
	constructor(token: string | null) {
		this.#token = token;
	}
	async clonePool(args: { cloneUrl: string; defaultBranch: string; target: string }): Promise<void> {
		await gitClone(args.target, { cloneUrl: args.cloneUrl, defaultBranch: args.defaultBranch, token: this.#token });
	}
	async fetchPool(args: { poolDir: string }): Promise<void> {
		await gitFetchPrune(args.poolDir, { token: this.#token });
	}
	async fetchBaseRef(args: { poolDir: string; ref: string }): Promise<void> {
		await gitFetchRef(args.poolDir, args.ref, { token: this.#token });
	}
	async fetchPrHead(args: { poolDir: string; prNumber: number }): Promise<void> {
		await gitFetchPrHead(args.poolDir, args.prNumber, { token: this.#token });
	}
	pushBranch(args: {
		repoDir: string;
		branch: string;
		expectedHead: string;
		slotUid?: number | null;
	}): Promise<PushResult> {
		return gitPush(args.repoDir, {
			branch: args.branch,
			expectedHead: args.expectedHead,
			token: this.#token,
			slotUid: args.slotUid,
		});
	}
	pushRelease(args: {
		repoDir: string;
		branch: string;
		tag: string;
		expectedHead: string;
		slotUid?: number | null;
	}): Promise<PushResult> {
		return gitPushRelease(args.repoDir, {
			branch: args.branch,
			tag: args.tag,
			expectedHead: args.expectedHead,
			token: this.#token,
			slotUid: args.slotUid,
		});
	}
}

// ---------- low-level helpers ----------

export const DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT = 120;

/** Run without raising; caller decides on returncode. Output is credential-redacted. */
export async function safeRun(cmd: readonly string[], options: RunOptions = {}): Promise<CompletedProcess> {
	const timeout = options.timeout === undefined ? DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT : options.timeout;
	const proc = await runProcess(cmd, { ...options, timeout });
	if (proc.timedOut) {
		return {
			...proc,
			returncode: 124,
			stdout: redactCredentials(proc.stdout),
			stderr: `${redactCredentials(proc.stderr)}\ntimed out after ${(timeout ?? 0).toFixed(0)}s`,
		};
	}
	return { ...proc, stdout: redactCredentials(proc.stdout), stderr: redactCredentials(proc.stderr) };
}

/** Raising helper; timeout surfaces as `GitCommandError` 124. */
export async function run(
	cmd: readonly string[],
	options: { cwd?: string | null; timeout?: number | null } = {},
): Promise<CompletedProcess> {
	const timeout = options.timeout === undefined ? DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT : options.timeout;
	const proc = await runProcess(cmd, { cwd: options.cwd, timeout });
	if (proc.timedOut) throw new GitCommandError(cmd, 124, "", `git timed out after ${(timeout ?? 0).toFixed(0)}s`);
	if (proc.returncode !== 0) throw new GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr);
	return proc;
}

/** Run `git worktree add`, cleaning partial state on failure. */
export async function worktreeAdd(addCmd: readonly string[], pool: string, repoDir: string): Promise<void> {
	try {
		await sandboxDeps.run(addCmd, { cwd: pool });
	} catch (addErr) {
		if (!(addErr instanceof GitCommandError)) throw addErr;
		fs.rmSync(repoDir, { recursive: true, force: true });
		const pruned = await sandboxDeps.safeRun(["git", "worktree", "prune"], { cwd: pool });
		if (pruned.returncode !== 0) {
			throw new GitCommandError(["git", "worktree", "prune"], pruned.returncode, pruned.stdout, pruned.stderr, {
				cause: addErr,
			});
		}
		throw addErr;
	}
}

/** Non-zombie process ids owned by the slot UID (reads `/proc`). */
export function slotPids(slotUid: number, procRoot = "/proc"): number[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(procRoot);
	} catch (err) {
		log.warning(`failed to scan ${procRoot} for slot user ${slotUid}: ${err}`);
		return [];
	}
	const pids: number[] = [];
	for (const name of entries) {
		if (!/^\d+$/.test(name)) continue;
		let status: string;
		try {
			status = fs.readFileSync(path.join(procRoot, name, "status"), "utf-8");
		} catch {
			continue;
		}
		let state = "";
		let uids: number[] = [];
		for (const line of status.split(/\r?\n/)) {
			if (line.startsWith("State:")) {
				state = line.slice("State:".length).trim();
			} else if (line.startsWith("Uid:")) {
				const parsed = line.split(/\s+/).slice(1, 5).map(Number);
				uids = parsed.some(Number.isNaN) ? [] : parsed;
			}
		}
		if (state.startsWith("Z")) continue;
		if (uids.includes(slotUid)) pids.push(Number(name));
	}
	return pids;
}

/** Kill any processes still running as a slot UID. */
export function reapSlot(slotUid: number | null | undefined): void {
	if (!slotPermissionsActive(slotUid)) return;
	for (const pid of sandboxDeps.slotPids(slotUid)) {
		try {
			sandboxDeps.kill(pid, "SIGKILL");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") continue;
			log.warning(`failed to kill slot user ${slotUid} process ${pid}: ${err}`);
		}
	}
}

function lstatOrNull(p: string): fs.Stats | null {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
}

/** Per-workspace tmpdir path, idempotently provisioned (symlink-safe). */
export function prepareSlotTmpdir(workspace: Workspace): string {
	const tmpdir = path.join(workspace.root, ".omp-tmp");
	const st = lstatOrNull(tmpdir);
	if (st && !st.isDirectory()) fs.unlinkSync(tmpdir);
	fs.mkdirSync(tmpdir, { recursive: true, mode: 0o700 });
	return tmpdir;
}

/** Env overlay (TMPDIR + XDG_*) for slot-side subprocesses. */
export function prepareSlotRuntimeEnv(workspace: Workspace): Record<string, string> {
	const tmpdir = prepareSlotTmpdir(workspace);
	const xdgRoot = path.join(workspace.root, ".omp-xdg");
	const xdgData = path.join(xdgRoot, "data");
	const xdgState = path.join(xdgRoot, "state");
	const xdgCache = path.join(xdgRoot, "cache");
	const bunCache = path.join(xdgCache, "bun-install");
	for (const base of [xdgData, xdgState, xdgCache]) fs.mkdirSync(path.join(base, "omp"), { recursive: true });
	fs.mkdirSync(bunCache, { recursive: true });
	return {
		TMPDIR: tmpdir,
		TMP: tmpdir,
		TEMP: tmpdir,
		XDG_DATA_HOME: xdgData,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		BUN_INSTALL_CACHE_DIR: bunCache,
	};
}

/** Create the runtime dirs that `chownWorkspace` will hand to the slot. */
export function provisionRuntimeDirs(wsRoot: string): void {
	const tmpdir = path.join(wsRoot, ".omp-tmp");
	const st = lstatOrNull(tmpdir);
	if (st && !st.isDirectory()) fs.unlinkSync(tmpdir);
	fs.mkdirSync(tmpdir, { recursive: true, mode: 0o700 });
	const xdgRoot = path.join(wsRoot, ".omp-xdg");
	for (const sub of ["data", "state", "cache"]) fs.mkdirSync(path.join(xdgRoot, sub, "omp"), { recursive: true });
	fs.mkdirSync(path.join(xdgRoot, "cache", "bun-install"), { recursive: true });
}

const S_IRWXG = 0o070;
const S_ISGID = 0o2000;
const S_IRGRP = 0o040;
const S_IWGRP = 0o020;

function grantGroupBits(p: string, gid: number, bits: number): void {
	const st = lstatOrNull(p);
	if (!st || st.isSymbolicLink()) return;
	// Keep the owner: Bun's chownSync does not honor the `-1` "unchanged" sentinel.
	fs.chownSync(p, st.uid, gid);
	chmodFull(p, (st.mode & 0o7777) | bits);
}

function grantTree(p: string, gid: number, filesGroupWritable: boolean): void {
	if (!fs.existsSync(p)) return;
	const fileBits = S_IRGRP | (filesGroupWritable ? S_IWGRP : 0);
	if (fs.statSync(p).isFile()) {
		grantGroupBits(p, gid, fileBits);
		return;
	}
	const stack = [p];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		grantGroupBits(dir, gid, S_IRWXG | S_ISGID);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (!entry.isSymbolicLink()) {
				grantGroupBits(full, gid, fileBits);
			}
		}
	}
}

export function resolveWorktreeGitDirs(repoDir: string): [string, string] | null {
	const marker = path.join(repoDir, ".git");
	try {
		if (fs.statSync(marker).isDirectory()) return [marker, marker];
	} catch {}
	let text: string;
	try {
		text = fs.readFileSync(marker, "utf-8").trim();
	} catch {
		return null;
	}
	if (!text.startsWith("gitdir:")) return null;
	const raw = text.slice("gitdir:".length).trim();
	const gitDir = path.isAbsolute(raw) ? raw : path.resolve(repoDir, raw);
	let rawCommon: string;
	try {
		rawCommon = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
	} catch {
		return [gitDir, gitDir];
	}
	const commonDir = path.isAbsolute(rawCommon) ? rawCommon : path.resolve(gitDir, rawCommon);
	return [gitDir, commonDir];
}

/** Keep shared Git metadata writable by whichever slot gets the retry. */
export function shareGitMetadataWithSlots(repoDir: string, slotUid: number | null): void {
	if (!slotPermissionsActive(slotUid)) return;
	const dirs = resolveWorktreeGitDirs(repoDir);
	if (dirs === null) return;
	const [gitDir, commonDir] = dirs;
	const gid = SHARED_OMP_GID;
	grantTree(gitDir, gid, true);
	grantGroupBits(commonDir, gid, S_IRWXG | S_ISGID);
	for (const [rel, writable] of [
		["objects", false],
		["refs", true],
		["logs", true],
		["worktrees", true],
	] as const) {
		grantTree(path.join(commonDir, rel), gid, writable);
	}
	for (const rel of ["config", "packed-refs", "HEAD", "FETCH_HEAD", "ORIG_HEAD"]) {
		grantTree(path.join(commonDir, rel), gid, true);
	}
}

/** Hand the workspace tree to the identity that will run repo-local git. */
export async function chownWorkspace(wsRoot: string, slotUid: number | null): Promise<void> {
	if (platformInfo.system() !== "linux") return;
	if (currentEuid() !== 0) return;
	const uid = slotUid ?? currentEuid();
	const gid = slotUid ?? currentEgid();
	for (const cmd of [
		["chown", "-R", `${uid}:${gid}`, wsRoot],
		["chmod", "-R", "u=rwX,g=rwX,o=", wsRoot],
	]) {
		const proc = await runProcess(cmd, { timeout: DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT });
		if (proc.returncode !== 0) {
			throw new Error(`Command '${cmd.join(" ")}' returned non-zero exit status ${proc.returncode}.`);
		}
	}
}

// ---------- workspace cache reclamation ----------

const TRASH_PREFIX = ".trash-";
const NODE_MODULES_SCAN_DEPTH = 4;

/** Locate `node_modules` dirs in a checkout without descending into them. */
export function findNodeModules(repoDir: string, maxDepth = NODE_MODULES_SCAN_DEPTH): string[] {
	const found: string[] = [];
	if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) return found;
	const walk = (current: string, depth: number): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
		if (dirs.includes("node_modules")) found.push(path.join(current, "node_modules"));
		if (depth + 1 >= maxDepth) return;
		for (const name of dirs) {
			if (name === ".git" || name === "node_modules") continue;
			walk(path.join(current, name), depth + 1);
		}
	};
	walk(repoDir, 0);
	return found;
}

/** Rename reclaimable cache dirs into `.trash-*` staging dirs. */
export function stageWorkspaceTrash(wsRoot: string): string[] {
	if (!fs.existsSync(wsRoot) || !fs.statSync(wsRoot).isDirectory()) return [];
	const staged = fs
		.readdirSync(wsRoot)
		.filter(name => name.startsWith(TRASH_PREFIX))
		.map(name => path.join(wsRoot, name));
	const candidates = [
		path.join(wsRoot, ".omp-xdg", "cache"),
		path.join(wsRoot, ".omp-tmp"),
		...findNodeModules(path.join(wsRoot, "repo")),
	];
	let trashRoot: string | null = null;
	candidates.forEach((victim, index) => {
		const st = lstatOrNull(victim);
		if (!st || !(st.isDirectory() || st.isSymbolicLink())) return;
		if (trashRoot === null) {
			trashRoot = path.join(wsRoot, `${TRASH_PREFIX}${crypto.getRandomValues(new Uint8Array(4)).toHex()}`);
			fs.mkdirSync(trashRoot, { mode: 0o700 });
			staged.push(trashRoot);
		}
		try {
			fs.renameSync(victim, path.join(trashRoot, `${index}-${path.basename(victim)}`));
		} catch (err) {
			log.warning("cache reclaim rename failed", { path: victim, err: String(err) });
		}
	});
	return staged;
}

async function purgeTrash(staged: readonly string[]): Promise<void> {
	for (const p of staged) await fs.promises.rm(p, { recursive: true, force: true });
}

/** Internal collaborators routed through one object (spy seam for tests). */
export const sandboxDeps = {
	safeRun,
	run,
	chownWorkspace,
	shareGitMetadataWithSlots,
	provisionRuntimeDirs,
	gitEnvForRepo,
	slotPids,
	kill: (pid: number, signal: NodeJS.Signals): void => {
		process.kill(pid, signal);
	},
};

/** Minimal async mutex (per-repo serialization). */
export class AsyncMutex {
	#locked = false;
	readonly #waiters: (() => void)[] = [];

	get locked(): boolean {
		return this.#locked;
	}

	/** Acquire without waiting; returns a release function, or null when held. */
	tryAcquire(): (() => void) | null {
		if (this.#locked) return null;
		this.#locked = true;
		return this.#releaser();
	}

	async acquire(): Promise<() => void> {
		if (!this.#locked) {
			this.#locked = true;
			return this.#releaser();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push(resolve);
		await promise;
		return this.#releaser();
	}

	#releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiters.shift();
			if (next) next();
			else this.#locked = false;
		};
	}

	async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

function exists(p: string): boolean {
	return fs.existsSync(p);
}

export interface EnsureWorkspaceArgs {
	repo: string;
	number: number;
	title: string;
	cloneUrl: string;
	defaultBranch: string;
	existingBranch?: string | null;
	prHead?: number | null;
	authorName: string;
	authorEmail: string;
	slotUid?: number | null;
}

/** Manages a shared clone pool and per-issue worktrees. */
export class SandboxManager {
	readonly root: string;
	readonly pool: string;
	transport: GitTransport;
	nativesCache: NativesCache | null;
	readonly #repoLocks = new Map<string, AsyncMutex>();

	constructor(root: string, options: { transport?: GitTransport | null; nativesCache?: NativesCache | null } = {}) {
		this.root = root;
		this.pool = path.join(root, "_pool");
		this.transport = options.transport ?? new LocalGitTransport(null);
		this.nativesCache = options.nativesCache ?? null;
		fs.mkdirSync(this.pool, { recursive: true });
	}

	/** Per-repo lock (serializes pool + worktree mutations for one repo). */
	repoLock(repo: string): AsyncMutex {
		let lock = this.#repoLocks.get(repo);
		if (!lock) {
			lock = new AsyncMutex();
			this.#repoLocks.set(repo, lock);
		}
		return lock;
	}

	poolPath(repo: string): string {
		return path.join(this.pool, repo.replaceAll("/", "__"));
	}

	/** Create or refresh the shared clone for `repo`. */
	async ensureClone(args: {
		repo: string;
		cloneUrl: string;
		defaultBranch: string;
		refresh?: boolean;
	}): Promise<string> {
		const target = this.poolPath(args.repo);
		if (exists(path.join(target, ".git")) || exists(path.join(target, "HEAD"))) {
			await SandboxManager.resetOriginUrl(target, args.cloneUrl);
			if (args.refresh ?? true) await this.transport.fetchPool({ repo: args.repo, poolDir: target });
			return target;
		}
		fs.mkdirSync(target, { recursive: true });
		await this.transport.clonePool({
			repo: args.repo,
			cloneUrl: args.cloneUrl,
			defaultBranch: args.defaultBranch,
			target,
		});
		return target;
	}

	/** `git remote set-url origin <cloneUrl>` if origin exists and differs. */
	static async resetOriginUrl(repoDir: string, cloneUrl: string): Promise<void> {
		const probeCmd = ["git", "remote", "get-url", "origin"];
		const probe = await sandboxDeps.safeRun(probeCmd, { cwd: repoDir });
		if (probe.returncode === 124) {
			throw new GitCommandError(probeCmd, probe.returncode, probe.stdout, probe.stderr);
		}
		if (probe.returncode !== 0) return;
		if (probe.stdout.trim() === cloneUrl) return;
		await sandboxDeps.safeRun(["git", "remote", "set-url", "origin", cloneUrl], { cwd: repoDir });
	}

	workspaceRoot(repo: string, number: number | string): string {
		return path.join(this.root, workspaceKey(repo, number));
	}

	/** Create or resume a per-issue worktree. */
	ensureWorkspace(args: EnsureWorkspaceArgs): Promise<Workspace> {
		return this.repoLock(args.repo).runExclusive(() => this.#ensureWorkspaceLocked(args));
	}

	async #ensureWorkspaceLocked(args: EnsureWorkspaceArgs): Promise<Workspace> {
		const { repo, number, title, cloneUrl, defaultBranch, authorName, authorEmail } = args;
		const existingBranch = args.existingBranch ?? null;
		const prHead = args.prHead ?? null;
		const slotUid = args.slotUid ?? null;
		if (prHead !== null && existingBranch !== null) {
			throw new RangeError("ensure_workspace accepts either pr_head or existing_branch, not both");
		}
		const pool = await this.ensureClone({ repo, cloneUrl, defaultBranch });
		const wsRoot = this.workspaceRoot(repo, number);
		const repoDir = path.join(wsRoot, "repo");
		const sessionDir = path.join(wsRoot, ".omp-session");
		const contextDir = path.join(wsRoot, "context");
		const artifactsDir = path.join(wsRoot, "artifacts");
		for (const p of [wsRoot, sessionDir, contextDir, path.join(contextDir, "repro"), artifactsDir]) {
			fs.mkdirSync(p, { recursive: true });
		}
		let branch =
			prHead !== null
				? `review/pr-${prHead}`
				: existingBranch || makeBranch({ issueNumber: number, title, seed: `${repo}#${number}` });

		const repoExists = exists(path.join(repoDir, ".git"));
		let workspacePrepared = false;
		const identity = slotIdentity(slotUid);
		let slotGitEnv: Record<string, string> | null = null;
		if (repoExists) {
			sandboxDeps.shareGitMetadataWithSlots(repoDir, slotUid);
			sandboxDeps.provisionRuntimeDirs(wsRoot);
			await sandboxDeps.chownWorkspace(wsRoot, slotUid);
			workspacePrepared = true;
		}
		if (!repoExists) {
			if (prHead !== null) {
				await this.transport.fetchPrHead({ repo, poolDir: pool, prNumber: prHead });
				await worktreeAdd(["git", "worktree", "add", "--detach", repoDir, "FETCH_HEAD"], pool, repoDir);
			} else {
				await this.transport.fetchBaseRef({ repo, poolDir: pool, ref: existingBranch || defaultBranch });
				const probe = ["git", "rev-parse", "--verify", `refs/heads/${branch}`];
				const checkProc = await sandboxDeps.safeRun(probe, { cwd: pool });
				if (checkProc.returncode === 124) {
					throw new GitCommandError(probe, checkProc.returncode, checkProc.stdout, checkProc.stderr);
				}
				if (checkProc.returncode === 0) {
					await worktreeAdd(["git", "worktree", "add", repoDir, branch], pool, repoDir);
				} else {
					let startPoint = `origin/${defaultBranch}`;
					if (existingBranch) {
						const remoteProbe = ["git", "rev-parse", "--verify", `refs/remotes/origin/${existingBranch}`];
						const remote = await sandboxDeps.safeRun(remoteProbe, { cwd: pool });
						if (remote.returncode === 124) {
							throw new GitCommandError(remoteProbe, remote.returncode, remote.stdout, remote.stderr);
						}
						if (remote.returncode === 0) startPoint = `origin/${existingBranch}`;
					}
					await worktreeAdd(["git", "worktree", "add", "-b", branch, repoDir, startPoint], pool, repoDir);
				}
			}
		} else {
			slotGitEnv = sandboxDeps.gitEnvForRepo(repoDir);
			const symref = ["git", "symbolic-ref", "--quiet", "--short", "HEAD"];
			const current = await sandboxDeps.safeRun(symref, { cwd: repoDir, env: slotGitEnv, identity });
			if (current.returncode === 124) {
				throw new GitCommandError(symref, current.returncode, current.stdout, current.stderr);
			}
			if (current.returncode === 0 && current.stdout.trim()) {
				branch = current.stdout.trim();
				if (existingBranch !== null && existingBranch !== branch) {
					log.warning(
						`workspace branch mapping ${pyRepr(existingBranch)} differs from checked-out branch ${pyRepr(branch)}; using checkout`,
					);
				}
			}
		}
		if (!workspacePrepared) {
			sandboxDeps.shareGitMetadataWithSlots(repoDir, slotUid);
			sandboxDeps.provisionRuntimeDirs(wsRoot);
			await sandboxDeps.chownWorkspace(wsRoot, slotUid);
		}
		slotGitEnv ??= sandboxDeps.gitEnvForRepo(repoDir);
		for (const command of [
			["git", "config", "user.email", authorEmail],
			["git", "config", "user.name", authorName],
		]) {
			const proc = await sandboxDeps.safeRun(command, { cwd: repoDir, env: slotGitEnv, identity });
			if (proc.returncode !== 0) throw new GitCommandError(command, proc.returncode, proc.stdout, proc.stderr);
		}
		sandboxDeps.shareGitMetadataWithSlots(repoDir, slotUid);
		const workspace = new Workspace(wsRoot, repoDir, sessionDir, contextDir, artifactsDir, branch, repo, number);
		await this.populateNativesCache(workspace, slotUid);
		return workspace;
	}

	/** Create or reset the repository's reusable main-branch release worktree. */
	ensureReleaseWorkspace(args: {
		repo: string;
		cloneUrl: string;
		defaultBranch: string;
		tag: string;
		authorName: string;
		authorEmail: string;
		slotUid?: number | null;
	}): Promise<Workspace> {
		return this.repoLock(args.repo).runExclusive(async () => {
			const { repo, cloneUrl, defaultBranch, tag } = args;
			const slotUid = args.slotUid ?? null;
			const pool = await this.ensureClone({ repo, cloneUrl, defaultBranch, refresh: false });
			await this.transport.fetchPool({ repo, poolDir: pool });
			const wsRoot = this.workspaceRoot(repo, "release");
			const repoDir = path.join(wsRoot, "repo");
			const sessionDir = path.join(wsRoot, `.omp-session-${tag}`);
			const contextDir = path.join(wsRoot, "context");
			const artifactsDir = path.join(wsRoot, "artifacts");
			for (const p of [wsRoot, sessionDir, contextDir, path.join(contextDir, "repro"), artifactsDir]) {
				fs.mkdirSync(p, { recursive: true });
			}
			const detach = ["git", "checkout", "--detach"];
			const detached = await sandboxDeps.safeRun(detach, { cwd: pool });
			if (detached.returncode !== 0) {
				throw new GitCommandError(detach, detached.returncode, detached.stdout, detached.stderr);
			}
			if (!exists(path.join(repoDir, ".git"))) {
				await worktreeAdd(
					["git", "worktree", "add", "-B", defaultBranch, repoDir, `origin/${defaultBranch}`],
					pool,
					repoDir,
				);
			}
			sandboxDeps.shareGitMetadataWithSlots(repoDir, slotUid);
			sandboxDeps.provisionRuntimeDirs(wsRoot);
			await sandboxDeps.chownWorkspace(wsRoot, slotUid);
			const identity = slotIdentity(slotUid);
			const slotGitEnv = sandboxDeps.gitEnvForRepo(repoDir);
			for (const command of [
				["git", "checkout", "-B", defaultBranch, `origin/${defaultBranch}`],
				["git", "reset", "--hard", `origin/${defaultBranch}`],
				["git", "clean", "-fd"],
				["git", "config", "user.email", args.authorEmail],
				["git", "config", "user.name", args.authorName],
			]) {
				const proc = await sandboxDeps.safeRun(command, { cwd: repoDir, env: slotGitEnv, identity });
				if (proc.returncode !== 0) throw new GitCommandError(command, proc.returncode, proc.stdout, proc.stderr);
			}
			sandboxDeps.shareGitMetadataWithSlots(repoDir, slotUid);
			const workspace = new Workspace(
				wsRoot,
				repoDir,
				sessionDir,
				contextDir,
				artifactsDir,
				defaultBranch,
				repo,
				"release",
			);
			await this.populateNativesCache(workspace, slotUid);
			return workspace;
		});
	}

	/** Try to hardlink cached pi-natives artifacts into the worktree (best-effort). */
	async populateNativesCache(workspace: Workspace, slotUid: number | null = null): Promise<void> {
		const cache = this.nativesCache;
		if (cache === null) return;
		const nativeDir = path.join(workspace.repo_dir, "packages", "natives", "native");
		let key: string;
		try {
			key = await nativesComputeKey(workspace.repo_dir);
		} catch (err) {
			log.debug("natives_cache key compute failed", {
				workspace: workspace.workspace_key,
				err: redactCredentials(String(err)),
			});
			return;
		}
		let hit: CacheHit | null;
		try {
			hit = cache.populateWorkspace(workspace.repo_full_name, key, nativeDir);
		} catch (err) {
			log.warning("natives_cache populate failed", {
				workspace: workspace.workspace_key,
				key,
				err: String(err),
			});
			return;
		}
		if (hit !== null && slotPermissionsActive(slotUid)) SandboxManager.chownNativesForSlot(nativeDir, hit, slotUid);
		log.info("natives_cache", {
			action: hit !== null ? "hit" : "miss",
			workspace: workspace.workspace_key,
			repo: workspace.repo_full_name,
			key,
			files: hit !== null ? hit.files.map(p => path.basename(p)) : [],
		});
	}

	/** Hand the populated native dir to the slot WITHOUT touching hardlinked `.node` inodes. */
	static chownNativesForSlot(nativeDir: string, hit: CacheHit, slotUid: number): void {
		try {
			fs.chownSync(nativeDir, slotUid, slotUid);
		} catch (err) {
			log.warning("natives_cache chown dir failed", { err: String(err) });
			return;
		}
		const nodeBasenames = new Set(hit.files.map(p => path.basename(p)).filter(name => name.endsWith(".node")));
		for (const child of fs.readdirSync(nativeDir)) {
			if (nodeBasenames.has(child)) continue;
			try {
				fs.lchownSync(path.join(nativeDir, child), slotUid, slotUid);
			} catch (err) {
				log.warning("natives_cache chown companion failed", {
					file: path.join(nativeDir, child),
					err: String(err),
				});
			}
		}
	}

	removeWorkspace(args: { repo: string; number: number | string }): Promise<void> {
		return this.repoLock(args.repo).runExclusive(async () => {
			const wsRoot = this.workspaceRoot(args.repo, args.number);
			const repoDir = path.join(wsRoot, "repo");
			const pool = this.poolPath(args.repo);
			if (exists(path.join(pool, ".git")) || exists(path.join(pool, "HEAD"))) {
				let needsPrune = false;
				if (exists(repoDir)) {
					const removed = await sandboxDeps.safeRun(["git", "worktree", "remove", "--force", repoDir], {
						cwd: pool,
					});
					if (removed.returncode !== 0) {
						fs.rmSync(repoDir, { recursive: true, force: true });
						needsPrune = true;
					}
				} else if (exists(wsRoot)) {
					needsPrune = true;
				}
				if (needsPrune) {
					const pruned = await sandboxDeps.safeRun(["git", "worktree", "prune"], { cwd: pool });
					if (pruned.returncode !== 0) {
						throw new GitCommandError(
							["git", "worktree", "prune"],
							pruned.returncode,
							pruned.stdout,
							pruned.stderr,
						);
					}
				}
			}
			if (exists(wsRoot)) fs.rmSync(wsRoot, { recursive: true, force: true });
		});
	}

	/** Strip re-creatable dependency caches from an idle workspace. */
	async reclaimWorkspaceCaches(args: { repo: string; number: number | string }): Promise<boolean> {
		const staged = await this.repoLock(args.repo).runExclusive(() =>
			stageWorkspaceTrash(this.workspaceRoot(args.repo, args.number)),
		);
		await purgeTrash(staged);
		return staged.length > 0;
	}

	/** Sweep dependency caches from every workspace under `root` (boot-time recovery). */
	async reclaimAllCaches(): Promise<number> {
		if (!exists(this.root) || !fs.statSync(this.root).isDirectory()) return 0;
		let count = 0;
		for (const name of fs.readdirSync(this.root).sort()) {
			const entry = path.join(this.root, name);
			if (name === "_pool" || name.startsWith(".") || !fs.statSync(entry).isDirectory()) continue;
			const staged = stageWorkspaceTrash(entry);
			if (staged.length > 0) {
				await purgeTrash(staged);
				count++;
			}
		}
		return count;
	}
}
