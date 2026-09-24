/**
 * Shared HMAC signing/verification for the roboomp ↔ gh-proxy channel.
 *
 * Every request is signed with HMAC-SHA256 over
 * `METHOD\npath[?query]\ntimestamp\nsha256hex(body)`. Byte-compatible with the
 * Python implementation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Headers on every roboomp→gh-proxy request. */
export const HEADER_TIMESTAMP = "X-Robomp-Timestamp";
export const HEADER_SIGNATURE = "X-Robomp-Sig";

/** ±skew permits modest clock drift while keeping the replay window small. */
export const DEFAULT_SKEW_SECONDS = 30;

type Bytes = Uint8Array | string;

function toBytes(value: Bytes): Uint8Array {
	return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function stringToSign(method: string, target: string, timestamp: string, body: Bytes): string {
	const bodyHash = new Bun.CryptoHasher("sha256").update(toBytes(body)).digest("hex");
	return [method.toUpperCase(), target, timestamp, bodyHash].join("\n");
}

function hmacHex(key: Bytes, message: string): string {
	return createHmac("sha256", toBytes(key)).update(message, "utf8").digest("hex");
}

/** Return `[timestamp, signatureHex]` for the given request shape. */
export function sign(args: {
	method: string;
	path: string;
	body: Bytes;
	key: Bytes;
	timestamp?: string;
}): [string, string] {
	const ts = args.timestamp ?? String(Math.floor(Date.now() / 1000));
	return [ts, hmacHex(args.key, stringToSign(args.method, args.path, ts, args.body))];
}

export interface VerifyResult {
	ok: boolean;
	reason: string;
}

/** Validate an incoming request. The reason is for logs only, never echoed. */
export function verify(args: {
	method: string;
	path: string;
	body: Bytes;
	timestamp: string | null | undefined;
	signature: string | null | undefined;
	key: Bytes;
	now?: number;
	skew?: number;
}): VerifyResult {
	const { timestamp, signature } = args;
	if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };
	if (!/^\s*[+-]?\d+\s*$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
	const tsInt = Number.parseInt(timestamp.trim(), 10);
	const nowInt = Math.trunc(args.now ?? Date.now() / 1000);
	if (Math.abs(nowInt - tsInt) > (args.skew ?? DEFAULT_SKEW_SECONDS)) {
		return { ok: false, reason: "timestamp outside skew window" };
	}
	const expected = hmacHex(args.key, stringToSign(args.method, args.path, timestamp, args.body));
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(signature, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature mismatch" };
	return { ok: true, reason: "" };
}
