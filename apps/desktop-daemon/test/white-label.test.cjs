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
	// never be contradicted by what arrives later.
	const texts = [
		"Trabajo con el Gentle Shell y con engram a diario, pero ODD y RDD son míos: pi-coding-agent no.",
		"Gentle-pi, gentle-ai, el Gentleman, abito-island, /gentle:x, organic driven development.",
		"texto normal sin nada que ocultar. " + "z".repeat(200),
		"Gentle Shell",
		"a /gentle:" + "w".repeat(80),
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
