"use strict";

/**
 * K2-13 (S7, S18): the global transcription setting, stored in the daemon config (`config.json` key `transcription`).
 * «Podemos hacer que el usuario escoja el modelo para ello» + «1 para los 2»: the user chooses how a Minikoda
 * transcribes the videos and audios it reads.
 *
 *   {mode: "local-parakeet", language}             default (S16): Parakeet v3 int8 on this computer, no network
 *   {mode: "remote", language, remote: {accountId, model}}
 *                                                  an OpenAI-compatible account Koda already has (a custom gateway
 *                                                  account: its Base URL and key come from that account, never
 *                                                  from this setting), e.g. NaN's `whisper`
 *
 * S18 (human decision L32, «pues usamos solo ese modelo»): Parakeet is the ONLY local model. The local
 * `local-whisper-turbo` option of the first build is gone — from this validator, from the protocol frames and from
 * Ajustes. A config stored by that build is migrated to `local-parakeet` on load (migrateTranscriptionSetting), so
 * an island written by an older version keeps working instead of becoming unreadable.
 *
 * `language` defaults to "es". No dependencies: config.cjs and protocol.cjs both use it.
 */

const MODES = Object.freeze(["local-parakeet", "remote"]);
/** S18: modes an earlier build could store, accepted ONLY when migrating a stored config. */
const REMOVED_MODES = Object.freeze(["local-whisper-turbo"]);
const LANGUAGES = Object.freeze(["es", "en", "fr", "de", "it", "pt", "ca"]);
const TRANSCRIPTION_DEFAULT = Object.freeze({ mode: "local-parakeet", language: "es" });
const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The helper's catalog model id for each local mode (S18: exactly one local model). */
const LOCAL_MODELS = Object.freeze({ "local-parakeet": "parakeet-tdt-0.6b-v3-int8" });

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const refuse = () => {
	throw new Error("invalid transcription setting");
};

/** Strict: unknown keys, modes, languages or a malformed remote are refused (never a silent fallback). */
function validateTranscriptionSetting(raw) {
	if (!isObject(raw)) refuse();
	for (const key of Object.keys(raw)) if (!["mode", "language", "remote"].includes(key)) refuse();
	if (!MODES.includes(raw.mode)) refuse();
	const language = raw.language ?? TRANSCRIPTION_DEFAULT.language;
	if (!LANGUAGES.includes(language)) refuse();
	const out = { mode: raw.mode, language };
	if (raw.mode === "remote") {
		const r = raw.remote;
		if (!isObject(r)) refuse();
		for (const key of Object.keys(r)) if (key !== "accountId" && key !== "model") refuse();
		if (typeof r.accountId !== "string" || !ACCOUNT_ID.test(r.accountId)) refuse();
		if (typeof r.model !== "string" || r.model.trim() === "" || r.model.length > 200 || CONTROL.test(r.model)) refuse();
		out.remote = { accountId: r.accountId, model: r.model };
	} else if (raw.remote !== undefined) {
		refuse();
	}
	return out;
}

/**
 * S18: the validator for a setting READ BACK from disk. A stored `local-whisper-turbo` (the removed local Whisper
 * option) becomes `local-parakeet` and keeps its language; everything else is validated exactly as a client frame is.
 * Only the removed MODE is migrated — an unknown mode, an extra key or a bad language is still refused.
 */
function migrateTranscriptionSetting(raw) {
	if (isObject(raw) && REMOVED_MODES.includes(raw.mode)) return validateTranscriptionSetting({ ...raw, mode: "local-parakeet" });
	return validateTranscriptionSetting(raw);
}

module.exports = {
	TRANSCRIPTION_DEFAULT,
	TRANSCRIPTION_MODES: MODES,
	TRANSCRIPTION_LANGUAGES: LANGUAGES,
	TRANSCRIPTION_REMOVED_MODES: REMOVED_MODES,
	LOCAL_MODELS,
	validateTranscriptionSetting,
	migrateTranscriptionSetting,
};
