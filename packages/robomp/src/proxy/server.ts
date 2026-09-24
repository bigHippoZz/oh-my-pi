/**
 * gh-proxy app: HMAC-gated GitHub REST + git proxy.
 *
 * Robomp calls every endpoint with HMAC headers (see `proxy-hmac`).
 * Authenticated requests dispatch to a single `GitHubClient` holding the PAT,
 * or to `git-ops` for git transport. The PAT never leaves this process.
 *
 * Endpoint payloads are deliberately typed (no generic GitHub passthrough).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../config";
import * as gitOps from "../git-ops";
import { GitCommandError, HeadDriftError } from "../git-ops";
import { GitHubClient, GitHubError, isMapping, type Json } from "../github-client";
import { App, HttpError, json, type Query, readBodyCapped, type RouteContext } from "../http-app";
import { getLogger } from "../logging";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, verify } from "../proxy-hmac";
import { pyRepr } from "../pycompat";
import { safeDirectoryEnv } from "../sandbox";
import { runProcess, slotIdentity } from "../subprocess";

const log = getLogger("robomp.proxy.server");

/** Git primitives the proxy dispatches to (spy seam for tests). */
export const proxyGitOps = {
	clone: gitOps.clone,
	fetchPrune: gitOps.fetchPrune,
	fetchRef: gitOps.fetchRef,
	fetchPrHead: gitOps.fetchPrHead,
	push: gitOps.push,
	pushRelease: gitOps.pushRelease,
};

function ghErrorResponse(exc: GitHubError): Response {
	return json(
		{ error: { kind: "github", status: exc.status, message: exc.detail, retry_after: exc.retry_after } },
		exc.status,
	);
}

function gitErrorResponse(
	exc: GitCommandError,
	options: { headDrift?: boolean; clientError?: boolean } = {},
): Response {
	const status = options.headDrift ? 409 : options.clientError ? 400 : 502;
	return json(
		{
			error: {
				kind: options.headDrift ? "head_drift" : "git",
				returncode: exc.returncode,
				cmd: exc.cmd,
				stdout: exc.stdout,
				stderr: exc.stderr,
			},
		},
		status,
	);
}

const JSON_WS = new Set([" ", "\t", "\n", "\r"]);
const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX = /^[0-9a-fA-F]$/;
const DIGIT = /^[0-9]$/;

class PyJsonError {
	constructor(
		readonly msg: string,
		readonly pos: number,
	) {}
}

/**
 * Locate the first error CPython's C JSON scanner (3.11/3.12) reports for
 * `text` and render it as `str(json.JSONDecodeError)`; `null` when valid.
 * Positions are code-point indices, as in Python strings. Mirrors
 * `JSONDecoder.decode` → `scan_once` → `StopIteration` = "Expecting value".
 */
export function pythonJsonDecodeError(text: string): string | null {
	const s = Array.from(text);
	const len = s.length;
	const ws = (idx: number): number => {
		while (idx < len && JSON_WS.has(s[idx]!)) idx++;
		return idx;
	};
	const hex4 = (from: number): number | null => {
		let value = 0;
		for (let i = from; i < from + 4; i++) {
			if (!HEX.test(s[i]!)) return null;
			value = value * 16 + Number.parseInt(s[i]!, 16);
		}
		return value;
	};
	const scanString = (end: number): number => {
		const begin = end - 1;
		for (;;) {
			let next = end;
			let c = "";
			for (; next < len; next++) {
				c = s[next]!;
				if (c === '"' || c === "\\") break;
				if (c.codePointAt(0)! <= 0x1f) throw new PyJsonError("Invalid control character at", next);
			}
			if (next >= len) throw new PyJsonError("Unterminated string starting at", begin);
			next++;
			if (c === '"') return next;
			if (next === len) throw new PyJsonError("Unterminated string starting at", begin);
			c = s[next]!;
			if (c !== "u") {
				end = next + 1;
				if (!JSON_ESCAPES.has(c)) throw new PyJsonError("Invalid \\escape", end - 2);
				continue;
			}
			next++;
			end = next + 4;
			if (end >= len) throw new PyJsonError("Invalid \\uXXXX escape", next - 1);
			const cp = hex4(next);
			if (cp === null) throw new PyJsonError("Invalid \\uXXXX escape", end - 5);
			if (cp >= 0xd800 && cp <= 0xdbff && end + 6 < len && s[end] === "\\" && s[end + 1] === "u") {
				end += 6;
				if (hex4(end - 4) === null) throw new PyJsonError("Invalid \\uXXXX escape", end - 5);
			}
		}
	};
	const matchNumber = (start: number): number => {
		let idx = start;
		if (s[idx] === "-") {
			idx++;
			if (idx >= len) throw new PyJsonError("Expecting value", start);
		}
		if (s[idx]! >= "1" && s[idx]! <= "9") {
			idx++;
			while (idx < len && DIGIT.test(s[idx]!)) idx++;
		} else if (s[idx] === "0") {
			idx++;
		} else {
			throw new PyJsonError("Expecting value", start);
		}
		if (idx < len - 1 && s[idx] === "." && DIGIT.test(s[idx + 1]!)) {
			idx += 2;
			while (idx < len && DIGIT.test(s[idx]!)) idx++;
		}
		if (idx < len - 1 && (s[idx] === "e" || s[idx] === "E")) {
			const eStart = idx;
			idx++;
			if (idx < len - 1 && (s[idx] === "-" || s[idx] === "+")) idx++;
			while (idx < len && DIGIT.test(s[idx]!)) idx++;
			if (!DIGIT.test(s[idx - 1]!)) idx = eStart;
		}
		return idx;
	};
	const literal = (idx: number, word: string): boolean => s.slice(idx, idx + word.length).join("") === word;
	const scanOnce = (idx: number): number => {
		if (idx >= len) throw new PyJsonError("Expecting value", idx);
		const c = s[idx];
		if (c === '"') return scanString(idx + 1);
		if (c === "{") return parseObject(idx + 1);
		if (c === "[") return parseArray(idx + 1);
		for (const word of ["null", "true", "false", "NaN", "Infinity", "-Infinity"]) {
			if (c === word[0] && literal(idx, word)) return idx + word.length;
		}
		return matchNumber(idx);
	};
	const parseObject = (start: number): number => {
		let idx = ws(start);
		if (idx >= len || s[idx] !== "}") {
			for (;;) {
				if (idx >= len || s[idx] !== '"') {
					throw new PyJsonError("Expecting property name enclosed in double quotes", idx);
				}
				idx = ws(scanString(idx + 1));
				if (idx >= len || s[idx] !== ":") throw new PyJsonError("Expecting ':' delimiter", idx);
				idx = ws(scanOnce(ws(idx + 1)));
				if (idx < len && s[idx] === "}") break;
				if (idx >= len || s[idx] !== ",") throw new PyJsonError("Expecting ',' delimiter", idx);
				idx = ws(idx + 1);
			}
		}
		return idx + 1;
	};
	const parseArray = (start: number): number => {
		let idx = ws(start);
		if (idx >= len || s[idx] !== "]") {
			for (;;) {
				idx = ws(scanOnce(idx));
				if (idx < len && s[idx] === "]") break;
				if (idx >= len || s[idx] !== ",") throw new PyJsonError("Expecting ',' delimiter", idx);
				idx = ws(idx + 1);
			}
		}
		return idx + 1;
	};
	try {
		const end = ws(scanOnce(ws(0)));
		if (end !== len) throw new PyJsonError("Extra data", end);
		return null;
	} catch (err) {
		if (!(err instanceof PyJsonError)) throw err;
		const before = s.slice(0, err.pos);
		const lineno = before.filter(ch => ch === "\n").length + 1;
		const colno = err.pos - before.lastIndexOf("\n");
		return `${err.msg}: line ${lineno} column ${colno} (char ${err.pos})`;
	}
}

function requireStr(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw new HttpError(400, `missing/invalid '${field}'`);
	return value;
}

function isPyInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function requireInt(value: unknown, field: string): number {
	if (!isPyInt(value)) throw new HttpError(400, `missing/invalid '${field}'`);
	return value;
}

const SAFE_REF_BODY_RE = /^[A-Za-z0-9._/-]+$/;

/** Validate the base-branch ref for `/gh/v1/git/fetch_ref` (refspec/option injection guard). */
export function requireFetchRef(value: unknown): string {
	const ref = requireStr(value, "ref");
	const body = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
	if (
		!body ||
		ref.startsWith("-") ||
		body.startsWith("/") ||
		body.endsWith("/") ||
		body.endsWith(".") ||
		body.endsWith(".lock") ||
		body.includes("//") ||
		body.includes("..") ||
		!SAFE_REF_BODY_RE.test(body)
	) {
		throw new HttpError(400, "invalid ref");
	}
	return ref;
}

function requireBranch(value: unknown): string {
	const branch = requireFetchRef(value);
	return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

const RELEASE_TAG_RE = /^v[0-9][A-Za-z0-9._-]*$/;

function requireReleaseTag(value: unknown): string {
	const tag = requireStr(value, "tag");
	if (!RELEASE_TAG_RE.test(tag)) throw new HttpError(400, "invalid tag");
	return tag;
}

function optionalSlotUid(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (!isPyInt(value) || !(value > 0 && value < 65536)) throw new HttpError(400, "missing/invalid 'slot_uid'");
	return value;
}

function optionalStrList(value: unknown, field: string): string[] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
		throw new HttpError(400, `invalid '${field}': must be array of strings`);
	}
	return [...value];
}

function requireReviewComments(value: unknown): Json[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) throw new HttpError(400, "missing/invalid 'comments'");
	return value.map((item, idx) => {
		if (!isMapping(item)) throw new HttpError(400, `comments[${idx}] must be an object`);
		const p = requireStr(item.path, `comments[${idx}].path`);
		const line = requireInt(item.line, `comments[${idx}].line`);
		const body = requireStr(item.body, `comments[${idx}].body`);
		const side = item.side ? String(item.side) : "RIGHT";
		if (side !== "RIGHT" && side !== "LEFT") throw new HttpError(400, `comments[${idx}].side must be RIGHT or LEFT`);
		const comment: Json = { path: p, line, side, body };
		if (item.start_line !== null && item.start_line !== undefined) {
			comment.start_line = requireInt(item.start_line, `comments[${idx}].start_line`);
		}
		if (item.start_side !== null && item.start_side !== undefined) {
			const startSide = requireStr(item.start_side, `comments[${idx}].start_side`);
			if (startSide !== "RIGHT" && startSide !== "LEFT") {
				throw new HttpError(400, `comments[${idx}].start_side must be RIGHT or LEFT`);
			}
			comment.start_side = startSide;
		}
		return comment;
	});
}

const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/;
const REMOTE_HELPER_RE = /^[A-Za-z][A-Za-z0-9+.-]*::/;
const FORBIDDEN_URL_BYTES_RE = /[\x00-\x1f\x7f]|%(?:00|0a|0d)/i;
const GIT_PROBE_SCRUBBED_ENV_KEYS = [
	"ROBOMP_GIT_HTTP_AUTH",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_WEBHOOK_SECRET",
	"ROBOMP_REPLAY_TOKEN",
	"ROBOMP_GH_PROXY_HMAC_KEY",
];
const ORIGIN_READ_TIMEOUT_SECONDS = 5;

export function validateRepoName(repo: string): void {
	if (!GITHUB_REPO_RE.test(repo) || repo.includes("/..") || repo.includes("../")) {
		throw new HttpError(400, `invalid repo ${pyRepr(repo)}`);
	}
}

function githubUrlForRepo(repo: string): string {
	validateRepoName(repo);
	return `https://github.com/${repo}.git`;
}

function poolDir(cfg: Settings, repo: string): string {
	validateRepoName(repo);
	return path.join(cfg.workspace_root, "_pool", repo.replaceAll("/", "__"));
}

function workspaceRepoDir(cfg: Settings, key: string): string {
	if (key.includes("/") || key.startsWith(".") || key.includes("..")) {
		throw new HttpError(400, `invalid workspace_key ${pyRepr(key)}`);
	}
	return path.join(cfg.workspace_root, key, "repo");
}

function resolveToken(cfg: Settings): string {
	if (cfg.github_token === null) throw new HttpError(500, "gh-proxy: GITHUB_TOKEN not configured");
	return cfg.github_token.getSecretValue();
}

function resolveHmacKey(cfg: Settings): Uint8Array {
	if (cfg.gh_proxy_hmac_key === null) throw new HttpError(500, "gh-proxy: ROBOMP_GH_PROXY_HMAC_KEY not configured");
	return new TextEncoder().encode(cfg.gh_proxy_hmac_key.getSecretValue());
}

interface RemoteAuth {
	url: string;
	token: string | null;
	authUrl: string | null;
}

function gitProbeEnv(repoDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_ASKPASS = "";
	env.SSH_ASKPASS = "";
	for (const key of GIT_PROBE_SCRUBBED_ENV_KEYS) delete env[key];
	Object.assign(env, safeDirectoryEnv(repoDir));
	return env;
}

/** Read every configured fetch URL or push URL for `origin` without contacting it. */
export async function readRemoteUrls(
	repoDir: string,
	options: { slotUid?: number | null; push?: boolean } = {},
): Promise<string[]> {
	const selector = options.push ? ["--push", "--all"] : ["--all"];
	const proc = await runProcess(["git", "-C", repoDir, "remote", "get-url", ...selector, "origin"], {
		env: gitProbeEnv(repoDir),
		timeout: ORIGIN_READ_TIMEOUT_SECONDS,
		identity: slotIdentity(options.slotUid),
	});
	if (proc.timedOut) throw new HttpError(504, "timeout reading origin url");
	if (proc.returncode !== 0) {
		log.warning("gh-proxy: failed to read origin url", { repo_dir: repoDir });
		throw new HttpError(400, "could not read origin url for worktree");
	}
	return proc.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
}

async function readSingleRemoteUrl(
	repoDir: string,
	expectedRepo: string,
	options: { push: boolean; slotUid?: number | null },
): Promise<string> {
	const urls = [...new Set(await readRemoteUrls(repoDir, options))];
	if (urls.length !== 1) {
		const kind = options.push ? "push" : "fetch";
		log.warning("gh-proxy: refusing git op — origin has ambiguous remote urls", {
			expected_repo: expectedRepo,
			kind,
			count: urls.length,
		});
		throw new HttpError(400, `origin must have exactly one ${kind} url`);
	}
	return urls[0]!;
}

interface ParsedUrl {
	scheme: string;
	username: string;
	password: string;
	hostname: string;
	port: string | null;
	portInvalid: boolean;
	path: string;
	params: string;
	query: string;
	fragment: string;
}

/** `urllib.parse.urlparse` subset (scheme://netloc/path;params?query#fragment). */
function urlparse(raw: string): ParsedUrl {
	const out: ParsedUrl = {
		scheme: "",
		username: "",
		password: "",
		hostname: "",
		port: null,
		portInvalid: false,
		path: "",
		params: "",
		query: "",
		fragment: "",
	};
	let rest = raw;
	const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
	if (schemeMatch) {
		out.scheme = schemeMatch[1]!.toLowerCase();
		rest = rest.slice(schemeMatch[0].length);
	}
	if (rest.startsWith("//")) {
		rest = rest.slice(2);
		const end = rest.search(/[/?#]/);
		const netloc = end < 0 ? rest : rest.slice(0, end);
		rest = end < 0 ? "" : rest.slice(end);
		let hostport = netloc;
		const at = netloc.lastIndexOf("@");
		if (at >= 0) {
			const userinfo = netloc.slice(0, at);
			hostport = netloc.slice(at + 1);
			const colon = userinfo.indexOf(":");
			out.username = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
			out.password = colon >= 0 ? userinfo.slice(colon + 1) : "";
			if (!out.username && !out.password && userinfo === "") out.username = "";
			if (userinfo.length > 0 && !out.username && colon < 0) out.username = userinfo;
		}
		const colon = hostport.lastIndexOf(":");
		if (colon >= 0 && !hostport.endsWith("]")) {
			out.hostname = hostport.slice(0, colon).toLowerCase();
			const portStr = hostport.slice(colon + 1);
			if (portStr !== "") {
				if (!/^\d+$/.test(portStr) || Number(portStr) > 65535) out.portInvalid = true;
				else out.port = portStr;
			}
		} else {
			out.hostname = hostport.toLowerCase();
		}
	}
	const hash = rest.indexOf("#");
	if (hash >= 0) {
		out.fragment = rest.slice(hash + 1);
		rest = rest.slice(0, hash);
	}
	const q = rest.indexOf("?");
	if (q >= 0) {
		out.query = rest.slice(q + 1);
		rest = rest.slice(0, q);
	}
	const semi = rest.lastIndexOf(";");
	const lastSlash = rest.lastIndexOf("/");
	if (semi > lastSlash) {
		out.params = rest.slice(semi + 1);
		rest = rest.slice(0, semi);
	}
	out.path = rest;
	return out;
}

function normalizedGithubHttpsUrl(url: string, expectedRepo: string): string {
	validateRepoName(expectedRepo);
	const parsed = urlparse(url);
	if (parsed.scheme !== "https") {
		throw new HttpError(400, `remote url must be https://github.com/${expectedRepo}[.git]`);
	}
	if (parsed.username || parsed.password) throw new HttpError(400, "remote url must not contain embedded credentials");
	if (parsed.portInvalid) throw new HttpError(400, "remote url has invalid port");
	if (parsed.port !== null) throw new HttpError(400, "remote url must not specify a port");
	if (parsed.hostname !== "github.com") {
		throw new HttpError(400, `remote url host must be github.com for repo ${pyRepr(expectedRepo)}`);
	}
	if (parsed.params || parsed.query || parsed.fragment) {
		throw new HttpError(400, "remote url must not contain params, query, or fragment");
	}
	let p = parsed.path.replace(/^\/+|\/+$/g, "");
	if (p.endsWith(".git")) p = p.slice(0, -4);
	if (p.toLowerCase() !== expectedRepo.toLowerCase()) {
		throw new HttpError(400, `remote url does not match repo ${pyRepr(expectedRepo)}`);
	}
	return githubUrlForRepo(expectedRepo);
}

function remoteAuthForUrl(url: string, expectedRepo: string, token: string): RemoteAuth {
	const raw = url.trim();
	if (!raw || raw !== url) throw new HttpError(400, "remote url must not be empty or padded");
	if (FORBIDDEN_URL_BYTES_RE.test(raw)) throw new HttpError(400, "remote url contains forbidden control bytes");
	if (raw.startsWith("-")) throw new HttpError(400, "remote url must not start with '-'");
	if (REMOTE_HELPER_RE.test(raw)) throw new HttpError(400, "git remote helper transports are disabled");
	const scheme = urlparse(raw).scheme;
	if (scheme === "http" || scheme === "https") {
		const normalized = normalizedGithubHttpsUrl(raw, expectedRepo);
		return { url: normalized, token, authUrl: normalized };
	}
	return { url: raw, token: null, authUrl: null };
}

function cloneRemoteAuth(cloneUrl: string, expectedRepo: string, token: string): RemoteAuth {
	try {
		return remoteAuthForUrl(cloneUrl, expectedRepo, token);
	} catch (err) {
		log.warning("gh-proxy: refusing clone — clone_url is not permitted", { expected_repo: expectedRepo });
		throw err;
	}
}

async function originRemoteAuth(
	repoDir: string,
	expectedRepo: string,
	token: string,
	options: { push?: boolean; slotUid?: number | null } = {},
): Promise<RemoteAuth> {
	const url = await readSingleRemoteUrl(repoDir, expectedRepo, {
		push: options.push ?? false,
		slotUid: options.slotUid,
	});
	try {
		return remoteAuthForUrl(url, expectedRepo, token);
	} catch (err) {
		log.warning("gh-proxy: refusing git op — origin url is not permitted", {
			expected_repo: expectedRepo,
			push: options.push ?? false,
		});
		throw err;
	}
}

export interface ProxyState {
	settings: Settings;
	github: GitHubClient;
}

export type ProxyApp = App<ProxyState>;

/** Build the gh-proxy app bound to `settings`. */
export function createProxyApp(settings: Settings, options: { github?: GitHubClient } = {}): ProxyApp {
	const state: ProxyState = { settings, github: options.github ?? new GitHubClient(resolveToken(settings)) };
	const app = new App(state);

	/** Canonical signing target: `path` plus raw query string if any. */
	const requestTarget = (url: URL): string => (url.search ? `${url.pathname}${url.search}` : url.pathname);

	const authenticate = async (ctx: RouteContext<ProxyState>): Promise<Uint8Array> => {
		const body = await readBodyCapped(ctx.request, ctx.state.settings.gh_proxy_max_body_bytes);
		const result = verify({
			method: ctx.request.method,
			path: requestTarget(ctx.url),
			body,
			timestamp: ctx.request.headers.get(HEADER_TIMESTAMP),
			signature: ctx.request.headers.get(HEADER_SIGNATURE),
			key: resolveHmacKey(ctx.state.settings),
		});
		if (!result.ok) {
			log.warning("gh-proxy auth rejected", { reason: result.reason, path: ctx.url.pathname });
			throw new HttpError(401, "unauthenticated");
		}
		return body;
	};

	app.get("/healthz", () => json({ status: "ok" }));

	// ---- reads ----
	app.get("/gh/v1/authenticated_login", async ctx => {
		await authenticate(ctx);
		try {
			return json({ login: await ctx.state.github.getAuthenticatedLogin() });
		} catch (exc) {
			if (exc instanceof GitHubError) throw new HttpError(exc.status, exc.detail);
			throw exc;
		}
	});

	app.get("/gh/v1/repo", async ctx => {
		const repo = ctx.query.str("repo");
		await authenticate(ctx);
		try {
			return json(await ctx.state.github.getRepo(repo));
		} catch (exc) {
			if (exc instanceof GitHubError) return ghErrorResponse(exc);
			throw exc;
		}
	});

	const guarded = (
		route: string,
		parse: (q: Query) => () => Promise<unknown>,
		options: { validateRepo?: boolean } = {},
	): void => {
		app.get(route, async ctx => {
			const run = parse(ctx.query);
			await authenticate(ctx);
			if (options.validateRepo) validateRepoName(ctx.query.str("repo"));
			try {
				return json(await run());
			} catch (exc) {
				if (exc instanceof GitHubError) return ghErrorResponse(exc);
				throw exc;
			}
		});
	};

	guarded(
		"/gh/v1/workflow_runs",
		q => {
			const repo = q.str("repo");
			const headSha = q.str("head_sha");
			return async () => ({ items: await state.github.listWorkflowRuns(repo, headSha) });
		},
		{ validateRepo: true },
	);
	guarded(
		"/gh/v1/workflow_jobs",
		q => {
			const repo = q.str("repo");
			const runId = q.int("run_id");
			return async () => ({ items: await state.github.listWorkflowJobs(repo, runId) });
		},
		{ validateRepo: true },
	);
	guarded(
		"/gh/v1/job_log_tail",
		q => {
			const repo = q.str("repo");
			const jobId = q.int("job_id");
			const tail = q.int("tail", 200);
			return async () => ({
				text: await state.github.getJobLogTail(repo, jobId, Math.max(1, Math.min(tail, 1000))),
			});
		},
		{ validateRepo: true },
	);
	guarded(
		"/gh/v1/tag_ref",
		q => {
			const repo = q.str("repo");
			const tag = q.str("tag");
			return async () => ({ sha: await state.github.getTagSha(repo, tag) });
		},
		{ validateRepo: true },
	);
	guarded(
		"/gh/v1/release_by_tag",
		q => {
			const repo = q.str("repo");
			const tag = q.str("tag");
			return () => state.github.getReleaseByTag(repo, tag);
		},
		{ validateRepo: true },
	);
	guarded("/gh/v1/issue", q => {
		const repo = q.str("repo");
		const number = q.int("number");
		return () => state.github.getIssue(repo, number);
	});
	guarded("/gh/v1/closing_prs", q => {
		const repo = q.str("repo");
		const number = q.int("number");
		return async () => ({ pr_numbers: await state.github.listClosingPullRequests(repo, number) });
	});
	guarded("/gh/v1/pull_request", q => {
		const repo = q.str("repo");
		const number = q.int("number");
		return () => state.github.getPullRequest(repo, number);
	});
	guarded("/gh/v1/pr_files", q => {
		const repo = q.str("repo");
		const prNumber = q.int("pr_number");
		return async () => ({ items: await state.github.listPrFiles(repo, prNumber) });
	});
	guarded("/gh/v1/issues", q => {
		const repo = q.str("repo");
		const issueState = q.str("state", "open");
		const limit = q.int("limit", 30);
		return async () => ({ items: await state.github.listIssues(repo, { state: issueState, limit }) });
	});
	guarded("/gh/v1/search_issues", q => {
		const repo = q.str("repo");
		const query = q.str("q");
		const limit = q.int("limit", 10);
		return async () => ({ items: await state.github.searchIssues(repo, query, limit) });
	});
	guarded("/gh/v1/issue_index_entries", q => {
		const repo = q.str("repo");
		const since = q.optStr("since");
		const page = q.int("page", 1);
		const perPage = q.int("per_page", 100);
		return async () => ({
			items: await state.github.listIssueIndexEntries(repo, { since, page, per_page: perPage }),
		});
	});
	guarded("/gh/v1/comments", q => {
		const repo = q.str("repo");
		const number = q.int("number");
		return async () => ({ items: await state.github.listComments(repo, number) });
	});
	guarded("/gh/v1/review_comments", q => {
		const repo = q.str("repo");
		const prNumber = q.int("pr_number");
		return async () => ({ items: await state.github.listReviewComments(repo, prNumber) });
	});
	guarded("/gh/v1/pr_reviews", q => {
		const repo = q.str("repo");
		const prNumber = q.int("pr_number");
		return async () => ({ items: await state.github.listPrReviews(repo, prNumber) });
	});
	guarded("/gh/v1/comment_reactions", q => {
		const repo = q.str("repo");
		const commentId = q.int("comment_id");
		return async () => ({ items: await state.github.listCommentReactions(repo, commentId) });
	});

	// ---- writes ----
	const jsonBody = async (ctx: RouteContext<ProxyState>): Promise<Json> => {
		const body = await authenticate(ctx);
		let data: unknown;
		try {
			// Starlette `request.json()` → `json.loads(bytes)`: UTF-8 (BOM tolerated), strict decode.
			const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
			const pyError = pythonJsonDecodeError(text);
			if (pyError !== null) throw new HttpError(400, `invalid json: ${pyError}`);
			data = JSON.parse(text);
		} catch (exc) {
			if (exc instanceof HttpError) throw exc;
			throw new HttpError(400, `invalid json: ${exc instanceof Error ? exc.message : String(exc)}`);
		}
		if (!isMapping(data)) throw new HttpError(400, "json body must be an object");
		return data;
	};

	const write = (route: string, handler: (data: Json, github: GitHubClient) => Promise<unknown>): void => {
		app.post(route, async ctx => {
			const data = await jsonBody(ctx);
			try {
				return json(await handler(data, ctx.state.github));
			} catch (exc) {
				if (exc instanceof GitHubError) return ghErrorResponse(exc);
				throw exc;
			}
		});
	};

	write("/gh/v1/post_comment", (data, github) => {
		const repo = requireStr(data.repo, "repo");
		const number = requireInt(data.number, "number");
		const body = requireStr(data.body, "body");
		return github.postComment(repo, number, body);
	});
	write("/gh/v1/open_pull_request", (data, github) => {
		const args = {
			repo: requireStr(data.repo, "repo"),
			head: requireStr(data.head, "head"),
			base: requireStr(data.base, "base"),
			title: requireStr(data.title, "title"),
			body: requireStr(data.body, "body"),
			draft: Boolean(data.draft ?? false),
			maintainer_can_modify: Boolean(data.maintainer_can_modify ?? true),
		};
		return github.openPullRequest(args);
	});
	write("/gh/v1/request_reviewers", async (data, github) => {
		const args = {
			repo: requireStr(data.repo, "repo"),
			pr_number: requireInt(data.pr_number, "pr_number"),
			reviewers: optionalStrList(data.reviewers, "reviewers"),
			team_reviewers: optionalStrList(data.team_reviewers, "team_reviewers"),
		};
		await github.requestReviewers(args);
		return { ok: true };
	});
	write("/gh/v1/add_issue_labels", async (data, github) => {
		const repo = requireStr(data.repo, "repo");
		const number = requireInt(data.number, "number");
		const labels = optionalStrList(data.labels, "labels") ?? [];
		return { labels: await github.addIssueLabels(repo, number, labels) };
	});
	write("/gh/v1/remove_issue_label", async (data, github) => {
		const repo = requireStr(data.repo, "repo");
		const number = requireInt(data.number, "number");
		const label = requireStr(data.label, "label");
		await github.removeIssueLabel(repo, number, label);
		return { ok: true };
	});
	write("/gh/v1/submit_pr_review", (data, github) => {
		const repo = requireStr(data.repo, "repo");
		const prNumber = requireInt(data.pr_number, "pr_number");
		const body = requireStr(data.body, "body");
		const event = data.event ? String(data.event) : "COMMENT";
		const comments = requireReviewComments(data.comments);
		const commitId = typeof data.commit_id === "string" && data.commit_id ? data.commit_id : null;
		return github.submitPrReview({ repo, pr_number: prNumber, body, event, comments, commit_id: commitId });
	});
	write("/gh/v1/add_assignees", async (data, github) => {
		const repo = requireStr(data.repo, "repo");
		const number = requireInt(data.number, "number");
		const assignees = optionalStrList(data.assignees, "assignees") ?? [];
		await github.addAssignees(repo, number, assignees);
		return { ok: true };
	});
	write("/gh/v1/close_issue", async (data, github) => {
		const repo = requireStr(data.repo, "repo");
		const number = requireInt(data.number, "number");
		const reason = typeof data.reason === "string" && data.reason ? data.reason : "completed";
		await github.closeIssue(repo, number, reason);
		return { ok: true };
	});

	// ---- git transport ----
	/** Bound a git op with the proxy's wall-clock budget (504 on timeout). */
	const runGitOp = async <T>(name: string, op: () => Promise<T>): Promise<T> => {
		const budget = settings.gh_proxy_git_timeout_seconds;
		let timer: Timer | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new HttpError(504, `git ${name} timed out`)), budget * 1000);
		});
		try {
			return await Promise.race([op(), timeout]);
		} catch (err) {
			if (err instanceof HttpError && err.status === 504) {
				log.warning("gh-proxy: git op exceeded timeout", { op: name, timeout: budget });
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	};

	app.post("/gh/v1/git/clone", async ctx => {
		const data = await jsonBody(ctx);
		const repo = requireStr(data.repo, "repo");
		const cloneUrl = requireStr(data.clone_url, "clone_url");
		const defaultBranch = requireStr(data.default_branch, "default_branch");
		const remote = cloneRemoteAuth(cloneUrl, repo, resolveToken(settings));
		const target = poolDir(settings, repo);
		try {
			await runGitOp("clone", () =>
				proxyGitOps.clone(target, {
					cloneUrl: remote.url,
					defaultBranch,
					token: remote.token,
					authUrl: remote.authUrl,
				}),
			);
		} catch (exc) {
			if (exc instanceof GitCommandError) return gitErrorResponse(exc);
			throw exc;
		}
		return json({ pool_dir: target });
	});

	app.post("/gh/v1/git/fetch", async ctx => {
		const data = await jsonBody(ctx);
		const repo = requireStr(data.repo, "repo");
		const target = poolDir(settings, repo);
		const remote = await originRemoteAuth(target, repo, resolveToken(settings));
		try {
			await runGitOp("fetch_prune", () =>
				proxyGitOps.fetchPrune(target, { token: remote.token, remoteUrl: remote.url, authUrl: remote.authUrl }),
			);
		} catch (exc) {
			if (exc instanceof GitCommandError) return gitErrorResponse(exc);
			throw exc;
		}
		return json({ pool_dir: target });
	});

	app.post("/gh/v1/git/fetch_ref", async ctx => {
		const data = await jsonBody(ctx);
		const repo = requireStr(data.repo, "repo");
		const ref = requireFetchRef(data.ref);
		const target = poolDir(settings, repo);
		const remote = await originRemoteAuth(target, repo, resolveToken(settings));
		// fetch_ref is intentionally best-effort; never surfaces a 5xx.
		await runGitOp("fetch_ref", () =>
			proxyGitOps.fetchRef(target, ref, { token: remote.token, remoteUrl: remote.url, authUrl: remote.authUrl }),
		);
		return json({ pool_dir: target });
	});

	app.post("/gh/v1/git/fetch_pr_head", async ctx => {
		const data = await jsonBody(ctx);
		const repo = requireStr(data.repo, "repo");
		const prNumber = requireInt(data.pr_number, "pr_number");
		const target = poolDir(settings, repo);
		const remote = await originRemoteAuth(target, repo, resolveToken(settings));
		try {
			await runGitOp("fetch_pr_head", () =>
				proxyGitOps.fetchPrHead(target, prNumber, {
					token: remote.token,
					remoteUrl: remote.url,
					authUrl: remote.authUrl,
				}),
			);
		} catch (exc) {
			if (exc instanceof GitCommandError) return gitErrorResponse(exc);
			throw exc;
		}
		return json({ pool_dir: target });
	});

	const pushPreamble = async (
		data: Json,
		options: { validateRepo: boolean; release: boolean },
	): Promise<{
		repo: string;
		branch: string;
		tag: string | null;
		expectedHead: string;
		slotUid: number | null;
		repoDir: string;
		remote: RemoteAuth;
	}> => {
		const repo = requireStr(data.repo, "repo");
		if (options.validateRepo) validateRepoName(repo);
		const key = requireStr(data.workspace_key, "workspace_key");
		const branch = requireBranch(data.branch);
		const tag = options.release ? requireReleaseTag(data.tag) : null;
		const expectedHead = requireStr(data.expected_head, "expected_head");
		const slotUid = optionalSlotUid(data.slot_uid);
		if (!key.startsWith(`${repo.replaceAll("/", "__")}__`)) {
			throw new HttpError(400, "workspace_key does not match repo");
		}
		const repoDir = workspaceRepoDir(settings, key);
		let isDir = false;
		try {
			isDir = fs.statSync(repoDir).isDirectory();
		} catch {}
		if (!isDir) throw new HttpError(404, `workspace not found: ${key}`);
		const remote = await originRemoteAuth(repoDir, repo, resolveToken(settings), { push: true, slotUid });
		return { repo, branch, tag, expectedHead, slotUid, repoDir, remote };
	};

	app.post("/gh/v1/git/push", async ctx => {
		const data = await jsonBody(ctx);
		const p = await pushPreamble(data, { validateRepo: false, release: false });
		try {
			const result = await runGitOp("push", () =>
				proxyGitOps.push(p.repoDir, {
					branch: p.branch,
					expectedHead: p.expectedHead,
					token: p.remote.token,
					remoteUrl: p.remote.url,
					authUrl: p.remote.authUrl,
					slotUid: p.slotUid,
				}),
			);
			return json({ head: result.head, branch: result.branch });
		} catch (exc) {
			if (exc instanceof HeadDriftError) return gitErrorResponse(exc, { headDrift: true });
			if (exc instanceof GitCommandError) return gitErrorResponse(exc);
			throw exc;
		}
	});

	app.post("/gh/v1/git/push_release", async ctx => {
		const data = await jsonBody(ctx);
		const p = await pushPreamble(data, { validateRepo: true, release: true });
		try {
			const result = await runGitOp("push_release", () =>
				proxyGitOps.pushRelease(p.repoDir, {
					branch: p.branch,
					tag: p.tag!,
					expectedHead: p.expectedHead,
					token: p.remote.token,
					remoteUrl: p.remote.url,
					authUrl: p.remote.authUrl,
					slotUid: p.slotUid,
				}),
			);
			return json({ head: result.head, branch: result.branch, tag: p.tag });
		} catch (exc) {
			if (exc instanceof HeadDriftError) return gitErrorResponse(exc, { headDrift: true });
			if (exc instanceof GitCommandError) return gitErrorResponse(exc, { clientError: true });
			throw exc;
		}
	});

	return app;
}
