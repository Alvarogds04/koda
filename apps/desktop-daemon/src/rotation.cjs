"use strict";

/**
 * K2-05 T3 (S2) — Abito transparent session rotation.
 *
 * Port of Gentle Dot's packages/daemon/src/rotation.ts (MIT; see
 * THIRD-PARTY-NOTICES.md). When the open session file passes the size or
 * compaction limits, the daemon writes a NEW session file seeded with ONE
 * hidden custom message (`custom_message`, customType "abito.handoff",
 * display:false) carrying the earlier conversation, switches the engine to it
 * with `switch_session`, and verifies the handoff reached the engine's
 * context. The chat stays ONE continuous conversation: the island never sees a
 * frame, a summary, or an extra user message (unlike #386's visible Spanish
 * frame prepended to the next prompt — that mechanism is gone).
 *
 * Bounds (env/config overridable, like Gentle Dot's GENTLE_DOT_ROTATE_*):
 * default 20 MB per session file or 10 compactions; the handoff keeps the
 * latest engine compaction summary, or — before any compaction — the previous
 * handoff plus the last 12 user/assistant messages truncated at 2000 chars.
 *
 * Everything the rotation touches is deterministic and fail-closed: a failed
 * seed write, switch, or verification leaves the chat in the current session
 * (the engine's own recovery reopens the previous session), and a session
 * header whose format version is not the engine's own skips the rotation.
 */

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** When the open session is replaced: past this file size or this many compactions. */
const DEFAULT_ROTATION = Object.freeze({ bytes: 20 * 1024 * 1024, compactions: 10 });

/** `customType` of the hidden message that carries the earlier session into the new one. */
const HANDOFF_TYPE = "abito.handoff";

/**
 * The engine's session format: `CURRENT_SESSION_VERSION` in pi-coding-agent
 * 1.0.4 through 1.4.0 (verified against the real 1.4.0 source,
 * dist/core/session-manager.js). Any other version on disk fails closed: the
 * rotation is skipped and logged.
 */
const SESSION_VERSION = 3;
const RECENT_MESSAGES = 12;
const MESSAGE_CHARS = 2000;
const HANDOFF_INTRO =
	"This conversation continues from an earlier session that grew too long. The user sees one continuous chat and cannot see this note; carry on naturally and do not mention it.";

const intFromEnv = (value) => {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/**
 * Rotation limits: the ABITO_ROTATE_* environment wins over the config values,
 * the config wins over the defaults (an invalid value never wins, like Gentle
 * Dot's GENTLE_DOT_ROTATE_*).
 */
function rotationLimits(env = process.env, config = {}) {
	return {
		bytes: intFromEnv(env.ABITO_ROTATE_BYTES) ?? config.bytes ?? DEFAULT_ROTATION.bytes,
		compactions: intFromEnv(env.ABITO_ROTATE_COMPACTIONS) ?? config.compactions ?? DEFAULT_ROTATION.compactions,
	};
}

/** The JSON lines of one session file whose text carries `mark`; torn lines are skipped. */
function entries(file, mark) {
	const found = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes(mark)) continue;
		try {
			found.push(JSON.parse(line));
		} catch {
			// A torn line is skipped.
		}
	}
	return found;
}

/**
 * What the new session needs to know: the latest compaction summary (the
 * engine already wrote it, so no extra model call), or, before any
 * compaction, the previous handoff plus the last messages.
 */
function handoffText(file) {
	const summary = entries(file, '"compaction"')
		.filter((e) => e.type === "compaction" && typeof e.summary === "string")
		.at(-1)?.summary;
	if (typeof summary === "string") return `${HANDOFF_INTRO}\n\nSummary of the conversation so far:\n\n${summary}`;
	const previous = entries(file, HANDOFF_TYPE)
		.filter((e) => e.type === "custom_message" && e.customType === HANDOFF_TYPE)
		.at(-1);
	const recent = sessionMessages(file)
		.flatMap((raw) => {
			const message = raw ?? {};
			if (message.role !== "user" && message.role !== "assistant") return [];
			const text = textOf(message).trim();
			const who = message.role === "user" ? "User" : "Assistant";
			return text ? [`${who}: ${text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text}`] : [];
		})
		.slice(-RECENT_MESSAGES);
	const earlier = previous ? textOf(previous).replace(HANDOFF_INTRO, "").trim() : "";
	return [
		HANDOFF_INTRO,
		earlier ? `Earlier context:\n\n${earlier}` : "",
		recent.length > 0 ? `The latest messages:\n\n${recent.join("\n\n")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** The `type:"message"` records of one session file, in order; context-only entries are not messages. */
function sessionMessages(file) {
	if (!fs.existsSync(file)) return [];
	const messages = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"message"')) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) messages.push(entry.message);
		} catch {
			// A torn last line while the engine writes; it is read again next time.
		}
	}
	return messages;
}

/** Plain text of a message whose content is a string or an array of content blocks. */
function textOf(item) {
	if (!item || typeof item !== "object") return "";
	const content = item.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (block && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("");
}

/** The open session is over one of the limits; an absent file never is. */
function overLimits(file, limits, rotator) {
	let stats;
	try {
		stats = fs.statSync(file);
	} catch {
		return false;
	}
	return stats.size >= limits.bytes || rotator.compactionsIn(file, stats.size) >= limits.compactions;
}

/** The header's format version, `undefined` when the file holds no parseable header yet. */
function headerVersion(file) {
	try {
		const first = fs.readFileSync(file, "utf8").split("\n")[0];
		const header = JSON.parse(first);
		if (header?.type !== "session") return undefined;
		return typeof header.version === "number" ? header.version : null;
	} catch {
		return undefined;
	}
}

/**
 * Writes a new session next to `previousFile` holding only the handoff, as a
 * hidden custom message: the engine sends it to the model as context, and its
 * history never shows it. Field names, ids, and the file name follow what the
 * engine writes itself (pi-coding-agent 1.4.0
 * `dist/core/session-manager.js`: header 695-706, file name 711-713, custom
 * message 947-958, entry ids 15-29). The seed carries `parentSession`, so the
 * files stay linked and history keeps reading across the rotation.
 */
async function writeHandoffSession(previousFile, text, cwd = process.cwd()) {
	const id = randomUUID();
	const timestamp = new Date().toISOString();
	let previousCwd;
	try {
		previousCwd = entries(previousFile, '"session"')[0]?.cwd;
	} catch {
		previousCwd = undefined;
	}
	const header = {
		type: "session",
		version: SESSION_VERSION,
		id,
		timestamp,
		cwd: typeof previousCwd === "string" ? previousCwd : cwd,
		parentSession: previousFile,
	};
	const handoff = {
		type: "custom_message",
		customType: HANDOFF_TYPE,
		content: text,
		display: false,
		id: randomUUID().slice(0, 8),
		parentId: null,
		timestamp,
	};
	const file = path.join(path.dirname(previousFile), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(handoff)}\n`, { flag: "wx", mode: 0o600 });
	return file;
}

/**
 * Replaces the open session with a fresh one seeded with a handoff once the
 * session file grows too large or holds too many compactions. The chat stays
 * one: the daemon links the files (engine `previousSessions`/state.json and
 * the seed's own `parentSession`), and history keeps reading across them.
 *
 * Triggered by the daemon after every settled turn; `canRotate()` must hold
 * (nothing paused, nothing on its way). Every failure — a seed write, the
 * switch, or the verification — reports `false` and leaves the chat where it
 * was; no data is ever lost.
 */
class SessionRotator {
	/**
	 * @param {object} engine the AgentEngine (sessionFile, request, status, busy, previousSessions, linkSessions)
	 * @param {object} options limits (bytes/compactions), canRotate, cwd, log
	 */
	constructor(engine, options = {}) {
		this.engine = engine;
		this.limits = options.limits ?? DEFAULT_ROTATION;
		/** True while the island is not paused and nothing else forbids a rotation. */
		this.canRotate = options.canRotate ?? (() => true);
		this.cwd = options.cwd;
		this.log = options.log ?? (() => {});
		this.rotating = false;
		/** Compactions counted so far in one file, read incrementally. */
		this.counted = { file: "", offset: 0, count: 0, rest: "" };
		// After every settled turn: replace an oversized session while the chat is idle.
		this.onSettled = (event) => {
			if (event?.type !== "agent_settled") return;
			void this.maybeRotate().catch((error) => this.log(`rotation check failed: ${error.message}`));
		};
		engine.on?.("event", this.onSettled);
	}

	stop() {
		this.engine.off?.("event", this.onSettled);
	}

	/** Rotates when the open session is over a limit and the chat is idle; true when it did. */
	async maybeRotate() {
		if (this.rotating || !this.canRotate()) return false;
		const file = this.engine.sessionFile;
		if (!file) return false;
		const over = overLimits(file, this.limits, this);
		if (!over) return false;
		this.rotating = true;
		try {
			// The settle trigger fires while other listeners may already be running;
			// never rotate under a running turn, a session change, or a pause.
			if (this.engine.status !== "ready" || this.engine.busy || !this.canRotate()) return false;
			return await this.rotate(file);
		} catch (error) {
			this.log(`rotation failed, the chat stays in ${file}: ${error.message}`);
			return false;
		} finally {
			this.rotating = false;
		}
	}

	async rotate(file) {
		// Fail closed on session-format drift: the engine's own files are version
		// 3 in pi-coding-agent 1.0.4-1.4.0; anything else on disk is not touched.
		const version = headerVersion(file);
		if (version !== undefined && version !== SESSION_VERSION) {
			this.log(`rotation skipped, the chat stays in ${file}: its session format is version ${version}, not ${SESSION_VERSION}`);
			return false;
		}
		const previous = [...(this.engine.previousSessions ?? []), file];
		let seed;
		try {
			seed = await writeHandoffSession(file, handoffText(file), this.cwd);
		} catch (error) {
			this.log(`rotation skipped, the chat stays in ${file}: ${error.message}`);
			return false;
		}
		// Link before switching: whatever happens below, a chat that ends up in
		// the seed keeps its chain (Gentle Dot links first for the same reason).
		this.engine.linkSessions?.(seed, previous);
		try {
			await this.engine.request({ type: "switch_session", sessionPath: seed });
			await this.verify(seed);
		} catch (error) {
			// The engine's session format may have drifted; never leave the user
			// without their conversation. Stay: a failed switch already put the
			// engine on its own recovery path back to the previous session, and a
			// failed verification switches back explicitly.
			this.log(`rotation aborted, the chat stays in ${file}: ${error.message}`);
			await this.stayIn(file);
			return false;
		}
		this.log(`rotation: the chat continues in ${seed}`);
		return true;
	}

	/** The engine opened the handoff session and its context holds the handoff. */
	async verify(seed) {
		if (this.engine.sessionFile !== seed) {
			throw new Error(`the engine opened ${this.engine.sessionFile ?? "no session"}`);
		}
		const response = await this.engine.request({ type: "get_messages" });
		const messages = response?.data?.messages;
		if (!Array.isArray(messages) || !messages.some((m) => m && m.customType === HANDOFF_TYPE)) {
			throw new Error("the handoff is missing from its context");
		}
	}

	/** Best effort: the current session is the one the chat came from. */
	async stayIn(file) {
		if (this.engine.sessionFile === file) return;
		try {
			await this.engine.request({ type: "switch_session", sessionPath: file });
		} catch (error) {
			this.log(`rotation: could not switch back to ${file} (${error.message}); the engine's own recovery owns the session`);
		}
	}

	/** Compaction entries counted incrementally: only the bytes past the last read are scanned. */
	compactionsIn(file, size) {
		if (this.counted.file !== file || size < this.counted.offset) {
			this.counted = { file, offset: 0, count: 0, rest: "" };
		}
		if (size > this.counted.offset) {
			const buffer = Buffer.alloc(size - this.counted.offset);
			let fd;
			try {
				fd = fs.openSync(file, "r");
				fs.readSync(fd, buffer, 0, buffer.length, this.counted.offset);
			} catch (error) {
				this.counted = { file, offset: 0, count: 0, rest: "" };
				// An unreadable file counts as no compactions: the size limit still applies.
				return 0;
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
			const lines = (this.counted.rest + buffer.toString("utf8")).split("\n");
			this.counted.rest = lines.pop() ?? "";
			this.counted.count += lines.filter(isCompaction).length;
			this.counted.offset = size;
		}
		return this.counted.count;
	}
}

function isCompaction(line) {
	if (!line.includes('"compaction"')) return false;
	try {
		return (JSON.parse(line) ?? {}).type === "compaction";
	} catch {
		return false;
	}
}

module.exports = { DEFAULT_ROTATION, HANDOFF_TYPE, SESSION_VERSION, SessionRotator, handoffText, headerVersion, rotationLimits, sessionMessages, textOf, writeHandoffSession };
