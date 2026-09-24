/** Worker-side pragma resolution: model + thinking overrides (port of test_worker_pragmas.py). */
import { expect, test } from "bun:test";
import type { Settings } from "../src/config";
import { directiveInfo } from "../src/task-types";
import { resolvePragmaOverrides } from "../src/worker";
import { makeSettings } from "./helpers";

function settingsWithPool(): Settings {
	return makeSettings({ ROBOMP_MODEL: "anthropic/claude-sonnet-4-6,openai/gpt-5.5,openai/gpt-5.5-mini" });
}

function withPragmas(...pragmas: [string, string][]) {
	return directiveInfo({ body: "run", author: "can1357", pragmas });
}

test("no directive means no override", () => {
	expect(resolvePragmaOverrides(null, settingsWithPool())).toEqual([null, null]);
});

test("directive without pragmas means no override", () => {
	expect(resolvePragmaOverrides(directiveInfo({ body: "run it", author: "can1357" }), settingsWithPool())).toEqual([
		null,
		null,
	]);
});

test("model pragma resolves to pool entry", () => {
	expect(resolvePragmaOverrides(withPragmas(["model", "gpt"]), settingsWithPool())).toEqual(["openai/gpt-5.5", null]);
});

test("model alias exact short name", () => {
	const [model] = resolvePragmaOverrides(withPragmas(["model", "gpt-5.5-mini"]), settingsWithPool());
	expect(model).toBe("openai/gpt-5.5-mini");
});

test("unmatched model alias falls back to random pick", () => {
	const [model] = resolvePragmaOverrides(withPragmas(["model", "qwen"]), settingsWithPool());
	expect(model).toBeNull();
});

test("thinking pragma normalized", () => {
	expect(resolvePragmaOverrides(withPragmas(["thinking", "LOW"]), settingsWithPool())).toEqual([null, "low"]);
});

test("unknown thinking level dropped", () => {
	const [, thinking] = resolvePragmaOverrides(withPragmas(["thinking", "ultra"]), settingsWithPool());
	expect(thinking).toBeNull();
});

test("both pragmas resolved together", () => {
	expect(resolvePragmaOverrides(withPragmas(["model", "claude"], ["thinking", "medium"]), settingsWithPool())).toEqual(
		["anthropic/claude-sonnet-4-6", "medium"],
	);
});

test("last value wins for duplicate keys", () => {
	const [model] = resolvePragmaOverrides(withPragmas(["model", "claude"], ["model", "gpt"]), settingsWithPool());
	expect(model).toBe("openai/gpt-5.5");
});
