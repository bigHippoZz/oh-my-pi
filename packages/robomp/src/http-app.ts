/**
 * Minimal routing layer over `Bun.serve`'s `fetch(Request)` handler.
 *
 * Mirrors the FastAPI behaviors the Python servers relied on:
 * - `HttpError(status, detail)` → `{"detail": ...}` JSON (FastAPI `HTTPException`).
 * - Query/body parameter validation failures → 422 `{"detail": [...]}`.
 * - Unknown route → 404 `{"detail": "Not Found"}`; wrong method → 405.
 *
 * An `App` is just `fetch(Request) => Promise<Response>`, so tests drive it
 * in-process (httpx `ASGITransport` analogue) without binding a port.
 */
import { getLogger } from "./logging";

const log = getLogger("robomp.http");

/** FastAPI `HTTPException` analogue. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly detail: unknown,
		readonly headers: Record<string, string> = {},
	) {
		super(typeof detail === "string" ? detail : JSON.stringify(detail));
		this.name = "HttpError";
	}
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

/** 422 in FastAPI's validation-error shape. */
export function validationError(loc: (string | number)[], msg: string, type = "value_error"): HttpError {
	return new HttpError(422, [{ type, loc, msg }]);
}

/** Typed accessor over URL query parameters with FastAPI-style validation. */
export class Query {
	constructor(readonly params: URLSearchParams) {}

	has(name: string): boolean {
		return this.params.has(name);
	}

	optStr(name: string): string | null {
		return this.params.get(name);
	}

	str(name: string, fallback?: string): string {
		const value = this.params.get(name);
		if (value !== null) return value;
		if (fallback !== undefined) return fallback;
		throw validationError(["query", name], "Field required", "missing");
	}

	int(name: string, fallback?: number): number {
		const value = this.params.get(name);
		if (value === null) {
			if (fallback !== undefined) return fallback;
			throw validationError(["query", name], "Field required", "missing");
		}
		if (!/^\s*[+-]?\d+\s*$/.test(value)) {
			throw validationError(
				["query", name],
				"Input should be a valid integer, unable to parse string as an integer",
				"int_parsing",
			);
		}
		return Number.parseInt(value, 10);
	}

	optInt(name: string): number | null {
		return this.params.has(name) ? this.int(name) : null;
	}

	bool(name: string, fallback: boolean): boolean {
		const value = this.params.get(name);
		if (value === null) return fallback;
		const norm = value.trim().toLowerCase();
		if (["1", "true", "t", "yes", "y", "on"].includes(norm)) return true;
		if (["0", "false", "f", "no", "n", "off"].includes(norm)) return false;
		throw validationError(["query", name], "Input should be a valid boolean", "bool_parsing");
	}
}

export interface RouteContext<S = unknown> {
	request: Request;
	url: URL;
	query: Query;
	params: Record<string, string>;
	state: S;
}

export type Handler<S> = (ctx: RouteContext<S>) => Response | Promise<Response>;

interface Route<S> {
	method: string;
	pattern: RegExp;
	keys: string[];
	handler: Handler<S>;
}

function compilePath(path: string): { pattern: RegExp; keys: string[] } {
	const keys: string[] = [];
	const source = path
		.split("/")
		.map(segment => {
			const param = /^\{(\w+)(:path)?\}$/.exec(segment);
			if (!param) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			keys.push(param[1]!);
			return param[2] ? "(.+)" : "([^/]+)";
		})
		.join("/");
	return { pattern: new RegExp(`^${source}$`), keys };
}

/** Tiny router with FastAPI-compatible error mapping. */
export class App<S> {
	readonly #routes: Route<S>[] = [];
	#fallback: Handler<S> | null = null;

	constructor(readonly state: S) {}

	route(method: string, path: string, handler: Handler<S>): this {
		const { pattern, keys } = compilePath(path);
		this.#routes.push({ method: method.toUpperCase(), pattern, keys, handler });
		return this;
	}

	get(path: string, handler: Handler<S>): this {
		return this.route("GET", path, handler);
	}

	post(path: string, handler: Handler<S>): this {
		return this.route("POST", path, handler);
	}

	/** Handler for requests no route matched (e.g. static files). */
	fallback(handler: Handler<S>): this {
		this.#fallback = handler;
		return this;
	}

	fetch = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		let pathMatched = false;
		try {
			for (const route of this.#routes) {
				const match = route.pattern.exec(url.pathname);
				if (!match) continue;
				pathMatched = true;
				if (route.method !== method && !(route.method === "GET" && method === "HEAD")) continue;
				const params: Record<string, string> = {};
				route.keys.forEach((key, i) => {
					params[key] = decodeURIComponent(match[i + 1]!);
				});
				return await route.handler({ request, url, query: new Query(url.searchParams), params, state: this.state });
			}
			if (this.#fallback && (method === "GET" || method === "HEAD")) {
				return await this.#fallback({
					request,
					url,
					query: new Query(url.searchParams),
					params: {},
					state: this.state,
				});
			}
			if (pathMatched) return json({ detail: "Method Not Allowed" }, 405);
			return json({ detail: "Not Found" }, 404);
		} catch (err) {
			if (err instanceof HttpError) return json({ detail: err.detail }, err.status, err.headers);
			log.exception("unhandled error in request handler", err, { path: url.pathname, method });
			return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } });
		}
	};
}

/**
 * Read the request body with a hard byte cap: reject on a declared
 * `Content-Length` above the cap before reading, then stream with a running
 * counter so a client that lies about (or omits) the header still can't get
 * more than `maxBytes` into memory.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
	const cl = request.headers.get("content-length");
	if (cl !== null) {
		if (!/^\s*\d+\s*$/.test(cl)) throw new HttpError(400, "invalid content-length");
		if (Number.parseInt(cl, 10) > maxBytes) throw new HttpError(413, "request body too large");
	}
	if (!request.body) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of request.body) {
		if (chunk.length === 0) continue;
		total += chunk.length;
		if (total > maxBytes) throw new HttpError(413, "request body too large");
		chunks.push(chunk);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
