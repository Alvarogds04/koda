"use strict";

/**
 * White-label rewriter (K2-05 T2): internal names must never reach the user.
 *
 * Ported from the Gentle Dot daemon (MIT, Copyright (c) 2026 Gentleman
 * Programming), `packages/daemon/src/white-label.ts`; see
 * THIRD-PARTY-NOTICES.md. Pure module on purpose: protocol.cjs translateEvent
 * (harness-generated text shown to the user) must call presentText /
 * shouldShowToast, but protocol.cjs changes on another branch (K2-03), so the
 * wiring is a later step and this module ships with its own tests first.
 *
 * Koda additions over the upstream port, deliberately narrower than the first
 * cut (B3): only the internal 0.1 product PHRASES are hidden — the memory
 * project identifier `abito-island` (whose NAME stays `abito-island`, S4) and
 * the product phrase "Abito island" (case-sensitive). A bare "Pi"/"Abito"
 * rewrite would corrupt legitimate text ("Raspberry Pi", "abito a Roma") and
 * is NOT done; upstream's own rewrites are kept exactly as upstream has them.
 *
 * presentText must ONLY ever be applied to assistant/harness-generated text
 * shown to the user — never to the user's own text. Gentle Dot's bridge.ts
 * also applies it to queued user text; Koda must not: the user's own words
 * (their Raspberry Pi, their abito) are theirs and pass through untouched.
 *
 * Wiring (T2, after K2-03): protocol.cjs translateEvent applies presentText to
 * the streamed text deltas and the harness-generated ask titles/options and
 * toast messages the island will show; the daemon/server send intake refuses
 * `/gentle:` commands through isBlockedInput. Delta streams need more than a
 * per-chunk rewrite: a hidden name can arrive split across deltas ("Gentle" |
 * " Shell"), so createTextFilter holds back a bounded tail that could still
 * start one and flushes it at the end of the message.
 */

/** Internal names that must never reach the user. */
const HIDDEN_NAMES = [
	/gentle[ -]?shell/i,
	/el gentleman/i,
	/gentle[ -]?ai/i,
	/gentle[ -]?pi/i,
	/\bpi[ -]coding[ -]agent\b/i,
	/Abito island/,
	/abito-island/i,
	/\bengram\b/i,
	/\bODD\b/,
	/organic driven development/i,
	/\/gentle:/i,
	/\bRDD\b/,
];

const REWRITES = [
	[/\/gentle:[\w:-]+/gi, ""],
	[/\bel gentleman\b/gi, "Koda"],
	[/\bAbito island\b/g, "Koda"],
	[/\babito-island\b/gi, "my memory"],
	[/\bgentle[ -]?(?:shell|ai|pi)\b/gi, "Koda"],
	[/\bpi[ -]coding[ -]agent\b/gi, "assistant"],
	[/\bPi (?:coding agent|agent|runtime|harness)\b/g, "assistant"],
	[/\borganic driven development\b/gi, "my workflow"],
	[/\bODD\b/g, "workflow"],
	[/\bengram\b/gi, "memory"],
	[/\breceipt-driven development\b/gi, "review"],
	[/\bRDD\b/g, "review"],
];

/** Rewrites internal names in harness-generated text shown to the user. */
function presentText(text) {
	let shown = text;
	for (const [pattern, replacement] of REWRITES) shown = shown.replace(pattern, replacement);
	return shown.replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1");
}

/**
 * Streaming (T2): how much of a rewritten chunk may still be shown when more
 * text can arrive. Every rewrite match is bounded — the longest is 26 chars
 * ("organic driven development") — so holding back the last HOLD_MAX
 * characters guarantees that no bounded name is ever half-emitted: a name is
 * only emitted once its whole span is further than HOLD_MAX from the end, and
 * any partial match still open at the end of the text sits inside the held
 * tail. `/gentle:` is the one UNBOUNDED match (the command token can be any
 * length), so an open token is held from its `/` until it closes.
 */
const HOLD_MAX = 32;
const OPEN_COMMAND = /\/gentle:/i;
const OPEN_COMMAND_TAIL = /^[\w:-]*$/;

function stableLength(shown) {
	let keep = shown.length - HOLD_MAX;
	if (keep <= 0) return 0;
	const open = shown.toLowerCase().lastIndexOf("/gentle:");
	if (open !== -1 && open < keep && OPEN_COMMAND_TAIL.test(shown.slice(open + "/gentle:".length))) {
		keep = Math.min(keep, open);
	}
	// Defence in depth for a non-idempotent rewrite (the replacements never
	// produce matchable text, so `shown` should not contain any): a complete
	// match crossing the boundary is held whole instead of being split.
	for (;;) {
		let crossed = false;
		for (const [pattern] of REWRITES) {
			const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
			let match;
			while ((match = re.exec(shown)) !== null) {
				const end = match.index + match[0].length;
				if (match.index < keep && end > keep) {
					keep = match.index;
					crossed = true;
				}
				if (match.index === re.lastIndex) re.lastIndex++;
			}
		}
		if (!crossed) return keep;
	}
}

/**
 * A stateful delta-stream filter (T2): `push` returns the text that is safe to
 * show now (possibly ""), `flush` returns whatever is still held once no more
 * text can arrive (the end of the assistant's message). Only assistant/harness
 * deltas ever go through it; the user's own text never does.
 */
function createTextFilter() {
	let pending = "";
	return {
		push(delta) {
			pending += delta;
			const shown = presentText(pending);
			const keep = stableLength(shown);
			if (keep <= 0) return "";
			const out = shown.slice(0, keep);
			pending = shown.slice(keep);
			return out;
		},
		flush() {
			if (pending === "") return "";
			const out = presentText(pending);
			pending = "";
			return out;
		},
	};
}

/** Informational notifications are harness chatter; warnings and errors still reach the user. */
function shouldShowToast(level) {
	return level !== "info";
}

/** Internal slash commands are not part of the product. */
function isBlockedInput(text) {
	return /^\s*\/gentle:/i.test(text);
}

module.exports = { HIDDEN_NAMES, REWRITES, presentText, shouldShowToast, isBlockedInput, createTextFilter };
