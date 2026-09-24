import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	extractMention,
	isImplementationAuthorizer,
	isMaintainer,
	type RouteOptions,
	rateLimitCap,
	route,
	shouldQueue,
	verifySignature,
} from "../src/github-events";
import type { Json } from "../src/github-client";

const ALLOWLIST = new Set(["octo/widget"]);
const BOT = "robomp-bot";
const R = (eventType: string, payload: Json, options: Partial<RouteOptions> = {}) =>
	route(eventType, payload, { allowlist: ALLOWLIST, botLogin: BOT, ...options });
const repository = { full_name: "octo/widget" };
const toKey42 = () => "octo/widget#42";
const none = () => null;
const sig = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

describe("verifySignature", () => {
	test("positive", () => {
		expect(verifySignature("shh", '{"x":1}', `sha256=${sig("shh", '{"x":1}')}`)).toBe(true);
	});
	test("rejects missing header", () => {
		expect(verifySignature("shh", "{}", null)).toBe(false);
		expect(verifySignature("shh", "{}", "")).toBe(false);
		expect(verifySignature("shh", "{}", "md5=deadbeef")).toBe(false);
	});
	test("rejects wrong secret", () => {
		expect(verifySignature("wrong", '{"x":1}', `sha256=${sig("right", '{"x":1}')}`)).toBe(false);
	});
});

describe("route: issues and comments", () => {
	test("issue opened queues triage", () => {
		const d = R("issues", { action: "opened", issue: { number: 4, user: { login: "alice" } }, repository });
		expect(shouldQueue(d)).toBe(true);
		expect(d.task).toBe("triage_issue");
		expect(d.issue_key).toBe("octo/widget#4");
	});

	test("issue reopened queues submitter-attributed triage", () => {
		const d = R("issues", {
			action: "reopened",
			issue: { number: 4, user: { login: "alice" }, author_association: "CONTRIBUTOR" },
			repository,
		});
		expect(d).toMatchObject({
			decision: "queue",
			task: "triage_issue",
			issue_key: "octo/widget#4",
			reason: "issues.reopened",
			submitter: "alice",
			association: "CONTRIBUTOR",
		});
	});

	test("skips a disallowed repo", () => {
		const d = R("issues", { action: "opened", issue: { number: 1 }, repository: { full_name: "other/repo" } });
		expect(shouldQueue(d)).toBe(false);
		expect(d.reason).toContain("allowlist");
	});

	test("skips a self comment", () => {
		expect(
			shouldQueue(
				R("issue_comment", {
					action: "created",
					comment: { user: { login: BOT }, body: "hi" },
					issue: { number: 4 },
					repository,
				}),
			),
		).toBe(false);
	});

	test("skips a [bot]-suffix comment", () => {
		const d = R("issue_comment", {
			action: "created",
			comment: { user: { login: "github-actions[bot]", type: "Bot" }, body: "ci ran" },
			issue: { number: 4 },
			repository,
		});
		expect(shouldQueue(d)).toBe(false);
		expect(d.reason).toContain("bot");
	});

	test("skips user type Bot", () => {
		expect(
			shouldQueue(
				R("issue_comment", {
					action: "created",
					comment: { user: { login: "renovate", type: "Bot" }, body: "deps" },
					issue: { number: 4 },
					repository,
				}),
			),
		).toBe(false);
	});

	test("comment routes to handle_comment", () => {
		const d = R("issue_comment", {
			action: "created",
			comment: { user: { login: "alice" }, body: "hi" },
			issue: { number: 4 },
			repository,
		});
		expect(d).toMatchObject({ decision: "queue", task: "handle_comment", issue_key: "octo/widget#4" });
	});

	test("skips issues event for a pull request", () => {
		expect(
			shouldQueue(R("issues", { action: "opened", issue: { number: 4, pull_request: { url: "x" } }, repository })),
		).toBe(false);
	});

	test("issue opened captures submitter", () => {
		const d = R("issues", {
			action: "opened",
			issue: { number: 4, user: { login: "alice" }, author_association: "FIRST_TIME_CONTRIBUTOR" },
			repository,
		});
		expect(d.submitter).toBe("alice");
		expect(d.association).toBe("FIRST_TIME_CONTRIBUTOR");
	});

	test("comment captures comment author association", () => {
		const d = R("issue_comment", {
			action: "created",
			comment: { user: { login: "bob" }, body: "hi", author_association: "CONTRIBUTOR" },
			issue: { number: 4 },
			repository,
		});
		expect(d.submitter).toBe("bob");
		expect(d.association).toBe("CONTRIBUTOR");
	});
});

describe("route: pull requests", () => {
	const botPrComment = (issueUser: string) => ({
		action: "created",
		comment: { user: { login: "alice" }, body: "looks good" },
		issue: { number: 9, user: { login: issueUser }, pull_request: { url: "x" } },
		repository,
	});

	test("PR conversation uses handle_pr_conversation", () => {
		expect(R("issue_comment", botPrComment(BOT), { resolveIssueFromPr: toKey42 }).task).toBe(
			"handle_pr_conversation",
		);
	});

	test("PR conversation normalizes a bot author suffix", () => {
		const d = R("issue_comment", botPrComment(`${BOT}[bot]`), {
			botLogin: `@${BOT}[bot]`,
			resolveIssueFromPr: toKey42,
		});
		expect(d.task).toBe("handle_pr_conversation");
	});

	test("PR conversation uses the resolver for the inflight key", () => {
		const d = R("issue_comment", botPrComment(BOT), {
			resolveIssueFromPr: (repo, prNumber) => {
				expect(repo).toBe("octo/widget");
				expect(prNumber).toBe(9);
				return "octo/widget#42";
			},
		});
		expect(d.issue_key).toBe("octo/widget#42");
	});

	test("PR conversation falls back to the PR key when the resolver misses", () => {
		const d = R(
			"issue_comment",
			{ ...botPrComment(BOT), comment: { user: { login: "alice" }, body: "hi" } },
			{ resolveIssueFromPr: none },
		);
		expect(d).toMatchObject({
			decision: "queue",
			task: "handle_pr_conversation",
			submitter: "alice",
			issue_key: "octo/widget#9",
		});
	});

	test("incoming PR opened queues review_pr", () => {
		const d = R("pull_request", {
			action: "opened",
			pull_request: {
				number: 9,
				draft: false,
				user: { login: "alice", type: "User" },
				author_association: "CONTRIBUTOR",
			},
			repository,
		});
		expect(d).toMatchObject({
			decision: "queue",
			task: "review_pr",
			issue_key: "octo/widget#9",
			submitter: "alice",
			association: "CONTRIBUTOR",
		});
	});

	test("incoming PR opened skips draft, bot and disabled", () => {
		const pr: Json = { number: 9, draft: true, user: { login: "alice", type: "User" } };
		const payload = { action: "opened", pull_request: pr, repository };
		expect(shouldQueue(R("pull_request", payload))).toBe(false);
		pr.draft = false;
		pr.user = { login: BOT, type: "Bot" };
		expect(shouldQueue(R("pull_request", payload))).toBe(false);
		pr.user = { login: "alice", type: "User" };
		const disabled = R("pull_request", payload, { prReviewEnabled: false });
		expect(shouldQueue(disabled)).toBe(false);
		expect(disabled.reason).toContain("disabled");
	});

	test("synchronize stays skipped", () => {
		expect(
			shouldQueue(
				R("pull_request", {
					action: "synchronize",
					pull_request: { number: 9, user: { login: "alice" } },
					repository,
				}),
			),
		).toBe(false);
	});

	test("incoming PR comment skips", () => {
		const d = R("issue_comment", {
			action: "created",
			comment: { user: { login: "alice" }, body: "ping" },
			issue: { number: 9, user: { login: "contributor" }, pull_request: { url: "x" } },
			repository,
		});
		expect(shouldQueue(d)).toBe(false);
		expect(d.reason).toBe("incoming PR comments ignored");
	});

	test("incoming PR comment with a maintainer mention still skips", () => {
		const d = R("issue_comment", {
			action: "created",
			comment: { user: { login: "can1357" }, author_association: "OWNER", body: "@robomp-bot please re-review" },
			issue: { number: 9, user: { login: "contributor" }, pull_request: { url: "x" } },
			repository,
		});
		expect(shouldQueue(d)).toBe(false);
		expect(d.issue_key).toBe("octo/widget#9");
		expect(d.reason).toBe("incoming PR comments ignored");
	});

	test("review only for bot-authored PR", () => {
		const d = R(
			"pull_request_review_comment",
			{
				action: "created",
				comment: { user: { login: "alice" }, body: "nit" },
				pull_request: { number: 9, user: { login: BOT } },
				repository,
			},
			{ resolveIssueFromPr: toKey42 },
		);
		expect(d).toMatchObject({ decision: "queue", task: "handle_review", issue_key: "octo/widget#42" });
		const notOurs = R("pull_request_review_comment", {
			action: "created",
			comment: { user: { login: "alice" }, body: "nit" },
			pull_request: { number: 9, user: { login: "someone-else" } },
			repository,
		});
		expect(shouldQueue(notOurs)).toBe(false);
	});

	test("review comment falls back to the PR key when the resolver misses", () => {
		const d = R(
			"pull_request_review_comment",
			{
				action: "created",
				comment: { user: { login: "alice" }, body: "nit" },
				pull_request: { number: 9, user: { login: BOT } },
				repository,
			},
			{ resolveIssueFromPr: none },
		);
		expect(d).toMatchObject({
			decision: "queue",
			task: "handle_review",
			submitter: "alice",
			issue_key: "octo/widget#9",
		});
	});

	test("PR closed cleans up any tracked PR", () => {
		const pr: Json = { number: 9, user: { login: "alice" }, merged: false };
		const payload = { action: "closed", pull_request: pr, repository };
		expect(R("pull_request", payload, { resolveIssueFromPr: toKey42 })).toMatchObject({
			decision: "queue",
			task: "cleanup_workspace",
			issue_key: "octo/widget#42",
			reason: "pull_request.closed",
		});
		pr.merged = true;
		expect(R("pull_request", payload, { resolveIssueFromPr: none })).toMatchObject({
			decision: "queue",
			task: "cleanup_workspace",
			issue_key: "octo/widget#9",
			reason: "pull_request.merged",
			submitter: null,
		});
	});

	test("PR merged carries no submitter", () => {
		const d = R(
			"pull_request",
			{ action: "closed", pull_request: { number: 9, user: { login: BOT }, merged: true }, repository },
			{ resolveIssueFromPr: toKey42 },
		);
		expect(shouldQueue(d)).toBe(true);
		expect(d.submitter).toBeNull();
	});
});

describe("rateLimitCap", () => {
	const opts = (unlimited: string[] = []) => ({ unlimited: new Set(unlimited), default: 3, contributor: 10 });
	test("unlimited allowlist beats association", () => {
		expect(rateLimitCap("can1357", "NONE", opts(["can1357"]))).toBeNull();
	});
	test("unlimited is case-insensitive", () => {
		expect(rateLimitCap("Can1357", null, opts(["can1357"]))).toBeNull();
	});
	test.each(["OWNER", "MEMBER", "COLLABORATOR"])("trusted association %p bypasses", assoc => {
		expect(rateLimitCap("stranger", assoc, opts())).toBeNull();
	});
	test("contributor tier", () => {
		expect(rateLimitCap("alice", "CONTRIBUTOR", opts())).toBe(10);
	});
	test.each([null, "NONE", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"])("default tier for %p", assoc => {
		expect(rateLimitCap("alice", assoc, opts())).toBe(3);
	});
});

describe("mentions and maintainers", () => {
	test("extractMention returns the body minus the mention", () => {
		expect(extractMention("hey @robomp-bot please look", "robomp-bot")).toBe("hey please look");
		expect(extractMention("@robomp-bot do X", "robomp-bot")).toBe("do X");
	});
	test.each(["@roboomp", "roboomp[bot]", "@roboomp[bot]"])("accepts prefixed or app bot login %p", login => {
		expect(extractMention("@roboomp go ahead", login)).toBe("go ahead");
	});
	test("strips a literal app suffix from the body", () => {
		expect(extractMention("@roboomp[bot] go ahead", "roboomp[bot]")).toBe("go ahead");
	});
	test("rejects an extended literal app suffix", () => {
		expect(extractMention("@roboomp[bot]-helper go ahead", "roboomp[bot]")).toBeNull();
	});
	test("null without a mention", () => {
		expect(extractMention("hello there", "robomp-bot")).toBeNull();
		expect(extractMention(null, "robomp-bot")).toBeNull();
		expect(extractMention("", "robomp-bot")).toBeNull();
	});
	test("is case-insensitive", () => {
		expect(extractMention("yo @ROBOMP-BOT", "robomp-bot")).toBe("yo");
	});
	test("respects the hyphen word boundary", () => {
		expect(extractMention("@robomp-bot-helper hi", "robomp-bot")).toBeNull();
	});
	test("handles multiple occurrences", () => {
		expect(extractMention("@robomp-bot one, then @robomp-bot two", "robomp-bot")).toBe("one, then two");
	});
	test("isMaintainer recognizes the explicit allowlist", () => {
		expect(isMaintainer("can1357", null, new Set(["can1357"]))).toBe(true);
		expect(isMaintainer("Can1357", "NONE", new Set(["can1357"]))).toBe(true);
	});
	test.each(["OWNER", "MEMBER", "COLLABORATOR"])("isMaintainer recognizes %p", assoc => {
		expect(isMaintainer("anyone", assoc, new Set())).toBe(true);
	});
	test("isMaintainer rejects contributor and none", () => {
		expect(isMaintainer("alice", "CONTRIBUTOR", new Set())).toBe(false);
		expect(isMaintainer("alice", null, new Set())).toBe(false);
		expect(isMaintainer(null, "OWNER", new Set())).toBe(true);
	});
	test("isImplementationAuthorizer accepts allowlist and owner", () => {
		expect(isImplementationAuthorizer("can1357", null, new Set(["can1357"]))).toBe(true);
		expect(isImplementationAuthorizer("Can1357", "NONE", new Set(["can1357"]))).toBe(true);
		expect(isImplementationAuthorizer("stranger", "OWNER", new Set())).toBe(true);
	});
	test.each(["MEMBER", "COLLABORATOR", "NONE", "CONTRIBUTOR", null])(
		"isImplementationAuthorizer rejects %p",
		assoc => {
			expect(isImplementationAuthorizer("stranger", assoc, new Set())).toBe(false);
		},
	);
});

describe("directives", () => {
	const comment = (body: string, extra: Json = {}) => ({
		action: "created",
		comment: { user: { login: "can1357" }, body, ...extra },
		issue: { number: 9 },
		repository,
	});

	test("set on an issue comment when the owner mentions the bot", () => {
		const d = R("issue_comment", comment("@robomp-bot please refactor X", { author_association: "OWNER" }));
		expect(d).toMatchObject({
			decision: "queue",
			directive: true,
			directive_body: "please refactor X",
			directive_author: "can1357",
			directive_authorizes_impl: true,
		});
	});

	test("set when the login is in the maintainers list", () => {
		const d = R("issue_comment", comment("@robomp-bot do it"), { maintainers: new Set(["can1357"]) });
		expect(d).toMatchObject({
			directive: true,
			directive_body: "do it",
			directive_author: "can1357",
			directive_authorizes_impl: true,
		});
	});

	test("authorizes a personal repo owner without author_association", () => {
		const d = route(
			"issue_comment",
			{
				action: "created",
				comment: { user: { login: "can1357" }, body: "@robomp-bot go ahead and push" },
				issue: { number: 9 },
				repository: { full_name: "can1357/widget", owner: { login: "can1357", type: "User" } },
			},
			{ allowlist: new Set(["can1357/widget"]), botLogin: BOT },
		);
		expect(d).toMatchObject({
			directive: true,
			directive_body: "go ahead and push",
			directive_author: "can1357",
			directive_authorizes_impl: true,
			association: "OWNER",
		});
	});

	test("does not authorize an org owner name without author_association", () => {
		const d = R("issue_comment", {
			action: "created",
			comment: { user: { login: "octo" }, body: "@robomp-bot go ahead and push" },
			issue: { number: 9 },
			repository: { full_name: "octo/widget", owner: { login: "octo", type: "Organization" } },
		});
		expect(d.directive).toBe(false);
		expect(d.directive_authorizes_impl).toBe(false);
	});

	test("collaborator directive does not authorize impl", () => {
		const d = R("issue_comment", {
			...comment("@robomp-bot go ahead with the plan", { author_association: "COLLABORATOR" }),
			comment: {
				user: { login: "oldschoola" },
				author_association: "COLLABORATOR",
				body: "@robomp-bot go ahead with the plan",
			},
		});
		expect(d).toMatchObject({
			directive: true,
			directive_body: "go ahead with the plan",
			directive_authorizes_impl: false,
		});
	});

	test("unset for a random user even with a mention", () => {
		const d = R("issue_comment", {
			...comment(""),
			comment: { user: { login: "stranger" }, author_association: "NONE", body: "@robomp-bot please refactor X" },
		});
		expect(shouldQueue(d)).toBe(true);
		expect(d.directive).toBe(false);
		expect(d.directive_body).toBeNull();
	});

	test("unset for a maintainer without a mention", () => {
		expect(R("issue_comment", comment("looks good to me", { author_association: "OWNER" })).directive).toBe(false);
	});

	test("a directive on an incoming PR conversation is ignored", () => {
		const d = R(
			"issue_comment",
			{
				action: "created",
				comment: {
					user: { login: "can1357" },
					author_association: "OWNER",
					body: "@robomp-bot change the indentation in foo.py",
				},
				issue: { number: 50, pull_request: { url: "x" } },
				repository,
			},
			{ resolveIssueFromPr: toKey42 },
		);
		expect(shouldQueue(d)).toBe(false);
		expect(d.reason).toBe("incoming PR comments ignored");
	});

	const reviewComment = (prUser: string, user: Json, body: string) => ({
		action: "created",
		comment: { user, ...(user.type ? {} : { author_association: "OWNER" }), body },
		pull_request: { number: 50, user: { login: prUser } },
		repository,
	});

	test("set on a review comment", () => {
		const d = R(
			"pull_request_review_comment",
			reviewComment(BOT, { login: "can1357" }, "@robomp-bot use a generator here"),
			{ resolveIssueFromPr: toKey42 },
		);
		expect(d).toMatchObject({
			decision: "queue",
			task: "handle_review",
			directive: true,
			directive_body: "use a generator here",
		});
	});

	test("review comment normalizes the bot author suffix", () => {
		const d = R(
			"pull_request_review_comment",
			reviewComment(`${BOT}[bot]`, { login: "can1357" }, "@robomp-bot use a generator here"),
			{ botLogin: `@${BOT}[bot]`, resolveIssueFromPr: toKey42 },
		);
		expect(d).toMatchObject({
			decision: "queue",
			task: "handle_review",
			directive: true,
			directive_body: "use a generator here",
		});
	});

	const codex = new Set(["chatgpt-codex-connector"]);

	test("reviewer bot comment on an incoming PR is ignored", () => {
		const d = R(
			"issue_comment",
			{
				action: "created",
				comment: {
					user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
					body: "Found two issues in the diff: ...",
				},
				issue: { number: 9, pull_request: { url: "x" } },
				repository,
			},
			{ reviewerBots: codex, resolveIssueFromPr: toKey42 },
		);
		expect(shouldQueue(d)).toBe(false);
		expect(d.reason).toBe("incoming PR comments ignored");
	});

	test("reviewer bot review comment is a directive", () => {
		const d = R(
			"pull_request_review_comment",
			reviewComment(BOT, { login: "chatgpt-codex-connector[bot]", type: "Bot" }, "This branch leaks memory."),
			{ reviewerBots: codex, resolveIssueFromPr: toKey42 },
		);
		expect(d).toMatchObject({
			decision: "queue",
			task: "handle_review",
			directive: true,
			directive_body: "This branch leaks memory.",
			directive_author: "chatgpt-codex-connector",
			directive_authorizes_impl: false,
		});
	});

	test("a random bot is still skipped when not in the reviewer list", () => {
		const d = R(
			"issue_comment",
			{
				action: "created",
				comment: { user: { login: "renovate", type: "Bot" }, body: "deps" },
				issue: { number: 9 },
				repository,
			},
			{ reviewerBots: codex },
		);
		expect(shouldQueue(d)).toBe(false);
		expect(d.reason).toContain("bot");
	});

	test("reviewer bot login is case-insensitive for review comments", () => {
		const d = R(
			"pull_request_review_comment",
			{
				action: "created",
				comment: { user: { login: "ChatGPT-Codex-Connector", type: "Bot" }, body: "feedback" },
				pull_request: { number: 9, user: { login: BOT } },
				repository,
			},
			{ reviewerBots: codex, resolveIssueFromPr: toKey42 },
		);
		expect(d.directive).toBe(true);
		expect(d.directive_author).toBe("chatgpt-codex-connector");
	});

	test("strips pragmas from a maintainer comment", () => {
		const d = R(
			"issue_comment",
			comment("@robomp-bot /model gpt /thinking low\nrefactor X", { author_association: "OWNER" }),
		);
		expect(d.directive).toBe(true);
		expect(d.directive_body).toBe("refactor X");
		expect(d.directive_pragmas).toEqual([
			["model", "gpt"],
			["thinking", "low"],
		]);
	});

	test("strips pragmas from a reviewer bot review comment", () => {
		const d = R(
			"pull_request_review_comment",
			{
				action: "created",
				comment: { user: { login: "chatgpt-codex-connector", type: "Bot" }, body: "/model claude\nLeak in foo()" },
				pull_request: { number: 9, user: { login: BOT } },
				repository,
			},
			{ reviewerBots: codex, resolveIssueFromPr: toKey42 },
		);
		expect(d.directive).toBe(true);
		expect(d.directive_body).toBe("Leak in foo()");
		expect(d.directive_pragmas).toEqual([["model", "claude"]]);
	});

	test("a non-directive comment carries no pragmas", () => {
		const d = R("issue_comment", {
			...comment(""),
			comment: { user: { login: "stranger" }, author_association: "NONE", body: "/model gpt\nhello" },
		});
		expect(d.directive).toBe(false);
		expect(d.directive_pragmas).toEqual([]);
	});
});

describe("release workflow", () => {
	const payload = (overrides: { action?: string; repo?: string; message?: string } = {}): Json => ({
		action: overrides.action ?? "completed",
		repository: { full_name: overrides.repo ?? "octo/widget", default_branch: "main" },
		workflow_run: {
			id: 10,
			name: "CI",
			head_branch: "main",
			head_sha: "abc",
			conclusion: "failure",
			head_commit: { message: overrides.message ?? "chore: bump version to 17.2.8" },
		},
	});

	test("completion queues the sentinel", () => {
		expect(R("workflow_run", payload(), { releaseSentinelEnabled: true })).toMatchObject({
			decision: "queue",
			task: "handle_release_ci",
			issue_key: "octo/widget#release",
		});
	});
	test("a bot-sent run still queues", () => {
		const p = payload();
		p.sender = { login: BOT, type: "Bot" };
		(p.workflow_run as Json).actor = { login: BOT, type: "Bot" };
		expect(shouldQueue(R("workflow_run", p, { releaseSentinelEnabled: true }))).toBe(true);
	});
	test("requested is ignored", () => {
		expect(R("workflow_run", payload({ action: "requested" }), { releaseSentinelEnabled: true }).reason).toBe(
			"workflow_run.requested ignored",
		);
	});
	test("a non-release workflow is ignored", () => {
		expect(
			R("workflow_run", payload({ message: "fix(ci): repair tests" }), { releaseSentinelEnabled: true }).reason,
		).toBe("not a release commit");
	});
	test("ignored when the sentinel is disabled", () => {
		expect(R("workflow_run", payload()).reason).toBe("release sentinel disabled");
	});
	test("requires an allowlisted repo", () => {
		expect(R("workflow_run", payload({ repo: "other/repo" }), { releaseSentinelEnabled: true }).reason).toBe(
			"repo not on allowlist",
		);
	});
});
