"use strict";

/**
 * K2-05 T4 U1 (S1,S2) — the daemon's history projection over the engine's
 * session files: one continuous chat read from the whole rotated chain
 * (engine `previousSessions` + `sessionFile`, oldest first), pages bounded by
 * ids that stay stable while the chain grows.
 *
 * Port of the projection half of Gentle Dot's packages/daemon/src/conversations.ts
 * and its helpers in presentation.ts / uploads.ts (splitAttachments) — MIT,
 * Copyright (c) 2026 Gentleman Programming; see THIRD-PARTY-NOTICES.md. The
 * conversation-list half of upstream (listConversations, titles, open/resolve)
 * is deliberately NOT ported: Koda keeps ONE continuous chat (L3/L4), so
 * `ready.features` carries `conversations:false` and there is no conversation
 * list to name.
 *
 * Pure module, no I/O beyond reading the session files. Koda hardening over
 * upstream: a chain file that cannot be stat-ed or read (missing, unreadable,
 * planted) is skipped with a log line instead of crashing the request, and a
 * non-positive page limit yields an empty page instead of a broken slice.
 */

const fs = require("node:fs");
const path = require("node:path");
const { presentText } = require("./white-label.cjs");

const PAGE_ID = /^s(\d+)-(\d+)$/;
const CACHED_FILES = 8;

/** The attachment block Gentle Dot's composePrompt appends to a message with files. */
const INTRO = "The user attached these files, saved in your workspace. Read them with your tools when needed.";
const BLOCK_START = "<attachments>";
const BLOCK_END = "</attachments>";

/**
 * Splits a user message into the text the user typed and the chips of the
 * files the daemon appended (upstream uploads.ts:406-429). Anything that is
 * not exactly that block passes through untouched.
 */
function splitAttachments(text) {
	const none = { text, attachments: [] };
	if (typeof text !== "string") return none;
	if (!text.endsWith(`\n${BLOCK_END}`)) return none;
	const start = text.lastIndexOf(`${BLOCK_START}\n${INTRO}\n`);
	if (start < 0 || (start > 0 && text.slice(start - 2, start) !== "\n\n")) return none;
	const lines = text
		.slice(start, -BLOCK_END.length - 1)
		.split("\n")
		.slice(2);
	const attachments = [];
	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			return none;
		}
		const { name, size, type } = entry ?? {};
		if (typeof name !== "string" || typeof size !== "number" || typeof type !== "string") return none;
		attachments.push({ name, size, mime: type });
	}
	if (attachments.length === 0) return none;
	return { text: text.slice(0, Math.max(0, start - 2)), attachments };
}

/** Plain text of a user or assistant message whose content is a string or content blocks. */
function textOf(message) {
	if (!message || typeof message !== "object") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (block && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("");
}

/** The life cycle of one tool call, as the activity list shows it (upstream presentation.ts). */
function describeTool(toolName, args, status = "running") {
	const name = typeof toolName === "string" ? toolName.toLowerCase() : "";
	const file = fileOf(args);
	const titled = (kind, titles) => ({ kind, title: status === "running" ? titles[0] : status === "done" ? titles[1] : titles[2] });
	if (name === "read") {
		return titled("read", file ? [`Reading ${file}`, `Read ${file}`, `Could not read ${file}`] : ["Reading a file", "Read a file", "Could not read a file"]);
	}
	if (name === "write" || name === "edit") {
		return titled("edit", file ? [`Editing ${file}`, `Edited ${file}`, `Could not edit ${file}`] : ["Editing a file", "Edited a file", "Could not edit a file"]);
	}
	if (name === "bash") return titled("run", ["Running a command", "Ran a command", "A command failed"]);
	if (name.startsWith("mem_save") || name === "mem_update" || name === "mem_session_summary") {
		return titled("memory", ["Saving a note", "Saved a note", "Could not save a note"]);
	}
	if (name.startsWith("mem_")) return titled("memory", ["Checking my notes", "Checked my notes", "Could not check my notes"]);
	if (name.startsWith("subagent_")) return titled("delegate", ["Asking a helper", "Asked a helper", "Could not ask a helper"]);
	if (["web_search", "fetch_content", "get_search_content", "source_check"].includes(name)) {
		return titled("search", ["Looking things up online", "Looked things up online", "Could not look things up online"]);
	}
	if (["grep", "find", "ls"].includes(name) || name.startsWith("codegraph")) {
		return titled("search", ["Searching files", "Searched files", "Could not search files"]);
	}
	if (name.startsWith("ask_user")) return titled("other", ["Asking you", "Asked you", "Could not ask you"]);
	return titled("other", ["Working", "Finished", "Failed"]);
}

function fileOf(args) {
	if (!args || typeof args !== "object") return undefined;
	const p = args.path ?? args.file_path ?? args.filePath;
	return typeof p === "string" && p !== "" ? path.basename(p) : undefined;
}

/** The `type:"message"` records of one session file, in order; context-only entries are not messages. */
function readSessionMessages(file) {
	if (typeof file !== "string" || !fs.existsSync(file)) return [];
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

const turnCache = new Map();

/**
 * The display turns of one session file, cached while the file is unchanged
 * (earlier files never change). A file that is missing or cannot be read is
 * skipped with a log line (never cached, never thrown): the history simply
 * starts where the readable files start.
 */
function sessionTurns(file, log) {
	if (typeof file !== "string" || !fs.existsSync(file)) {
		log?.(`history: a session file of the chain is unavailable, skipped: ${file}`);
		return [];
	}
	let stats;
	try {
		stats = fs.statSync(file);
	} catch (error) {
		log?.(`history: a session file of the chain is unavailable, skipped: ${file} (${error.message})`);
		return [];
	}
	const cached = turnCache.get(file);
	if (cached?.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.turns;
	let turns;
	try {
		turns = historyFromMessages(readSessionMessages(file));
	} catch (error) {
		log?.(`history: a session file of the chain could not be read, skipped: ${file} (${error.message})`);
		return [];
	}
	turnCache.delete(file);
	turnCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, turns });
	if (turnCache.size > CACHED_FILES) turnCache.delete(turnCache.keys().next().value);
	return turns;
}

/**
 * One page of the chat kept in `chain` (session files, oldest first; the last
 * one is open), ending just before the message `before`, or at the newest one.
 * Ids are `s<file index>-<turn number>`, which stay valid while the chain
 * grows. An unknown `before` yields an empty page; so does a non-positive
 * limit. Messages of every file but the last carry `earlier:true`.
 */
function pageHistory(chain, limit, before, log) {
	if (!Array.isArray(chain) || !Number.isSafeInteger(limit) || limit < 1) return { messages: [], hasEarlier: false };
	let file = chain.length - 1;
	let end = Number.POSITIVE_INFINITY;
	if (before !== undefined) {
		const match = PAGE_ID.exec(typeof before === "string" ? before : "");
		if (!match || Number(match[1]) >= chain.length) return { messages: [], hasEarlier: false };
		file = Number(match[1]);
		end = Number(match[2]) - 1;
	}
	const page = [];
	for (; file >= 0; file--, end = Number.POSITIVE_INFINITY) {
		const turns = sessionTurns(chain[file], log).slice(0, end);
		const start = Math.max(0, turns.length - (limit - page.length));
		const earlier = file < chain.length - 1 ? { earlier: true } : {};
		page.unshift(
			...turns.slice(start).map((turn, i) => ({ ...turn, id: `s${file}-${start + i + 1}`, ...earlier })),
		);
		if (page.length >= limit) {
			const more = start > 0 || chain.slice(0, file).some((path) => sessionTurns(path, log).length > 0);
			return { messages: page, hasEarlier: more };
		}
	}
	return { messages: page, hasEarlier: false };
}

/**
 * Converts Pi `get_messages` output into display messages; consecutive
 * assistant messages form one turn. All assistant text passes white-label
 * presentText (internal names never reach the user); the user's own text
 * never does. Hidden handoffs and every other context-only entry never reach
 * this function (readSessionMessages returns type:"message" rows only).
 */
function historyFromMessages(messages) {
	const failed = new Set();
	for (const raw of messages ?? []) {
		const m = raw ?? {};
		if (m.role === "toolResult" && m.isError && m.toolCallId) failed.add(m.toolCallId);
	}
	const history = [];
	let index = 0;
	for (const raw of messages ?? []) {
		const m = raw ?? {};
		if (m.role === "user") {
			const { text, attachments } = splitAttachments(textOf(m));
			if (!text && !attachments.length) continue;
			history.push({
				id: `h${++index}`,
				role: "user",
				text,
				activities: [],
				...(attachments.length > 0 ? { attachments } : {}),
			});
			continue;
		}
		if (m.role !== "assistant") continue;
		let turn = history.at(-1);
		if (turn?.role !== "assistant") {
			turn = { id: `h${++index}`, role: "assistant", text: "", activities: [] };
			history.push(turn);
		}
		const text = presentText(textOf(m));
		if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
		turn.activities.push(...activitiesOf(m, failed));
	}
	return history;
}

function activitiesOf(message, failed) {
	if (!Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => {
		const b = block ?? {};
		if (b.type !== "toolCall" || typeof b.name !== "string") return [];
		const id = b.id ?? b.name;
		const status = failed.has(id) ? "failed" : "done";
		return [{ id, ...describeTool(b.name, b.arguments, status), status }];
	});
}

module.exports = { splitAttachments, textOf, describeTool, readSessionMessages, pageHistory, historyFromMessages };
