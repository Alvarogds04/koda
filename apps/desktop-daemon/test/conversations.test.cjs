"use strict";

// K2-05 T4 U1 (S1,S2): the daemon's history projection over Pi v3 session files.
//
// Port of Gentle Dot packages/daemon/src/conversations.ts (projection half) —
// MIT; see THIRD-PARTY-NOTICES.md. One continuous chat: the history is read
// from the engine's whole rotated chain (oldest file first, the last one
// open); hidden custom_message handoffs and any other display:false entries
// never appear; ids are `s<file index>-<turn>` and stay stable while the chain
// grows; assistant text passes white-label presentText, user text never does.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { pageHistory, historyFromMessages, readSessionMessages, splitAttachments } = require("../src/conversations.cjs");
const P = require("../src/protocol.cjs");
const { SESSION_VERSION } = require("../src/rotation.cjs");

function tmp(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** One v3 session file with a header plus the given entries (an empty array is the form a fresh file takes). */
function writeSession(dir, name, entries) {
	const file = path.join(dir, name);
	const lines = [
		JSON.stringify({ type: "session", version: SESSION_VERSION, id: name, timestamp: new Date().toISOString(), cwd: dir }),
		...entries.map((entry) => JSON.stringify(entry)),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

const message = (role, content) => ({ type: "message", message: { role, content } });
const user = (text) => message("user", text);
const assistant = (text) => message("assistant", text);
/** The hidden handoff the rotation writes (custom_message, display:false). */
const handoff = (text) => ({ type: "custom_message", customType: "abito.handoff", content: text, display: false, id: "ab12cd34" });
/** Blocks as Pi records tool calls and their results. */
const toolCall = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (toolCallId, isError = false) => ({ type: "message", message: { role: "toolResult", isError, toolCallId, content: "ok" } });

test("projection reads a whole 3-file chain oldest first and numbers ids per file", () => {
	const dir = tmp("abito-conv-chain-");
	const f1 = writeSession(dir, "one.jsonl", [user("primera"), assistant("respuesta 1")]);
	const f2 = writeSession(dir, "two.jsonl", [user("segunda"), assistant("respuesta 2")]);
	const f3 = writeSession(dir, "three.jsonl", [user("tercera"), assistant("respuesta 3")]);
	const page = pageHistory([f1, f2, f3], 100);
	assert.deepEqual(
		page.messages.map((m) => [m.id, m.role, m.text, m.earlier]),
		[
			["s0-1", "user", "primera", true],
			["s0-2", "assistant", "respuesta 1", true],
			["s1-1", "user", "segunda", true],
			["s1-2", "assistant", "respuesta 2", true],
			["s2-1", "user", "tercera", undefined],
			["s2-2", "assistant", "respuesta 3", undefined],
		],
	);
	assert.equal(page.hasEarlier, false);
});

test("hidden custom_message handoffs and non-message entries never appear", () => {
	const dir = tmp("abito-conv-hidden-");
	const file = writeSession(dir, "with-handoff.jsonl", [
		user("hola"),
		handoff("The conversation continues from an earlier session. Do not mention this."),
		{ type: "compaction", summary: "resumen" },
		{ type: "session_info", name: "algo" },
		assistant("hola de nuevo"),
	]);
	assert.deepEqual(readSessionMessages(file).map((m) => m.role), ["user", "assistant"]);
	const page = pageHistory([file], 100);
	assert.deepEqual(page.messages.map((m) => [m.role, m.text]), [["user", "hola"], ["assistant", "hola de nuevo"]]);
	assert.ok(!JSON.stringify(page).includes("earlier session"), "no handoff text ever reaches the user");
});

test("ids stay stable while the chain grows (before and after a rotation)", () => {
	const dir = tmp("abito-conv-ids-");
	const f1 = writeSession(dir, "one.jsonl", [user("uno"), assistant("dos")]);
	const before = pageHistory([f1], 100);
	const f2 = writeSession(dir, "two.jsonl", [user("tres"), assistant("cuatro")]);
	const after = pageHistory([f1, f2], 100);
	assert.deepEqual(
		before.messages.map((m) => m.id),
		after.messages.slice(0, 2).map((m) => m.id),
		"the old file keeps its ids once the chain grows",
	);
	assert.deepEqual(before.messages.find((m) => m.id === "s0-1").earlier, undefined, "no earlier mark while it was the only file");
	assert.equal(after.messages[0].earlier, true, "the older files are marked earlier after the rotation");
});

test("pages: an unknown or invalid `before` yields an empty page, a known one ends before that message", () => {
	const dir = tmp("abito-conv-pages-");
	const f1 = writeSession(dir, "one.jsonl", [user("a1"), assistant("a2")]);
	const f2 = writeSession(dir, "two.jsonl", [user("b1"), assistant("b2")]);
	const f3 = writeSession(dir, "three.jsonl", [user("c1"), assistant("c2")]);
	const chain = [f1, f2, f3];
	assert.deepEqual(pageHistory(chain, 100, "s9-1"), { messages: [], hasEarlier: false }, "an index past the chain is empty");
	assert.deepEqual(pageHistory(chain, 100, "nonsense"), { messages: [], hasEarlier: false });
	assert.deepEqual(pageHistory(chain, 100, ""), { messages: [], hasEarlier: false });
	// Newest page first: it is the last page of file 2.
	const last = pageHistory(chain, 2);
	assert.deepEqual(last.messages.map((m) => m.id), ["s2-1", "s2-2"]);
	assert.equal(last.hasEarlier, true);
	const earlier = pageHistory(chain, 2, "s2-1");
	assert.deepEqual(earlier.messages.map((m) => m.id), ["s1-1", "s1-2"], "ends just before the given id");
	assert.equal(earlier.hasEarlier, true);
	// The oldest file has nothing before it.
	const oldest = pageHistory(chain, 10, "s1-1");
	assert.deepEqual(oldest.messages.map((m) => m.id), ["s0-1", "s0-2"]);
	assert.equal(oldest.hasEarlier, false);
});

test("pages are bounded by the limit; a page always takes whole turns", () => {
	const dir = tmp("abito-conv-limit-");
	const file = writeSession(dir, "one.jsonl", [user("u"), assistant("a")]);
	const page = pageHistory([file], 1);
	assert.deepEqual(page.messages.map((m) => m.text), ["a"]);
	assert.equal(page.hasEarlier, true, "the first turn is still earlier");
	assert.deepEqual(pageHistory([file], 0), { messages: [], hasEarlier: false }, "an absurd limit yields an empty page");
});

test("a missing or unreadable chain file is skipped with a log, never a crash", () => {
	const dir = tmp("abito-conv-missing-");
	const f1 = writeSession(dir, "one.jsonl", [user("queda")]);
	const logs = [];
	const page = pageHistory([path.join(dir, "gone.jsonl"), path.join(dir, "sub", "nope.jsonl"), f1], 100, undefined, (line) => logs.push(line));
	assert.deepEqual(page.messages.map((m) => [m.id, m.text]), [["s2-1", "queda"]]);
	assert.equal(page.hasEarlier, false);
	assert.ok(logs.length >= 1, "the skip is logged");
	// A file that cannot even be stat-ed is skipped too (the dir was removed under it).
	const logs2 = [];
	fs.rmSync(path.join(dir, "sub"), { recursive: true, force: true });
	pageHistory([f1, path.join(dir, "sub", "nope.jsonl")], 100, undefined, (line) => logs2.push(line));
	// And a whole unreadable path never throws:
	assert.doesNotThrow(() => pageHistory([f1, path.join(dir, "sub", "nope.jsonl")], 100));
});

test("torn and corrupt lines are skipped; the readable prefix still projects", () => {
	const dir = tmp("abito-conv-corrupt-");
	const file = path.join(dir, "torn.jsonl");
	fs.writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: SESSION_VERSION, id: "t", timestamp: "t", cwd: dir }),
			JSON.stringify(user("buena")),
			'{"type":"message","message":{"role":"user","conte', // torn last line while the engine writes
			"esto no es json y habla de message", // garbage that only mentions the key
		].join("\n"),
	);
	assert.deepEqual(readSessionMessages(file).map((m) => m.role), ["user"]);
	const page = pageHistory([file], 100);
	assert.deepEqual(page.messages.map((m) => m.text), ["buena"]);
});

test("assistant text passes white-label presentText; user text never does", () => {
	const dir = tmp("abito-conv-white-");
	const file = writeSession(dir, "one.jsonl", [
		user("mi engram y mi Gentle Shell y el ODD siguen aquí"),
		assistant("leo tu engram del Gentle Shell en el ODD"),
	]);
	const page = pageHistory([file], 100);
	assert.equal(page.messages[0].text, "mi engram y mi Gentle Shell y el ODD siguen aquí", "the user's own words are theirs");
	assert.equal(page.messages[1].text, "leo tu memory del Koda en el workflow", "assistant text is white-labelled");
});

test("consecutive assistant messages form ONE turn joined with a blank line", () => {
	const dir = tmp("abito-conv-merge-");
	const file = writeSession(dir, "one.jsonl", [user("hola"), assistant("parte 1"), assistant("parte 2")]);
	const page = pageHistory([file], 100);
	assert.equal(page.messages.length, 2);
	assert.equal(page.messages[1].text, "parte 1\n\nparte 2");
	assert.equal(page.messages[1].id, "s0-2");
});

test("tool rows become closed-kinded activities, failed when the engine's result failed", () => {
	const dir = tmp("abito-conv-tools-");
	const file = writeSession(dir, "one.jsonl", [
		user("mira"),
		message("assistant", [
			{ type: "text", text: "buscando" },
			toolCall("t1", "read", { path: "/tmp/notas.md" }),
			toolCall("t2", "bash"),
			toolCall("t3", "desconocido"),
		]),
		toolResult("t1"),
		toolResult("t2", true),
		assistant("listo"),
	]);
	const page = pageHistory([file], 100);
	// A toolResult message never splits the turn: consecutive assistant messages merge.
	const mus = page.messages[1];
	assert.equal(mus.role, "assistant");
	assert.equal(mus.text, "buscando\n\nlisto");
	assert.deepEqual(
		mus.activities,
		[
			{ id: "t1", kind: "read", title: "Read notas.md", status: "done" },
			{ id: "t2", kind: "run", title: "A command failed", status: "failed" },
			{ id: "t3", kind: "other", title: "Finished", status: "done" },
		],
	);
	assert.ok(page.messages.every((m) => !JSON.stringify(m).includes("/tmp/notas.md")), "raw arguments never travel");
});

test("user attachments are split into text and chips, exactly Gentle Dot's block shape", () => {
	const intro = "The user attached these files, saved in your workspace. Read them with your tools when needed.";
	const text = `mira esto\n\n<attachments>\n${intro}\n${JSON.stringify({ name: "notas.txt", size: 12, type: "text/plain" })}\n</attachments>`;
	const split = splitAttachments(text);
	assert.deepEqual(split, { text: "mira esto", attachments: [{ name: "notas.txt", size: 12, mime: "text/plain" }] });
	// Anything that is not exactly the block passes through untouched.
	assert.deepEqual(splitAttachments("solo <attachments> texto"), { text: "solo <attachments> texto", attachments: [] });
});

test("the empty form: no session file, an empty file", () => {
	const dir = tmp("abito-conv-empty-");
	assert.deepEqual(pageHistory([], 100), { messages: [], hasEarlier: false });
	const file = writeSession(dir, "empty.jsonl", []);
	assert.deepEqual(pageHistory([file], 100), { messages: [], hasEarlier: false });
});

test("the per-file cache serves unchanged files and invalidates changed ones", () => {
	const dir = tmp("abito-conv-cache-");
	const file = writeSession(dir, "one.jsonl", [user("uno")]);
	assert.deepEqual(pageHistory([file], 100).messages.map((m) => m.text), ["uno"]);
	const second = pageHistory([file], 100);
	const first = readSessionMessages(file);
	fs.appendFileSync(file, `${JSON.stringify(user("dos"))}\n`);
	assert.deepEqual(pageHistory([file], 100).messages.map((m) => m.text), ["uno", "dos"], "the changed file is read again");
	assert.equal(first.length, 1, "the cached copy is not aliased into the next read");
	assert.equal(second.messages.length, 1);
});

test("historyFromMessages builds h-numbered turns when a raw engine answer is projected", () => {
	const turns = historyFromMessages([
		{ role: "user", content: "hola" },
		{ role: "assistant", content: [{ type: "text", text: "hola tú" }] },
		{ role: "assistant", content: "segunda parte" },
	]);
	assert.deepEqual(
		turns.map((m) => [m.id, m.role, m.text]),
		[["h1", "user", "hola"], ["h2", "assistant", "hola tú\n\nsegunda parte"]],
	);
});

// ----- K2-05 T4 U1 verifier fixes -------------------------------------------

/** The per-frame limit the island's reader enforces (agentclient.rs FrameError::TooLarge). */
const ISLAND_FRAME_LIMIT = 256 * 1024;

/** The user rows Gentle Dot keeps: a message with only image blocks still is one user turn. */
const imageBlock = { type: "image", mimeType: "image/png", data: "aG9sYQ==" };

/** The verifier's shape: a 60-turn chat whose answers carry ~2,700 chars plus tool activity rows. */
function writeLongChat(dir) {
	const entries = [];
	for (let i = 1; i <= 60; i++) {
		entries.push(user(`pregunta ${i} sobre el procedimiento completo de despliegue`));
		entries.push(message("assistant", [
			{ type: "text", text: `respuesta ${i}: ${"x".repeat(2700)}` },
			...Array.from({ length: 20 }, (_, k) => toolCall(`t${i}-${k}`, "read", { path: `/proyecto/modulo${k}/componente/archivo-con-nombre-largo.ts` })),
		]));
	}
	return writeSession(dir, "long.jsonl", entries);
}

// Every string reachable in a decoded frame, depth-first (B1 test helper).
const frameStrings = (value, out = []) => {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) frameStrings(v, out);
	else if (value !== null && typeof value === "object") for (const v of Object.values(value)) frameStrings(v, out);
	return out;
};
const hasLoneSurrogate = (s) => {
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i += 1;
		} else if (c >= 0xdc00 && c <= 0xdfff) return true;
	}
	return false;
};
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Numeric order of the page ids `s<file>-<turn>`. */
const idOrder = (id) => {
	const [, f, t] = /^(\d+)-(\d+)$/.exec(id.slice(1));
	return Number(f) * 1e9 + Number(t);
};

test("a 60-turn chat of ~2,700-char answers (the verifier's 276,370-byte shape) builds a page that always fits", () => {
	const dir = tmp("abito-conv-long-");
	const file = writeLongChat(dir);
	const unbounded = JSON.stringify(historyFromMessages(readSessionMessages(file)));
	assert.ok(Buffer.byteLength(unbounded) > ISLAND_FRAME_LIMIT, `the fixture must reproduce an over-limit shape, got ${Buffer.byteLength(unbounded)}`);
	const page = pageHistory([file], 100);
	const frame = JSON.stringify(page);
	assert.ok(Buffer.byteLength(frame) <= 192 * 1024, `the page must stay under the island-safe budget, got ${Buffer.byteLength(frame)}`);
	assert.ok(page.messages.length > 0, "a bounded page is never empty when the chat has turns");
	assert.equal(page.hasEarlier, true, "the walk continues exactly where the page stopped");
});

test("walking get_earlier over a long chat returns every turn exactly once, in order", () => {
	const dir = tmp("abito-conv-walk-");
	const file = writeLongChat(dir);
	const all = [];
	let page = pageHistory([file], 100);
	for (let guard = 0; page.messages.length > 0; guard++) {
		assert.ok(guard < 100, "the walk terminated");
		assert.deepEqual(page.messages.map((m) => m.id), [...page.messages].sort((a, b) => idOrder(a.id) - idOrder(b.id)).map((m) => m.id), "each page is oldest first");
		all.push(...page.messages);
		if (!page.hasEarlier) break;
		page = pageHistory([file], 100, page.messages[0].id);
	}
	const ids = all.map((m) => m.id);
	assert.equal(new Set(ids).size, 120, "no turn is repeated or skipped across pages");
	assert.deepEqual(
		[...ids].sort((a, b) => idOrder(a) - idOrder(b)),
		Array.from({ length: 120 }, (_, i) => `s0-${i + 1}`),
		"every turn exactly once",
	);
});

test("one huge message is clipped so its page fits: whole code points, white-labelled text, no split surrogate", () => {
	const dir = tmp("abito-conv-huge-");
	const file = writeSession(dir, "huge.jsonl", [
		user("recita"),
		message("assistant", [{ type: "text", text: `memory: ${" 𝐀".repeat(120_000)}` }]),
		user("sigue"),
		assistant("fin"),
	]);
	const page = pageHistory([file], 100);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 192 * 1024, "the page with the clipped message fits");
	assert.deepEqual(page.messages.map((m) => m.id), ["s0-1", "s0-2", "s0-3", "s0-4"], "the clipped giant message stays in its turn order, nothing dropped");
	assert.equal(page.hasEarlier, false, "the whole (bounded) chat is one page");
	const huge = page.messages[1];
	assert.ok(huge.text.length < 120_000, "the oversized text was clipped");
	assert.ok(!loneSurrogate.test(huge.text), "the clip never splits a surrogate pair");
	assert.ok(huge.text.startsWith("memory: "), "the clip runs after white-labelling, never over a hidden name");
	assert.equal(huge.textClipped, true, "the page-budget clip of the text is marked, never silent (F2)");
	assert.equal(P.historyFrame(page).messages[1].clipped, true, "the DTO carries the marker as clipped:true (F2)");
	assert.deepEqual(page.messages[0].text, "recita", "the turns around the clipped one still project");
});

test("hand-made cursors: sN-0 and a turn beyond what the file ever held yield an empty page with hasEarlier false", () => {
	const dir = tmp("abito-conv-cursors-");
	const file = writeSession(dir, "small.jsonl", [user("uno"), assistant("dos"), user("tres")]);
	assert.deepEqual(pageHistory([file], 100, "s0-0"), { messages: [], hasEarlier: false }, "turn 0 never existed");
	assert.deepEqual(pageHistory([file], 100, "s0-99"), { messages: [], hasEarlier: false }, "a turn past the file never existed");
	assert.deepEqual(pageHistory([file], 100, "s0-2").messages.map((m) => m.id), ["s0-1"], "a real turn id still pages backwards");
});

test("a user row that carries only images is kept, as Gentle Dot keeps it (empty text, no chips)", () => {
	const turns = historyFromMessages([
		{ role: "user", content: [imageBlock] },
		{ role: "assistant", content: "la vi" },
	]);
	assert.deepEqual(
		turns.map((m) => [m.role, m.text, m.attachments]),
		[["user", "", undefined], ["assistant", "la vi", undefined]],
	);
});

// B1 (verifier): a session file whose reply holds a lone surrogate (the JSON escape
// reaches the daemon through JSON.parse) used to make every get_history frame encode a
// lone-surrogate \udXXX escape — the island's serde_json rejects it and drops the
// connection, forever. The single outbound encoder replaces it with U+FFFD.
test("history from a session file holding a lone surrogate encodes U+FFFD, never the lone half (B1)", () => {
	const dir = tmp("abito-conv-lone-");
	const header = JSON.stringify({ type: "session", version: SESSION_VERSION, id: "lone", timestamp: new Date().toISOString(), cwd: dir });
	// The raw file text carries the \ud800 ESCAPE; writeFileSync with a string that itself
	// contains the backslash-u sequence (JSON.stringify would keep the lone surrogate as an
	// escape too, so both spellings reach the daemon through JSON.parse).
	const replyLine = `{"type":"message","message":{"role":"assistant","content":"antes \\ud800 después 😀"}}`;
	const file = path.join(dir, "lone.jsonl");
	fs.writeFileSync(file, `${header}\n${replyLine}\n`);
	const page = pageHistory([file], 100);
	assert.equal(page.messages.length, 1);
	const parsed = JSON.parse(P.encodeServerFrame(P.historyFrame(page), 1).toString("utf8"));
	for (const s of frameStrings(parsed)) assert.ok(!hasLoneSurrogate(s), "the encoded history line carries a lone surrogate");
	assert.ok(parsed.messages[0].text.includes("\uFFFD"), "the lone surrogate was replaced with U+FFFD");
	assert.ok(parsed.messages[0].text.includes("😀"), "the valid pair is untouched");
});

test("sessionTail + nextRow number rows exactly as the history projection does (K2-05 bind by id)", () => {
	const { sessionTail, nextRow } = require("../src/conversations.cjs");
	const dir = tmp("abito-conv-rows-");
	assert.deepEqual(sessionTail(path.join(dir, "missing.jsonl")), { rows: 0, role: undefined }, "a session not flushed yet has no rows");
	const entries = [user("uno"), assistant("a"), toolResult("t1"), assistant("b"), handoff("oculto"), user("dos"), user("tres"), assistant("c")];
	const file = writeSession(dir, "rows.jsonl", entries);
	const page = pageHistory([file], 100);
	assert.deepEqual(sessionTail(file), { rows: page.messages.length, role: "assistant" });
	// counting the same messages from an empty file gives the same ids the page gives
	let tail = { rows: 0, role: undefined };
	const users = [];
	for (const e of entries) {
		if (e.type !== "message") continue;
		const step = nextRow(tail, e.message.role);
		tail = step.tail;
		if (step.userRow !== undefined) users.push(`s0-${step.userRow}`);
	}
	assert.deepEqual(users, page.messages.filter((m) => m.role === "user").map((m) => m.id));
	assert.equal(tail.rows, page.messages.length);
});
