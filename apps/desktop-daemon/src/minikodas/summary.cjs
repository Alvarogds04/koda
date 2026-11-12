"use strict";

/**
 * K2-13 Minikodas (T5, S1/S7): the plain-language summary of a DRAFT, built deterministically from the
 * validated recipe alone. S1: «Koda me muestra en simple qué entendió (cuándo corre, qué lee, qué hace, dónde
 * me lo muestra y qué nunca hará solo) y solo lo crea si lo apruebo»; S7 adds «Con qué modelo».
 *
 * There is NO model call here: the same recipe always renders the same text. The summary is the approval
 * preview, so it carries nothing the recipe does not say: the never list, the source descriptor, the task
 * text and, for the model, only its VISIBLE account label (never the accountId, a credential or a file path).
 * Every piece is sanitised to one plain line: Unicode format characters (Cf: bidi overrides such as U+202E,
 * zero-width characters), control characters and line breaks go, and long text is cut with an ellipsis.
 */

/** The fixed sections, in order. The titles are what the island and the chat show. */
const TITLES = Object.freeze({
	when: "Cuándo corre",
	reads: "Qué lee",
	does: "Qué hace",
	shows: "Dónde te lo muestra",
	never: "Qué nunca hará solo",
	model: "Con qué modelo",
});
const SECTION_ORDER = Object.freeze(["when", "reads", "does", "shows", "never", "model"]);

const LIMITS = Object.freeze({
	/** «Qué hace» is the recipe's task text, trimmed to something a person reads at a glance. */
	maxTaskBytes: 512,
	/** Every section, and the whole text block: bytes, not characters (this is what the frame caps). */
	maxSectionBytes: 512,
	maxTextBytes: 3600,
});

/** The verbs a Minikoda never does alone, in plain Spanish (recipe `never`). */
const NEVER_VERBS = Object.freeze({ buy: "compra", sell: "vende", send: "envía", delete: "borra" });

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;

/** One plain line: no Cf (bidi, zero-width), no control characters, no breaks; trailing/leading space trimmed. */
function plainLine(value) {
	return String(value ?? "")
		.replace(/\p{Cf}/gu, "")
		.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** A text block cut to `max` BYTES at a line boundary (the lines are already plain), ending in «…». */
function clipBlock(lines, max) {
	const text = lines.join("\n");
	if (Buffer.byteLength(text) <= max) return text;
	const kept = [];
	for (const line of lines) {
		if (Buffer.byteLength([...kept, line, "…"].join("\n")) > max) break;
		kept.push(line);
	}
	return [...kept, "…"].join("\n");
}

/** A plain line cut to `max` BYTES, ending in «…» when something was left out. */
function clipBytes(value, max) {
	const text = plainLine(value);
	if (Buffer.byteLength(text) <= max) return text;
	let cut = text.slice(0, max);
	while (cut !== "" && Buffer.byteLength(`${cut}…`) > max) cut = cut.slice(0, -1);
	return `${cut.trimEnd()}…`;
}

const withStop = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** «cada 5 minutos» / «cada hora» / «cada 90 minutos»: the plain repeat of `when.everyMs`. */
function everyText(everyMs) {
	if (everyMs % HOUR_MS === 0) {
		const n = everyMs / HOUR_MS;
		return n === 1 ? "Corre solo, cada hora." : `Corre solo, cada ${n} horas.`;
	}
	if (everyMs % MINUTE_MS === 0) {
		const n = everyMs / MINUTE_MS;
		return n === 1 ? "Corre solo, cada minuto." : `Corre solo, cada ${n} minutos.`;
	}
	const n = Math.max(1, Math.round(everyMs / 1000));
	return n === 1 ? "Corre solo, cada segundo." : `Corre solo, cada ${n} segundos.`;
}

/** «Corre una sola vez, el 20/11/2026 a las 14:30 (UTC).» `at` is stored normalized to UTC by recipe.cjs. */
function atText(at) {
	const d = new Date(at);
	if (Number.isNaN(d.getTime())) return "Corre una sola vez, a una hora que no pude leer.";
	const pad = (n) => String(n).padStart(2, "0");
	const date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
	return `Corre una sola vez, el ${date} a las ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC).`;
}

function whenText(when) {
	if (when?.manual === true) return "Corre solo cuando lo lances vos, a mano.";
	if (Number.isSafeInteger(when?.everyMs)) return everyText(when.everyMs);
	if (typeof when?.at === "string") return atText(when.at);
	return "Corre cuando lo lances vos, a mano.";
}

/** «compra, vende, envía ni borra»: the recipe's `never` list as plain Spanish verbs, in the recipe's order. */
function neverList(never) {
	const verbs = (Array.isArray(never) ? never : []).map((v) => NEVER_VERBS[v]).filter(Boolean);
	if (verbs.length === 0) return "";
	if (verbs.length === 1) return verbs[0];
	return `${verbs.slice(0, -1).join(", ")} ni ${verbs[verbs.length - 1]}`;
}

function neverText(never) {
	const list = neverList(never);
	if (list === "") return "No hace nada de eso solo: lo deja propuesto en «Hoy» y espera tu aprobación.";
	return `Nunca ${list} solo. Si hace falta algo así, queda propuesto en «Hoy» y espera tu aprobación.`;
}

/**
 * «Con qué modelo»: the visible account label plus the model id, or «el mismo del chat» when the recipe kept
 * the chat's model (S7 default). The accountId, the credential and any path are never part of the text: only
 * the label a person sees in Ajustes.
 */
function modelText(model, { accountLabel, modelIsDefault }) {
	if (modelIsDefault === true) return "Usa el mismo modelo del chat.";
	const id = clipBytes(model?.id, 120);
	const provider = clipBytes(model?.provider, 60);
	const label = clipBytes(accountLabel, 80);
	if (label !== "") return withStop(`Usa ${label}, el modelo ${id}`);
	return withStop(`Usa el modelo ${provider}/${id}`);
}

function sectionText(key, recipe, options) {
	if (key === "when") return clipBytes(whenText(recipe.when), LIMITS.maxSectionBytes);
	if (key === "reads") return clipBytes(withStop(`Lee ${clipBytes(recipe.reads?.source, 200)}`), LIMITS.maxSectionBytes);
	if (key === "does") return clipBytes(recipe.prompt, LIMITS.maxTaskBytes) || "No me quedó claro qué tiene que hacer.";
	if (key === "shows") return "Te lo muestra en «Hoy», la bandeja de Koda.";
	if (key === "never") return clipBytes(neverText(recipe.never), LIMITS.maxSectionBytes);
	return clipBytes(modelText(recipe.model, options), LIMITS.maxSectionBytes);
}

/**
 * Builds the summary of one recipe: `{sections: [{key, title, text}], text}`. Pure and deterministic.
 * @param {object} recipe  a VALIDATED recipe (recipe.cjs); nothing else is read
 * @param {object} [options]
 * @param {string} [options.accountLabel]  the chosen account's visible label (never its id)
 * @param {boolean} [options.modelIsDefault]  true when the recipe kept the chat's current model
 */
function buildSummary(recipe, { accountLabel, modelIsDefault = false } = {}) {
	const options = { accountLabel, modelIsDefault };
	const sections = SECTION_ORDER.map((key) => ({ key, title: TITLES[key], text: sectionText(key, recipe, options) }));
	const lines = sections.map((s) => `${s.title}: ${s.text}`);
	return { sections, text: clipBlock(lines, LIMITS.maxTextBytes) };
}

module.exports = { buildSummary, SECTION_ORDER, TITLES, LIMITS: Object.freeze({ ...LIMITS }) };
