/**
 * POSIX helpers that Bun's `node:fs` gets wrong or lacks.
 *
 * - Bun's `fs.chmodSync` masks the mode to `0o777`, silently dropping the
 *   setgid/setuid/sticky bits, and `fs.chownSync(p, -1, gid)` rewrites the
 *   owner instead of leaving it unchanged. The shared clone pool relies on
 *   setgid directories (`02770`), so mode changes go straight to libc.
 * - `flock(2)` has no Node/Bun binding; the natives cache must interlock with
 *   the Python implementation's `fcntl.flock` on the same lockfile.
 * - `shutil.rmtree(..., ignore_errors=True)`: best-effort removal that keeps
 *   going past failures instead of aborting on the first one.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dlopen, FFIType, type Pointer, read } from "bun:ffi";

const LIBC_CANDIDATES = process.platform === "darwin" ? ["libc.dylib", "libSystem.B.dylib"] : ["libc.so.6", "libc.so"];

interface LibcChmod {
	chmod(path: Uint8Array, mode: number): number;
}

let libcChmod: LibcChmod | null | undefined;

function loadLibcChmod(): LibcChmod | null {
	if (libcChmod !== undefined) return libcChmod;
	for (const name of LIBC_CANDIDATES) {
		try {
			const lib = dlopen(name, { chmod: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
			libcChmod = lib.symbols as unknown as LibcChmod;
			return libcChmod;
		} catch {}
	}
	libcChmod = null;
	return libcChmod;
}

/** `chmod(2)` preserving the special bits (setgid/setuid/sticky). */
export function chmodFull(target: string, mode: number): void {
	const lib = loadLibcChmod();
	if (lib === null || (mode & 0o7000) === 0) {
		fs.chmodSync(target, mode);
		return;
	}
	const rc = lib.chmod(new TextEncoder().encode(`${target}\0`), mode & 0o7777);
	if (rc !== 0) fs.chmodSync(target, mode & 0o777);
}

// ---------- flock(2) ----------

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

interface LibcFlock {
	flock(fd: number, operation: number): number;
	errno(): number;
}

let libcFlock: LibcFlock | null | undefined;

function loadLibcFlock(): LibcFlock | null {
	if (libcFlock !== undefined) return libcFlock;
	const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
	for (const name of LIBC_CANDIDATES) {
		try {
			const lib = dlopen(name, {
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				[errnoSymbol]: { args: [], returns: FFIType.ptr },
			});
			const symbols = lib.symbols as unknown as Record<string, (...args: number[]) => number | Pointer | null>;
			const flock = symbols.flock as (fd: number, operation: number) => number;
			const errnoLocation = symbols[errnoSymbol] as () => Pointer | null;
			libcFlock = {
				flock,
				errno: () => {
					const ptr = errnoLocation();
					return ptr === null ? 0 : read.i32(ptr, 0);
				},
			};
			return libcFlock;
		} catch {}
	}
	libcFlock = null;
	return libcFlock;
}

function errnoError(errno: number, syscall: string, target: string): NodeJS.ErrnoException {
	const code = Object.entries(os.constants.errno).find(([, num]) => num === errno)?.[0] ?? "EIO";
	const err: NodeJS.ErrnoException = new Error(`${code}: ${syscall} failed on '${target}'`);
	err.code = code;
	err.errno = errno;
	err.syscall = syscall;
	err.path = target;
	return err;
}

/**
 * Exclusive `flock(fd, LOCK_EX)` on `lockPath` (created if missing), waiting
 * indefinitely like Python's blocking `fcntl.flock`. The wait polls
 * `LOCK_EX | LOCK_NB` so the event loop keeps running. Locks taken through
 * separate calls conflict even within one process (flock locks belong to the
 * open file description), and interlock with any other `flock` holder.
 *
 * Returns the release function (`LOCK_UN` then close).
 */
export async function acquireExclusiveFlock(lockPath: string, pollMs = 25): Promise<() => void> {
	const lib = loadLibcFlock();
	if (lib === null) throw new Error("flock(2) is unavailable on this platform");
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const fd = fs.openSync(lockPath, "a+");
	const retryable = new Set([os.constants.errno.EWOULDBLOCK, os.constants.errno.EAGAIN, os.constants.errno.EINTR]);
	try {
		for (;;) {
			if (lib.flock(fd, LOCK_EX | LOCK_NB) === 0) break;
			const errno = lib.errno();
			if (!retryable.has(errno)) throw errnoError(errno, "flock", lockPath);
			await Bun.sleep(pollMs);
		}
	} catch (err) {
		fs.closeSync(fd);
		throw err;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			lib.flock(fd, LOCK_UN);
		} finally {
			fs.closeSync(fd);
		}
	};
}

// ---------- OSError classification ----------

/**
 * True for errors Python would raise as `OSError`: Node/Bun system errors
 * (`code` like `ENOENT` plus a numeric `errno`), including spawn failures.
 */
export function isOSError(err: unknown): err is NodeJS.ErrnoException {
	if (!(err instanceof Error)) return false;
	const { code, errno } = err as NodeJS.ErrnoException;
	return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) && typeof errno === "number";
}

// ---------- shutil.rmtree(ignore_errors=True) ----------

function lstatOrNullSync(p: string): fs.Stats | null {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
	try {
		return await fs.promises.lstat(p);
	} catch {
		return null;
	}
}

function purgeTreeSync(dir: string): void {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir);
	} catch {}
	for (const name of names) {
		const child = path.join(dir, name);
		const st = lstatOrNullSync(child);
		if (st?.isDirectory()) {
			purgeTreeSync(child);
			continue;
		}
		try {
			fs.unlinkSync(child);
		} catch {}
	}
	try {
		fs.rmdirSync(dir);
	} catch {}
}

async function purgeTree(dir: string): Promise<void> {
	let names: string[] = [];
	try {
		names = await fs.promises.readdir(dir);
	} catch {}
	for (const name of names) {
		const child = path.join(dir, name);
		const st = await lstatOrNull(child);
		if (st?.isDirectory()) {
			await purgeTree(child);
			continue;
		}
		try {
			await fs.promises.unlink(child);
		} catch {}
	}
	try {
		await fs.promises.rmdir(dir);
	} catch {}
}

/**
 * `shutil.rmtree(target, ignore_errors=True)`: remove everything removable
 * and swallow every error. Like Python, a symlink (or non-directory) root is
 * left untouched, and a failure on one entry does not stop the rest.
 */
export function rmtreeIgnoreErrorsSync(target: string): void {
	const st = lstatOrNullSync(target);
	if (!st?.isDirectory()) return;
	try {
		fs.rmSync(target, { recursive: true, force: true });
		return;
	} catch {}
	purgeTreeSync(target);
}

/** Async `rmtreeIgnoreErrorsSync` (keeps the event loop free on large trees). */
export async function rmtreeIgnoreErrors(target: string): Promise<void> {
	const st = await lstatOrNull(target);
	if (!st?.isDirectory()) return;
	try {
		await fs.promises.rm(target, { recursive: true, force: true });
		return;
	} catch {}
	await purgeTree(target);
}
