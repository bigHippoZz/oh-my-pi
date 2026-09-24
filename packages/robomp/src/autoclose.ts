/**
 * Background scheduler that closes question issues after a quiet window.
 *
 * Driven by `pending_closures` rows: the bot's question answer inserts a row;
 * webhook activity cancels it; this loop atomically claims due rows, checks
 * for a 👎 from the issue's original author on the watched comment, and either
 * cancels or closes the issue with `state_reason=completed`. The loop is the
 * only writer of terminal states for rows it has claimed.
 */
import { PeriodicLoop } from "./background";
import type { Settings } from "./config";
import { type Database, type PendingClosureRow, utcNow } from "./db";
import type { GitHubBackend } from "./github-backend";
import { GitHubError } from "./github-client";
import { getLogger } from "./logging";

const log = getLogger("robomp.autoclose");

export type AutocloseOutcome = "closed" | "cancelled" | "retried";

type AutocloseSettings = Pick<
	Settings,
	"question_autoclose_enabled" | "question_autoclose_hours" | "question_autoclose_scan_seconds"
>;

/** Long-lived loop that closes due `pending_closures` rows. */
export class AutocloseScheduler {
	readonly #settings: AutocloseSettings;
	readonly #db: Database;
	readonly #github: Pick<GitHubBackend, "listCommentReactions" | "closeIssue">;
	readonly #loop: PeriodicLoop;

	constructor(args: {
		settings: AutocloseSettings;
		db: Database;
		github: Pick<GitHubBackend, "listCommentReactions" | "closeIssue">;
	}) {
		this.#settings = args.settings;
		this.#db = args.db;
		this.#github = args.github;
		this.#loop = new PeriodicLoop(
			"autoclose-scheduler",
			() => this.#settings.question_autoclose_scan_seconds,
			async () => {
				await this.tick();
			},
			{ errorMessage: "autoclose tick failed", loggerName: "robomp.autoclose" },
		);
	}

	get enabled(): boolean {
		return (
			this.#settings.question_autoclose_enabled &&
			this.#settings.question_autoclose_hours > 0 &&
			this.#settings.question_autoclose_scan_seconds > 0
		);
	}

	get running(): boolean {
		return this.#loop.running;
	}

	/** Spawn the background loop. No-op when the feature is disabled. */
	async start(): Promise<void> {
		if (!this.enabled) {
			log.info("autoclose disabled", {
				enabled: this.#settings.question_autoclose_enabled,
				hours: this.#settings.question_autoclose_hours,
			});
			return;
		}
		if (this.#loop.running) return;
		this.#loop.start();
		log.info("autoclose started", {
			scan_seconds: this.#settings.question_autoclose_scan_seconds,
			hours: this.#settings.question_autoclose_hours,
		});
	}

	stop(): Promise<void> {
		return this.#loop.stop();
	}

	/** Process all due rows; returns closed/cancelled/retried counts. */
	async tick(): Promise<Record<AutocloseOutcome, number>> {
		const rows = this.#db.claimDueClosures({ now: utcNow() });
		const counts: Record<AutocloseOutcome, number> = { closed: 0, cancelled: 0, retried: 0 };
		for (const row of rows) counts[await this.#processRow(row)] += 1;
		if (rows.length > 0) log.info("autoclose tick", { ...counts, total: rows.length });
		return counts;
	}

	async #processRow(row: PendingClosureRow): Promise<AutocloseOutcome> {
		let reactions: Awaited<ReturnType<GitHubBackend["listCommentReactions"]>>;
		try {
			reactions = await this.#github.listCommentReactions(row.repo, row.comment_id);
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			log.warning("autoclose: list_comment_reactions failed; will retry", {
				issue_key: row.issue_key,
				status: err.status,
				gh_message: err.detail,
			});
			this.#db.requeueClaimedClosure(row.issue_key);
			return "retried";
		}
		const author = row.issue_author.toLowerCase();
		if (reactions.some(r => r.content === "-1" && r.user_login.toLowerCase() === author)) {
			this.#db.finalizeClosure(row.issue_key, { state: "cancelled", reason: "author_downvoted" });
			log.info("autoclose cancelled by author 👎", { issue_key: row.issue_key, comment_id: row.comment_id });
			return "cancelled";
		}
		try {
			await this.#github.closeIssue(row.repo, row.number, "completed");
		} catch (err) {
			if (!(err instanceof GitHubError)) throw err;
			if (err.status === 404) {
				this.#db.finalizeClosure(row.issue_key, { state: "cancelled", reason: "already_closed" });
				log.info("autoclose: issue already gone", { issue_key: row.issue_key });
				return "cancelled";
			}
			log.warning("autoclose: close_issue failed; will retry", {
				issue_key: row.issue_key,
				status: err.status,
				gh_message: err.detail,
			});
			this.#db.requeueClaimedClosure(row.issue_key);
			return "retried";
		}
		this.#db.finalizeClosure(row.issue_key, { state: "closed", reason: null });
		log.info("autoclose closed issue", { issue_key: row.issue_key, number: row.number });
		return "closed";
	}
}
