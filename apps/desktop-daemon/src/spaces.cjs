"use strict";

/**
 * Abito island multi-Space access policy (#376, OD026).
 *
 * A specialist Dot may be granted access to several Spaces: a closed list of bounded names on
 * top of (and including) its own default Space name (#375). The default is the default Space
 * only; a dot that carries NEITHER field is unrestricted, which is exactly today's behaviour.
 *
 * This module is PURE POLICY: it never spawns, reads, writes or talks to the engine. The caller
 * supplies a `grantsFor(dotId)` resolver and this module calls it once per check. That makes the
 * re-check semantics structural: there is no snapshot and no cache, so revoking a Space takes
 * effect on the very next tool use, without restarting the daemon or the engine.
 *
 * CALL-SITE CONTRACT (for #418 / #374 — enforcement is DORMANT today: nothing calls this module
 * yet). On every tool use that names a Space, the caller MUST:
 *   1. resolve the tool use's target Space (or leave `space` unset for unscoped tool uses,
 *      which are out of policy scope and always allowed);
 *   2. call `checkToolUse(grantsFor, { dotId, space })` where `grantsFor` re-reads the dot's
 *      CURRENT grants from the live specialists store — never a copy taken at session start;
 *   3. refuse the tool use with the returned closed `reason` when `allowed` is false, leaving
 *      every stored value and counter unchanged.
 * The grants data itself is DECLARATIVE and fails closed on load: hostile entries are dropped
 * (never executed), duplicates collapse to the first occurrence and the list is capped.
 */

const MAX_SPACE_CHARS = 80;
/** The closed cap on a dot's extra Space NAMES: keeps the declarative list finite. */
const MAX_SPACES = 8;

/** Any control character (C0/C1, bidi, separators, lone surrogates): never accepted. */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A Space NAME is bounded plain text; anything hostile normalizes to `null` (dropped). */
function normalizeSpaceName(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_SPACE_CHARS) return null;
	if (FORBIDDEN_TEXT.test(trimmed) || FORBIDDEN_TEXT.test(value)) return null;
	return trimmed;
}

/**
 * The declarative grant data of one dot, normalized. Accepts `{ defaultSpace?, space?, spaces? }`
 * (`space` is the #375 field name); unknown shapes degrade to empty grants, never to an error.
 */
function normalizeGrants(dot) {
	if (!isObject(dot)) return { defaultSpace: null, spaces: [] };
	const defaultSpace = normalizeSpaceName(dot.defaultSpace ?? dot.space);
	const spaces = [];
	const list = Array.isArray(dot.spaces) ? dot.spaces : [];
	for (const entry of list) {
		if (spaces.length >= MAX_SPACES) break;
		const name = normalizeSpaceName(entry);
		if (name === null) continue;
		if (!spaces.includes(name)) spaces.push(name);
	}
	return { defaultSpace, spaces };
}

/**
 * The dot's current effective grants: the explicit list (plus the default Space, deduplicated)
 * when a list exists, else only the default Space, else `null` = UNRESTRICTED (today's
 * behaviour for a dot with no Space fields at all).
 */
function effectiveGrants(grants) {
	const { defaultSpace, spaces } = normalizeGrants(grants);
	if (defaultSpace === null && spaces.length === 0) return null;
	const out = defaultSpace === null ? [] : [defaultSpace];
	for (const name of spaces) if (!out.includes(name)) out.push(name);
	return out;
}

/**
 * ONE tool-use decision. `grantsFor(dotId)` is called exactly once per check and MUST return the
 * dot's CURRENT normalized grants (or `null` for an unknown dot, which is refused fail-closed).
 * Closed results only: `{ allowed: true }` or `{ allowed: false, reason }` with `reason` one of
 * `dot_unknown` (the resolver knows no such dot) or `space_not_granted` (the Space is not in the
 * dot's current list). A tool use that names no Space is out of policy scope and always allowed.
 * This function mutates nothing and stores nothing: refusals are pure.
 */
function checkToolUse(grantsFor, request) {
	const space = request && typeof request === "object" ? request.space : undefined;
	if (space === undefined || space === null) return { allowed: true };
	const dotId = request && typeof request === "object" ? request.dotId : undefined;
	const grants = typeof grantsFor === "function" ? grantsFor(dotId) : null;
	if (grants === null || grants === undefined) return { allowed: false, reason: "dot_unknown" };
	const current = effectiveGrants(grants);
	if (current === null) return { allowed: true }; // unrestricted dot: today's behaviour
	const name = normalizeSpaceName(space);
	if (name === null || !current.includes(name)) return { allowed: false, reason: "space_not_granted" };
	return { allowed: true };
}

module.exports = { MAX_SPACES, MAX_SPACE_CHARS, normalizeSpaceName, normalizeGrants, effectiveGrants, checkToolUse };
