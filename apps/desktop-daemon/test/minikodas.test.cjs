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
	reads: { source: "telegram:canal-x" },
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
	// A draft may omit id and model (the daemon fills them), a stored recipe may not.
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
	assert.ok(fs.existsSync(path.join(island, "minikodas", "engines", "oportunidades", "agent", "auth.json")));
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
