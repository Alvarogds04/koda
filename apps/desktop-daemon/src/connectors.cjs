"use strict";

/**
 * Read-only connectors view (V4): runs the `abito-connectors` CLI as a
 * subprocess and REVALIDATES its stdout against a strict allowlist
 * (`abito-connectors/view/1`, see apps/desktop-connectors/docs/CONNECT-FLOW.md).
 * The CLI is never trusted: unknown keys are dropped at every level, wrong
 * types are rejected (never coerced) and every failure is the same generic
 * error that carries no stdout, stderr or path.
 *
 * The data are the PERSISTED connectors.json values, not live state.
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const util = require("node:util");
const { accessSync, constants, lstatSync, realpathSync } = require("node:fs");
const path = require("node:path");
const { assertSecurePath } = require("./isolation.cjs");

const SCHEMA = "abito-connectors/view/1";
const DEFAULTS = Object.freeze({ timeoutMs: 5000, maxBytes: 256 * 1024 });
const MAX_CATALOG = 32;
const MAX_CONNECTORS = 256;
const MAX_FIELDS = 8;
const MAX_STEPS = 16;

/** Same shape as the CLI's connector id: 1-64 ASCII alphanumerics/`_`/`-`, alphanumeric first. */
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Field slots may also carry `.` and start with `_`. */
const FIELD_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const STATUS_CODE = /^[a-z0-9_]{1,64}$/;
/** Control (C0/C1), format (bidi marks, ZWSP, isolates...), line/paragraph separators and lone surrogates. */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const AUTH = new Set(["none", "provider_oauth", "user_oauth"]);
const MODES = new Set(["read_only", "read_and_send"]);
const STATES = new Set(["connected", "needs_setup", "failed", "disabled"]);

/** The one error this module throws: fixed message, no cause, nothing from the child. */
class ConnectorsError extends Error {
	constructor() {
		super("connectors unavailable");
		this.name = "ConnectorsError";
	}
}
const fail = () => {
	throw new ConnectorsError();
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function text(value, max) {
	if (typeof value !== "string" || value.length < 1 || value.length > max || FORBIDDEN_TEXT.test(value)) fail();
	return value;
}
/** Never usable as a property name on a plain object. */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
function id(value, pattern = CONNECTOR_ID) {
	if (typeof value !== "string" || !pattern.test(value) || RESERVED.has(value)) fail();
	return value;
}
function bool(value) {
	if (typeof value !== "boolean") fail();
	return value;
}
function int(value, min, max) {
	if (!Number.isInteger(value) || value < min || value > max) fail();
	return value;
}
function array(value, max) {
	if (!Array.isArray(value) || value.length > max) fail();
	return value;
}
function object(value) {
	if (!isObject(value)) fail();
	return value;
}

function buildField(raw) {
	const f = object(raw);
	return { key: id(f.key, FIELD_KEY), label: text(f.label, 128), secret: bool(f.secret), optional: bool(f.optional) };
}

function buildGuide(raw) {
	const g = object(raw);
	const guide = { steps: array(g.steps, MAX_STEPS).map((s) => text(s, 512)) };
	if (g.note !== undefined) guide.note = text(g.note, 512);
	return guide;
}

function buildEntry(raw) {
	const e = object(raw);
	if (!AUTH.has(e.auth)) fail();
	const entry = {
		key: id(e.key),
		label: text(e.label, 128),
		reads: text(e.reads, 512),
		sends: text(e.sends, 512),
		auth: e.auth,
		fields: array(e.fields, MAX_FIELDS).map(buildField),
	};
	if (e.guide !== undefined) entry.guide = buildGuide(e.guide);
	entry.read_only_tools_count = int(e.read_only_tools_count, 0, 1000);
	return entry;
}

/** Validated, allowlist-rebuilt catalog entries; throws ConnectorsError. */
const buildCatalog = (raw) => array(raw, MAX_CATALOG).map(buildEntry);

function buildStatus(raw) {
	const s = object(raw);
	if (typeof s.state !== "string") fail();
	const status = { state: STATES.has(s.state) ? s.state : "unknown" };
	if (s.code !== undefined) {
		if (typeof s.code !== "string" || !STATUS_CODE.test(s.code)) fail();
		status.code = s.code;
	}
	return status;
}

function buildConnector(raw) {
	const c = object(raw);
	if (typeof c.mode !== "string") fail();
	const out = { id: id(c.id), label: text(c.label, 128) };
	if (c.catalog_key !== undefined) out.catalog_key = id(c.catalog_key);
	out.mode = MODES.has(c.mode) ? c.mode : "unknown";
	out.enabled = bool(c.enabled);
	out.status = buildStatus(c.status);
	out.revision = int(c.revision, 0, Number.MAX_SAFE_INTEGER);
	out.configured = bool(c.configured);
	return out;
}

/** Validated, allowlist-rebuilt connector records; throws ConnectorsError. */
const buildConnectors = (raw) => array(raw, MAX_CONNECTORS).map(buildConnector);

/** Locale/timezone only. PATH is NOT inherited (fixed below). No PI_*, no provider keys, no real HOME. */
const CHILD_ENV_ALLOWLIST = ["LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const CHILD_PATH = "/usr/bin:/bin";

/**
 * Spawn-time trust check, run before EVERY spawn (the file may change between calls). The command
 * must be an absolute path whose realpath is a regular, executable file owned by the current user
 * or root and not group/world-writable, with a secure parent chain (assertSecurePath: no
 * world-writable-without-sticky dirs, no foreign owners, no symlink components). A symlink itself
 * is allowed only when its own directory chain is secure and it is owned by the user or root.
 * Throws the generic ConnectorsError.
 */
function assertTrustedCommand(command) {
	try {
		if (typeof command !== "string" || !path.isAbsolute(command) || path.normalize(command) !== command) fail();
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		const owned = (st) => uid === undefined || st.uid === uid || st.uid === 0;
		assertSecurePath(path.dirname(command));
		const link = lstatSync(command);
		if (!owned(link)) fail();
		const real = realpathSync(command);
		const st = lstatSync(real);
		if (!st.isFile() || !owned(st) || (st.mode & 0o022) !== 0 || (st.mode & 0o111) === 0) fail();
		accessSync(real, constants.X_OK);
		assertSecurePath(path.dirname(real));
	} catch {
		fail();
	}
}

class ConnectorsView {
	/**
	 * @param {object} options
	 * @param {string} options.command   ABSOLUTE path of the CLI binary (trusted code run as the user); never a shell, never PATH-resolved
	 * @param {string} options.dir       connectors directory passed as `status --dir`
	 * @param {object} [options.env]     base environment (filtered through an allowlist)
	 * @param {string} [options.cwd]     child cwd (the island); default `dir`
	 * @param {string} [options.home]    private HOME for the child; default `cwd`
	 * @param {number} [options.timeoutMs]  hard timeout per command, SIGKILL (default 5000)
	 * @param {number} [options.maxBytes]   stdout cap per command (default 256 KiB)
	 * @param {(line:string)=>void} [options.log]  receives fixed strings only
	 */
	constructor(options) {
		this.command = options.command;
		this.dir = options.dir;
		this.cwd = options.cwd ?? options.dir;
		this.home = options.home ?? this.cwd;
		this.baseEnv = options.env ?? process.env;
		this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
		this.maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
		this.log = options.log ?? (() => {});
	}

	childEnv() {
		const env = {};
		for (const key of CHILD_ENV_ALLOWLIST) {
			const value = this.baseEnv[key];
			if (typeof value === "string" && value !== "") env[key] = value;
		}
		env.PATH = CHILD_PATH;
		env.HOME = this.home;
		env.TMPDIR = this.home;
		return env;
	}

	/** Runs one CLI subcommand; resolves with the parsed single JSON object or throws ConnectorsError. */
	run(args) {
		return new Promise((resolve, reject) => {
			let settled = false;
			let child;
			const timer = setTimeout(() => finish(true), this.timeoutMs);
			timer.unref?.();
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) killGroup(child);
				try {
					child?.kill("SIGKILL");
				} catch {}
				child?.stdout?.destroy();
				child?.stderr?.destroy();
				if (error) {
					this.log("connectors command failed");
					return reject(new ConnectorsError());
				}
				resolve(value);
			};
			try {
				assertTrustedCommand(this.command);
				child = spawn(this.command, args, {
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: this.childEnv(),
					cwd: this.cwd,
					detached: true, // own process group so a timeout kills grandchildren too
					windowsHide: true,
				});
			} catch {
				return finish(true);
			}
			const chunks = [];
			let size = 0;
			let errSize = 0;
			child.on("error", () => finish(true));
			child.stdout.on("data", (chunk) => {
				size += chunk.length;
				if (size > this.maxBytes) return finish(true);
				chunks.push(chunk);
			});
			// Drained so the child never blocks on a full pipe; never stored nor surfaced.
			child.stderr.on("data", (chunk) => {
				errSize += chunk.length;
				if (errSize > this.maxBytes) finish(true);
			});
			child.on("close", (code) => {
				if (code !== 0) return finish(true);
				try {
					finish(false, parseOutput(Buffer.concat(chunks)));
				} catch {
					finish(true);
				}
			});
		});
	}

	/** `{catalog, connectors}`, rebuilt from allowlists. Throws ConnectorsError (generic) on any problem. */
	async snapshot() {
		const [catalog, status] = await Promise.all([this.run(["catalog"]), this.run(["status", "--dir", this.dir])]);
		if (catalog.schema !== SCHEMA || status.schema !== SCHEMA) fail();
		return { catalog: buildCatalog(catalog.entries), connectors: buildConnectors(status.connectors) };
	}
}

/** SIGKILL the child's whole process group (it is its own leader); ESRCH (already gone) is fine. */
function killGroup(child) {
	if (!child || !Number.isInteger(child.pid) || child.pid <= 1) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {}
}

/** Exactly one JSON object on one line (a single trailing LF is allowed), valid UTF-8. */
function parseOutput(buffer) {
	const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
	const line = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
	if (line === "" || line.includes("\n") || line.includes("\r")) fail();
	return object(JSON.parse(line));
}

const CONTROL_ERROR_CODES = new Set([
	"bad_request", "busy", "unavailable", "failed", "rate_limited", "unknown_proposal",
	"digest_mismatch", "needs_setup", "signin_failed",
]);
const CONTROL_CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTROL_PROPOSAL_ID = /^ap-[0-9a-f]{28,}$/;
const CONTROL_DIGEST = /^[0-9a-f]{64}$/i;
const CONTROL_RESERVED = new Set(["__proto__", "constructor", "prototype"]);

class ConnectorsControlError extends Error {
	constructor(code = "failed") {
		super("connector control failed");
		this.name = "ConnectorsControlError";
		this.code = CONTROL_ERROR_CODES.has(code) ? code : "failed";
	}
}

function controlError(code) { return new ConnectorsControlError(code); }
function controlCode(error) {
	if (error?.code === "busy" || error?.code === "rate_limited") return "busy";
	if (error?.code === "unavailable") return "unavailable";
	if (error?.code === "bad_request") return "bad_request";
	if (error?.code === "stale") return "busy";
	return "failed";
}
function validateControlId(value) {
	if (typeof value !== "string" || !CONTROL_CONNECTOR_ID.test(value) || CONTROL_RESERVED.has(value)) throw controlError("bad_request");
	return value;
}

/** A setup flow keeps values only in memory and its diagnostics are counts, never contents. */
class ConnectorSetupFlow {
	constructor(data) {
		Object.assign(this, data);
		this.values = Object.create(null);
		this.index = 0;
		this.promptId = undefined;
		this.timer = undefined;
		this.startImmediate = undefined;
	}
	clearValues() { for (const key of Object.keys(this.values)) delete this.values[key]; }
	toJSON() { return { fields: this.fields.length, fieldsRemaining: Math.max(0, this.fields.length - this.index), collectedValues: Object.keys(this.values).length, activePrompt: this.promptId ? 1 : 0 }; }
	[util.inspect.custom]() { return this.toJSON(); }
}

/** Live island-agent control adapter over the private connector-host supervisor. */
class ConnectorsControl extends EventEmitter {
	constructor(options) {
		super();
		this.host = options.host;
		this.catalogSource = options.catalog;
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
		this.promptTimeoutMs = options.promptTimeoutMs ?? 120_000;
		this.randomHex = options.randomHex ?? ((bytes) => crypto.randomBytes(bytes).toString("hex"));
		this.log = options.log ?? (() => {});
		this.closed = false;
		this.flow = undefined;
		this.lastPending = undefined;
		this.lastPendingSignature = undefined;
		this.lastConnectorsSignature = undefined;
		this.catalogCache = undefined;
		this.catalogFlight = undefined;
		this.listeners = [];
		this.wasReady = false;
		this.pendingReadDepth = 0;
		this.connectorsReadDepth = 0;
		const on = (event, fn) => {
			this.host.on(event, fn);
			this.listeners.push(() => this.host.off(event, fn));
		};
		on("status", (status) => this.onStatus(status));
		on("pending", () => {
			if (!this.pendingReadDepth) this.refreshPending().catch(() => this.log("connector pending refresh failed"));
		});
		on("connectors", () => {
			if (!this.connectorsReadDepth) this.refreshConnectors().catch(() => this.log("connector list refresh failed"));
		});
		if (this.host.status === "ready") this.onStatus("ready");
	}

	isReady() { return !this.closed && this.host?.status === "ready"; }
	isSetupFlow(flowId) { return typeof flowId === "string" && flowId.startsWith("connector-setup-"); }

	onStatus(status) {
		if (this.closed) return;
		if (status === "ready") {
			if (this.wasReady) return;
			this.wasReady = true;
			Promise.resolve().then(() => this.host.subscribe(true)).catch(() => this.log("connector host subscribe failed")).then(async () => {
				if (this.closed || !this.isReady()) return;
				try { await this.refreshPending(); } catch { this.log("connector pending refresh failed"); }
				try { await this.refreshConnectors(); } catch { this.log("connector list refresh failed"); }
			});
			return;
		}
		this.wasReady = false;
		if (this.lastPending?.length) {
			this.lastPending = [];
			this.lastPendingSignature = this.pendingSignature([]);
			this.emit("pending", []);
		}
		if (this.flow) this.finishFlow(this.flow, { ok: false, message: "unavailable" });
	}

	async getCatalog() {
		if (this.catalogCache) return this.catalogCache;
		if (this.catalogFlight) return this.catalogFlight;
		const flight = Promise.resolve().then(() => this.catalogSource()).then((catalog) => {
			this.catalogCache = buildCatalog(catalog);
			return this.catalogCache;
		}).catch(() => []);
		this.catalogFlight = flight;
		try { return await flight; }
		finally { if (this.catalogFlight === flight) this.catalogFlight = undefined; }
	}

	async connectors() {
		if (!this.isReady()) throw controlError("unavailable");
		let snapshot;
		this.connectorsReadDepth++;
		try { snapshot = await this.host.connectors(); }
		catch (error) { throw controlError(controlCode(error)); }
		finally { this.connectorsReadDepth--; }
		try {
			return { catalog: await this.getCatalog(), connectors: buildConnectors(snapshot?.connectors), live: true };
		} catch {
			throw controlError("failed");
		}
	}

	pendingSignature(items) {
		return JSON.stringify(items.map((item) => [
			item.proposal_id, item.connector_id, item.connector_label, item.connector_label_truncated,
			item.tool, item.arguments_preview, item.arguments_truncated, item.arguments_sensitive, item.digest,
		]));
	}

	async readPending() {
		if (!this.isReady()) throw controlError("unavailable");
		let pendingItems;
		let connectorItems;
		this.pendingReadDepth++;
		this.connectorsReadDepth++;
		try { [pendingItems, connectorItems] = await Promise.all([this.host.pending(), this.host.connectors()]); }
		catch (error) { throw controlError(controlCode(error)); }
		finally { this.pendingReadDepth--; this.connectorsReadDepth--; }
		if (!this.isReady()) throw controlError("unavailable");
		try {
			if (!Array.isArray(pendingItems) || pendingItems.length > 64) throw new Error("invalid pending list");
			const records = buildConnectors(connectorItems?.connectors);
			const labels = new Map(records.map((item) => [item.id, item.label]));
			return pendingItems.map((item) => {
				const proposalId = item.proposalId ?? item.proposal_id;
				const connectorId = item.connectorId ?? item.connector_id;
				if (typeof proposalId !== "string" || !CONTROL_PROPOSAL_ID.test(proposalId) || typeof connectorId !== "string" || !CONTROL_CONNECTOR_ID.test(connectorId) || CONTROL_RESERVED.has(connectorId)) throw new Error("invalid pending item");
				const rawLabel = item.connectorLabel ?? item.connector_label ?? labels.get(connectorId) ?? connectorId;
				if (typeof rawLabel !== "string") throw new Error("invalid label");
				const labelChars = Array.from(rawLabel);
				const labelTruncated = item.connectorLabelTruncated === true || item.connector_label_truncated === true || labelChars.length > 128;
				const connectorLabel = labelChars.slice(0, 128).join("");
				const tool = item.tool;
				const preview = item.argumentsPreview ?? item.arguments_preview;
				const truncated = item.argumentsTruncated === true || item.arguments_truncated === true;
				const sensitive = item.argumentsSensitive === true || item.arguments_sensitive === true;
				const itemDigest = item.digest;
				const expires = item.expiresInMs ?? item.expires_in_ms;
				if (typeof tool !== "string" || tool.length < 1 || tool.length > 128 || typeof preview !== "string" || Array.from(preview).length > 512 || typeof itemDigest !== "string" || !CONTROL_DIGEST.test(itemDigest) || !Number.isSafeInteger(expires) || expires < 0) throw new Error("invalid pending item");
				if (!sensitive) throw new Error("invalid pending sensitivity");
				return {
					proposal_id: proposalId, connector_id: connectorId, connector_label: connectorLabel,
					connector_label_truncated: labelTruncated, tool, arguments_preview: preview,
					arguments_truncated: truncated, arguments_sensitive: true, digest: itemDigest.toLowerCase(), expires_in_ms: expires,
				};
			});
		} catch {
			throw controlError("failed");
		}
	}

	async pending() {
		const items = await this.readPending();
		this.publishPending(items, false);
		return items;
	}

	publishPending(items, force) {
		if (this.closed) return;
		const signature = this.pendingSignature(items);
		if (force || signature !== this.lastPendingSignature) {
			this.lastPending = items;
			this.lastPendingSignature = signature;
			this.emit("pending", items);
		}
	}

	async refreshPending(force = false) {
		const items = await this.readPending();
		this.publishPending(items, force);
		return items;
	}

	publishConnectors(data, force) {
		if (this.closed) return;
		const signature = JSON.stringify([data.catalog, data.connectors]);
		if (force || signature !== this.lastConnectorsSignature) {
			this.lastConnectorsSignature = signature;
			this.emit("connectors", data);
		}
	}

	async refreshConnectors(force = false) {
		const data = await this.connectors();
		this.publishConnectors(data, force);
		return data;
	}

	async refreshMutation() {
		const items = await this.refreshPending(true);
		await this.refreshConnectors(true);
		return items;
	}

	async decision(method, proposalId, digest) {
		if (typeof proposalId !== "string" || !CONTROL_PROPOSAL_ID.test(proposalId)) throw controlError("bad_request");
		if (method === "approve" && (typeof digest !== "string" || !CONTROL_DIGEST.test(digest))) throw controlError("bad_request");
		if (!this.isReady()) throw controlError("unavailable");
		try {
			if (method === "approve") await this.host.approve(proposalId, digest.toLowerCase());
			else await this.host.deny(proposalId);
		} catch (error) {
			if (error?.code === "stale") {
				const items = await this.refreshMutation();
				const current = items.find((item) => item.proposal_id === proposalId);
				if (method === "approve" && current && current.digest !== digest.toLowerCase()) throw controlError("digest_mismatch");
				throw controlError("unknown_proposal");
			}
			throw controlError(controlCode(error));
		}
		try { await this.refreshMutation(); }
		catch { this.log("connector decision refresh failed"); }
	}

	approve(proposalId, digest) { return this.decision("approve", proposalId, digest); }
	deny(proposalId) { return this.decision("deny", proposalId); }

	async currentRecord(connectorId) {
		let listing;
		try { listing = await this.host.connectors(); }
		catch (error) { throw controlError(controlCode(error)); }
		try {
			const records = buildConnectors(listing?.connectors);
			return records.find((item) => item.id === connectorId);
		} catch { throw controlError("failed"); }
	}

	async mutateConnector(method, connectorId, mode) {
		validateControlId(connectorId);
		if (!this.isReady()) throw controlError("unavailable");
		if (method === "setMode" && mode !== "read_only" && mode !== "read_and_send") throw controlError("bad_request");
		let current = await this.currentRecord(connectorId);
		if (!current) throw controlError("bad_request");
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				if (method === "disconnect") await this.host.disconnect(connectorId, current.revision);
				else await this.host.setMode(connectorId, mode, current.revision);
				await this.refreshConnectors(true);
				return;
			} catch (error) {
				if (error?.code === "stale" && attempt === 0) {
					current = await this.currentRecord(connectorId);
					if (!current) throw controlError("bad_request");
					continue;
				}
				throw controlError(controlCode(error));
			}
		}
		throw controlError("busy");
	}

	disconnect(connectorId) { return this.mutateConnector("disconnect", connectorId); }
	setMode(connectorId, mode) { return this.mutateConnector("setMode", connectorId, mode); }

	async connect(connectorId) {
		validateControlId(connectorId);
		if (!this.isReady()) throw controlError("unavailable");
		if (this.flow) throw controlError("busy");
		let listing;
		try { listing = await this.host.connectors(); }
		catch (error) { throw controlError(controlCode(error)); }
		let records;
		try { records = buildConnectors(listing?.connectors); }
		catch { throw controlError("failed"); }
		const current = records.find((item) => item.id === connectorId);
		const catalogKey = current?.catalog_key ?? connectorId;
		const catalog = await this.getCatalog();
		if (!this.isReady()) throw controlError("unavailable");
		const entry = catalog.find((item) => item.key === catalogKey);
		if (!entry) throw controlError("bad_request");
		if (entry.auth === "provider_oauth") throw controlError("unavailable");
		if (this.flow) throw controlError("busy");
		const suffix = this.randomHex(8);
		if (typeof suffix !== "string" || !/^[0-9a-f]{16}$/.test(suffix)) throw controlError("failed");
		const flow = new ConnectorSetupFlow({ flowId: `connector-setup-${suffix}`, connectorId, revision: current?.revision ?? 0, fields: entry.fields });
		this.flow = flow;
		flow.startImmediate = setImmediate(() => { flow.startImmediate = undefined; this.advanceFlow(flow).catch(() => this.finishFlow(flow, { ok: false, message: "failed" })); });
		return { flowId: flow.flowId };
	}

	async advanceFlow(flow) {
		if (this.closed || this.flow !== flow) return;
		if (flow.index >= flow.fields.length) {
			let result;
			const connectFailure = (error) => {
				const code = error?.code === "unavailable" ? "unavailable" : error?.code === "bad_request" ? "needs_setup" : error?.code === "failed" ? "signin_failed" : ["busy", "rate_limited", "stale"].includes(error?.code) ? "busy" : "signin_failed";
				return { ok: false, message: code };
			};
			// Fail closed: exactly one host.connect per flow. A host `stale` cannot tell a
			// pre-apply refusal from a post-seal one, so it is never retried (deferred: needs a
			// distinct host code). It maps to `busy` and the live list is refreshed below.
			try {
				await this.host.connect(flow.connectorId, flow.revision, flow.values);
				result = { ok: true };
			} catch (error) {
				result = connectFailure(error);
			}
			if (this.flow !== flow || this.closed) return;
			this.finishFlow(flow, result ?? { ok: false, message: "busy" });
			try { await this.refreshConnectors(true); } catch { this.log("connector list refresh failed"); }
			return;
		}
		const field = flow.fields[flow.index];
		flow.promptId = this.randomHex(8);
		if (typeof flow.promptId !== "string" || !/^[0-9a-f]{16}$/.test(flow.promptId)) return this.finishFlow(flow, { ok: false, message: "failed" });
		this.emit("auth_prompt", {
			flowId: flow.flowId, promptId: flow.promptId, accountId: "", connector_id: flow.connectorId,
			kind: field.secret ? "secret" : "text", message: field.label, secret: field.secret, optional: field.optional,
		});
		flow.timer = this.setTimer(() => {
			flow.timer = undefined;
			this.finishFlow(flow, { ok: false, message: "needs_setup" });
		}, this.promptTimeoutMs);
		flow.timer?.unref?.();
	}

	async reply(flowId, promptId, value) {
		const flow = this.flow;
		if (!flow || flow.flowId !== flowId || flow.promptId !== promptId || typeof value !== "string") throw controlError("bad_request");
		this.clearTimer(flow.timer);
		flow.timer = undefined;
		flow.promptId = undefined;
		const field = flow.fields[flow.index++];
		if (value === "") {
			if (!field.optional) return this.finishFlow(flow, { ok: false, message: "needs_setup" });
		} else {
			flow.values[field.key] = value;
		}
		await this.advanceFlow(flow);
	}

	async cancel(flowId) {
		if (!this.flow || this.flow.flowId !== flowId) throw controlError("bad_request");
		this.finishFlow(this.flow, { ok: false, cancelled: true });
	}

	finishFlow(flow, result) {
		if (this.flow !== flow) return;
		this.clearTimer(flow.timer);
		flow.timer = undefined;
		if (flow.startImmediate) clearImmediate(flow.startImmediate);
		flow.startImmediate = undefined;
		flow.promptId = undefined;
		flow.clearValues();
		this.flow = undefined;
		this.emit("auth_done", {
			flowId: flow.flowId, accountId: "", connector_id: flow.connectorId, ...result,
		});
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		if (this.flow) this.finishFlow(this.flow, { ok: false, cancelled: true, message: "unavailable" });
		for (const off of this.listeners.splice(0)) off();
	}

	toJSON() { return { listeners: this.listeners.length, activeFlows: this.flow ? 1 : 0, pendingItems: this.lastPending?.length ?? 0 }; }
	[util.inspect.custom]() { return this.toJSON(); }
}

module.exports = { ConnectorsError, ConnectorsView, ConnectorsControl, ConnectorsControlError, SCHEMA, buildCatalog, buildConnectors };
