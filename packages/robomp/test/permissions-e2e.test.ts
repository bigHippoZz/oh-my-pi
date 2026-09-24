/**
 * Slot-permission end-to-end tests (port of test_permissions_e2e.py).
 *
 * Gated by `ROBOMP_PERMISSION_E2E=1`; they need Linux root so repo commands
 * really drop to the omp-N slot UIDs via setpriv.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "../src/db";
import type { GitHubBackend } from "../src/github-backend";
import {
	repoCommandEnv,
	runPrePublishBunCheck,
	runRepoCommand,
	guardedPushBranch,
	ToolBindings,
} from "../src/host-tools";
import { computeKey as nativesComputeKey, NativesCache } from "../src/natives-cache";
import { chmodFull } from "../src/posix";
import { LocalGitTransport, SandboxManager, type Workspace } from "../src/sandbox";
import type { CompletedProcess } from "../src/subprocess";
import { makeDb, onCleanup } from "./helpers";

const SLOT_ONE = 2001;
const SLOT_TWO = 2002;
const SHARED_OMP_GID = 2000;
const AUTHOR_NAME = "robomp-bot";
const AUTHOR_EMAIL = "robomp-bot@example.invalid";
const REPO = "octo/permission-e2e";

const enabled = process.env.ROBOMP_PERMISSION_E2E === "1";

function toolchainSkipReason(): string | null {
	if (process.platform !== "linux" || process.geteuid?.() !== 0) {
		return "slot permission e2e tests require Linux root so subprocesses can drop to omp-N UIDs";
	}
	const missing = ["git", "bun", "cargo", "python3"].filter(cmd => Bun.which(cmd) === null);
	if (missing.length > 0) return `slot permission e2e tests require tools on PATH: ${missing.join(", ")}`;
	return null;
}

function git(args: string[], cwd: string, env?: Record<string, string | undefined>): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd, env: env ?? process.env, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

function writeSeedRepo(seed: string): void {
	fs.mkdirSync(path.join(seed, "src"), { recursive: true });
	fs.mkdirSync(path.join(seed, "crates", "core", "src"), { recursive: true });
	fs.writeFileSync(
		path.join(seed, "package.json"),
		`${JSON.stringify(
			{
				name: "permission-e2e",
				private: true,
				type: "module",
				scripts: {
					check: "bun run check:ts && cargo check --workspace",
					"check:ts": "biome check src/index.ts",
					fix: "biome check --write --unsafe src/index.ts",
				},
				devDependencies: { "@biomejs/biome": "^2.4.14" },
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(path.join(seed, ".gitignore"), "node_modules/\n");
	fs.writeFileSync(path.join(seed, "src", "index.ts"), "export const answer = 42;\n");
	fs.writeFileSync(path.join(seed, "Cargo.toml"), '[workspace]\nmembers = ["crates/core"]\nresolver = "2"\n');
	fs.writeFileSync(path.join(seed, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\nprofile = "minimal"\n');
	fs.writeFileSync(
		path.join(seed, "crates", "core", "Cargo.toml"),
		'[package]\nname = "permission-e2e-core"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
	);
	fs.writeFileSync(path.join(seed, "crates", "core", "src", "lib.rs"), "pub fn answer() -> u32 {\n    42\n}\n");
}

/** Scoped env override restored after the test (pytest `monkeypatch.setenv`). */
function setEnv(key: string, value: string): void {
	const saved = process.env[key];
	process.env[key] = value;
	onCleanup(() => {
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	});
}

function slotTmpPath(): string {
	const root = fs.mkdtempSync(path.join("/tmp", "robomp-permission-e2e-"));
	fs.chmodSync(root, 0o755);
	onCleanup(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function shareTreeWithSlots(root: string): void {
	const visit = (dir: string): void => {
		fs.chownSync(dir, 0, SHARED_OMP_GID);
		chmodFull(dir, 0o2770);
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const child = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(child);
			} else {
				const executable = fs.statSync(child).mode & 0o111;
				fs.chownSync(child, 0, SHARED_OMP_GID);
				fs.chmodSync(child, executable ? 0o770 : 0o660);
			}
		}
	};
	visit(root);
}

function upstreamRepo(tmp: string): string {
	const upstream = path.join(tmp, "upstream.git");
	const seed = path.join(tmp, "seed");
	fs.mkdirSync(seed);
	writeSeedRepo(seed);
	git(["init", "--initial-branch=main", "--bare", upstream], tmp);
	git(["init", "--initial-branch=main", seed], tmp);
	git(["-C", seed, "add", "."], tmp);
	git(["-C", seed, "commit", "-m", "seed"], tmp, {
		...process.env,
		GIT_AUTHOR_NAME: "seed",
		GIT_AUTHOR_EMAIL: "seed@example.invalid",
		GIT_COMMITTER_NAME: "seed",
		GIT_COMMITTER_EMAIL: "seed@example.invalid",
	});
	git(["-C", seed, "remote", "add", "origin", upstream], tmp);
	git(["-C", seed, "push", "origin", "main"], tmp);
	shareTreeWithSlots(upstream);
	const systemConfig = path.join(tmp, "git-system.conf");
	git(["config", "--file", systemConfig, "--add", "safe.directory", upstream], tmp);
	fs.chmodSync(systemConfig, 0o644);
	setEnv("GIT_CONFIG_SYSTEM", systemConfig);
	return upstream;
}

function ensureWorkspace(
	root: string,
	upstream: string,
	options: { number: number; slotUid: number; existingBranch?: string | null },
): Promise<Workspace> {
	const manager = new SandboxManager(root, { transport: new LocalGitTransport(null) });
	return manager.ensureWorkspace({
		repo: REPO,
		number: options.number,
		title: "permission e2e",
		cloneUrl: upstream,
		defaultBranch: "main",
		existingBranch: options.existingBranch ?? null,
		authorName: AUTHOR_NAME,
		authorEmail: AUTHOR_EMAIL,
		slotUid: options.slotUid,
	});
}

function bindingsFor(db: Database, workspace: Workspace, upstream: string, slotUid: number): ToolBindings {
	return new ToolBindings({
		db,
		// Not used by these local-only host-tool paths.
		github: {} as GitHubBackend,
		gitTransport: new LocalGitTransport(null),
		repo: { full_name: REPO, default_branch: "main", clone_url: upstream, private: false },
		issue: {
			repo: REPO,
			number: Number(workspace.issue_number),
			title: "permission e2e",
			body: "",
			state: "open",
			author: "human",
			labels: [],
			is_pull_request: false,
		},
		workspace,
		authorName: AUTHOR_NAME,
		authorEmail: AUTHOR_EMAIL,
		slotUid,
	});
}

async function runOk(bindings: ToolBindings, cmd: string[], timeout = 180): Promise<CompletedProcess> {
	const proc = await runRepoCommand(bindings, cmd, { timeout });
	if (proc.returncode !== 0) {
		throw new Error(
			`command failed as slot ${bindings.slotUid}: ${cmd.join(" ")}\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
		);
	}
	return proc;
}

function writeAsSlot(bindings: ToolBindings, relativePath: string, content: string): Promise<CompletedProcess> {
	return runOk(bindings, [
		"python3",
		"-c",
		"from pathlib import Path; " +
			"Path(__import__('sys').argv[1]).parent.mkdir(parents=True, exist_ok=True); " +
			"Path(__import__('sys').argv[1]).write_text(__import__('sys').argv[2], encoding='utf-8')",
		relativePath,
		content,
	]);
}

function prepareSharedCargoCache(tmp: string): string {
	const cargoHome = path.join(tmp, "shared-cache", "cargo");
	const cargoTarget = path.join(tmp, "shared-cache", "cargo-target");
	for (const p of [cargoHome, cargoTarget]) {
		fs.mkdirSync(p, { recursive: true });
		fs.chownSync(p, 0, SHARED_OMP_GID);
		chmodFull(p, 0o2770);
	}
	setEnv("CARGO_HOME", cargoHome);
	setEnv("CARGO_TARGET_DIR", cargoTarget);
	return cargoTarget;
}

describe.skipIf(!enabled)("slot permission e2e", () => {
	test("slot workspace runs bun, biome, cargo and git after root re-entry", async () => {
		const skip = toolchainSkipReason();
		if (skip) return void console.warn(skip);
		const tmp = slotTmpPath();
		const upstream = upstreamRepo(tmp);
		const db = makeDb();
		const cargoTarget = prepareSharedCargoCache(tmp);
		const workspaces = path.join(tmp, "workspaces");

		const first = await ensureWorkspace(workspaces, upstream, { number: 101, slotUid: SLOT_ONE });
		const staleBunCache = path.join(first.root, ".omp-xdg", "cache", "bun-install", "root-owned-stale");
		fs.mkdirSync(staleBunCache, { recursive: true });
		const staleMarker = path.join(staleBunCache, "marker.txt");
		fs.writeFileSync(staleMarker, "root-owned\n");
		fs.chmodSync(staleBunCache, 0o700);
		fs.chmodSync(staleMarker, 0o600);

		const workspace = await ensureWorkspace(workspaces, upstream, {
			number: 101,
			slotUid: SLOT_ONE,
			existingBranch: first.branch,
		});
		const bindings = bindingsFor(db, workspace, upstream, SLOT_ONE);

		await runOk(bindings, ["bun", "install", "--no-progress"], 300);
		await runOk(bindings, ["bun", "run", "check:ts"], 180);
		await runOk(bindings, ["cargo", "check", "--workspace"], 600);
		await runPrePublishBunCheck(bindings, {}, { toolName: "gh_push_branch", stage: "push" });

		const bunCache = repoCommandEnv(bindings).BUN_INSTALL_CACHE_DIR!;
		expect(fs.statSync(bunCache).isDirectory()).toBe(true);
		expect(fs.statSync(bunCache).uid).toBe(SLOT_ONE);
		expect(fs.statSync(staleMarker).uid).toBe(SLOT_ONE);
		expect(fs.statSync(path.join(cargoTarget, "debug")).isDirectory()).toBe(true);
		expect(fs.statSync(path.join(cargoTarget, "debug")).gid).toBe(SHARED_OMP_GID);

		await writeAsSlot(bindings, "src/slot-generated.ts", "export const generatedBySlot = true;\n");
		await runOk(bindings, ["git", "add", "src/slot-generated.ts", "Cargo.lock", "bun.lock"]);
		await runOk(bindings, ["git", "commit", "-m", "slot generated file"]);
		const status = await runOk(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"]);
		expect(status.stdout.trim()).toBe("");
	}, 1_200_000);

	test("git pool metadata survives root push and retry slot", async () => {
		const skip = toolchainSkipReason();
		if (skip) return void console.warn(skip);
		const tmp = slotTmpPath();
		const upstream = upstreamRepo(tmp);
		const db = makeDb();
		const workspaces = path.join(tmp, "workspaces");

		const first = await ensureWorkspace(workspaces, upstream, { number: 102, slotUid: SLOT_ONE });
		const firstBindings = bindingsFor(db, first, upstream, SLOT_ONE);
		await writeAsSlot(firstBindings, "src/first-slot.ts", "export const firstSlot = 1;\n");
		await runOk(firstBindings, ["git", "add", "src/first-slot.ts"]);
		await runOk(firstBindings, ["git", "commit", "-m", "first slot commit"]);

		const firstHead = await guardedPushBranch(firstBindings, {}, "gh_push_branch", first.branch);
		expect(git(["--git-dir", upstream, "rev-parse", first.branch], tmp).trim()).toBe(firstHead);

		const retry = await ensureWorkspace(workspaces, upstream, {
			number: 102,
			slotUid: SLOT_TWO,
			existingBranch: first.branch,
		});
		const retryBindings = bindingsFor(db, retry, upstream, SLOT_TWO);
		await runOk(retryBindings, ["git", "fsck", "--no-progress"], 180);
		await writeAsSlot(retryBindings, "src/retry-slot.ts", "export const retrySlot = 2;\n");
		await runOk(retryBindings, ["git", "add", "src/retry-slot.ts"]);
		await runOk(retryBindings, ["git", "commit", "-m", "retry slot commit"]);

		const retryHead = await guardedPushBranch(retryBindings, {}, "gh_push_branch", retry.branch);
		expect(git(["--git-dir", upstream, "rev-parse", retry.branch], tmp).trim()).toBe(retryHead);
		expect(retryHead).not.toBe(firstHead);
	}, 600_000);

	test("natives cache shares artifacts across slot workspaces", async () => {
		// Capture under slot 1, populate under slot 2: setgid `omp` inheritance,
		// hardlinked `.node`, copied companions, and rebuild/rewrite isolation.
		const skip = toolchainSkipReason();
		if (skip) return void console.warn(skip);
		const tmp = slotTmpPath();
		const upstream = upstreamRepo(tmp);
		const db = makeDb();
		const workspaces = path.join(tmp, "workspaces");
		const cacheRoot = path.join(tmp, "cache", "pi-natives");
		fs.mkdirSync(cacheRoot, { recursive: true });
		fs.chownSync(cacheRoot, 0, SHARED_OMP_GID);
		chmodFull(cacheRoot, 0o2770);
		const nativesCache = new NativesCache(cacheRoot);
		const manager = new SandboxManager(workspaces, { transport: new LocalGitTransport(null), nativesCache });

		// --- Workspace 1: stage built artifacts and capture them. ---
		const ws1 = await manager.ensureWorkspace({
			repo: REPO,
			number: 301,
			title: "natives cache producer",
			cloneUrl: upstream,
			defaultBranch: "main",
			authorName: AUTHOR_NAME,
			authorEmail: AUTHOR_EMAIL,
			slotUid: SLOT_ONE,
		});
		const bindings1 = bindingsFor(db, ws1, upstream, SLOT_ONE);
		await writeAsSlot(bindings1, "packages/natives/native/pi_natives.linux-arm64.node", "ELFx-original");
		await writeAsSlot(bindings1, "packages/natives/native/index.d.ts", "export const X: number;\n");
		await writeAsSlot(bindings1, "packages/natives/native/index.js", "export const X = 1;\n");
		await writeAsSlot(bindings1, "packages/natives/native/embedded-addon.js", "export const embeddedAddon = null;\n");

		const key = await nativesComputeKey(ws1.repo_dir, "linux-arm64");
		const nativeDir1 = path.join(ws1.repo_dir, "packages", "natives", "native");
		const stored = await nativesCache.capture(REPO, key, nativeDir1, { sourceWorkspace: ws1.workspace_key });
		expect(stored).not.toBeNull();
		const cachedNode = path.join(stored!, "pi_natives.linux-arm64.node");
		const cachedCompanion = path.join(stored!, "index.d.ts");
		expect(fs.statSync(cachedNode).gid).toBe(SHARED_OMP_GID);
		expect(fs.statSync(cachedCompanion).gid).toBe(SHARED_OMP_GID);

		// --- Workspace 2: a different slot UID gets auto-populated on ensure. ---
		const ws2 = await manager.ensureWorkspace({
			repo: REPO,
			number: 302,
			title: "natives cache consumer",
			cloneUrl: upstream,
			defaultBranch: "main",
			authorName: AUTHOR_NAME,
			authorEmail: AUTHOR_EMAIL,
			slotUid: SLOT_TWO,
		});
		const bindings2 = bindingsFor(db, ws2, upstream, SLOT_TWO);
		const nativeDir2 = path.join(ws2.repo_dir, "packages", "natives", "native");
		const ws2Node = path.join(nativeDir2, "pi_natives.linux-arm64.node");
		const ws2Companion = path.join(nativeDir2, "index.d.ts");
		expect(fs.existsSync(ws2Node)).toBe(true);
		expect(fs.existsSync(ws2Companion)).toBe(true);
		// The .node is hardlinked (same inode); the companion is copied.
		expect(fs.statSync(ws2Node).ino).toBe(fs.statSync(cachedNode).ino);
		expect(fs.statSync(cachedNode).nlink).toBeGreaterThanOrEqual(2);
		expect(fs.statSync(ws2Companion).ino).not.toBe(fs.statSync(cachedCompanion).ino);

		// Slot 2 can read the populated artifacts.
		await runOk(bindings2, ["test", "-r", "packages/natives/native/pi_natives.linux-arm64.node"]);
		await runOk(bindings2, ["test", "-r", "packages/natives/native/index.d.ts"]);

		// Rebuild simulation: napi's installBinary does temp + rename.
		await runOk(bindings2, [
			"python3",
			"-c",
			"import os, sys; dest = sys.argv[1]; tmp = dest + '.tmp.rebuild'; " +
				"open(tmp, 'wb').write(b'REBUILT'); os.rename(tmp, dest)",
			"packages/natives/native/pi_natives.linux-arm64.node",
		]);
		expect(fs.readFileSync(ws2Node, "utf-8")).toBe("REBUILT");
		expect(fs.readFileSync(cachedNode, "utf-8")).toBe("ELFx-original");
		expect(fs.statSync(ws2Node).ino).not.toBe(fs.statSync(cachedNode).ino);

		// Companion rewrite (open-truncate-write) must not touch the cache copy.
		await writeAsSlot(bindings2, "packages/natives/native/index.d.ts", "// regenerated by gen-enums\n");
		expect(fs.readFileSync(ws2Companion, "utf-8")).toBe("// regenerated by gen-enums\n");
		expect(fs.readFileSync(cachedCompanion, "utf-8")).toBe("export const X: number;\n");

		// Recapture is idempotent under the flock.
		const again = await nativesCache.capture(REPO, key, nativeDir2, { sourceWorkspace: ws2.workspace_key });
		expect(again).toBe(stored);
	}, 600_000);
});
