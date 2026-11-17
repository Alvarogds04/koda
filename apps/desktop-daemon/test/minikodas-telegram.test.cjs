"use strict";

// K2-13 Minikodas, commit 2 (T1b, S10/S20): the daemon's Telegram client. One client per daemon, ALWAYS mtcute's
// MemoryStorage (the session is a credential: it goes to the island's keychain, never to disk), the phone → code → 2FA
// hand-off over the island protocol, restore from the island's keychain at start, and closed error codes with Spanish
// notices. Offline: mtcute is replaced by a scripted fake module; there is no api_id in this repo and no real login.
// The ONE exception is the «never prompt» test, which loads the REAL @mtcute/node from the bundled runtime tree with its
// RPC stubbed: the bug it pins down (readline prompts on stdin/stdout) only exists in the real client.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

const P = require("../src/protocol.cjs");
const {
	TelegramSession,
	TELEGRAM_STATES,
	TELEGRAM_ERROR_CODES,
	SPANISH_NOTICES,
	mapRpcError,
	resolveClientModule,
	clientModuleEntry,
} = require("../src/minikodas/telegram.cjs");

const API_ID = 123456;
const API_HASH = "0123456789abcdef0123456789abcdef";
const PHONE = "+5491155550000";
const CODE = "12345";
const PASSWORD = "correct horse";
const SESSION = "1BQANOTEuMTA4LjU2LjE0Nw==";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmp(t) {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-tg-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
	return base;
}
const allFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/**
 * A scripted stand-in for `@mtcute/node`. It follows the real client's shape where the daemon depends on it
 * (constructor params, `start()` with dynamic code/password callbacks and `invalidCodeCallback`, `exportSession`,
 * `destroy`, RPC errors carrying their `text`), and it mimics the real package's one dangerous default: a client
 * without a MemoryStorage writes `client.session` into the working directory.
 */
function fakeModule(options = {}) {
	const created = [];
	const clients = [];
	const calls = [];
	class MemoryStorage {
		constructor() {
			this.kind = "memory";
		}
	}
	class RpcError extends Error {
		constructor(text, seconds) {
			super(text);
			this.text = text;
			if (seconds !== undefined) this.seconds = seconds;
		}
	}
	const user = options.user === undefined ? { displayName: "Ana Pérez", username: "anap" } : options.user;
	class TelegramClient {
		constructor(params) {
			created.push(params);
			clients.push(this);
			if (!(params.storage instanceof MemoryStorage)) {
				fs.writeFileSync(path.join(options.writeInto ?? process.cwd(), "client.session"), "leaked\n");
			}
			this.destroyed = false;
		}
		async start(params) {
			calls.push({ start: params.session ? "session" : "phone" });
			if (params.session !== undefined) {
				if (options.restoreError) throw new RpcError(options.restoreError);
				return user;
			}
			// Telegram floods or rejects before a code is ever asked for
			if (options.floodOnStart) throw new RpcError(`FLOOD_WAIT_${options.floodOnStart}`, options.floodOnStart);
			if (options.codeError) throw new RpcError(options.codeError);
			const code = await params.code();
			if (code !== (options.code ?? CODE)) {
				await params.invalidCodeCallback?.("code");
				const again = await params.code();
				if (again !== (options.code ?? CODE)) throw new RpcError("PHONE_CODE_INVALID");
			}
			if (options.needs2fa) {
				const password = await params.password();
				if (password !== (options.password ?? PASSWORD)) {
					await params.invalidCodeCallback?.("password");
					const again = await params.password();
					if (again !== (options.password ?? PASSWORD)) throw new RpcError("PASSWORD_HASH_INVALID");
				}
			}
			return user;
		}
		async exportSession() {
			return options.exported ?? SESSION;
		}
		async destroy() {
			this.destroyed = true;
		}
	}
	return { mod: { TelegramClient, MemoryStorage }, created, clients, calls, RpcError };
}

/** Drives one login to completion the way the island does: separate frames, each answered by the person. */
async function loginFlow(session, { code = CODE, password = PASSWORD } = {}) {
	const started = await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	assert.equal(started.state, "awaiting_code");
	const code_ = await session.loginCode(code);
	if (code_.state === "awaiting_password") {
		const done = await session.loginPassword(password);
		return { started, code: code_, password: done };
	}
	return { started, code: code_ };
}

// ---------- the client is always a MemoryStorage client ----------

test("telegram: the client is always built with mtcute's MemoryStorage, and nobody can hand it another storage", async (t) => {
	const dir = tmp(t);
	const fake = fakeModule({ writeInto: dir });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await loginFlow(session);
	assert.equal(fake.created.length, 1, "one client per daemon");
	assert.equal(fake.created[0].storage.kind, "memory", "the client got mtcute's MemoryStorage");
	assert.equal(fake.created[0].apiId, API_ID);
	assert.equal(fake.created[0].apiHash, API_HASH);
	assert.deepEqual(allFiles(dir), [], "nothing was written: no client.session, no sqlite file");
	assert.throws(() => new TelegramSession({ storage: { load: () => {} }, loadModule: async () => fake.mod }), /storage/i, "a caller-supplied storage is refused, not silently replaced");
});

test("telegram: a second client never coexists: logging in again replaces the previous attempt", async (t) => {
	const fake = fakeModule({});
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await loginFlow(session);
	assert.equal(session.state, "connected");
	await assert.rejects(() => session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE }), (error) => error.code === "telegram_already_connected");
	assert.equal(fake.created.length, 1, "no second client while one is connected");
	await session.logout();
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	assert.equal(fake.created.length, 2, "after logout a new client is built");
	await session.stop();
});

// ---------- phone → code → 2FA ----------

test("telegram: login walks phone → code → 2FA and hands the session back exactly once", async (t) => {
	const fake = fakeModule({ needs2fa: true });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	const out = await loginFlow(session);
	assert.equal(out.code.state, "awaiting_password");
	assert.equal(out.password.state, "connected");
	assert.equal(out.password.session, SESSION, "the exported session travels in the reply that finished the login");
	assert.deepEqual(session.status(), { state: "connected", account: { name: "Ana Pérez", username: "anap" } });
	assert.deepEqual(out.started.state, "awaiting_code");
	// nothing else carries the session: the status frame is account/state only.
	assert.doesNotMatch(JSON.stringify(session.status()), /1BQANO/);
});

test("telegram: 2FA is asked for only when Telegram asks (no password frame needed otherwise)", async (t) => {
	const fake = fakeModule({});
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	const out = await loginFlow(session);
	assert.equal(out.code.state, "connected");
	assert.equal(out.code.session, SESSION);
	await assert.rejects(() => session.loginPassword(PASSWORD), (error) => error.code === "telegram_not_awaiting_password");
});

test("telegram: a wrong code keeps the login alive at awaiting_code, and a second frame finishes it", async (t) => {
	const fake = fakeModule({ code: CODE });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	await assert.rejects(() => session.loginCode("00000"), (error) => error.code === "telegram_code_invalid");
	assert.equal(session.state, "awaiting_code", "the person can try again instead of restarting the login");
	const ok = await session.loginCode(CODE);
	assert.equal(ok.state, "connected");
});

test("telegram: a wrong 2FA password stays at awaiting_password", async (t) => {
	const fake = fakeModule({ needs2fa: true, password: PASSWORD });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	await session.loginCode(CODE);
	await assert.rejects(() => session.loginPassword("nope"), (error) => error.code === "telegram_password_invalid");
	assert.equal(session.state, "awaiting_password");
	const ok = await session.loginPassword(PASSWORD);
	assert.equal(ok.state, "connected");
});

// ---------- closed codes and Spanish notices ----------

test("telegram: RPC errors map to closed codes with Spanish notices, and FLOOD_WAIT carries the minutes", async () => {
	const notice = (code) => SPANISH_NOTICES[code];
	assert.equal(notice("telegram_code_invalid"), "El código de Telegram no es válido. Pedí uno nuevo e intentá otra vez.");
	assert.equal(notice("telegram_password_invalid"), "La contraseña de dos pasos no es correcta. Probá otra vez.");
	assert.equal(notice("telegram_flood_wait"), "Telegram pidió esperar; volvé a intentar cuando pase el tiempo indicado.");
	assert.equal(notice("telegram_session_invalid"), "La sesión de Telegram ya no es válida. Conectá tu cuenta otra vez.");
	assert.match(notice("telegram_unavailable"), /no está disponible/);
	assert.match(notice("telegram_failed"), /^Telegram no respondió como se esperaba/);
	for (const code of TELEGRAM_ERROR_CODES) assert.equal(typeof notice(code), "string", `${code} has a Spanish notice`);
	for (const sentence of Object.values(SPANISH_NOTICES)) {
		assert.doesNotMatch(sentence, /[A-Za-z0-9+/=]{24,}/, `a notice never carries a token-like blob: ${sentence}`);
		assert.ok(sentence.length <= 200, `a notice stays short: ${sentence}`);
	}
	const flood = mapRpcError(Object.assign(new Error("FLOOD_WAIT_125"), { text: "FLOOD_WAIT_125", seconds: 125 }));
	assert.equal(flood.code, "telegram_flood_wait");
	assert.equal(flood.retryAfterMinutes, 3, "125 s surfaces as 3 minutes (rounded up, never «wait 0 minutes»)");
	assert.equal(flood.notice, "Telegram pidió esperar 3 minutos.");
	assert.equal(mapRpcError(Object.assign(new Error("x"), { text: "FLOOD_WAIT_42" })).retryAfterMinutes, 1, "42 s is one minute, never «wait 0 minutes»");
	assert.equal(mapRpcError(Object.assign(new Error("x"), { text: "PHONE_CODE_INVALID" })).code, "telegram_code_invalid");
	assert.equal(mapRpcError(Object.assign(new Error("x"), { text: "API_ID_INVALID" })).code, "telegram_credentials_invalid");
	assert.equal(mapRpcError(Object.assign(new Error("x"), { text: "AUTH_KEY_UNREGISTERED" })).code, "telegram_session_invalid");
});

test("telegram: a FLOOD_WAIT while asking for the code surfaces as a status notice with the minutes, not as silence", async (t) => {
	const fake = fakeModule({ floodOnStart: 240 });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	const notices = [];
	session.on("status", (status) => notices.push(status));
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	const end = Date.now() + 3000;
	while (Date.now() < end && !notices.some((n) => n.notice)) await sleep(5);
	const withNotice = notices.find((n) => n.notice);
	assert.ok(withNotice, `no notice was emitted: ${JSON.stringify(notices)}`);
	assert.equal(withNotice.notice, "Telegram pidió esperar 4 minutos.");
	assert.equal(withNotice.retryAfterMinutes, 4);
	assert.equal(withNotice.state, "awaiting_code", "the person can still answer a code that never arrives, or start over");
	assert.doesNotMatch(JSON.stringify(notices), /\+5491155550000|0123456789abcdef|240/, "a status never carries the phone, the api hash or a raw server value");
});

test("telegram: an unknown RPC error becomes telegram_failed and never echoes the Telegram message", async (t) => {
	const fake = fakeModule({ codeError: `SOMETHING_WEIRD_${PHONE}` });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	await assert.rejects(
		() => session.loginCode(CODE),
		(error) => {
			assert.equal(error.code, "telegram_failed");
			assert.doesNotMatch(JSON.stringify({ message: error.message, notice: error.notice ?? "" }), /\+5491155550000/, "the raw Telegram text is never surfaced");
			return true;
		},
	);
});

// ---------- restore from the island's keychain ----------

test("telegram: restore rehydrates the client from the island's session; an unchanged session is not echoed back", async (t) => {
	const fake = fakeModule({ exported: SESSION });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	const out = await session.restore({ apiId: API_ID, apiHash: API_HASH, session: SESSION });
	assert.equal(out.state, "connected");
	assert.equal(out.session, undefined, "the island already has this session: no telegram_session reply");
	assert.equal(fake.calls[0].start, "session");
	assert.equal(fake.created[0].storage.kind, "memory");
	assert.deepEqual(session.status().account, { name: "Ana Pérez", username: "anap" });
});

test("telegram: restore replies with a refreshed session when Telegram rotated it", async (t) => {
	const rotated = `${SESSION}rotated`;
	const fake = fakeModule({ exported: rotated });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	const out = await session.restore({ apiId: API_ID, apiHash: API_HASH, session: SESSION });
	assert.equal(out.state, "connected");
	assert.equal(out.session, rotated, "the island must store the refreshed session in the keychain");
});

test("telegram: a revoked session disconnects instead of pretending to be connected", async (t) => {
	const fake = fakeModule({ restoreError: "AUTH_KEY_UNREGISTERED" });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await assert.rejects(() => session.restore({ apiId: API_ID, apiHash: API_HASH, session: SESSION }), (error) => error.code === "telegram_session_invalid");
	assert.equal(session.state, "disconnected");
	assert.deepEqual(session.status(), { state: "disconnected" });
});

// ---------- restore with the REAL client: never a readline prompt ----------

/**
 * The real @mtcute/node as Koda ships it (apps/desktop-tauri/packaging/runtime/node_modules). Without that tree installed
 * here the test skips: the pinned tree is proven by the packaging checks and the build.
 */
const REAL_MTCUTE = path.join(__dirname, "..", "..", "desktop-tauri", "packaging", "runtime", "node_modules", "@mtcute", "node", "index.js");
const realMtcute = fs.existsSync(REAL_MTCUTE);

/**
 * The real client with its RPC stubbed: every Telegram call answers `rpcText` as an RPC error, and no socket is ever
 * opened (`_connected`), so nothing leaves this machine and no account is involved. Everything else — the constructor,
 * `start()` (whose Node subclass fills missing phone/code/password with readline prompts), `importSession`,
 * `exportSession` — is the library Koda ships.
 */
async function realClientModule(rpcText = "AUTH_KEY_UNREGISTERED") {
	const real = await import(pathToFileURL(REAL_MTCUTE).href);
	const created = [];
	class StubbedClient extends real.TelegramClient {
		constructor(params) {
			super(params);
			created.push(this);
			this.rpcCalls = [];
			this._client._connected = true; // no transport: every call is answered below
			this._client.mt.call = async (method) => {
				this.rpcCalls.push(method._);
				return { _: "mt_rpc_error", errorCode: 401, errorMessage: rpcText };
			};
		}
	}
	return { real, created, mod: { TelegramClient: StubbedClient, MemoryStorage: real.MemoryStorage } };
}

/** A REAL session string (mtcute's own `exportSession` of a fabricated auth key) for the tests that need one. */
async function realSessionString(real) {
	const seed = new real.TelegramClient({ apiId: API_ID, apiHash: API_HASH, storage: new real.MemoryStorage(), logLevel: 0 });
	try {
		await seed.prepare();
		await seed._client.mt.storage.provider.authKeys.set(2, Buffer.alloc(256, 7));
		return await seed.exportSession();
	} finally {
		await seed.destroy();
	}
}

/** Resolves `{value}`/`{error}` when the promise settles first, or the `fallback` after `ms`. */
function settledWithin(promise, ms, fallback = "hung") {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		timer.unref?.();
		promise.then(
			(value) => { clearTimeout(timer); resolve({ value }); },
			(error) => { clearTimeout(timer); resolve({ error }); },
		);
	});
}

test("telegram: a dead stored session settles disconnected with no prompt on stdin/stdout (REAL mtcute)", { skip: realMtcute ? false : "packaging/runtime/node_modules is not installed here" }, async (t) => {
	const { real, created, mod } = await realClientModule("AUTH_KEY_UNREGISTERED");
	const stored = await realSessionString(real);
	const session = new TelegramSession({ loadModule: async () => mod });
	t.after(() => session.stop());
	// stdout is where mtcute's Node client prints «phone > », «code > » and «2fa password > »: it must stay empty.
	const writes = [];
	const original = process.stdout.write;
	process.stdout.write = function write(chunk, ...rest) {
		writes.push(String(chunk));
		return original.call(this, chunk, ...rest);
	};
	t.after(() => { process.stdout.write = original; });
	const outcome = await settledWithin(session.restore({ apiId: API_ID, apiHash: API_HASH, session: stored }), 10_000);
	assert.notEqual(outcome, "hung", "restore must settle: a dead session may never wait for a phone number nobody can type");
	assert.equal(outcome.error?.code, "telegram_session_invalid");
	assert.equal(session.state, "disconnected");
	assert.deepEqual(session.status(), { state: "disconnected" });
	assert.equal(created.length, 1);
	assert.ok(created[0] instanceof real.TelegramClient, "the client under test is the real shipped one");
	assert.deepEqual(writes, [], `nothing was written to stdout: ${JSON.stringify(writes)}`);
});

// ---------- clients, frames and ownership ----------

test("telegram: the real exported session fits the frame by a wide margin (measured, not guessed)", { skip: realMtcute ? false : "packaging/runtime/node_modules is not installed here" }, async () => {
	const { real } = await realClientModule();
	const stored = await realSessionString(real);
	assert.ok(stored.length > 0, "the library exported something");
	assert.match(stored, /^[\x20-\x7e]+$/, "printable ASCII, so the frame (and the island's keychain) can carry it");
	assert.ok(stored.length <= P.TELEGRAM_LIMITS.maxSession, `${stored.length} chars fit the ${P.TELEGRAM_LIMITS.maxSession}-char frame`);
	assert.ok(stored.length < 1024, `the cap is not tight: a real mtcute session measures ${stored.length} chars`);
	assert.equal(P.telegramSessionFrame({ session: stored }).session, stored, "the frame accepts a real session");
});

test("telegram: mtcute's own logging stays off whatever MTCUTE_LOG_LEVEL says (REAL mtcute)", { skip: realMtcute ? false : "packaging/runtime/node_modules is not installed here" }, async (t) => {
	// NodePlatform reads MTCUTE_LOG_LEVEL as the default level, and INFO/DEBUG/VERBOSE can print phone numbers, codes and
	// payloads. The daemon passes its own level, so a verbose environment cannot turn the library's log on.
	const real = await import(pathToFileURL(REAL_MTCUTE).href);
	const previous = process.env.MTCUTE_LOG_LEVEL;
	process.env.MTCUTE_LOG_LEVEL = "5";
	t.after(() => {
		if (previous === undefined) delete process.env.MTCUTE_LOG_LEVEL;
		else process.env.MTCUTE_LOG_LEVEL = previous;
	});
	const created = [];
	class RecordingClient extends real.TelegramClient {
		constructor(params) {
			super(params);
			created.push(this);
			this._client._connected = true;
			this._client.mt.call = async () => ({ _: "mt_rpc_error", errorCode: 401, errorMessage: "AUTH_KEY_UNREGISTERED" });
		}
	}
	const session = new TelegramSession({ loadModule: async () => ({ TelegramClient: RecordingClient, MemoryStorage: real.MemoryStorage }) });
	t.after(() => session.stop());
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	assert.equal(created.length, 1);
	assert.equal(created[0].log.level, 0, "level 0 (OFF) was passed explicitly; the environment did not decide");
	// Restoring the island's session builds another client: it must be just as quiet (this is the path a dead session
	// takes, and mtcute's own recovery logs a phone number at INFO).
	const stored = await realSessionString(real);
	await session.restore({ apiId: API_ID, apiHash: API_HASH, session: stored }).catch(() => {});
	assert.equal(created.length, 2);
	assert.equal(created[1].log.level, 0, "a restore passes the same level");
});

test("telegram: a long Telegram display name is clipped so the status frame can still be built", async (t) => {
	// Telegram allows first+last up to 129 chars; the status frame carries a name capped at 80.
	const fake = fakeModule({ user: { displayName: "ñ".repeat(129), username: "anap" } });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await loginFlow(session);
	assert.equal(session.status().account.name.length, 80, "the name reaches the frame clipped, not dropped by the frame builder");
	assert.doesNotThrow(() => P.telegramStatusFrame(session.status()), "a real name must never make the status frame throw");
});

test("telegram: a session the frames cannot carry fails the login cleanly instead of throwing in the reply", async (t) => {
	// 4 KiB is generous (see the measured test below); a value outside the frame's contract must never reach the reply,
	// because the island could neither store it nor restore it and the daemon would look connected.
	const fake = fakeModule({ exported: "x".repeat(P.TELEGRAM_LIMITS.maxSession + 1) });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	await assert.rejects(() => session.loginCode(CODE), (error) => error.code === "telegram_failed");
	assert.equal(session.state, "disconnected", "nobody is left «connected» with a session that cannot travel");
	assert.equal(session.connectedClient(), undefined);
	assert.ok(fake.clients[0].destroyed, "the client is torn down instead of keeping an auth key nobody can restore");
});

test("telegram: another connection cannot answer or restart a pending login", async (t) => {
	const fake = fakeModule({ needs2fa: true });
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE, owner: "conn-a" });
	const refused = (error) => error.code === "telegram_login_other_connection";
	await assert.rejects(() => session.loginCode(CODE, "conn-b"), refused, "a code from another window is not the person's answer");
	await assert.rejects(() => session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE, owner: "conn-b" }), refused, "a second window cannot replace the flow");
	assert.equal(session.state, "awaiting_code", "and the first window is still where it was");
	const out = await session.loginCode(CODE, "conn-a");
	assert.equal(out.state, "awaiting_password");
	await assert.rejects(() => session.loginPassword(PASSWORD, "conn-b"), refused, "the 2FA password belongs to the same window");
	assert.equal((await session.loginPassword(PASSWORD, "conn-a")).state, "connected");
	// Once the login finished there is nothing left to own: code/password are simply not awaited anymore.
	await assert.rejects(() => session.loginCode(CODE, "conn-b"), (error) => error.code === "telegram_not_awaiting_code");
});

// ---------- logout, missing library, cancellation ----------

test("telegram: logout destroys the client and forgets the account", async (t) => {
	const fake = fakeModule({});
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await loginFlow(session);
	const out = await session.logout();
	assert.equal(out.state, "disconnected");
	assert.deepEqual(session.status(), { state: "disconnected" });
	assert.ok(fake.clients[0].destroyed, "the client was torn down");
});

test("telegram: without the client library the frames answer unavailable instead of crashing", async (t) => {
	const missing = Object.assign(new Error("Cannot find module '@mtcute/node'"), { code: "MODULE_NOT_FOUND" });
	const session = new TelegramSession({ loadModule: async () => { throw missing; } });
	t.after(() => session.stop());
	await assert.rejects(() => session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE }), (error) => error.code === "telegram_unavailable");
	assert.equal(session.state, "disconnected");
	await assert.rejects(() => session.restore({ apiId: API_ID, apiHash: API_HASH, session: SESSION }), (error) => error.code === "telegram_unavailable");
});

test("telegram: a pending login is cancelled cleanly by logout (no hung promise, no leak)", async (t) => {
	const fake = fakeModule({});
	const session = new TelegramSession({ loadModule: async () => fake.mod });
	t.after(() => session.stop());
	await session.loginStart({ apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	const pending = session.flow;
	await session.logout();
	await assert.rejects(() => pending, (error) => error.code === "telegram_cancelled");
	assert.equal(session.state, "disconnected");
	assert.equal(session.flow, undefined);
});

// ---------- the client library is found where it ships ----------

test("telegram: the library is looked up beside the running Node, then beside the daemon's package, then by Node resolution", async (t) => {
	const root = tmp(t);
	const runtime = path.join(root, "prefix", "runtime");
	const daemonPkg = path.join(root, "prefix", "desktop-daemon");
	fs.mkdirSync(path.join(runtime, "node_modules", "@mtcute", "node"), { recursive: true });
	fs.writeFileSync(path.join(runtime, "node_modules", "@mtcute", "node", "package.json"), JSON.stringify({ name: "@mtcute/node", version: "0.32.8", type: "module", exports: { ".": { import: "./index.js" } } }));
	fs.writeFileSync(path.join(runtime, "node_modules", "@mtcute", "node", "index.js"), "export const shipped = true;\n");
	fs.mkdirSync(daemonPkg, { recursive: true });
	const imported = [];
	const importer = async (spec) => {
		imported.push(spec);
		return { shipped: true };
	};
	// beside the running Node (the app runs the daemon on the bundled Node)
	const besideNode = await resolveClientModule({ execPath: path.join(runtime, "node"), packageRoot: daemonPkg, importer });
	assert.deepEqual(imported, [path.join(runtime, "node_modules", "@mtcute", "node", "index.js")], "the runtime folder is tried first");
	assert.deepEqual(besideNode, { shipped: true });
	// a daemon started by some other Node (development): the sibling runtime folder, then plain resolution
	imported.length = 0;
	await resolveClientModule({ execPath: path.join(root, "elsewhere", "node"), packageRoot: daemonPkg, importer });
	assert.deepEqual(imported, [path.join(runtime, "node_modules", "@mtcute", "node", "index.js")], "second candidate: <package>/../runtime");
	imported.length = 0;
	await resolveClientModule({ execPath: path.join(root, "elsewhere", "node"), packageRoot: path.join(root, "checkout"), importer });
	assert.deepEqual(imported, ["@mtcute/node"], "last resort: ordinary Node resolution (a development checkout)");
	assert.equal(clientModuleEntry(JSON.stringify({ exports: { ".": { import: { default: "./index.js" } } } })), "index.js");
	assert.equal(clientModuleEntry(JSON.stringify({})), "index.js", "no exports map: the package's index.js");
});

// ---------- protocol ----------

test("protocol: telegram frames accept exactly the documented fields and reject anything else", () => {
	const decode = (frame) => P.decodeClientLine(Buffer.from(JSON.stringify(frame)));
	const ok = (frame, expected) => assert.deepEqual(decode(frame).frame, { type: frame.type, ...expected });
	ok({ type: "telegram_status" }, {});
	ok({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: PHONE }, { apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	ok({ type: "telegram_login_code", code: CODE }, { code: CODE });
	ok({ type: "telegram_login_password", password: PASSWORD }, { password: PASSWORD });
	ok({ type: "telegram_logout" }, {});
	ok({ type: "telegram_session_restore", apiId: API_ID, apiHash: API_HASH, session: SESSION }, { apiId: API_ID, apiHash: API_HASH, session: SESSION });
	const refuse = (frame) => assert.deepEqual(decode(frame), { error: "bad_request" }, JSON.stringify(frame));
	refuse({ type: "telegram_login_start", apiId: "123456", apiHash: API_HASH, phone: PHONE });
	refuse({ type: "telegram_login_start", apiId: 0, apiHash: API_HASH, phone: PHONE });
	refuse({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH.toUpperCase(), phone: PHONE });
	refuse({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH.slice(1), phone: PHONE });
	refuse({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: "5491155550000" });
	refuse({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: "+12" });
	refuse({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: "+5" + "1".repeat(16) });
	refuse({ type: "telegram_login_code", code: "" });
	refuse({ type: "telegram_login_code" });
	refuse({ type: "telegram_login_password", password: "x".repeat(1025) });
	refuse({ type: "telegram_session_restore", apiId: API_ID, apiHash: API_HASH, session: "" });
	refuse({ type: "telegram_session_restore", apiId: API_ID, apiHash: API_HASH, session: "x".repeat(4097) });
	// PROTOCOL.md says printable ASCII: a session with a newline or a non-ASCII byte is not a mtcute session and would
	// be stored in the keychain as something the daemon could never read back.
	refuse({ type: "telegram_session_restore", apiId: API_ID, apiHash: API_HASH, session: `${SESSION.slice(0, 4)}\u00e9${SESSION.slice(4)}` });
	refuse({ type: "telegram_session_restore", apiId: API_ID, apiHash: API_HASH, session: `${SESSION}\n${SESSION}` });
	refuse({ type: "telegram_session_restore", apiId: API_ID, apiHash: API_HASH, session: `${SESSION}\u0000` });
	refuse({ type: "telegram_login_start" });
});

test("protocol: the status/session/error frames carry only closed fields and stay under the cap", () => {
	const status = P.telegramStatusFrame({ state: "connected", account: { name: "Ana", username: "anap" } });
	assert.deepEqual(status, { type: "telegram_status", state: "connected", account: { name: "Ana", username: "anap" } });
	assert.deepEqual(P.telegramStatusFrame({ state: "disconnected" }), { type: "telegram_status", state: "disconnected" });
	// A caller that hands over extra data (the session, say) can never leak it through a status frame.
	assert.deepEqual(P.telegramStatusFrame({ state: "connected", session: SESSION, apiHash: API_HASH }), { type: "telegram_status", state: "connected" });
	assert.throws(() => P.telegramStatusFrame({ state: "connected", account: { name: "Ana", username: "a".repeat(200) } }), /telegram frame invalid/);
	assert.throws(() => P.telegramStatusFrame({ state: "logged_in" }), /telegram frame invalid/);
	const withNotice = P.telegramStatusFrame({ state: "awaiting_code", notice: "El código no es válido." });
	assert.deepEqual(withNotice, { type: "telegram_status", state: "awaiting_code", notice: "El código no es válido." });
	const session = P.telegramSessionFrame({ session: SESSION, apiHash: API_HASH });
	assert.deepEqual(session, { type: "telegram_session", session: SESSION }, "only the session travels");
	assert.throws(() => P.telegramSessionFrame({ session: "x".repeat(4097) }), /telegram frame invalid/);
	assert.throws(() => P.telegramSessionFrame({}), /telegram frame invalid/);
	for (const state of TELEGRAM_STATES) assert.equal(P.telegramStatusFrame({ state }).state, state);
	const capped = P.telegramStatusFrame({ state: "connected", notice: "n".repeat(500) });
	assert.equal(capped.notice.length, 300, "a notice is clipped, never unbounded");
});

// ---------- server: pause, routing, and the session frame that only the asker sees ----------

const TOKEN = "t".repeat(43);
const sleepTick = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFrame(c, pred, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (c.frames.some(pred)) return c.frames.find(pred);
		await sleepTick(5);
	}
	assert.ok(c.frames.some(pred), `no frame ${pred} in ${JSON.stringify(c.frames)}`);
}
function connectClient(endpoint) {
	const socket = net.connect(endpoint);
	const c = { socket, frames: [], buf: "" };
	socket.setEncoding("utf8");
	socket.on("data", (d) => {
		c.buf += d;
		let i;
		while ((i = c.buf.indexOf("\n")) !== -1) {
			c.frames.push(JSON.parse(c.buf.slice(0, i)));
			c.buf = c.buf.slice(i + 1);
		}
	});
	socket.on("error", () => {});
	c.send = (f) => socket.write(`${JSON.stringify(f)}\n`);
	return c;
}

/**
 * A stand-in for the daemon-wide Telegram service: the server only routes frames to it, forwards its errors and
 * broadcasts its "status" event (the real session emits that; the session frame is never part of it).
 */
class FakeTelegram extends EventEmitter {
	constructor() {
		super();
		this.calls = [];
		this.state = "disconnected";
		this.session = SESSION;
		this.failure = undefined;
	}
	async loginStart(frame) {
		this.calls.push(["loginStart", frame]);
		if (this.failure) throw Object.assign(new Error("x"), { code: this.failure });
		this.state = "awaiting_code";
		this.emit("status", this.status());
		return { state: this.state };
	}
	async loginCode(code, owner) {
		this.calls.push(["loginCode", { code, owner }]);
		this.state = "connected";
		this.emit("status", this.status());
		return { state: "connected", session: this.session };
	}
	async loginPassword(password, owner) {
		this.calls.push(["loginPassword", { password, owner }]);
		return { state: this.state };
	}
	async logout() {
		this.calls.push(["logout"]);
		this.state = "disconnected";
		this.emit("status", this.status());
		return { state: "disconnected" };
	}
	async restore(frame) {
		this.calls.push(["restore", frame]);
		return { state: "connected", session: frame.session === this.session ? undefined : this.session };
	}
	status() {
		return { state: this.state, ...(this.state === "connected" ? { account: { name: "Ana", username: "anap" } } : {}) };
	}
}

async function serverFixture(t, telegramOptions = {}) {
	const { IslandServer } = require("../src/server.cjs");
	const engine = new EventEmitter();
	engine.status = "ready";
	engine.request = async () => ({ type: "response", success: true });
	const telegram = new FakeTelegram();
	const runtimeDir = path.join(tmp(t), "run");
	const server = new IslandServer({
		runtimeDir,
		token: TOKEN,
		engine,
		telegram,
		limits: {},
		...telegramOptions,
	});
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const open = async () => {
		const c = connectClient(endpoint);
		t.after(() => c.socket.destroy());
		await new Promise((r) => c.socket.once("connect", r));
		c.send({ type: "hello", protocol: P.PROTOCOL, token: TOKEN });
		await waitFrame(c, (f) => f.type === "ready");
		return c;
	};
	return { server, telegram, endpoint, open };
}

test("server: the session frame answers ONLY the connection that completed the login", async (t) => {
	const { open, telegram } = await serverFixture(t);
	const asker = await open();
	const watcher = await open();
	asker.send({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	const status = await waitFrame(asker, (f) => f.type === "telegram_status");
	assert.equal(status.state, "awaiting_code");
	asker.send({ type: "telegram_login_code", code: CODE });
	const session = await waitFrame(asker, (f) => f.type === "telegram_session");
	assert.equal(session.session, SESSION);
	// the other connection sees the status broadcast, never the session
	await waitFrame(watcher, (f) => f.type === "telegram_status" && f.state === "connected");
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(watcher.frames.filter((f) => f.type === "telegram_session"), [], "a session is never broadcast");
	assert.ok(telegram.calls.some(([name]) => name === "loginCode"));
});

test("server: the global pause refuses every login frame, still answers status, and still allows logout", async (t) => {
	const { open } = await serverFixture(t, { paused: true });
	const c = await open();
	for (const frame of [
		{ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: PHONE },
		{ type: "telegram_login_code", code: CODE },
		{ type: "telegram_login_password", password: PASSWORD },
	]) {
		c.frames.length = 0;
		c.send(frame);
		const error = await waitFrame(c, (f) => f.type === "error");
		assert.equal(error.code, "paused", `${frame.type} is refused while paused`);
	}
	// #379 keeps account-safety actions available, like agent_disconnect: logging out must never need the pause off.
	c.frames.length = 0;
	c.send({ type: "telegram_logout" });
	const afterLogout = await waitFrame(c, (f) => f.type === "telegram_status" || f.type === "error");
	assert.equal(afterLogout.type, "telegram_status", "logout stays available while paused");
	assert.equal(afterLogout.state, "disconnected");
	c.frames.length = 0;
	c.send({ type: "telegram_status" });
	const status = await waitFrame(c, (f) => f.type === "telegram_status");
	assert.equal(status.state, "disconnected", "read-only status still answers while paused");
});

test("server: a login is handed to the service with the connection that started it", async (t) => {
	const { open, telegram } = await serverFixture(t);
	const starts = async (n) => {
		for (let i = 0; i < 400 && telegram.calls.filter(([name]) => name === "loginStart").length < n; i++) await sleepTick(5);
		return telegram.calls.filter(([name]) => name === "loginStart");
	};
	const first = await open();
	const second = await open();
	first.send({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	const one = await starts(1);
	second.send({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	const two = await starts(2);
	assert.equal(two.length, 2, `both frames reached the service: ${JSON.stringify(telegram.calls)}`);
	assert.ok(one[0][1].owner !== undefined && two[1][1].owner !== undefined, "every start carries its originating connection");
	assert.notEqual(two[0][1].owner, two[1][1].owner, "two connections are not the same owner");
	first.send({ type: "telegram_login_code", code: CODE });
	for (let i = 0; i < 400 && !telegram.calls.some(([name]) => name === "loginCode"); i++) await sleepTick(5);
	const answered = telegram.calls.filter(([name]) => name === "loginCode");
	assert.deepEqual(answered.map(([, frame]) => frame.owner), [two[0][1].owner], "the code is answered by the connection that started the login");
});

test("server: a closed Telegram error code reaches the island unchanged", async (t) => {
	const { open, telegram } = await serverFixture(t);
	telegram.failure = "telegram_flood_wait";
	const c = await open();
	c.send({ type: "telegram_login_start", apiId: API_ID, apiHash: API_HASH, phone: PHONE });
	const error = await waitFrame(c, (f) => f.type === "error");
	assert.equal(error.code, "telegram_flood_wait");
});

test("server: without a Telegram service the frames answer unavailable instead of crashing", async (t) => {
	const { IslandServer } = require("../src/server.cjs");
	const engine = new EventEmitter();
	engine.status = "ready";
	const runtimeDir = path.join(tmp(t), "run");
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const c = connectClient(endpoint);
	t.after(() => c.socket.destroy());
	await new Promise((r) => c.socket.once("connect", r));
	c.send({ type: "hello", protocol: P.PROTOCOL, token: TOKEN });
	await waitFrame(c, (f) => f.type === "ready");
	c.send({ type: "telegram_status" });
	const error = await waitFrame(c, (f) => f.type === "error");
	assert.equal(error.code, "unavailable");
});

// ---------- secrets never leave ----------

test("telegram: apiHash, phone, code, password and session never appear in a log line or a status frame", async (t) => {
	const fake = fakeModule({ needs2fa: true });
	const logs = [];
	const session = new TelegramSession({ loadModule: async () => fake.mod, log: (line) => logs.push(String(line)) });
	t.after(() => session.stop());
	const frames = [];
	const out = await loginFlow(session);
	frames.push(P.telegramStatusFrame(out.started), P.telegramStatusFrame(out.code), P.telegramStatusFrame(out.password));
	frames.push(P.telegramSessionFrame({ session: out.password.session }));
	frames.push(P.telegramStatusFrame(await session.logout()));
	frames.push(P.telegramStatusFrame(await session.restore({ apiId: API_ID, apiHash: API_HASH, session: SESSION })));
	const secrets = [API_HASH, PHONE, CODE, PASSWORD, SESSION, "1BQANO"];
	for (const secret of secrets) {
		for (const line of logs) assert.ok(!line.includes(secret), `a log line leaked ${secret}: ${line}`);
		for (const frame of frames) assert.ok(!JSON.stringify(frame).includes(secret) || frame.type === "telegram_session", `a frame leaked ${secret}: ${JSON.stringify(frame)}`);
	}
	assert.ok(logs.length > 0, "state changes are logged");
	assert.ok(logs.every((line) => /telegram/i.test(line)), "log lines are identifiable and content-free");
	// The one frame that carries a session is the login reply, and only when a login actually produced it.
	const leaked = frames.filter((f) => f.type !== "telegram_session" && JSON.stringify(f).includes(SESSION));
	assert.deepEqual(leaked, []);
});
