"use strict";

/**
 * K2-13 (T1b, S6/S10/S20): the daemon's Telegram client.
 *
 * ONE client per daemon, built ALWAYS with mtcute's `MemoryStorage`. The session is a credential: the island keeps it in
 * the OS keychain and hands it over at start (`telegram_session_restore`); the daemon keeps it in memory only, and no
 * file of any kind is written (mtcute's default storage would write `client.session` in the working directory, so the
 * storage is never left to a default and a caller cannot pass one). The session leaves the daemon in exactly one frame,
 * `telegram_session`, which is a reply to the connection that asked for it and NEVER a broadcast.
 *
 * Nothing secret is ever logged, stored on disk, put in «Hoy» or repeated in an error: apiHash, phone, code, password and
 * session stay in memory. Errors surface as closed codes (`TELEGRAM_ERROR_CODES`) with a fixed Spanish sentence; the raw
 * Telegram text is kept only as the error's `cause`, never in its message and never in a frame.
 *
 * The login is frame-driven, not readline-driven: `loginStart` sends the code request and returns at once, `loginCode`
 * and `loginPassword` deliver the person's answer, and a wrong answer keeps the flow alive so the island can ask again.
 * FLOOD_WAIT is absorbed by mtcute up to 10 s; a longer one surfaces here as `telegram_flood_wait` with the minutes.
 */

const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

const MODULE_SPEC = "@mtcute/node";
/** The package's own ESM entry when its manifest cannot be read (mtcute 0.32.8: `.` → `./index.js`). */
const DEFAULT_ENTRY = "index.js";
const STATES = Object.freeze(["disconnected", "awaiting_code", "awaiting_password", "connected"]);

/** Fixed Spanish sentences. One per closed code, so the island never has to translate a Telegram string. */
const SPANISH_NOTICES = Object.freeze({
	telegram_unavailable: "Telegram no está disponible en esta instalación de Koda.",
	telegram_already_connected: "Ya hay una cuenta de Telegram conectada. Desconectala antes de conectar otra.",
	telegram_not_awaiting_code: "No estoy esperando un código de Telegram.",
	telegram_not_awaiting_password: "No estoy esperando la contraseña de dos pasos.",
	telegram_credentials_invalid: "El api_id o el api_hash no son válidos. Revisalos en Ajustes.",
	telegram_code_invalid: "El código de Telegram no es válido. Pedí uno nuevo e intentá otra vez.",
	telegram_password_invalid: "La contraseña de dos pasos no es correcta. Probá otra vez.",
	telegram_password_required: "Telegram pide la contraseña de dos pasos de tu cuenta.",
	telegram_flood_wait: "Telegram pidió esperar; volvé a intentar cuando pase el tiempo indicado.",
	telegram_session_invalid: "La sesión de Telegram ya no es válida. Conectá tu cuenta otra vez.",
	telegram_not_connected: "No hay ninguna cuenta de Telegram conectada. Conectala en Ajustes.",
	telegram_channel_invalid: "El canal de Telegram no es válido. Usá @usuario o un enlace t.me del canal.",
	telegram_cancelled: "La conexión con Telegram se canceló.",
	telegram_login_other_connection: "Esa conexión con Telegram la empezó otra ventana de Koda. Terminála desde ahí.",
	telegram_failed: "Telegram no respondió como se esperaba. Probá otra vez.",
});
/** Every code the Telegram frames can carry (the server maps them through `SPANISH_NOTICES`). */
const TELEGRAM_ERROR_CODES = Object.freeze(Object.keys(SPANISH_NOTICES));

class TelegramError extends Error {
	/** @param {string} code one of TELEGRAM_ERROR_CODES @param {object} [extra] notice, retryAfterMinutes, cause */
	constructor(code, extra = {}) {
		// A mapped failure may carry a more precise sentence (FLOOD_WAIT: «…esperar 4 minutos»): it wins over the fixed one.
		const notice = typeof extra.notice === "string" && extra.notice !== "" ? extra.notice : SPANISH_NOTICES[code] ?? SPANISH_NOTICES.telegram_failed;
		super(notice);
		this.name = "TelegramError";
		this.code = SPANISH_NOTICES[code] ? code : "telegram_failed";
		this.notice = notice;
		if (extra.retryAfterMinutes !== undefined) this.retryAfterMinutes = extra.retryAfterMinutes;
		if (extra.cause !== undefined) this.cause = extra.cause;
	}
}

const rpcText = (error) => String(error?.text ?? error?.errorMessage ?? error?.message ?? "");

/** Telegram allows first+last to add up to 129 chars; the status frame carries a name capped at 80. */
const MAX_ACCOUNT_NAME = 80;
/** The longest session string that may travel in one `telegram_session` frame (a real mtcute session is ~350 chars). */
const SESSION_MAX_CHARS = 4096;
/**
 * The session contract, shared with protocol.cjs so the frame builder, the frame decoder and the login agree on ONE
 * definition: printable ASCII, non-empty, bounded. mtcute's own string session is base64 of a fixed layout, so it always
 * satisfies this; anything else (a client that answered a file path, a JSON blob, a pasted multi-line string) does not.
 */
const isCarriableSession = (value) =>
	typeof value === "string"
	&& value !== ""
	&& value.length <= SESSION_MAX_CHARS
	&& !/[\u0000-\u001f\u007f]/.test(value)
	&& /^[\x20-\x7e]+$/.test(value);

/**
 * Maps a Telegram/mtcute failure to one closed code plus its Spanish sentence. The raw text is never echoed: it can
 * contain anything (a phone number in a server message), and the person gets a sentence Koda wrote.
 */
function mapRpcError(error) {
	const text = rpcText(error);
	const flood = /(?:FLOOD|SLOWMODE|FLOOD_PREMIUM|FLOOD_TEST_PHONE)_WAIT_(\d+)/.exec(text);
	const seconds = flood ? Number(flood[1]) : Number.parseInt(String(error?.seconds ?? ""), 10);
	if (Number.isFinite(seconds) && (flood || Number.isFinite(Number.parseInt(String(error?.seconds ?? ""), 10)))) {
		const minutes = Math.max(1, Math.ceil(seconds / 60));
		return { code: "telegram_flood_wait", retryAfterMinutes: minutes, notice: `Telegram pidió esperar ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.` };
	}
	if (/PHONE_CODE_(?:INVALID|EMPTY|EXPIRED)/.test(text)) return { code: "telegram_code_invalid", notice: SPANISH_NOTICES.telegram_code_invalid };
	if (/PASSWORD_HASH_INVALID/.test(text)) return { code: "telegram_password_invalid", notice: SPANISH_NOTICES.telegram_password_invalid };
	if (/SESSION_PASSWORD_NEEDED/.test(text)) return { code: "telegram_password_required", notice: SPANISH_NOTICES.telegram_password_required };
	if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED/.test(text)) return { code: "telegram_session_invalid", notice: SPANISH_NOTICES.telegram_session_invalid };
	if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD|API_HASH/.test(text)) return { code: "telegram_credentials_invalid", notice: SPANISH_NOTICES.telegram_credentials_invalid };
	return { code: "telegram_failed", notice: SPANISH_NOTICES.telegram_failed };
}

/** The ESM entry of `@mtcute/node` from its manifest (`exports["."]`, then `module`/`main`), relative to the package. */
function clientModuleEntry(manifestJson) {
	let manifest;
	try {
		manifest = JSON.parse(manifestJson);
	} catch {
		return DEFAULT_ENTRY;
	}
	const pick = (value) => {
		if (typeof value === "string") return value;
		if (!value || typeof value !== "object") return undefined;
		return pick(value.import) ?? pick(value.default) ?? pick(value.node) ?? pick(value.require);
	};
	const entry = pick(manifest?.exports?.["."]) ?? pick(manifest?.module) ?? pick(manifest?.main);
	if (typeof entry !== "string" || entry === "") return DEFAULT_ENTRY;
	return entry.replace(/^\.\//, "");
}

const defaultImporter = async (spec) => import(path.isAbsolute(spec) ? pathToFileURL(spec).href : spec);

/** The phone/code/password answer a restore can never produce: it refuses, never touching stdio. */
const restoreRefusesByDesign = () => {
	throw new TelegramError("telegram_session_invalid");
};

/**
 * mtcute's own log manager (`@mtcute/core` LogManager): 0 is OFF. It is passed explicitly, so nothing the library logs —
 * which at INFO/DEBUG/VERBOSE carries phone numbers, codes and payloads — reaches the daemon's stdio, whatever
 * `MTCUTE_LOG_LEVEL` is set to in the person's environment (NodePlatform reads it as the default level).
 */
const MTCUTE_LOG_OFF = 0;

/**
 * Finds the client library where Koda ships it (S6, L41): beside the Node the daemon runs on — the bundled runtime, so
 * `<prefix>/runtime/node_modules` — then beside the daemon's own package (`<prefix>/runtime` again, for a daemon started
 * by another Node), and only then by ordinary Node resolution (a development checkout with `node_modules`).
 * Returns the imported module namespace; throws whatever the last attempt threw.
 */
async function resolveClientModule({ execPath = process.execPath, packageRoot = path.resolve(__dirname, "..", ".."), importer = defaultImporter } = {}) {
	const candidates = [];
	if (typeof execPath === "string" && execPath !== "") candidates.push(path.dirname(execPath));
	if (typeof packageRoot === "string" && packageRoot !== "") candidates.push(path.resolve(packageRoot, "..", "runtime"));
	for (const dir of candidates) {
		const pkg = path.join(dir, "node_modules", ...MODULE_SPEC.split("/"));
		let manifest;
		try {
			manifest = fs.readFileSync(path.join(pkg, "package.json"), "utf8");
		} catch {
			continue; // not shipped there
		}
		return importer(path.join(pkg, clientModuleEntry(manifest)));
	}
	return importer(MODULE_SPEC);
}

/**
 * The daemon's Telegram session. Events: "status" (the public `{state, account?, notice?, retryAfterMinutes?}` object
 * changed; never a secret). Methods resolve to public data only; a failure throws TelegramError with a closed code.
 */
class TelegramSession extends EventEmitter {
	/**
	 * @param {object} [options]
	 * @param {(line: string) => void} [options.log]   content-free state log (never a phone, code, password, apiHash or session)
	 * @param {() => Promise<object>} [options.loadModule] the client library (`{TelegramClient, MemoryStorage}`); tests inject a fake
	 * @param {object} [options.resolution]            {execPath, packageRoot, importer} for the default loader
	 */
	constructor(options = {}) {
		super();
		// S20: the storage is never a decision. A caller that tries to pass one is refused instead of silently replaced.
		if (options.storage !== undefined) throw new TypeError("TelegramSession never accepts a storage: the client always uses mtcute's MemoryStorage (S20)");
		if (options.session !== undefined) throw new TypeError("TelegramSession never accepts a session at construction: use restore()");
		this.log = options.log ?? (() => {});
		this.resolution = options.resolution ?? {};
		this.loadModule = options.loadModule ?? (() => resolveClientModule(this.resolution));
		this.state = "disconnected";
		this.account = undefined;
		this.client = undefined;
		this.flow = undefined;
		this.module = undefined;
		this.apiId = undefined;
		this.apiHash = undefined;
		this.session = undefined;
		this.waiting = { code: undefined, password: undefined };
		this.queued = { code: undefined, password: undefined };
		this.loginOwner = undefined;
		this.waiters = [];
		this.flowEnd = undefined;
		this.stopped = false;
	}

	/** The public status frame's data: never a phone, apiHash, code, password or session. */
	status() {
		return {
			state: this.state,
			...(this.account ? { account: { name: this.account.name, username: this.account.username } } : {}),
		};
	}

	#emitStatus(extra = {}) {
		const status = { ...this.status(), ...extra };
		this.emit("status", status);
		return status;
	}

	// ----- the frame-driven login ------------------------------------------------------------

	/** Starts a login: builds the one client (MemoryStorage), asks Telegram for a code and returns at once. The code
	 * request's outcome (a FLOOD_WAIT, an invalid api_id) arrives as a "status" event with its Spanish notice.
	 * `owner` is the connection that started it: only that connection may answer or replace the flow. */
	async loginStart({ apiId, apiHash, phone, owner }) {
		if (this.stopped) throw new TelegramError("telegram_cancelled");
		if (this.state === "connected") throw new TelegramError("telegram_already_connected");
		// A pending login belongs to the window that started it: another one cannot silently replace it (two windows
		// starting at once both ended up receiving the session).
		if (this.loginOwner !== undefined && owner !== this.loginOwner) throw new TelegramError("telegram_login_other_connection");
		await this.#discard("telegram_cancelled");
		const module = await this.#clientModule();
		this.apiId = apiId;
		this.apiHash = apiHash;
		this.client = new module.TelegramClient({ apiId, apiHash, storage: new module.MemoryStorage(), logLevel: MTCUTE_LOG_OFF });
		this.loginOwner = owner;
		this.state = "awaiting_code";
		this.account = undefined;
		this.session = undefined;
		this.flowEnd = undefined;
		this.log("telegram: login started (mtcute client with MemoryStorage)");
		const flow = this.#drive(this.client, { apiId, apiHash, phone });
		this.flow = flow;
		flow.catch(() => {}); // delivered through #notify; a frame that is never asked for must not crash the daemon
		this.#emitStatus();
		return { state: this.state };
	}

	/** Delivers the code Telegram sent. Resolves to the next state, or to the session when the login finished. */
	async loginCode(code, owner) {
		if (this.state !== "awaiting_code") throw new TelegramError("telegram_not_awaiting_code");
		this.#assertOwner(owner);
		return this.#answer("code", code);
	}

	/** Delivers the two-step password. Resolves to the next state, or to the session when the login finished. */
	async loginPassword(password, owner) {
		if (this.state !== "awaiting_password") throw new TelegramError("telegram_not_awaiting_password");
		this.#assertOwner(owner);
		return this.#answer("password", password);
	}

	/**
	 * Rehydrates the client from the island's keychain session (sent at start). Resolves to `{state, session?}`; the
	 * session is present only when Telegram rotated it, so an unchanged one is never echoed back.
	 */
	async restore({ apiId, apiHash, session }) {
		if (this.stopped) throw new TelegramError("telegram_cancelled");
		await this.#discard("telegram_cancelled");
		const module = await this.#clientModule();
		this.apiId = apiId;
		this.apiHash = apiHash;
		const client = new module.TelegramClient({ apiId, apiHash, storage: new module.MemoryStorage(), logLevel: MTCUTE_LOG_OFF });
		this.client = client;
		try {
			// S6/S20: restoring NEVER asks anything. mtcute's Node client fills a missing phone, code or 2FA password
			// with `readline` prompts on stdin/stdout, so a dead session (`AUTH_KEY_UNREGISTERED`) would print
			// «phone > » and wait forever on a daemon that has no terminal. These callbacks refuse instead: the restore
			// settles `disconnected` with `telegram_session_invalid`, and nothing is read from or written to stdio.
			const user = await client.start({ apiId, apiHash, session, phone: restoreRefusesByDesign, code: restoreRefusesByDesign, password: restoreRefusesByDesign });
			this.#signedIn(user);
			const exported = await this.#export(client);
			const rotated = exported !== undefined && exported !== session ? exported : undefined;
			if (rotated === undefined) this.session = session;
			this.log("telegram: session restored from the island");
			this.#emitStatus();
			return { state: this.state, ...(rotated !== undefined ? { session: rotated } : {}) };
		} catch (error) {
			// A dead session (AUTH_KEY_UNREGISTERED and friends) and our own refusal above share one closed code: the
			// island asks the person to connect again, and nothing else about the failure travels.
			const mapped = error instanceof TelegramError ? { code: error.code, notice: error.notice } : mapRpcError(error);
			await this.#discard(error);
			if (mapped.code === "telegram_session_invalid") {
				this.log("telegram: the stored session is no longer valid");
				this.#emitStatus({ notice: mapped.notice });
				throw new TelegramError(mapped.code, { cause: error });
			}
			throw new TelegramError(mapped.code, { ...mapped, cause: error });
		}
	}

	/** Disconnects: revokes the auth key on Telegram when it can, always drops the client and the account. */
	async logout() {
		const client = this.client;
		if (client) {
			try {
				await client.logout?.();
			} catch {
				this.log("telegram: could not revoke the session on Telegram (forgetting it locally anyway)");
			}
		}
		await this.#discard("telegram_cancelled"); // tears the client down exactly once
		this.#forget();
		this.log("telegram: logged out");
		this.#emitStatus();
		return { state: this.state };
	}

	/** The daemon is stopping: cancel a pending login and drop the client. Never throws. */
	async stop() {
		this.stopped = true;
		await this.#discard("telegram_cancelled");
		this.#forget();
	}

	/** The live client, for the channel reader (commit 3); undefined unless a session is connected. */
	connectedClient() {
		return this.state === "connected" ? this.client : undefined;
	}

	// ----- internals -------------------------------------------------------------------------

	#forget() {
		this.client = undefined;
		this.state = "disconnected";
		this.account = undefined;
		this.session = undefined;
		this.apiHash = undefined;
		this.flow = undefined;
		this.flowEnd = undefined;
		this.loginOwner = undefined;
	}

	/** Only the connection that started a login may answer it; a flow without an owner (tests, an embedded call) is open. */
	#assertOwner(owner) {
		if (this.loginOwner !== undefined && owner !== this.loginOwner) throw new TelegramError("telegram_login_other_connection");
	}

	/** Cancels the flow in flight (its pending answer rejects with `code`) and destroys the client. */
	async #discard(cause) {
		const client = this.client;
		const waiting = this.waiting;
		this.waiting = { code: undefined, password: undefined };
		const rejection = cause instanceof TelegramError ? cause : new TelegramError(typeof cause === "string" ? cause : "telegram_cancelled");
		for (const kind of ["code", "password"]) waiting[kind]?.reject(rejection);
		this.client = undefined;
		this.flow = undefined;
		if (client) {
			await Promise.resolve(client.destroy?.()).catch(() => {});
		}
		this.state = "disconnected";
		this.account = undefined;
		this.loginOwner = undefined;
	}

	async #clientModule() {
		if (this.module) return this.module;
		let module;
		try {
			module = await this.loadModule();
		} catch (error) {
			throw new TelegramError("telegram_unavailable", { cause: error });
		}
		if (typeof module?.TelegramClient !== "function" || typeof module?.MemoryStorage !== "function") {
			throw new TelegramError("telegram_unavailable");
		}
		this.module = module;
		return module;
	}

	#ask(kind) {
		if (this.queued[kind] !== undefined) {
			const value = this.queued[kind];
			this.queued[kind] = undefined;
			return Promise.resolve(value);
		}
		return new Promise((resolve, reject) => {
			this.waiting[kind] = { resolve, reject };
		});
	}

	#notify(event) {
		// "asked"/"invalid" are steps in a live flow; only "done"/"failed" end it (a late frame then sees that ending).
		if (event.kind === "done" || event.kind === "failed") this.flowEnd = event;
		for (const waiter of this.waiters.splice(0)) waiter(event);
	}

	/** Waits for the flow's next event: another prompt, the session, or a closed error. */
	#nextEvent() {
		if (this.flowEnd) return Promise.resolve(this.flowEnd);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	async #answer(kind, value) {
		const waiting = this.waiting[kind];
		if (waiting) {
			this.waiting[kind] = undefined;
			waiting.resolve(value);
		} else {
			this.queued[kind] = value; // the flow has not asked yet: the answer is waiting for it
		}
		const event = await this.#nextEvent();
		if (event.kind === "done") {
			this.state = "connected";
			this.#emitStatus();
			return { state: this.state, ...(event.session !== undefined ? { session: event.session } : {}) };
		}
		if (event.kind === "failed") throw event.error;
		if (event.kind === "invalid") {
			// Telegram refused the answer but the flow is still alive: the person is where they were and can retry.
			throw new TelegramError(event.type === "password" ? "telegram_password_invalid" : "telegram_code_invalid");
		}
		this.state = event.type === "password" ? "awaiting_password" : "awaiting_code";
		this.#emitStatus();
		return { state: this.state };
	}

	#signedIn(user) {
		this.state = "connected";
		const raw = typeof user?.displayName === "string" && user.displayName.trim() !== "" ? user.displayName : typeof user?.firstName === "string" ? user.firstName : "Cuenta de Telegram";
		// The status frame caps the name at 80 and refuses control characters; a real Telegram name can be 129 chars, so it
		// is clipped HERE (a frame builder that throws would leave a person logged in with no status to show for it).
		const name = String(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_ACCOUNT_NAME) || "Cuenta de Telegram";
		const username = typeof user?.username === "string" && user.username !== "" ? user.username : null;
		this.account = { name, username };
	}

	/** The exported session, or undefined when the client has none (a restore then keeps the island's copy as it is). */
	async #export(client) {
		try {
			const exported = await client.exportSession();
			return typeof exported === "string" && exported !== "" ? exported : undefined;
		} catch {
			return undefined;
		}
	}

	async #drive(client, { apiId, apiHash, phone }) {
		try {
			const user = await client.start({
				apiId,
				apiHash,
				phone,
				code: () => {
					this.#notify({ kind: "asked", type: "code" });
					return this.#ask("code");
				},
				password: () => {
					this.#notify({ kind: "asked", type: "password" });
					return this.#ask("password");
				},
				invalidCodeCallback: async (type) => {
					// Telegram refused the answer: stay where the person was (the flow asks again), and tell the frame that
					// sent it why, so the island can say «el código no es válido» instead of silently waiting.
					this.state = type === "password" ? "awaiting_password" : "awaiting_code";
					this.#notify({ kind: "invalid", type });
					this.#emitStatus();
				},
				codeSentCallback: () => this.log("telegram: Telegram sent the login code"),
			});
			// The session leaves in the ONE `telegram_session` frame, which carries printable ASCII bounded by
			// SESSION_MAX_CHARS. A login that cannot produce such a value must not complete: the island could neither
			// store it in the keychain nor restore it, and the daemon would look connected with nothing to reconnect with.
			const exported = await this.#export(client);
			if (!isCarriableSession(exported)) throw new TelegramError("telegram_failed");
			this.#signedIn(user);
			const session = exported;
			this.session = session;
			this.apiHash = apiHash; // still needed to reconnect; memory only
			this.loginOwner = undefined;
			this.log("telegram: login finished");
			this.#notify({ kind: "done", session });
			this.#emitStatus();
		} catch (error) {
			const mapped = error instanceof TelegramError && error.code === "telegram_cancelled" ? { code: "telegram_cancelled", notice: error.message } : error instanceof TelegramError ? { code: error.code, notice: error.notice } : mapRpcError(error);
			const failure = new TelegramError(mapped.code, { ...mapped, cause: error });
			if (mapped.code === "telegram_cancelled") {
				this.log("telegram: login cancelled");
			} else {
				this.log(`telegram: login failed (${failure.code})`);
			}
			if (mapped.code === "telegram_session_invalid" || mapped.code === "telegram_failed") {
				// Nothing is waiting to be retried: the attempt is over, and an auth key nobody could store must not linger.
				await this.#discard(failure);
			} else {
				this.state = this.state === "connected" ? "connected" : this.state === "awaiting_password" ? "awaiting_password" : "awaiting_code";
			}
			this.#notify({ kind: "failed", error: failure });
			this.#emitStatus({ notice: failure.notice, ...(failure.retryAfterMinutes !== undefined ? { retryAfterMinutes: failure.retryAfterMinutes } : {}) });
			throw failure; // session.flow rejects too: a caller that awaited it never hangs on a dead flow
		}
	}
}

/** The daemon wires one of these (daemon.cjs); the server routes the telegram_* frames to it. */
const createTelegram = (options) => new TelegramSession(options);

module.exports = {
	TelegramSession,
	TelegramError,
	createTelegram,
	TELEGRAM_STATES: STATES,
	TELEGRAM_ERROR_CODES,
	SPANISH_NOTICES,
	mapRpcError,
	resolveClientModule,
	clientModuleEntry,
	isCarriableSession,
	SESSION_MAX_CHARS,
	MAX_ACCOUNT_NAME,
	MODULE_SPEC,
};
