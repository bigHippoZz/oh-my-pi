/** Python builtin renderings; every expectation was produced by CPython 3.11. */
import { expect, test } from "bun:test";
import { pyIterOrEmpty, pyIsInt, pyRepr, pySplitlines, pySplitWhitespace, pyStr, pyTruthy } from "../src/pycompat";

// [input, repr(input)] pairs.
const REPR_CASES: readonly [string, readonly (readonly [string, string])[]][] = [
	[
		"quote selection: default single",
		[
			["plain", "'plain'"],
			["it's", '"it\'s"'],
			['say "hi"', "'say \"hi\"'"],
			["both ' and \"", "'both \\' and \"'"],
		],
	],
	[
		"backslash and C0 named escapes",
		[
			["back\\slash", "'back\\\\slash'"],
			["tab\tnl\nret\r", "'tab\\tnl\\nret\\r'"],
		],
	],
	[
		"C0, DEL and C1 controls as \\xNN",
		[
			["\u0000\u001f\u007f", "'\\x00\\x1f\\x7f'"],
			["\u0080\u009f", "'\\x80\\x9f'"],
		],
	],
	["Latin-1 non-printables as \\xNN, printables raw", [["\u00a0\u00ad\u00e9\u00ff", "'\\xa0\\xad\u00e9\u00ff'"]]],
	[
		"BMP format/separator/private-use/unassigned as \\uNNNN",
		[
			["\u0100\u200b\u2028\u2029\u3000\ufeff", "'\u0100\\u200b\\u2028\\u2029\\u3000\\ufeff'"],
			["\ue000", "'\\ue000'"],
			["\u0378", "'\\u0378'"],
		],
	],
	["lone surrogate as \\uNNNN", [["\ud800", "'\\ud800'"]]],
	[
		"astral printable raw, non-printable as \\UNNNNNNNN",
		[
			["\ud83d\ude00", "'\ud83d\ude00'"],
			["\udb40\udc01\udbff\udfff", "'\\U000e0001\\U0010ffff'"],
		],
	],
	["ASCII space stays printable", [[" a b ", "' a b '"]]],
];

for (const [name, rows] of REPR_CASES) {
	test(`pyRepr matches Python repr(): ${name}`, () => {
		for (const [input, expected] of rows) expect(pyRepr(input)).toBe(expected);
	});
}

test("pyRepr of a list escapes each element like Python", () => {
	expect(pyRepr(["a'b", "\u0085", '"'])).toBe("[\"a'b\", '\\x85', '\"']");
});

test("pySplitlines matches str.splitlines() boundaries and trailing handling", () => {
	expect(pySplitlines("a\nb")).toEqual(["a", "b"]);
	expect(pySplitlines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
	expect(pySplitlines("a\u000bb\fc")).toEqual(["a", "b", "c"]);
	expect(pySplitlines("x\u001cy\u001dz\u001ew")).toEqual(["x", "y", "z", "w"]);
	expect(pySplitlines("p\u0085q\u2028r\u2029s")).toEqual(["p", "q", "r", "s"]);
	expect(pySplitlines("")).toEqual([]);
	expect(pySplitlines("\n")).toEqual([""]);
	expect(pySplitlines("a\n\nb\n")).toEqual(["a", "", "b"]);
	expect(pySplitlines("a\u001fb\u200bc")).toEqual(["a\u001fb\u200bc"]);
});

test("pySplitWhitespace matches str.split() whitespace set", () => {
	expect(pySplitWhitespace(" a\tb\u001fc\u0085d\u00a0e\u3000f\ufeffg  ")).toEqual([
		"a",
		"b",
		"c",
		"d",
		"e",
		"f\ufeffg",
	]);
	expect(pySplitWhitespace("")).toEqual([]);
	expect(pySplitWhitespace("\u001c\u001d")).toEqual([]);
});

test("pyIsInt/pyStr/pyTruthy follow Python semantics for JSON values", () => {
	// isinstance(True, int) is True; str(True) == "True"; [] and {} are falsy.
	expect([true, false, 3, 0].map(pyIsInt)).toEqual([true, true, true, true]);
	expect([1.5, "1", null].map(pyIsInt)).toEqual([false, false, false]);
	expect([true, null, 7, "s"].map(pyStr)).toEqual(["True", "None", "7", "s"]);
	expect([null, false, 0, "", [], {}].map(pyTruthy)).toEqual([false, false, false, false, false, false]);
	expect([true, 1, "0", [0], { a: 1 }].map(pyTruthy)).toEqual([true, true, true, true, true]);
});

test("pyIterOrEmpty iterates like Python `for x in (value or ())`", () => {
	expect(pyIterOrEmpty(null)).toEqual([]);
	expect(pyIterOrEmpty("ab")).toEqual(["a", "b"]);
	expect(pyIterOrEmpty({ tool: 1, ux: 2 })).toEqual(["tool", "ux"]);
	expect(() => pyIterOrEmpty(5)).toThrow(new TypeError("'int' object is not iterable"));
	expect(() => pyIterOrEmpty(true)).toThrow(new TypeError("'bool' object is not iterable"));
});
