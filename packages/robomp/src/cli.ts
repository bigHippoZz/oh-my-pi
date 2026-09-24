#!/usr/bin/env bun
/**
 * robomp command-line interface (Python `click` group analogue).
 *
 *   robomp serve                         webhook receiver + worker pool
 *   robomp triage OWNER/REPO#NN          queue a live issue as if a webhook arrived
 *   robomp replay DELIVERY_ID            re-enqueue a stored event
 *   robomp status                        dump issue and release state
 *   robomp cleanup ISSUE_KEY             force-remove an issue's workspace
 *   robomp proxy serve                   run the HMAC-authenticated gh-proxy
 */
import { getSettings, loadProxySettings, type Settings } from "./config";
import { type EventRow, getDatabase, INACTIVE_EVENT_STATES } from "./db";
import { configureLogging } from "./logging";
import {
	awaitTerminalState,
	enqueueManualTriage,
	InvalidIssueRef,
	ManualTriageError,
	ManualTriageTimeout,
	parseIssueRef,
} from "./manual-triage";
import { GitHubProxyClient } from "./proxy-client";
import { createProxyApp } from "./proxy/server";
import { SandboxManager } from "./sandbox";
import { ConfigurationExit, createApp, requireProxyMode } from "./server";

const MAIN_HELP = `Usage: robomp [OPTIONS] COMMAND [ARGS]...

  roboomp control surface.

Options:
  --help  Show this message and exit.

Commands:
  cleanup  Force-remove the workspace for an issue (does not touch the remote).
  proxy    gh-proxy control surface.
  replay   Re-enqueue a stored event so the running \`serve\` pool can pick it up.
  serve    Run the webhook receiver + worker pool.
  status   Dump issue and release state.
  triage   Fetch a live issue and queue it as if a webhook arrived.
`;

const PROXY_HELP = `Usage: robomp proxy [OPTIONS] COMMAND [ARGS]...

  gh-proxy control surface.

Options:
  --help  Show this message and exit.

Commands:
  serve  Run the HMAC-authenticated GitHub proxy.
`;

/** Early exit with a status code (click `sys.exit`). */
class CliExit extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

function echo(text = ""): void {
	process.stdout.write(`${text}\n`);
}

function echoErr(text: string): void {
	process.stderr.write(`${text}\n`);
}

function usageError(usage: string, message: string): never {
	echoErr(`${usage}\nTry 'robomp --help' for help.\n\nError: ${message}`);
	throw new CliExit(2);
}

function settingsOrDie(): Settings {
	try {
		return getSettings();
	} catch (err) {
		echoErr(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
		throw new CliExit(2);
	}
}

function defaultWaitTimeout(cfg: Settings): number {
	return cfg.task_timeout_seconds + cfg.task_timeout_hard_grace_seconds + 30;
}

/** Python `json.dumps(obj, indent=2)` for the small flat objects we print. */
function dumps(value: Record<string, unknown>): string {
	return JSON.stringify(value, null, 2);
}

interface CommandArgs {
	positional: string[];
	waitTimeout: number | null;
}

function parseArgs(argv: string[], usage: string, options: { waitTimeout?: boolean } = {}): CommandArgs {
	const positional: string[] = [];
	let waitTimeout: number | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (options.waitTimeout && (arg === "--wait-timeout" || arg.startsWith("--wait-timeout="))) {
			const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
			if (raw === undefined) usageError(usage, "Option '--wait-timeout' requires an argument.");
			const value = Number(raw);
			if (raw.trim() === "" || Number.isNaN(value)) {
				usageError(usage, `Invalid value for '--wait-timeout': '${raw}' is not a valid float.`);
			}
			if (value < 0.1) {
				usageError(usage, `Invalid value for '--wait-timeout': ${raw} is not in the range x>=0.1.`);
			}
			waitTimeout = value;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") usageError(usage, `No such option: ${arg}`);
		positional.push(arg);
	}
	return { positional, waitTimeout };
}

function requireArgument(args: CommandArgs, usage: string, name: string): string {
	if (args.positional.length === 0) usageError(usage, `Missing argument '${name}'.`);
	if (args.positional.length > 1) usageError(usage, `Got unexpected extra argument (${args.positional[1]})`);
	return args.positional[0]!;
}

function printTerminal(delivery: string, final: EventRow | null): void {
	if (final === null) {
		echo(dumps({ delivery, state: "missing" }));
		return;
	}
	echo(dumps({ delivery, state: final.state, error: final.last_error }));
}

async function waitTerminal(cfg: Settings, delivery: string, waitTimeout: number | null): Promise<void> {
	const db = getDatabase(cfg.sqlite_path);
	const timeout = waitTimeout ?? defaultWaitTimeout(cfg);
	let final: EventRow | null;
	try {
		final = await awaitTerminalState(db, delivery, { timeout });
	} catch (err) {
		if (err instanceof ManualTriageTimeout) {
			echoErr(dumps({ delivery, state: err.state, timed_out: true, error: err.message }));
			throw new CliExit(1);
		}
		throw err;
	}
	printTerminal(delivery, final);
}

/** Resolve on SIGINT/SIGTERM. */
function shutdownSignal(): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const handler = (signal: string) => resolve(signal);
	process.once("SIGINT", handler);
	process.once("SIGTERM", handler);
	return promise;
}

async function serve(): Promise<void> {
	const cfg = settingsOrDie();
	configureLogging(cfg.log_dir);
	cfg.ensurePaths();
	const server = createApp(cfg);
	await server.start();
	const http = Bun.serve({ hostname: cfg.bind_host, port: cfg.bind_port, fetch: server.fetch, idleTimeout: 0 });
	echoErr(`robomp listening on http://${cfg.bind_host}:${http.port}`);
	await shutdownSignal();
	await http.stop();
	await server.stop();
}

async function triage(argv: string[]): Promise<void> {
	const usage = "Usage: robomp triage [OPTIONS] ISSUE_REF";
	const args = parseArgs(argv, usage, { waitTimeout: true });
	const issueRef = requireArgument(args, usage, "ISSUE_REF");
	const cfg = settingsOrDie();
	configureLogging(cfg.log_dir);
	cfg.ensurePaths();
	let repoFull: string;
	let number: number;
	try {
		[repoFull, number] = parseIssueRef(issueRef);
	} catch (err) {
		if (err instanceof InvalidIssueRef) {
			echoErr(err.message);
			throw new CliExit(2);
		}
		throw err;
	}
	if (!cfg.allows(repoFull)) {
		echoErr(`refusing: ${repoFull} not in ROBOMP_REPO_ALLOWLIST`);
		throw new CliExit(2);
	}
	const [baseUrl, key] = requireProxyMode(cfg);
	const github = new GitHubProxyClient({ baseUrl, hmacKey: key });
	const db = getDatabase(cfg.sqlite_path);
	let delivery: string;
	try {
		delivery = await enqueueManualTriage({ db, github, repoFull, number });
	} catch (err) {
		if (err instanceof ManualTriageError) {
			echoErr(`refusing: ${err.message}`);
			throw new CliExit(2);
		}
		throw err;
	}
	// The dispatcher lives in the long-running `serve` process; we only watch
	// the row land in a terminal state (wake latency ≤ the 10s dispatch poll).
	echo(dumps({ delivery, state: "queued" }));
	await waitTerminal(cfg, delivery, args.waitTimeout);
}

async function replay(argv: string[]): Promise<void> {
	const usage = "Usage: robomp replay [OPTIONS] DELIVERY_ID";
	const args = parseArgs(argv, usage, { waitTimeout: true });
	const deliveryId = requireArgument(args, usage, "DELIVERY_ID");
	const cfg = settingsOrDie();
	configureLogging(cfg.log_dir);
	cfg.ensurePaths();
	const db = getDatabase(cfg.sqlite_path);
	const row = db.getEvent(deliveryId);
	if (row === null) {
		echoErr(`unknown delivery: ${deliveryId}`);
		throw new CliExit(2);
	}
	if (!db.requeueEvent(deliveryId, { from_states: INACTIVE_EVENT_STATES })) {
		echoErr(`delivery ${deliveryId} is ${row.state}; only inactive events can be replayed`);
		throw new CliExit(2);
	}
	await waitTerminal(cfg, deliveryId, args.waitTimeout);
}

function status(argv: string[]): void {
	parseArgs(argv, "Usage: robomp status [OPTIONS]");
	const cfg = settingsOrDie();
	cfg.ensurePaths();
	const db = getDatabase(cfg.sqlite_path);
	const issueRows = db.listIssues();
	for (const row of issueRows) {
		echo(
			`${row.key.padEnd(40)} state=${row.state.padEnd(12)} pr=${row.pr_number || "-"} ` +
				`branch=${row.branch || "-"} updated=${row.updated_at}`,
		);
	}
	const releaseRows = db.listReleases();
	if (releaseRows.length > 0) {
		if (issueRows.length > 0) echo();
		echo("Releases:");
	}
	for (const row of releaseRows) {
		const error = row.last_error ? ` error=${row.last_error}` : "";
		echo(
			`${row.key.padEnd(40)} state=${row.state.padEnd(12)} rounds=${String(row.rounds).padEnd(2)} ` +
				`sha=${row.current_sha.slice(0, 12)} updated=${row.updated_at}${error}`,
		);
	}
}

async function cleanup(argv: string[]): Promise<void> {
	const usage = "Usage: robomp cleanup [OPTIONS] ISSUE_KEY";
	const key = requireArgument(parseArgs(argv, usage), usage, "ISSUE_KEY");
	const cfg = settingsOrDie();
	cfg.ensurePaths();
	const db = getDatabase(cfg.sqlite_path);
	const row = db.getIssue(key);
	if (row === null) {
		echoErr(`unknown issue: ${key}`);
		throw new CliExit(2);
	}
	await new SandboxManager(cfg.workspace_root).removeWorkspace({ repo: row.repo, number: row.number });
	db.setIssueState(key, "abandoned");
	echo(`cleaned up ${key}`);
}

/**
 * `robomp proxy serve`: loads proxy-only settings so the gh-proxy container
 * only needs `GITHUB_TOKEN` + `ROBOMP_GH_PROXY_HMAC_KEY`.
 */
async function proxyServe(): Promise<void> {
	let cfg: Settings;
	try {
		cfg = loadProxySettings();
	} catch (err) {
		echoErr(`gh-proxy configuration error: ${err instanceof Error ? err.message : String(err)}`);
		throw new CliExit(2);
	}
	configureLogging(cfg.log_dir);
	cfg.ensurePaths();
	if (cfg.github_token === null) {
		echoErr("gh-proxy: GITHUB_TOKEN is required in proxy mode");
		throw new CliExit(2);
	}
	if (cfg.gh_proxy_hmac_key === null) {
		echoErr("gh-proxy: ROBOMP_GH_PROXY_HMAC_KEY is required in proxy mode");
		throw new CliExit(2);
	}
	const app = createProxyApp(cfg);
	const http = Bun.serve({
		hostname: cfg.gh_proxy_bind_host,
		port: cfg.gh_proxy_bind_port,
		fetch: app.fetch,
		idleTimeout: 0,
	});
	echoErr(`gh-proxy listening on http://${cfg.gh_proxy_bind_host}:${http.port}`);
	await shutdownSignal();
	await http.stop();
}

async function proxy(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	if (command === undefined || command === "--help") {
		echo(PROXY_HELP.trimEnd());
		return;
	}
	if (command === "serve") {
		parseArgs(rest, "Usage: robomp proxy serve [OPTIONS]");
		await proxyServe();
		return;
	}
	usageError("Usage: robomp proxy [OPTIONS] COMMAND [ARGS]...", `No such command '${command}'.`);
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	try {
		switch (command) {
			case undefined:
			case "--help":
				echo(MAIN_HELP.trimEnd());
				return 0;
			case "serve":
				parseArgs(rest, "Usage: robomp serve [OPTIONS]");
				await serve();
				return 0;
			case "triage":
				await triage(rest);
				return 0;
			case "replay":
				await replay(rest);
				return 0;
			case "status":
				status(rest);
				return 0;
			case "cleanup":
				await cleanup(rest);
				return 0;
			case "proxy":
				await proxy(rest);
				return 0;
			default:
				usageError("Usage: robomp [OPTIONS] COMMAND [ARGS]...", `No such command '${command}'.`);
		}
	} catch (err) {
		if (err instanceof CliExit) return err.code;
		if (err instanceof ConfigurationExit) {
			echoErr(err.message);
			return 1;
		}
		throw err;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
