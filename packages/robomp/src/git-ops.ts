/**
 * Low-level git primitives with ephemeral PAT injection.
 *
 * The PAT is supplied through `git --config-env=http.<url>.extraHeader=ENVVAR`
 * when a verified HTTPS remote is known, or the legacy global
 * `http.extraHeader` path for older direct callers. Git expands the env var
 * inside the spawned process; the secret never appears in argv visible to
 * other UIDs via `/proc/<pid>/cmdline`.
 *
 * Git is spawned directly (not via `@oh-my-pi/pi-natives/vcs`) because this
 * layer needs exact argv/env control, credential scrubbing, per-call slot
 * identity, and `--config-env` injection that the shared VCS helper does not
 * expose.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getLogger } from "./logging";
import { pyRepr } from "./pycompat";
import { type CompletedProcess, type ProcessIdentity, processEnv, runProcess, slotIdentity } from "./subprocess";

const log = getLogger("robomp.git_ops");

/** Per-call env var name read by `git --config-env`. */
export const AUTH_ENV_VAR = "ROBOMP_GIT_HTTP_AUTH";
const TOKEN_ALLOWED_PROTOCOLS = "https";
export const TOKEN_SAFE_CONFIG = [
	"protocol.allow=never",
	"protocol.https.allow=always",
	"protocol.http.allow=never",
	"protocol.git.allow=never",
	"protocol.ssh.allow=never",
	"protocol.file.allow=never",
	"protocol.ext.allow=never",
	"credential.helper=",
	"core.askPass=",
	"core.hooksPath=/dev/null",
	"http.proxy=",
	"http.sslVerify=true",
	"http.extraHeader=",
];
const GIT_SUBPROCESS_SCRUBBED_ENV_KEYS = [
	AUTH_ENV_VAR,
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_WEBHOOK_SECRET",
	"ROBOMP_REPLAY_TOKEN",
	"ROBOMP_GH_PROXY_HMAC_KEY",
];

export function gitSubprocessEnv(): Record<string, string> {
	const env = processEnv();
	for (const key of GIT_SUBPROCESS_SCRUBBED_ENV_KEYS) delete env[key];
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_ASKPASS = "";
	env.SSH_ASKPASS = "";
	return env;
}

/**
 * Every git smart-HTTP request path a fetch/push can hit. Repo-local
 * `http.<url>/<path>.*` keys win over a base-only override (longest prefix),
 * so each path is overridden explicitly; see the Python module for the full
 * threat model.
 */
const GIT_SMART_HTTP_PATHS = ["", "/info", "/info/refs", "/git-upload-pack", "/git-receive-pack"];

export function tokenUrlSafeConfig(authUrl: string | null): string[] {
	if (authUrl === null) return [];
	const items: string[] = [];
	for (const suffix of GIT_SMART_HTTP_PATHS) {
		const scoped = `${authUrl}${suffix}`;
		items.push(`http.${scoped}.proxy=`, `http.${scoped}.sslVerify=true`, `credential.${scoped}.helper=`);
	}
	items.push(`http.${authUrl}.extraHeader=`);
	return items;
}

function httpExtraHeaderKey(authUrl: string | null): string {
	return authUrl === null ? "http.extraHeader" : `http.${authUrl}.extraHeader`;
}

const CRED_URL = /(https?:\/\/)([^:/@\s]+):([^@/\s]+)@/g;
const BAD_OBJECT_REF_RE =
	/(?:fatal: bad object (?<bad>refs\/[^\s]+)|error: (?<invalid>refs\/[^\s]+) does not point to a valid object!)/g;
const FETCH_PRUNE_REPAIR_ATTEMPTS = 8;
export const AGENT_HOME = "/srv/agent-home";

/** Strip `user:password@` from any embedded URL in `text`. */
export function redactCredentials(text: string | null | undefined): string {
	if (!text) return text ?? "";
	return text.replace(CRED_URL, "$1***@");
}

function redactedCmd(cmd: readonly string[]): string[] {
	return cmd.map(part => redactCredentials(part));
}

/** Wraps a failed git subprocess with credentials redacted from argv and output. */
export class GitCommandError extends Error {
	readonly returncode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly cmd: string[];
	constructor(cmd: readonly string[], returncode: number, stdout: string, stderr: string, options?: ErrorOptions) {
		const redStdout = redactCredentials(stdout);
		const redStderr = redactCredentials(stderr);
		const redCmd = redactedCmd(cmd);
		const msg = redStderr.trim() || redStdout.trim() || `exit ${returncode}`;
		super(`git ${redCmd.slice(1).join(" ")} failed: ${msg}`, options);
		this.name = "GitCommandError";
		this.returncode = returncode;
		this.stdout = redStdout;
		this.stderr = redStderr;
		this.cmd = redCmd;
	}
}

/**
 * Raised when `expected_head` no longer matches the current HEAD.
 * Defends against a commit landing between preflight gates and the push.
 */
export class HeadDriftError extends GitCommandError {
	constructor(cmd: readonly string[], returncode: number, stdout: string, stderr: string, options?: ErrorOptions) {
		super(cmd, returncode, stdout, stderr, options);
		this.name = "HeadDriftError";
	}
}

/** Build the `Authorization: Basic …` header value for a PAT. */
export function basicAuthHeader(token: string): string {
	return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

export function appendSafeDirectory(env: Record<string, string>, repoDir: string): void {
	const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
	env[`GIT_CONFIG_KEY_${count}`] = "safe.directory";
	env[`GIT_CONFIG_VALUE_${count}`] = repoDir;
	env.GIT_CONFIG_COUNT = String(count + 1);
}

/**
 * `urllib.parse.urlsplit(url)` for a `file://` URL: `[netloc, path]`, with
 * no percent-decoding. Throws `RangeError` (Python `ValueError`) exactly
 * where urlsplit does: unbalanced/invalid bracketed hosts and netlocs that
 * change meaning under NFKC normalization.
 */
export function pyUrlsplitFile(url: string): { netloc: string; path: string } {
	// urlsplit lstrips C0 controls/space and drops tab/CR/LF anywhere.
	let rest = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
	const colon = rest.indexOf(":");
	if (colon > 0 && /^[A-Za-z][A-Za-z0-9+\-.]*$/.test(rest.slice(0, colon))) rest = rest.slice(colon + 1);
	let netloc = "";
	if (rest.startsWith("//")) {
		let end = rest.length;
		for (const ch of "/?#") {
			const idx = rest.indexOf(ch, 2);
			if (idx >= 0) end = Math.min(end, idx);
		}
		netloc = rest.slice(2, end);
		rest = rest.slice(end);
		const open = netloc.includes("[");
		const close = netloc.includes("]");
		if (open !== close) throw new RangeError("Invalid IPv6 URL");
		if (open && close) checkBracketedNetloc(netloc);
	}
	const hash = rest.indexOf("#");
	if (hash >= 0) rest = rest.slice(0, hash);
	const query = rest.indexOf("?");
	if (query >= 0) rest = rest.slice(0, query);
	checkNetlocNfkc(netloc);
	return { netloc, path: rest };
}

function checkBracketedNetloc(netloc: string): void {
	const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
	const openIdx = hostAndPort.indexOf("[");
	let hostname: string;
	if (openIdx >= 0) {
		if (openIdx > 0) throw new RangeError("Invalid IPv6 URL");
		const bracketed = hostAndPort.slice(openIdx + 1);
		const closeIdx = bracketed.indexOf("]");
		hostname = closeIdx >= 0 ? bracketed.slice(0, closeIdx) : bracketed;
		const port = closeIdx >= 0 ? bracketed.slice(closeIdx + 1) : "";
		if (port && !port.startsWith(":")) throw new RangeError("Invalid IPv6 URL");
	} else {
		const colonIdx = hostAndPort.indexOf(":");
		hostname = colonIdx >= 0 ? hostAndPort.slice(0, colonIdx) : hostAndPort;
	}
	if (hostname.startsWith("v")) {
		if (!/^v[a-fA-F0-9]+\.[\s\S]+$/.test(hostname)) throw new RangeError("IPvFuture address is invalid");
		return;
	}
	if (net.isIPv4(hostname)) throw new RangeError("An IPv4 address cannot be in brackets");
	if (!net.isIPv6(hostname)) {
		throw new RangeError(`${pyRepr(hostname)} does not appear to be an IPv4 or IPv6 address`);
	}
}

function checkNetlocNfkc(netloc: string): void {
	if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
	const n = netloc.replace(/[@:#?]/g, "");
	const normalized = n.normalize("NFKC");
	if (n === normalized) return;
	for (const ch of "/?#@:") {
		if (normalized.includes(ch)) {
			throw new RangeError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
		}
	}
}

/** `str(pathlib.PurePosixPath(p))`: collapse `//` and `.` segments, drop the trailing slash. */
export function pyPosixPath(p: string): string {
	if (p === "") return ".";
	const leading = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
	const parts = p.split("/").filter(part => part !== "" && part !== ".");
	const body = parts.join("/");
	return leading + body || ".";
}

/**
 * `pathlib.Path.resolve()` (non-strict `os.path.realpath`): walk components,
 * resolving symlinks of those that exist and applying `..` to the resolved
 * prefix; missing components are kept verbatim.
 */
function pyResolve(p: string): string {
	const absolute = p.startsWith("/") ? p : `${process.cwd()}/${p}`;
	let current = "/";
	for (const part of absolute.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			current = path.dirname(current);
			continue;
		}
		const next = path.join(current, part);
		try {
			current = fs.realpathSync(next);
		} catch {
			current = next;
		}
	}
	return current;
}

/** Return a local filesystem remote path that git may need whitelisted. */
export function localRemoteSafeDirectory(remoteUrl: string, cwd: string): string | null {
	const raw = remoteUrl.trim();
	if (!raw) return null;
	if (raw.startsWith("file://")) {
		// Python `Path(urlparse(raw).path)`: the path is NOT percent-decoded.
		const parsed = pyUrlsplitFile(raw);
		if (parsed.netloc !== "" && parsed.netloc !== "localhost") return null;
		return pyPosixPath(parsed.path);
	}
	if (raw.includes("://") || /^[^/\\s]+:/.test(raw)) return null;
	const local = pyPosixPath(raw);
	return path.isAbsolute(local) ? local : pyResolve(`${cwd}/${local}`);
}

/** Hard wall-clock cap on any one `git` invocation (seconds). */
export const DEFAULT_GIT_TIMEOUT_SECONDS = 120;

export interface RunGitOptions {
	cwd: string | null;
	token: string | null;
	authUrl?: string | null;
	extraEnv?: Record<string, string> | null;
	safeDirectory?: string | null;
	identity?: ProcessIdentity | null;
	timeout?: number | null;
}

/**
 * Run `git <args>` with optional PAT injection via `--config-env`.
 *
 * Non-zero exit returns the result; callers `check` it or inspect manually.
 * A timeout throws `GitCommandError` with returncode 124 (GNU `timeout`).
 * Stdout/stderr are always credential-redacted.
 */
export async function runGit(args: readonly string[], options: RunGitOptions): Promise<CompletedProcess> {
	const env = gitSubprocessEnv();
	if (options.identity && fs.existsSync(AGENT_HOME) && fs.statSync(AGENT_HOME).isDirectory()) {
		env.HOME = AGENT_HOME;
	}
	if (options.extraEnv) Object.assign(env, options.extraEnv);
	if (options.safeDirectory) appendSafeDirectory(env, options.safeDirectory);
	const authUrl = options.authUrl ?? null;
	const cmd = ["git", "-c", "protocol.ext.allow=never"];
	if (options.token) {
		env[AUTH_ENV_VAR] = basicAuthHeader(options.token);
		if (authUrl !== null) {
			env.GIT_ALLOW_PROTOCOL = TOKEN_ALLOWED_PROTOCOLS;
			env.GIT_CONFIG_NOSYSTEM = "1";
			env.GIT_CONFIG_SYSTEM = "/dev/null";
			env.GIT_CONFIG_GLOBAL = "/dev/null";
			for (const item of [...TOKEN_SAFE_CONFIG, ...tokenUrlSafeConfig(authUrl)]) cmd.push("-c", item);
		}
		cmd.push("--config-env", `${httpExtraHeaderKey(authUrl)}=${AUTH_ENV_VAR}`);
	}
	cmd.push(...args);
	log.debug("git", { cmd: redactedCmd(cmd), cwd: options.cwd });
	const timeout = options.timeout ?? DEFAULT_GIT_TIMEOUT_SECONDS;
	const proc = await runProcess(cmd, { cwd: options.cwd, env, timeout, identity: options.identity ?? null });
	if (proc.timedOut) {
		throw new GitCommandError(
			cmd,
			124,
			redactCredentials(proc.stdout),
			`git timed out after ${timeout.toFixed(0)}s: ${redactedCmd(cmd).join(" ")}`,
		);
	}
	return { ...proc, stdout: redactCredentials(proc.stdout), stderr: redactCredentials(proc.stderr) };
}

export function check(proc: CompletedProcess, cmd: readonly string[]): CompletedProcess {
	if (proc.returncode !== 0) throw new GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr);
	return proc;
}

function isDir(p: string): boolean {
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

function gitDir(repoDir: string): string | null {
	const dotGit = path.join(repoDir, ".git");
	if (isDir(dotGit)) return dotGit;
	if (isFile(dotGit)) {
		let text: string;
		try {
			text = fs.readFileSync(dotGit, "utf-8").trim();
		} catch {
			return null;
		}
		if (!text.startsWith("gitdir:")) return null;
		const raw = text.slice("gitdir:".length).trim();
		return path.isAbsolute(raw) ? raw : path.resolve(repoDir, raw);
	}
	if (fs.existsSync(path.join(repoDir, "HEAD")) && isDir(path.join(repoDir, "objects"))) return repoDir;
	return null;
}

/** Drop object alternates that point at directories no longer mounted. */
export function pruneMissingAlternates(repoDir: string): boolean {
	const dir = gitDir(repoDir);
	if (dir === null) return false;
	const objectsDir = path.join(dir, "objects");
	const alternates = path.join(objectsDir, "info", "alternates");
	let lines: string[];
	try {
		lines = fs.readFileSync(alternates, "utf-8").split(/\r?\n/);
		if (lines.at(-1) === "") lines.pop();
	} catch {
		return false;
	}
	const kept: string[] = [];
	let changed = false;
	for (const line of lines) {
		const raw = line.trim();
		if (!raw) {
			changed = true;
			continue;
		}
		const resolved = path.isAbsolute(raw) ? raw : path.resolve(objectsDir, raw);
		if (isDir(resolved)) kept.push(line);
		else changed = true;
	}
	if (!changed) return false;
	try {
		if (kept.length > 0) fs.writeFileSync(alternates, `${kept.join("\n")}\n`, "utf-8");
		else fs.unlinkSync(alternates);
	} catch (err) {
		log.warning("failed to prune missing git alternates", { repo_dir: repoDir, error: String(err) });
		return false;
	}
	log.warning("pruned missing git alternates", { repo_dir: repoDir });
	return true;
}

function isSafeRefName(ref: string): boolean {
	if (!ref.startsWith("refs/")) return false;
	if (/[\0\r\n\t ]/.test(ref)) return false;
	return ref.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function badRefsFromFetchOutput(output: string): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	for (const match of output.matchAll(BAD_OBJECT_REF_RE)) {
		const ref = match.groups?.bad ?? match.groups?.invalid ?? "";
		if (seen.has(ref) || !isSafeRefName(ref)) continue;
		seen.add(ref);
		refs.push(ref);
	}
	return refs;
}

/** Map each ref in `refs` to the worktree paths whose HEAD is on it. */
async function worktreesHoldingRefs(repoDir: string, refs: readonly string[]): Promise<Map<string, string[]>> {
	const byRef = new Map<string, string[]>();
	if (refs.length === 0) return byRef;
	const proc = await runGit(["worktree", "list", "--porcelain"], { cwd: repoDir, token: null });
	if (proc.returncode !== 0) return byRef;
	const refsSet = new Set(refs);
	let current = new Map<string, string>();
	const flush = () => {
		const branch = current.get("branch");
		const wtPath = current.get("worktree");
		if (branch && refsSet.has(branch) && wtPath) {
			const list = byRef.get(branch) ?? [];
			list.push(wtPath);
			byRef.set(branch, list);
		}
	};
	for (const line of proc.stdout.split(/\r?\n/)) {
		if (!line.trim()) {
			flush();
			current = new Map();
			continue;
		}
		const idx = line.indexOf(" ");
		if (idx > 0) current.set(line.slice(0, idx), line.slice(idx + 1));
	}
	flush();
	return byRef;
}

async function removeWorktrees(repoDir: string, paths: readonly string[]): Promise<void> {
	for (const wt of paths) {
		const proc = await runGit(["worktree", "remove", "--force", wt], { cwd: repoDir, token: null });
		if (proc.returncode !== 0) {
			log.warning("failed to remove worktree during fetch repair", {
				repo_dir: repoDir,
				worktree: wt,
				stderr: proc.stderr.slice(0, 500),
			});
			continue;
		}
		log.warning("removed worktree during fetch repair", { repo_dir: repoDir, worktree: wt });
	}
	if (paths.length > 0) await runGit(["worktree", "prune"], { cwd: repoDir, token: null });
}

export async function deleteBadRefs(repoDir: string, output: string): Promise<boolean> {
	const badRefs = badRefsFromFetchOutput(output);
	if (badRefs.length === 0) return false;
	const holding = await worktreesHoldingRefs(repoDir, badRefs);
	let changed = false;
	for (const ref of badRefs) {
		const worktrees = holding.get(ref) ?? [];
		if (worktrees.length > 0) {
			await removeWorktrees(repoDir, worktrees);
			changed = true;
		}
		const proc = await runGit(["update-ref", "-d", ref], { cwd: repoDir, token: null });
		if (proc.returncode === 0) {
			changed = true;
			log.warning("deleted invalid git ref during fetch repair", { repo_dir: repoDir, git_ref: ref });
			continue;
		}
		log.warning("failed to delete invalid git ref during fetch repair", {
			repo_dir: repoDir,
			git_ref: ref,
			stderr: proc.stderr.slice(0, 500),
		});
	}
	return changed;
}

async function repairFetchPruneFailure(repoDir: string, output: string): Promise<boolean> {
	const prunedAlternates = pruneMissingAlternates(repoDir);
	const deletedRefs = await deleteBadRefs(repoDir, output);
	return prunedAlternates || deletedRefs;
}

function explicitRemoteEnv(remoteUrl: string | null | undefined, cwd: string): Record<string, string> | null {
	if (remoteUrl === null || remoteUrl === undefined) return null;
	const localRemote = localRemoteSafeDirectory(remoteUrl, cwd);
	if (localRemote === null) return null;
	const env: Record<string, string> = {};
	appendSafeDirectory(env, localRemote);
	return env;
}

export function branchRefspec(ref: string): string {
	if (ref.includes(":") || (ref.startsWith("refs/") && !ref.startsWith("refs/heads/"))) return ref;
	const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
	return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

export interface RemoteOptions {
	token: string | null;
	remoteUrl?: string | null;
	authUrl?: string | null;
	safeDirectory?: string | null;
}

// ---------- Public primitives ----------

/** Fresh `git clone --filter=blob:none` into `target`. */
export async function clone(
	target: string,
	options: {
		cloneUrl: string;
		defaultBranch: string;
		token: string | null;
		authUrl?: string | null;
		safeDirectory?: string | null;
	},
): Promise<void> {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const args = [
		"clone",
		"--filter=blob:none",
		"--no-tags",
		"--branch",
		options.defaultBranch,
		options.cloneUrl,
		target,
	];
	check(
		await runGit(args, {
			cwd: null,
			token: options.token,
			authUrl: options.authUrl,
			safeDirectory: options.safeDirectory,
		}),
		["git", ...args],
	);
}

/** Refresh `refs/remotes/origin/*` on the shared pool clone. */
export async function fetchPrune(repoDir: string, options: RemoteOptions): Promise<void> {
	pruneMissingAlternates(repoDir);
	const remoteUrl = options.remoteUrl ?? null;
	const extraEnv = explicitRemoteEnv(remoteUrl, repoDir);
	const args =
		remoteUrl === null
			? ["fetch", "--prune", "origin"]
			: ["fetch", "--prune", "--no-tags", "--filter=blob:none", remoteUrl, "+refs/heads/*:refs/remotes/origin/*"];
	let lastProc: CompletedProcess | null = null;
	for (let i = 0; i < FETCH_PRUNE_REPAIR_ATTEMPTS; i++) {
		const proc = await runGit(args, {
			cwd: repoDir,
			token: options.token,
			authUrl: options.authUrl,
			extraEnv,
			safeDirectory: options.safeDirectory,
		});
		if (proc.returncode === 0) return;
		lastProc = proc;
		const output = `${proc.stderr}\n${proc.stdout}`;
		if (!(await repairFetchPruneFailure(repoDir, output))) check(proc, ["git", ...args]);
	}
	check(lastProc!, ["git", ...args]);
}

/**
 * Fetch `<ref>` from origin AND materialize every reachable blob locally
 * (`--refetch --no-filter`, oh-my-pi#1818). Best-effort: failures are logged.
 */
export async function fetchRef(repoDir: string, ref: string, options: RemoteOptions): Promise<void> {
	const remoteUrl = options.remoteUrl ?? null;
	const remote = remoteUrl || "origin";
	const args = ["fetch", "--refetch", "--no-filter", remote, remoteUrl ? branchRefspec(ref) : ref];
	const proc = await runGit(args, {
		cwd: repoDir,
		token: options.token,
		authUrl: options.authUrl,
		extraEnv: explicitRemoteEnv(remoteUrl, repoDir),
		safeDirectory: options.safeDirectory,
	});
	if (proc.returncode !== 0) log.debug("fetch_ref non-fatal failure", { ref, stderr: proc.stderr });
}

/** Fetch `refs/pull/<n>/head` into FETCH_HEAD with all reachable blobs. */
export async function fetchPrHead(repoDir: string, prNumber: number, options: RemoteOptions): Promise<void> {
	if (prNumber <= 0) throw new RangeError(`invalid PR number: ${prNumber}`);
	const remoteUrl = options.remoteUrl ?? null;
	const remote = remoteUrl || "origin";
	const ref = remoteUrl ? `refs/pull/${prNumber}/head` : `pull/${prNumber}/head`;
	const args = ["fetch", "--refetch", "--no-filter", remote, ref];
	check(
		await runGit(args, {
			cwd: repoDir,
			token: options.token,
			authUrl: options.authUrl,
			extraEnv: explicitRemoteEnv(remoteUrl, repoDir),
			safeDirectory: options.safeDirectory,
		}),
		["git", ...args],
	);
}

export interface PushResult {
	head: string;
	branch: string;
}

/** Summary of the workspace's uncommitted + unpushed state. */
export interface DirtyState {
	uncommitted: number;
	unpushed: number;
	summary: string;
}

export function isDirty(state: DirtyState): boolean {
	return state.uncommitted > 0 || state.unpushed > 0;
}

/** Return the SHA of HEAD or throw GitCommandError. */
export async function revParseHead(
	repoDir: string,
	options: { safeDirectory?: string | null; identity?: ProcessIdentity | null } = {},
): Promise<string> {
	const args = ["rev-parse", "HEAD"];
	const proc = await runGit(args, {
		cwd: repoDir,
		token: null,
		safeDirectory: options.safeDirectory,
		identity: options.identity,
	});
	if (proc.returncode !== 0) throw new GitCommandError(["git", ...args], proc.returncode, proc.stdout, proc.stderr);
	return proc.stdout.trim();
}

function outputLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/**
 * Probe the worktree for uncommitted/unpushed work. Errors are swallowed —
 * "we couldn't tell" is treated as clean.
 */
export async function inspectDirtyState(
	repoDir: string,
	options: { slotUid?: number | null; safeDirectory?: string | null } = {},
): Promise<DirtyState> {
	const identity = slotIdentity(options.slotUid);
	const gitOpts = { cwd: repoDir, token: null, safeDirectory: options.safeDirectory, identity };
	let uncommitted = 0;
	let uncommittedSample: string[] = [];
	const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], gitOpts);
	if (status.returncode === 0 && status.stdout.trim()) {
		const lines = outputLines(status.stdout);
		uncommitted = lines.length;
		uncommittedSample = lines.slice(0, 10);
	}
	let unpushed = 0;
	let unpushedSample: string[] = [];
	const count = await runGit(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"], gitOpts);
	if (count.returncode === 0) {
		const parsed = Number.parseInt(count.stdout.trim() || "0", 10);
		unpushed = Number.isNaN(parsed) ? 0 : parsed;
	}
	if (unpushed > 0) {
		const logProc = await runGit(
			["log", `--max-count=${Math.min(unpushed, 5)}`, "--oneline", "HEAD", "--not", "--remotes=origin"],
			gitOpts,
		);
		if (logProc.returncode === 0) unpushedSample = outputLines(logProc.stdout).filter(line => line.trim());
	}
	if (uncommitted === 0 && unpushed === 0) return { uncommitted: 0, unpushed: 0, summary: "" };
	const parts: string[] = [];
	if (uncommitted) {
		const more =
			uncommitted > uncommittedSample.length ? `\n… and ${uncommitted - uncommittedSample.length} more` : "";
		parts.push(`Uncommitted changes (${uncommitted}):\n${uncommittedSample.join("\n")}${more}`);
	}
	if (unpushed) {
		const logText = unpushedSample.length > 0 ? unpushedSample.join("\n") : "(no log available)";
		parts.push(`Unpushed commits (${unpushed}):\n${logText}`);
	}
	return { uncommitted, unpushed, summary: parts.join("\n\n") };
}

export interface PushOptions extends RemoteOptions {
	branch: string;
	expectedHead: string | null;
	slotUid?: number | null;
}

async function originPushEnv(
	repoDir: string,
	safeDirectory: string | null,
	identity: ProcessIdentity | null,
): Promise<Record<string, string> | null> {
	const origin = await runGit(["remote", "get-url", "origin"], {
		cwd: repoDir,
		token: null,
		safeDirectory,
		identity,
	});
	if (origin.returncode !== 0) return null;
	const localRemote = localRemoteSafeDirectory(origin.stdout, repoDir);
	if (localRemote === null) return null;
	const env: Record<string, string> = {};
	appendSafeDirectory(env, localRemote);
	return env;
}

/**
 * Push `HEAD` with a lease pinned to the local `refs/remotes/origin/<branch>`
 * (empty for a brand-new branch). Aborts with `HeadDriftError` when
 * `expectedHead` no longer matches the local HEAD.
 */
export async function push(repoDir: string, options: PushOptions): Promise<PushResult> {
	const identity = slotIdentity(options.slotUid);
	let safeDirectory = options.safeDirectory ?? null;
	if (safeDirectory === null && identity) safeDirectory = repoDir;
	const head = await revParseHead(repoDir, { safeDirectory, identity });
	if (options.expectedHead && head !== options.expectedHead) {
		throw new HeadDriftError(
			["git", "push"],
			128,
			"",
			`HEAD changed since preflight (${options.expectedHead.slice(0, 12)} → ${head.slice(0, 12)}); aborting push.`,
		);
	}
	const { branch } = options;
	const probe = await runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
		cwd: repoDir,
		token: null,
		safeDirectory,
		identity,
	});
	const expectedRemote = probe.returncode === 0 ? probe.stdout.trim() : "";
	const remoteUrl = options.remoteUrl ?? null;
	let pushExtraEnv: Record<string, string> | null;
	let destination: string;
	let refspec: string;
	let setUpstream: boolean;
	if (remoteUrl === null) {
		pushExtraEnv = await originPushEnv(repoDir, safeDirectory, identity);
		destination = "origin";
		refspec = branch;
		setUpstream = true;
	} else {
		pushExtraEnv = explicitRemoteEnv(remoteUrl, repoDir);
		destination = remoteUrl;
		refspec = `HEAD:refs/heads/${branch}`;
		setUpstream = false;
	}
	const args = ["push"];
	if (options.token) args.push("--no-verify");
	args.push(`--force-with-lease=refs/heads/${branch}:${expectedRemote}`);
	if (setUpstream) args.push("--set-upstream");
	args.push(destination, refspec);
	check(
		await runGit(args, {
			cwd: repoDir,
			token: options.token,
			authUrl: options.authUrl,
			extraEnv: pushExtraEnv,
			safeDirectory,
			identity,
		}),
		["git", ...args],
	);
	if (remoteUrl !== null) {
		const update = await runGit(["update-ref", `refs/remotes/origin/${branch}`, head], {
			cwd: repoDir,
			token: null,
			safeDirectory,
			identity,
		});
		if (update.returncode !== 0) {
			log.warning("failed to refresh remote-tracking ref after explicit-url push", {
				repo_dir: repoDir,
				branch,
				stderr: update.stderr.slice(0, 500),
			});
		}
	}
	return { head, branch };
}

/** Atomically push a release branch and force its tag to the same commit. */
export async function pushRelease(
	repoDir: string,
	options: RemoteOptions & { branch: string; tag: string; expectedHead: string; slotUid?: number | null },
): Promise<PushResult> {
	const identity = slotIdentity(options.slotUid);
	let safeDirectory = options.safeDirectory ?? null;
	if (safeDirectory === null && identity) safeDirectory = repoDir;
	const head = await revParseHead(repoDir, { safeDirectory, identity });
	if (head !== options.expectedHead) {
		throw new HeadDriftError(
			["git", "push"],
			128,
			"",
			`HEAD changed since preflight (${options.expectedHead.slice(0, 12)} → ${head.slice(0, 12)}); aborting push.`,
		);
	}
	const remoteUrl = options.remoteUrl ?? null;
	let pushExtraEnv: Record<string, string> | null;
	let destination: string;
	if (remoteUrl === null) {
		pushExtraEnv = await originPushEnv(repoDir, safeDirectory, identity);
		destination = "origin";
	} else {
		pushExtraEnv = explicitRemoteEnv(remoteUrl, repoDir);
		destination = remoteUrl;
	}
	const args = ["push", "--atomic"];
	if (options.token) args.push("--no-verify");
	args.push(
		destination,
		`refs/heads/${options.branch}:refs/heads/${options.branch}`,
		`+${options.expectedHead}:refs/tags/${options.tag}`,
	);
	check(
		await runGit(args, {
			cwd: repoDir,
			token: options.token,
			authUrl: options.authUrl,
			extraEnv: pushExtraEnv,
			safeDirectory,
			identity,
		}),
		["git", ...args],
	);
	return { head, branch: options.branch };
}
