/** Shared test fixtures (pytest `conftest.py` analogue). */
import { afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type EnvSource, Settings } from "../src/config";
import { Database } from "../src/db";

const cleanups: (() => void)[] = [];

afterEach(() => {
	while (cleanups.length > 0) {
		try {
			cleanups.pop()!();
		} catch {}
	}
});

/** Register a cleanup that runs after the current test. */
export function onCleanup(fn: () => void): void {
	cleanups.push(fn);
}

/** Fresh temp dir removed after the test (pytest `tmp_path`). */
export function tmpPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robomp-test-"));
	onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export function baselineEnv(tmp: string): Record<string, string> {
	return {
		ROBOMP_GH_PROXY_URL: "http://gh-proxy.invalid:8081",
		ROBOMP_GH_PROXY_HMAC_KEY: "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
		ROBOMP_BOT_LOGIN: "robomp-bot",
		ROBOMP_GIT_AUTHOR_NAME: "robomp-bot",
		ROBOMP_GIT_AUTHOR_EMAIL: "robomp-bot@example.invalid",
		ROBOMP_REPO_ALLOWLIST: "octo/widget",
		ROBOMP_MODEL: "anthropic/claude-sonnet-4-5",
		ROBOMP_THINKING: "high",
		ROBOMP_WORKSPACE_ROOT: path.join(tmp, "workspaces"),
		ROBOMP_SQLITE_PATH: path.join(tmp, "robomp.sqlite"),
		ROBOMP_LOG_DIR: path.join(tmp, "logs"),
		ROBOMP_NATIVES_CACHE_ROOT: path.join(tmp, "natives-cache"),
		ROBOMP_NATIVES_CACHE_ENABLED: "false",
		ROBOMP_ISSUE_INDEX_SYNC_SECONDS: "0",
		GITHUB_TOKEN: "",
		ROBOMP_REPLAY_TOKEN: "",
	};
}

/** Orchestrator-mode env (pytest `env` fixture). */
export function orchestratorEnv(tmp = tmpPath(), overrides: EnvSource = {}): EnvSource {
	return { ...baselineEnv(tmp), ...overrides };
}

/** gh-proxy container env: holds the PAT, no proxy vars (pytest `proxy_env`). */
export function proxyEnv(tmp = tmpPath(), overrides: EnvSource = {}): EnvSource {
	return {
		...baselineEnv(tmp),
		GITHUB_TOKEN: "ghp_test_token_value_xxxxxxxxxxxxxxxx",
		ROBOMP_GH_PROXY_URL: "",
		ROBOMP_GH_PROXY_HMAC_KEY: "",
		...overrides,
	};
}

/** Loaded settings with paths created (pytest `settings` fixture). */
export function makeSettings(overrides: EnvSource = {}, tmp = tmpPath()): Settings {
	const cfg = new Settings(orchestratorEnv(tmp, overrides));
	cfg.ensurePaths();
	return cfg;
}

/** Fresh database closed after the test (pytest `db` fixture). */
export function makeDb(tmp = tmpPath()): Database {
	const db = new Database(path.join(tmp, "test.sqlite"));
	onCleanup(() => db.close());
	return db;
}
