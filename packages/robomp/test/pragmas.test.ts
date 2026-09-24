import { expect, test } from "bun:test";
import { parsePragmas, pragmaValue, resolveModelAlias, resolveThinkingLevel } from "../src/pragmas";

test.each([
	[
		"single inline command",
		"/model gpt\nfix the off-by-one in foo()",
		"fix the off-by-one in foo()",
		[["model", "gpt"]],
	],
	[
		"multiple commands on one line",
		"/model gpt /thinking low\nrun",
		"run",
		[
			["model", "gpt"],
			["thinking", "low"],
		],
	],
	[
		"stacked commands",
		"/model gpt\n/thinking low\nrun",
		"run",
		[
			["model", "gpt"],
			["thinking", "low"],
		],
	],
	[
		"equals form",
		"/model=gpt /thinking=low\nrun",
		"run",
		[
			["model", "gpt"],
			["thinking", "low"],
		],
	],
	["indented command line", "   /model gpt\nrun", "run", [["model", "gpt"]]],
	["mixed line is not consumed", "/model gpt fix the bug", "/model gpt fix the bug", []],
	[
		"path references are not consumed",
		"/src/foo.py:42 is the offender\n/model gpt\nfix it",
		"/src/foo.py:42 is the offender\nfix it",
		[["model", "gpt"]],
	],
	["command without value is not consumed", "/model\nrun", "/model\nrun", []],
	["dangling command aborts the whole line", "/model gpt /thinking\nrun", "/model gpt /thinking\nrun", []],
	["interior blank lines survive", "/model gpt\n\nbody one\n\nbody two", "body one\n\nbody two", [["model", "gpt"]]],
	["empty body", "", "", []],
	["key case normalized, value preserved", "/MODEL GPT-5.5\nrun", "run", [["model", "GPT-5.5"]]],
])("parsePragmas: %s", (_name, body, cleaned, pragmas) => {
	expect(parsePragmas(body)).toEqual([cleaned, pragmas as [string, string][]]);
});

test("pragmaValue last wins", () => {
	expect(
		pragmaValue(
			[
				["model", "a"],
				["model", "b"],
			],
			"model",
		),
	).toBe("b");
	expect(pragmaValue([["model", "a"]], "MODEL")).toBe("a");
	expect(pragmaValue([], "model")).toBeNull();
});

test("resolveModelAlias precedence", () => {
	const pool = ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "openai/gpt-5.5-mini"];
	expect(resolveModelAlias("gpt-5.5", pool)).toBe("openai/gpt-5.5");
	expect(resolveModelAlias("gpt", pool)).toBe("openai/gpt-5.5");
	expect(resolveModelAlias("claude", pool)).toBe("anthropic/claude-sonnet-4-6");
});

test("resolveModelAlias full id", () => {
	expect(resolveModelAlias("openai/gpt-5.5", ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"])).toBe(
		"openai/gpt-5.5",
	);
});

test("resolveModelAlias no match", () => {
	expect(resolveModelAlias("gpt", ["anthropic/claude-sonnet-4-6"])).toBeNull();
	expect(resolveModelAlias("", ["anthropic/claude-sonnet-4-6"])).toBeNull();
});

test.each([
	["off", "off"],
	["none", "off"],
	["no", "off"],
	["lo", "low"],
	["low", "low"],
	["med", "medium"],
	["medium", "medium"],
	["hi", "high"],
	["high", "high"],
	["xhi", "xhigh"],
	["xhigh", "xhigh"],
	["HIGH", "high"],
	["  Hi  ", "high"],
	["XHi", "xhigh"],
])("resolveThinkingLevel(%p) → %p", (input, expected) => {
	expect(resolveThinkingLevel(input)).toBe(expected as ReturnType<typeof resolveThinkingLevel>);
});

test.each(["ultra", "", "minimal", "constructor"])("resolveThinkingLevel rejects %p", input => {
	expect(resolveThinkingLevel(input)).toBeNull();
});
