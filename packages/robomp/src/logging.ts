/**
 * Logging for roboomp — pretty ANSI to stdout, JSON lines to a rotating file.
 *
 * Mirrors the Python `logging_config` contract: the file is
 * `<log_dir>/robomp.log.jsonl` (10 MiB x 5 backups), one JSON object per line
 * with `ts`/`level`/`logger`/`msg`, optional `exc`, plus flattened extras.
 * `/api/logs` tails that file, so its shape is a wire contract.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
const LEVEL_NO: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };

export interface LogRecord {
	created: number;
	level: LogLevel;
	logger: string;
	msg: string;
	extra: Record<string, unknown>;
	exc?: string;
}

export type LogHandler = (record: LogRecord) => void;

const RST = "\x1b[0m";
const DIM = "\x1b[2m";
const LEVEL_COLOR: Record<LogLevel, string> = {
	DEBUG: "\x1b[34m",
	INFO: "\x1b[32m",
	WARNING: "\x1b[33m",
	ERROR: "\x1b[31m",
	CRITICAL: "\x1b[1;31m",
};

const LOG_FILE_NAME = "robomp.log.jsonl";
const MAX_BYTES = 10 * 1024 * 1024;
const BACKUP_COUNT = 5;

let rootLevel = LEVEL_NO.INFO;
const handlers: LogHandler[] = [];
let initialized = false;
const loggerLevels = new Map<string, number>();

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function isoSeconds(created: number): string {
	return `${new Date(created).toISOString().slice(0, 19)}Z`;
}

export function formatException(err: unknown): string {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	return String(err);
}

function safeJsonValue(value: unknown): unknown {
	try {
		JSON.stringify(value);
		return value;
	} catch {
		return String(value);
	}
}

export function formatJsonRecord(record: LogRecord): string {
	const payload: Record<string, unknown> = {
		ts: isoSeconds(record.created),
		level: record.level,
		logger: record.logger,
		msg: record.msg,
	};
	if (record.exc) payload.exc = record.exc;
	for (const [key, value] of Object.entries(record.extra)) {
		if (key.startsWith("_") || key in payload) continue;
		payload[key] = safeJsonValue(value);
	}
	return JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function formatPrettyRecord(record: LogRecord): string {
	const ts = new Date(record.created).toISOString().slice(11, 19);
	const level = `${LEVEL_COLOR[record.level]}${pad(record.level, 8)}${RST}`;
	const name = record.logger.startsWith("robomp.") ? record.logger.slice("robomp.".length) : record.logger;
	const extras = Object.entries(record.extra)
		.filter(([key]) => !key.startsWith("_"))
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	let line = `${DIM}${ts}${RST}  ${level}  ${DIM}${pad(name, 22)}${RST}  ${record.msg}`;
	if (extras.length > 0) line += `  ${DIM}${extras.join(" ")}${RST}`;
	if (record.exc) line += `\n${record.exc}`;
	return line;
}

class RotatingFileSink {
	readonly #file: string;
	#size: number;
	constructor(dir: string) {
		fs.mkdirSync(dir, { recursive: true });
		this.#file = path.join(dir, LOG_FILE_NAME);
		try {
			this.#size = fs.statSync(this.#file).size;
		} catch {
			this.#size = 0;
		}
	}
	write(line: string): void {
		const data = `${line}\n`;
		const bytes = Buffer.byteLength(data);
		if (this.#size > 0 && this.#size + bytes > MAX_BYTES) this.#rotate();
		fs.appendFileSync(this.#file, data);
		this.#size += bytes;
	}
	#rotate(): void {
		for (let i = BACKUP_COUNT - 1; i >= 1; i--) {
			const src = `${this.#file}.${i}`;
			if (fs.existsSync(src)) fs.renameSync(src, `${this.#file}.${i + 1}`);
		}
		if (fs.existsSync(this.#file)) fs.renameSync(this.#file, `${this.#file}.1`);
		this.#size = 0;
	}
}

function emit(record: LogRecord): void {
	for (const handler of handlers) {
		try {
			handler(record);
		} catch {
			// A broken sink must never take the caller down.
		}
	}
}

function effectiveLevel(name: string): number {
	let cursor = name;
	while (cursor) {
		const level = loggerLevels.get(cursor);
		if (level !== undefined) return level;
		const dot = cursor.lastIndexOf(".");
		if (dot < 0) break;
		cursor = cursor.slice(0, dot);
	}
	return rootLevel;
}

export class Logger {
	constructor(readonly name: string) {}

	isEnabledFor(level: LogLevel): boolean {
		return LEVEL_NO[level] >= effectiveLevel(this.name);
	}

	log(level: LogLevel, msg: string, extra: Record<string, unknown> = {}, err?: unknown): void {
		if (!this.isEnabledFor(level)) return;
		emit({
			created: Date.now(),
			level,
			logger: this.name,
			msg,
			extra,
			exc: err === undefined ? undefined : formatException(err),
		});
	}

	debug(msg: string, extra?: Record<string, unknown>): void {
		this.log("DEBUG", msg, extra);
	}
	info(msg: string, extra?: Record<string, unknown>): void {
		this.log("INFO", msg, extra);
	}
	warning(msg: string, extra?: Record<string, unknown>, err?: unknown): void {
		this.log("WARNING", msg, extra, err);
	}
	error(msg: string, extra?: Record<string, unknown>, err?: unknown): void {
		this.log("ERROR", msg, extra, err);
	}
	/** ERROR with the exception's stack attached (Python `log.exception`). */
	exception(msg: string, err: unknown, extra?: Record<string, unknown>): void {
		this.log("ERROR", msg, extra, err);
	}
}

const loggers = new Map<string, Logger>();

export function getLogger(name: string): Logger {
	let logger = loggers.get(name);
	if (!logger) {
		logger = new Logger(name);
		loggers.set(name, logger);
	}
	return logger;
}

export function setLoggerLevel(name: string, level: LogLevel): void {
	loggerLevels.set(name, LEVEL_NO[level]);
}

/** Register an extra sink; returns a disposer. Used by tests to capture records. */
export function addLogHandler(handler: LogHandler): () => void {
	handlers.push(handler);
	return () => {
		const idx = handlers.indexOf(handler);
		if (idx >= 0) handlers.splice(idx, 1);
	};
}

/** Idempotently configure logging: pretty ANSI to stdout, JSON to file. */
export function configureLogging(logDir?: string, level: LogLevel = "INFO"): void {
	if (initialized) return;
	rootLevel = LEVEL_NO[level];
	handlers.length = 0;
	handlers.push(record => {
		process.stdout.write(`${formatPrettyRecord(record)}\n`);
	});
	if (logDir !== undefined) {
		const sink = new RotatingFileSink(logDir);
		handlers.push(record => sink.write(formatJsonRecord(record)));
	}
	initialized = true;
}

export function resetLoggingForTests(): void {
	initialized = false;
	handlers.length = 0;
	rootLevel = LEVEL_NO.INFO;
	loggerLevels.clear();
}
