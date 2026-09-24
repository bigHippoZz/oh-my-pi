/**
 * Byte-exact renderings of Python builtins that leak into agent-visible text
 * (`repr()` in error messages, `json.dumps()` in tool results/artifacts).
 */

function reprString(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	let out = quote;
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (ch === "\\") out += "\\\\";
		else if (ch === quote) out += `\\${quote}`;
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
		else out += ch;
	}
	return out + quote;
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
