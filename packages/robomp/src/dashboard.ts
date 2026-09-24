/**
 * Status dashboard helpers: log tail + the static SPA served at `/`.
 *
 * The HTML/JS/CSS live under `src/static/`, produced by the Vite build in
 * `web/`. This module locates the bundle, substitutes the per-instance config
 * sentinel, and serves hashed assets under `/static/*`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// Tail at most this many bytes from the end of the log file.
const TAIL_MAX_BYTES = 2 * 1024 * 1024;

// Sentinel literally embedded in the built `index.html`; replaced per request
// with a JSON config blob so the SPA can pick up the replay token.
const CONFIG_SENTINEL = "__ROBOMP_CONFIG__";

/** Bundle location (test seam: tests may point it at a tmp dir). */
export const dashboardPaths = {
	staticDir: path.join(import.meta.dir, "static"),
};

export type LogEntry = Record<string, unknown>;

/**
 * Return up to `limit` JSON log records from the tail of `file` (oldest first).
 * Unparseable lines come back as `{"level": "RAW", "msg": <line>}` so a
 * malformed final line never blanks the whole view.
 */
export function tailJsonl(file: string, limit: number): LogEntry[] {
	if (limit <= 0) return [];
	let size: number;
	try {
		size = fs.statSync(file).size;
	} catch {
		return [];
	}
	if (size === 0) return [];
	const readSize = Math.min(size, TAIL_MAX_BYTES);
	let chunk = Buffer.alloc(readSize);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, chunk, 0, readSize, size - readSize);
	} finally {
		fs.closeSync(fd);
	}
	// If we started mid-line, drop the partial leading line.
	if (readSize < size) {
		const nl = chunk.indexOf(0x0a);
		if (nl === -1) return [];
		chunk = chunk.subarray(nl + 1);
	}
	const lines = splitBytesLines(chunk);
	const out: LogEntry[] = [];
	for (const raw of lines.slice(-limit)) {
		const line = raw.toString("utf-8").trim();
		if (!line) continue;
		try {
			const obj: unknown = JSON.parse(line);
			if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
				out.push(obj as LogEntry);
				continue;
			}
		} catch {}
		out.push({ level: "RAW", logger: "raw", msg: line });
	}
	return out;
}

/** Python `bytes.splitlines()` (no trailing empty element). */
function splitBytesLines(buf: Buffer): Buffer[] {
	const out: Buffer[] = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		const byte = buf[i]!;
		if (byte === 0x0a || byte === 0x0d) {
			out.push(buf.subarray(start, i));
			if (byte === 0x0d && buf[i + 1] === 0x0a) i++;
			start = i + 1;
		}
	}
	if (start < buf.length) out.push(buf.subarray(start));
	return out;
}

/** The built frontend bundle is unavailable (run `bun run robomp-ts:web:build`). */
export class DashboardBundleMissing extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DashboardBundleMissing";
	}
}

/** Filesystem directory served at `/static` (created lazily). */
export function staticDir(): string {
	fs.mkdirSync(dashboardPaths.staticDir, { recursive: true });
	return dashboardPaths.staticDir;
}

let indexTemplate: string | null = null;

function loadIndexTemplate(): string {
	if (indexTemplate !== null) return indexTemplate;
	const indexPath = path.join(dashboardPaths.staticDir, "index.html");
	let text: string;
	try {
		text = fs.readFileSync(indexPath, "utf-8");
	} catch {
		throw new DashboardBundleMissing(`frontend bundle missing at ${indexPath}; run \`bun run robomp-ts:web:build\``);
	}
	if (!text.includes(CONFIG_SENTINEL)) {
		throw new DashboardBundleMissing(
			`frontend bundle at ${indexPath} is missing the ${CONFIG_SENTINEL} sentinel; rebuild with \`bun run robomp-ts:web:build\``,
		);
	}
	indexTemplate = text;
	return text;
}

/** Drop the cached template (tests that swap the static dir). */
export function resetIndexCache(): void {
	indexTemplate = null;
}

/**
 * Render the dashboard HTML with the server's replay token baked into a
 * `<script type="application/json">` block the SPA reads at startup.
 */
export function renderIndex(replayToken: string | null): string {
	const config = { replayEnabled: Boolean(replayToken), replayToken: replayToken || "" };
	// `</` would otherwise let an attacker-controlled token break out of the script element.
	const payload = JSON.stringify(config)
		.replace(/[\u0080-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.replaceAll("</", "<\\/");
	return loadIndexTemplate().replaceAll(CONFIG_SENTINEL, payload);
}

/** Serve `/static/<rel>` from the bundle dir; `null` when absent or escaping the dir. */
export function staticFile(rel: string): Bun.BunFile | null {
	const root = path.resolve(staticDir());
	const target = path.resolve(root, rel);
	if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
	try {
		if (!fs.statSync(target).isFile()) return null;
	} catch {
		return null;
	}
	return Bun.file(target);
}
