/** Shared task records (Python `worker.py` dataclasses) used by persona, worker and tasks. */

/** Release verdict and failure context supplied to an agent round. */
export interface ReleaseTaskContext {
	tag: string;
	version: string;
	round: number;
	max_rounds: number;
	head_sha: string;
	default_branch: string;
	failures_text: string;
	run_urls: readonly string[];
}

/** One entry in the conversation a directive carries to the agent. */
export interface ThreadMessage {
	/** issue_body | pr_body | comment | review_comment | review */
	kind: string;
	author: string;
	body: string;
	created_at: string;
	/** review_comment only */
	path?: string | null;
	/** review_comment only */
	line?: number | null;
	/** review only (APPROVED / CHANGES_REQUESTED / COMMENTED) */
	state?: string | null;
}

export function threadMessage(init: ThreadMessage): ThreadMessage {
	return { path: null, line: null, state: null, ...init };
}

/** A maintainer's `@bot` mention captured as an authoritative instruction. */
export interface DirectiveInfo {
	body: string;
	author: string;
	thread: readonly ThreadMessage[];
	pragmas: readonly (readonly [string, string])[];
	authorizes_impl: boolean;
}

export function directiveInfo(init: Pick<DirectiveInfo, "body" | "author"> & Partial<DirectiveInfo>): DirectiveInfo {
	return { thread: [], pragmas: [], authorizes_impl: false, ...init };
}
