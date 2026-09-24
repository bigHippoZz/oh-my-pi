/**
 * Tiny HTTP layer over `fetch` with an injectable transport.
 *
 * The transport is a `(Request) => Response` function (default: global
 * `fetch`), which gives tests a seam equivalent to httpx's `MockTransport`.
 * Redirects are followed here (not inside fetch) so a mocked transport sees
 * every hop, matching httpx's `follow_redirects=True` behavior.
 */

export type HttpTransport = (request: Request) => Promise<Response> | Response;

export const defaultTransport: HttpTransport = request => fetch(request, { redirect: "manual" });

/** Raised when the transport cannot connect or the request times out (httpx ConnectError/TimeoutException). */
export class TransportError extends Error {
	constructor(
		message: string,
		readonly kind: "connect" | "timeout",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "TransportError";
	}
}

export type QueryValue = string | number | boolean | null | undefined;

export interface HttpRequestOptions {
	method: string;
	url: string;
	headers?: Record<string, string>;
	params?: Record<string, QueryValue>;
	json?: unknown;
	body?: string | Uint8Array;
	timeoutMs?: number;
	followRedirects?: boolean;
	maxRedirects?: number;
}

export function buildUrl(base: string, pathOrUrl: string, params?: Record<string, QueryValue>): URL {
	const url = /^https?:\/\//.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(base.replace(/\/$/, "") + pathOrUrl);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === null) continue;
			url.searchParams.append(key, typeof value === "boolean" ? (value ? "true" : "false") : String(value));
		}
	}
	return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Send one request through `transport`, following redirects when asked. */
export async function sendRequest(
	transport: HttpTransport,
	base: string,
	options: HttpRequestOptions,
): Promise<Response> {
	let method = options.method.toUpperCase();
	let url = buildUrl(base, options.url, options.params);
	const headers: Record<string, string> = { ...options.headers };
	let body: string | Uint8Array<ArrayBuffer> | undefined = options.body as
		| string
		| Uint8Array<ArrayBuffer>
		| undefined;
	if (options.json !== undefined) {
		body = JSON.stringify(options.json);
		headers["Content-Type"] = "application/json";
	}
	const follow = options.followRedirects ?? true;
	const maxRedirects = options.maxRedirects ?? 20;
	const timeoutMs = options.timeoutMs ?? 30_000;
	for (let hop = 0; ; hop++) {
		const request = new Request(url.href, {
			method,
			headers,
			body: method === "GET" || method === "HEAD" ? undefined : body,
			redirect: "manual",
		});
		let response: Response;
		try {
			response = await withTimeout(Promise.resolve(transport(request)), timeoutMs);
		} catch (err) {
			if (err instanceof TransportError) throw err;
			throw new TransportError(err instanceof Error ? err.message : String(err), "connect", { cause: err });
		}
		if (!follow || !REDIRECT_STATUSES.has(response.status) || hop >= maxRedirects) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		url = new URL(location, url);
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
			method = "GET";
			body = undefined;
			delete headers["Content-Type"];
		}
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return promise;
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new TransportError(`timed out after ${timeoutMs}ms`, "timeout")), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Build a transport from a handler (tests; httpx `MockTransport` analogue). */
export function mockTransport(handler: (request: Request) => Response | Promise<Response>): HttpTransport {
	return handler;
}

export function jsonResponse(status: number, data: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}
