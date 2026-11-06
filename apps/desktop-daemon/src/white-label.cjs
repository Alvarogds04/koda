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
 * Koda additions over the upstream port: the internal 0.1 product name Abito
 * (and its memory project abito-island, whose NAME stays `abito-island` —
 * S4 — but is rewritten in shown text) and the bare engine name Pi are hidden
 * too, matching the product identity document identity.md.
 */

/** Internal names that must never reach the user. */
const HIDDEN_NAMES = [
	/gentle[ -]?shell/i,
	/el gentleman/i,
	/gentle[ -]?ai/i,
	/gentle[ -]?pi/i,
	/\bpi[ -]coding[ -]agent\b/i,
	/\bAbito\b/i,
	/\bengram\b/i,
	/\bODD\b/,
	/organic driven development/i,
	/\/gentle:/i,
	/\bRDD\b/,
	/\bPi\b/,
];

const REWRITES = [
	[/\/gentle:[\w:-]+/gi, ""],
	[/\bel gentleman\b/gi, "Koda"],
	[/\bAbito island\b/gi, "Koda"],
	[/\babito-island\b/gi, "my memory"],
	[/\bAbito\b/gi, "Koda"],
	[/\bgentle[ -]?(?:shell|ai|pi)\b/gi, "Koda"],
	[/\bpi[ -]coding[ -]agent\b/gi, "assistant"],
	[/\bPi (?:coding agent|agent|runtime|harness)\b/g, "assistant"],
	[/\borganic driven development\b/gi, "my workflow"],
	[/\bODD\b/g, "workflow"],
	[/\bengram\b/gi, "memory"],
	[/\breceipt-driven development\b/gi, "review"],
	[/\bRDD\b/g, "review"],
	[/\bPi\b/g, "assistant"],
];

/** Rewrites internal names in harness-generated text shown to the user. */
function presentText(text) {
	let shown = text;
	for (const [pattern, replacement] of REWRITES) shown = shown.replace(pattern, replacement);
	return shown.replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1");
}

/** Informational notifications are harness chatter; warnings and errors still reach the user. */
function shouldShowToast(level) {
	return level !== "info";
}

/** Internal slash commands are not part of the product. */
function isBlockedInput(text) {
	return /^\s*\/gentle:/i.test(text);
}

module.exports = { HIDDEN_NAMES, REWRITES, presentText, shouldShowToast, isBlockedInput };
