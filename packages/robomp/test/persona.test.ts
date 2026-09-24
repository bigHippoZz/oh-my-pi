import { expect, test } from "bun:test";
import * as persona from "../src/persona";
import { directiveInfo, type ReleaseTaskContext, threadMessage } from "../src/task-types";

const repo = { full_name: "octo/widget", default_branch: "main", clone_url: "", private: false };
const issue = (overrides: Record<string, unknown> = {}) => ({
	repo: "octo/widget",
	number: 1080,
	title: "broken thing",
	body: "the body text",
	state: "open",
	author: "alice",
	labels: [] as string[],
	is_pull_request: false,
	...overrides,
});
const workspace = (branch = "farm/abc/test") => ({
	branch,
	session_dir: "/tmp/session",
	context_dir: "/tmp/ctx",
	repo_dir: "/tmp/repo",
});
const pr = {
	number: 99,
	author: "alice",
	head_ref: "fix-crash",
	base_ref: "main",
	head_repo: "alice/widget",
	html_url: "https://github.com/octo/widget/pull/99",
};
const comment = (body = "@roboomp please fix") => ({
	id: 1,
	author: "can1357",
	body,
	created_at: "2026-05-14T20:00:00Z",
});

test("renderThread empty yields placeholder", () => {
	expect(persona.renderThread([]).startsWith("(no prior")).toBe(true);
});

test("renderThread orders kinds with appropriate headers", () => {
	const out = persona.renderThread([
		threadMessage({ kind: "issue_body", author: "alice", body: "orig report", created_at: "" }),
		threadMessage({ kind: "comment", author: "bob", body: "me too", created_at: "2026-05-01T10:00:00Z" }),
		threadMessage({
			kind: "review_comment",
			author: "codex",
			body: "leak here",
			created_at: "2026-05-02T10:00:00Z",
			path: "src/foo.py",
			line: 42,
		}),
		threadMessage({
			kind: "review",
			author: "codex",
			body: "two issues",
			created_at: "2026-05-02T10:01:00Z",
			state: "CHANGES_REQUESTED",
		}),
	]);
	for (const fragment of [
		"### @alice — issue body",
		"orig report",
		"### @bob — comment *(2026-05-01T10:00:00Z)*",
		"me too",
		"### @codex — review comment on `src/foo.py`:L42",
		"leak here",
		"### @codex — review (CHANGES_REQUESTED)",
		"two issues",
	]) {
		expect(out).toContain(fragment);
	}
});

test("directive prompt embeds thread and directive body", () => {
	const out = persona.directive({
		repo,
		issue: issue(),
		comment: comment(),
		workspace: workspace(),
		directive: directiveInfo({
			body: "apply fix Y",
			author: "can1357",
			thread: [
				threadMessage({
					kind: "comment",
					author: "alice",
					body: "follow up please",
					created_at: "2026-05-01T10:00:00Z",
				}),
			],
		}),
		prStatus: "PR #1080 is open",
	});
	for (const fragment of ["octo/widget#1080", "@can1357", "apply fix Y", "follow up please", "PR #1080 is open"])
		expect(out).toContain(fragment);
});

test("followup comment prompt embeds thread context", () => {
	const out = persona.followupComment({
		repo,
		issue: issue(),
		comment: comment("current request"),
		workspace: workspace(),
		prStatus: "PR #1080 is open",
		prNumber: 1080,
		thread: [
			threadMessage({ kind: "pr_body", author: "roboomp", body: "PR body", created_at: "" }),
			threadMessage({
				kind: "comment",
				author: "can1357",
				body: "prior request",
				created_at: "2026-05-01T10:00:00Z",
			}),
		],
	});
	for (const fragment of ["Prior conversation", "PR body", "prior request", "current request"])
		expect(out).toContain(fragment);
});

test("kickoff directive embeds thread and the classify instruction", () => {
	const out = persona.kickoffDirective({
		repo,
		issue: issue(),
		workspace: workspace(),
		directive: directiveInfo({
			body: "reproduce + fix",
			author: "can1357",
			thread: [threadMessage({ kind: "issue_body", author: "alice", body: "failing on macos", created_at: "" })],
		}),
	});
	for (const fragment of ["octo/widget#1080", "failing on macos", "reproduce + fix", "Classify first"])
		expect(out).toContain(fragment);
});

test("resume triage renders branch and issue", () => {
	const out = persona.resumeTriage({ repo, issue: issue(), workspace: workspace() });
	for (const fragment of ["farm/abc/test", "octo/widget#1080", "broken thing", "fetch_issue_thread"])
		expect(out).toContain(fragment);
});

test("kickoff PR review formats head repo and origin base", () => {
	const out = persona.kickoffPrReview({ repo, pr, workspace: workspace() });
	expect(out).toContain("`fix-crash` from `alice/widget`");
	expect(out).toContain("git diff origin/main...HEAD");
});

test("review completion reminder mentions submit only", () => {
	const out = persona.reviewCompletionReminder({
		repo,
		issue: issue({ number: 99, title: "Fix parser" }),
		workspace: workspace("review/pr-99"),
	});
	expect(out).toContain("submit_pr_review");
	expect(out).not.toContain("gh_open_pr");
});

test("completion reminder limits mark_unable to reporter details", () => {
	const out = persona.completionReminder({ repo, issue: issue(), workspace: workspace() });
	expect(out).toContain("reporter-provided reproduction details");
	expect(out).not.toContain("maintainer input");
});

test("system append renders the configured bot login", () => {
	const out = persona.systemAppend({ repo, issue: issue(), workspace: workspace(), botLogin: "Svitter" });
	expect(out).toContain("You are **@Svitter**");
	expect(out).not.toContain("**robomp**");
});

test("system append routes push refusal to a maintainer comment only", () => {
	const out = persona.systemAppend({ repo, issue: issue(), workspace: workspace(), botLogin: "Svitter" });
	expect(out).toContain("Unresolvable push refusal");
	expect(out).toContain("`gh_post_comment` maintainer");
	expect(out).not.toContain("or use `mark_unable_to_reproduce`");
});

test("PR review system append renders the configured bot login", () => {
	const out = persona.systemAppendPrReview({ repo, issue: issue(), workspace: workspace(), botLogin: "Svitter" });
	expect(out).toContain("@Svitter");
	expect(out).not.toContain("**robomp**");
});

const releaseContext: ReleaseTaskContext = {
	tag: "v17.2.8",
	version: "17.2.8",
	round: 2,
	max_rounds: 5,
	head_sha: "a".repeat(40),
	default_branch: "main",
	failures_text: "## CI / check (failure)\n`bun check` failed",
	run_urls: ["https://example.invalid/runs/10"],
};

test("release prompts preserve the retag contract", () => {
	const system = persona.systemAppendRelease({
		repo,
		release: releaseContext,
		workspace: workspace("main"),
		releaseCommitPrefix: "chore: bump version to ",
	});
	const kickoff = persona.kickoffRelease({ repo, release: releaseContext, workspace: workspace("main") });
	const followup = persona.followupRelease({ repo, release: releaseContext, workspace: workspace("main") });
	expect(system).toContain("`chore: bump version to 17.2.8`");
	expect(system).toContain("NEVER bump versions or changelogs");
	expect(system).toContain("After `release_retag` succeeds, END YOUR TURN");
	expect(kickoff).toContain("`bun check` failed");
	expect(kickoff).toContain("2/5");
	expect(followup).toContain("still failing");
	expect(followup).toContain("crash-resumed round");
});

test("release todo phases end in retag", () => {
	const phases = persona.seedPhases("handle_release_ci");
	expect(phases.map(p => p.name)).toEqual(["Diagnose", "Fix", "Retag"]);
	expect(phases.at(-1)!.tasks.at(-1)).toBe("Call release_retag and end the turn");
});
