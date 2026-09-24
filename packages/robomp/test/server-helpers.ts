/** In-process harness for the orchestrator HTTP app (FastAPI `TestClient` analogue). */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../src/config";
import { dashboardPaths, resetIndexCache } from "../src/dashboard";
import { closeDatabase, getDatabase, type Database } from "../src/db";
import { GitHubClient } from "../src/github-client";
import type { HttpTransport } from "../src/http";
import { type AppPool, createApp, type RobompServer } from "../src/server";
import { tmpPath } from "./helpers";

const PLACEHOLDER_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>robomp</title></head>
  <body>
    <div id="app"></div>
    <script id="robomp-config" type="application/json">__ROBOMP_CONFIG__</script>
  </body>
</html>
`;

/**
 * Guarantee a renderable dashboard bundle (the real one comes from the web
 * build). Points the static dir at a tmp copy so tests never touch src/.
 */
export function ensureDashboardBundle(): void {
	const dir = path.join(tmpPath(), "static");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "index.html"), PLACEHOLDER_INDEX_HTML);
	dashboardPaths.staticDir = dir;
	resetIndexCache();
}

export class PausedPool implements AppPool {
	started = false;
	stopped = false;
	wakes = 0;
	async start(): Promise<void> {
		this.started = true;
	}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	wake(): void {
		this.wakes += 1;
	}
	async cancelEvent(): Promise<boolean> {
		return false;
	}
	inflightSnapshot(): string[] {
		return [];
	}
}

export class PausedPoolFactory {
	pools: PausedPool[] = [];
	create = (): PausedPool => {
		const pool = new PausedPool();
		this.pools.push(pool);
		return pool;
	};
}

export interface ClientResponse {
	status: number;
	text: string;
	headers: Headers;
	json(): any;
}

export interface Client {
	get(url: string, headers?: Record<string, string>): Promise<ClientResponse>;
	post(
		url: string,
		options?: { json?: unknown; content?: string | Uint8Array; headers?: Record<string, string> },
	): Promise<ClientResponse>;
}

function clientFor(server: RobompServer): Client {
	const send = async (request: Request): Promise<ClientResponse> => {
		const res = await server.fetch(request);
		const text = await res.text();
		return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
	};
	return {
		get: (url, headers = {}) => send(new Request(`http://testserver${url}`, { headers })),
		post: (url, options = {}) => {
			const headers: Record<string, string> = { ...options.headers };
			let body: string | Uint8Array | undefined = options.content;
			if (options.json !== undefined) {
				body = JSON.stringify(options.json);
				headers["content-type"] ??= "application/json";
			}
			return send(new Request(`http://testserver${url}`, { method: "POST", headers, body }));
		},
	};
}

/** Run `fn` against a started server with a paused pool; closes the DB afterwards. */
export async function withClient(
	settings: Settings,
	fn: (client: Client, server: RobompServer, db: Database) => Promise<void>,
	factory = new PausedPoolFactory(),
): Promise<void> {
	const server = createApp(settings, { poolFactory: factory.create });
	await server.start();
	try {
		await fn(clientFor(server), server, getDatabase(settings.sqlite_path));
	} finally {
		await server.stop();
		closeDatabase();
	}
}

/** Replace the proxy GitHub client with one wired to a mock transport. */
export function installGithubMock(server: RobompServer, transport: HttpTransport): void {
	server.state.github = new GitHubClient("token", { transport });
}

export function signedHeaders(secret: string, body: string, event: string, delivery: string): Record<string, string> {
	const sig = new Bun.CryptoHasher("sha256", secret).update(body).digest("hex");
	return {
		"X-GitHub-Event": event,
		"X-GitHub-Delivery": delivery,
		"X-Hub-Signature-256": `sha256=${sig}`,
		"Content-Type": "application/json",
	};
}

export function postWebhook(
	client: Client,
	event: string,
	delivery: string,
	payload: unknown,
	secret = "test-webhook-secret",
): Promise<ClientResponse> {
	const body = JSON.stringify(payload);
	return client.post("/webhook/github", { content: body, headers: signedHeaders(secret, body, event, delivery) });
}
