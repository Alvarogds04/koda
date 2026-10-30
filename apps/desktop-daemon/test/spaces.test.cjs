"use strict";

// #376 (OD026) — multi-Space access per Dot, re-checked on every tool use.
// Pure policy tests against a FAKE engine: a store of dot grants the engine consults through
// a resolver, so the re-check semantics (revocation takes effect on the NEXT call, without
// restart) are exercised exactly as a real call site would. The module is tested before the
// implementation (RED → GREEN). Nothing here touches the real engine or the filesystem.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	MAX_SPACES,
	MAX_SPACE_CHARS,
	normalizeSpaceName,
	normalizeGrants,
	effectiveGrants,
	checkToolUse,
} = require("../src/spaces.cjs");

/** A fake engine: the live grant store plus the ONE policy call it must make per tool use. */
function fakeEngine(store) {
	let checks = 0;
	return {
		checks: () => checks,
		grantsFor(dotId) {
			checks += 1;
			return Object.prototype.hasOwnProperty.call(store, dotId) ? store[dotId] : null;
		},
		toolUse(dotId, space) {
			return checkToolUse((id) => this.grantsFor(id), { dotId, space });
		},
	};
}

const DOT = "esp-0011223344556677";

test("space names are bounded plain text, hostile values normalize to nothing", () => {
	assert.equal(MAX_SPACE_CHARS, 80);
	assert.equal(normalizeSpaceName("Investigación"), "Investigación");
	assert.equal(normalizeSpaceName("  Archivo  "), "Archivo", "names are stored trimmed");
	assert.equal(normalizeSpaceName("x".repeat(MAX_SPACE_CHARS)), "x".repeat(MAX_SPACE_CHARS));
	for (const bad of [undefined, null, 7, {}, "", "   ", "x\n", "x\t", "x\u{0}", "x\u{1b}", "x\u{7f}", "x".repeat(MAX_SPACE_CHARS + 1)]) {
		assert.equal(normalizeSpaceName(bad), null, `${String(bad).slice(0, 12)} normalizes to null`);
	}
});

test("grants are declarative and fail closed: hostile entries are dropped, never executed", () => {
	assert.deepEqual(normalizeGrants(undefined), { defaultSpace: null, spaces: [] });
	assert.deepEqual(normalizeGrants({}), { defaultSpace: null, spaces: [] });
	assert.deepEqual(
		normalizeGrants({ defaultSpace: "  Mi espacio  ", spaces: ["B", "A", "B", 7, "x\n", "  A  "] }),
		{ defaultSpace: "Mi espacio", spaces: ["B", "A"] },
		"hostile entries are dropped, duplicates collapse, first occurrence wins, values trimmed",
	);
	// The default Space may also arrive under the #375 field name.
	assert.deepEqual(normalizeGrants({ space: "Investigación", spaces: [] }), { defaultSpace: "Investigación", spaces: [] });
	// An over-cap stored list is truncated, never fatal.
	const over = Array.from({ length: MAX_SPACES + 4 }, (_, k) => `s${k}`);
	assert.equal(normalizeGrants({ spaces: over }).spaces.length, MAX_SPACES);
	assert.deepEqual(normalizeGrants({ spaces: "B" }), { defaultSpace: null, spaces: [] }, "a wrongly typed list is absent");
});

test("effective grants: no fields is unrestricted (today's behaviour), otherwise the closed list", () => {
	assert.equal(effectiveGrants({ defaultSpace: null, spaces: [] }), null, "no Space fields at all restricts nothing");
	assert.deepEqual(effectiveGrants({ defaultSpace: "Investigación", spaces: [] }), ["Investigación"]);
	assert.deepEqual(
		effectiveGrants({ defaultSpace: "Investigación", spaces: ["Archivo", "B"] }),
		["Investigación", "Archivo", "B"],
		"the default Space is always granted alongside the explicit list",
	);
	assert.deepEqual(effectiveGrants({ defaultSpace: null, spaces: ["B"] }), ["B"]);
});

test("the fake engine is allowed its default Space and refused others with one closed reason", () => {
	const engine = fakeEngine({ [DOT]: { defaultSpace: "Investigación", spaces: [] } });
	assert.deepEqual(engine.toolUse(DOT, "Investigación"), { allowed: true });
	assert.deepEqual(engine.toolUse(DOT, "Archivo"), { allowed: false, reason: "space_not_granted" });
	assert.equal(engine.checks(), 2);
});

test("a listed dot may touch every listed Space and nothing else", () => {
	const engine = fakeEngine({ [DOT]: { defaultSpace: "Investigación", spaces: ["Archivo", "B"] } });
	for (const granted of ["Investigación", "Archivo", "B"]) {
		assert.deepEqual(engine.toolUse(DOT, granted), { allowed: true }, granted);
	}
	assert.deepEqual(engine.toolUse(DOT, "Otro"), { allowed: false, reason: "space_not_granted" });
	// A hostile name in a request can never match a valid grant.
	assert.deepEqual(engine.toolUse(DOT, "Archivo\u{0}"), { allowed: false, reason: "space_not_granted" });
});

test("revocation takes effect on the NEXT tool use, without restarting the engine", () => {
	const store = { [DOT]: { defaultSpace: "Investigación", spaces: ["Archivo"] } };
	const engine = fakeEngine(store);
	assert.deepEqual(engine.toolUse(DOT, "Archivo"), { allowed: true });
	// The human revokes the grant in the dot's CURRENT list (the same live object the
	// resolver re-reads). No restart happens: the very next call is refused.
	store[DOT] = { defaultSpace: "Investigación", spaces: [] };
	assert.deepEqual(engine.toolUse(DOT, "Archivo"), { allowed: false, reason: "space_not_granted" });
	assert.deepEqual(engine.toolUse(DOT, "Investigación"), { allowed: true }, "the default Space survives the revocation");
	// Re-granting works the same way, again with no restart.
	store[DOT] = { defaultSpace: "Investigación", spaces: ["Archivo"] };
	assert.deepEqual(engine.toolUse(DOT, "Archivo"), { allowed: true });
	// The re-check is structural: the resolver runs once per tool use, never cached.
	assert.equal(engine.checks(), 4);
});

test("an unrestricted dot and unscoped tool uses keep today's behaviour", () => {
	const engine = fakeEngine({ [DOT]: {} });
	assert.equal(effectiveGrants(normalizeGrants(engine.grantsFor(DOT))), null);
	assert.deepEqual(engine.toolUse(DOT, "cualquiera"), { allowed: true }, "no Space fields restrict nothing");
	// A tool use that does not name a Space is out of policy scope, even for a restricted dot.
	const restricted = fakeEngine({ [DOT]: { defaultSpace: "Investigación", spaces: [] } });
	assert.deepEqual(restricted.toolUse(DOT, undefined), { allowed: true });
	assert.deepEqual(restricted.toolUse(DOT, null), { allowed: true });
	// Out of policy scope: no Space is touched, so the resolver is never consulted.
	assert.equal(restricted.checks(), 0);
});

test("an unknown dot is refused fail-closed and refusals never mutate the store", () => {
	const store = { [DOT]: { defaultSpace: "Investigación", spaces: [] } };
	const before = JSON.stringify(store);
	const engine = fakeEngine(store);
	assert.deepEqual(engine.toolUse("esp-ffffffffffffffff", "Investigación"), { allowed: false, reason: "dot_unknown" });
	assert.deepEqual(engine.toolUse(DOT, "Archivo"), { allowed: false, reason: "space_not_granted" });
	assert.equal(JSON.stringify(store), before, "refused tool uses leave the grant store byte-identical");
});
