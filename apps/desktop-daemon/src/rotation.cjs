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
 * seed write skips the rotation; a failed switch or verification falls back to
 * a `new_session` seeded the same way (Gentle Dot's own fallback) and removes
 * the orphan handoff file it created, so the chat never stays behind in an
 * oversized session and never retries in a storm.
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

/**
 * Rotation limits: the ABITO_ROTATE_* environment wins over the config values,
 * the config wins over the defaults (an invalid value never wins, like Gentle
 * Dot's GENTLE_DOT_ROTATE_*). F7: an env value is accepted only as a plain
 * positive decimal integer (no 1e3, 0x10 or spaces), and ABITO_ROTATE_BYTES
 * keeps the same 1024-byte minimum the config has — a smaller value never wins.
 */
const MIN_ROTATE_BYTES = 1024;

const intFromEnv = (value) => {
	if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

function rotationLimits(env = process.env, config = {}) {
	const envBytes = intFromEnv(env.ABITO_ROTATE_BYTES);
	return {
		bytes: (envBytes !== undefined && envBytes >= MIN_ROTATE_BYTES ? envBytes : undefined) ?? config.bytes ?? DEFAULT_ROTATION.bytes,
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
 * compaction, the previous handoff plus the last messages. Like Gentle Dot,
 * the truthiness of the summary decides (F4): an EMPTY summary is no summary
 * and the handoff falls back to the recent messages instead of shipping empty.
 */
function handoffText(file) {
	const summary = entries(file, '"compaction"')
		.filter((e) => e.type === "compaction" && typeof e.summary === "string")
		.at(-1)?.summary;
	if (summary) return `${HANDOFF_INTRO}\n\nSummary of the conversation so far:\n\n${summary}`;
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
 * (nothing paused, nothing on its way). A failed seed write reports `false`;
 * a failed switch or verification falls back to a fresh session (never more
 * than one orphan seed per attempt window, which is removed on failure); no
 * data is ever lost.
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
		/** How long a failed-switch fallback waits for the engine's own recovery. */
		this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
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
		if (version !== SESSION_VERSION) {
			// F4 fail closed: a header that cannot be parsed (undefined) is as
			// foreign as a wrong version — the rotation is skipped and logged.
			this.log(`rotation skipped, the chat stays in ${file}: its session format is ${version === undefined ? "unparseable" : `version ${version}`}, not ${SESSION_VERSION}`);
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
		// Link before switching (the chain of the session that ends up open keeps
		// its history); linking alone never persists the seed (F1: Gentle Dot
		// persists the OPEN session only).
		this.engine.linkSessions?.(seed, previous);
		try {
			await this.engine.request({ type: "switch_session", sessionPath: seed });
			await this.verify(seed);
		} catch (error) {
			// F2 (Gentle Dot, rotation.ts:212-215): a switch or verification failure
			// does not leave the chat in the OVERSIZED session to retry forever —
			// a `new_session` seeded the same way continues it. The orphan seed of
			// the failed attempt is removed first (exactly that file, in the
			// sessions dir, regular and owned: never anything else).
			this.log(`rotation: the engine did not load the handoff session ${seed} (${error.message}); starting a fresh session without it`);
			this.removeOrphanSeed(seed, file);
			try {
				// A failed switch may have put the engine on its own recovery
				// path (the child is recycled and the previous session reopens);
				// the fallback goes once it is ready again.
				await this.waitForIdle();
				await this.engine.request({ type: "new_session", parentSession: file });
			} catch (fallbackError) {
				this.log(`rotation fallback failed, the chat stays in ${file}: ${fallbackError.message}`);
				return false;
			}
			const fresh = this.engine.sessionFile;
			if (fresh && fresh !== file) this.engine.linkSessions?.(fresh, previous);
			this.log(`rotation: the chat continues in ${fresh}`);
			return true;
		}
		this.log(`rotation: the chat continues in ${seed}`);
		return true;
	}

	/**
	 * Waits, bounded, until the engine can take a session request again: after a
	 * failed switch it may be recycling the child and reopening the previous
	 * session. A timeout throws so the caller reports the failure and stops.
	 */
	async waitForIdle(timeoutMs = this.idleTimeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.engine.status === "ready" && !this.engine.busy) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`the engine did not become ready again within ${timeoutMs} ms`);
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

	/**
	 * Removes the orphan handoff session a failed attempt created — ONLY that
	 * exact file: resolved inside the previous session's directory (the engine's
	 * private sessions dir), a regular non-symlink file owned by this user.
	 * Best effort: a failure is logged, never thrown.
	 */
	removeOrphanSeed(seed, previousFile) {
		try {
			const resolved = path.resolve(seed);
			if (resolved === path.resolve(previousFile)) return;
			if (path.dirname(resolved) !== path.resolve(path.dirname(previousFile))) return;
			const stats = fs.lstatSync(resolved);
			if (stats.isSymbolicLink() || !stats.isFile()) return;
			if (typeof process.getuid === "function" && stats.uid !== process.getuid()) return;
			fs.unlinkSync(resolved);
		} catch (error) {
			this.log(`rotation: could not remove the orphan handoff session ${seed}: ${error.message}`);
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
			} catch {
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
