import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicLink, CACHE_KEY_PATHS, computeKey, NativesCache, NativesKeyError } from "../src/natives-cache";
import { gitSync, tmpPath } from "./helpers";

const REPO = "octo/widget";
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args: string[], cwd: string) => gitSync(cwd, args, { env: gitEnv });

function write(p: string, content: string | Uint8Array): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

function seedRepo(root: string, withAllInputs = true): string {
	fs.mkdirSync(root, { recursive: true });
	git(["init", "--initial-branch=main", root], path.dirname(root));
	write(path.join(root, "Cargo.lock"), "# lock v1\n");
	if (withAllInputs) {
		write(path.join(root, "Cargo.toml"), "[workspace]\nmembers = ['crates/*']\n");
		write(path.join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.85.0"\n');
		write(path.join(root, "crates/pi-natives/Cargo.toml"), '[package]\nname = "pi-natives"\n');
		write(path.join(root, "crates/pi-natives/src.rs"), "// source\n");
		write(path.join(root, "packages/natives/package.json"), '{"name":"@oh-my-pi/pi-natives"}\n');
		write(path.join(root, "packages/natives/scripts/build-native.ts"), "// build script\n");
		write(path.join(root, "packages/natives/native/index.d.ts"), "// initial typings\n");
	}
	git(["-C", root, "add", "."], path.dirname(root));
	git(["-C", root, "commit", "-m", "init"], path.dirname(root));
	return root;
}

function populateBuiltArtifacts(
	repoDir: string,
	body: Uint8Array = new TextEncoder().encode("\x7fELF...native"),
): string {
	const nativeDir = path.join(repoDir, "packages/natives/native");
	write(path.join(nativeDir, "pi_natives.linux-arm64.node"), body);
	write(path.join(nativeDir, "index.d.ts"), "export const X: number;\n");
	write(path.join(nativeDir, "index.js"), "export const X = 1;\n");
	write(path.join(nativeDir, "embedded-addon.js"), "export const embeddedAddon = null;\n");
	return nativeDir;
}

const cacheIn = (tmp: string, options?: { maxEntriesPerRepo?: number; maxBytes?: number }) =>
	new NativesCache(path.join(tmp, "natives-cache"), options);

const entries = (cache: NativesCache) =>
	new Set(
		fs
			.readdirSync(cache.repoRoot(REPO), { withFileTypes: true })
			.filter(e => e.isDirectory() && !e.name.startsWith("."))
			.map(e => e.name),
	);

describe("computeKey", () => {
	test("deterministic across clones", async () => {
		const tmp = tmpPath();
		const a = seedRepo(path.join(tmp, "a"));
		const b = path.join(tmp, "b");
		git(["clone", a, b], tmp);
		expect(await computeKey(a, "linux-arm64")).toBe(await computeKey(b, "linux-arm64"));
	});

	test("changes when each input changes", async () => {
		const tmp = tmpPath();
		const base = seedRepo(path.join(tmp, "base"));
		const baseKey = await computeKey(base, "linux-arm64");
		const mutations: Record<string, [string, string]> = {
			crates: ["crates/pi-natives/src.rs", "// new comment\n"],
			"Cargo.lock": ["Cargo.lock", "# lock v2\n"],
			"Cargo.toml": ["Cargo.toml", "[workspace]\nmembers = ['crates/*', 'extra']\n"],
			"rust-toolchain.toml": ["rust-toolchain.toml", '[toolchain]\nchannel = "1.86.0"\n'],
			"packages/natives": ["packages/natives/scripts/build-native.ts", "// edited\n"],
		};
		for (const [label, [rel, body]] of Object.entries(mutations)) {
			const clone = path.join(tmp, `clone-${label.replaceAll("/", "-")}`);
			git(["clone", base, clone], tmp);
			write(path.join(clone, rel), body);
			git(["-C", clone, "add", "."], tmp);
			git(["-C", clone, "commit", "-m", `mutate ${label}`], tmp);
			expect(await computeKey(clone, "linux-arm64")).not.toBe(baseKey);
		}
	});

	test("target triple changes the key", async () => {
		const repo = seedRepo(path.join(tmpPath(), "repo"));
		expect(await computeKey(repo, "linux-arm64")).not.toBe(await computeKey(repo, "linux-x64-modern"));
	});

	test("handles missing inputs deterministically", async () => {
		const repo = seedRepo(path.join(tmpPath(), "repo"), false);
		const before = await computeKey(repo, "linux-arm64");
		write(path.join(repo, "crates/pi-natives/lib.rs"), "// new\n");
		git(["-C", repo, "add", "."], repo);
		git(["-C", repo, "commit", "-m", "add crates"], repo);
		expect(await computeKey(repo, "linux-arm64")).not.toBe(before);
	});

	test("uses all documented paths", () => {
		expect(CACHE_KEY_PATHS).toEqual([
			"crates",
			"Cargo.lock",
			"Cargo.toml",
			"rust-toolchain.toml",
			"packages/natives",
		]);
	});

	test("rejects a non-repo", async () => {
		await expect(computeKey(tmpPath(), "linux-arm64")).rejects.toBeInstanceOf(NativesKeyError);
	});
});

describe("populate / capture", () => {
	test("populate miss is a noop", () => {
		const tmp = tmpPath();
		const cache = cacheIn(tmp);
		const repoDir = seedRepo(path.join(tmp, "ws", "repo"));
		const nativeDir = path.join(repoDir, "packages/natives/native");
		const before = fs.readdirSync(nativeDir).sort();
		expect(cache.populateWorkspace(REPO, "deadbeef".repeat(8), nativeDir)).toBeNull();
		expect(fs.readdirSync(nativeDir).sort()).toEqual(before);
	});

	test("capture then populate shares the node inode but copies companions", async () => {
		const tmp = tmpPath();
		const cache = cacheIn(tmp);
		const srcRepo = seedRepo(path.join(tmp, "src", "repo"));
		const nativeDir = populateBuiltArtifacts(srcRepo);
		const key = await computeKey(srcRepo, "linux-arm64");
		const stored = (await cache.capture(REPO, key, nativeDir, { sourceWorkspace: "src__001" }))!;
		expect(stored).not.toBeNull();
		const manifest = JSON.parse(fs.readFileSync(path.join(stored, "manifest.json"), "utf-8")) as {
			key: string;
			node_files: string[];
		};
		expect(manifest.key).toBe(key);
		expect(manifest.node_files).toContain("pi_natives.linux-arm64.node");

		const dstRepo = path.join(tmp, "dst", "repo");
		fs.mkdirSync(path.dirname(dstRepo), { recursive: true });
		git(["clone", srcRepo, dstRepo], path.dirname(dstRepo));
		const dstNative = path.join(dstRepo, "packages/natives/native");
		fs.mkdirSync(dstNative, { recursive: true });
		const hit = cache.populateWorkspace(REPO, key, dstNative)!;
		const names = new Set(hit.files.map(f => path.basename(f)));
		for (const name of ["pi_natives.linux-arm64.node", "index.d.ts", "index.js", "embedded-addon.js"]) {
			expect(names.has(name)).toBe(true);
		}
		const cachedNode = fs.statSync(path.join(stored, "pi_natives.linux-arm64.node"));
		const wsNode = fs.statSync(path.join(dstNative, "pi_natives.linux-arm64.node"));
		expect(cachedNode.ino).toBe(wsNode.ino);
		expect(cachedNode.nlink).toBeGreaterThanOrEqual(2);
		for (const name of ["index.d.ts", "index.js", "embedded-addon.js"]) {
			const cached = path.join(stored, name);
			const ws = path.join(dstNative, name);
			expect(fs.statSync(cached).ino).not.toBe(fs.statSync(ws).ino);
			const original = fs.readFileSync(cached, "utf-8");
			fs.writeFileSync(ws, "rewritten\n");
			expect(fs.readFileSync(cached, "utf-8")).toBe(original);
		}
	});

	test("capture skips when artifacts are incomplete", async () => {
		const tmp = tmpPath();
		const cache = cacheIn(tmp);
		const repo = seedRepo(path.join(tmp, "ws", "repo"));
		const nativeDir = path.join(repo, "packages/natives/native");
		fs.writeFileSync(path.join(nativeDir, "pi_natives.linux-arm64.node"), "x");
		expect(await cache.capture(REPO, "k", nativeDir)).toBeNull();
		expect(fs.existsSync(cache.entryDir(REPO, "k"))).toBe(false);
	});

	test("capture is idempotent under the lock", async () => {
		const tmp = tmpPath();
		const cache = cacheIn(tmp);
		const srcRepo = seedRepo(path.join(tmp, "src", "repo"));
		populateBuiltArtifacts(srcRepo);
		const key = await computeKey(srcRepo, "linux-arm64");
		const nativeDir = path.join(srcRepo, "packages/natives/native");
		const results = await Promise.all([cache.capture(REPO, key, nativeDir), cache.capture(REPO, key, nativeDir)]);
		expect(results.every(r => typeof r === "string")).toBe(true);
		expect([...entries(cache)]).toEqual([key]);
	});

	test("populate falls back to copy across devices", async () => {
		const tmp = tmpPath();
		const cache = cacheIn(tmp);
		const srcRepo = seedRepo(path.join(tmp, "src", "repo"));
		populateBuiltArtifacts(srcRepo);
		const key = await computeKey(srcRepo, "linux-arm64");
		await cache.capture(REPO, key, path.join(srcRepo, "packages/natives/native"));
		const dstNative = path.join(tmp, "ws2/packages/natives/native");
		fs.mkdirSync(dstNative, { recursive: true });
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			throw Object.assign(new Error("Cross-device link"), { code: "EXDEV" });
		});
		let hit: ReturnType<NativesCache["populateWorkspace"]>;
		try {
			hit = cache.populateWorkspace(REPO, key, dstNative);
		} finally {
			link.mockRestore();
		}
		expect(hit).not.toBeNull();
		const copied = path.join(dstNative, "pi_natives.linux-arm64.node");
		expect(fs.existsSync(copied)).toBe(true);
		expect(fs.statSync(path.join(cache.entryDir(REPO, key), "pi_natives.linux-arm64.node")).ino).not.toBe(
			fs.statSync(copied).ino,
		);
	});

	test("populate replaces an existing file atomically", async () => {
		const tmp = tmpPath();
		const cache = cacheIn(tmp);
		const srcRepo = seedRepo(path.join(tmp, "src", "repo"));
		populateBuiltArtifacts(srcRepo, new TextEncoder().encode("\x7fELF.A"));
		const key = await computeKey(srcRepo, "linux-arm64");
		await cache.capture(REPO, key, path.join(srcRepo, "packages/natives/native"));
		const dstNative = path.join(tmp, "dst/packages/natives/native");
		fs.mkdirSync(dstNative, { recursive: true });
		const target = path.join(dstNative, "pi_natives.linux-arm64.node");
		fs.writeFileSync(target, "old-stub");
		expect(cache.populateWorkspace(REPO, key, dstNative)).not.toBeNull();
		expect(fs.readFileSync(target, "utf-8")).toBe("\x7fELF.A");
	});
});

function stampEntry(cache: NativesCache, key: string, capturedAt: number): string {
	const entry = cache.entryDir(REPO, key);
	fs.mkdirSync(entry, { recursive: true });
	fs.writeFileSync(path.join(entry, "pi_natives.linux-arm64.node"), "x".repeat(1024));
	for (const name of ["index.d.ts", "index.js", "embedded-addon.js"]) fs.writeFileSync(path.join(entry, name), "");
	fs.writeFileSync(
		path.join(entry, "manifest.json"),
		JSON.stringify({ key, captured_at: capturedAt, node_files: ["pi_natives.linux-arm64.node"] }),
	);
	return entry;
}

describe("gc", () => {
	const now = Date.now() / 1000;

	test("evicts oldest beyond the entry cap", async () => {
		const cache = cacheIn(tmpPath(), { maxEntriesPerRepo: 2, maxBytes: 0 });
		stampEntry(cache, "k1", now - 300);
		stampEntry(cache, "k2", now - 200);
		stampEntry(cache, "k3", now - 100);
		expect(await cache.gc(REPO)).toBe(1);
		expect(entries(cache)).toEqual(new Set(["k2", "k3"]));
	});

	test("evicts for the byte cap", async () => {
		const cache = cacheIn(tmpPath(), { maxEntriesPerRepo: 8, maxBytes: 2500 });
		stampEntry(cache, "k1", now - 300);
		stampEntry(cache, "k2", now - 200);
		stampEntry(cache, "k3", now - 100);
		await cache.gc(REPO);
		const remaining = entries(cache);
		expect(remaining.has("k1")).toBe(false);
		expect(remaining.size).toBeGreaterThan(0);
		for (const name of remaining) expect(["k2", "k3"]).toContain(name);
	});

	test("preserves workspace hardlinks", async () => {
		const tmp = tmpPath();
		const cache = cacheIn(tmp, { maxEntriesPerRepo: 1, maxBytes: 0 });
		const entry = stampEntry(cache, "k1", now - 500);
		stampEntry(cache, "k2", now - 100);
		const wsNode = path.join(tmp, "ws", "pi_natives.linux-arm64.node");
		fs.mkdirSync(path.dirname(wsNode), { recursive: true });
		fs.linkSync(path.join(entry, "pi_natives.linux-arm64.node"), wsNode);
		await cache.gc(REPO);
		expect(fs.existsSync(entry)).toBe(false);
		expect(fs.readFileSync(wsNode, "utf-8")).toBe("x".repeat(1024));
	});

	test("clears stale staging dirs", async () => {
		const cache = cacheIn(tmpPath());
		const stale = path.join(cache.repoRoot(REPO), ".aabb.tmp.99999");
		write(path.join(stale, "leaked"), "from a crashed capture");
		await cache.gc(REPO);
		expect(fs.existsSync(stale)).toBe(false);
	});

	test("drops an entry with a missing manifest", async () => {
		const cache = cacheIn(tmpPath());
		const incomplete = cache.entryDir(REPO, "bogus");
		write(path.join(incomplete, "pi_natives.linux-arm64.node"), "x");
		await cache.gc(REPO);
		expect(fs.existsSync(incomplete)).toBe(false);
	});

	test("lookup rejects an incomplete entry", () => {
		const cache = cacheIn(tmpPath());
		write(path.join(cache.entryDir(REPO, "partial"), "manifest.json"), "{}");
		expect(cache.lookup(REPO, "partial")).toBeNull();
	});
});

test("atomicLink replaces an existing target", () => {
	const tmp = tmpPath();
	const src = path.join(tmp, "src");
	const dst = path.join(tmp, "dst");
	fs.writeFileSync(src, "new");
	fs.writeFileSync(dst, "old");
	atomicLink(src, dst);
	expect(fs.readFileSync(dst, "utf-8")).toBe("new");
	expect(fs.statSync(dst).ino).toBe(fs.statSync(src).ino);
});
