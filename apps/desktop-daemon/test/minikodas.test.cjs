"use strict";

// K2-13 Minikodas, commit 1 (T3, S4/S5/S7): recipe validation, model choice, the runner with the closed kit,
// the scheduler and the recipe store with its approve-to-create step. Offline: the engine is the fake Pi fixture
// (test/fixtures/minikodas/fake-pi.cjs) that loads the REAL kit extension; no model, no network, no real ~/.pi.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { validateRecipe, KIT_CATALOGUE, REQUIRED_NEVER } = require("../src/minikodas/recipe.cjs");
const { resolveModelChoice, projectModel } = require("../src/minikodas/model.cjs");
const { runMinikoda, engineArgs, KIT_EXTENSION } = require("../src/minikodas/runner.cjs");
const { Scheduler } = require("../src/minikodas/scheduler.cjs");
const { MinikodaService } = require("../src/minikodas/service.cjs");

const FAKE_PI = path.join(__dirname, "fixtures", "minikodas", "fake-pi.cjs");
const MARKER = "minikoda-bash-ran.txt";
const posix = process.platform !== "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await sleep(10);
	}
	assert.ok(await fn(), "waitFor timed out");
}

function tmp(t) {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-mk-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
	return base;
}
const MODEL = { provider: "fake", id: "fake-minikoda", accountId: "main" };
const recipe = (over = {}) => ({
	id: "oportunidades",
	name: "Oportunidades",
	when: { manual: true },
	reads: { source: "notas.txt" },
	kit: ["source_read", "inbox_propose"],
	prompt: "Sos un Minikoda de oportunidades de inversión.",
	model: { ...MODEL },
	never: ["buy", "sell", "send", "delete"],
	...over,
});
function allFiles(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...allFiles(p));
		else out.push(p);
	}
	return out;
}
function script(base, steps, name = "script.json") {
	const file = path.join(base, name);
	fs.writeFileSync(file, JSON.stringify({ steps }));
	return file;
}
const fakeEngine = (scriptFile, report) => ({ command: process.execPath, commandArgs: [FAKE_PI, "--script", scriptFile, ...(report ? ["--report", report] : [])], env: { PATH: process.env.PATH }, startTimeoutMs: 10_000 });

/** The scripted turn of the PoC: tries bash, reads the source, parks a sell, answers with a summary. */
const STANDARD = [
	{ tool: "bash", args: { marker: MARKER } },
	{ tool: "source_read" },
	{ tool: "inbox_propose", args: { action: "sell", target: "ACME", text: "El post dice «ACME pierde el contrato»." } },
	{ text: "Considerar venta: ACME. Dejé 1 propuesta en «Hoy»." },
];

// ---------- recipe ----------

test("recipe: accepts a valid recipe and normalizes it; the closed kit and the never list are fixed", () => {
	const r = validateRecipe(recipe({ when: { everyMs: 60_000 } }));
	assert.deepEqual([...r.kit], ["source_read", "inbox_propose"]);
	assert.deepEqual([...r.never], [...REQUIRED_NEVER]);
	assert.deepEqual(KIT_CATALOGUE, ["source_read", "inbox_propose"]);
	assert.ok(Object.isFrozen(r));
	assert.equal(validateRecipe(recipe({ when: { at: "2099-01-01T10:00:00+02:00" } })).when.at, "2099-01-01T08:00:00.000Z");
});

test("recipe: strict validation refuses every out-of-contract field with a RecipeError", () => {
	const bad = [
		[{ kit: ["source_read", "bash"] }, /closed catalogue/],
		[{ kit: [] }, /non-empty/],
		[{ kit: ["source_read", "source_read"] }, /duplicates/],
		[{ never: ["buy", "sell", "send"] }, /never must be exactly/],
		[{ never: ["buy", "sell", "send", "delete", "x"] }, /never must be exactly/],
		[{ when: {} }, /exactly one/],
		[{ when: { manual: true, everyMs: 60_000 } }, /exactly one/],
		[{ when: { everyMs: 10 } }, /everyMs/],
		[{ when: { at: "mañana" } }, /ISO/],
		[{ reads: { rss: "/x" } }, /unknown fields/],
		[{ reads: { source: "" } }, /reads.source/],
		[{ prompt: "" }, /prompt/],
		[{ prompt: "x\u0000y" }, /prompt/],
		[{ model: { provider: "Fake Bad", id: "m" } }, /model.provider/],
		[{ model: { provider: "fake", id: "m", baseUrl: "http://x" } }, /unknown fields/],
		[{ model: undefined }, /model is required/],
		[{ id: "Bad Id" }, /id must be/],
		[{ name: "a\nb" }, /name/],
	];
	for (const [over, pattern] of bad) assert.throws(() => validateRecipe(recipe(over)), (e) => e.name === "RecipeError" && pattern.test(e.message), JSON.stringify(over));
	assert.throws(() => validateRecipe({ ...recipe(), output: "telegram" }), /unknown fields/);
	assert.throws(() => validateRecipe(recipe({ when: { at: "2000-01-01T00:00:00Z" } }), { now: Date.now() }), /future/);
});

test("recipe: a Telegram source is validated when the Minikoda is created, and a descriptor without `telegram:` is refused in Spanish", () => {
	const source = (value) => validateRecipe(recipe({ reads: { source: value } })).reads.source;
	for (const value of ["telegram:@valmar_canal", "telegram:valmar_canal", "telegram:t.me/valmar_canal", "telegram:https://t.me/valmar_canal"]) {
		assert.equal(source(value), value, `${value} is a channel the daemon can read`);
	}
	// A channel typed without the prefix must never be read as an empty text file at run time: the daemon refuses it
	// here, where the person still is, with a sentence that says what to write instead.
	for (const value of ["@valmar_canal", "t.me/valmar_canal", "https://t.me/valmar_canal", "telegram.me/valmar_canal"]) {
		assert.throws(() => validateRecipe(recipe({ reads: { source: value } })), /prefijo «telegram:»/, `refused at creation: ${value}`);
	}
	for (const value of ["telegram:", "telegram:@val mar", "telegram:t.me/+AbCdEf123", "telegram:https://example.com/valmar"]) {
		assert.throws(() => validateRecipe(recipe({ reads: { source: value } })), /canal de Telegram válido/, `refused: ${value}`);
	}
	assert.equal(source("mi archivo de notas"), "mi archivo de notas", "a plain descriptor stays a text source");
});

// A draft may omit id and model (the daemon fills them), a stored recipe may not.
test("recipe: a draft may omit id and model, a stored recipe may not", () => {
	const { id: _id, model: _model, ...draft } = recipe();
	assert.equal(validateRecipe(draft, { draft: true }).id, undefined);
	assert.throws(() => validateRecipe(draft), /id must be/);
});

// ---------- model choice (S7) ----------

function accountsFixture(base, { configured = true, extra = [] } = {}) {
	const accountsRoot = path.join(base, "accounts");
	fs.mkdirSync(path.join(accountsRoot, "main"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(accountsRoot, "main", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "FAKE-KEY-NOT-REAL" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(accountsRoot, "main", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "fake-minikoda" }] } } }), { mode: 0o600 });
	const accounts = [{ accountId: "main", provider: "fake", configured }, ...extra];
	return {
		accountsRoot,
		accounts: { listAccounts: () => accounts.map((a) => ({ ...a })), models: async (provider) => (provider === "fake" ? [{ provider: "fake", id: "fake-minikoda" }, { provider: "fake", id: "other" }] : []) },
		profiles: { list: () => ({ profiles: [{ id: "work", accountId: "main", provider: "fake", modelId: "other" }], active: "work" }) },
	};
}

test("S7 model choice: only an existing, signed-in account and a model it offers; default = the chat's current model", async (t) => {
	const base = tmp(t);
	const fx = accountsFixture(base, { extra: [{ accountId: "second", provider: "fake2", configured: false }, { accountId: "dup-a", provider: "dup", configured: true }, { accountId: "dup-b", provider: "dup", configured: true }] });
	const resolve = (choice) => resolveModelChoice({ choice, listAccounts: fx.accounts.listAccounts, profiles: fx.profiles, listModels: fx.accounts.models, accountsRoot: fx.accountsRoot });
	assert.deepEqual(await resolve({ provider: "fake", id: "fake-minikoda" }), MODEL);
	assert.deepEqual(await resolve(undefined), { provider: "fake", id: "other", accountId: "main" }, "default is the chat's active profile model");
	const reason = async (choice) => resolve(choice).then(() => "accepted", (e) => e.reason);
	assert.equal(await reason({ provider: "openai", id: "gpt" }), "unknown_account", "a provider Koda has no account for");
	assert.equal(await reason({ provider: "fake", id: "not-offered" }), "unknown_model");
	assert.equal(await reason({ provider: "fake2", id: "x" }), "account_not_signed_in");
	assert.equal(await reason({ provider: "dup", id: "x" }), "ambiguous_account");
	assert.equal(await reason({ provider: "fake", id: "fake-minikoda", accountId: "nope" }), "unknown_account");
	const noChat = await resolveModelChoice({ choice: undefined, listAccounts: fx.accounts.listAccounts, profiles: { list: () => ({ profiles: [], active: undefined }) }, listModels: fx.accounts.models, accountsRoot: fx.accountsRoot }).catch((e) => e.reason);
	assert.equal(noChat, "no_model");
});

test("S7 projectModel writes only the chosen credential and defaults into the Minikoda's own agent dir (0600)", async (t) => {
	const base = tmp(t);
	const fx = accountsFixture(base);
	const agentDir = path.join(base, "engine", "agent");
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const files = projectModel({ agentDir, accountsRoot: fx.accountsRoot, model: MODEL });
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(files.auth, "utf8"))), ["fake"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(files.settings, "utf8")), { defaultProvider: "fake", defaultModel: "fake-minikoda" });
	if (posix) for (const f of [files.auth, files.models, files.settings]) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
	fs.writeFileSync(path.join(fx.accountsRoot, "main", "auth.json"), "{}");
	assert.throws(() => projectModel({ agentDir, accountsRoot: fx.accountsRoot, model: MODEL }), (e) => e.reason === "account_not_signed_in");
});

// ---------- runner (S4, S5) ----------

test("S4 engine argv: reduced profile, kit extension, --tools = kit, the chosen model", () => {
	const args = engineArgs({ kit: ["source_read", "inbox_propose"], model: MODEL });
	assert.deepEqual(args, ["-ne", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", KIT_EXTENSION, "--tools", "source_read,inbox_propose", "--model", "fake/fake-minikoda"]);
});

test("S4 a run uses its own private root, declares only the kit, refuses bash (never runs), reads the source and parks only what the kit stored", async (t) => {
	const base = tmp(t);
	const root = path.join(base, "engines", "oportunidades");
	const report = path.join(base, "report.json");
	const r = await runMinikoda({ recipe: validateRecipe(recipe()), root, runId: "r1", source: "Post: ACME pierde el contrato.", engine: fakeEngine(script(base, STANDARD), report) });
	assert.equal(r.outcome, "done");
	const rep = JSON.parse(fs.readFileSync(report, "utf8"));
	assert.deepEqual(rep.declared, ["source_read", "inbox_propose"], "only the kit is declared");
	assert.equal(rep.kitEnv, "source_read,inbox_propose");
	assert.equal(rep.gentleAgents, "0");
	assert.equal(rep.home, path.join(root, "home"), "own private HOME");
	assert.equal(rep.agentDir, path.join(root, "agent"), "own private agent dir");
	for (const flag of ["-ne", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) assert.ok(rep.argv.includes(flag), flag);
	assert.deepEqual(r.toolCalls.map((c) => [c.toolName, c.isError]), [["bash", true], ["source_read", false], ["inbox_propose", false]]);
	assert.match(r.toolCalls[0].text, /not found/);
	assert.match(r.toolCalls[1].text, /ACME pierde el contrato/);
	assert.equal(allFiles(root).some((f) => path.basename(f) === MARKER), false, "bash never ran");
	assert.deepEqual(r.proposals, [{ action: "sell", target: "ACME", text: "El post dice «ACME pierde el contrato»." }]);
	assert.match(r.resultText, /Considerar venta/);
	if (posix) assert.equal(fs.statSync(root).mode & 0o777, 0o700);
	const prompt = fs.readFileSync(path.join(root, "identity.md"), "utf8");
	assert.match(prompt, /You never buy, sell, send or delete/);
	assert.match(prompt, /Sos un Minikoda de oportunidades/, "the specialised prompt is appended");
});

test("S4 belt and braces: with bash widened into the tool selection, the kit guard alone refuses it", async (t) => {
	const base = tmp(t);
	const root = path.join(base, "engines", "g");
	const report = path.join(base, "report.json");
	const r = await runMinikoda({ recipe: validateRecipe(recipe()), root, runId: "r1", tools: ["source_read", "inbox_propose", "bash"], engine: fakeEngine(script(base, STANDARD), report) });
	assert.ok(JSON.parse(fs.readFileSync(report, "utf8")).declared.includes("bash"), "bash was declared in this widened run");
	const bash = r.toolCalls.find((c) => c.toolName === "bash");
	assert.equal(bash.isError, true);
	assert.match(bash.text, /not in this Minikoda's kit/);
	assert.equal(allFiles(root).some((f) => path.basename(f) === MARKER), false, "bash never ran");
});

test("S4 negative control: with bash allowed by BOTH layers it really runs (the «never ran» checks are not vacuous)", async (t) => {
	const base = tmp(t);
	const root = path.join(base, "engines", "c");
	const r = await runMinikoda({ recipe: validateRecipe(recipe()), root, runId: "r1", tools: ["source_read", "inbox_propose", "bash"], guardKit: ["source_read", "inbox_propose", "bash"], engine: fakeEngine(script(base, STANDARD)) });
	assert.equal(r.toolCalls.find((c) => c.toolName === "bash").isError, false);
	assert.equal(allFiles(root).some((f) => path.basename(f) === MARKER), true, "the marker appears when bash is allowed");
});

test("S5 inbox_propose accepts only buy, sell or send; anything else is an error the model sees and nothing is parked", async (t) => {
	const base = tmp(t);
	const root = path.join(base, "engines", "p");
	const steps = [
		{ tool: "inbox_propose", args: { action: "delete", target: "ACME", text: "borrar" } },
		{ tool: "inbox_propose", args: { action: "transfer", target: "ACME", text: "x" } },
		{ tool: "inbox_propose", args: { action: "BUY", target: "ACME", text: "x" } },
		{ tool: "inbox_propose", args: { action: "buy", target: "", text: "x" } },
		{ tool: "inbox_propose", args: { action: "buy", target: "MELI", text: "Oportunidad citada." } },
		{ tool: "inbox_propose", args: { action: "send", target: "grupo", text: "Resumen." } },
		{ text: "Listo." },
	];
	const r = await runMinikoda({ recipe: validateRecipe(recipe()), root, runId: "r1", engine: fakeEngine(script(base, steps)) });
	assert.equal(r.outcome, "done");
	assert.deepEqual(r.toolCalls.map((c) => c.isError), [true, true, true, true, false, false]);
	assert.match(r.toolCalls[0].text, /Only buy, sell or send/);
	assert.deepEqual(r.proposals.map((p) => p.action), ["buy", "send"]);
	const parked = fs.readFileSync(path.join(root, "run", "proposals.jsonl"), "utf8").trim().split("\n");
	assert.equal(parked.length, 2, "the kit file holds only the accepted proposals");
});

test("S5 a proposal the model only CLAIMS in its text is never a proposal; a forged kit-file line outside buy/sell/send is discarded", async (t) => {
	const base = tmp(t);
	const root = path.join(base, "engines", "f");
	const steps = [{ text: "Dejé 3 propuestas en Hoy: comprar ACME, vender MELI y enviar el resumen. Ya ejecuté la venta." }];
	const r = await runMinikoda({ recipe: validateRecipe(recipe()), root, runId: "r1", engine: fakeEngine(script(base, steps)) });
	assert.equal(r.outcome, "done");
	assert.deepEqual(r.proposals, []);
	const { readProposals } = require("../src/minikodas/runner.cjs");
	const forged = path.join(base, "forged.jsonl");
	fs.writeFileSync(forged, `${JSON.stringify({ action: "delete", target: "x", text: "y" })}\nnot json\n${JSON.stringify({ action: "buy", target: "ACME", text: "ok" })}\n`);
	assert.deepEqual(readProposals(forged), { proposals: [{ action: "buy", target: "ACME", text: "ok" }], discarded: 2 });
});

test("S4 a crash, a hang (timeout) or a start failure is a FAILED run, never silent and never respawned", async (t) => {
	const base = tmp(t);
	const crash = await runMinikoda({ recipe: validateRecipe(recipe()), root: path.join(base, "e1"), runId: "r1", engine: fakeEngine(script(base, [{ tool: "inbox_propose", args: { action: "buy", target: "A", text: "t" } }, { crash: 3 }], "c.json")) });
	assert.equal(crash.outcome, "failed");
	assert.equal(crash.reason, "crashed");
	assert.equal(crash.proposals.length, 1, "what the kit parked before the crash is reported, not lost silently");
	const hang = await runMinikoda({ recipe: validateRecipe(recipe()), root: path.join(base, "e2"), runId: "r2", timeoutMs: 800, engine: fakeEngine(script(base, [{ hang: true }], "h.json")) });
	assert.equal(hang.outcome, "failed");
	assert.equal(hang.reason, "timeout");
	const nostart = await runMinikoda({ recipe: validateRecipe(recipe()), root: path.join(base, "e3"), runId: "r3", engine: { command: path.join(base, "no-such-pi"), env: { PATH: process.env.PATH }, startTimeoutMs: 2000 } });
	assert.equal(nostart.outcome, "failed");
	assert.equal(nostart.reason, "start_failed");
	const model = await runMinikoda({ recipe: validateRecipe(recipe()), root: path.join(base, "e4"), runId: "r4", prepareModel: () => { throw Object.assign(new Error("x"), { name: "ModelChoiceError" }); }, engine: fakeEngine(script(base, STANDARD, "m.json")) });
	assert.equal(model.reason, "model_unavailable");
});

// ---------- scheduler ----------

test("scheduler: everyMs fires on its own; a Minikoda never overlaps itself (busy ticks are skipped, never queued)", async (t) => {
	let active = 0;
	let maxActive = 0;
	let calls = 0;
	const running = new Set();
	const launch = async (id) => {
		if (running.has(id)) return { started: false, reason: "running" };
		running.add(id);
		calls += 1;
		active += 1;
		maxActive = Math.max(maxActive, active);
		setTimeout(() => { active -= 1; running.delete(id); }, 350);
		return { started: true };
	};
	const s = new Scheduler({ launch });
	t.after(() => s.stop());
	s.add(validateRecipe(recipe({ id: "lento", when: { everyMs: 60 } }), { minEveryMs: 1 }));
	await sleep(900);
	s.stop();
	assert.ok(calls >= 2, `fired with nobody calling launch (${calls})`);
	assert.equal(maxActive, 1, "never two runs of the same Minikoda at once");
	assert.equal(s.stats("lento"), undefined, "stop() clears every entry");
});

test("scheduler: `at` fires once and marks it; a fired `at` is not re-armed; manual never fires; paused ticks are skipped", async (t) => {
	const fired = [];
	const marked = [];
	let paused = false;
	const s = new Scheduler({ launch: async (id) => { fired.push(id); return { started: true }; }, markFired: (id) => marked.push(id), isPaused: () => paused });
	t.after(() => s.stop());
	s.add(validateRecipe(recipe({ id: "una-vez", when: { at: new Date(Date.now() + 100).toISOString() } })));
	s.add(validateRecipe(recipe({ id: "ya-corrio", when: { at: new Date(Date.now() + 100).toISOString() } })), { firedAt: "2026-01-01T00:00:00.000Z" });
	s.add(validateRecipe(recipe({ id: "a-mano", when: { manual: true } })));
	await sleep(500);
	assert.deepEqual(fired, ["una-vez"]);
	assert.deepEqual(marked, ["una-vez"]);
	paused = true;
	const skipped = [];
	s.on("skipped", (e) => skipped.push(e.reason));
	s.add(validateRecipe(recipe({ id: "pausado", when: { everyMs: 50 } }), { minEveryMs: 1 }));
	await sleep(300);
	assert.deepEqual(fired, ["una-vez"], "nothing launches while paused");
	assert.ok(skipped.length > 0 && skipped.every((r) => r === "paused"));
});

// ---------- service: store, approve-to-create, launch ----------

function service(t, base, over = {}) {
	const fx = accountsFixture(base, over.fixture);
	const results = { runs: [], errors: [], addRun: async (run) => { results.runs.push(run); }, addError: async (err) => { results.errors.push(err); } };
	const svc = new MinikodaService({
		islandRoot: path.join(base, "island"),
		accounts: fx.accounts,
		profiles: fx.profiles,
		accountsRoot: fx.accountsRoot,
		results,
		minEveryMs: 1,
		runTimeoutMs: over.runTimeoutMs ?? 10_000,
		engine: fakeEngine(script(base, over.steps ?? STANDARD)),
		...(over.options ?? {}),
	});
	t.after(() => svc.stop());
	svc.start();
	return { svc, results, fx, island: path.join(base, "island") };
}

test("S1 (daemon part) a Minikoda is created as a DRAFT and runs only after approveCreate; the store is private", async (t) => {
	const base = tmp(t);
	const { svc, results, island } = service(t, base);
	const { id: _id, model: _m, ...draft } = recipe();
	const created = await svc.createDraft(draft);
	assert.equal(created.id, "oportunidades", "id from the name");
	assert.equal(created.status, "draft");
	assert.deepEqual(created.model, { provider: "fake", id: "other", accountId: "main" }, "default model = the chat's model");
	await assert.rejects(svc.launch("oportunidades"), (e) => e.code === "not_active");
	assert.equal(results.runs.length, 0);
	const file = path.join(island, "minikodas", "recipes.json");
	if (posix) {
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.join(island, "minikodas")).mode & 0o777, 0o700);
	}
	const before = fs.readFileSync(file, "utf8");
	await assert.rejects(svc.createDraft({ ...draft, kit: ["bash"] }), (e) => e.code === "bad_request");
	await assert.rejects(svc.createDraft({ ...draft, model: { provider: "openai", id: "gpt" } }), (e) => e.code === "model_unavailable");
	await assert.rejects(svc.createDraft({ ...draft, id: "oportunidades" }), (e) => e.code === "exists");
	assert.equal(fs.readFileSync(file, "utf8"), before, "rejected input leaves the store unchanged");
	assert.equal((await svc.approveCreate("oportunidades")).status, "active");
	await assert.rejects(svc.approveCreate("oportunidades"), (e) => e.code === "not_pending");
	assert.deepEqual(await svc.launch("oportunidades"), { started: true, runId: svc.running.get("oportunidades").runId });
	await waitFor(() => results.runs.length === 1);
	assert.deepEqual(results.runs[0].proposals, [{ action: "sell", target: "ACME", text: "El post dice «ACME pierde el contrato»." }]);
	assert.equal(svc.get("oportunidades").lastRun.outcome, "done");
	assert.notEqual(path.join(island, "minikodas", "engines", "oportunidades"), path.join(island, "agent"), "never the chat engine's root");
	assert.ok(fs.existsSync(path.join(island, "minikodas", "engines", "oportunidades", "agent", "settings.json")), "the model was projected into its own agent dir");
	await waitFor(() => !svc.running.has("oportunidades"));
	assert.equal(fs.existsSync(path.join(island, "minikodas", "engines", "oportunidades", "agent", "auth.json")), false, "the copied credential does not stay between runs");
	assert.equal(fs.existsSync(path.join(island, "agent", "auth.json")), false, "the chat engine's agent dir is never touched");
});

test("S4 never-overlapping launches per Minikoda; a failed run lands as an error (never silent); delete removes its private root", async (t) => {
	const base = tmp(t);
	const { svc, results, island } = service(t, base, { steps: [{ hang: true }], runTimeoutMs: 600 });
	await svc.createDraft(recipe());
	await svc.approveCreate("oportunidades");
	assert.equal((await svc.launch("oportunidades")).started, true);
	assert.deepEqual(await svc.launch("oportunidades"), { started: false, reason: "running" });
	await waitFor(() => results.errors.length === 1);
	assert.equal(results.runs.length, 0);
	assert.match(results.errors[0].text, /falló \(timeout\)/);
	assert.equal(svc.get("oportunidades").lastRun.reason, "timeout");
	const root = path.join(island, "minikodas", "engines", "oportunidades");
	assert.ok(fs.existsSync(root));
	await svc.delete("oportunidades");
	assert.equal(fs.existsSync(root), false);
	assert.deepEqual(svc.list(), []);
	await assert.rejects(svc.launch("oportunidades"), (e) => e.code === "unknown_minikoda");
});

test("S4 the scheduler launches an approved Minikoda without anyone calling launch, and never overlaps it", async (t) => {
	const base = tmp(t);
	const { svc, results } = service(t, base);
	const starts = [];
	const skips = [];
	svc.scheduler.on("fired", (e) => starts.push(e));
	svc.scheduler.on("skipped", (e) => skips.push(e));
	let maxRunning = 0;
	svc.on("changed", () => { maxRunning = Math.max(maxRunning, svc.running.size); });
	await svc.createDraft(recipe({ when: { everyMs: 50 } }));
	await sleep(200);
	assert.equal(starts.length, 0, "a draft is never scheduled");
	await svc.approveCreate("oportunidades");
	await waitFor(() => results.runs.length >= 1, 15_000);
	assert.ok(starts.length >= 1);
	assert.equal(maxRunning, 1, "one run of this Minikoda at a time");
	assert.ok(skips.every((s) => s.reason === "running"));
});

/** Races `promise` against a deadline so a deadlock fails the test instead of hanging the suite. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms (deadlock)`)), ms))]);

test("B1 deleting a Minikoda while its run never ends cancels the run, deletes it and leaves the service usable", async (t) => {
	const base = tmp(t);
	const { svc, results, island } = service(t, base, { steps: [{ hang: true }], runTimeoutMs: 600_000 });
	await svc.createDraft(recipe());
	await svc.approveCreate("oportunidades");
	await svc.createDraft(recipe({ id: "otro", name: "Otro" }));
	assert.equal((await svc.launch("oportunidades")).started, true);
	await sleep(300);
	assert.deepEqual(await within(svc.delete("oportunidades"), 5000, "delete"), { id: "oportunidades", deleted: true });
	assert.equal(results.errors.length, 1, "the cancelled run is recorded, never silent");
	assert.match(results.errors[0].text, /cancelled/);
	assert.deepEqual(svc.list().map((m) => m.id), ["otro"]);
	assert.equal(fs.existsSync(path.join(island, "minikodas", "engines", "oportunidades")), false);
	// The store queue is not stuck: the next mutation goes through.
	assert.equal((await within(svc.approveCreate("otro"), 5000, "approveCreate after delete")).status, "active");
	await within(svc.stop(), 5000, "stop after delete");
});

test("B1 stop() while a delete is cancelling a never-ending run settles both", async (t) => {
	const base = tmp(t);
	const { svc, results } = service(t, base, { steps: [{ hang: true }], runTimeoutMs: 600_000 });
	await svc.createDraft(recipe());
	await svc.approveCreate("oportunidades");
	await svc.launch("oportunidades");
	await sleep(300);
	const deleting = svc.delete("oportunidades");
	await within(Promise.all([deleting, svc.stop()]), 5000, "delete + stop");
	assert.equal(results.errors.length, 1);
	assert.deepEqual(svc.list(), []);
	assert.deepEqual(await svc.launch("oportunidades"), { started: false, reason: "stopped" });
});

test("S4 a stored Minikoda survives a restart; the daemon stop cancels a run in flight and records it as failed", async (t) => {
	const base = tmp(t);
	const first = service(t, base, { steps: [{ hang: true }], runTimeoutMs: 60_000 });
	await first.svc.createDraft(recipe());
	await first.svc.approveCreate("oportunidades");
	await first.svc.launch("oportunidades");
	await sleep(300);
	await first.svc.stop();
	assert.equal(first.results.errors.length, 1);
	assert.match(first.results.errors[0].text, /cancelled/);
	const again = service(t, base);
	assert.deepEqual(again.svc.list().map((m) => [m.id, m.status]), [["oportunidades", "active"]]);
});

// ---------- S11: OAuth credential copy and write-back («1a») ----------
// FAKE tokens only; the fake Pi's `rotate` step refreshes under the SDK lock like Pi does.

const oauth = (tag, expires) => ({ type: "oauth", access: `FAKE-ACCESS-${tag}`, refresh: `FAKE-REFRESH-${tag}`, expires });
const readAuth = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Account `main` signed in with OAuth; a chat agent dir whose active profile is `main`/`fake` (or not). */
function oauthFixture(t, base, { account, chatLive, chatActive = true, steps }) {
	const s = service(t, base, { steps, options: {} });
	fs.writeFileSync(path.join(s.fx.accountsRoot, "main", "auth.json"), JSON.stringify({ fake: account }), { mode: 0o600 });
	fs.writeFileSync(path.join(s.fx.accountsRoot, "main", "account.json"), JSON.stringify({ accountId: "main", provider: "fake" }), { mode: 0o600 });
	const chatDir = path.join(base, "chat");
	const agentDir = path.join(chatDir, "agent");
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	if (chatLive) fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ fake: chatLive }), { mode: 0o600 });
	const activeAccountPath = path.join(chatDir, "active-account.json");
	if (chatActive) fs.writeFileSync(activeAccountPath, JSON.stringify({ accountId: "main", provider: "fake" }), { mode: 0o600 });
	s.svc.options.chat = { agentDir, activeAccountPath };
	return { ...s, chatAuth: path.join(agentDir, "auth.json"), accountAuth: path.join(s.fx.accountsRoot, "main", "auth.json"), agentDir };
}

async function runOnce(svc, results, n = 1, ms = 10_000) {
	await svc.createDraft(recipe());
	await svc.approveCreate("oportunidades");
	assert.equal((await svc.launch("oportunidades")).started, true);
	await waitFor(() => results.runs.length + results.errors.length >= n, ms);
	await waitFor(() => !svc.running.has("oportunidades"), ms);
}

test("S11 a token rotated inside the Minikoda is written back to the account AND to the chat's live credential", async (t) => {
	const base = tmp(t);
	const now = Date.now();
	const rotated = oauth("ROTATED", now + 3_600_000);
	const fx = oauthFixture(t, base, { account: oauth("OLD", now + 1_800_000), chatLive: oauth("OLD", now + 1_800_000), steps: [{ rotate: { provider: "fake", credential: rotated } }, ...STANDARD] });
	await runOnce(fx.svc, fx.results);
	assert.equal(fx.results.runs.length, 1, "the run itself succeeded");
	assert.deepEqual(readAuth(fx.accountAuth).fake, rotated, "the account store has the rotated token");
	assert.deepEqual(readAuth(fx.chatAuth).fake, rotated, "the chat's live credential has the rotated token");
	if (posix) for (const f of [fx.accountAuth, fx.chatAuth]) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
	for (const dir of [path.dirname(fx.accountAuth), fx.agentDir]) assert.equal(fs.existsSync(path.join(dir, "auth.json.lock")), false, "locks released");
});

test("S11 the chat is on another account: only the account store gets the rotated token, the chat file is untouched", async (t) => {
	const base = tmp(t);
	const now = Date.now();
	const rotated = oauth("ROTATED", now + 3_600_000);
	const other = oauth("OTHER-ACCOUNT", now + 60_000);
	const fx = oauthFixture(t, base, { account: oauth("OLD", now + 1_800_000), chatLive: other, chatActive: false, steps: [{ rotate: { provider: "fake", credential: rotated } }, ...STANDARD] });
	await runOnce(fx.svc, fx.results);
	assert.deepEqual(readAuth(fx.accountAuth).fake, rotated);
	assert.deepEqual(readAuth(fx.chatAuth).fake, other);
});

test("S11 a stale account copy: the chat's fresher live token is the one copied into the run", async (t) => {
	const base = tmp(t);
	const now = Date.now();
	const stale = oauth("STALE", now + 60_000);
	const live = oauth("CHAT-REFRESHED", now + 3_600_000);
	const report = path.join(base, "report.json");
	const fx = oauthFixture(t, base, { account: stale, chatLive: live, steps: STANDARD });
	fx.svc.options.engine = fakeEngine(script(base, STANDARD, "s.json"), report);
	await runOnce(fx.svc, fx.results);
	assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")).authSeen, { fake: live }, "the fresher chat token was copied in");
	assert.deepEqual(readAuth(fx.chatAuth).fake, live);
	// Nothing rotated in the run: the Minikoda copy equals what was copied in, so nothing is written back.
	assert.deepEqual(readAuth(fx.accountAuth).fake, stale, "the run never writes an unchanged copy");
});

test("S11 never an older token over a newer one; logout is never undone", async (t) => {
	const { writeBackCredential, freshestCredential } = require("../src/minikodas/credentials.cjs");
	const base = tmp(t);
	const now = Date.now();
	const accountsRoot = path.join(base, "accounts");
	fs.mkdirSync(path.join(accountsRoot, "main"), { recursive: true, mode: 0o700 });
	const chatDir = path.join(base, "chat", "agent");
	fs.mkdirSync(chatDir, { recursive: true, mode: 0o700 });
	const activeAccountPath = path.join(base, "chat", "active-account.json");
	fs.writeFileSync(activeAccountPath, JSON.stringify({ accountId: "main", provider: "fake" }));
	const chat = { agentDir: chatDir, activeAccountPath };
	const accountAuth = path.join(accountsRoot, "main", "auth.json");
	const chatAuth = path.join(chatDir, "auth.json");
	const args = { accountsRoot, accountId: "main", provider: "fake", chat };
	const newest = oauth("NEWEST", now + 7_200_000);
	fs.writeFileSync(accountAuth, JSON.stringify({ fake: newest, other: { type: "api_key", key: "FAKE" } }));
	fs.writeFileSync(chatAuth, JSON.stringify({ fake: newest }));
	const out = await writeBackCredential({ ...args, before: oauth("A", now), after: oauth("B", now + 3_600_000) });
	assert.deepEqual(out, { account: false, chat: false });
	assert.deepEqual(readAuth(accountAuth).fake, newest);
	assert.deepEqual(readAuth(chatAuth).fake, newest);
	// Logout on both sides: nothing is refilled.
	fs.writeFileSync(accountAuth, JSON.stringify({ other: { type: "api_key", key: "FAKE" } }));
	fs.writeFileSync(chatAuth, JSON.stringify({}));
	assert.deepEqual(await writeBackCredential({ ...args, before: undefined, after: oauth("C", now + 9_000_000) }), { account: false, chat: false });
	assert.equal(readAuth(accountAuth).fake, undefined);
	assert.equal(await freshestCredential(args), undefined, "the account store decides signed-in");
	// An api key credential is never written back (only OAuth refreshes).
	fs.writeFileSync(accountAuth, JSON.stringify({ fake: { type: "api_key", key: "FAKE-1" } }));
	assert.deepEqual(await writeBackCredential({ ...args, before: undefined, after: { type: "api_key", key: "FAKE-2" } }), { account: false, chat: false });
	// A profile switch in progress (journal left) makes the chat side unknown: it is left alone.
	fs.writeFileSync(chatAuth, JSON.stringify({ fake: oauth("CHAT", now) }));
	fs.writeFileSync(path.join(chatDir, ".switch.json"), "{}");
	fs.writeFileSync(accountAuth, JSON.stringify({ fake: oauth("ACC", now) }));
	assert.deepEqual(await writeBackCredential({ ...args, before: undefined, after: oauth("D", now + 1000) }), { account: true, chat: false });
});

test("S11 concurrent writers under the SDK lock never lose the newest token", async (t) => {
	const { writeBackCredential, lockCredentials } = require("../src/minikodas/credentials.cjs");
	const base = tmp(t);
	const now = Date.now();
	const accountsRoot = path.join(base, "accounts");
	fs.mkdirSync(path.join(accountsRoot, "main"), { recursive: true, mode: 0o700 });
	const chatDir = path.join(base, "chat", "agent");
	fs.mkdirSync(chatDir, { recursive: true, mode: 0o700 });
	const activeAccountPath = path.join(base, "chat", "active-account.json");
	fs.writeFileSync(activeAccountPath, JSON.stringify({ accountId: "main", provider: "fake" }));
	const accountAuth = path.join(accountsRoot, "main", "auth.json");
	const chatAuth = path.join(chatDir, "auth.json");
	fs.writeFileSync(accountAuth, JSON.stringify({ fake: oauth("START", now) }));
	fs.writeFileSync(chatAuth, JSON.stringify({ fake: oauth("START", now) }));
	const args = { accountsRoot, accountId: "main", provider: "fake", chat: { agentDir: chatDir, activeAccountPath } };
	// The chat engine holds its lock and refreshes to the newest token while a Minikoda write-back waits.
	const release = await lockCredentials(chatDir);
	const waiting = writeBackCredential({ ...args, before: oauth("START", now), after: oauth("MINIKODA", now + 1_000_000) });
	await sleep(150);
	assert.deepEqual(readAuth(chatAuth).fake, oauth("START", now), "nothing written while the chat holds its lock");
	const chatNewest = oauth("CHAT-NEWEST", now + 2_000_000);
	fs.writeFileSync(chatAuth, JSON.stringify({ fake: chatNewest }));
	release();
	assert.deepEqual(await waiting, { account: true, chat: false });
	assert.deepEqual(readAuth(chatAuth).fake, chatNewest, "the chat's newer refresh survives");
	// Many write-backs at once (two Minikodas, several runs): the store ends with the freshest, never torn.
	const many = Array.from({ length: 12 }, (_, i) => writeBackCredential({ ...args, before: undefined, after: oauth(`W${i}`, now + 3_000_000 + i * 1000) }));
	await Promise.all(many);
	assert.deepEqual(readAuth(accountAuth).fake, oauth("W11", now + 3_000_000 + 11_000));
	assert.deepEqual(readAuth(chatAuth).fake, oauth("W11", now + 3_000_000 + 11_000));
});

// ---------- verifier follow-ups (T3b) ----------

test("F4 a custom (gateway) account gets its guarded provider extension passed with -e (-ne disables the auto-loaded one)", async (t) => {
	const base = tmp(t);
	const report = path.join(base, "report.json");
	const { svc, results, fx, island } = service(t, base, { fixture: { extra: [{ accountId: "gw", provider: "custom-gw", configured: true, custom: true }] } });
	fs.mkdirSync(path.join(fx.accountsRoot, "gw"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(fx.accountsRoot, "gw", "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "FAKE-GW-KEY" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(fx.accountsRoot, "gw", "models.json"), JSON.stringify({ providers: { "custom-gw": { baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "gw-model" }] } } }), { mode: 0o600 });
	svc.options.engine = fakeEngine(script(base, STANDARD, "gw.json"), report);
	await svc.createDraft(recipe({ model: { provider: "custom-gw", id: "gw-model", accountId: "gw" } }));
	await svc.approveCreate("oportunidades");
	await svc.launch("oportunidades");
	await waitFor(() => results.runs.length + results.errors.length === 1);
	const rep = JSON.parse(fs.readFileSync(report, "utf8"));
	const ext = path.join(island, "minikodas", "engines", "oportunidades", "agent", "extensions", "abito-custom-provider.js");
	assert.ok(rep.argv.includes("-ne"));
	assert.equal(rep.argv[rep.argv.indexOf(ext) - 1], "-e", "the custom provider extension is loaded explicitly");
	assert.deepEqual(rep.providers, ["custom-gw"], "the gateway provider is registered");
	assert.equal(results.runs.length, 1);
});

test("F5 S13: proposals parked before a run crashes are stored as pending, and the failure is reported with them", async (t) => {
	const base = tmp(t);
	const { svc, results } = service(t, base, { steps: [{ tool: "inbox_propose", args: { action: "buy", target: "MELI", text: "Oportunidad." } }, { crash: 3 }] });
	await svc.createDraft(recipe());
	await svc.approveCreate("oportunidades");
	await svc.launch("oportunidades");
	await waitFor(() => results.errors.length === 1);
	assert.equal(results.runs.length, 0);
	assert.deepEqual(results.errors[0].proposals, [{ action: "buy", target: "MELI", text: "Oportunidad." }]);
	assert.match(results.errors[0].text, /falló \(crashed\)/);
	assert.match(results.errors[0].text, /1 propuesta\(s\) de esa corrida quedaron pendientes/);
});

test("F6 a proposal target loses Unicode format characters (bidi overrides) and must be one line", async (t) => {
	const { readProposals } = require("../src/minikodas/runner.cjs");
	const base = tmp(t);
	const file = path.join(base, "p.jsonl");
	const lines = [
		{ action: "sell", target: "AC\u202eEM\u202c", text: "ok" },
		{ action: "buy", target: "A\nB", text: "two lines" },
		{ action: "buy", target: "A\u2028B", text: "line separator" },
		{ action: "buy", target: "\u200b\u2066", text: "only format chars" },
	];
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
	assert.deepEqual(readProposals(file), { proposals: [{ action: "sell", target: "ACEM", text: "ok" }], discarded: 3 });
	// The kit refuses it up front, so the model sees the error and nothing is parked.
	const root = path.join(base, "engines", "k");
	const steps = [
		{ tool: "inbox_propose", args: { action: "sell", target: "AC\nME", text: "x" } },
		{ tool: "inbox_propose", args: { action: "sell", target: "\u202eACME", text: "x" } },
		{ text: "Listo." },
	];
	const r = await runMinikoda({ recipe: validateRecipe(recipe()), root, runId: "r1", engine: fakeEngine(script(base, steps)) });
	assert.deepEqual(r.toolCalls.map((c) => c.isError), [true, false]);
	assert.match(r.toolCalls[0].text, /one line/);
	assert.deepEqual(r.proposals, [{ action: "sell", target: "ACME", text: "x" }]);
});

test("F9 a one-time `at` run that is due while paused (or busy) is reported, never silently lost", async (t) => {
	const missed = [];
	let paused = true;
	const s = new Scheduler({ launch: async () => ({ started: false, reason: "busy" }), isPaused: () => paused, onMissed: (e) => missed.push(e) });
	t.after(() => s.stop());
	s.add(validateRecipe(recipe({ id: "pausada", when: { at: new Date(Date.now() + 50).toISOString() } })));
	s.add(validateRecipe(recipe({ id: "cada", when: { everyMs: 50 } }), { minEveryMs: 1 }));
	await sleep(300);
	paused = false;
	s.add(validateRecipe(recipe({ id: "ocupada", when: { at: new Date(Date.now() + 50).toISOString() } })));
	await sleep(300);
	assert.deepEqual(missed.map((m) => [m.minikoda, m.reason]), [["pausada", "paused"], ["ocupada", "busy"]], "only one-time runs are reported; repeating ticks just skip");
	// The service turns it into an error item in «Hoy».
	const base = tmp(t);
	const { svc, results } = service(t, base, { options: { isPaused: () => true } });
	await svc.createDraft(recipe({ when: { at: new Date(Date.now() + 2000).toISOString() } }));
	await svc.approveCreate("oportunidades");
	await waitFor(() => results.errors.length === 1, 10_000);
	assert.match(results.errors[0].text, /no se hizo \(paused\)/);
	assert.equal(results.runs.length, 0);
});

test("F10 the copied auth.json is removed after every run (done or failed) and when the copy step fails", async (t) => {
	const base = tmp(t);
	const { svc, results, island, fx } = service(t, base);
	const auth = path.join(island, "minikodas", "engines", "oportunidades", "agent", "auth.json");
	await svc.createDraft(recipe());
	await svc.approveCreate("oportunidades");
	await svc.launch("oportunidades");
	await waitFor(() => results.runs.length === 1);
	await waitFor(() => !svc.running.has("oportunidades"));
	assert.equal(fs.existsSync(auth), false, "removed after a done run");
	svc.options.engine = fakeEngine(script(base, [{ crash: 3 }], "c.json"));
	await svc.launch("oportunidades");
	await waitFor(() => results.errors.length === 1);
	await waitFor(() => !svc.running.has("oportunidades"));
	assert.equal(fs.existsSync(auth), false, "removed after a failed run");
	// The copy step fails after the credential was written (the model is no longer offered by the account).
	fs.writeFileSync(path.join(fx.accountsRoot, "main", "models.json"), "{}");
	const gw = { accountId: "main", provider: "fake", configured: true, custom: true };
	svc.options.accounts = { ...fx.accounts, listAccounts: () => [gw] };
	await svc.launch("oportunidades");
	await waitFor(() => results.errors.length === 2);
	await waitFor(() => !svc.running.has("oportunidades"));
	assert.match(results.errors[1].text, /model_unavailable/);
	assert.equal(fs.existsSync(auth), false, "removed when the copy step fails");
});

// ---------- T3c: credential write-back hardening (re-verify mwdcsca1, F-A..F-F) ----------

/** Account `main` and a chat agent dir whose active profile is `main`/`fake`, for the credentials.cjs unit tests. */
function credentialStores(t) {
	const base = tmp(t);
	const accountsRoot = path.join(base, "accounts");
	const accountDir = path.join(accountsRoot, "main");
	fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
	const chatDir = path.join(base, "chat", "agent");
	fs.mkdirSync(chatDir, { recursive: true, mode: 0o700 });
	const activeAccountPath = path.join(base, "chat", "active-account.json");
	fs.writeFileSync(activeAccountPath, JSON.stringify({ accountId: "main", provider: "fake" }));
	const accountAuth = path.join(accountDir, "auth.json");
	const chatAuth = path.join(chatDir, "auth.json");
	const put = (account, chat) => {
		fs.writeFileSync(accountAuth, JSON.stringify({ fake: account }));
		fs.writeFileSync(chatAuth, JSON.stringify({ fake: chat ?? account }));
	};
	return { base, accountDir, chatDir, accountAuth, chatAuth, put, args: { accountsRoot, accountId: "main", provider: "fake", chat: { agentDir: chatDir, activeAccountPath } } };
}
const NOTHING = { account: false, chat: false };
const BOTH = { account: true, chat: true };

test("F-A a forged OAuth credential never replaces an API key (account store or chat) and is never copied in over one", async (t) => {
	const { writeBackCredential, freshestCredential } = require("../src/minikodas/credentials.cjs");
	const s = credentialStores(t);
	const now = Date.now();
	const key = { type: "api_key", key: "FAKE-KEY" };
	s.put(key);
	for (const before of [key, undefined]) {
		assert.deepEqual(await writeBackCredential({ ...s.args, before, after: oauth("FORGED", now + 3_600_000) }), NOTHING, `before=${before?.type}`);
		assert.deepEqual(readAuth(s.accountAuth).fake, key, "the account keeps its API key (the only copy)");
		assert.deepEqual(readAuth(s.chatAuth).fake, key, "the chat keeps its API key");
	}
	// Copy-in: an OAuth token in the chat file never wins over the account's API key.
	fs.writeFileSync(s.chatAuth, JSON.stringify({ fake: oauth("LIVE", now + 3_600_000) }));
	assert.deepEqual(await freshestCredential(s.args), key);
	// OAuth copied in, but the account now holds an API key (the user switched): nothing is written.
	assert.deepEqual(await writeBackCredential({ ...s.args, before: oauth("A", now + 1000), after: oauth("B", now + 3_600_000) }), NOTHING);
	assert.deepEqual(readAuth(s.accountAuth).fake, key);
	// The account holds an API key while the chat still holds OAuth for it: the chat is not refreshed either.
	s.put(key, oauth("A", now + 1000));
	assert.deepEqual(await writeBackCredential({ ...s.args, before: oauth("A", now + 1000), after: oauth("B", now + 3_600_000) }), NOTHING);
	assert.deepEqual(readAuth(s.chatAuth).fake, oauth("A", now + 1000));
	// The account holds OAuth but the chat holds an API key for the same provider: both are left alone.
	s.put(oauth("A", now + 1000), key);
	assert.deepEqual(await writeBackCredential({ ...s.args, before: oauth("A", now + 1000), after: oauth("B", now + 3_600_000) }), NOTHING);
	assert.deepEqual(readAuth(s.accountAuth).fake, oauth("A", now + 1000));
	assert.deepEqual(readAuth(s.chatAuth).fake, key);
});

test("F-A end to end: a Minikoda engine that writes an OAuth credential over its copied API key changes nothing outside its root", async (t) => {
	const base = tmp(t);
	const key = { type: "api_key", key: "FAKE-KEY" };
	const forged = oauth("FORGED", Date.now() + 3_600_000);
	const fx = oauthFixture(t, base, { account: key, chatLive: key, steps: [{ rotate: { provider: "fake", credential: forged } }, ...STANDARD] });
	await runOnce(fx.svc, fx.results);
	assert.equal(fx.results.runs.length, 1);
	assert.deepEqual(readAuth(fx.accountAuth).fake, key, "the account's API key survives");
	assert.deepEqual(readAuth(fx.chatAuth).fake, key, "the chat's API key survives");
});

test("F-A a huge or far-future expiry is refused; at most one year ahead is accepted", async (t) => {
	const { writeBackCredential } = require("../src/minikodas/credentials.cjs");
	const s = credentialStores(t);
	const now = Date.now();
	const day = 86_400_000;
	const before = oauth("A", now + 3_600_000);
	for (const expires of [8.64e15, now + 366 * day]) {
		s.put(before);
		assert.deepEqual(await writeBackCredential({ ...s.args, before, after: oauth("PINNED", expires) }), NOTHING, `expires=${expires}`);
		assert.deepEqual(readAuth(s.accountAuth).fake, before);
		assert.deepEqual(readAuth(s.chatAuth).fake, before);
	}
	assert.deepEqual(await writeBackCredential({ ...s.args, before, after: oauth("B", now + 364 * day) }), BOTH);
});

test("F-A the refreshed token must expire strictly later than the copied-in one and than what each side holds", async (t) => {
	const { writeBackCredential } = require("../src/minikodas/credentials.cjs");
	const s = credentialStores(t);
	const T = Date.now() + 3_600_000;
	// Equal expiry, different token: never written (a `>=` would let a same-age forgery through).
	s.put(oauth("A", T));
	assert.deepEqual(await writeBackCredential({ ...s.args, before: oauth("A", T), after: oauth("B", T) }), NOTHING);
	assert.deepEqual(readAuth(s.accountAuth).fake, oauth("A", T));
	// Both sides hold an OLDER token than the one copied in: `after` must still beat the copied-in expiry.
	s.put(oauth("S", T - 1000));
	assert.deepEqual(await writeBackCredential({ ...s.args, before: oauth("A", T), after: oauth("B", T) }), NOTHING);
	assert.deepEqual(readAuth(s.accountAuth).fake, oauth("S", T - 1000));
	assert.deepEqual(await writeBackCredential({ ...s.args, before: oauth("A", T), after: oauth("B", T + 1) }), BOTH);
	assert.deepEqual(readAuth(s.chatAuth).fake, oauth("B", T + 1));
});

test("F-A only {type, access, refresh, expires} and fields the copied-in credential already had are written back", async (t) => {
	const { writeBackCredential } = require("../src/minikodas/credentials.cjs");
	const s = credentialStores(t);
	const T = Date.now() + 3_600_000;
	const before = { ...oauth("A", T), accountId: "acct-1" };
	s.put(before);
	const after = { ...oauth("B", T + 60_000), accountId: "acct-2", enterpriseUrl: "https://forged.invalid", headers: { x: "y" } };
	assert.deepEqual(await writeBackCredential({ ...s.args, before, after }), BOTH);
	const expected = { type: "oauth", access: "FAKE-ACCESS-B", refresh: "FAKE-REFRESH-B", expires: T + 60_000, accountId: "acct-2" };
	assert.deepEqual(readAuth(s.accountAuth).fake, expected);
	assert.deepEqual(readAuth(s.chatAuth).fake, expected);
});

test("F-F lock order is always chat, then account (never the account lock while waiting for the chat's)", async (t) => {
	const { writeBackCredential, freshestCredential, lockCredentials } = require("../src/minikodas/credentials.cjs");
	const s = credentialStores(t);
	const T = Date.now() + 3_600_000;
	s.put(oauth("A", T));
	const accountLock = path.join(s.accountDir, "auth.json.lock");
	const chatLock = path.join(s.chatDir, "auth.json.lock");
	for (const call of [() => writeBackCredential({ ...s.args, before: oauth("A", T), after: oauth("B", T + 1000) }), () => freshestCredential(s.args)]) {
		const releaseChat = await lockCredentials(s.chatDir);
		const waiting = call();
		await sleep(150);
		assert.equal(fs.existsSync(accountLock), false, "the account lock is not taken before the chat lock");
		releaseChat();
		await waiting;
		const releaseAccount = await lockCredentials(s.accountDir);
		const second = call();
		await sleep(150);
		assert.equal(fs.existsSync(chatLock), true, "the chat lock is taken first and held while the account lock is awaited");
		releaseAccount();
		await second;
		assert.equal(fs.existsSync(chatLock) || fs.existsSync(accountLock), false, "both released");
	}
});

test("F-B an OAuth session that expires before the run could end is not copied in: «Hoy» asks to renew it in the chat", async (t) => {
	const base = tmp(t);
	const now = Date.now();
	const report = path.join(base, "report.json");
	// runTimeoutMs 10 s: a session needs at least 10 s + 5 min + the margin left.
	const soon = oauth("SOON", now + 120_000);
	const fx = oauthFixture(t, base, { account: soon, chatLive: soon, steps: STANDARD });
	fx.svc.options.engine = fakeEngine(script(base, STANDARD, "s.json"), report);
	fx.svc.options.accounts = { ...fx.svc.options.accounts, listAccounts: () => [{ accountId: "main", provider: "fake", configured: true, label: "Trabajo" }] };
	await runOnce(fx.svc, fx.results);
	assert.equal(fx.results.runs.length, 0);
	assert.equal(fx.results.errors.length, 1);
	assert.match(fx.results.errors[0].text, /la sesión de Trabajo vence pronto; abrí el chat para renovarla/);
	assert.equal(fx.svc.get("oportunidades").lastRun.reason, "model_unavailable");
	assert.equal(fs.existsSync(report), false, "the engine never started");
	assert.equal(fs.existsSync(path.join(fx.island, "minikodas", "engines", "oportunidades", "agent", "auth.json")), false, "nothing was copied in");
	assert.deepEqual(readAuth(fx.accountAuth).fake, soon);
	// Enough lifetime left (just above the bound): the run goes ahead with that session.
	const enough = oauth("ENOUGH", Date.now() + 10_000 + 360_000 + 30_000);
	fs.writeFileSync(fx.accountAuth, JSON.stringify({ fake: enough }));
	fs.writeFileSync(fx.chatAuth, JSON.stringify({ fake: enough }));
	await fx.svc.launch("oportunidades");
	await waitFor(() => fx.results.runs.length === 1);
	assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")).authSeen, { fake: enough });
});

/**
 * A run whose engine rotates the token, but whose write-back cannot take the account lock: the copy is kept.
 * Returns the fixture with `release` (frees the account lock) and the kept copy's path.
 */
async function keptCopy(t, base) {
	const { lockCredentials } = require("../src/minikodas/credentials.cjs");
	const now = Date.now();
	const rotated = oauth("ROTATED", now + 7_200_000);
	const go = path.join(base, "go");
	const fx = oauthFixture(t, base, { account: oauth("OLD", now + 3_600_000), chatLive: oauth("OLD", now + 3_600_000), steps: [{ rotate: { provider: "fake", credential: rotated } }, { waitFile: go }, ...STANDARD] });
	fx.svc.options.credentialLockWaitMs = 200;
	const runAuth = path.join(fx.island, "minikodas", "engines", "oportunidades", "agent", "auth.json");
	await fx.svc.createDraft(recipe());
	await fx.svc.approveCreate("oportunidades");
	assert.equal((await fx.svc.launch("oportunidades")).started, true);
	// The fake engine writes in place (not atomically): a read can land mid-write.
	await waitFor(() => { try { return readAuth(runAuth).fake?.access === rotated.access; } catch { return false; } });
	let held = await lockCredentials(path.dirname(fx.accountAuth));
	const release = () => { held?.(); held = undefined; };
	t.after(release);
	fs.writeFileSync(go, "");
	await waitFor(() => fx.results.runs.length === 1);
	await waitFor(() => !fx.svc.running.has("oportunidades"));
	assert.deepEqual(readAuth(runAuth).fake, rotated, "the copy that could not be written back is kept");
	assert.deepEqual(readAuth(fx.accountAuth).fake, oauth("OLD", now + 3_600_000));
	return { ...fx, rotated, runAuth, release };
}

test("F-C a kept copy is written back before the next run of that Minikoda", async (t) => {
	const base = tmp(t);
	const fx = await keptCopy(t, base);
	fx.release();
	fx.svc.options.engine = fakeEngine(script(base, STANDARD, "second.json"));
	await fx.svc.launch("oportunidades");
	await waitFor(() => fx.results.runs.length === 2);
	await waitFor(() => !fx.svc.running.has("oportunidades"));
	assert.deepEqual(readAuth(fx.accountAuth).fake, fx.rotated, "the rotated token reached the account");
	assert.deepEqual(readAuth(fx.chatAuth).fake, fx.rotated, "and the chat");
	assert.equal(fs.existsSync(fx.runAuth), false);
});

test("F-C a kept copy is settled when the daemon starts again, without any run", async (t) => {
	const base = tmp(t);
	const fx = await keptCopy(t, base);
	await fx.svc.stop();
	fx.release();
	const results = { runs: [], errors: [], addRun: async (r) => { results.runs.push(r); }, addError: async (e) => { results.errors.push(e); } };
	const again = new MinikodaService({ ...fx.svc.options, results });
	t.after(() => again.stop());
	await again.start();
	assert.deepEqual(readAuth(fx.accountAuth).fake, fx.rotated);
	assert.deepEqual(readAuth(fx.chatAuth).fake, fx.rotated);
	assert.equal(fs.existsSync(fx.runAuth), false, "settled and removed");
	assert.equal(results.runs.length + results.errors.length, 0, "nothing ran");
});

test("F-C deleting a Minikoda writes its kept copy back first; while that fails the Minikoda and its copy stay", async (t) => {
	const base = tmp(t);
	const fx = await keptCopy(t, base);
	const root = path.join(fx.island, "minikodas", "engines", "oportunidades");
	await assert.rejects(fx.svc.delete("oportunidades"), (e) => e.code === "failed");
	assert.deepEqual(readAuth(fx.runAuth).fake, fx.rotated, "the copy survives a delete whose write-back failed");
	assert.deepEqual(fx.svc.list().map((m) => m.id), ["oportunidades"]);
	fx.release();
	assert.deepEqual(await fx.svc.delete("oportunidades"), { id: "oportunidades", deleted: true });
	assert.deepEqual(readAuth(fx.accountAuth).fake, fx.rotated, "the rotated token reached the account before the root was removed");
	assert.equal(fs.existsSync(root), false);
});

test("F-D a refresh still in flight when the engine is stopped finishes (stop grace >= 20 s, no SIGTERM at 5 s)", async (t) => {
	const base = tmp(t);
	const now = Date.now();
	const rotated = oauth("LATE", now + 7_200_000);
	const fx = oauthFixture(t, base, { account: oauth("OLD", now + 3_600_000), chatLive: oauth("OLD", now + 3_600_000), steps: STANDARD });
	const file = path.join(base, "late.json");
	fs.writeFileSync(file, JSON.stringify({ steps: STANDARD, onEnd: { delayMs: 6000, rotate: { provider: "fake", credential: rotated } } }));
	fx.svc.options.engine = fakeEngine(file);
	await runOnce(fx.svc, fx.results, 1, 40_000);
	assert.equal(fx.results.runs.length, 1);
	assert.deepEqual(readAuth(fx.accountAuth).fake, rotated, "the refresh that ended after stdin closed was written back");
});

test("F-F a Minikoda being deleted cannot be launched again meanwhile", async (t) => {
	const base = tmp(t);
	const { svc } = service(t, base);
	await svc.createDraft(recipe());
	await svc.approveCreate("oportunidades");
	let open;
	svc.serial(() => new Promise((resolve) => { open = resolve; }));
	const deleting = svc.delete("oportunidades");
	await sleep(20);
	await assert.rejects(svc.launch("oportunidades"), (e) => e.code === "unknown_minikoda");
	assert.equal(svc.running.size, 0, "no run started during the deletion");
	open();
	assert.deepEqual(await deleting, { id: "oportunidades", deleted: true });
});
