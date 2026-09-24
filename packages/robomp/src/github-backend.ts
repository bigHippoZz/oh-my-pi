/**
 * Structural interface shared by `GitHubClient` and `GitHubProxyClient`.
 *
 * Callers (worker, host tools, tasks, server, CLI) reference `GitHubBackend`
 * so they accept either the direct PAT-bearing REST client or the HMAC-RPC
 * proxy client. Both return the same typed records from `github-client`.
 */
import type {
	CommentInfo,
	IssueIndexEntry,
	IssueInfo,
	IssueSummary,
	Json,
	PullRequestFileInfo,
	PullRequestInfo,
	PullRequestReviewInfo,
	ReactionInfo,
	ReleaseInfo,
	RepoInfo,
	ReviewCommentInfo,
	WorkflowJobInfo,
	WorkflowRunInfo,
} from "./github-client";

export interface GitHubBackend {
	// ---- reads ----
	getRepo(repo: string): Promise<RepoInfo>;
	listWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRunInfo[]>;
	listWorkflowJobs(repo: string, runId: number): Promise<WorkflowJobInfo[]>;
	getJobLogTail(repo: string, jobId: number, tailLines?: number): Promise<string>;
	getTagSha(repo: string, tag: string): Promise<string | null>;
	getReleaseByTag(repo: string, tag: string): Promise<ReleaseInfo | null>;
	getIssue(repo: string, number: number): Promise<IssueInfo>;
	listClosingPullRequests(repo: string, number: number): Promise<number[]>;
	getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
	listPrFiles(repo: string, prNumber: number): Promise<PullRequestFileInfo[]>;
	listIssues(repo: string, options?: { state?: string; limit?: number }): Promise<IssueSummary[]>;
	searchIssues(repo: string, query: string, limit?: number): Promise<IssueSummary[]>;
	listIssueIndexEntries(
		repo: string,
		options?: { since?: string | null; page?: number; per_page?: number },
	): Promise<IssueIndexEntry[]>;
	listComments(repo: string, number: number): Promise<CommentInfo[]>;
	listReviewComments(repo: string, prNumber: number): Promise<ReviewCommentInfo[]>;
	listPrReviews(repo: string, prNumber: number): Promise<PullRequestReviewInfo[]>;
	getAuthenticatedLogin(): Promise<string>;

	// ---- writes ----
	postComment(repo: string, number: number, body: string): Promise<CommentInfo>;
	openPullRequest(args: {
		repo: string;
		head: string;
		base: string;
		title: string;
		body: string;
		draft?: boolean;
		maintainer_can_modify?: boolean;
	}): Promise<PullRequestInfo>;
	requestReviewers(args: {
		repo: string;
		pr_number: number;
		reviewers?: string[] | null;
		team_reviewers?: string[] | null;
	}): Promise<void>;
	addIssueLabels(repo: string, number: number, labels: string[]): Promise<string[]>;
	removeIssueLabel(repo: string, number: number, label: string): Promise<void>;
	submitPrReview(args: {
		repo: string;
		pr_number: number;
		body: string;
		event: string;
		comments: readonly Json[];
		commit_id?: string | null;
	}): Promise<PullRequestReviewInfo>;
	addAssignees(repo: string, number: number, assignees: string[]): Promise<void>;
	listCommentReactions(repo: string, commentId: number): Promise<ReactionInfo[]>;
	closeIssue(repo: string, number: number, reason?: string): Promise<void>;
}
