/**
 * Content-addressed cache of pre-built `packages/natives/native/` artifacts.
 *
 * 1. Computes a deterministic key from the git tree-hashes of the inputs that
 *    determine the build output, plus the target triple.
 * 2. On workspace populate: hardlinks cached `.node` files (and copies the
 *    companions) into the worktree's `packages/natives/native/`.
 * 3. On successful task exit: captures freshly-built artifacts into the cache.
 *
 * Layout and manifest format match the Python implementation so an existing
 * `/data/cache/pi-natives` tree stays valid.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "./logging";
import { pyJsonDumps, pyRepr } from "./pycompat";
import { acquireExclusiveFlock, chmodFull, isOSError, rmtreeIgnoreErrorsSync } from "./posix";
import { CalledProcessError, processEnv, runProcess, TimeoutExpired } from "./subprocess";

const log = getLogger("robomp.natives_cache");

/** Paths whose git tree-hash feeds the cache key. Order is significant. */
export const CACHE_KEY_PATHS: readonly string[] = [
	"crates",
	"Cargo.lock",
	"Cargo.toml",
	"rust-toolchain.toml",
	"packages/natives",
];

/** `fnmatch("pi_natives.*.node")`: `*` spans any character, newlines included. */
const CACHED_NODE_RE = /^pi_natives\.[\s\S]*\.node$/;
export const CACHED_COMPANION_FILES: readonly string[] = ["index.d.ts", "index.js", "embedded-addon.js"];
const MANIFEST_FILENAME = "manifest.json";
const LOCKFILE_NAME = ".lock";
const NULL_TREE_HASH = "0".repeat(40);

function normalizePlatform(): string {
	const p = process.platform;
	if (p === "linux" || p === "darwin" || p === "win32") return p;
	return p;
}

function normalizeArch(): string {
	const a = process.arch;
	if (a === "x64") return "x64";
	if (a === "arm64") return "arm64";
	return a;
}

/** `<platform>-<arch>[-<variant>]` matching the napi addon basename. */
export function targetTriple(): string {
	const plat = normalizePlatform();
	const arch = normalizeArch();
	if (arch !== "x64") return `${plat}-${arch}`;
	const variant = (process.env.TARGET_VARIANT ?? "").trim() || "host";
	return `${plat}-${arch}-${variant}`;
}

function gitSafeDirectoryEnv(repoDir: string): Record<string, string> {
	const env = processEnv();
	const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
	env[`GIT_CONFIG_KEY_${count}`] = "safe.directory";
	env[`GIT_CONFIG_VALUE_${count}`] = repoDir;
	env.GIT_CONFIG_COUNT = String(count + 1);
	return env;
}

/**
 * Python's `RuntimeError` from `compute_key`: `git cat-file` answered with
 * the wrong number of lines. A failing `git` itself raises
 * `CalledProcessError` (timeout: `TimeoutExpired`; spawn failure:
 * `ProcessSpawnError`).
 */
export class NativesKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NativesKeyError";
	}
}

/**
 * Deterministic sha256 over the git tree-hashes of cache-key paths.
 *
 * Throws `CalledProcessError` if `git` itself fails (e.g. not a repo) —
 * callers SHOULD treat that as "no cache" and proceed.
 */
export async function computeKey(repoDir: string, target?: string): Promise<string> {
	const tgt = target ?? targetTriple();
	const stdin = CACHE_KEY_PATHS.map(p => `HEAD:${p}\n`).join("");
	const cmd = ["git", "cat-file", "--batch-check"];
	const timeout = 120;
	const proc = await runProcess(cmd, {
		cwd: repoDir,
		input: stdin,
		env: gitSafeDirectoryEnv(repoDir),
		timeout,
	});
	if (proc.timedOut) throw new TimeoutExpired(cmd, timeout, proc.stdout, proc.stderr);
	if (proc.returncode !== 0) throw new CalledProcessError(proc.returncode, cmd, proc.stdout, proc.stderr);
	const lines = pySplitlines(proc.stdout);
	if (lines.length !== CACHE_KEY_PATHS.length) {
		throw new NativesKeyError(
			`git cat-file returned ${lines.length} lines, expected ${CACHE_KEY_PATHS.length}: ${pyRepr(proc.stdout)}`,
		);
	}
	const hasher = new Bun.CryptoHasher("sha256");
	CACHE_KEY_PATHS.forEach((p, i) => {
		const stripped = lines[i]!.trim();
		// Python `"".split(None, 1)[0]` raises IndexError.
		if (stripped === "") throw new RangeError("list index out of range");
		const treeHash = stripped.endsWith("missing") ? NULL_TREE_HASH : stripped.split(/\s+/, 1)[0]!;
		hasher.update(`${p}\t${treeHash}\n`);
	});
	hasher.update(`TARGET\t${tgt}\n`);
	return hasher.digest("hex");
}

/** Python `str.splitlines()` (the line boundaries git output can contain). */
function pySplitlines(text: string): string[] {
	const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function repoSlug(repo: string): string {
	return repo.replaceAll("/", "__");
}

function tmpSibling(dst: string): string {
	return `${dst}.tmp.${process.pid}`;
}

/** Hardlink `src` → `dst`, replacing `dst` atomically; copies on EXDEV. */
export function atomicLink(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	const tmp = tmpSibling(dst);
	try {
		try {
			fs.linkSync(src, tmp);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
			fs.copyFileSync(src, tmp);
		}
		fs.renameSync(tmp, dst);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** Copy `src` → `dst` via a sibling temp file + rename (fresh inode). */
export function atomicCopy(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	const tmp = tmpSibling(dst);
	try {
		fs.copyFileSync(src, tmp);
		const st = fs.statSync(src);
		fs.utimesSync(tmp, st.atime, st.mtime);
		chmodFull(tmp, st.mode & 0o7777);
		fs.renameSync(tmp, dst);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** Exclusive `flock` on `lockPath` around `fn` (Python `_flock`; waits indefinitely). */
async function withFlock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
	const release = await acquireExclusiveFlock(lockPath);
	try {
		return await fn();
	} finally {
		release();
	}
}

function listNodeFiles(dir: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter(name => CACHED_NODE_RE.test(name))
		.sort()
		.map(name => path.join(dir, name));
}

/** Files copied/linked into the workspace by `populateWorkspace`. */
export interface CacheHit {
	cache_dir: string;
	files: readonly string[];
}

/** Per-repo content-addressed cache of pi-natives build outputs. */
export class NativesCache {
	readonly root: string;
	readonly maxEntriesPerRepo: number;
	readonly maxBytes: number;

	constructor(root: string, options: { maxEntriesPerRepo?: number; maxBytes?: number } = {}) {
		this.root = root;
		this.maxEntriesPerRepo = Math.max(1, options.maxEntriesPerRepo ?? 8);
		this.maxBytes = Math.max(0, options.maxBytes ?? 4 * 1024 ** 3);
		fs.mkdirSync(root, { recursive: true });
	}

	repoRoot(repo: string): string {
		return path.join(this.root, repoSlug(repo));
	}

	entryDir(repo: string, key: string): string {
		return path.join(this.repoRoot(repo), key);
	}

	lockfile(repo: string): string {
		return path.join(this.repoRoot(repo), LOCKFILE_NAME);
	}

	/** Return the cache directory if `key` is present and complete. */
	lookup(repo: string, key: string): string | null {
		const entry = this.entryDir(repo, key);
		if (!fs.existsSync(path.join(entry, MANIFEST_FILENAME))) return null;
		if (listNodeFiles(entry).length === 0) return null;
		for (const name of CACHED_COMPANION_FILES) {
			if (!fs.existsSync(path.join(entry, name))) return null;
		}
		return entry;
	}

	/** Hardlink the `.node`, copy companions, into `nativeDir`. Null on miss. */
	populateWorkspace(repo: string, key: string, nativeDir: string): CacheHit | null {
		const entry = this.lookup(repo, key);
		if (entry === null) return null;
		fs.mkdirSync(nativeDir, { recursive: true });
		const copied: string[] = [];
		for (const src of listNodeFiles(entry)) {
			const dst = path.join(nativeDir, path.basename(src));
			atomicLink(src, dst);
			copied.push(dst);
		}
		for (const name of CACHED_COMPANION_FILES) {
			const dst = path.join(nativeDir, name);
			atomicCopy(path.join(entry, name), dst);
			copied.push(dst);
		}
		return { cache_dir: entry, files: copied };
	}

	/** Atomically capture `nativeDir` contents under `key`. */
	async capture(
		repo: string,
		key: string,
		nativeDir: string,
		options: { sourceWorkspace?: string | null; commit?: string | null } = {},
	): Promise<string | null> {
		const nodeFiles = listNodeFiles(nativeDir);
		if (nodeFiles.length === 0) return null;
		for (const name of CACHED_COMPANION_FILES) {
			if (!fs.existsSync(path.join(nativeDir, name))) return null;
		}
		const repoRoot = this.repoRoot(repo);
		fs.mkdirSync(repoRoot, { recursive: true });
		return withFlock(this.lockfile(repo), () => {
			if (this.lookup(repo, key) !== null) return this.entryDir(repo, key);
			const final = this.entryDir(repo, key);
			const staging = path.join(repoRoot, `.${key}.tmp.${process.pid}`);
			rmtreeIgnoreErrorsSync(staging);
			fs.mkdirSync(staging, { recursive: true });
			try {
				for (const src of nodeFiles) atomicCopy(src, path.join(staging, path.basename(src)));
				for (const name of CACHED_COMPANION_FILES) {
					atomicCopy(path.join(nativeDir, name), path.join(staging, name));
				}
				const manifest = {
					captured_at: Date.now() / 1000,
					commit: options.commit ?? null,
					key,
					node_files: nodeFiles.map(src => path.basename(src)),
					source_workspace: options.sourceWorkspace ?? null,
					target: targetTriple(),
				};
				fs.writeFileSync(path.join(staging, MANIFEST_FILENAME), pyJsonDumps(manifest, { indent: 2 }));
				fs.renameSync(staging, final);
			} catch (err) {
				rmtreeIgnoreErrorsSync(staging);
				throw err;
			}
			this.#gcLocked(repo);
			return final;
		});
	}

	/** Evict entries beyond per-repo or total caps. Returns the evicted count. */
	async gc(repo?: string): Promise<number> {
		if (repo !== undefined) return withFlock(this.lockfile(repo), () => this.#gcLocked(repo));
		if (!fs.existsSync(this.root)) return 0;
		let total = 0;
		for (const child of fs.readdirSync(this.root, { withFileTypes: true })) {
			if (!isDirFollow(path.join(this.root, child.name))) continue;
			const repoName = child.name.replace("__", "/");
			try {
				total += await withFlock(this.lockfile(repoName), () => this.#gcLocked(repoName));
			} catch (err) {
				if (!isOSError(err)) throw err;
				log.warning("natives_cache gc skip", { repo: child.name, err: err.message });
			}
		}
		return total;
	}

	/** Caller MUST hold the per-repo lock. */
	#gcLocked(repo: string): number {
		const repoRoot = this.repoRoot(repo);
		if (!fs.existsSync(repoRoot)) return 0;
		const entries: { capturedAt: number; size: number; dir: string }[] = [];
		for (const child of fs.readdirSync(repoRoot, { withFileTypes: true })) {
			const childPath = path.join(repoRoot, child.name);
			if (!isDirFollow(childPath)) continue;
			if (child.name.startsWith(".")) {
				rmtreeIgnoreErrorsSync(childPath);
				continue;
			}
			const manifestPath = path.join(childPath, MANIFEST_FILENAME);
			if (!fs.existsSync(manifestPath)) {
				rmtreeIgnoreErrorsSync(childPath);
				continue;
			}
			let capturedAt = readCapturedAt(manifestPath);
			if (capturedAt === null) capturedAt = fs.statSync(manifestPath).mtimeMs / 1000;
			entries.push({ capturedAt, size: dirSize(childPath), dir: childPath });
		}
		entries.sort((a, b) => a.capturedAt - b.capturedAt);
		let evicted = 0;
		while (entries.length > this.maxEntriesPerRepo) {
			rmtreeIgnoreErrorsSync(entries.shift()!.dir);
			evicted++;
		}
		if (this.maxBytes > 0) {
			let total = entries.reduce((sum, e) => sum + e.size, 0);
			while (total > this.maxBytes && entries.length > 1) {
				const victim = entries.shift()!;
				rmtreeIgnoreErrorsSync(victim.dir);
				total -= victim.size;
				evicted++;
			}
		}
		return evicted;
	}
}

/** Python `Path.is_dir()`: follows symlinks, false on any error. */
function isDirFollow(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * `float(json.loads(manifest).get("captured_at", 0.0))`, or null where Python
 * falls back to the manifest mtime (`OSError`, `ValueError`, `JSONDecodeError`).
 * Values Python's `float()` rejects with `TypeError` (and a non-dict
 * manifest's `AttributeError`) propagate as `TypeError`.
 */
function readCapturedAt(manifestPath: string): number | null {
	let manifest: unknown;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch {
		return null;
	}
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
		const typeName =
			manifest === null
				? "NoneType"
				: Array.isArray(manifest)
					? "list"
					: typeof manifest === "string"
						? "str"
						: typeof manifest === "boolean"
							? "bool"
							: Number.isInteger(manifest)
								? "int"
								: "float";
		throw new TypeError(`'${typeName}' object has no attribute 'get'`);
	}
	const raw = "captured_at" in manifest ? (manifest as Record<string, unknown>).captured_at : 0;
	if (typeof raw === "number") return raw;
	if (typeof raw === "boolean") return raw ? 1 : 0;
	if (typeof raw === "string") {
		const text = raw.trim().replaceAll("_", "").toLowerCase();
		if (/^[+-]?(nan|inf|infinity)$/.test(text)) {
			return text.includes("nan") ? Number.NaN : text.startsWith("-") ? -Infinity : Infinity;
		}
		if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(text)) return Number(text);
		return null;
	}
	const typeName = raw === null ? "NoneType" : Array.isArray(raw) ? "list" : "dict";
	throw new TypeError(`float() argument must be a string or a real number, not '${typeName}'`);
}

/**
 * Sum of file sizes under `dir` (Python `os.walk` + `lstat`; errors
 * swallowed): symlinks to directories are neither counted nor descended.
 */
function dirSize(dir: string): number {
	let total = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isSymbolicLink() && isDirFollow(full)) continue;
			try {
				total += fs.lstatSync(full).size;
			} catch {}
		}
	}
	return total;
}
