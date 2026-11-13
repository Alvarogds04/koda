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
 * Streaming (T2, exact per the re-verification finding): the concatenated
 * stream must be EXACTLY presentText(wholeText) for EVERY way of splitting the
 * text into deltas. The filter emits presentText of a raw prefix ending at a
 * cut `p` only when the cut is safe in the strongest sense:
 *
 *  (a) no rewrite/hidden-name match in the CURRENT raw buffer starts before p
 *      and ends at or after p (a match that the buffer already shows is never
 *      cut, so a name is only ever rewritten whole);
 *  (b) at least the longest finite pattern match (26 chars: "organic driven
 *      development") of raw text is held back, so a match crossing the cut has
 *      to start inside the buffer — where (a) sees it — and a match still
 *      forming would have to be longer than every pattern. The unbounded
 *      exception is an open /gentle: token (its command tail can be any
 *      length): it is held whole from its `/` while its tail is still only
 *      command-token characters, however long it grows;
 *  (c) p is not between two word characters (the buffer-end \b of a phantom
 *      match like «engram|as» must never become a chunk-boundary rewrite) and
 *      not inside a UTF-16 surrogate pair;
 *  (d) p is never adjacent to a space: every run of spaces — and the
 *      punctuation or removed token it touches — stays inside ONE chunk, so
 *      presentText's space collapsing and space-before-punctuation stripping
 *      resolve exactly as they do over the whole text.
 *
 * Every adjustment only moves the cut LEFT, so the fixpoint terminates; when
 * the cut would be unsafe all the way to 0, nothing is emitted and the text is
 * held (flush rewrites whatever is still held at the end of the message).
 */
const HOLD_MAX = 32;
/** Longest finite rewrite/hidden-name match: "organic driven development" (26). */
const LONGEST_MATCH = 26;
const TOKEN_HEAD = "/gentle:";
/** All patterns a rewrite or a hidden-name match could still grow out of. */
const CUT_PATTERNS = [...HIDDEN_NAMES, ...REWRITES.map(([pattern]) => pattern)];
const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;
const isJsWord = (ch) => /[A-Za-z0-9_]/.test(ch);
const global_ = (pattern) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
/** The same pattern pinned to the start of the probe string (sticky). */
const sticky = (pattern) => new RegExp(pattern.source, `${pattern.flags.replace("g", "")}y`);
/** The same pattern pinned to the END of the probe string. */
const anchoredEnd = (pattern) => new RegExp(`${pattern.source}$`, pattern.flags.replace("g", ""));
/** Where the /gentle: token that starts at `at` ends (first non-command char), = length when still open. */
function tokenEnd(pending, at) {
	let i = at + TOKEN_HEAD.length;
	while (i < pending.length && /[\w:-]/.test(pending[i])) i += 1;
	return i;
}

/**
 * The largest raw prefix length that is safe to emit now (0 = hold everything).
 * Every rule below only moves the cut LEFT, so the fixpoint terminates.
 */
function stableRawLength(pending) {
	let keep = Math.max(0, pending.length - HOLD_MAX);
	for (;;) {
		const before = keep;
		const lower = pending.toLowerCase();
		// (b) Token composites (found by the F1 property test): removing a /gentle:
		// token WELDS the raw text around it into a new hidden name — «Abito» +
		// «/gentle:memory-saveAbito island» → «Abito island» → «Koda» — and that new
		// match reaches up to LONGEST_MATCH raw characters back from the token's
		// start and LONGEST_MATCH past its end. No cut may sit inside that span
		// (for a still-open token the end is the buffer end, so the whole token
		// neighbourhood is held, however long the command grows).
		for (let at = lower.indexOf(TOKEN_HEAD); at !== -1; at = lower.indexOf(TOKEN_HEAD, at + 1)) {
			const end = tokenEnd(pending, at);
			if (keep > at - LONGEST_MATCH && keep < end + LONGEST_MATCH) keep = Math.max(0, at - LONGEST_MATCH);
		}
		// (a) a bounded pattern match in the buffer that starts before the cut and
		// strictly crosses it: hold the cut at the match's first character. (Matches
		// are at most LONGEST_MATCH chars, so a window of ±LONGEST_MATCH sees every
		// crossing; a token that crosses is already excluded by the rule above.)
		const from = Math.max(0, keep - LONGEST_MATCH);
		const to = Math.min(pending.length, keep + LONGEST_MATCH);
		const window = pending.slice(from, to);
		for (const pattern of CUT_PATTERNS) {
			const re = global_(pattern);
			let match;
			while ((match = re.exec(window)) !== null) {
				const start = from + match.index;
				const end = start + match[0].length;
				if (start < keep && end > keep) keep = start;
				if (match.index === re.lastIndex) re.lastIndex++;
			}
		}
		// (d) whitespace stays whole inside one chunk: no cut adjacent to a space.
		// (c) no cut inside a UTF-16 surrogate pair.
		while (keep > 0 && keep < pending.length) {
			if (pending[keep - 1] === " " || pending[keep] === " ") { keep -= 1; continue; }
			if (isHighSurrogate(pending.charCodeAt(keep - 1)) && isLowSurrogate(pending.charCodeAt(keep))) { keep -= 1; continue; }
			break;
		}
		// (c) exact word-boundary rule: a cut between two word characters is safe
		// only when neither side can grow a phantom \b rewrite — no pattern may
		// match the prefix's tail ENDING at the cut (the prefix would rewrite it
		// through its end-of-string \b: «…engram|» + «s…» → «memory»), and no
		// pattern may match STARTING at the cut within the held window (the held
		// part would rewrite it through its start-of-string \b where the whole
		// text, with a word char before, has none).
		if (keep > 0 && keep < pending.length && isJsWord(pending[keep - 1]) && isJsWord(pending[keep])) {
			const prefixTail = pending.slice(Math.max(0, keep - LONGEST_MATCH), keep);
			const heldWindow = pending.slice(keep, Math.min(pending.length, keep + LONGEST_MATCH));
			let rejected = false;
			for (const pattern of CUT_PATTERNS) {
				if (!rejected && anchoredEnd(pattern).test(prefixTail)) rejected = true;
				if (!rejected && sticky(pattern).test(heldWindow)) rejected = true;
			}
			if (rejected) keep -= 1;
		}
		if (keep === before) break;
	}
	return keep;
}

/**
 * A stateful delta-stream filter (T2, exact per the re-verification finding):
 * `push` returns the text that is safe to show now (possibly ""), `flush`
 * returns whatever is still held once no more text can arrive (the end of the
 * assistant's message). For EVERY delta split the concatenated stream is
 * EXACTLY presentText(wholeText): cuts are only made where no rewrite match,
 * word boundary, surrogate pair or whitespace rule can still be contradicted
 * (see stableRawLength). Only assistant/harness deltas ever go through it; the
 * user's own text never does. The held tail is always RAW text.
 */
function createTextFilter() {
	let pending = "";
	return {
		push(delta) {
			pending += delta;
			const keep = stableRawLength(pending);
			if (keep <= 0) return "";
			const out = presentText(pending.slice(0, keep));
			pending = pending.slice(keep);
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
