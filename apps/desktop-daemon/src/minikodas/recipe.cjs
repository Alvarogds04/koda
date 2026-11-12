"use strict";

/**
 * K2-13 Minikodas (T3, S4/S7): the recipe of one Minikoda and its strict validation. Pure: no I/O.
 *
 * A recipe is {id, name, when, reads, kit, prompt, model, never}:
 * - when   exactly one of {manual: true}, {everyMs: n} or {at: ISO date};
 * - reads  {source: "<descriptor>"}; the daemon prepares the content of that source for each run and hands it to the
 *          Minikoda only through `source_read`. A `telegram:@canal` descriptor is a public channel read with the
 *          user's own account (S6) and is validated here, at creation (telegram-source.cjs owns the grammar);
 * - kit    names from the CLOSED catalogue below, nothing else;
 * - prompt the Minikoda's specialised prompt (the calidad round showed a specialised prompt is what matters);
 * - model  {provider, id, accountId} chosen from the accounts Koda already has (validated by model.cjs);
 * - never  the verbs a Minikoda never does on its own; it must list all of buy, sell, send and delete.
 * Anything else (unknown fields, unknown kit pieces, out-of-range values) is refused, never repaired.
 */

const { parseSource, looksLikeChannel } = require("./telegram-source.cjs");

/** The closed kit catalogue: every tool a recipe may put in its kit. */
const KIT_CATALOGUE = Object.freeze(["source_read", "inbox_propose"]);
/** What a Minikoda never does alone. The recipe must say so explicitly (all four). */
const REQUIRED_NEVER = Object.freeze(["buy", "sell", "send", "delete"]);
/** The only actions `inbox_propose` parks (S5). Anything else is refused with an error the model sees. */
const PROPOSAL_ACTIONS = Object.freeze(["buy", "sell", "send"]);

const LIMITS = Object.freeze({
	maxNameChars: 80,
	maxSourceChars: 200,
	maxPromptChars: 16_000,
	maxModelIdChars: 200,
	/** Smallest `everyMs` in production; tests inject a smaller one through the service. */
	minEveryMs: 60_000,
	maxEveryMs: 7 * 24 * 60 * 60_000,
	/** Furthest `at` accepted (one year). */
	maxAtAheadMs: 366 * 24 * 60 * 60_000,
});

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STRICT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Control characters except tab and newline (a prompt has lines). */
const PROMPT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const RECIPE_KEYS = ["id", "name", "when", "reads", "kit", "prompt", "model", "never"];

class RecipeError extends Error {
	constructor(message) {
		super(`invalid recipe: ${message}`);
		this.name = "RecipeError";
		this.code = "bad_request";
	}
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (why) => {
	throw new RecipeError(why);
};
const onlyKeys = (value, keys, what) => {
	const extra = Object.keys(value).filter((k) => !keys.includes(k));
	if (extra.length) fail(`${what} has unknown fields`);
};

function validateWhen(when, { minEveryMs, now }) {
	if (!isObject(when)) fail("when is required");
	const keys = Object.keys(when);
	if (keys.length !== 1 || !["manual", "everyMs", "at"].includes(keys[0])) fail("when needs exactly one of manual, everyMs or at");
	if (keys[0] === "manual") {
		if (when.manual !== true) fail("when.manual must be true");
		return { manual: true };
	}
	if (keys[0] === "everyMs") {
		if (!Number.isSafeInteger(when.everyMs) || when.everyMs < minEveryMs || when.everyMs > LIMITS.maxEveryMs) fail(`when.everyMs must be an integer between ${minEveryMs} and ${LIMITS.maxEveryMs}`);
		return { everyMs: when.everyMs };
	}
	if (typeof when.at !== "string" || when.at.length > 40) fail("when.at must be an ISO date");
	const at = Date.parse(when.at);
	if (Number.isNaN(at)) fail("when.at must be an ISO date");
	if (now !== undefined && (at <= now || at - now > LIMITS.maxAtAheadMs)) fail("when.at must be in the future (at most one year ahead)");
	return { at: new Date(at).toISOString() };
}

function validateModel(model) {
	if (!isObject(model)) fail("model must be an object");
	onlyKeys(model, ["provider", "id", "accountId"], "model");
	if (typeof model.provider !== "string" || !STRICT_ID.test(model.provider)) fail("model.provider is invalid");
	if (typeof model.id !== "string" || model.id.trim() === "" || model.id.length > LIMITS.maxModelIdChars || CONTROL.test(model.id)) fail("model.id is invalid");
	if (model.accountId !== undefined && (typeof model.accountId !== "string" || !STRICT_ID.test(model.accountId))) fail("model.accountId is invalid");
	return { provider: model.provider, id: model.id, ...(model.accountId !== undefined ? { accountId: model.accountId } : {}) };
}

/**
 * `reads.source`: a plain text descriptor, or `telegram:@canal`. The Telegram form is checked HERE, when the Minikoda is
 * created, and not at run time: a channel typed without the prefix (`@canal`, `t.me/canal`) would otherwise be accepted
 * as a text file name and read as empty on every run, and a typo inside `telegram:` would only fail at 3 a.m.
 */
function validateSource(value) {
	if (typeof value !== "string" || value.trim() === "" || value.length > LIMITS.maxSourceChars || CONTROL.test(value)) {
		fail(`reads.source must be 1-${LIMITS.maxSourceChars} chars`);
	}
	const source = value.trim();
	if (looksLikeChannel(source)) {
		fail(`reads.source: para leer un canal de Telegram hace falta el prefijo «telegram:» (escribí «telegram:${source}»)`);
	}
	if (parseSource(source) === undefined) {
		fail("reads.source: eso no es un canal de Telegram válido (usá «telegram:@canal» o un enlace t.me del canal)");
	}
	return source;
}

function validateRecipe(raw, options = {}) {	const draft = options.draft === true;
	const minEveryMs = options.minEveryMs ?? LIMITS.minEveryMs;
	if (!isObject(raw)) fail("not an object");
	onlyKeys(raw, RECIPE_KEYS, "recipe");
	const { id, name, when, reads, kit, prompt, model, never } = raw;
	if (!(draft && id === undefined) && (typeof id !== "string" || !ID.test(id))) fail("id must be [a-z0-9-], 1-40 chars");
	if (typeof name !== "string" || name.trim() === "" || name.length > LIMITS.maxNameChars || CONTROL.test(name)) fail(`name must be 1-${LIMITS.maxNameChars} chars`);
	const normalizedWhen = validateWhen(when, { minEveryMs, now: options.now });
	if (!isObject(reads)) fail("reads must be {source}");
	onlyKeys(reads, ["source"], "reads");
	const source = validateSource(reads.source);
	if (!Array.isArray(kit) || kit.length === 0 || kit.length > KIT_CATALOGUE.length) fail("kit must be a non-empty list");
	for (const piece of kit) if (typeof piece !== "string" || !KIT_CATALOGUE.includes(piece)) fail("kit has a piece outside the closed catalogue");
	if (new Set(kit).size !== kit.length) fail("kit has duplicates");
	if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > LIMITS.maxPromptChars || PROMPT_CONTROL.test(prompt)) fail(`prompt must be 1-${LIMITS.maxPromptChars} chars`);
	if (!draft && model === undefined) fail("model is required");
	const normalizedModel = model === undefined ? undefined : validateModel(model);
	if (!Array.isArray(never) || never.length !== REQUIRED_NEVER.length || new Set(never).size !== never.length) fail(`never must be exactly ${REQUIRED_NEVER.join(", ")}`);
	for (const verb of never) if (!REQUIRED_NEVER.includes(verb)) fail(`never must be exactly ${REQUIRED_NEVER.join(", ")}`);
	return Object.freeze({
		...(id !== undefined ? { id } : {}),
		name: name.trim(),
		when: Object.freeze(normalizedWhen),
		reads: Object.freeze({ source }),
		kit: Object.freeze([...kit]),
		prompt,
		...(normalizedModel ? { model: Object.freeze(normalizedModel) } : {}),
		never: Object.freeze([...REQUIRED_NEVER]),
	});
}

/** A plain (unfrozen) copy for JSON and DTOs. */
function recipeToJson(r) {
	return {
		id: r.id,
		name: r.name,
		when: { ...r.when },
		reads: { ...r.reads },
		kit: [...r.kit],
		prompt: r.prompt,
		model: { ...r.model },
		never: [...r.never],
	};
}

module.exports = { KIT_CATALOGUE, REQUIRED_NEVER, PROPOSAL_ACTIONS, LIMITS, RecipeError, validateRecipe, recipeToJson, ID_PATTERN: ID };
