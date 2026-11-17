"use strict";

/**
 * K2-13 Minikodas (T3, S7): the model of a Minikoda. «Podemos hacer que el usuario escoja el modelo para ello».
 *
 * The user picks the model of each Minikoda from the accounts Koda ALREADY has (auth.cjs accounts, the same
 * ones the chat's profiles use); nothing else is accepted, so a Minikoda never uses a service the user did
 * not configure. Without a choice, the default is the chat's current model: the active profile
 * (profiles.cjs) → {provider, id: modelId, accountId}.
 *
 * Validation (resolveModelChoice): the account must exist, be signed in (configured) and serve the provider;
 * a provider served by several accounts needs an explicit accountId; the model id must be one the account
 * offers (`listModels`, the same catalogue `models_list` shows; custom accounts: their discovered ids).
 *
 * Projection (projectModel): before each run the Minikoda's OWN private agent dir receives exactly that one
 * credential (the freshest copy, written back after the run: credentials.cjs, S11), the account's models.json and the model defaults — the same files profile activation writes
 * for the chat engine, never shared with it. A custom (LiteLLM/OpenAI-compatible) account is served only by
 * the guarded provider extension (custom-provider-extension.cjs), exactly like the chat.
 */

const { existsSync, readFileSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const { writePrivateFile } = require("../isolation.cjs");
const { EXTENSION_FILE, RUNTIME_FILE, TEMPLATE, runtimeDocument } = require("../custom-provider-extension.cjs");

class ModelChoiceError extends Error {
	constructor(reason) {
		super(`model choice refused: ${reason}`);
		this.name = "ModelChoiceError";
		this.code = "bad_request";
		this.reason = reason;
	}
}

const refuse = (reason) => {
	throw new ModelChoiceError(reason);
};

function readJson(file) {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The chat's current model (active profile), or undefined when the chat has none. */
function chatModel(profiles) {
	try {
		const { profiles: list, active } = profiles.list();
		const p = list.find((x) => x.id === active);
		return p ? { provider: p.provider, id: p.modelId, accountId: p.accountId } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Validates a model choice against the configured accounts and returns {provider, id, accountId}.
 * @param {object} args
 * @param {{provider:string,id:string,accountId?:string}|undefined} args.choice  undefined → the chat's model
 * @param {() => Array<{accountId,provider,configured,custom?,local?}>} args.listAccounts
 * @param {{list(): {profiles, active}}} [args.profiles]
 * @param {(provider:string, accountId:string) => Promise<Array<{provider,id}>>} args.listModels
 * @param {string} args.accountsRoot  accounts store (custom accounts: discovered ids live in their models.json)
 */
async function resolveModelChoice({ choice, listAccounts, profiles, listModels, accountsRoot }) {
	const wanted = choice ?? (profiles ? chatModel(profiles) : undefined);
	if (!wanted) refuse("no_model");
	const accounts = listAccounts().filter((a) => a.provider === wanted.provider);
	let account;
	if (wanted.accountId !== undefined) account = accounts.find((a) => a.accountId === wanted.accountId);
	else if (accounts.length === 1) account = accounts[0];
	else if (accounts.length > 1) refuse("ambiguous_account");
	if (!account) refuse("unknown_account");
	if (account.configured !== true) refuse("account_not_signed_in");
	let offered;
	if (account.custom === true) {
		const entry = readJson(path.join(accountsRoot, account.accountId, "models.json"))?.providers?.[account.provider];
		offered = runtimeDocument(account.provider, entry)?.models ?? [];
	} else {
		offered = (await listModels(account.provider, account.accountId)).filter((m) => m?.provider === account.provider).map((m) => m.id);
	}
	if (!offered.includes(wanted.id)) refuse("unknown_model");
	return { provider: account.provider, id: wanted.id, accountId: account.accountId };
}

/**
 * Writes the chosen model into a Minikoda's private agent dir (its own root, never the chat's). Re-run before
 * every spawn, so a logout or a model change in the account is honoured on the next run. Throws
 * ModelChoiceError when the account lost its credential.
 */
function projectModel({ agentDir, accountsRoot, model, custom, credential: given }) {
	const accountDir = path.join(accountsRoot, model.accountId);
	// `given`: the freshest copy chosen under the credential locks (credentials.cjs, S11); default: the account's.
	const credential = given ?? readJson(path.join(accountDir, "auth.json"))?.[model.provider];
	if (!credential) refuse("account_not_signed_in");
	const files = {
		auth: path.join(agentDir, "auth.json"),
		models: path.join(agentDir, "models.json"),
		settings: path.join(agentDir, "settings.json"),
		extension: path.join(agentDir, "extensions", EXTENSION_FILE),
		runtime: path.join(agentDir, RUNTIME_FILE),
	};
	writePrivateFile(files.auth, `${JSON.stringify({ [model.provider]: credential }, null, 2)}\n`);
	if (custom === true) {
		const entry = readJson(path.join(accountDir, "models.json"))?.providers?.[model.provider];
		const runtime = runtimeDocument(model.provider, entry);
		if (!runtime || !runtime.models.includes(model.id)) refuse("unknown_model");
		writePrivateFile(files.models, `${JSON.stringify({ providers: {} })}\n`);
		writePrivateFile(files.runtime, `${JSON.stringify(runtime, null, 2)}\n`);
		writePrivateFile(files.extension, TEMPLATE);
	} else {
		let models = `${JSON.stringify({ providers: {} })}\n`;
		try {
			models = readFileSync(path.join(accountDir, "models.json"), "utf8");
		} catch {}
		writePrivateFile(files.models, models);
		for (const key of ["extension", "runtime"]) if (existsSync(files[key])) unlinkSync(files[key]);
	}
	writePrivateFile(files.settings, `${JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id }, null, 2)}\n`);
	return files;
}

module.exports = { ModelChoiceError, chatModel, resolveModelChoice, projectModel };
