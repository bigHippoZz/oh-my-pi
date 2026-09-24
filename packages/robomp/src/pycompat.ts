/**
 * Byte-exact renderings of Python builtins that leak into agent-visible text
 * (`repr()` in error messages, `json.dumps()` in tool results/artifacts).
 */

/**
 * Python `str.isprintable()` for one code point: Unicode categories Cc, Cf,
 * Cs, Co, Cn, Zl, Zp and Zs are non-printable, except ASCII space. Lone
 * surrogates (JS strings may carry them, as may Python `str`) match `Cs`.
 */
const NON_PRINTABLE_RE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

function isPrintable(ch: string): boolean {
	return ch === " " || !NON_PRINTABLE_RE.test(ch);
}

function hex(code: number, width: number): string {
	return code.toString(16).padStart(width, "0");
}

/** CPython `unicode_repr`: quote choice, backslash escapes, `\xNN`/`\uNNNN`/`\UNNNNNNNN`. */
function reprString(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	let out = quote;
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (ch === "\\" || ch === quote) out += `\\${ch}`;
		else if (ch === "\t") out += "\\t";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
		else if (code < 0x7f || isPrintable(ch)) out += ch;
		else if (code <= 0xff) out += `\\x${hex(code, 2)}`;
		else if (code <= 0xffff) out += `\\u${hex(code, 4)}`;
		else out += `\\U${hex(code, 8)}`;
	}
	return out + quote;
}

/** Line boundaries recognized by Python `str.splitlines()`. */
const PY_LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python `str.splitlines()` (no `keepends`): no trailing empty element; `""` → `[]`. */
export function pySplitlines(text: string): string[] {
	const lines = text.split(PY_LINE_BREAK_RE);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Whitespace per Python `str.isspace()`. */
const PY_WHITESPACE_RE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** Python `str.split()` with no separator: split on whitespace runs, dropping empty fields. */
export function pySplitWhitespace(text: string): string[] {
	return text.split(PY_WHITESPACE_RE).filter(part => part !== "");
}

/** Python `repr()` for the scalar/list values that appear in tool errors. */
export function pyRepr(value: unknown): string {
	if (typeof value === "string") return reprString(value);
	if (value === null || value === undefined) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).map(
			([k, v]) => `${reprString(k)}: ${pyRepr(v)}`,
		);
		return `{${entries.join(", ")}}`;
	}
	return String(value);
}

/** Python `str()` for JSON-decoded values (`str()` equals `repr()` for everything but `str`). */
export function pyStr(value: unknown): string {
	return typeof value === "string" ? value : pyRepr(value);
}

/** Python truthiness for JSON-decoded values: `None`, `False`, `0`, `""`, `[]`, `{}` are falsy. */
export function pyTruthy(value: unknown): boolean {
	if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

/** Python `isinstance(value, int)` for JSON-decoded values: `bool` is an `int` subclass. */
export function pyIsInt(value: unknown): value is number | boolean {
	return typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value));
}

/** Python `int(value)` for a value accepted by `pyIsInt`. */
export function pyInt(value: number | boolean): number {
	return typeof value === "boolean" ? Number(value) : value;
}

/**
 * Python `for item in (value or ())` over a JSON-decoded value: strings yield
 * code points, dicts yield keys, and a truthy non-iterable raises `TypeError`.
 */
export function pyIterOrEmpty(value: unknown): unknown[] {
	if (!pyTruthy(value)) return [];
	if (typeof value === "string") return Array.from(value);
	if (Array.isArray(value)) return value;
	if (typeof value === "object") return Object.keys(value as Record<string, unknown>);
	const typeName = typeof value === "boolean" ? "bool" : Number.isInteger(value) ? "int" : "float";
	throw new TypeError(`'${typeName}' object is not iterable`);
}

/** Python `repr(tuple)`. */
export function pyTupleRepr(values: readonly unknown[]): string {
	if (values.length === 1) return `(${pyRepr(values[0])},)`;
	return `(${values.map(pyRepr).join(", ")})`;
}

function dumpString(value: string): string {
	return JSON.stringify(value).replace(
		/[\u0080-\uffff]/g,
		ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function dump(value: unknown, indent: number | null, depth: number): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return dumpString(value);
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "NaN";
		if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
		return JSON.stringify(value);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	const items: string[] = Array.isArray(value)
		? value.map(v => dump(v, indent, depth + 1))
		: Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => `${dumpString(k)}: ${dump(v, indent, depth + 1)}`);
	const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
	if (items.length === 0) return `${open}${close}`;
	if (indent === null) return `${open}${items.join(", ")}${close}`;
	const pad = " ".repeat(indent * (depth + 1));
	return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${" ".repeat(indent * depth)}${close}`;
}

/** Python `json.dumps(value, indent=indent)` with default `ensure_ascii=True` separators. */
export function pyJsonDumps(value: unknown, options: { indent?: number } = {}): string {
	return dump(value, options.indent ?? null, 0);
}
