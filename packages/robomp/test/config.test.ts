import { describe, expect, test } from "bun:test";
import { Settings, SettingsValidationError } from "../src/config";
import { orchestratorEnv, proxyEnv } from "./helpers";

describe("Settings", () => {
	test("loads from env", () => {
		const cfg = new Settings(orchestratorEnv());
		expect(cfg.bot_login).toBe("robomp-bot");
		expect(cfg.repo_allowlist).toEqual(new Set(["octo/widget"]));
		expect(cfg.allows("octo/widget")).toBe(true);
		expect(cfg.allows("Octo/Widget")).toBe(true);
		expect(cfg.allows("other/widget")).toBe(false);
	});

	test("missing every credential source trips the no-access validator", () => {
		const env = orchestratorEnv(undefined, {
			GITHUB_TOKEN: "",
			ROBOMP_GH_PROXY_URL: "",
			ROBOMP_GH_PROXY_HMAC_KEY: "",
		});
		expect(() => new Settings(env)).toThrow(/no GitHub access configured/);
	});

	test("orchestrator mode loads proxy config", () => {
		const cfg = new Settings(orchestratorEnv());
		expect(cfg.github_token).toBeNull();
		expect(cfg.gh_proxy_url).toBe("http://gh-proxy.invalid:8081");
		expect(cfg.gh_proxy_hmac_key?.getSecretValue().startsWith("test-hmac-key")).toBe(true);
	});

	test("rejects token and proxy together", () => {
		expect(() => new Settings(orchestratorEnv(undefined, { GITHUB_TOKEN: "x" }))).toThrow(SettingsValidationError);
	});

	test("rejects proxy url without key", () => {
		expect(() => new Settings(orchestratorEnv(undefined, { ROBOMP_GH_PROXY_HMAC_KEY: "" }))).toThrow(
			SettingsValidationError,
		);
	});

	test("proxy mode loads PAT", () => {
		const cfg = new Settings(proxyEnv());
		expect(cfg.github_token?.getSecretValue()).toBe("ghp_test_token_value_xxxxxxxxxxxxxxxx");
		expect(cfg.gh_proxy_url).toBeNull();
		expect(cfg.gh_proxy_hmac_key).toBeNull();
	});

	test("allowlist csv parsing", () => {
		const cfg = new Settings(
			orchestratorEnv(undefined, { ROBOMP_REPO_ALLOWLIST: "  alpha/one ,beta/two, ,gamma/three " }),
		);
		expect(cfg.repo_allowlist).toEqual(new Set(["alpha/one", "beta/two", "gamma/three"]));
	});

	test("blank replay token treated as disabled", () => {
		expect(new Settings(orchestratorEnv(undefined, { ROBOMP_REPLAY_TOKEN: "" })).replay_token).toBeNull();
	});

	test("whitespace replay token treated as disabled", () => {
		expect(new Settings(orchestratorEnv(undefined, { ROBOMP_REPLAY_TOKEN: "   " })).replay_token).toBeNull();
	});

	test("real replay token preserved", () => {
		const cfg = new Settings(orchestratorEnv(undefined, { ROBOMP_REPLAY_TOKEN: "abc" }));
		expect(cfg.replay_token?.getSecretValue()).toBe("abc");
	});

	test("blank bot login rejected", () => {
		expect(() => new Settings(orchestratorEnv(undefined, { ROBOMP_BOT_LOGIN: "   " }))).toThrow(
			SettingsValidationError,
		);
	});

	test.each(["roboomp", " @roboomp ", " @ROBOOMP ", "roboomp[bot]", "@roboomp[bot]", " @ROBOOMP[BOT] "])(
		"bot login normalizes mention, case and app suffix: %p",
		raw => {
			expect(new Settings(orchestratorEnv(undefined, { ROBOMP_BOT_LOGIN: raw })).bot_login).toBe("roboomp");
		},
	);

	test("maintainer logins normalize csv entries", () => {
		const cfg = new Settings(
			orchestratorEnv(undefined, { ROBOMP_MAINTAINER_LOGINS: " can1357, @ROBOOMP , @Alice[bot] ,, " }),
		);
		expect(cfg.maintainer_logins).toEqual(new Set(["can1357", "roboomp", "alice"]));
	});

	test.each([
		["roboomp", "roboomp"],
		[" @roboomp ", "roboomp"],
		[" @ROBOOMP ", "roboomp"],
		["roboomp[bot]", "roboomp"],
		["@roboomp[bot]", "roboomp"],
		[" @ROBOOMP[BOT] ", "roboomp"],
	])("maintainer logins common entry forms: %p", (raw, expected) => {
		const cfg = new Settings(orchestratorEnv(undefined, { ROBOMP_MAINTAINER_LOGINS: raw }));
		expect(cfg.maintainer_logins).toEqual(new Set([expected]));
	});

	test("model pool single", () => {
		const cfg = new Settings(orchestratorEnv());
		expect(cfg.model_pool).toEqual([cfg.model]);
		expect(cfg.pickModel()).toBe(cfg.model);
	});

	test("model pool csv parses", () => {
		const cfg = new Settings(
			orchestratorEnv(undefined, {
				ROBOMP_MODEL: " codex/gpt-5.4 , anthropic/claude-sonnet-4-6 ,, anthropic/claude-opus-4-7 ",
			}),
		);
		expect(cfg.model_pool).toEqual(["codex/gpt-5.4", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"]);
	});

	test("pick model covers full pool", () => {
		const cfg = new Settings(orchestratorEnv(undefined, { ROBOMP_MODEL: "a,b,c" }));
		const seen = new Set(Array.from({ length: 500 }, () => cfg.pickModel()));
		expect(seen).toEqual(new Set(["a", "b", "c"]));
	});

	test("release model falls back to general pool", () => {
		const cfg = new Settings(orchestratorEnv(undefined, { ROBOMP_MODEL: "a" }));
		expect(cfg.release_model_pool).toEqual(["a"]);
		expect(cfg.pickReleaseModel()).toBe("a");
	});

	test("release model pool csv parses", () => {
		const cfg = new Settings(
			orchestratorEnv(undefined, { ROBOMP_MODEL: "fallback", ROBOMP_RELEASE_MODEL: " release-a, release-b ,, " }),
		);
		expect(cfg.release_model_pool).toEqual(["release-a", "release-b"]);
	});

	test("max concurrency default is 8", () => {
		expect(new Settings(orchestratorEnv()).max_concurrency).toBe(8);
	});

	test("task timeout hard grace env parses", () => {
		const cfg = new Settings(orchestratorEnv(undefined, { ROBOMP_TASK_TIMEOUT_HARD_GRACE_SECONDS: "12.5" }));
		expect(cfg.task_timeout_hard_grace_seconds).toBe(12.5);
	});
});
