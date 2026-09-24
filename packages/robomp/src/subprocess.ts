/**
 * Subprocess execution with optional slot identity.
 *
 * Python's `subprocess.run(user=, group=, extra_groups=, umask=)` has no Bun
 * equivalent: `Bun.spawn` silently ignores `uid`/`gid`. When a slot identity
 * is requested we therefore re-exec through `setpriv(1)` (util-linux), which
 * drops real+effective uid/gid and supplementary groups before `exec`, and a
 * tiny `sh` trampoline that applies the umask. Tests assert the resulting
 * child really runs as the slot uid.
 *
 * `processRunner.run` is the single spawn seam; tests `spyOn` it instead of
 * mutating globals.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { ptree } from "@oh-my-pi/pi-utils";
import { pyRepr } from "./pycompat";

export const SHARED_OMP_GID = 2000;
export const DEFAULT_SUBPROCESS_TIMEOUT_SECONDS = 120;

/** Target identity for a child process (`subprocess.run(user=..., ...)` analogue). */
export interface ProcessIdentity {
	uid: number;
	gid: number;
	groups: readonly number[];
	umask: number;
}

export interface RunOptions {
	cwd?: string | null;
	env?: Record<string, string | undefined>;
	/** Seconds; `null` disables the timeout. Defaults to 120s. */
	timeout?: number | null;
	input?: string;
	identity?: ProcessIdentity | null;
}

/** Result of a finished (or timed-out) subprocess. */
export interface CompletedProcess {
	args: string[];
	returncode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Host identity probes (spy seam: tests fake Linux/root without mutating `process`). */
export const platformInfo = {
	system: (): NodeJS.Platform => process.platform,
	geteuid: (): number => (typeof process.geteuid === "function" ? process.geteuid() : -1),
	getegid: (): number => (typeof process.getegid === "function" ? process.getegid() : -1),
};

export function currentEuid(): number {
	return platformInfo.geteuid();
}

export function currentEgid(): number {
	return platformInfo.getegid();
}

/** Slot identity switching only applies on Linux when running as root. */
export function slotPermissionsActive(slotUid: number | null | undefined): slotUid is number {
	return slotUid !== null && slotUid !== undefined && platformInfo.system() === "linux" && currentEuid() === 0;
}

/** Identity for commands that should run as a slot (`omp-N`), or null when inactive. */
export function slotIdentity(slotUid: number | null | undefined): ProcessIdentity | null {
	if (!slotPermissionsActive(slotUid)) return null;
	return { uid: slotUid, gid: slotUid, groups: [SHARED_OMP_GID], umask: 0o002 };
}

/** Build the argv that runs `argv` under `identity` via setpriv + umask trampoline. */
export function wrapWithIdentity(argv: readonly string[], identity: ProcessIdentity): string[] {
	const umask = identity.umask.toString(8).padStart(3, "0");
	return [
		"setpriv",
		`--reuid=${identity.uid}`,
		`--regid=${identity.gid}`,
		identity.groups.length > 0 ? `--groups=${identity.groups.join(",")}` : "--clear-groups",
		"--",
		"/bin/sh",
		"-c",
		`umask ${umask} && exec "$@"`,
		"sh",
		...argv,
	];
}

function cleanEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
	if (env === undefined) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
	return out;
}

/** Python `repr(float)` for the whole-second timeouts used by callers (`120` -> `120.0`). */
function pyFloat(value: number): string {
	return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Base of the `subprocess.SubprocessError` family (`CalledProcessError`, `TimeoutExpired`). */
export class SubprocessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubprocessError";
	}
}

/** Python `subprocess.CalledProcessError`: raised by `check=True` on a non-zero exit. */
export class CalledProcessError extends SubprocessError {
	readonly returncode: number;
	readonly cmd: string[];
	readonly stdout: string | null;
	readonly stderr: string | null;
	constructor(returncode: number, cmd: readonly string[], stdout: string | null = null, stderr: string | null = null) {
		super(CalledProcessError.format(returncode, cmd));
		this.name = "CalledProcessError";
		this.returncode = returncode;
		this.cmd = [...cmd];
		this.stdout = stdout;
		this.stderr = stderr;
	}

	/** `str(CalledProcessError)`, byte-for-byte. */
	static format(returncode: number, cmd: readonly string[]): string {
		const head = `Command '${pyRepr([...cmd])}'`;
		if (returncode >= 0) return `${head} returned non-zero exit status ${returncode}.`;
		const name = Object.entries(os.constants.signals).find(([, num]) => num === -returncode)?.[0];
		return name === undefined
			? `${head} died with unknown signal ${-returncode}.`
			: `${head} died with <Signals.${name}: ${-returncode}>.`;
	}
}

/** Python `subprocess.TimeoutExpired`. */
export class TimeoutExpired extends SubprocessError {
	readonly cmd: string[];
	readonly timeout: number;
	readonly stdout: string | null;
	readonly stderr: string | null;
	constructor(cmd: readonly string[], timeout: number, stdout: string | null = null, stderr: string | null = null) {
		super(`Command '${pyRepr([...cmd])}' timed out after ${pyFloat(timeout)} seconds`);
		this.name = "TimeoutExpired";
		this.cmd = [...cmd];
		this.timeout = timeout;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

const STRERROR: Record<string, string> = {
	EPERM: "Operation not permitted",
	ENOENT: "No such file or directory",
	E2BIG: "Argument list too long",
	ENOEXEC: "Exec format error",
	EAGAIN: "Resource temporarily unavailable",
	ENOMEM: "Cannot allocate memory",
	EACCES: "Permission denied",
	ENOTDIR: "Not a directory",
	EISDIR: "Is a directory",
	ETXTBSY: "Text file busy",
	ENAMETOOLONG: "File name too long",
	ELOOP: "Too many levels of symbolic links",
};

/**
 * Python `OSError` raised by `subprocess.run` when the child cannot start
 * (missing executable, missing/non-directory `cwd`, not executable). Python
 * propagates it from `_run`/`_safe_run`/`_run_git`; callers that need the
 * `FileNotFoundError` case check `code === "ENOENT"`.
 */
export class ProcessSpawnError extends Error {
	/** Positive errno (Python `OSError.errno`). */
	readonly errno: number;
	/** Symbolic errno (`ENOENT`, `EACCES`, ...). */
	readonly code: string;
	readonly strerror: string;
	readonly filename: string;
	constructor(code: string, filename: string) {
		const errno = (os.constants.errno as Record<string, number | undefined>)[code] ?? 0;
		const strerror = STRERROR[code] ?? code;
		super(`[Errno ${errno}] ${strerror}: ${pyRepr(filename)}`);
		this.name = "ProcessSpawnError";
		this.errno = errno;
		this.code = code;
		this.strerror = strerror;
		this.filename = filename;
	}
}

function errnoCode(err: unknown): string | null {
	if (!(err instanceof Error)) return null;
	const code = (err as NodeJS.ErrnoException).code;
	return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : null;
}

/**
 * The child's `chdir(cwd)` runs before `exec`, so a bad `cwd` is what Python
 * reports even when the executable is also missing.
 */
function cwdSpawnError(cwd: string | null | undefined): ProcessSpawnError | null {
	if (!cwd) return null;
	let st: fs.Stats;
	try {
		st = fs.statSync(cwd);
	} catch (err) {
		return new ProcessSpawnError(errnoCode(err) ?? "ENOENT", cwd);
	}
	return st.isDirectory() ? null : new ProcessSpawnError("ENOTDIR", cwd);
}

async function runImpl(argv: readonly string[], options: RunOptions = {}): Promise<CompletedProcess> {
	const env = cleanEnv(options.env) ?? cleanEnv(process.env);
	if (options.identity) {
		// The setpriv/sh trampoline would turn a missing cwd or executable into
		// a shell exit 127; Python's `subprocess.run(user=...)` raises instead.
		const cwdErr = cwdSpawnError(options.cwd);
		if (cwdErr) throw cwdErr;
		const exe = argv[0];
		if (exe !== undefined && Bun.which(exe, { PATH: env?.PATH ?? "", cwd: options.cwd ?? undefined }) === null) {
			throw new ProcessSpawnError("ENOENT", exe);
		}
	}
	const cmd = options.identity ? wrapWithIdentity(argv, options.identity) : [...argv];
	const timeoutSeconds = options.timeout === undefined ? DEFAULT_SUBPROCESS_TIMEOUT_SECONDS : options.timeout;
	let result: ptree.ExecResult;
	try {
		result = await ptree.exec(cmd, {
			cwd: options.cwd ?? undefined,
			env,
			timeout: timeoutSeconds === null ? undefined : Math.max(1, Math.round(timeoutSeconds * 1000)),
			input: options.input,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
		});
	} catch (err) {
		// Spawn failures surface like Python's `OSError` from `subprocess.run`.
		const code = errnoCode(err);
		if (code === null) throw err;
		throw cwdSpawnError(options.cwd) ?? new ProcessSpawnError(code, argv[0] ?? "");
	}
	const timedOut = result.exitError instanceof ptree.TimeoutError;
	return {
		args: [...argv],
		returncode: timedOut ? 124 : (result.exitCode ?? -1),
		stdout: result.stdout,
		stderr: result.stderr,
		timedOut,
	};
}

/** Spawn seam (tests `spyOn(processRunner, "run")`). */
export const processRunner = {
	run: runImpl,
};

/**
 * Run `argv` and capture output. Never throws for a non-zero exit or a
 * timeout (see `timedOut`); throws `ProcessSpawnError` when the child cannot
 * start, like Python's `subprocess.run` raising `OSError`.
 */
export function runProcess(argv: readonly string[], options?: RunOptions): Promise<CompletedProcess> {
	return processRunner.run(argv, options);
}

/** Copy of `process.env` without undefined values. */
export function processEnv(): Record<string, string> {
	return cleanEnv(process.env) ?? {};
}
