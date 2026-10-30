"use strict";

/**
 * Abito continuous conversation rotation by summary (#386).
 *
 * When the engine session approaches its context budget, the daemon rotates
 * to a fresh session (`new_session`) and keeps a bounded, deterministic
 * summary of the previous conversation pending; the summary is prepended to
 * the user's NEXT prompt (never a daemon-issued model request: rotation is
 * `get_session_stats` + `get_messages` + `new_session` only) and cleared once
 * sent. A failed summary keeps the old session instead of losing history.
 *
 * Bounds: the summary always retains the last `keepTurns` turns (per-message
 * truncation only); older turns are dropped first while a total character cap
 * holds. Everything is deterministic: same messages in, same summary out.
 */

const { EventEmitter } = require("node:events");

const DEFAULT_THRESHOLD_PERCENT = 85;
const DEFAULT_KEEP_TURNS = 12;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 1200;
// Worst case for the retained last N turns is keepTurns * (maxCharsPerMessage
// + role marker); the total cap only ever trims turns OLDER than those.
const DEFAULT_MAX_CHARS = 20_000;

const USER_MARK = "[usuario]";
const ASSISTANT_MARK = "[asistente]";
const DROPPED_MARK = "(Se omitieron";
const TRUNCATION_MARK = "…";

function positiveInt(value, fallback, max = 1_048_576) {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("invalid rotation bound");
	return value;
}

/** Extracts the visible text of one Pi message content (string or block array). */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Groups messages into turns: a turn starts at a user message; assistant messages join it. */
function groupTurns(messages) {
	const turns = [];
	let open = undefined;
	for (const message of messages ?? []) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			open = { parts: [{ role: "user", text: contentText(message.content) }] };
			turns.push(open);
		} else if (message.role === "assistant") {
			const part = { role: "assistant", text: contentText(message.content) };
			if (!open) {
				open = { parts: [part] };
				turns.push(open);
			} else {
				open.parts.push(part);
			}
		}
		// Every other role (toolResult, bashExecution, custom, …) stays out of the summary.
	}
	return turns.filter((turn) => turn.parts.some((part) => part.text.trim() !== ""));
}

/**
 * Deterministic, bounded summary text over Pi `get_messages` messages.
 * Returns "" when there is nothing to summarize.
 */
function buildSummary(messages, options = {}) {
	const keepTurns = positiveInt(options.keepTurns, DEFAULT_KEEP_TURNS, 100);
	const maxCharsPerMessage = positiveInt(options.maxCharsPerMessage, DEFAULT_MAX_CHARS_PER_MESSAGE);
	const maxChars = positiveInt(options.maxChars, DEFAULT_MAX_CHARS);
	const truncate = (text) => (text.length > maxCharsPerMessage ? `${text.slice(0, Math.max(1, maxCharsPerMessage - 1))}${TRUNCATION_MARK}` : text);
	const render = (turn) => turn.parts
		.map((part) => `${part.role === "user" ? USER_MARK : ASSISTANT_MARK} ${truncate(part.text)}`)
		.join("\n");

	const turns = groupTurns(messages);
	if (turns.length === 0) return "";
	// The last keepTurns turns are NEVER dropped: the total cap only trims older ones.
	const recent = turns.slice(-keepTurns);
	const older = turns.slice(0, turns.length - recent.length);
	const keptOlder = [];
	let used = 0;
	for (let index = older.length - 1; index >= 0; index--) {
		const text = render(older[index]);
		if (used + text.length + 2 > maxChars) break;
		keptOlder.unshift(text);
		used += text.length + 2;
	}
	const omitted = older.length - keptOlder.length;
	const header = omitted > 0 ? `${DROPPED_MARK} ${omitted} turnos anteriores de la conversación.)\n\n` : "";
	return `${header}${[...keptOlder, ...recent.map(render)].join("\n\n")}`;
}

/** User-visible framing for a pending summary prepended to the next prompt (Spanish). */
function frameSummary(summary) {
	return `[Resumen de la conversación anterior (rotada automáticamente por límite de contexto)]\n${summary}\n[Fin del resumen. Debajo va tu mensaje actual.]\n\n`;
}

/**
 * Watches the engine and rotates the conversation when the context budget
 * runs low. Construct with an AgentEngine; call `stop()` to detach.
 *
 * Guarantees:
 * - rotation issues NO prompt: `get_session_stats` → `get_messages` →
 *   `new_session`; the summary travels to the model only inside the user's
 *   next prompt (`decoratePrompt`);
 * - any summary failure (request error, unexpected shape, empty result)
 *   aborts the rotation and keeps the old session;
 * - skipped while the engine is busy, not ready, paused (`isPaused`), while a
 *   summary is still pending (never overwritten), and for a session that was
 *   already rotated (loop protection).
 */
class SessionRotator extends EventEmitter {
	constructor(options = {}) {
		super();
		this.engine = options.engine;
		this.log = options.log ?? (() => {});
		this.isPaused = options.isPaused ?? (() => false);
		this.thresholdPercent = positiveInt(options.thresholdPercent, DEFAULT_THRESHOLD_PERCENT, 100);
		this.keepTurns = positiveInt(options.keepTurns, DEFAULT_KEEP_TURNS, 100);
		this.maxCharsPerMessage = positiveInt(options.maxCharsPerMessage, DEFAULT_MAX_CHARS_PER_MESSAGE);
		this.maxChars = positiveInt(options.maxChars, DEFAULT_MAX_CHARS);
		this.pendingSummary = undefined;
		this.lastRotatedSessionFile = undefined;
		this.rotating = undefined;
		this.onSettled = () => this.scheduleCheck();
		this.engine.on?.("event", this.onSettled);
	}

	stop() {
		this.engine.off?.("event", this.onSettled);
	}

	/** Fires after every settled turn; failures are logged, never thrown. */
	scheduleCheck() {
		this.rotateOnce().then((result) => {
			if (result.rotated) this.emit("rotation", result);
		}).catch((error) => this.log(`rotation check failed: ${error.message}`));
	}

	/**
	 * One bounded rotation attempt. Resolves `{rotated, reason, ...}` and never
	 * rejects: every refusal or failure is reported as a reason instead.
	 */
	async rotateOnce() {
		if (this.engine.status !== "ready") return { rotated: false, reason: "not_ready" };
		if (this.isPaused() === true) return { rotated: false, reason: "paused" };
		if (this.engine.busy) return { rotated: false, reason: "busy" };
		if (this.pendingSummary !== undefined) return { rotated: false, reason: "pending_summary" };
		if (this.engine.sessionFile !== undefined && this.engine.sessionFile === this.lastRotatedSessionFile) {
			return { rotated: false, reason: "already_rotated" };
		}
		const run = this.rotating ?? this.performRotation();
		this.rotating = run.then(() => {}, () => {});
		try {
			return await run;
		} finally {
			if (this.rotating !== undefined && this.rotating === undefined) this.rotating = undefined;
			this.rotating = undefined;
		}
	}

	async performRotation() {
		const stats = await this.engine.request({ type: "get_session_stats" });
		const usage = stats?.data?.contextUsage;
		// Missing/null usage (no model, or right after a compaction) never rotates.
		if (!usage || typeof usage.percent !== "number") return { rotated: false, reason: "no_usage" };
		if (usage.percent < this.thresholdPercent) return { rotated: false, reason: "below_threshold" };

		let summary;
		try {
			const messages = await this.engine.request({ type: "get_messages" });
			const list = messages?.data?.messages;
			if (!Array.isArray(list)) return { rotated: false, reason: "bad_messages" };
			summary = buildSummary(list, {
				keepTurns: this.keepTurns,
				maxCharsPerMessage: this.maxCharsPerMessage,
				maxChars: this.maxChars,
			});
		} catch (error) {
			// Summary failure keeps the old session: rotation is aborted, history intact.
			this.log(`rotation aborted, summary failed: ${error.message}`);
			return { rotated: false, reason: "summary_failed" };
		}
		if (summary === "") return { rotated: false, reason: "empty_summary" };

		// Store the summary only after every fallible summary step succeeded;
		// a failed new_session below leaves nothing pending.
		const previousSessionFile = this.engine.sessionFile;
		try {
			await this.engine.request({ type: "new_session" });
		} catch (error) {
			// The engine's changeSession recovery reopens the previous session.
			this.log(`rotation aborted, new_session failed: ${error.message}`);
			return { rotated: false, reason: "new_session_failed" };
		}
		this.pendingSummary = summary;
		this.lastRotatedSessionFile = this.engine.sessionFile;
		this.log(`conversation rotated at ${usage.percent}% context (${previousSessionFile ?? "?"} -> ${this.engine.sessionFile ?? "?"}); summary is pending for the next prompt`);
		return {
			rotated: true, reason: "rotated", percent: usage.percent,
			summaryChars: summary.length, from: previousSessionFile, to: this.engine.sessionFile,
		};
	}

	/**
	 * Prepends the pending summary to the user's message and clears it (sent
	 * exactly once). Without a pending summary the message is returned as-is.
	 */
	decoratePrompt(message) {
		if (this.pendingSummary === undefined) return message;
		const framed = `${frameSummary(this.pendingSummary)}${message}`;
		this.pendingSummary = undefined;
		return framed;
	}

	/**
	 * Transactional variant (R6): peeks the pending summary without clearing it.
	 * `commit()` clears it once the engine accepted the prompt; if the request
	 * fails nothing is lost and the next prompt still carries the summary.
	 * @returns {{message:string, commit:()=>void}}
	 */
	beginPrompt(message) {
		const summary = this.pendingSummary;
		if (summary === undefined) return { message, commit() {} };
		return {
			message: `${frameSummary(summary)}${message}`,
			commit: () => { if (this.pendingSummary === summary) this.pendingSummary = undefined; },
		};
	}

	/** Drops an undelivered pending summary (e.g. the user started a new conversation). */
	discardPending() {
		this.pendingSummary = undefined;
	}
}

module.exports = { DEFAULT_KEEP_TURNS, DEFAULT_THRESHOLD_PERCENT, SessionRotator, buildSummary, frameSummary };
