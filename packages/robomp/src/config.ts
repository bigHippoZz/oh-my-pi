/**
 * Env-driven configuration for roboomp.
 *
 * Mirrors the Python `Settings` (pydantic-settings) contract: the same env
 * var names, defaults, blank-means-unset coercions, and cross-field
 * validation. Env lookup is case-insensitive like pydantic's
 * `case_sensitive=False`; Bun auto-loads `.env` from the working directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

export type EnvSource = Record<string, string | undefined>;

/** Raised when env configuration fails validation (pydantic `ValidationError` analogue). */
export class SettingsValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingsValidationError";
	}
}

/** Opaque secret wrapper; never prints its value. */
export class SecretStr {
	readonly #value: string;
	constructor(value: string) {
		this.#value = value;
	}
	getSecretValue(): string {
		return this.#value;
	}
	toString(): string {
		return "**********";
	}
	toJSON(): string {
		return "**********";
	}
	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return "SecretStr('**********')";
	}
}

class EnvReader {
	readonly #lower = new Map<string, string>();
	constructor(env: EnvSource) {
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined) this.#lower.set(key.toLowerCase(), value);
		}
	}
	raw(name: string): string | undefined {
		return this.#lower.get(name.toLowerCase());
	}
	has(name: string): boolean {
		return this.#lower.has(name.toLowerCase());
	}
	str(name: string, fallback: string): string {
		return this.raw(name) ?? fallback;
	}
	required(name: string): string {
		const value = this.raw(name);
		if (value === undefined) throw new SettingsValidationError(`${name}: Field required`);
		return value;
	}
	bool(name: string, fallback: boolean): boolean {
		const value = this.raw(name);
		if (value === undefined) return fallback;
		const norm = value.trim().toLowerCase();
		if (["1", "true", "t", "yes", "y", "on"].includes(norm)) return true;
		if (["0", "false", "f", "no", "n", "off"].includes(norm)) return false;
		throw new SettingsValidationError(`${name}: Input should be a valid boolean, unable to interpret input`);
	}
	int(name: string, fallback: number): number {
		const value = this.raw(name);
		if (value === undefined) return fallback;
		const trimmed = value.trim();
		if (!/^[+-]?\d+$/.test(trimmed)) {
			throw new SettingsValidationError(`${name}: Input should be a valid integer`);
		}
		return Number.parseInt(trimmed, 10);
	}
	float(name: string, fallback: number): number {
		const value = this.raw(name);
		if (value === undefined) return fallback;
		const parsed = Number(value.trim());
		if (value.trim() === "" || Number.isNaN(parsed)) {
			throw new SettingsValidationError(`${name}: Input should be a valid number`);
		}
		return parsed;
	}
	/** Blank / whitespace-only values mean "unset". */
	optional(name: string): string | undefined {
		const value = this.raw(name);
		if (value === undefined || !value.trim()) return undefined;
		return value;
	}
}

function randomChoice<T>(items: readonly T[]): T {
	return items[Math.floor(Math.random() * items.length)]!;
}

function csvSet(raw: string, normalize: (piece: string) => string): ReadonlySet<string> {
	const out = new Set<string>();
	for (const piece of raw.split(",")) {
		const item = normalize(piece);
		if (item) out.add(item);
	}
	return out;
}

function stripAt(value: string): string {
	return value.replace(/^@+/, "");
}

function removeSuffix(value: string, suffix: string): string {
	return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

export interface SettingsInit {
	github_token: SecretStr | null;
	github_webhook_secret: SecretStr;
	bot_login: string;
	git_author_name: string | null;
	git_author_email: string;
	repo_allowlist_raw: string;
	pr_review_enabled: boolean;
	release_sentinel_enabled: boolean;
	release_commit_prefix: string;
	release_max_rounds: number;
	release_task_timeout_seconds: number;
	release_model: string | null;
	gh_proxy_url: string | null;
	gh_proxy_hmac_key: SecretStr | null;
	gh_proxy_bind_host: string;
	gh_proxy_bind_port: number;
	gh_proxy_max_body_bytes: number;
	gh_proxy_git_timeout_seconds: number;
	model: string;
	provider: string | null;
	thinking_level: ThinkingLevel;
	max_concurrency: number;
	task_timeout_seconds: number;
	task_timeout_hard_grace_seconds: number;
	request_timeout_seconds: number;
	event_max_retries: number;
	event_retry_delays_raw: string;
	task_completion_max_reminders: number;
	omp_command: string;
	shutdown_drain_timeout_seconds: number;
	shutdown_kill_timeout_seconds: number;
	workspace_root: string;
	sqlite_path: string;
	log_dir: string;
	bind_host: string;
	bind_port: number;
	replay_token: SecretStr | null;
	rate_limit_window_seconds: number;
	rate_limit_default: number;
	rate_limit_contributor: number;
	rate_limit_unlimited_raw: string;
	maintainer_logins_raw: string;
	reviewer_bots_raw: string;
	question_autoclose_enabled: boolean;
	question_autoclose_hours: number;
	question_autoclose_scan_seconds: number;
	issue_index_sync_seconds: number;
	natives_cache_enabled: boolean;
	natives_cache_root: string;
	natives_cache_max_entries_per_repo: number;
	natives_cache_max_bytes: number;
	natives_cache_gc_interval_seconds: number;
	reclaim_workspace_caches: boolean;
}

/** Strongly-typed runtime configuration. */
export class Settings implements SettingsInit {
	github_token!: SecretStr | null;
	github_webhook_secret!: SecretStr;
	bot_login!: string;
	git_author_name!: string | null;
	git_author_email!: string;
	repo_allowlist_raw!: string;
	pr_review_enabled!: boolean;
	release_sentinel_enabled!: boolean;
	release_commit_prefix!: string;
	release_max_rounds!: number;
	release_task_timeout_seconds!: number;
	release_model!: string | null;
	gh_proxy_url!: string | null;
	gh_proxy_hmac_key!: SecretStr | null;
	gh_proxy_bind_host!: string;
	gh_proxy_bind_port!: number;
	gh_proxy_max_body_bytes!: number;
	gh_proxy_git_timeout_seconds!: number;
	model!: string;
	provider!: string | null;
	thinking_level!: ThinkingLevel;
	max_concurrency!: number;
	task_timeout_seconds!: number;
	task_timeout_hard_grace_seconds!: number;
	request_timeout_seconds!: number;
	event_max_retries!: number;
	event_retry_delays_raw!: string;
	task_completion_max_reminders!: number;
	omp_command!: string;
	shutdown_drain_timeout_seconds!: number;
	shutdown_kill_timeout_seconds!: number;
	workspace_root!: string;
	sqlite_path!: string;
	log_dir!: string;
	bind_host!: string;
	bind_port!: number;
	replay_token!: SecretStr | null;
	rate_limit_window_seconds!: number;
	rate_limit_default!: number;
	rate_limit_contributor!: number;
	rate_limit_unlimited_raw!: string;
	maintainer_logins_raw!: string;
	reviewer_bots_raw!: string;
	question_autoclose_enabled!: boolean;
	question_autoclose_hours!: number;
	question_autoclose_scan_seconds!: number;
	issue_index_sync_seconds!: number;
	natives_cache_enabled!: boolean;
	natives_cache_root!: string;
	natives_cache_max_entries_per_repo!: number;
	natives_cache_max_bytes!: number;
	natives_cache_gc_interval_seconds!: number;
	reclaim_workspace_caches!: boolean;

	/** Load + validate from an env mapping (defaults to `process.env`). */
	constructor(env: EnvSource = process.env) {
		const e = new EnvReader(env);
		const token = e.optional("GITHUB_TOKEN");
		const proxyKey = e.optional("ROBOMP_GH_PROXY_HMAC_KEY");
		const replay = e.optional("ROBOMP_REPLAY_TOKEN");
		const thinking = e.str("ROBOMP_THINKING", "high") as ThinkingLevel;
		if (!THINKING_LEVELS.includes(thinking)) {
			throw new SettingsValidationError(
				`ROBOMP_THINKING: Input should be ${THINKING_LEVELS.map(l => `'${l}'`).join(", ")}`,
			);
		}
		this.#assign({
			github_token: token === undefined ? null : new SecretStr(token),
			github_webhook_secret: new SecretStr(e.required("GITHUB_WEBHOOK_SECRET")),
			bot_login: normalizeBotLogin(e.required("ROBOMP_BOT_LOGIN")),
			git_author_name: e.raw("ROBOMP_GIT_AUTHOR_NAME") ?? null,
			git_author_email: e.required("ROBOMP_GIT_AUTHOR_EMAIL"),
			repo_allowlist_raw: e.str("ROBOMP_REPO_ALLOWLIST", ""),
			pr_review_enabled: e.bool("ROBOMP_PR_REVIEW_ENABLED", true),
			release_sentinel_enabled: e.bool("ROBOMP_RELEASE_SENTINEL_ENABLED", false),
			release_commit_prefix: e.str("ROBOMP_RELEASE_COMMIT_PREFIX", "chore: bump version to "),
			release_max_rounds: e.int("ROBOMP_RELEASE_MAX_ROUNDS", 5),
			release_task_timeout_seconds: e.float("ROBOMP_RELEASE_TASK_TIMEOUT_SECONDS", 3600),
			release_model: e.raw("ROBOMP_RELEASE_MODEL") ?? null,
			gh_proxy_url: e.optional("ROBOMP_GH_PROXY_URL") ?? null,
			gh_proxy_hmac_key: proxyKey === undefined ? null : new SecretStr(proxyKey),
			gh_proxy_bind_host: e.str("ROBOMP_GH_PROXY_BIND_HOST", "0.0.0.0"),
			gh_proxy_bind_port: e.int("ROBOMP_GH_PROXY_BIND_PORT", 8081),
			gh_proxy_max_body_bytes: e.int("ROBOMP_GH_PROXY_MAX_BODY_BYTES", 1 << 20),
			gh_proxy_git_timeout_seconds: e.float("ROBOMP_GH_PROXY_GIT_TIMEOUT_SECONDS", 60),
			model: e.str("ROBOMP_MODEL", "anthropic/claude-sonnet-4-6"),
			provider: e.raw("ROBOMP_PROVIDER") ?? null,
			thinking_level: thinking,
			max_concurrency: e.int("ROBOMP_MAX_CONCURRENCY", 8),
			task_timeout_seconds: e.float("ROBOMP_TASK_TIMEOUT_SECONDS", 2400),
			task_timeout_hard_grace_seconds: e.float("ROBOMP_TASK_TIMEOUT_HARD_GRACE_SECONDS", 60),
			request_timeout_seconds: e.float("ROBOMP_REQUEST_TIMEOUT_SECONDS", 120),
			event_max_retries: e.int("ROBOMP_EVENT_MAX_RETRIES", 3),
			event_retry_delays_raw: e.str("ROBOMP_EVENT_RETRY_DELAYS_SECONDS", "30,120,600"),
			task_completion_max_reminders: e.int("ROBOMP_TASK_COMPLETION_MAX_REMINDERS", 2),
			omp_command: e.str("ROBOMP_OMP_COMMAND", "omp"),
			shutdown_drain_timeout_seconds: e.float("ROBOMP_SHUTDOWN_DRAIN_TIMEOUT_SECONDS", 25),
			shutdown_kill_timeout_seconds: e.float("ROBOMP_SHUTDOWN_KILL_TIMEOUT_SECONDS", 5),
			workspace_root: e.str("ROBOMP_WORKSPACE_ROOT", "./data/workspaces"),
			sqlite_path: e.str("ROBOMP_SQLITE_PATH", "./data/robomp.sqlite"),
			log_dir: e.str("ROBOMP_LOG_DIR", "./data/logs"),
			bind_host: e.str("ROBOMP_BIND_HOST", "0.0.0.0"),
			bind_port: e.int("ROBOMP_BIND_PORT", 8080),
			replay_token: replay === undefined ? null : new SecretStr(replay),
			rate_limit_window_seconds: e.float("ROBOMP_RATE_LIMIT_WINDOW_SECONDS", 3600),
			rate_limit_default: e.int("ROBOMP_RATE_LIMIT_DEFAULT", 3),
			rate_limit_contributor: e.int("ROBOMP_RATE_LIMIT_CONTRIBUTOR", 10),
			rate_limit_unlimited_raw: e.str("ROBOMP_RATE_LIMIT_UNLIMITED", ""),
			maintainer_logins_raw: e.str("ROBOMP_MAINTAINER_LOGINS", ""),
			reviewer_bots_raw: e.str("ROBOMP_REVIEWER_BOTS", ""),
			question_autoclose_enabled: e.bool("ROBOMP_QUESTION_AUTOCLOSE_ENABLED", true),
			question_autoclose_hours: e.float("ROBOMP_QUESTION_AUTOCLOSE_HOURS", 4),
			question_autoclose_scan_seconds: e.float("ROBOMP_QUESTION_AUTOCLOSE_SCAN_SECONDS", 60),
			issue_index_sync_seconds: e.float("ROBOMP_ISSUE_INDEX_SYNC_SECONDS", 900),
			natives_cache_enabled: e.bool("ROBOMP_NATIVES_CACHE_ENABLED", true),
			natives_cache_root: e.str("ROBOMP_NATIVES_CACHE_ROOT", "/data/cache/pi-natives"),
			natives_cache_max_entries_per_repo: e.int("ROBOMP_NATIVES_CACHE_MAX_ENTRIES_PER_REPO", 8),
			natives_cache_max_bytes: e.int("ROBOMP_NATIVES_CACHE_MAX_BYTES", 4 * 1024 ** 3),
			natives_cache_gc_interval_seconds: e.float("ROBOMP_NATIVES_CACHE_GC_INTERVAL_SECONDS", 3600),
			reclaim_workspace_caches: e.bool("ROBOMP_RECLAIM_WORKSPACE_CACHES", true),
		});
		this.#validateProxyOrPat();
	}

	/** Build without env loading or cross-field validation (pydantic `model_construct`). */
	static construct(init: Partial<SettingsInit>): Settings {
		const settings = Object.create(Settings.prototype) as Settings;
		const defaults = new Settings({
			GITHUB_WEBHOOK_SECRET: "",
			ROBOMP_BOT_LOGIN: "construct",
			ROBOMP_GIT_AUTHOR_EMAIL: "construct@invalid",
			GITHUB_TOKEN: "construct",
		});
		Object.assign(settings, defaults, { github_token: null }, init);
		return settings;
	}

	/** Copy with overrides (pydantic `model_copy(update=...)`). */
	copy(update: Partial<SettingsInit>): Settings {
		const settings = Object.create(Settings.prototype) as Settings;
		Object.assign(settings, this, update);
		return settings;
	}

	#assign(init: SettingsInit): void {
		Object.assign(this, init);
	}

	#validateProxyOrPat(): void {
		const hasToken = this.github_token !== null;
		const hasUrl = Boolean(this.gh_proxy_url);
		const hasKey = this.gh_proxy_hmac_key !== null;
		if (hasToken && hasUrl) {
			throw new SettingsValidationError(
				"GITHUB_TOKEN and ROBOMP_GH_PROXY_URL are mutually exclusive — " +
					"set ONE to choose between direct-PAT and gh-proxy modes.",
			);
		}
		if (hasUrl !== hasKey) {
			throw new SettingsValidationError(
				"ROBOMP_GH_PROXY_URL and ROBOMP_GH_PROXY_HMAC_KEY must both be set together (or both empty).",
			);
		}
		if (!hasToken && !hasUrl) {
			throw new SettingsValidationError(
				"no GitHub access configured: set GITHUB_TOKEN, or set " +
					"ROBOMP_GH_PROXY_URL + ROBOMP_GH_PROXY_HMAC_KEY to use gh-proxy.",
			);
		}
	}

	get repo_allowlist(): ReadonlySet<string> {
		return csvSet(this.repo_allowlist_raw, p => p.trim().toLowerCase());
	}

	get rate_limit_unlimited(): ReadonlySet<string> {
		return csvSet(this.rate_limit_unlimited_raw, p => stripAt(p.trim()).toLowerCase());
	}

	get reviewer_bots(): ReadonlySet<string> {
		return csvSet(this.reviewer_bots_raw, p => stripAt(p.trim()).toLowerCase());
	}

	get maintainer_logins(): ReadonlySet<string> {
		return csvSet(this.maintainer_logins_raw, p => removeSuffix(stripAt(p.trim()).toLowerCase(), "[bot]"));
	}

	allows(fullName: string): boolean {
		return this.repo_allowlist.has(fullName.toLowerCase());
	}

	/** ROBOMP_MODEL may be a single id or a comma-separated list; always non-empty. */
	get model_pool(): readonly string[] {
		const items = this.model
			.split(",")
			.map(p => p.trim())
			.filter(Boolean);
		return items.length > 0 ? items : [this.model];
	}

	pickModel(): string {
		return randomChoice(this.model_pool);
	}

	/** Release-specific model pool, falling back to the general pool. */
	get release_model_pool(): readonly string[] {
		const items = (this.release_model ?? "")
			.split(",")
			.map(p => p.trim())
			.filter(Boolean);
		return items.length > 0 ? items : this.model_pool;
	}

	pickReleaseModel(): string {
		if (!this.release_model?.trim()) return this.pickModel();
		return randomChoice(this.release_model_pool);
	}

	/** Parsed backoff schedule in seconds; always non-empty. */
	get event_retry_delays(): readonly number[] {
		const vals: number[] = [];
		for (const raw of this.event_retry_delays_raw.split(",")) {
			const piece = raw.trim();
			if (!piece) continue;
			const seconds = Number(piece);
			if (Number.isNaN(seconds)) continue;
			if (seconds >= 0) vals.push(seconds);
		}
		return vals.length > 0 ? vals : [30];
	}

	/** Backoff before the `retryIndex`-th retry (1-based), with ±20% jitter. */
	retryDelaySeconds(retryIndex: number): number {
		const delays = this.event_retry_delays;
		const idx = Math.min(Math.max(retryIndex, 1), delays.length) - 1;
		return delays[idx]! * (0.8 + Math.random() * 0.4);
	}

	/** Falls back to bot_login if ROBOMP_GIT_AUTHOR_NAME isn't set. */
	get resolved_author_name(): string {
		return (this.git_author_name || this.bot_login).trim();
	}

	ensurePaths(): void {
		for (const dir of [this.workspace_root, path.dirname(this.sqlite_path), this.log_dir]) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}
}

function normalizeBotLogin(value: string): string {
	let cleaned = value.trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	cleaned = cleaned.toLowerCase();
	if (cleaned.endsWith("[bot]")) cleaned = cleaned.slice(0, -5);
	if (!cleaned) throw new SettingsValidationError("ROBOMP_BOT_LOGIN must be a non-empty GitHub login");
	return cleaned;
}

let cachedSettings: Settings | undefined;

export function getSettings(): Settings {
	cachedSettings ??= new Settings();
	return cachedSettings;
}

/** Invalidate the cached settings (tests). */
export function resetSettingsCache(): void {
	cachedSettings = undefined;
}

/**
 * Build a `Settings` instance suitable for the gh-proxy process.
 *
 * Only the env vars the proxy actually consumes are required; orchestrator
 * fields get inert placeholders. Skips the orchestrator cross-field validator.
 */
export function loadProxySettings(env: EnvSource = process.env): Settings {
	const e = new EnvReader(env);
	const requireNonBlank = (name: string): string => {
		const value = e.required(name);
		if (!value.trim()) throw new SettingsValidationError(`${name}: must be a non-empty string`);
		return value;
	};
	return Settings.construct({
		github_token: new SecretStr(requireNonBlank("GITHUB_TOKEN")),
		github_webhook_secret: new SecretStr(""),
		bot_login: "gh-proxy",
		git_author_email: "gh-proxy@invalid",
		gh_proxy_url: null,
		gh_proxy_hmac_key: new SecretStr(requireNonBlank("ROBOMP_GH_PROXY_HMAC_KEY")),
		gh_proxy_bind_host: e.str("ROBOMP_GH_PROXY_BIND_HOST", "0.0.0.0"),
		gh_proxy_bind_port: e.int("ROBOMP_GH_PROXY_BIND_PORT", 8081),
		workspace_root: e.str("ROBOMP_WORKSPACE_ROOT", "./data/workspaces"),
		log_dir: e.str("ROBOMP_LOG_DIR", "./data/logs"),
		gh_proxy_max_body_bytes: e.int("ROBOMP_GH_PROXY_MAX_BODY_BYTES", 1 << 20),
		gh_proxy_git_timeout_seconds: e.float("ROBOMP_GH_PROXY_GIT_TIMEOUT_SECONDS", 60),
	});
}
