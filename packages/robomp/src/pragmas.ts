/**
 * Slash-command pragmas for maintainer directives.
 *
 * A pragma is structured metadata a maintainer attaches to a directive
 * comment to steer the agent run, as slash-commands on their own line:
 *
 * ```
 * @robomp-bot /model gpt /thinking low
 * fix the off-by-one in foo()
 * ```
 *
 * Either `/key value` or `/key=value` form is accepted. A line is consumed
 * only when every whitespace-separated token on it is a valid slash command,
 * so an inline `/path/to/file` reference in prose never tokenizes. Consumed
 * lines are stripped from the body. Duplicate keys keep insertion order.
 *
 * Supported keys: `/model <alias>` and `/thinking <level>`.
 */
import type { ThinkingLevel } from "./config";

export type Pragma = readonly [string, string];

/** Key = letter first, then letters/digits/dash/underscore (case-insensitive). */
const KEY_RE = /^[a-z][a-z0-9_-]*$/i;

/** Parse one line as a sequence of slash commands; null if not a pure command line. */
function parseCommandLine(line: string): Pragma[] | null {
	const stripped = line.trim();
	if (!stripped || !stripped.startsWith("/")) return null;
	const tokens = stripped.split(/\s+/);
	const pairs: Pragma[] = [];
	let i = 0;
	while (i < tokens.length) {
		const tok = tokens[i]!;
		if (!tok.startsWith("/") || tok.length < 2) return null;
		const eq = tok.indexOf("=");
		if (eq >= 0) {
			const key = tok.slice(1, eq);
			const value = tok.slice(eq + 1);
			if (!KEY_RE.test(key) || !value) return null;
			pairs.push([key.toLowerCase(), value]);
			i += 1;
			continue;
		}
		const key = tok.slice(1);
		if (!KEY_RE.test(key)) return null;
		if (i + 1 >= tokens.length || tokens[i + 1]!.startsWith("/")) return null;
		pairs.push([key.toLowerCase(), tokens[i + 1]!]);
		i += 2;
	}
	return pairs.length > 0 ? pairs : null;
}

/** Python `str.splitlines(keepends=True)`. */
export function splitLinesKeepEnds(text: string): string[] {
	const out: string[] = [];
	const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
	let last = 0;
	for (const match of text.matchAll(re)) {
		const end = match.index! + match[0].length;
		out.push(text.slice(last, end));
		last = end;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/** Split `body` into `[cleanedBody, pragmas]`. */
export function parsePragmas(body: string): [string, Pragma[]] {
	if (!body) return [body, []];
	const found: Pragma[] = [];
	const kept: string[] = [];
	for (const line of splitLinesKeepEnds(body)) {
		const commands = parseCommandLine(line.replace(/[\r\n]+$/, ""));
		if (commands === null) {
			kept.push(line);
			continue;
		}
		found.push(...commands);
	}
	return [kept.join("").replace(/^[\r\n]+|[\r\n]+$/g, ""), found];
}

/** Return the last value for `key` (last-wins), or null if absent. */
export function pragmaValue(pragmas: readonly Pragma[], key: string): string | null {
	const target = key.toLowerCase();
	let result: string | null = null;
	for (const [k, v] of pragmas) if (k === target) result = v;
	return result;
}

/**
 * Case-insensitive match of `alias` against each member of `pool`.
 * Precedence: full-id exact > short-name-after-slash exact > substring.
 */
export function resolveModelAlias(alias: string, pool: readonly string[]): string | null {
	const needle = alias.trim().toLowerCase();
	if (!needle) return null;
	let exact: string | null = null;
	let partial: string | null = null;
	for (const model of pool) {
		const lower = model.toLowerCase();
		if (lower === needle) return model;
		if (exact === null && lower.slice(lower.lastIndexOf("/") + 1) === needle) exact = model;
		if (partial === null && lower.includes(needle)) partial = model;
	}
	return exact ?? partial;
}

const THINKING_ALIASES: Record<string, ThinkingLevel> = {
	off: "off",
	none: "off",
	no: "off",
	lo: "low",
	low: "low",
	med: "medium",
	medium: "medium",
	hi: "high",
	high: "high",
	xhi: "xhigh",
	xhigh: "xhigh",
	max: "max",
};

/** Normalize a thinking pragma to a canonical level, or null if unknown. */
export function resolveThinkingLevel(value: string): ThinkingLevel | null {
	const key = value.trim().toLowerCase();
	return Object.hasOwn(THINKING_ALIASES, key) ? THINKING_ALIASES[key]! : null;
}
