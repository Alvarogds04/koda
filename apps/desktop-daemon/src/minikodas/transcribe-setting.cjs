"use strict";

/**
 * K2-13 (S7, S16): the global transcription setting, stored in the daemon config (`config.json` key `transcription`).
 * «Podemos hacer que el usuario escoja el modelo para ello» + «1 para los 2»: the user chooses how a Minikoda
 * transcribes the videos and audios it reads.
 *
 *   {mode: "local-parakeet"}                       default (S16): Parakeet v3 int8 on this computer, no network
 *   {mode: "local-whisper-turbo", language}        Whisper turbo int8 on this computer (better on company names,
 *                                                  slower, ~2.5 GB RAM); the language is always fixed
 *   {mode: "remote", language, remote: {accountId, model}}
 *                                                  an OpenAI-compatible account Koda already has (a custom gateway
 *                                                  account: its Base URL and key come from that account, never
 *                                                  from this setting), e.g. NaN's `whisper`
 *
 * `language` defaults to "es". No dependencies: config.cjs and protocol.cjs both use it.
 */

const MODES = Object.freeze(["local-parakeet", "local-whisper-turbo", "remote"]);
const LANGUAGES = Object.freeze(["es", "en", "fr", "de", "it", "pt", "ca"]);
const TRANSCRIPTION_DEFAULT = Object.freeze({ mode: "local-parakeet", language: "es" });
const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The helper's catalog model id for each local mode. */
const LOCAL_MODELS = Object.freeze({ "local-parakeet": "parakeet-tdt-0.6b-v3-int8", "local-whisper-turbo": "whisper-turbo" });

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

module.exports = { TRANSCRIPTION_DEFAULT, TRANSCRIPTION_MODES: MODES, TRANSCRIPTION_LANGUAGES: LANGUAGES, LOCAL_MODELS, validateTranscriptionSetting };
