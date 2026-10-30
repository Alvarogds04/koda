"use strict";

// Test double for the Abito SDK auth helper child (JSONL over stdin/stdout).
// Used only by the engine tests; it never contacts a real provider or the network.
//
// Protocol (mirrors src/sdk-helper.mjs):
// - Requests:  { id, cmd, ... } with cmd in
//     providers | models | status | login | enroll_api_key | logout
// - Answers:   { cmd: "answer", flowId, promptId, value } | { cmd: "cancel", flowId }
// - Emissions: { type: "result", id, ok, ... } | { type: "prompt", flowId, promptId, ... }
//              | { type: "event", flowId, event }
//
// Evidence knobs:
// - --accounts-root <dir>      where fake account auth.json files live
// - FAKE_ENV_OUT=<path>        dump process.env (helper environment hygiene test)
// - FAKE_LOGIN_FAIL=1          login result is ok:false and its raw error carries
//                              "FAKE-INTERNAL-DETAIL" (must never reach the daemon surface)
// - FAKE_LOGIN_HANG=1          login emits one prompt and never answers result (cancel path)
// - FAKE_LOCAL_PROVIDER=1      include a local OpenAI-compatible provider + models
//
// The fake never echoes an answer or a stored key back on stdout; credentials are
// written only to the private account auth.json file, like the real helper.

const fs = require("node:fs");
const path = require("node:path");

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const accountsRoot = argValue("--accounts-root") || ".";
const envOut = process.env.FAKE_ENV_OUT;
if (envOut) fs.writeFileSync(envOut, JSON.stringify(process.env));

const writeRecord = (record) => process.stdout.write(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));

const credentialPath = (accountId) => path.join(accountsRoot, accountId, "auth.json");

function readCredential(accountId) {
	try {
		return JSON.parse(fs.readFileSync(credentialPath(accountId), "utf8"));
	} catch {
		return undefined;
	}
}

function writeCredential(accountId, providerId, credential) {
	const file = credentialPath(accountId);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const next = { ...readCredential(accountId), [providerId]: credential };
	fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	loosen(accountId);
}

// FAKE_LOOSE_MODE=1 simulates an SDK/umask leaving 0644 files in a 0755 account dir.
function loosen(accountId) {
	if (process.env.FAKE_LOOSE_MODE !== "1") return;
	if (process.platform === "win32") {
		// HU-061: a real loose DACL (Everyone: full control) — the daemon's re-assert must tighten it through the helper.
		for (const target of [credentialPath(accountId), path.dirname(credentialPath(accountId))]) {
			const r = require("node:child_process").spawnSync("icacls", [target, "/grant", "*S-1-1-0:F"], { encoding: "utf8" });
			if (r.status !== 0) throw new Error(`icacls could not loosen ${target}: ${r.stdout}${r.stderr}`);
		}
		return;
	}
	fs.chmodSync(credentialPath(accountId), 0o644);
	fs.chmodSync(path.dirname(credentialPath(accountId)), 0o755);
}

const LOCAL = process.env.FAKE_LOCAL_PROVIDER === "1";

const PROVIDERS = [
	{ id: "anthropic", name: "Anthropic", methods: ["oauth", "api_key"] },
	{ id: "openai", name: "OpenAI", methods: ["oauth", "api_key"] },
	...(LOCAL ? [{ id: "abito-local", name: "Abito local server", methods: ["api_key"] }] : []),
];

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, input: ["text", "image"], contextWindow: 200000 },
	{ provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini", reasoning: false, input: ["text"], contextWindow: 128000 },
	...(LOCAL
		? [{ provider: "abito-local", id: "qwen2.5-coder:7b", name: "Qwen2.5 Coder 7B", reasoning: false, input: ["text"], contextWindow: 32768 }]
		: []),
];

/** One flow: { providerId, method, controller, pending: Map<promptId, {resolve,reject}>, cancelled } */
const flows = new Map();
let seq = 0;

function settle(answer, { ok, cancelled, error } = {}) {
	const flow = flows.get(answer.flowId);
	if (!flow) return;
	flows.delete(answer.flowId);
	if (cancelled) {
		flow.cancelled = true;
		flow.controller.abort();
		return;
	}
	if (answer.promptId !== undefined) {
		const pending = flow.pending.get(answer.promptId);
		if (pending) {
			flow.pending.delete(answer.promptId);
			pending.resolve(answer.value);
		}
	}
	void ok;
	void error;
}

async function handle(msg) {
	const { id, cmd } = msg;
	switch (cmd) {
		case "providers":
			writeRecord({ type: "result", id, ok: true, providers: PROVIDERS });
			return;
		case "models": {
			const provider = msg.providerId;
			writeRecord({
				type: "result",
				id,
				ok: true,
				models: provider ? MODELS.filter((m) => m.provider === provider) : MODELS,
			});
			return;
		}
		case "status": {
			const stored = readCredential(msg.accountId);
			const credentials = stored
				? Object.entries(stored).map(([provider, cred]) => ({ provider, authMethod: cred.type, configured: true }))
				: [];
			writeRecord({ type: "result", id, ok: true, credentials });
			return;
		}
		case "enroll_api_key": {
			writeCredential(msg.accountId, msg.providerId, { type: "api_key", key: msg.apiKey });
			writeRecord({ type: "result", id, ok: true });
			return;
		}
		case "logout": {
			const stored = readCredential(msg.accountId);
			if (stored) {
				const next = { ...stored };
				delete next[msg.providerId];
				fs.writeFileSync(credentialPath(msg.accountId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
				loosen(msg.accountId);
			}
			writeRecord({ type: "result", id, ok: true });
			return;
		}
		case "login": {
			const flowId = msg.flowId;
			const controller = new AbortController();
			const flow = { providerId: msg.providerId, method: msg.method, controller, pending: new Map(), cancelled: false };
			flows.set(flowId, flow);
			controller.signal.addEventListener("abort", () => {
				for (const pending of [...flow.pending.values()]) pending.reject(new Error("cancelled"));
				flow.pending.clear();
			});
			const interaction = {
				signal: controller.signal,
				prompt: (prompt) =>
					new Promise((resolve, reject) => {
						if (controller.signal.aborted) return reject(new Error("cancelled"));
						const promptId = `p${++seq}`;
						flow.pending.set(promptId, { resolve, reject });
						writeRecord({
							type: "prompt",
							flowId,
							promptId,
							kind: prompt.type,
							message: prompt.message,
							...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
							...(prompt.options ? { options: prompt.options } : {}),
							secret: prompt.type === "secret",
						});
					}),
				notify: (event) => {
					const safe = { kind: event.type };
					if (event.type === "info") safe.message = event.message;
					if (event.type === "auth_url") {
						safe.url = event.url;
						if (event.instructions) safe.instructions = event.instructions;
					}
					if (event.type === "device_code") {
						safe.userCode = event.userCode;
						safe.verificationUri = event.verificationUri;
					}
					if (event.type === "progress") safe.message = event.message;
					writeRecord({ type: "event", flowId, event: safe });
				},
			};
			try {
				let answer;
				if (msg.method === "api_key") {
					answer = await interaction.prompt({ type: "secret", message: "Paste your API key", placeholder: "sk-..." });
					writeCredential(msg.accountId, msg.providerId, { type: "api_key", key: answer });
				} else {
					interaction.notify({ type: "auth_url", url: "https://example.invalid/oauth", instructions: "Open the URL" });
					answer = await interaction.prompt({ type: "text", message: "Paste the verification code" });
					writeCredential(msg.accountId, msg.providerId, { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 3600_000 });
				}
				if (process.env.FAKE_LOGIN_FAIL === "1") {
					writeRecord({ type: "result", id, ok: false, error: "FAKE-INTERNAL-DETAIL stack trace with FAKE-KEY-MARKER" });
					return;
				}
				void answer;
				writeRecord({ type: "result", id, ok: true });
			} catch (error) {
				if (flow.cancelled) writeRecord({ type: "result", id, ok: false, cancelled: true });
				else writeRecord({ type: "result", id, ok: false, error: "sign-in did not complete" });
			} finally {
				flows.delete(flowId);
			}
			return;
		}
		default:
			writeRecord({ type: "result", id, ok: false, error: "unknown command" });
	}
}

const decoder = { buffer: "" };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	decoder.buffer += chunk;
	for (;;) {
		const lf = decoder.buffer.indexOf("\n");
		if (lf === -1) break;
		const line = decoder.buffer.slice(0, lf);
		decoder.buffer = decoder.buffer.slice(lf + 1);
		if (line.trim() === "") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.cmd === "answer") settle(record);
		else if (record.cmd === "cancel") settle(record, { cancelled: true });
		else void handle(record);
	}
});
process.stdin.on("end", () => process.exit(0));

// FAKE_LOGIN_HANG: login emits its prompt and then never resolves.
if (process.env.FAKE_LOGIN_HANG === "1") {
	// The login handler above already blocks on the prompt promise, so nothing
	// else is needed: the flow stays pending until the daemon cancels it.
}
