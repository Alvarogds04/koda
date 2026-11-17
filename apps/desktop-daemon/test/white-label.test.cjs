"use strict";

// K2-05 T2: internal names must never reach the user. Pure-module tests for the
// white-label port of Gentle Dot's white-label.ts (MIT; see THIRD-PARTY-NOTICES.md).
//
// Wiring is deliberately NOT here: protocol.cjs translateEvent must call
// presentText/shouldShowToast, but protocol.cjs changes on another branch
// (K2-03), so the module ships first with its own proof (T2, S1/S4).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
	HIDDEN_NAMES,
	presentText,
	shouldShowToast,
	isBlockedInput,
} = require("../src/white-label.cjs");

test("hidden names cover the engine and every internal name T2 lists", () => {
	const names = [
		"Gentle Shell",
		"gentle-shell",
		"gentle shell",
		"el Gentleman",
		"Gentle AI",
		"gentle-ai",
		"gentle-pi",
		"pi-coding-agent",
		"abito-island",
		"Engram",
		"engram",
		"ODD",
		"Organic Driven Development",
		"organic driven development",
		"RDD",
		"/gentle:",
	];
	for (const name of names) {
		assert.ok(
			HIDDEN_NAMES.some((pattern) => pattern.test(name)),
			`no hidden-name pattern matches "${name}"`,
		);
	}
});

test("presentText rewrites every hidden name into Koda's voice", () => {
	const cases = [
		["Run /gentle:memory-save now", "Run now"],
		["el Gentleman says hi", "Koda says hi"],
		["Gentle Shell started", "Koda started"],
		["gentle-pi is ready", "Koda is ready"],
		["the Gentle AI installer", "the Koda installer"],
		["pi-coding-agent version", "assistant version"],
		["the Pi agent runtime", "the assistant runtime"],
		["Organic Driven Development works", "my workflow works"],
		["per ODD", "per workflow"],
		["saved via Engram", "saved via memory"],
		["receipt-driven development note", "review note"],
		["per RDD", "per review"],
		["saved to abito-island", "saved to my memory"],
		["the Abito island app", "the Koda app"],
	];
	for (const [input, expected] of cases) {
		assert.equal(presentText(input), expected, input);
	}
	// Harness spacing artefacts are cleaned: double spaces collapse and
	// punctuation never keeps a space before it.
	assert.equal(presentText("a  b , c"), "a b, c");
	assert.equal(presentText("done ."), "done.");
});

// Koda's additions over upstream must never corrupt legitimate text: the bare
// "Pi" → "assistant" and case-insensitive "Abito" rewrites were removed (B3) —
// only product phrases ("Abito island") and the memory project identifier are
// rewritten, and upstream's own phrase-bound rewrites stay exact.
test("presentText leaves legitimate text that merely contains Pi or abito untouched", () => {
	const cases = [
		"Raspberry Pi 4",
		"Pi-hole blocks ads",
		"abito a Roma",
		"Pi knows",
		"Abito greets you",
		"abito Island hops",
	];
	for (const input of cases) {
		assert.equal(presentText(input), input, `must stay untouched: ${input}`);
	}
});

test("presentText output never matches a hidden name (for the rewritten inputs)", () => {
	for (const [input] of [
		["Gentle Shell and gentle-pi"],
		["Abito island, abito-island, Engram"],
		["pi-coding-agent, ODD, RDD, /gentle:memory"],
		["el Gentleman, Gentle AI, organic driven development"],
	]) {
		const shown = presentText(input);
		for (const pattern of HIDDEN_NAMES) {
			assert.doesNotMatch(shown, pattern, `hidden name leaked in ${JSON.stringify(shown)}`);
		}
	}
});

test("shouldShowToast shows warnings and errors, never harness info chatter", () => {
	assert.equal(shouldShowToast("info"), false);
	assert.equal(shouldShowToast("warning"), true);
	assert.equal(shouldShowToast("error"), true);
});

test("isBlockedInput blocks only the internal /gentle: commands", () => {
	assert.equal(isBlockedInput("/gentle:memory-search"), true);
	assert.equal(isBlockedInput("  /gentle:x"), true);
	assert.equal(isBlockedInput("/GENTLE:x"), true);
	assert.equal(isBlockedInput("/help"), false);
	assert.equal(isBlockedInput("hola /gentle:"), false, "mid-sentence text is not a command");
});

test("presentText is documented as assistant/harness-only, never applied to the user's own text", () => {
	// Gentle Dot bridge.ts applies presentText to queued user text too; Koda must
	// not (the user's own words — their Raspberry Pi, their abito — are theirs).
	const source = fs.readFileSync(path.join(__dirname, "..", "src", "white-label.cjs"), "utf8");
	assert.match(source, /never[\s\S]*user's own text|user's own text[\s\S]*never/i);
});

test("the port keeps its MIT provenance (Gentle Dot, white-label.ts)", () => {
	const source = fs.readFileSync(path.join(__dirname, "..", "src", "white-label.cjs"), "utf8");
	assert.match(source, /Gentle Dot/);
	assert.match(source, /white-label\.ts/);
	assert.match(source, /MIT/);
	assert.match(source, /Copyright \(c\) 2026 Gentleman/);
});

// ----- T2: the streaming filter (split hidden names across deltas) -----------

const { createTextFilter } = require("../src/white-label.cjs");

const joined = (filter, deltas) => {
	const parts = deltas.map((d) => filter.push(d));
	parts.push(filter.flush());
	return parts.join("");
};

test("createTextFilter rewrites a whole hidden name inside one long delta", () => {
	const f = createTextFilter();
	const shown = joined(f, [`${"x".repeat(60)} Gentle Shell is ready. ${"y".repeat(60)}`]);
	assert.ok(shown.includes("Koda is ready"), JSON.stringify(shown));
	assert.ok(!/gentle/i.test(shown), JSON.stringify(shown));
});

test("createTextFilter keeps a name split across deltas hidden (bounded hold-back)", () => {
	const f = createTextFilter();
	const shown = joined(f, [`${"x".repeat(60)} and Gentle`, " Shell works. " + "y".repeat(60)]);
	assert.ok(shown.includes("Koda works"), JSON.stringify(shown));
	assert.ok(!/gentle/i.test(shown), JSON.stringify(shown));
});

test("createTextFilter holds a letter-by-letter name and flushes it rewritten", () => {
	const f = createTextFilter();
	const shown = joined(f, [..."Gentle Shell", " contestó."]);
	assert.equal(shown, "Koda contestó.", JSON.stringify(shown));
});

test("createTextFilter never emits half of an open /gentle: command token", () => {
	const f = createTextFilter();
	const parts = [];
	const text = `${"x".repeat(60)} /gentle:memory-save ahora. ${"y".repeat(60)}`;
	for (let i = 0; i < text.length; i += 7) parts.push(f.push(text.slice(i, i + 7)));
	parts.push(f.flush());
	const shown = parts.join("");
	assert.ok(!shown.includes("/gentle:"), JSON.stringify(shown));
	assert.ok(shown.includes("ahora"), JSON.stringify(shown));
});

test("createTextFilter output is stable: nothing already emitted is ever changed by later text", () => {
	// Property-style sweep: for ANY delta split, the concatenated visible stream
	// must equal the full rewrite of the whole text — a prefix once emitted can
	// never be contradicted by what arrives later, and a word cut at a delta
	// boundary must NOT be rewritten early (F1: «engram»+«as» stays "engramas",
	// not "memoryas"). Held back is RAW text; rewriting happens only where the
	// text can no longer change.
	const texts = [
		"Trabajo con el Gentle Shell y con engram a diario, pero ODD y RDD son míos: pi-coding-agent no.",
		"Gentle-pi, gentle-ai, el Gentleman, abito-island, /gentle:x, organic driven development.",
		"texto normal sin nada que ocultar. " + "z".repeat(200),
		"Gentle Shell",
		"a /gentle:" + "w".repeat(80),
		// F1: the four boundary cuts the verifier reproduced (with a prefix long
		// enough that the filter has already emitted something).
		`${"x".repeat(60)} engramas`,
		`${"x".repeat(60)} Pi agente`,
		`${"x".repeat(60)} ODDITY`,
		`${"x".repeat(60)} GentlePie`,
	];
	const splits = [1, 2, 3, 5, 7, 11, 13, 32, 64, 1000];
	for (const text of texts) {
		for (const size of splits) {
			const f = createTextFilter();
			const parts = [];
			for (let i = 0; i < text.length; i += size) parts.push(f.push(text.slice(i, i + size)));
			parts.push(f.flush());
			assert.equal(parts.join(""), presentText(text), `split ${size} of ${JSON.stringify(text.slice(0, 40))}`);
		}
	}
});

// F1: the exact pairs the verifier reproduced («engram»|«as» → «memoryas»,
// «Pi agent»|«e» → «assistante», «ODD»|«ITY» → «workflowITY», «GentlePi»|«e» →
// «Kodae»), preceded by a pad long enough that the filter already emitted — the
// broken filter stored the rewritten tail, so the next delta glued onto the
// REWRITE instead of the raw word.
test("createTextFilter never rewrites a word cut at a delta boundary (F1)", () => {
	const pad = "x".repeat(60);
	for (const [a, b] of [
		["engram", "as"],
		["Pi agent", "e"],
		["ODD", "ITY"],
		["GentlePi", "e"],
	]) {
		const f = createTextFilter();
		const parts = [f.push(`${pad} ${a}`), f.push(b), f.flush()];
		assert.equal(parts.join(""), presentText(`${pad} ${a}${b}`), JSON.stringify({ a, b, parts }));
	}
});

// ----- F1 re-verify: the stream must be EXACTLY presentText(whole) -----------

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The stream of `text` split into deltas of `size`, plus flush, concatenated. */
const streamFor = (text, size) => {
	const f = createTextFilter();
	const parts = [];
	for (let i = 0; i < text.length; i += size) parts.push(f.push(text.slice(i, i + size)));
	parts.push(f.flush());
	return parts.join("");
};

// The verifier's exact reproductions, as named tests.
test("F1: «hola engram» + «s…» shows exactly presentText(whole) — no «memorys»", () => {
	const text = "hola engram" + "s" + "y".repeat(31);
	const f = createTextFilter();
	const parts = [f.push("hola engram"), f.push("s" + "y".repeat(31)), f.flush()];
	assert.equal(parts.join(""), presentText(text));
	assert.ok(parts.join("").includes("engrams"), JSON.stringify(parts));
	for (const size of [1, 2, 3, 5, 7, 11]) assert.equal(streamFor(text, size), presentText(text), `split ${size}`);
});

test("F1: «Los engramas son…» in fixed-size deltas 1..12 stays «engramas»", () => {
	const text = "Los engramas son recuerdos que Koda guarda en mi memoria. 🚀 y así. ";
	for (let size = 1; size <= 12; size++) {
		assert.equal(streamFor(text, size), presentText(text), `split ${size}`);
	}
});

test("F1: «ODDS|Pi coding agent» cuts never split a word into a phantom rewrite", () => {
	for (const text of ["ODDSPi coding agent", "ODDS Pi coding agent", "ODDS ODD Pi agent. engramas ODDITY GentlePie"]) {
		for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 26, 27, 32, 33, 64]) {
			assert.equal(streamFor(text, size), presentText(text), `split ${size} of ${JSON.stringify(text)}`);
		}
	}
});

test("F1: surrogate pairs are never split by the cut (emoji survive every split)", () => {
	const text = "Guardado 🙂🙂 con 👍🏽 y 𝄞 en mi memoria. ODD y RDD quedan como review. ";
	for (let size = 1; size <= 8; size++) {
		assert.equal(streamFor(text, size), presentText(text), `split ${size}`);
	}
});

test("F1: a removed /gentle: token never leaves double spaces in the stream", () => {
	for (const text of ["Run /gentle:memory-save now", "a /gentle:x  b", "x  /gentle:abc  y", " /gentle:x", "/gentle:x", "hola /gentle:"])
		for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 26, 27, 32, 33, 64])
			assert.equal(streamFor(text, size), presentText(text), `split ${size} of ${JSON.stringify(text)}`);
});

// The design property: for EVERY way of splitting ANY stream into deltas, the
// concatenated stream is EXACTLY presentText(wholeText). 200000 seeded random
// streams (vocabulary covers every hidden name, near-miss words, /gentle:
// tokens, spaces, punctuation, accented letters and emoji) split at random
// positions. Seed 0x6b6f6461 ("koda") — reproducible with mulberry32 above.
test("F1 property: 200000 seeded random streams equal presentText(whole) for every random split", () => {
	const TOKENS = [
		// every hidden name
		"Gentle Shell", "gentle-shell", "GentleShell", "el Gentleman", "Gentle AI", "gentle-ai", "gentle pi",
		"pi-coding-agent", "Pi coding agent", "Pi agent", "Pi runtime", "Pi harness", "Abito island",
		"abito-island", "engram", "Engram", "ODD", "organic driven development",
		"/gentle:", "/gentle:memory-save", "/gentle:x", "RDD", "receipt-driven development",
		// near misses the old filter corrupted
		"engramas", "engrams", "ODDS", "ODDITY", "Pipe", "pico", "Gentleman's", "GentlePie", "xengram",
		"engramx", "Abito", "abitolateral", "Raspberry Pi", "paid", "RDDs", "PI", "engramá",
		// ordinary filler
		"hola", "Los", "son", "recuerdos", "the", "and", "memory", "setup", "x", "y", "abc", "word",
		// punctuation and whitespace runs
		".", ",", ";", ":", "!", "?", "-", " ", "  ", "   ",
		// accented letters and emoji (surrogate pairs)
		"á", "éíóúñ", "ç", "ü", "🙂", "👍🏽", "🚀", "𝄞",
	];
	const rand = mulberry32(0x6b6f6461);
	const pick = () => TOKENS[Math.floor(rand() * TOKENS.length)];
	const STREAMS = 200_000;
	for (let i = 0; i < STREAMS; i++) {
		const tokenCount = 2 + Math.floor(rand() * 9);
		const parts = [];
		for (let k = 0; k < tokenCount; k++) parts.push(pick());
		const text = parts.join("");
		const f = createTextFilter();
		const out = [];
		const deltas = 1 + Math.floor(rand() * 5);
		let at = 0;
		for (let d = 0; d < deltas; d++) {
			const cut = at + 1 + Math.floor(rand() * 12);
			if (cut >= text.length) break;
			out.push(f.push(text.slice(at, cut)));
			at = cut;
		}
		out.push(f.push(text.slice(at)));
		out.push(f.flush());
		const want = presentText(text);
		assert.equal(out.join(""), want, `stream ${i}: ${JSON.stringify({ text })}`);
	}
});
