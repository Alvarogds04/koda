"use strict";

// K2-13 Minikodas, commit 2 (T4, S3/S5): the «Hoy» inbox with PIN approve-later, the protocol frames
// (allowlist + DTOs), the server verbs and the daemon wiring end to end. Offline: fake Pi (loads the real kit
// extension), fake auth helper; no model, no network, no real ~/.pi or ~/.abito-island.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const P = require("../src/protocol.cjs");
const { IslandServer } = require("../src/server.cjs");
const { HoyInbox, PIN_ATTEMPTS, PIN_LOCK_MS } = require("../src/minikodas/hoy.cjs");
const { Minikodas } = require("../src/minikodas/index.cjs");

const FAKE_PI = path.join(__dirname, "fixtures", "minikodas", "fake-pi.cjs");
const FAKE_AGENT = path.join(__dirname, "fixtures", "fake-agent.cjs");
const FAKE_AUTH = path.join(__dirname, "fixtures", "fake-auth.cjs");
const PIN = "246810"; // test-only PIN for throwaway inboxes
const CHEAP_SCRYPT = { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const posix = process.platform !== "win32";
const TOKEN = "t".repeat(43);
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
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-hoy-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
	return base;
}
const recipe = (over = {}) => ({
	id: "oportunidades",
	name: "Oportunidades",
	when: { manual: true },
	reads: { source: "telegram:canal-x" },
	kit: ["source_read", "inbox_propose"],
	prompt: "Sos un Minikoda de oportunidades de inversión.",
	model: { provider: "anthropic", id: "claude-sonnet-5" },
	never: ["buy", "sell", "send", "delete"],
	...over,
});
function script(base, steps, name = "script.json") {
	const file = path.join(base, name);
	fs.writeFileSync(file, JSON.stringify({ steps }));
	return file;
}
/** The scripted turn: bash attempt, source read, ONE real sell proposal, a text that CLAIMS more proposals. */
const STANDARD = [
	{ tool: "bash", args: { marker: "minikoda-bash-ran.txt" } },
	{ tool: "source_read" },
	{ tool: "inbox_propose", args: { action: "sell", target: "ACME", text: "El post dice «ACME pierde el contrato»." } },
	{ tool: "inbox_propose", args: { action: "delete", target: "cartera", text: "borrar todo" } },
	{ text: "Dejé 3 propuestas en Hoy: vender ACME, comprar MELI y enviar el resumen. Ya ejecuté la compra de MELI." },
];

// ---------- «Hoy» inbox ----------

async function inboxWithRun(dir, opts = {}) {
	const inbox = new HoyInbox({ dir, ...opts });
	assert.deepEqual(await inbox.setPin(PIN), { ok: true });
	const added = await inbox.addRun({ minikoda: "oportunidades", resultText: "Considerar venta: ACME.", proposals: [{ action: "sell", target: "ACME", text: "Motivo" }] });
	return { inbox, proposal: added.find((i) => i.kind === "proposal"), result: added.find((i) => i.kind === "result") };
}

test("S3 Hoy: the proposal is pending and nothing executes before approval; the PIN is stored only as a salted scrypt hash (0600)", async (t) => {
	const dir = path.join(tmp(t), "hoy");
	const { inbox, proposal, result } = await inboxWithRun(dir);
	assert.equal(result.status, "approved", "a result has nothing to decide");
	assert.equal(proposal.status, "pending");
	assert.equal(proposal.action, "sell");
	assert.deepEqual(inbox.approvedEntries(), [], "nothing executed before approval");
	const pin = JSON.parse(fs.readFileSync(path.join(dir, "pin.json"), "utf8"));
	assert.equal(pin.kdf, "scrypt");
	assert.equal(pin.N, 1 << 15);
	assert.equal(Buffer.from(pin.salt, "base64").length, 16);
	assert.equal(fs.readFileSync(path.join(dir, "pin.json"), "utf8").includes(PIN), false, "never the PIN in clear");
	if (posix) for (const f of ["hoy.jsonl", "pin.json", "approved.jsonl"]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
	if (posix) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	const second = new HoyInbox({ dir });
	assert.notEqual(JSON.parse(fs.readFileSync(second.pinFile, "utf8")).hash, Buffer.from(PIN).toString("base64"));
});

test("S3 approve-later: wrong PIN refused (state unchanged); right PIN executes exactly once, even with two approvals sent together", async (t) => {
	const dir = path.join(tmp(t), "hoy");
	const { inbox, proposal } = await inboxWithRun(dir);
	const events = [];
	inbox.on("approved", (e) => events.push(e));
	const before = fs.readFileSync(inbox.file, "utf8");
	const wrong = await inbox.approve(proposal.id, "000000");
	assert.deepEqual(wrong, { ok: false, code: "pin_wrong", left: PIN_ATTEMPTS - 1 });
	assert.equal(fs.readFileSync(inbox.file, "utf8"), before, "a wrong PIN leaves Hoy unchanged");
	assert.deepEqual(inbox.approvedEntries(), []);
	assert.equal(events.length, 0);
	const [a, b] = await Promise.all([inbox.approve(proposal.id, PIN), inbox.approve(proposal.id, PIN)]);
	assert.equal(a.ok, true);
	assert.deepEqual(b, { ok: false, code: "not_pending" }, "the second approval is refused");
	assert.equal(inbox.approvedEntries().length, 1, "exactly one execution");
	assert.equal(events.length, 1, "exactly one approved event");
	assert.deepEqual([events[0].itemId, events[0].action, events[0].target], [proposal.id, "sell", "ACME"]);
	assert.deepEqual(await inbox.approve(proposal.id, PIN), { ok: false, code: "not_pending" });
	assert.equal(inbox.approvedEntries().length, 1);
	assert.equal(inbox.get(proposal.id).status, "approved");
});

test("S3 reject never executes, needs no PIN and is final; result/error items and unknown ids are not approvable", async (t) => {
	const dir = path.join(tmp(t), "hoy");
	const { inbox, proposal, result } = await inboxWithRun(dir);
	const events = [];
	inbox.on("approved", (e) => events.push(e));
	assert.equal((await inbox.reject(proposal.id)).ok, true);
	assert.deepEqual(inbox.approvedEntries(), [], "reject executes nothing");
	assert.deepEqual(await inbox.approve(proposal.id, PIN), { ok: false, code: "not_pending" });
	assert.deepEqual(await inbox.reject(proposal.id), { ok: false, code: "not_pending" });
	assert.deepEqual(await inbox.approve(result.id, PIN), { ok: false, code: "unknown_item" });
	const err = await inbox.addError({ minikoda: "oportunidades", text: "falló (timeout)" });
	assert.deepEqual(await inbox.approve(err.id, PIN), { ok: false, code: "unknown_item" });
	assert.deepEqual(await inbox.approve("00000000-0000-4000-8000-000000000000", PIN), { ok: false, code: "unknown_item" });
	assert.equal(events.length, 0);
	assert.deepEqual(inbox.approvedEntries(), []);
});

test("S3 5 wrong PINs lock approvals for 15 minutes; the lock survives a restart; even the right PIN is refused while locked", async (t) => {
	const dir = path.join(tmp(t), "hoy");
	const { inbox, proposal } = await inboxWithRun(dir);
	const codes = [];
	for (let i = 0; i < PIN_ATTEMPTS; i++) codes.push((await inbox.approve(proposal.id, "111111")).code);
	assert.deepEqual(codes, ["pin_wrong", "pin_wrong", "pin_wrong", "pin_wrong", "pin_locked"]);
	assert.equal((await inbox.approve(proposal.id, PIN)).code, "pin_locked");
	assert.equal(inbox.pinStatus().locked, true);
	const restarted = new HoyInbox({ dir });
	assert.equal((await restarted.approve(proposal.id, PIN)).code, "pin_locked", "the lock is persisted");
	assert.equal((await restarted.setPin("999999", PIN)).code, "pin_locked", "no PIN change while locked");
	assert.deepEqual(restarted.approvedEntries(), []);
	assert.equal(restarted.get(proposal.id).status, "pending");
	const later = new HoyInbox({ dir, now: () => Date.now() + PIN_LOCK_MS + 60_000 });
	assert.equal((await later.approve(proposal.id, PIN)).ok, true, "after the window the right PIN works");
	assert.equal(later.approvedEntries().length, 1);
});

test("S3 PIN: set once; changing it requires the old PIN; a damaged pin.json locks (fail closed)", async (t) => {
	const dir = path.join(tmp(t), "hoy");
	const inbox = new HoyInbox({ dir });
	assert.deepEqual(inbox.pinStatus(), { set: false, locked: false });
	assert.deepEqual(await inbox.setPin("12"), { ok: false, code: "pin_invalid" });
	assert.deepEqual(await inbox.setPin(PIN, "123456"), { ok: false, code: "pin_not_set" });
	assert.deepEqual(await inbox.setPin(PIN), { ok: true });
	const hash = fs.readFileSync(inbox.pinFile, "utf8");
	assert.deepEqual(await inbox.setPin("135790"), { ok: false, code: "pin_exists" });
	assert.equal((await inbox.setPin("135790", "000000")).code, "pin_wrong");
	assert.equal(JSON.parse(fs.readFileSync(inbox.pinFile, "utf8")).hash, JSON.parse(hash).hash, "refused changes keep the hash");
	assert.deepEqual(await inbox.setPin("135790", PIN), { ok: true });
	const added = await inbox.addRun({ minikoda: "m", resultText: "r", proposals: [{ action: "buy", target: "X", text: "t" }] });
	assert.equal((await inbox.approve(added[1].id, PIN)).code, "pin_wrong", "the old PIN no longer works");
	fs.writeFileSync(inbox.pinFile, "{not json");
	assert.deepEqual(inbox.pinStatus(), { set: true, locked: true });
	assert.equal((await inbox.approve(added[1].id, "135790")).code, "pin_locked");
	assert.deepEqual(inbox.approvedEntries(), []);
});

test("S5 Hoy stores only buy/sell/send proposals even if a caller hands it something else", async (t) => {
	const inbox = new HoyInbox({ dir: path.join(tmp(t), "hoy") });
	const added = await inbox.addRun({ minikoda: "m", resultText: "r", proposals: [{ action: "delete", target: "x", text: "y" }, { action: "send", target: "g", text: "z" }] });
	assert.deepEqual(added.map((i) => [i.kind, i.action]), [["result", undefined], ["proposal", "send"]]);
});

// ---------- protocol allowlist ----------

test("protocol: Minikodas and Hoy client frames are validated and rebuilt; anything off-contract is bad_request", () => {
	const uuid = "123e4567-e89b-42d3-a456-426614174000";
	assert.deepEqual(P.validateClientFrame({ type: "minikodas_list", extra: 1 }), { type: "minikodas_list" });
	assert.deepEqual(P.validateClientFrame({ type: "hoy_list" }), { type: "hoy_list" });
	assert.deepEqual(P.validateClientFrame({ type: "pin_status" }), { type: "pin_status" });
	for (const type of ["minikoda_get", "minikoda_approve_create", "minikoda_delete", "minikoda_launch"]) {
		assert.deepEqual(P.validateClientFrame({ type, id: "oportunidades", x: 1 }), { type, id: "oportunidades" });
		assert.equal(P.validateClientFrame({ type, id: "../x" }), undefined);
		assert.equal(P.validateClientFrame({ type }), undefined);
	}
	const created = P.validateClientFrame({ type: "minikoda_create", recipe: recipe(), token: "x" });
	assert.equal(created.recipe.id, "oportunidades");
	assert.deepEqual(Object.keys(created), ["type", "recipe"]);
	assert.equal(P.validateClientFrame({ type: "minikoda_create", recipe: recipe({ kit: ["bash"] }) }), undefined);
	assert.equal(P.validateClientFrame({ type: "minikoda_create", recipe: { ...recipe(), env: {} } }), undefined);
	assert.equal(P.validateClientFrame({ type: "minikoda_create", recipe: recipe({ never: ["send"] }) }), undefined);
	assert.deepEqual(P.validateClientFrame({ type: "hoy_approve", id: uuid, pin: PIN, extra: 1 }), { type: "hoy_approve", id: uuid, pin: PIN });
	assert.equal(P.validateClientFrame({ type: "hoy_approve", id: uuid }), undefined, "approve needs the PIN");
	assert.equal(P.validateClientFrame({ type: "hoy_approve", id: uuid, pin: 246810 }), undefined);
	assert.equal(P.validateClientFrame({ type: "hoy_approve", id: "nope", pin: PIN }), undefined);
	assert.deepEqual(P.validateClientFrame({ type: "hoy_reject", id: uuid, pin: PIN }), { type: "hoy_reject", id: uuid });
	assert.deepEqual(P.validateClientFrame({ type: "pin_set", pin: PIN }), { type: "pin_set", pin: PIN });
	assert.deepEqual(P.validateClientFrame({ type: "pin_set", pin: PIN, old: "135790" }), { type: "pin_set", pin: PIN, old: "135790" });
	assert.equal(P.validateClientFrame({ type: "pin_set", pin: "12" }), undefined);
	assert.equal(P.validateClientFrame({ type: "pin_set", pin: PIN, old: "x" }), undefined);
	for (const code of ["unknown_minikoda", "not_active", "not_pending", "exists", "model_unavailable", "unknown_item", "pin_wrong", "pin_locked", "pin_not_set", "pin_exists", "pin_invalid"]) {
		assert.deepEqual(P.errorFrame(code), { type: "error", code });
	}
});

test("protocol: hoy frame is rebuilt field by field from stored items, pending proposals first; pin_status never carries the hash", () => {
	const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
	const frame = P.hoyFrame([
		{ id: id(1), minikoda: "m", kind: "result", text: "r", status: "approved", createdAt: "a", secret: "x" },
		{ id: id(2), minikoda: "m", kind: "proposal", action: "sell", target: "ACME", text: "t", status: "pending", createdAt: "b" },
		{ id: id(3), minikoda: "m", kind: "proposal", action: "buy", target: "MELI", text: "t", status: "rejected", createdAt: "c", decidedAt: "d" },
	]);
	assert.deepEqual(frame.items.map((i) => i.id), [id(2), id(3), id(1)]);
	assert.equal(frame.items[2].secret, undefined);
	assert.equal(frame.truncated, false);
	assert.throws(() => P.hoyFrame([{ id: id(1), minikoda: "m", kind: "proposal", action: "delete", target: "x", text: "t", status: "pending" }]), /invalid/);
	assert.deepEqual(P.pinStatusFrame({ set: true, locked: false, left: 5, hash: "h", salt: "s" }), { type: "pin_status", set: true, locked: false, left: 5 });
});

// ---------- server verbs (fake engine, real Minikodas facade) ----------

class FakeEngine extends EventEmitter {
	constructor() {
		super();
		this.status = "ready";
	}
	async request() {
		return { success: true };
	}
	send() {}
}

function accountsFixture(base) {
	const accountsRoot = path.join(base, "island", "accounts");
	fs.mkdirSync(path.join(accountsRoot, "main"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(accountsRoot, "main", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "FAKE-KEY-NOT-REAL" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(accountsRoot, "main", "account.json"), JSON.stringify({ accountId: "main", label: "Main", provider: "anthropic", authMethod: "api_key", configured: true, createdAt: "2026-11-11T00:00:00.000Z" }), { mode: 0o600 });
	return accountsRoot;
}

function connect(endpoint) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(endpoint);
		const frames = [];
		let buf = "";
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				frames.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token: TOKEN })}\n`);
			const send = (f) => socket.write(`${JSON.stringify(f)}\n`);
			const wait = async (pred, ms = 10_000) => {
				const end = Date.now() + ms;
				const start = frames.length;
				while (Date.now() < end) {
					const hit = frames.slice(start).find(pred) ?? undefined;
					if (hit) return hit;
					await sleep(10);
				}
				assert.fail("frame not received");
			};
			/** Sends a frame and waits for the next frame of one of `types` that arrives after it. */
			const ask = async (f, types) => {
				const start = frames.length;
				send(f);
				const end = Date.now() + 10_000;
				while (Date.now() < end) {
					const hit = frames.slice(start).find((x) => types.includes(x.type));
					if (hit) return hit;
					await sleep(10);
				}
				assert.fail(`no ${types.join("/")} after ${f.type}`);
			};
			resolve({ socket, frames, send, wait, ask });
		});
	});
}

async function serverWith(t, base, steps = STANDARD) {
	const accountsRoot = accountsFixture(base);
	const accounts = {
		listAccounts: () => [{ accountId: "main", provider: "anthropic", configured: true }],
		models: async () => [{ provider: "anthropic", id: "claude-sonnet-5" }],
	};
	const minikodas = new Minikodas({
		islandRoot: path.join(base, "island"),
		accountsRoot,
		accounts,
		profiles: { list: () => ({ profiles: [], active: undefined }) },
		engine: { command: process.execPath, commandArgs: [FAKE_PI, "--script", script(base, steps)], env: { PATH: process.env.PATH }, startTimeoutMs: 10_000 },
		minEveryMs: 1,
		runTimeoutMs: 10_000,
		scrypt: CHEAP_SCRYPT,
	});
	minikodas.start();
	const runtimeDir = path.join(base, "rt");
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), minikodas });
	await server.start();
	t.after(async () => {
		await minikodas.stop();
		await server.close();
	});
	const client = await connect(server.endpoint);
	t.after(() => client.socket.destroy());
	await client.wait((f) => f.type === "ready");
	return { server, minikodas, client };
}

test("server: create is a draft until approve-create; launch lands the run in Hoy with ONLY the stored proposal, never the model's claims", { skip: !posix && "Unix socket fixture" }, async (t) => {
	const base = tmp(t);
	const { minikodas, client } = await serverWith(t, base);
	const created = await client.ask({ type: "minikoda_create", recipe: recipe() }, ["minikoda", "error"]);
	assert.equal(created.type, "minikoda");
	assert.equal(created.minikoda.status, "draft");
	assert.equal(created.minikoda.model.accountId, "main");
	assert.deepEqual(await client.ask({ type: "minikoda_launch", id: "oportunidades" }, ["minikoda_launched", "error"]), { type: "error", code: "not_active", seq: client.frames.at(-1).seq });
	const store = path.join(base, "island", "minikodas", "recipes.json");
	const before = fs.readFileSync(store, "utf8");
	assert.equal((await client.ask({ type: "minikoda_create", recipe: recipe({ model: { provider: "openai", id: "gpt-5-mini" } }) }, ["minikoda", "error"])).code, "model_unavailable");
	assert.equal((await client.ask({ type: "minikoda_create", recipe: recipe({ kit: ["bash"] }) }, ["minikoda", "error"])).code, "bad_request");
	assert.equal(fs.readFileSync(store, "utf8"), before, "rejected creates leave the store unchanged");
	const approved = await client.ask({ type: "minikoda_approve_create", id: "oportunidades" }, ["minikoda", "error"]);
	assert.equal(approved.minikoda.status, "active");
	const launched = await client.ask({ type: "minikoda_launch", id: "oportunidades" }, ["minikoda_launched", "error"]);
	assert.equal(launched.started, true);
	const hoy = await client.wait((f) => f.type === "hoy" && f.items.length >= 2, 15_000);
	const proposals = hoy.items.filter((i) => i.kind === "proposal");
	assert.deepEqual(proposals.map((p) => [p.action, p.target, p.status]), [["sell", "ACME", "pending"]], "only what the kit really stored");
	assert.equal(hoy.items.some((i) => i.kind === "proposal" && /MELI|resumen/i.test(i.target)), false, "claims in the text never become proposals");
	assert.equal(hoy.items.find((i) => i.kind === "result").text.includes("Dejé 3 propuestas"), true, "the claim stays as plain result text");
	assert.equal(minikodas.inbox.approvedEntries().length, 0);
	const listed = await client.ask({ type: "hoy_list" }, ["hoy"]);
	assert.deepEqual(listed.items, hoy.items, "hoy_list is the same stored list");
	const engineRoot = path.join(base, "island", "minikodas", "engines", "oportunidades");
	const inEngine = (dir) => fs.readdirSync(dir, { recursive: true }).map(String);
	assert.equal(inEngine(engineRoot).some((f) => /hoy\.jsonl|pin\.json|approved\.jsonl|session\.json/.test(f)), false, "Hoy, PIN and token never live in the engine root");
});

test("server: approve needs the PIN; wrong PIN refused with no event; right PIN executes once (one hoy_approved); second approve refused; reject never executes", { skip: !posix && "Unix socket fixture" }, async (t) => {
	const base = tmp(t);
	const { minikodas, client } = await serverWith(t, base);
	await client.ask({ type: "minikoda_create", recipe: recipe() }, ["minikoda"]);
	await client.ask({ type: "minikoda_approve_create", id: "oportunidades" }, ["minikoda"]);
	await client.ask({ type: "minikoda_launch", id: "oportunidades" }, ["minikoda_launched"]);
	const hoy = await client.wait((f) => f.type === "hoy" && f.items.some((i) => i.kind === "proposal"), 15_000);
	const proposal = hoy.items.find((i) => i.kind === "proposal");
	assert.equal((await client.ask({ type: "hoy_approve", id: proposal.id, pin: PIN }, ["hoy_decided", "error"])).code, "pin_not_set");
	assert.deepEqual((await client.ask({ type: "pin_set", pin: PIN }, ["pin_status", "error"])), { type: "pin_status", set: true, locked: false, left: 5, seq: client.frames.at(-1).seq });
	assert.equal((await client.ask({ type: "pin_set", pin: "135790" }, ["pin_status", "error"])).code, "pin_exists");
	assert.equal((await client.ask({ type: "hoy_approve", id: proposal.id }, ["hoy_decided", "error"])).code, "bad_request", "no PIN, no approval");
	assert.equal((await client.ask({ type: "hoy_approve", id: proposal.id, pin: "000000" }, ["hoy_decided", "error"])).code, "pin_wrong");
	assert.equal(client.frames.filter((f) => f.type === "hoy_approved").length, 0);
	assert.equal(minikodas.inbox.approvedEntries().length, 0);
	const ok = await client.ask({ type: "hoy_approve", id: proposal.id, pin: PIN }, ["hoy_decided", "error"]);
	assert.deepEqual([ok.type, ok.id, ok.status], ["hoy_decided", proposal.id, "approved"]);
	await waitFor(() => client.frames.some((f) => f.type === "hoy_approved"));
	const approvedEvent = client.frames.find((f) => f.type === "hoy_approved");
	assert.deepEqual([approvedEvent.id, approvedEvent.action, approvedEvent.target], [proposal.id, "sell", "ACME"]);
	assert.equal((await client.ask({ type: "hoy_approve", id: proposal.id, pin: PIN }, ["hoy_decided", "error"])).code, "not_pending");
	await sleep(100);
	assert.equal(client.frames.filter((f) => f.type === "hoy_approved").length, 1, "exactly one approved event");
	assert.equal(minikodas.inbox.approvedEntries().length, 1, "exactly one execution");
	// A second run brings a second proposal; rejecting it executes nothing.
	await client.ask({ type: "minikoda_launch", id: "oportunidades" }, ["minikoda_launched"]);
	await waitFor(() => minikodas.hoyList().filter((i) => i.kind === "proposal" && i.status === "pending").length === 1, 15_000);
	const second = minikodas.hoyList().find((i) => i.kind === "proposal" && i.status === "pending");
	assert.equal((await client.ask({ type: "hoy_reject", id: second.id }, ["hoy_decided", "error"])).status, "rejected");
	assert.equal((await client.ask({ type: "hoy_approve", id: second.id, pin: PIN }, ["hoy_decided", "error"])).code, "not_pending");
	assert.equal(minikodas.inbox.approvedEntries().length, 1);
	assert.equal(client.frames.filter((f) => f.type === "hoy_approved").length, 1);
	assert.equal(JSON.stringify(client.frames).includes(PIN), false, "the PIN is never echoed in any frame");
});

test("server: minikodas_list/get/delete; launch refused while paused; a crash lands in Hoy as an error item", { skip: !posix && "Unix socket fixture" }, async (t) => {
	const base = tmp(t);
	const { server, client } = await serverWith(t, base, [{ crash: 3 }]);
	await client.ask({ type: "minikoda_create", recipe: recipe() }, ["minikoda"]);
	const list = await client.ask({ type: "minikodas_list" }, ["minikodas"]);
	assert.deepEqual(list.minikodas.map((m) => [m.id, m.status, m.prompt]), [["oportunidades", "draft", undefined]], "the list never carries prompts");
	const got = await client.ask({ type: "minikoda_get", id: "oportunidades" }, ["minikoda"]);
	assert.match(got.minikoda.prompt, /oportunidades de inversión/);
	assert.equal((await client.ask({ type: "minikoda_get", id: "nope" }, ["minikoda", "error"])).code, "unknown_minikoda");
	await client.ask({ type: "minikoda_approve_create", id: "oportunidades" }, ["minikoda"]);
	server.paused = true;
	assert.equal((await client.ask({ type: "minikoda_launch", id: "oportunidades" }, ["minikoda_launched", "error"])).code, "paused");
	server.paused = false;
	await client.ask({ type: "minikoda_launch", id: "oportunidades" }, ["minikoda_launched"]);
	const hoy = await client.wait((f) => f.type === "hoy" && f.items.some((i) => i.kind === "error"), 15_000);
	assert.match(hoy.items.find((i) => i.kind === "error").text, /falló \(crashed\)/);
	const deleted = await client.ask({ type: "minikoda_delete", id: "oportunidades" }, ["minikoda_deleted", "error"]);
	assert.equal(deleted.id, "oportunidades");
	assert.deepEqual((await client.ask({ type: "minikodas_list" }, ["minikodas"])).minikodas, []);
});

// ---------- daemon wiring end to end ----------

test("daemon: Minikodas are wired; a SCHEDULED run fires without any launch, lands in Hoy, and the chat engine's root is never touched", { skip: !posix && "Unix socket fixture", timeout: 60_000 }, async (t) => {
	const { Daemon, readSession } = require("../src/daemon.cjs");
	const base = tmp(t);
	const root = path.join(base, "i");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	// The daemon's accounts live under its own root: copy the fixture account there.
	const accountsRoot = accountsFixture(base);
	fs.cpSync(accountsRoot, path.join(root, "accounts"), { recursive: true });
	fs.chmodSync(path.join(root, "accounts"), 0o700);
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH },
		engineOptions: { command: process.execPath, commandArgs: [FAKE_AGENT], backoffMs: [20], stopTimeoutMs: 500, startTimeoutMs: 5000 },
		accountsOptions: { helper: { command: process.execPath, args: [FAKE_AUTH, "--accounts-root", path.join(root, "accounts")], env: { PATH: process.env.PATH } } },
		minikodasOptions: {
			engine: { command: process.execPath, commandArgs: [FAKE_PI, "--script", script(base, STANDARD)], env: { PATH: process.env.PATH }, startTimeoutMs: 10_000 },
			minEveryMs: 1,
			scrypt: CHEAP_SCRYPT,
		},
	});
	await daemon.start();
	t.after(() => daemon.stop());
	const session = readSession(root);
	const client = await new Promise((resolve, reject) => {
		const socket = net.connect(session.endpoint);
		const frames = [];
		let buf = "";
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				frames.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token: session.token })}\n`);
			resolve({ socket, frames, send: (f) => socket.write(`${JSON.stringify(f)}\n`) });
		});
	});
	t.after(() => client.socket.destroy());
	await waitFor(() => client.frames.some((f) => f.type === "ready"));
	client.send({ type: "minikoda_create", recipe: recipe({ when: { everyMs: 200 } }) });
	await waitFor(() => client.frames.some((f) => f.type === "minikoda" && f.minikoda.status === "draft"));
	await sleep(400);
	assert.equal(daemon.minikodas.hoyList().length, 0, "a draft never runs");
	client.send({ type: "minikoda_approve_create", id: "oportunidades" });
	// Nobody sends minikoda_launch: the scheduler does it.
	await waitFor(() => client.frames.some((f) => f.type === "hoy" && f.items.some((i) => i.kind === "proposal")), 20_000);
	assert.equal(client.frames.some((f) => f.type === "minikoda_launched"), false);
	const hoy = daemon.minikodas.hoyList();
	assert.equal(hoy.filter((i) => i.kind === "proposal" && i.action === "sell").length >= 1, true);
	assert.equal(hoy.some((i) => i.kind === "proposal" && i.action !== "sell"), false, "only stored proposals, never the delete the kit refused or the claimed ones");
	assert.equal(fs.existsSync(path.join(root, "agent", "auth.json")), false, "the chat engine's agent dir never gets the Minikoda's credential");
	assert.ok(fs.existsSync(path.join(root, "minikodas", "engines", "oportunidades", "agent", "auth.json")));
	assert.equal(fs.statSync(path.join(root, "minikodas", "hoy", "hoy.jsonl")).mode & 0o777, 0o600);
	await daemon.stop();
	assert.equal(daemon.minikodas, undefined, "stopped with the daemon");
});
