"use strict";

/**
 * Custom LiteLLM / OpenAI-compatible provider (HU-041, T6a-2): the guarded Pi transport.
 *
 * Pi's plain `models.json` providers cannot supply a per-call `fetch`, and the SDK's default fetch
 * follows redirects (forwarding the bearer key and body to wherever a gateway points). So a custom
 * account is activated together with ONE provider-scoped Pi extension that registers only that
 * provider and delegates to the SDK's own `openai-completions` stream with a guarded `fetch`.
 *
 * The extension is a FIXED, versioned template: this module never interpolates a key, URL, model id
 * or any other user data into it. The account's configuration travels as private runtime JSON
 * (`custom-provider.json`, written 0600 next to the engine's other private agent files), which the
 * extension re-validates itself; the key is the one Pi resolves from the engine's private auth.json.
 *
 * The guard: HTTPS, or HTTP for a literal loopback address, no userinfo/query/fragment; scheme, host
 * and port pinned to the configured Base URL; only `POST <base>/chat/completions` and
 * `GET <base>/models`; `redirect: "manual"` and EVERY 3xx refused (same-origin included, with the
 * body cancelled so nothing follows); header wait, idle time and response bytes bounded; errors
 * reach Pi as fixed phrases that never contain the key, the URL, the host or upstream text.
 */

const { validateCustomBaseUrl } = require("./protocol.cjs");

const TEMPLATE_VERSION = 1;
const EXTENSION_FILE = "abito-custom-provider.js";
const RUNTIME_FILE = "custom-provider.json";
/** Host-side copy of the template's PROVIDER_ID: the only provider names Abito ever creates (ownership proof for teardown). */
const PROVIDER_ID = /^custom-[a-z0-9][a-z0-9._-]{0,63}$/;
/** Model-list bounds, defined ONCE: discovery (custom-provider.cjs), runtime data here, and the template's LIMITS. */
const MODEL_LIMITS = Object.freeze({ maxModels: 128, maxIdChars: 200 });
const CONTROL = /[\u0000-\u001f\u007f]/;

// The template is plain ESM loaded by Pi (jiti). Keep it free of backticks and dollar-brace sequences:
// it is a constant, never a template that receives data.
const TEMPLATE = String.raw`// Abito custom provider extension (template v1). Generated file: do not edit.
// Fixed code only. The account's Base URL and model ids are read from custom-provider.json at load
// and re-validated here; the API key is the one Pi resolves from its private auth.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TEMPLATE_VERSION = 1;
export const LIMITS = Object.freeze({ headersMs: 300000, idleMs: 300000, maxBytes: 67108864, maxModels: ${MODEL_LIMITS.maxModels}, maxIdChars: ${MODEL_LIMITS.maxIdChars} });

const URL_SHAPE = /^(https?):\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?((?:\/[A-Za-z0-9._~-]+)*)\/?$/;
const PROVIDER_ID = /^custom-[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DOTTED_BYTE = /^(0|[1-9]\d{0,2})$/;

class GuardError extends Error {
	constructor(reason) {
		super("Custom gateway request refused (" + reason + ")");
		this.name = "GuardError";
		this.reason = reason;
	}
}

/** https, or http for a literal loopback only; no userinfo/query/fragment/escapes/dot segments. */
export function normalizeBaseUrl(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
	const m = URL_SHAPE.exec(value);
	if (!m) return undefined;
	const scheme = m[1].toLowerCase();
	const host = m[2].toLowerCase();
	if (m[3] !== undefined && !(Number(m[3]) >= 1 && Number(m[3]) <= 65535)) return undefined;
	if (m[4].split("/").some((seg) => seg === "." || seg === "..")) return undefined;
	if (scheme === "http") {
		const loopback = host === "[::1]" || (/^127(\.\d{1,3}){3}$/.test(host) && host.split(".").every((p) => DOTTED_BYTE.test(p) && Number(p) <= 255));
		if (!loopback) return undefined;
	}
	let url;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.hostname !== host) return undefined;
	return { origin: url.origin, basePath: url.pathname.replace(/\/$/, ""), href: (url.origin + url.pathname).replace(/\/$/, "") };
}

/** Validated runtime data or undefined: { provider, base, models }. */
export function parseRuntime(text) {
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.version !== TEMPLATE_VERSION) return undefined;
	if (typeof doc.provider !== "string" || !PROVIDER_ID.test(doc.provider)) return undefined;
	const base = normalizeBaseUrl(doc.baseUrl);
	if (!base) return undefined;
	if (!Array.isArray(doc.models) || doc.models.length < 1 || doc.models.length > LIMITS.maxModels) return undefined;
	for (const id of doc.models) {
		if (typeof id !== "string" || id.trim() === "" || id.length > LIMITS.maxIdChars || CONTROL.test(id)) return undefined;
	}
	if (new Set(doc.models).size !== doc.models.length) return undefined;
	return { provider: doc.provider, base, models: [...doc.models] };
}

/**
 * A fetch pinned to one gateway. Anything else (another scheme, host, port, path or method, userinfo,
 * query, fragment) is refused BEFORE a request is made; a redirect is refused after the response
 * headers, with its body cancelled. Failures record a fixed reason in state.reason (and the HTTP
 * status in state.status) and surface only as GuardError or an abort.
 */
export function createGuardedFetch(base, state = {}, limits = LIMITS, fetchImpl = globalThis.fetch) {
	const allowed = new Set(["POST " + base.basePath + "/chat/completions", "GET " + base.basePath + "/models"]);
	const refuse = (reason) => {
		state.reason = reason;
		return new GuardError(reason);
	};
	return async function guardedFetch(input, init) {
		// Only string / URL inputs (what the SDK passes). A Request object carries its own method, headers
		// and body that init would not override consistently, so it is refused before any side effect.
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
		if (raw === undefined) throw refuse("request");
		let target;
		try {
			target = new URL(raw);
		} catch {
			throw refuse("request");
		}
		const method = String((init && init.method) || "GET").toUpperCase();
		if (target.origin !== base.origin || target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "") throw refuse("destination");
		if (!allowed.has(method + " " + target.pathname)) throw refuse("destination");

		const controller = new AbortController();
		const outer = init && init.signal;
		const onAbort = () => controller.abort();
		if (outer) {
			if (outer.aborted) controller.abort();
			else outer.addEventListener("abort", onAbort, { once: true });
		}
		let timer = setTimeout(() => {
			state.reason = "timeout";
			controller.abort();
		}, limits.headersMs);
		const cleanup = () => {
			clearTimeout(timer);
			if (outer) outer.removeEventListener("abort", onAbort);
		};
		let response;
		try {
			// Forward exactly what was validated: the checked URL and method, manual redirects, our signal.
			response = await fetchImpl(target.href, { ...(init || {}), method, redirect: "manual", signal: controller.signal });
		} catch (error) {
			cleanup();
			if (state.reason) throw new GuardError(state.reason);
			if (outer && outer.aborted) throw error;
			throw refuse("unreachable");
		}
		clearTimeout(timer);
		state.status = response.status;
		if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
			try {
				await response.body?.cancel();
			} catch {}
			cleanup();
			// A synthetic, non-retryable 4xx: nothing was followed and nothing upstream is echoed.
			state.reason = "redirect";
			return new Response(JSON.stringify({ error: { message: "Custom gateway request refused (redirect)" } }), { status: 400, headers: { "content-type": "application/json" } });
		}
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > limits.maxBytes) {
			try {
				await response.body?.cancel();
			} catch {}
			cleanup();
			throw refuse("too_large");
		}
		if (!response.body) {
			cleanup();
			return response;
		}
		const reader = response.body.getReader();
		let bytes = 0;
		let idle;
		const arm = () => {
			clearTimeout(idle);
			idle = setTimeout(() => {
				state.reason = "timeout";
				controller.abort();
			}, limits.idleMs);
		};
		arm();
		const bounded = new ReadableStream({
			async pull(out) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						clearTimeout(idle);
						cleanup();
						out.close();
						return;
					}
					bytes += value.byteLength;
					if (bytes > limits.maxBytes) {
						state.reason = "too_large";
						controller.abort();
						throw new GuardError("too_large");
					}
					arm();
					out.enqueue(value);
				} catch (error) {
					clearTimeout(idle);
					cleanup();
					out.error(state.reason ? new GuardError(state.reason) : error);
				}
			},
			cancel(reason) {
				clearTimeout(idle);
				cleanup();
				controller.abort();
				return reader.cancel(reason).catch(() => {});
			},
		});
		return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

/** Fixed, key-free wording for Pi: a guard reason, an HTTP status, or a generic failure. */
export function safeMessage(state) {
	if (state.reason) return "Custom gateway request refused (" + state.reason + ")";
	if (state.status >= 400) return "Custom gateway returned HTTP " + state.status;
	return "Custom gateway request failed";
}

function failure(model, message, aborted) {
	return {
		type: "error",
		reason: aborted ? "aborted" : "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: aborted ? "aborted" : "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

export function makeStream(runtime, loadPiAi = () => import("@earendil-works/pi-ai/compat"), fetchImpl = globalThis.fetch, limits = LIMITS) {
	return function streamSimple(model, context, options) {
		const state = {};
		let out;
		let resolveOut;
		const ready = new Promise((resolve) => {
			resolveOut = resolve;
		});
		(async () => {
			const api = await loadPiAi();
			out = api.createAssistantMessageEventStream();
			resolveOut(out);
			try {
				if (model.provider !== runtime.provider || !runtime.models.includes(model.id)) throw new GuardError("model");
				const pinned = normalizeBaseUrl(model.baseUrl);
				if (!pinned || pinned.href !== runtime.base.href) throw new GuardError("destination");
				const inner = api.openAICompletionsApi().streamSimple(
					{ ...model, api: "openai-completions", baseUrl: runtime.base.href },
					context,
					{ ...options, maxRetries: 0, fetch: createGuardedFetch(runtime.base, state, limits, fetchImpl) },
				);
				for await (const event of inner) {
					if (event.type === "error") out.push(failure(model, safeMessage(state), event.reason === "aborted"));
					else out.push(event);
				}
			} catch (error) {
				out.push(failure(model, error instanceof GuardError ? error.message : safeMessage(state), false));
			}
			out.end();
		})().catch(() => resolveOut(undefined));
		// Pi consumes the stream synchronously; forward once the SDK module has loaded.
		const proxy = {
			async *[Symbol.asyncIterator]() {
				const real = await ready;
				if (real) yield* real;
			},
			async result() {
				const real = await ready;
				return real ? real.result() : failure(model, "Custom gateway request failed", false).error;
			},
		};
		return proxy;
	};
}

export default function (pi) {
	let runtime;
	try {
		const dir = process.env.PI_CODING_AGENT_DIR;
		if (!dir) return;
		runtime = parseRuntime(readFileSync(join(dir, "custom-provider.json"), "utf8"));
	} catch {
		return;
	}
	if (!runtime) return;
	pi.registerProvider(runtime.provider, {
		name: "Custom gateway",
		baseUrl: runtime.base.href,
		api: "abito-custom-openai",
		models: runtime.models.map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		})),
		streamSimple: makeStream(runtime),
	});
}
`;

/** The validated runtime document for an account's `models.json` entry, or undefined. */
function runtimeDocument(provider, entry) {
	const baseUrl = validateCustomBaseUrl(entry?.baseUrl);
	if (!baseUrl || typeof provider !== "string") return undefined;
	const models = Array.isArray(entry.models) ? entry.models.map((m) => m?.id) : [];
	if (models.length < 1 || models.length > MODEL_LIMITS.maxModels) return undefined;
	for (const id of models) {
		if (typeof id !== "string" || id.trim() === "" || id.length > MODEL_LIMITS.maxIdChars || CONTROL.test(id)) return undefined;
	}
	if (new Set(models).size !== models.length) return undefined;
	return { version: TEMPLATE_VERSION, provider, baseUrl, models };
}

module.exports = { PROVIDER_ID, MODEL_LIMITS, EXTENSION_FILE, RUNTIME_FILE, TEMPLATE, TEMPLATE_VERSION, runtimeDocument };
