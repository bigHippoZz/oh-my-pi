/**
 * Tiny HTTP layer over `fetch` with an injectable transport.
 *
 * The transport is a `(Request) => Response` function (default: global
 * `fetch`), which gives tests a seam equivalent to httpx's `MockTransport`.
 * Redirects are followed here (not inside fetch) so a mocked transport sees
 * every hop, matching httpx's `follow_redirects=True` behavior.
 *
 * Error model mirrors httpx as the Python callers see it:
 * - `TransportError("connect")` ≈ `httpx.ConnectError` (connection could not be
 *   established: refused, DNS, socket open, TLS handshake);
 * - `TransportError("timeout")` ≈ `httpx.TimeoutException`;
 * - `TooManyRedirectsError` ≈ `httpx.TooManyRedirects`;
 * - every other transport failure (reset after send, truncated body, protocol
 *   error) propagates unchanged, like httpx `ReadError`/`RemoteProtocolError`,
 *   so retry loops that only catch `TransportError` do not replay it.
 *
 * Timeouts: httpx `Timeout(30, connect=10)` bounds connect, each write and
 * each read separately. `fetch` exposes no connect phase, so the request is
 * bounded by `timeoutMs` until response headers arrive, and every subsequent
 * body read is bounded by `timeoutMs` of inactivity (httpx read timeout).
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

/** Raised when a redirect chain exceeds `maxRedirects` (httpx TooManyRedirects). */
export class TooManyRedirectsError extends Error {
	constructor(message = "Exceeded maximum allowed redirects.") {
		super(message);
		this.name = "TooManyRedirects";
	}
}

/**
 * Bun `fetch` error codes raised before a connection is established (httpx
 * `ConnectError`): refused/unreachable/DNS failures surface as
 * `ConnectionRefused` or `FailedToOpenSocket`; the POSIX/libuv spellings and
 * TLS handshake/certificate failures are included for non-Bun transports.
 * Codes like `ECONNRESET`/`ConnectionClosed` happen after the request was
 * sent and are deliberately absent.
 */
const CONNECT_ERROR_CODES = new Set([
	"ConnectionRefused",
	"FailedToOpenSocket",
	"UnableToConnect",
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EADDRNOTAVAIL",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Bun/POSIX codes for timeouts raised by the socket layer itself. */
const TIMEOUT_ERROR_CODES = new Set(["ETIMEDOUT", "ConnectionTimeout", "Timeout"]);

function errorCode(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
	const code = err.code;
	return typeof code === "string" ? code : undefined;
}

function errorName(err: unknown): string | undefined {
	return err instanceof Error || err instanceof DOMException ? err.name : undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error || err instanceof DOMException ? err.message : String(err);
}

/**
 * Map a raw transport rejection to the retryable `TransportError` kinds, or
 * `null` when it is not a connect/timeout failure (propagate unchanged).
 */
export function classifyTransportError(err: unknown): TransportError | null {
	if (err instanceof TransportError) return err;
	const code = errorCode(err);
	if (errorName(err) === "TimeoutError" || (code !== undefined && TIMEOUT_ERROR_CODES.has(code))) {
		return new TransportError(errorMessage(err), "timeout", { cause: err });
	}
	if (code !== undefined && CONNECT_ERROR_CODES.has(code)) {
		return new TransportError(errorMessage(err), "connect", { cause: err });
	}
	return null;
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
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

function effectivePort(url: URL): string {
	return url.port || DEFAULT_PORTS[url.protocol] || "";
}

function sameOrigin(a: URL, b: URL): boolean {
	return a.protocol === b.protocol && a.hostname === b.hostname && effectivePort(a) === effectivePort(b);
}

/** httpx `_is_https_redirect`: same host, http→https on default ports. */
function isHttpsRedirect(from: URL, to: URL): boolean {
	if (from.hostname !== to.hostname) return false;
	return (
		from.protocol === "http:" &&
		effectivePort(from) === "80" &&
		to.protocol === "https:" &&
		effectivePort(to) === "443"
	);
}

/** httpx `_redirect_method`. */
function redirectMethod(method: string, status: number): string {
	if ((status === 303 || status === 302) && method !== "HEAD") return "GET";
	if (status === 301 && method === "POST") return "GET";
	return method;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) delete headers[key];
	}
}

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
	for (let redirects = 0; ; redirects++) {
		const response = await sendOnce(transport, url, method, headers, body, timeoutMs);
		const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
		if (!follow || !location) return response;
		await response.body?.cancel().catch(() => {});
		if (redirects + 1 > maxRedirects) throw new TooManyRedirectsError();
		const next = new URL(location, url);
		// httpx `_redirect_headers`: never forward credentials to another origin.
		if (!sameOrigin(url, next) && !isHttpsRedirect(url, next)) deleteHeader(headers, "Authorization");
		deleteHeader(headers, "Cookie");
		const nextMethod = redirectMethod(method, response.status);
		if (nextMethod !== method && nextMethod === "GET") {
			body = undefined;
			deleteHeader(headers, "Content-Type");
			deleteHeader(headers, "Content-Length");
			deleteHeader(headers, "Transfer-Encoding");
		}
		method = nextMethod;
		url = next;
	}
}

async function sendOnce(
	transport: HttpTransport,
	url: URL,
	method: string,
	headers: Record<string, string>,
	body: string | Uint8Array<ArrayBuffer> | undefined,
	timeoutMs: number,
): Promise<Response> {
	const bounded = timeoutMs > 0 && Number.isFinite(timeoutMs);
	const controller = new AbortController();
	const request = new Request(url.href, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : body,
		redirect: "manual",
		signal: controller.signal,
	});
	const timedOut = Promise.withResolvers<never>();
	const timer = bounded
		? setTimeout(() => {
				const err = new TransportError(`timed out after ${timeoutMs}ms`, "timeout");
				timedOut.reject(err);
				controller.abort(err);
			}, timeoutMs)
		: undefined;
	let response: Response;
	try {
		response = await Promise.race([Promise.resolve(transport(request)), timedOut.promise]);
	} catch (err) {
		throw classifyTransportError(err) ?? err;
	} finally {
		clearTimeout(timer);
	}
	if (!bounded || !response.body || NULL_BODY_STATUSES.has(response.status)) return response;
	return new Response(boundedBody(response.body, timeoutMs, controller), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Re-stream `source` so each read waits at most `timeoutMs` (httpx read
 * timeout). A stalled read raises `TransportError("timeout")`; other read
 * failures propagate unchanged (httpx `ReadError`, not retried).
 */
function boundedBody(
	source: ReadableStream<Uint8Array>,
	timeoutMs: number,
	controller: AbortController,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(sink) {
			const stalled = Promise.withResolvers<never>();
			const timer = setTimeout(() => {
				const err = new TransportError(`read timed out after ${timeoutMs}ms`, "timeout");
				// Reject first: cancelling settles the pending read as `done`.
				stalled.reject(err);
				controller.abort(err);
				reader.cancel(err).catch(() => {});
			}, timeoutMs);
			try {
				const chunk = await Promise.race([reader.read(), stalled.promise]);
				if (chunk.done) sink.close();
				else sink.enqueue(chunk.value);
			} catch (err) {
				if (err instanceof TransportError || errorName(err) !== "TimeoutError") throw err;
				throw new TransportError(errorMessage(err), "timeout", { cause: err });
			} finally {
				clearTimeout(timer);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
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
