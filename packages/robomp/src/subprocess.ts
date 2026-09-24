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
import { ptree } from "@oh-my-pi/pi-utils";

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

async function runImpl(argv: readonly string[], options: RunOptions = {}): Promise<CompletedProcess> {
	const cmd = options.identity ? wrapWithIdentity(argv, options.identity) : [...argv];
	const timeoutSeconds = options.timeout === undefined ? DEFAULT_SUBPROCESS_TIMEOUT_SECONDS : options.timeout;
	try {
		const result = await ptree.exec(cmd, {
			cwd: options.cwd ?? undefined,
			env: cleanEnv(options.env) ?? cleanEnv(process.env),
			timeout: timeoutSeconds === null ? undefined : Math.max(1, Math.round(timeoutSeconds * 1000)),
			input: options.input,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full",
		});
		const timedOut = result.exitError instanceof ptree.TimeoutError;
		return {
			args: [...argv],
			returncode: timedOut ? 124 : (result.exitCode ?? -1),
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut,
		};
	} catch (err) {
		// Spawn failures (missing binary, bad cwd) mirror Python's OSError surface
		// as a failed process so callers keep a single error path.
		const message = err instanceof Error ? err.message : String(err);
		return { args: [...argv], returncode: 127, stdout: "", stderr: message, timedOut: false };
	}
}

/** Spawn seam (tests `spyOn(processRunner, "run")`). */
export const processRunner = {
	run: runImpl,
};

/** Run `argv` and capture output; never throws for a non-zero exit. */
export function runProcess(argv: readonly string[], options?: RunOptions): Promise<CompletedProcess> {
	return processRunner.run(argv, options);
}

/** Copy of `process.env` without undefined values. */
export function processEnv(): Record<string, string> {
	return cleanEnv(process.env) ?? {};
}
