/**
 * POSIX file-mode helpers that Bun's `node:fs` gets wrong.
 *
 * Bun's `fs.chmodSync` masks the mode to `0o777`, silently dropping the
 * setgid/setuid/sticky bits, and `fs.chownSync(p, -1, gid)` rewrites the
 * owner instead of leaving it unchanged. The shared clone pool relies on
 * setgid directories (`02770`), so mode changes go straight to libc.
 */
import * as fs from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

interface LibcChmod {
	chmod(path: Uint8Array, mode: number): number;
}

let libc: LibcChmod | null | undefined;

function loadLibc(): LibcChmod | null {
	if (libc !== undefined) return libc;
	const candidates = process.platform === "darwin" ? ["libc.dylib", "libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const name of candidates) {
		try {
			const lib = dlopen(name, { chmod: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
			libc = lib.symbols as unknown as LibcChmod;
			return libc;
		} catch {}
	}
	libc = null;
	return libc;
}

/** `chmod(2)` preserving the special bits (setgid/setuid/sticky). */
export function chmodFull(target: string, mode: number): void {
	const lib = loadLibc();
	if (lib === null || (mode & 0o7000) === 0) {
		fs.chmodSync(target, mode);
		return;
	}
	const rc = lib.chmod(new TextEncoder().encode(`${target}\0`), mode & 0o7777);
	if (rc !== 0) fs.chmodSync(target, mode & 0o777);
}
