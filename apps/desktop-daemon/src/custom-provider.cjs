"use strict";

/**
 * Custom LiteLLM / OpenAI-compatible provider (HU-041, T6a-1): bounded model discovery.
 *
 * `GET <baseUrl>/models` with the account's bearer key, nothing else. The Base URL is re-validated
 * here (https, or http only for a literal loopback address), every redirect is refused (a 3xx is a
 * failure, same-origin included, and is never followed), and time, response bytes, model count and
 * id length are bounded. Failures are a CustomProviderError with a FIXED `reason`; the message and
 * stack never contain the key, the URL, the host or any upstream text.
 */

const http = require("node:http");
const https = require("node:https");
const { validateCustomBaseUrl } = require("./protocol.cjs");
const { MODEL_LIMITS } = require("./custom-provider-extension.cjs");

const DISCOVERY_LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 256 * 1024, maxModels: MODEL_LIMITS.maxModels, maxIdChars: MODEL_LIMITS.maxIdChars });
const CONTROL = /[\u0000-\u001f\u007f]/;

class CustomProviderError extends Error {
	constructor(reason) {
		super(`Model discovery failed (${reason})`);
		this.name = "CustomProviderError";
		this.reason = reason;
	}
}

/** Validates the `{data:[{id}]}` listing: 1..maxModels unique printable ids. */
function parseModelIds(text) {
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new CustomProviderError("invalid_response");
	}
	const data = doc?.data;
	if (!Array.isArray(data) || data.length === 0) throw new CustomProviderError("invalid_response");
	if (data.length > DISCOVERY_LIMITS.maxModels) throw new CustomProviderError("too_many");
	const ids = [];
	for (const entry of data) {
		const id = entry?.id;
		if (typeof id !== "string" || id.trim() === "" || id.length > DISCOVERY_LIMITS.maxIdChars || CONTROL.test(id)) {
			throw new CustomProviderError("invalid_response");
		}
		ids.push(id);
	}
	if (new Set(ids).size !== ids.length) throw new CustomProviderError("invalid_response");
	return ids;
}

/** @returns {Promise<string[]>} model ids exposed by the gateway */
function discoverModels({ baseUrl, apiKey, timeoutMs = DISCOVERY_LIMITS.timeoutMs } = {}) {
	const normalized = validateCustomBaseUrl(baseUrl);
	if (!normalized || typeof apiKey !== "string" || apiKey === "") return Promise.reject(new CustomProviderError("invalid_url"));
	const url = new URL(`${normalized}/models`);
	const client = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		let settled = false;
		let request;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request?.destroy();
			fn(value);
		};
		const timer = setTimeout(() => finish(reject, new CustomProviderError("timeout")), timeoutMs);
		try {
			request = client.request(
			{
				protocol: url.protocol,
				hostname: url.hostname.replace(/^\[|\]$/g, ""),
				port: url.port,
				path: url.pathname,
				method: "GET",
				agent: false,
				headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			},
			(res) => {
				const status = res.statusCode ?? 0;
				if (status >= 300 && status < 400) return finish(reject, new CustomProviderError("redirect"));
				if (status < 200 || status >= 300) return finish(reject, new CustomProviderError("status"));
				if (Number(res.headers["content-length"]) > DISCOVERY_LIMITS.maxBytes) return finish(reject, new CustomProviderError("too_large"));
				const chunks = [];
				let bytes = 0;
				res.on("data", (chunk) => {
					bytes += chunk.length;
					if (bytes > DISCOVERY_LIMITS.maxBytes) return finish(reject, new CustomProviderError("too_large"));
					chunks.push(chunk);
				});
				res.on("end", () => {
					try {
						finish(resolve, parseModelIds(Buffer.concat(chunks).toString("utf8")));
					} catch (error) {
						finish(reject, error);
					}
				});
				res.on("error", () => finish(reject, new CustomProviderError("unreachable")));
			},
		);
		request.on("error", () => finish(reject, new CustomProviderError("unreachable")));
		request.end();
		} catch {
			// Synchronous setup failure (e.g. a header value Node refuses): clear the timer, fixed reason.
			finish(reject, new CustomProviderError("unreachable"));
		}
	});
}

module.exports = { CustomProviderError, DISCOVERY_LIMITS, discoverModels };
