import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AUTH_ENV_VAR,
	deleteBadRefs,
	fetchPrHead as gitFetchPrHead,
	fetchPrune as gitFetchPrune,
	fetchRef as gitFetchRef,
	GitCommandError,
	push as gitPush,
	redactCredentials as sandboxRedact,
	runGit,
} from "../src/git-ops";
import { computeKey, NativesCache, targetTriple } from "../src/natives-cache";
import {
	chownWorkspace,
	DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT,
	type GitTransport,
	makeBranch,
	prepareSlotRuntimeEnv,
	prepareSlotTmpdir,
	provisionRuntimeDirs,
	reapSlot,
	renameWorkspaceBranch,
	run,
	SandboxManager,
	safeDirectoryEnv,
	safeRun,
	sandboxDeps,
	shareGitMetadataWithSlots,
	slotPids,
	Workspace,
	workspaceKey,
	worktreeAdd,
} from "../src/sandbox";
import * as subprocess from "../src/subprocess";
import { type CompletedProcess, type RunOptions, platformInfo, processRunner, slotIdentity } from "../src/subprocess";
import { gitSync, tmpPath } from "./helpers";

afterEach(() => {
	for (const obj of [sandboxDeps, platformInfo, processRunner] as Record<string, unknown>[]) {
		for (const fn of Object.values(obj)) (fn as { mockRestore?: () => void }).mockRestore?.();
	}
});

const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args: string[], cwd: string) => gitSync(cwd, args, { env: gitEnv });
const done = (cmd: readonly string[], returncode = 0, stdout = "", stderr = ""): CompletedProcess => ({
	args: [...cmd],
	returncode,
	stdout,
	stderr,
	timedOut: false,
});
const AUTHOR = { authorName: "robomp-bot", authorEmail: "robomp-bot@example.invalid" };

/** Fake Linux + root for slot-permission code paths. */
function fakeLinuxRoot(euid = 0, system: NodeJS.Platform = "linux"): void {
	spyOn(platformInfo, "system").mockReturnValue(system);
	spyOn(platformInfo, "geteuid").mockReturnValue(euid);
}

function makeWorkspace(root: string, branch = "farm/test/topic"): Workspace {
	return new Workspace(
		root,
		path.join(root, "repo"),
		path.join(root, ".omp-session"),
		path.join(root, "context"),
		path.join(root, "artifacts"),
		branch,
		"octo/widget",
		1,
	);
}

function upstreamRepo(tmp: string): string {
	const repo = path.join(tmp, "upstream.git");
	fs.mkdirSync(repo);
	git(["init", "--initial-branch=main", "--bare", repo], tmp);
	const seed = path.join(tmp, "seed");
	fs.mkdirSync(seed);
	git(["init", "--initial-branch=main", seed], tmp);
	fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
	git(["-C", seed, "add", "."], tmp);
	git(["-C", seed, "commit", "-m", "init"], tmp);
	git(["-C", seed, "remote", "add", "origin", repo], tmp);
	git(["-C", seed, "push", "origin", "main"], tmp);
	return repo;
}

function initWorktreeRepo(repoDir: string, branch: string): void {
	fs.mkdirSync(repoDir, { recursive: true });
	git(["init", `--initial-branch=${branch}`, repoDir], path.dirname(repoDir));
	fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
	git(["-C", repoDir, "add", "."], path.dirname(repoDir));
	git(["-C", repoDir, "commit", "-m", "init"], path.dirname(repoDir));
}

function chownTree(root: string, uid: number): void {
	Bun.spawnSync(["chown", "-R", `${uid}:${uid}`, root]);
}

const isLinuxRoot = () => process.platform === "linux" && process.geteuid?.() === 0;

test("workspace key and branch shape", () => {
	expect(workspaceKey("oven-sh/bun", 30654)).toBe("oven-sh__bun__30654");
	expect(workspaceKey("oven-sh/bun", "release")).toBe("oven-sh__bun__release");
	const branch = makeBranch({ issueNumber: 30654, title: "JSON.parse crashes on BOM", seed: "oven-sh/bun#30654" });
	expect(branch.startsWith("farm/")).toBe(true);
	const parts = branch.split("/");
	expect(parts).toHaveLength(3);
	expect(parts[1]).toHaveLength(8);
	expect(parts[2]).toContain("json-parse-crashes");
});

describe("renameWorkspaceBranch", () => {
	test("renames the local branch", async () => {
		const root = path.join(tmpPath(), "ws");
		const initial = "farm/abc12345/some-issue";
		initWorktreeRepo(path.join(root, "repo"), initial);
		const ws = makeWorkspace(root, initial);
		expect(await renameWorkspaceBranch(ws, "fix-json-bom")).toBe("farm/abc12345/fix-json-bom");
		expect(ws.branch).toBe("farm/abc12345/fix-json-bom");
		expect(gitSync(ws.repo_dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/farm/abc12345/fix-json-bom");
	});

	test("refreshes shared metadata for the slot", async () => {
		const root = path.join(tmpPath(), "ws");
		const initial = "farm/abc12345/some-issue";
		initWorktreeRepo(path.join(root, "repo"), initial);
		const ws = makeWorkspace(root, initial);
		if (isLinuxRoot()) chownTree(root, 2004);
		const calls: [string, number | null][] = [];
		spyOn(sandboxDeps, "shareGitMetadataWithSlots").mockImplementation((repoDir, slotUid) => {
			calls.push([repoDir, slotUid]);
		});
		await renameWorkspaceBranch(ws, "fix-json-bom", { slotUid: 2004 });
		expect(calls).toEqual([[ws.repo_dir, 2004]]);
	});

	test("runs git as the slot when permissions are active", async () => {
		const root = path.join(tmpPath(), "ws");
		fs.mkdirSync(path.join(root, "repo"), { recursive: true });
		const initial = "farm/abc12345/some-issue";
		const ws = makeWorkspace(root, initial);
		const captured: { cmd?: readonly string[]; options?: RunOptions } = {};
		fakeLinuxRoot();
		spyOn(processRunner, "run").mockImplementation(async (cmd, options) => {
			captured.cmd = cmd;
			captured.options = options;
			return done(cmd);
		});
		spyOn(sandboxDeps, "shareGitMetadataWithSlots").mockImplementation(() => {});
		expect(await renameWorkspaceBranch(ws, "fix-json-bom", { slotUid: 2004 })).toBe("farm/abc12345/fix-json-bom");
		expect(captured.cmd).toEqual(["git", "branch", "-m", initial, "farm/abc12345/fix-json-bom"]);
		expect(captured.options?.cwd).toBe(ws.repo_dir);
		expect(captured.options?.identity).toEqual({ uid: 2004, gid: 2004, groups: [2000], umask: 0o002 });
	});

	test("is idempotent when the slug is unchanged", async () => {
		const tmp = tmpPath();
		const initial = "farm/abc12345/keep-me";
		const ws = makeWorkspace(path.join(tmp, "ws"), initial);
		ws.repo_dir = path.join(tmp, "does-not-exist");
		expect(await renameWorkspaceBranch(ws, "keep-me")).toBe(initial);
		expect(ws.branch).toBe(initial);
	});

	test.each([
		"",
		"Has-Caps",
		"-leading",
		"trailing-",
		"double--hyphen",
		"has/slash",
		"has_underscore",
		"a".repeat(51),
		null,
		123,
	])("rejects bad slug %p", async bad => {
		await expect(
			renameWorkspaceBranch(makeWorkspace(path.join(tmpPath(), "ws")), bad as string),
		).rejects.toBeInstanceOf(RangeError);
	});

	test("is a noop when a PR is open", async () => {
		const root = path.join(tmpPath(), "ws");
		const initial = "farm/abc12345/old-slug";
		initWorktreeRepo(path.join(root, "repo"), initial);
		const ws = makeWorkspace(root, initial);
		expect(await renameWorkspaceBranch(ws, "new-slug", { prNumber: 42 })).toBe(initial);
		expect(ws.branch).toBe(initial);
		expect(gitSync(ws.repo_dir, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${initial}`);
		await expect(renameWorkspaceBranch(ws, "Bad Slug", { prNumber: 42 })).rejects.toBeInstanceOf(RangeError);
	});

	test("rejects a non-farm branch", async () => {
		const ws = makeWorkspace(path.join(tmpPath(), "ws"), "main");
		await expect(renameWorkspaceBranch(ws, "ok-slug")).rejects.toBeInstanceOf(RangeError);
	});

	test("surfaces git failure", async () => {
		const root = path.join(tmpPath(), "ws");
		const initial = "farm/abc12345/old";
		initWorktreeRepo(path.join(root, "repo"), initial);
		git(["-C", path.join(root, "repo"), "branch", "farm/abc12345/new"], root);
		const ws = makeWorkspace(root, initial);
		await expect(renameWorkspaceBranch(ws, "new")).rejects.toBeInstanceOf(GitCommandError);
		expect(ws.branch).toBe(initial);
	});
});

describe("deleteBadRefs", () => {
	test("removes the worktree holding the ref", async () => {
		const tmp = tmpPath();
		const pool = path.join(tmp, "pool");
		initWorktreeRepo(pool, "main");
		const workDir = path.join(tmp, "worktree");
		git(["worktree", "add", "-b", "farm/badhex/bad-branch", workDir, "main"], pool);
		expect(fs.existsSync(path.join(workDir, ".git"))).toBe(true);
		const fetchOutput =
			"error: object directory /tmp/git-objects-aux does not exist; check .git/objects/info/alternates\n" +
			"fatal: bad object refs/heads/farm/badhex/bad-branch\n" +
			"error: did not send all necessary objects\n";
		expect(await deleteBadRefs(pool, fetchOutput)).toBe(true);
		expect(
			Bun.spawnSync(["git", "rev-parse", "--verify", "refs/heads/farm/badhex/bad-branch"], { cwd: pool }).exitCode,
		).not.toBe(0);
		expect(fs.existsSync(path.join(workDir, ".git"))).toBe(false);
	});

	test("noop when no bad ref is in the output", async () => {
		const pool = path.join(tmpPath(), "pool");
		initWorktreeRepo(pool, "main");
		expect(await deleteBadRefs(pool, "fatal: unrelated failure\n")).toBe(false);
	});
});

describe("ensureWorkspace", () => {
	test("creates a worktree", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 42,
			title: "something is wrong",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		});
		expect(fs.readFileSync(path.join(ws.repo_dir, "README.md"), "utf-8")).toBe("hello\n");
		expect(gitSync(ws.repo_dir, ["-C", ws.repo_dir, "rev-parse", "--abbrev-ref", "HEAD"])).toBe(ws.branch);
		expect(ws.branch.startsWith("farm/")).toBe(true);
		for (const dir of [ws.session_dir, ws.context_dir, ws.repro_dir, ws.artifacts_dir])
			expect(fs.statSync(dir).isDirectory()).toBe(true);
	});

	test("release workspace resets to remote main and uses the tag session", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const args = { repo: "octo/widget", cloneUrl: upstream, defaultBranch: "main", ...AUTHOR };
		const workspace = await mgr.ensureReleaseWorkspace({ ...args, tag: "v1.2.3" });
		expect(workspace.branch).toBe("main");
		expect(workspace.issue_number).toBe("release");
		expect(workspace.workspace_key).toBe("octo__widget__release");
		expect(path.basename(workspace.session_dir)).toBe(".omp-session-v1.2.3");

		fs.writeFileSync(path.join(workspace.repo_dir, "local.txt"), "discard me\n");
		git(["-C", workspace.repo_dir, "add", "local.txt"], tmp);
		git(["-C", workspace.repo_dir, "commit", "-m", "local crash residue"], tmp);
		fs.writeFileSync(path.join(workspace.repo_dir, "untracked.txt"), "discard me too\n");

		const seed = path.join(tmp, "seed");
		fs.writeFileSync(path.join(seed, "remote.txt"), "new remote state\n");
		git(["-C", seed, "add", "remote.txt"], tmp);
		git(["commit", "-m", "advance remote"], seed);
		git(["-C", seed, "push", "origin", "main"], tmp);
		const remoteHead = git(["rev-parse", "HEAD"], seed);

		const resumed = await mgr.ensureReleaseWorkspace({ ...args, tag: "v1.2.3" });
		expect(git(["rev-parse", "HEAD"], resumed.repo_dir)).toBe(remoteHead);
		expect(fs.existsSync(path.join(resumed.repo_dir, "local.txt"))).toBe(false);
		expect(fs.existsSync(path.join(resumed.repo_dir, "untracked.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(resumed.repo_dir, "remote.txt"), "utf-8")).toBe("new remote state\n");

		const next = await mgr.ensureReleaseWorkspace({ ...args, tag: "v1.2.4" });
		expect(next.repo_dir).toBe(resumed.repo_dir);
		expect(path.basename(next.session_dir)).toBe(".omp-session-v1.2.4");
	});

	test("pr_head uses the detached PR ref", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const contributor = path.join(tmp, "contributor");
		git(["clone", upstream, contributor], tmp);
		fs.writeFileSync(path.join(contributor, "README.md"), "hello from pr\n");
		git(["-C", contributor, "add", "README.md"], tmp);
		gitSync(contributor, ["commit", "-m", "pr change"], {
			env: { GIT_AUTHOR_NAME: "c", GIT_AUTHOR_EMAIL: "c@t", GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@t" },
		});
		const prHead = git(["rev-parse", "HEAD"], contributor);
		git(["-C", contributor, "push", "origin", "HEAD:refs/pull/9/head"], tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 9,
			title: "incoming PR",
			cloneUrl: upstream,
			defaultBranch: "main",
			prHead: 9,
			...AUTHOR,
		});
		expect(git(["rev-parse", "HEAD"], ws.repo_dir)).toBe(prHead);
		expect(
			Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ws.repo_dir }).exitCode,
		).not.toBe(0);
		expect(ws.branch).toBe("review/pr-9");
		expect(
			Bun.spawnSync(["git", "config", "--get", "remote.origin.pushurl"], { cwd: ws.repo_dir }).exitCode,
		).not.toBe(0);
	});
});

describe("chownWorkspace", () => {
	const recordRun = () => {
		const calls: { cmd: readonly string[]; timeout: number | null | undefined }[] = [];
		spyOn(processRunner, "run").mockImplementation(async (cmd, options) => {
			calls.push({ cmd, timeout: options?.timeout });
			return done(cmd);
		});
		return calls;
	};

	test("noops when not root", async () => {
		fakeLinuxRoot(1000);
		const calls = recordRun();
		await chownWorkspace(tmpPath(), 2001);
		expect(calls).toEqual([]);
	});

	test("noops off linux", async () => {
		fakeLinuxRoot(0, "darwin");
		const calls = recordRun();
		await chownWorkspace(tmpPath(), 2001);
		expect(calls).toEqual([]);
	});

	test("runs chown and chmod as root on linux", async () => {
		fakeLinuxRoot();
		const calls = recordRun();
		const tmp = tmpPath();
		await chownWorkspace(tmp, 2001);
		expect(calls).toEqual([
			{ cmd: ["chown", "-R", "2001:2001", tmp], timeout: DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT },
			{ cmd: ["chmod", "-R", "u=rwX,g=rwX,o=", tmp], timeout: DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT },
		]);
	});

	test("makes the workspace slot-owned", async () => {
		const tmp = tmpPath();
		const subdir = path.join(tmp, "subdir");
		fs.mkdirSync(subdir);
		const file = path.join(subdir, "file.txt");
		fs.writeFileSync(file, "data\n");
		for (const p of [tmp, subdir, file]) fs.chmodSync(p, 0o777);
		const owned = new Map<string, [number, number]>();
		const walk = (root: string, visit: (p: string, isDir: boolean) => void) => {
			visit(root, true);
			for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
				const full = path.join(root, entry.name);
				if (entry.isDirectory()) walk(full, visit);
				else visit(full, false);
			}
		};
		fakeLinuxRoot();
		spyOn(processRunner, "run").mockImplementation(async (cmd, options) => {
			expect(options?.timeout).toBe(DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT);
			if (cmd[0] === "chown" && cmd[1] === "-R") {
				const [uid, gid] = cmd[2]!.split(":").map(Number) as [number, number];
				walk(cmd[3]!, p => owned.set(p, [uid, gid]));
			} else if (cmd[0] === "chmod" && cmd[1] === "-R" && cmd[2] === "u=rwX,g=rwX,o=") {
				walk(cmd[3]!, (p, isDir) => fs.chmodSync(p, isDir ? 0o770 : 0o660));
			} else {
				throw new Error(`unexpected command: ${cmd.join(" ")}`);
			}
			return done(cmd);
		});
		await chownWorkspace(tmp, 2001);
		expect(owned.get(tmp)).toEqual([2001, 2001]);
		expect(owned.get(subdir)).toEqual([2001, 2001]);
		expect(owned.get(file)).toEqual([2001, 2001]);
		expect(fs.statSync(tmp).mode & 0o7777).toBe(0o770);
		expect(fs.statSync(subdir).mode & 0o7777).toBe(0o770);
		expect(fs.statSync(file).mode & 0o7777).toBe(0o660);
	});

	test("normalizes to root when slots are disabled", async () => {
		fakeLinuxRoot();
		spyOn(platformInfo, "getegid").mockReturnValue(0);
		const calls = recordRun();
		const tmp = tmpPath();
		await chownWorkspace(tmp, null);
		expect(calls.map(c => c.cmd)).toEqual([
			["chown", "-R", "0:0", tmp],
			["chmod", "-R", "u=rwX,g=rwX,o=", tmp],
		]);
	});
});

describe("slot processes", () => {
	test("slotPids reads /proc status and skips zombies", () => {
		const tmp = tmpPath();
		fs.mkdirSync(path.join(tmp, "self"));
		const status = (pid: string, body: string) => {
			fs.mkdirSync(path.join(tmp, pid));
			fs.writeFileSync(path.join(tmp, pid, "status"), body);
		};
		status("123", "Name:\tomp\nState:\tS (sleeping)\nUid:\t0\t2001\t2001\t2001\n");
		status("124", "Name:\tomp\nState:\tZ (zombie)\nUid:\t2001\t2001\t2001\t2001\n");
		status("125", "Name:\troot\nState:\tS (sleeping)\nUid:\t0\t0\t0\t0\n");
		expect(slotPids(2001, tmp)).toEqual([123]);
	});

	test("reapSlot noops when permissions are inactive", () => {
		fakeLinuxRoot(0, "darwin");
		const calls: [number, string][] = [];
		spyOn(sandboxDeps, "kill").mockImplementation((pid, sig) => void calls.push([pid, sig]));
		reapSlot(2001);
		expect(calls).toEqual([]);
	});

	test("reapSlot kills slot uid processes on linux root", () => {
		fakeLinuxRoot();
		spyOn(sandboxDeps, "slotPids").mockReturnValue([111, 222]);
		const calls: [number, string][] = [];
		spyOn(sandboxDeps, "kill").mockImplementation((pid, sig) => void calls.push([pid, sig]));
		reapSlot(2001);
		expect(calls).toEqual([
			[111, "SIGKILL"],
			[222, "SIGKILL"],
		]);
	});

	test("slot identity runs as slot on linux root", () => {
		fakeLinuxRoot();
		expect(slotIdentity(2001)).toEqual({ uid: 2001, gid: 2001, groups: [2000], umask: 0o002 });
	});

	test.if(isLinuxRoot())("setpriv identity really drops to the slot uid", async () => {
		const proc = await subprocess.runProcess(["sh", "-c", "id -u; id -g; id -G; umask"], {
			identity: slotIdentity(2001),
		});
		expect(proc.stdout.split("\n").slice(0, 4)).toEqual(["2001", "2001", "2001 2000", "0002"]);
	});
});

describe("runtime dirs", () => {
	test("prepareSlotTmpdir mkdirs without chown", () => {
		fakeLinuxRoot();
		const chown = spyOn(fs, "chownSync");
		const tmp = tmpPath();
		const tmpdir = prepareSlotTmpdir(makeWorkspace(tmp));
		expect(tmpdir).toBe(path.join(tmp, ".omp-tmp"));
		expect(fs.statSync(tmpdir).mode & 0o7777).toBe(0o700);
		expect(chown).not.toHaveBeenCalled();
		chown.mockRestore();
	});

	test("prepareSlotTmpdir replaces a symlink without touching the target", () => {
		const tmp = tmpPath();
		const target = path.join(tmp, "target");
		fs.mkdirSync(target);
		fs.symlinkSync(target, path.join(tmp, ".omp-tmp"));
		const prepared = prepareSlotTmpdir(makeWorkspace(tmp));
		expect(fs.lstatSync(prepared).isDirectory()).toBe(true);
		expect(fs.lstatSync(prepared).isSymbolicLink()).toBe(false);
		expect(fs.statSync(target).isDirectory()).toBe(true);
	});

	test("provisionRuntimeDirs replaces a tmpdir symlink and creates the XDG tree", () => {
		const tmp = tmpPath();
		const target = path.join(tmp, "target");
		fs.mkdirSync(target);
		const tmpdir = path.join(tmp, ".omp-tmp");
		fs.symlinkSync(target, tmpdir);
		provisionRuntimeDirs(tmp);
		expect(fs.lstatSync(tmpdir).isDirectory()).toBe(true);
		expect(fs.statSync(target).isDirectory()).toBe(true);
		expect(fs.statSync(tmpdir).mode & 0o7777).toBe(0o700);
		for (const sub of ["data", "state", "cache"])
			expect(fs.statSync(path.join(tmp, ".omp-xdg", sub, "omp")).isDirectory()).toBe(true);
		expect(fs.statSync(path.join(tmp, ".omp-xdg", "cache", "bun-install")).isDirectory()).toBe(true);
	});

	test("safeDirectoryEnv scopes a single repo path", () => {
		const repoDir = path.join(tmpPath(), "repo");
		expect(safeDirectoryEnv(repoDir)).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "safe.directory",
			GIT_CONFIG_VALUE_0: repoDir,
		});
	});

	test("prepareSlotRuntimeEnv returns workspace-private paths without chown", () => {
		fakeLinuxRoot();
		const chown = spyOn(fs, "chownSync");
		const run = spyOn(processRunner, "run");
		const ws = makeWorkspace(tmpPath());
		const bunCache = path.join(ws.root, ".omp-xdg", "cache", "bun-install");
		const env = prepareSlotRuntimeEnv(ws);
		expect(env.TMPDIR).toBe(path.join(ws.root, ".omp-tmp"));
		expect(env.XDG_CACHE_HOME).toBe(path.join(ws.root, ".omp-xdg", "cache"));
		expect(env.BUN_INSTALL_CACHE_DIR).toBe(bunCache);
		for (const sub of ["data", "state", "cache"])
			expect(fs.statSync(path.join(ws.root, ".omp-xdg", sub, "omp")).isDirectory()).toBe(true);
		expect(fs.statSync(bunCache).isDirectory()).toBe(true);
		expect(chown).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		chown.mockRestore();
	});

	test("shareGitMetadataWithSlots keeps the pool writable for the retry slot", () => {
		const tmp = tmpPath();
		const repoDir = path.join(tmp, "workspaces", "octo__widget__43", "repo");
		fs.mkdirSync(repoDir, { recursive: true });
		const commonDir = path.join(tmp, "workspaces", "_pool", "octo__widget", ".git");
		const gitDir = path.join(commonDir, "worktrees", "repo");
		fs.mkdirSync(gitDir, { recursive: true });
		fs.writeFileSync(path.join(repoDir, ".git"), `gitdir: ${gitDir}\n`);
		fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
		const mk = (p: string, content: string) => {
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, content);
			fs.chmodSync(p, 0o600);
			return p;
		};
		const objectFile = mk(path.join(commonDir, "objects", "ab", "object"), "object\n");
		const refFile = mk(path.join(commonDir, "refs", "heads", "farm"), "sha\n");
		const logFile = mk(
			path.join(commonDir, "logs", "refs", "heads", "farm"),
			"sha sha bot <bot@example.invalid> commit\n",
		);
		const indexFile = mk(path.join(gitDir, "index"), "index\n");
		const chowns: [string, number, number][] = [];
		fakeLinuxRoot();
		const chown = spyOn(fs, "chownSync").mockImplementation((p, uid, gid) => void chowns.push([String(p), uid, gid]));
		try {
			shareGitMetadataWithSlots(repoDir, 2002);
		} finally {
			chown.mockRestore();
		}
		const mode = (p: string) => fs.statSync(p).mode;
		expect(mode(path.dirname(objectFile)) & 0o020).toBeTruthy();
		expect(mode(path.dirname(objectFile)) & 0o2000).toBeTruthy();
		expect(mode(objectFile) & 0o040).toBeTruthy();
		expect(mode(objectFile) & 0o020).toBeFalsy();
		expect(mode(refFile) & 0o020).toBeTruthy();
		expect(mode(logFile) & 0o020).toBeTruthy();
		expect(mode(indexFile) & 0o020).toBeTruthy();
		expect(chowns).toContainEqual([gitDir, fs.statSync(gitDir).uid, 2000]);
	});
});

describe("ensureWorkspace permissions", () => {
	test("refreshes permissions for the retry slot and keeps the session", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const chowns: [string, number | null][] = [];
		const shared: [string, number | null][] = [];
		const realChown = sandboxDeps.chownWorkspace;
		const realShare = sandboxDeps.shareGitMetadataWithSlots;
		spyOn(sandboxDeps, "chownWorkspace").mockImplementation(async (root, slotUid) => {
			chowns.push([root, slotUid]);
			await realChown(root, slotUid);
		});
		spyOn(sandboxDeps, "shareGitMetadataWithSlots").mockImplementation((repoDir, slotUid) => {
			shared.push([repoDir, slotUid]);
			realShare(repoDir, slotUid);
		});
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const base = {
			repo: "octo/widget",
			number: 44,
			title: "retry me",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		};
		const ws1 = await mgr.ensureWorkspace({ ...base, slotUid: 2001 });
		const transcript = path.join(ws1.session_dir, "turn.jsonl");
		fs.writeFileSync(transcript, "{}\n");
		const ws2 = await mgr.ensureWorkspace({ ...base, existingBranch: ws1.branch, slotUid: 2002 });
		expect(ws2.repo_dir).toBe(ws1.repo_dir);
		expect(ws2.session_dir).toBe(ws1.session_dir);
		expect(fs.statSync(transcript).isFile()).toBe(true);
		expect(ws2.branch).toBe(ws1.branch);
		expect(shared).toEqual([
			[ws1.repo_dir, 2001],
			[ws1.repo_dir, 2001],
			[ws1.repo_dir, 2002],
			[ws1.repo_dir, 2002],
		]);
		expect(chowns).toEqual([
			[ws1.root, 2001],
			[ws1.root, 2002],
		]);
	});

	test("preserves the checked-out branch on replay", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const base = {
			repo: "octo/widget",
			number: 45,
			title: "retry me",
			cloneUrl: upstream,
			defaultBranch: "main",
			slotUid: null,
			...AUTHOR,
		};
		const ws1 = await mgr.ensureWorkspace(base);
		const renamed = "farm/abc12345/renamed";
		git(["-C", ws1.repo_dir, "branch", "-m", ws1.branch, renamed], ws1.repo_dir);
		expect((await mgr.ensureWorkspace(base)).branch).toBe(renamed);
	});

	test("runs existing-worktree git as the slot after chown", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const base = {
			repo: "octo/widget",
			number: 47,
			title: "retry me",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		};
		const ws1 = await mgr.ensureWorkspace({ ...base, slotUid: null });
		const events: [string, number | null][] = [];
		const gitCalls: { cmd: readonly string[]; options?: RunOptions }[] = [];
		fakeLinuxRoot();
		spyOn(processRunner, "run").mockImplementation(async (cmd, options) => {
			gitCalls.push({ cmd, options });
			const uid = options?.identity?.uid ?? null;
			if (cmd[0] === "git" && cmd[1] === "remote" && cmd[2] === "get-url") return done(cmd, 0, `${upstream}\n`);
			if (cmd[0] === "git" && cmd[1] === "symbolic-ref") {
				events.push(["symbolic-ref", uid]);
				return done(cmd, 0, `${ws1.branch}\n`);
			}
			if (cmd[0] === "git" && cmd[1] === "config") events.push(["config", uid]);
			return done(cmd);
		});
		spyOn(sandboxDeps, "chownWorkspace").mockImplementation(
			async (_root, slotUid) => void events.push(["chown", slotUid]),
		);
		spyOn(sandboxDeps, "shareGitMetadataWithSlots").mockImplementation(() => {});
		const ws2 = await mgr.ensureWorkspace({ ...base, slotUid: 2002 });
		expect(ws2.branch).toBe(ws1.branch);
		expect(events[0]).toEqual(["chown", 2002]);
		const idx = (e: [string, number]) => events.findIndex(x => x[0] === e[0] && x[1] === e[1]);
		expect(idx(["symbolic-ref", 2002])).toBeGreaterThan(idx(["chown", 2002]));
		expect(events.filter(e => e[0] === "config" && e[1] === 2002)).toHaveLength(2);
		const worktreeGit = gitCalls.filter(
			c => c.cmd[0] === "git" && (c.cmd[1] === "symbolic-ref" || c.cmd[1] === "config"),
		);
		expect(worktreeGit.length).toBeGreaterThan(0);
		for (const c of worktreeGit) expect(c.options?.identity).toMatchObject({ uid: 2002, gid: 2002 });
	});

	test("invokes the slot chown", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const calls: [string, number | null][] = [];
		const realChown = sandboxDeps.chownWorkspace;
		spyOn(sandboxDeps, "chownWorkspace").mockImplementation(async (root, slotUid) => {
			calls.push([root, slotUid]);
			await realChown(root, slotUid);
		});
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 43,
			title: "t",
			cloneUrl: upstream,
			defaultBranch: "main",
			slotUid: 2001,
			...AUTHOR,
		});
		expect(calls).toEqual([[ws.root, 2001]]);
	});

	test("provisions and slot-owns the runtime dirs", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const runtimePaths: string[] = [];
		const realChown = sandboxDeps.chownWorkspace;
		spyOn(sandboxDeps, "chownWorkspace").mockImplementation(async (root, slotUid) => {
			expect(slotUid).not.toBeNull();
			const paths = [
				".omp-tmp",
				".omp-xdg/data",
				".omp-xdg/data/omp",
				".omp-xdg/state",
				".omp-xdg/state/omp",
				".omp-xdg/cache",
				".omp-xdg/cache/omp",
				".omp-xdg/cache/bun-install",
			].map(rel => path.join(root, rel));
			for (const p of paths) expect(fs.statSync(p).isDirectory()).toBe(true);
			runtimePaths.push(...paths);
			await realChown(root, slotUid);
		});
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 46,
			title: "runtime perms",
			cloneUrl: upstream,
			defaultBranch: "main",
			slotUid: 2001,
			...AUTHOR,
		});
		expect(runtimePaths).toHaveLength(8);
		expect(runtimePaths.every(p => p.startsWith(ws.root))).toBe(true);
	});

	test("is idempotent", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const base = { repo: "octo/widget", number: 5, title: "t", cloneUrl: upstream, defaultBranch: "main", ...AUTHOR };
		const ws1 = await mgr.ensureWorkspace(base);
		const ws2 = await mgr.ensureWorkspace(base);
		expect(ws1.repo_dir).toBe(ws2.repo_dir);
		expect(ws1.branch).toBe(ws2.branch);
	});

	test("existing branch starts from the remote head", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const branch = "farm/abc12345/existing-pr";
		const seed = path.join(tmp, "remote-branch-seed");
		git(["clone", upstream, seed], tmp);
		git(["-C", seed, "checkout", "-b", branch], tmp);
		fs.writeFileSync(path.join(seed, "README.md"), "from pr branch\n");
		git(["-C", seed, "add", "README.md"], tmp);
		git(["commit", "-m", "pr branch"], seed);
		git(["-C", seed, "push", "origin", branch], tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 77,
			title: "follow up",
			cloneUrl: upstream,
			defaultBranch: "main",
			existingBranch: branch,
			...AUTHOR,
		});
		expect(ws.branch).toBe(branch);
		expect(fs.readFileSync(path.join(ws.repo_dir, "README.md"), "utf-8")).toBe("from pr branch\n");
	});

	test("rewrites a credentialed origin before fetch", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const pool = mgr.poolPath("octo/widget");
		fs.mkdirSync(path.dirname(pool), { recursive: true });
		git(["clone", "--filter=blob:none", upstream, pool], tmp);
		git(["-C", pool, "remote", "set-url", "origin", "https://bot:ghp_seekrit@example.invalid/octo/widget.git"], tmp);
		expect(fs.readFileSync(path.join(pool, ".git", "config"), "utf-8")).toContain("ghp_seekrit");
		await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 7,
			title: "t",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		});
		const after = fs.readFileSync(path.join(pool, ".git", "config"), "utf-8");
		expect(after).not.toContain("ghp_seekrit");
		expect(after).not.toContain("bot:");
		expect(git(["-C", pool, "remote", "get-url", "origin"], tmp)).toBe(upstream);
	});
});

describe("removeWorkspace", () => {
	test("removes the worktree and root", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 12,
			title: "t",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		});
		await mgr.removeWorkspace({ repo: "octo/widget", number: 12 });
		expect(fs.existsSync(ws.repo_dir)).toBe(false);
		expect(fs.existsSync(ws.root)).toBe(false);
	});

	const stagePoolAndRepo = (mgr: SandboxManager, number: number, withRepo: boolean) => {
		const wsRoot = mgr.workspaceRoot("o/r", number);
		const repoDir = path.join(wsRoot, "repo");
		fs.mkdirSync(withRepo ? repoDir : wsRoot, { recursive: true });
		const pool = mgr.poolPath("o/r");
		fs.mkdirSync(path.join(pool, ".git"), { recursive: true });
		return { wsRoot, repoDir, pool };
	};

	test("prunes the pool after a failed worktree remove", async () => {
		const mgr = new SandboxManager(tmpPath());
		const { repoDir, pool } = stagePoolAndRepo(mgr, 7, true);
		const calls: [readonly string[], string | null | undefined][] = [];
		spyOn(sandboxDeps, "safeRun").mockImplementation(async (cmd, options) => {
			calls.push([cmd, options?.cwd]);
			return cmd[2] === "remove" ? done(cmd, 124, "", "timed out") : done(cmd);
		});
		await mgr.removeWorkspace({ repo: "o/r", number: 7 });
		const cmds = calls.map(([c]) => c.join(" "));
		const pruneIdx = cmds.indexOf("git worktree prune");
		expect(pruneIdx).toBeGreaterThanOrEqual(0);
		expect(calls[pruneIdx]![1]).toBe(pool);
		expect(cmds.findIndex(c => c.startsWith("git worktree remove"))).toBeLessThan(pruneIdx);
		expect(fs.existsSync(repoDir)).toBe(false);
	});

	test("prunes when a failed remove already deleted the checkout", async () => {
		const mgr = new SandboxManager(tmpPath());
		const { repoDir, pool } = stagePoolAndRepo(mgr, 9, true);
		const calls: [readonly string[], string | null | undefined][] = [];
		spyOn(sandboxDeps, "safeRun").mockImplementation(async (cmd, options) => {
			calls.push([cmd, options?.cwd]);
			if (cmd[2] === "remove") {
				fs.rmdirSync(repoDir);
				return done(cmd, 124, "", "timed out");
			}
			return done(cmd);
		});
		await mgr.removeWorkspace({ repo: "o/r", number: 9 });
		const prune = calls.find(([c]) => c.join(" ") === "git worktree prune");
		expect(prune?.[1]).toBe(pool);
	});

	test("real prune clears a dangling registration", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 21,
			title: "t",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		});
		const pool = mgr.poolPath("octo/widget");
		expect(git(["-C", pool, "worktree", "list", "--porcelain"], tmp)).toContain(ws.repo_dir);
		const realSafeRun = sandboxDeps.safeRun;
		spyOn(sandboxDeps, "safeRun").mockImplementation(async (cmd, options) =>
			cmd[1] === "worktree" && cmd[2] === "remove" ? done(cmd, 124, "", "timed out") : realSafeRun(cmd, options),
		);
		await mgr.removeWorkspace({ repo: "octo/widget", number: 21 });
		expect(git(["-C", pool, "worktree", "list", "--porcelain"], tmp)).not.toContain(ws.repo_dir);
		git(["-C", pool, "worktree", "add", "--detach", ws.repo_dir, "HEAD"], tmp);
		expect(fs.existsSync(ws.repo_dir)).toBe(true);
	});

	test("raises when prune times out", async () => {
		const mgr = new SandboxManager(tmpPath());
		stagePoolAndRepo(mgr, 31, true);
		const calls: string[] = [];
		spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd => {
			calls.push(cmd.join(" "));
			if (cmd[2] === "remove") return done(cmd, 1, "", "remove failed");
			if (cmd[2] === "prune") return done(cmd, 124, "", "prune timed out");
			return done(cmd);
		});
		const err = await mgr.removeWorkspace({ repo: "o/r", number: 31 }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(calls).toContain("git worktree prune");
		expect(err).toBeInstanceOf(GitCommandError);
		expect((err as GitCommandError).returncode).toBe(124);
	});

	test("prunes when the checkout is already gone on entry", async () => {
		const mgr = new SandboxManager(tmpPath());
		const { wsRoot } = stagePoolAndRepo(mgr, 33, false);
		const calls: string[] = [];
		spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd => {
			calls.push(cmd.join(" "));
			return done(cmd);
		});
		await mgr.removeWorkspace({ repo: "o/r", number: 33 });
		expect(calls).toContain("git worktree prune");
		expect(calls.some(c => c.startsWith("git worktree remove"))).toBe(false);
		expect(fs.existsSync(wsRoot)).toBe(false);
	});

	test("runs no git when the pool is not a real clone", async () => {
		const mgr = new SandboxManager(tmpPath());
		const wsRoot = mgr.workspaceRoot("o/r", 41);
		fs.mkdirSync(wsRoot, { recursive: true });
		fs.mkdirSync(mgr.poolPath("o/r"), { recursive: true });
		const safe = spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd =>
			done(cmd, 128, "", "not a git repository"),
		);
		await mgr.removeWorkspace({ repo: "o/r", number: 41 });
		expect(safe).not.toHaveBeenCalled();
		expect(fs.existsSync(wsRoot)).toBe(false);
	});

	test("skips prune on a repeat close after full cleanup", async () => {
		const mgr = new SandboxManager(tmpPath());
		fs.mkdirSync(path.join(mgr.poolPath("o/r"), ".git"), { recursive: true });
		const safe = spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd => done(cmd));
		await mgr.removeWorkspace({ repo: "o/r", number: 43 });
		expect(safe).not.toHaveBeenCalled();
	});
});

describe("credential redaction", () => {
	test("strips userinfo", () => {
		expect(sandboxRedact("Cloning into 'x' from https://bot:ghp_secret@github.com/o/r.git failed")).toBe(
			"Cloning into 'x' from https://***@github.com/o/r.git failed",
		);
		expect(sandboxRedact("a https://x:y@example.com b https://q:z@example.org c")).toBe(
			"a https://***@example.com b https://***@example.org c",
		);
		expect(sandboxRedact("plain message")).toBe("plain message");
		expect(sandboxRedact(null)).toBe("");
	});

	test("GitCommandError redacts url in args and stderr", async () => {
		const tmp = tmpPath();
		const credUrl = "https://bot:ghp_abc123secret@example.invalid/o/r.git";
		const err = await run(["git", "clone", credUrl, path.join(tmp, "out")]).then(
			() => null,
			(e: unknown) => e as Error,
		);
		expect(err).not.toBeNull();
		expect(err!.message).not.toContain("ghp_abc123secret");
		expect(err!.message).not.toContain("https://bot:");
	});
});

describe("push lease", () => {
	const setup = (tmp: string, upstream: string) => {
		const work = path.join(tmp, "work");
		git(["clone", upstream, work], tmp);
		git(["-C", work, "checkout", "-b", "farm/abc/topic"], tmp);
		fs.writeFileSync(path.join(work, "x.txt"), "a\n");
		git(["-C", work, "add", "x.txt"], tmp);
		git(["-C", work, "commit", "-m", "initial"], tmp);
		return work;
	};

	test("succeeds after a local amend", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const work = setup(tmp, upstream);
		await gitPush(work, { branch: "farm/abc/topic", expectedHead: null, token: null });
		fs.writeFileSync(path.join(work, "x.txt"), "a-amended\n");
		git(["-C", work, "add", "x.txt"], tmp);
		git(["-C", work, "commit", "--amend", "--no-edit"], tmp);
		const amended = git(["-C", work, "rev-parse", "HEAD"], tmp);
		expect((await gitPush(work, { branch: "farm/abc/topic", expectedHead: null, token: null })).head).toBe(amended);
		expect(git(["-C", upstream, "rev-parse", "refs/heads/farm/abc/topic"], tmp)).toBe(amended);
	});

	test("refuses when origin moved", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const work = setup(tmp, upstream);
		await gitPush(work, { branch: "farm/abc/topic", expectedHead: null, token: null });
		const intruder = path.join(tmp, "intruder");
		git(["clone", upstream, intruder], tmp);
		git(["-C", intruder, "checkout", "-b", "farm/abc/topic", "origin/farm/abc/topic"], tmp);
		fs.writeFileSync(path.join(intruder, "x.txt"), "from-intruder\n");
		git(["-C", intruder, "add", "x.txt"], tmp);
		git(["-C", intruder, "commit", "--amend", "--no-edit"], tmp);
		git(["-C", intruder, "push", "--force", "origin", "farm/abc/topic"], tmp);
		fs.writeFileSync(path.join(work, "x.txt"), "from-us\n");
		git(["-C", work, "add", "x.txt"], tmp);
		git(["-C", work, "commit", "--amend", "--no-edit"], tmp);
		const err = await gitPush(work, { branch: "farm/abc/topic", expectedHead: null, token: null }).then(
			() => null,
			(e: unknown) => e as GitCommandError,
		);
		expect(err).toBeInstanceOf(GitCommandError);
		const text = `${err!.stderr}${err!.stdout}`.toLowerCase();
		expect(text.includes("stale info") || text.includes("rejected")).toBe(true);
	});
});

describe("runGit", () => {
	const capture = () => {
		const captured: { cmd?: readonly string[]; options?: RunOptions } = {};
		spyOn(processRunner, "run").mockImplementation(async (cmd, options) => {
			captured.cmd = cmd;
			captured.options = options;
			return done(cmd);
		});
		return captured;
	};

	test("injects safe.directory and subprocess identity", async () => {
		const captured = capture();
		const identity = { uid: 2001, gid: 2001, groups: [2000], umask: 0o002 };
		await runGit(["status"], { cwd: tmpPath(), token: null, safeDirectory: "/x", identity });
		const env = captured.options!.env!;
		// The safe.directory entry is appended after any inherited GIT_CONFIG_* pairs.
		const idx = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
		expect(env.GIT_CONFIG_COUNT).toBe(String(idx + 1));
		expect(env[`GIT_CONFIG_KEY_${idx}`]).toBe("safe.directory");
		expect(env[`GIT_CONFIG_VALUE_${idx}`]).toBe("/x");
		expect(captured.cmd).toContain("protocol.ext.allow=never");
		expect(captured.options!.identity).toEqual(identity);
	});

	test("scopes the token and scrubs parent auth env", async () => {
		const prev = { token: process.env.GITHUB_TOKEN, auth: process.env[AUTH_ENV_VAR] };
		process.env.GITHUB_TOKEN = "parent-token";
		process.env[AUTH_ENV_VAR] = "parent-auth";
		const captured = capture();
		const authUrl = "https://github.com/octo/widget.git";
		try {
			await runGit(["ls-remote", authUrl], { cwd: tmpPath(), token: "scoped-token", authUrl });
		} finally {
			for (const [key, value] of [
				["GITHUB_TOKEN", prev.token],
				[AUTH_ENV_VAR, prev.auth],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		const env = captured.options!.env!;
		const cmd = captured.cmd!;
		expect(env[AUTH_ENV_VAR]!.startsWith("Authorization: Basic ")).toBe(true);
		expect(env[AUTH_ENV_VAR]).not.toBe("parent-auth");
		expect("GITHUB_TOKEN" in env).toBe(false);
		expect(env.GIT_ALLOW_PROTOCOL).toBe("https");
		expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
		for (const item of [
			"--config-env",
			`http.${authUrl}.extraHeader=${AUTH_ENV_VAR}`,
			"protocol.allow=never",
			"protocol.https.allow=always",
			"protocol.ext.allow=never",
			"core.hooksPath=/dev/null",
			"http.proxy=",
			"http.sslVerify=true",
			`http.${authUrl}.proxy=`,
			`http.${authUrl}.sslVerify=true`,
			`http.${authUrl}.extraHeader=`,
		]) {
			expect(cmd).toContain(item);
		}
	});

	test("kills a hung child", async () => {
		const tmp = tmpPath();
		const fakebin = path.join(tmp, "bin");
		fs.mkdirSync(fakebin);
		fs.writeFileSync(path.join(fakebin, "git"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
		const prevPath = process.env.PATH;
		process.env.PATH = fakebin;
		try {
			const err = await runGit(["status"], { cwd: tmp, token: null, timeout: 0.5 }).then(
				() => null,
				(e: unknown) => e as GitCommandError,
			);
			expect(err).toBeInstanceOf(GitCommandError);
			expect(err!.returncode).toBe(124);
			expect(err!.stderr.toLowerCase()).toContain("timed out");
		} finally {
			process.env.PATH = prevPath;
		}
	});
});

describe("partial-clone blob backfill (oh-my-pi#1818)", () => {
	const partialUpstream = (tmp: string) => {
		const repo = path.join(tmp, "partial-upstream.git");
		fs.mkdirSync(repo);
		git(["init", "--initial-branch=main", "--bare", repo], tmp);
		git(["-C", repo, "config", "uploadpack.allowFilter", "true"], tmp);
		git(["-C", repo, "config", "uploadpack.allowAnySHA1InWant", "true"], tmp);
		const seed = path.join(tmp, "partial-seed");
		fs.mkdirSync(seed);
		git(["init", "--initial-branch=main", seed], tmp);
		fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
		git(["-C", seed, "add", "."], tmp);
		git(["-C", seed, "commit", "-m", "init"], tmp);
		git(["-C", seed, "remote", "add", "origin", repo], tmp);
		git(["-C", seed, "push", "origin", "main"], tmp);
		return repo;
	};
	const commitNewBlob = (upstream: string, tmp: string, file: string, content: string, ref = "main") => {
		const contrib = path.join(tmp, `contrib-${file.replaceAll("/", "_")}`);
		git(["clone", `file://${upstream}`, contrib], tmp);
		fs.writeFileSync(path.join(contrib, file), content);
		git(["-C", contrib, "add", file], tmp);
		git(["-C", contrib, "commit", "-m", `add ${file}`], tmp);
		const sha = git(["-C", contrib, "rev-parse", "HEAD"], tmp);
		git(["-C", contrib, "push", "origin", `HEAD:${ref}`], tmp);
		return sha;
	};
	const missing = (repo: string, rev: string) =>
		git(["-C", repo, "rev-list", "--objects", "--missing=print", rev], repo)
			.split("\n")
			.filter(line => line.startsWith("?"))
			.map(line => line.slice(1).split(" ")[0]);
	const partialClone = (tmp: string, upstream: string) => {
		const pool = path.join(tmp, "pool");
		git(["clone", "--filter=blob:none", "--no-tags", "--branch", "main", `file://${upstream}`, pool], tmp);
		return pool;
	};

	test("fetchRef backfills missing blobs", async () => {
		const tmp = tmpPath();
		const upstream = partialUpstream(tmp);
		const pool = partialClone(tmp, upstream);
		commitNewBlob(upstream, tmp, "payload.txt", "v2 contents here\n");
		await gitFetchPrune(pool, { token: null });
		expect(missing(pool, "origin/main").length).toBeGreaterThan(0);
		const cfgBefore = fs.readFileSync(path.join(pool, ".git", "config"), "utf-8");
		expect(cfgBefore).toContain("partialclonefilter = blob:none");
		expect(cfgBefore).toContain("promisor = true");
		await gitFetchRef(pool, "main", { token: null });
		expect(missing(pool, "origin/main")).toEqual([]);
		const cfgAfter = fs.readFileSync(path.join(pool, ".git", "config"), "utf-8");
		expect(cfgAfter).toContain("partialclonefilter = blob:none");
		expect(cfgAfter).toContain("promisor = true");
		git(["-C", pool, "remote", "set-url", "origin", "https://example.invalid/missing.git"], tmp);
		const wsDir = path.join(tmp, "ws");
		gitSync(tmp, ["-C", pool, "worktree", "add", "-b", "verify-1818", wsDir, "origin/main"], {
			env: { GIT_TERMINAL_PROMPT: "0" },
		});
		expect(fs.readFileSync(path.join(wsDir, "payload.txt"), "utf-8")).toBe("v2 contents here\n");
	});

	test("fetchPrHead backfills missing blobs", async () => {
		const tmp = tmpPath();
		const upstream = partialUpstream(tmp);
		const pool = partialClone(tmp, upstream);
		const prSha = commitNewBlob(upstream, tmp, "pr.txt", "pr blob payload\n", "refs/pull/7/head");
		await gitFetchPrHead(pool, 7, { token: null });
		expect(missing(pool, prSha)).toEqual([]);
		git(["-C", pool, "remote", "set-url", "origin", "https://example.invalid/missing.git"], tmp);
		const wsDir = path.join(tmp, "pr-ws");
		gitSync(tmp, ["-C", pool, "worktree", "add", "--detach", wsDir, "FETCH_HEAD"], {
			env: { GIT_TERMINAL_PROMPT: "0" },
		});
		expect(fs.readFileSync(path.join(wsDir, "pr.txt"), "utf-8")).toBe("pr blob payload\n");
	});
});

describe("natives cache integration", () => {
	test("without a cache the native dir is untouched", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"));
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 10,
			title: "no cache",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		});
		expect(mgr.nativesCache).toBeNull();
		expect(fs.existsSync(path.join(ws.repo_dir, "packages/natives/native"))).toBe(false);
	});

	test("populates from the natives cache", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const cache = new NativesCache(path.join(tmp, "natives-cache"));
		const mgr = new SandboxManager(path.join(tmp, "workspaces"), { nativesCache: cache });
		const base = { repo: "octo/widget", cloneUrl: upstream, defaultBranch: "main", ...AUTHOR };
		const ws1 = await mgr.ensureWorkspace({ ...base, number: 11, title: "producer" });
		const native1 = path.join(ws1.repo_dir, "packages/natives/native");
		fs.mkdirSync(native1, { recursive: true });
		const triple = targetTriple();
		fs.writeFileSync(path.join(native1, `pi_natives.${triple}.node`), "ELFx");
		fs.writeFileSync(path.join(native1, "index.d.ts"), "export const X: number;\n");
		fs.writeFileSync(path.join(native1, "index.js"), "export const X = 1;\n");
		fs.writeFileSync(path.join(native1, "embedded-addon.js"), "export const embeddedAddon = null;\n");
		const key = await computeKey(ws1.repo_dir);
		expect(await cache.capture("octo/widget", key, native1)).not.toBeNull();
		const ws2 = await mgr.ensureWorkspace({ ...base, number: 12, title: "consumer" });
		const node = path.join(ws2.repo_dir, "packages/natives/native", `pi_natives.${triple}.node`);
		expect(fs.readFileSync(node, "utf-8")).toBe("ELFx");
		expect(fs.statSync(path.join(cache.entryDir("octo/widget", key), `pi_natives.${triple}.node`)).ino).toBe(
			fs.statSync(node).ino,
		);
	});

	test("a cache miss is a silent noop", async () => {
		const tmp = tmpPath();
		const upstream = upstreamRepo(tmp);
		const mgr = new SandboxManager(path.join(tmp, "workspaces"), {
			nativesCache: new NativesCache(path.join(tmp, "empty-cache")),
		});
		const ws = await mgr.ensureWorkspace({
			repo: "octo/widget",
			number: 13,
			title: "miss",
			cloneUrl: upstream,
			defaultBranch: "main",
			...AUTHOR,
		});
		expect(fs.existsSync(path.join(ws.repo_dir, "packages/natives/native"))).toBe(false);
	});
});

describe("repo lock", () => {
	test("is per-repo identity", () => {
		const mgr = new SandboxManager(tmpPath());
		expect(mgr.repoLock("o/r")).toBe(mgr.repoLock("o/r"));
		expect(mgr.repoLock("o/r")).not.toBe(mgr.repoLock("o/r2"));
	});

	test("serializes the same repo", async () => {
		const mgr = new SandboxManager(tmpPath());
		const release = await mgr.repoLock("o/r").acquire();
		expect(mgr.repoLock("o/r").tryAcquire()).toBeNull();
		release();
		const again = mgr.repoLock("o/r").tryAcquire();
		expect(again).not.toBeNull();
		again!();
	});

	test("allows distinct repos to overlap", async () => {
		const mgr = new SandboxManager(tmpPath());
		const release = await mgr.repoLock("o/a").acquire();
		const other = mgr.repoLock("o/b").tryAcquire();
		expect(other).not.toBeNull();
		other!();
		release();
	});

	const stubTransport = (): GitTransport => ({
		clonePool: async () => {},
		fetchPool: async () => {},
		fetchBaseRef: async () => {},
		fetchPrHead: async () => {},
		pushBranch: async () => ({ head: "", branch: "" }),
		pushRelease: async () => ({ head: "", branch: "" }),
	});

	const recordingLock = (mgr: SandboxManager, events: (string | [string, string])[]) => {
		const real = mgr.repoLock.bind(mgr);
		spyOn(mgr, "repoLock").mockImplementation(repo => {
			events.push(["lock", repo]);
			const lock = real(repo);
			const original = lock.runExclusive.bind(lock);
			lock.runExclusive = async fn =>
				original(async () => {
					events.push("acquire");
					try {
						return await fn();
					} finally {
						events.push("release");
					}
				});
			return lock;
		});
	};

	const stubInternals = () => {
		spyOn(sandboxDeps, "run").mockImplementation(async cmd => done(cmd));
		spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd => done(cmd));
		spyOn(sandboxDeps, "chownWorkspace").mockImplementation(async () => {});
		spyOn(sandboxDeps, "shareGitMetadataWithSlots").mockImplementation(() => {});
		spyOn(sandboxDeps, "provisionRuntimeDirs").mockImplementation(() => {});
	};

	test("ensureWorkspace acquires the repo lock", async () => {
		const mgr = new SandboxManager(tmpPath());
		mgr.transport = stubTransport();
		const events: (string | [string, string])[] = [];
		recordingLock(mgr, events);
		stubInternals();
		const ws = await mgr.ensureWorkspace({
			repo: "o/r",
			number: 1,
			title: "t",
			cloneUrl: "https://x/o/r.git",
			defaultBranch: "main",
			authorName: "n",
			authorEmail: "e@e",
			slotUid: null,
		});
		expect(events).toContainEqual(["lock", "o/r"]);
		expect(events.filter(e => e === "acquire")).toHaveLength(1);
		expect(events.filter(e => e === "release")).toHaveLength(1);
		expect(ws.repo_full_name).toBe("o/r");
	});

	test("removeWorkspace acquires the repo lock", async () => {
		const mgr = new SandboxManager(tmpPath());
		const events: (string | [string, string])[] = [];
		recordingLock(mgr, events);
		await mgr.removeWorkspace({ repo: "o/r", number: 99 });
		expect(events).toContainEqual(["lock", "o/r"]);
		expect(events.filter(e => e === "acquire")).toHaveLength(1);
		expect(events.filter(e => e === "release")).toHaveLength(1);
	});

	const probeTimeoutCase = async (
		fake: (cmd: readonly string[]) => CompletedProcess,
		prepare?: (mgr: SandboxManager) => void,
	) => {
		const mgr = new SandboxManager(tmpPath());
		mgr.transport = stubTransport();
		prepare?.(mgr);
		stubInternals();
		spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd => fake(cmd));
		spyOn(sandboxDeps, "gitEnvForRepo").mockReturnValue({});
		await expect(
			mgr.ensureWorkspace({
				repo: "o/r",
				number: 1,
				title: "t",
				cloneUrl: "https://x/o/r.git",
				defaultBranch: "main",
				authorName: "n",
				authorEmail: "e@e",
				existingBranch: "feature/x",
				slotUid: null,
			}),
		).rejects.toBeInstanceOf(GitCommandError);
	};

	test("raises when the local branch probe times out", async () => {
		await probeTimeoutCase(cmd =>
			cmd.includes("rev-parse") && cmd.at(-1)!.startsWith("refs/heads/")
				? done(cmd, 124, "", "timed out")
				: done(cmd),
		);
	});

	test("raises when the remote branch probe times out", async () => {
		await probeTimeoutCase(cmd => {
			if (cmd.includes("rev-parse") && cmd.at(-1)!.startsWith("refs/heads/")) return done(cmd, 128);
			if (cmd.includes("rev-parse") && cmd.at(-1)!.startsWith("refs/remotes/origin/"))
				return done(cmd, 124, "", "timed out");
			return done(cmd);
		});
	});

	test("raises when the symbolic-ref probe times out", async () => {
		await probeTimeoutCase(
			cmd => (cmd[1] === "symbolic-ref" ? done(cmd, 124, "", "timed out") : done(cmd)),
			mgr => fs.mkdirSync(path.join(mgr.workspaceRoot("o/r", 1), "repo", ".git"), { recursive: true }),
		);
	});
});

describe("timeouts", () => {
	test("safeRun timeout returns 124", async () => {
		const seen: { timeout?: number | null } = {};
		spyOn(processRunner, "run").mockImplementation(async (cmd, options) => {
			seen.timeout = options?.timeout;
			return { ...done(cmd, 124), timedOut: true };
		});
		expect((await safeRun(["git", "status"])).returncode).toBe(124);
		expect(seen.timeout).toBe(DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT);
	});

	test("run timeout raises GitCommandError 124", async () => {
		const seen: { timeout?: number | null } = {};
		spyOn(processRunner, "run").mockImplementation(async (cmd, options) => {
			seen.timeout = options?.timeout;
			return { ...done(cmd, 124), timedOut: true };
		});
		const err = await run(["git", "status"]).then(
			() => null,
			(e: unknown) => e as GitCommandError,
		);
		expect(err).toBeInstanceOf(GitCommandError);
		expect(err!.returncode).toBe(124);
		expect(seen.timeout).toBe(DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT);
	});

	test("worktreeAdd cleans partial state on failure", async () => {
		const tmp = tmpPath();
		const pool = path.join(tmp, "pool");
		fs.mkdirSync(pool);
		const repoDir = path.join(tmp, "ws", "repo");
		fs.mkdirSync(repoDir, { recursive: true });
		fs.writeFileSync(path.join(repoDir, "leftover"), "partial");
		spyOn(sandboxDeps, "run").mockImplementation(async cmd => {
			throw new GitCommandError(cmd, 124, "", "timed out");
		});
		const pruned: string[] = [];
		spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd => {
			pruned.push(cmd.join(" "));
			return done(cmd);
		});
		const err = await worktreeAdd(["git", "worktree", "add", repoDir, "main"], pool, repoDir).then(
			() => null,
			(e: unknown) => e as GitCommandError,
		);
		expect(err?.returncode).toBe(124);
		expect(fs.existsSync(repoDir)).toBe(false);
		expect(pruned).toContain("git worktree prune");
	});

	test("worktreeAdd raises the prune failure chained from the add error", async () => {
		const tmp = tmpPath();
		const pool = path.join(tmp, "pool");
		fs.mkdirSync(pool);
		const repoDir = path.join(tmp, "ws", "repo");
		fs.mkdirSync(repoDir, { recursive: true });
		const addErr = new GitCommandError(["git", "worktree", "add"], 1, "", "add failed");
		spyOn(sandboxDeps, "run").mockImplementation(async () => {
			throw addErr;
		});
		spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd => done(cmd, 124, "", "prune timed out"));
		const err = await worktreeAdd(["git", "worktree", "add", repoDir, "main"], pool, repoDir).then(
			() => null,
			(e: unknown) => e as GitCommandError,
		);
		expect(err?.returncode).toBe(124);
		expect(err?.cause).toBe(addErr);
	});

	test("ensureClone fails before fetch when the origin probe times out", async () => {
		const mgr = new SandboxManager(path.join(tmpPath(), "workspaces"));
		fs.mkdirSync(path.join(mgr.poolPath("octo/widget"), ".git"), { recursive: true });
		let fetched = false;
		mgr.transport = {
			clonePool: async () => {},
			fetchBaseRef: async () => {},
			fetchPrHead: async () => {},
			pushBranch: async () => ({ head: "", branch: "" }),
			pushRelease: async () => ({ head: "", branch: "" }),
			fetchPool: async () => {
				fetched = true;
			},
		};
		spyOn(sandboxDeps, "safeRun").mockImplementation(async cmd =>
			cmd.join(" ") === "git remote get-url origin" ? done(cmd, 124, "", "timed out") : done(cmd),
		);
		await expect(
			mgr.ensureClone({
				repo: "octo/widget",
				cloneUrl: "https://github.com/octo/widget.git",
				defaultBranch: "main",
			}),
		).rejects.toBeInstanceOf(GitCommandError);
		expect(fetched).toBe(false);
	});
});

describe("workspace cache reclamation", () => {
	const seedReclaimable = (mgr: SandboxManager, repo: string, number: number) => {
		const wsRoot = mgr.workspaceRoot(repo, number);
		for (const rel of [
			"repo/node_modules/left-pad",
			"repo/packages/tui/node_modules/dep",
			"repo/src",
			".omp-session",
			".omp-xdg/cache/bun-install",
			".omp-xdg/state/omp",
			".omp-tmp",
			"artifacts",
		]) {
			fs.mkdirSync(path.join(wsRoot, rel), { recursive: true });
		}
		const files: Record<string, string> = {
			"repo/node_modules/left-pad/index.js": "x",
			"repo/packages/tui/node_modules/dep/index.js": "x",
			"repo/src/keep.ts": "keep",
			".omp-session/session.jsonl": "{}",
			".omp-xdg/cache/bun-install/pkg.tgz": "x",
			".omp-xdg/state/omp/state.json": "{}",
			".omp-tmp/scratch": "x",
			"artifacts/run.log": "x",
		};
		for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(wsRoot, rel), content);
		return wsRoot;
	};
	const trash = (wsRoot: string) => fs.readdirSync(wsRoot).filter(n => n.startsWith(".trash-"));

	test("strips dep caches and preserves state", async () => {
		const mgr = new SandboxManager(path.join(tmpPath(), "workspaces"));
		const wsRoot = seedReclaimable(mgr, "octo/widget", 7);
		expect(await mgr.reclaimWorkspaceCaches({ repo: "octo/widget", number: 7 })).toBe(true);
		for (const rel of ["repo/node_modules", "repo/packages/tui/node_modules", ".omp-xdg/cache", ".omp-tmp"]) {
			expect(fs.existsSync(path.join(wsRoot, rel))).toBe(false);
		}
		expect(fs.readFileSync(path.join(wsRoot, "repo/src/keep.ts"), "utf-8")).toBe("keep");
		for (const rel of [".omp-session/session.jsonl", ".omp-xdg/state/omp/state.json", "artifacts/run.log"]) {
			expect(fs.existsSync(path.join(wsRoot, rel))).toBe(true);
		}
		expect(trash(wsRoot)).toEqual([]);
		expect(await mgr.reclaimWorkspaceCaches({ repo: "octo/widget", number: 7 })).toBe(false);
	});

	test("a missing workspace is a noop", async () => {
		const mgr = new SandboxManager(path.join(tmpPath(), "workspaces"));
		expect(await mgr.reclaimWorkspaceCaches({ repo: "octo/widget", number: 404 })).toBe(false);
	});

	test("reclaimAllCaches sweeps workspaces, not the pool", async () => {
		const mgr = new SandboxManager(path.join(tmpPath(), "workspaces"));
		const wsA = seedReclaimable(mgr, "octo/widget", 1);
		const wsB = seedReclaimable(mgr, "octo/gadget", 2);
		fs.mkdirSync(path.join(wsB, ".trash-dead"));
		fs.writeFileSync(path.join(wsB, ".trash-dead/junk"), "x");
		const poolMarker = path.join(mgr.pool, "octo__widget", "node_modules");
		fs.mkdirSync(poolMarker, { recursive: true });
		expect(await mgr.reclaimAllCaches()).toBe(2);
		for (const wsRoot of [wsA, wsB]) {
			expect(fs.existsSync(path.join(wsRoot, "repo/node_modules"))).toBe(false);
			expect(fs.existsSync(path.join(wsRoot, ".omp-session/session.jsonl"))).toBe(true);
			expect(trash(wsRoot)).toEqual([]);
		}
		expect(fs.existsSync(poolMarker)).toBe(true);
		expect(await mgr.reclaimAllCaches()).toBe(0);
	});
});
