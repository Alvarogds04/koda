"use strict";

const net = require("node:net");
const { EventEmitter } = require("node:events");
const util = require("node:util");
const { buildCatalog, buildConnectors } = require("./connectors.cjs");

const PROTOCOL = "abito-connector-host/1";
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 64;
const ERROR_CODES = new Set(["bad_request", "stale", "busy", "unavailable", "failed", "rate_limited", "too_large"]);
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROPOSAL_ID = /^ap-[0-9a-f]{28,}$/;
const DIGEST = /^[0-9a-fA-F]{64}$/;
const FIELD_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const MODES = new Set(["read_only", "read_and_send"]);
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;
const privateClientState = new WeakMap();

class ConnectorHostError extends Error {
	constructor(code = "failed") {
		super("connector host request failed");
		this.name = "ConnectorHostError";
		this.code = ERROR_CODES.has(code) ? code : "failed";
	}
}
const fail = (code = "bad_request") => { throw new ConnectorHostError(code); };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const safeInt = (v, min = 0) => Number.isSafeInteger(v) && v >= min;

function validateId(value) {
	if (typeof value !== "string" || !CONNECTOR_ID.test(value) || RESERVED.has(value)) fail();
	return value;
}
function validateRevision(value) {
	if (!safeInt(value)) fail();
	return value;
}
function validateProposalId(value) {
	if (typeof value !== "string" || !PROPOSAL_ID.test(value)) fail();
	return value;
}
function validateValues(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) fail();
	const proto = Object.getPrototypeOf(input);
	if (proto !== Object.prototype && proto !== null) fail();
	const keys = Object.keys(input);
	if (keys.length > 16 || Object.getOwnPropertySymbols(input).some((s) => Object.getOwnPropertyDescriptor(input, s)?.enumerable)) fail();
	const values = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!FIELD_KEY.test(key) || RESERVED.has(key) || !descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") fail();
		if (Buffer.byteLength(descriptor.value, "utf8") > 8192 || descriptor.value.includes("\0")) fail();
		values[key] = descriptor.value;
	}
	return values;
}
function sanitizeText(value, max = 512) {
	if (typeof value !== "string" || Array.from(value).length > max) fail("failed");
	return value.replace(FORBIDDEN_TEXT, "");
}
function buildPending(raw) {
	if (!Array.isArray(raw) || raw.length > 64) fail("failed");
	return raw.map((item) => {
		if (!isObject(item) || !PROPOSAL_ID.test(item.proposal_id ?? "") || !CONNECTOR_ID.test(item.connector_id ?? "") || RESERVED.has(item.connector_id)) fail("failed");
		if (typeof item.tool !== "string" || item.tool.length < 1 || item.tool.length > 128 || typeof item.arguments_truncated !== "boolean" || item.arguments_sensitive !== true || !DIGEST.test(item.digest ?? "") || !safeInt(item.expires_in_ms)) fail("failed");
		const tool = sanitizeText(item.tool, 128);
		const argumentsPreview = sanitizeText(item.arguments_preview);
		if (tool.length === 0) fail("failed");
		return {
			proposalId: item.proposal_id,
			connectorId: item.connector_id,
			tool,
			argumentsPreview,
			argumentsTruncated: item.arguments_truncated || argumentsPreview !== item.arguments_preview,
			argumentsSensitive: true,
			digest: item.digest,
			expiresInMs: item.expires_in_ms,
		};
	});
}

function buildState(raw) {
	if (!isObject(raw) || raw.protocol !== PROTOCOL || !safeInt(raw.pid, 1) || !safeInt(raw.startedAt) || !safeInt(raw.proxyPort, 1) || raw.proxyPort > 65535 || !safeInt(raw.connectors) || !safeInt(raw.pending) || typeof raw.failedClosed !== "boolean") fail("failed");
	// This is only the connector store's rollback-degraded flag; false says nothing about keyring or transport readiness.
	return { protocol: PROTOCOL, pid: raw.pid, startedAt: raw.startedAt, proxyPort: raw.proxyPort, connectors: raw.connectors, pending: raw.pending, failedClosed: raw.failedClosed };
}
function buildConnectorsReply(raw) {
	if (!isObject(raw) || raw.schema !== "abito-connectors/view/1") fail("failed");
	try {
		return { schema: raw.schema, catalog: raw.entries === undefined ? [] : buildCatalog(raw.entries), connectors: buildConnectors(raw.connectors) };
	} catch {
		fail("failed");
	}
}
function expectedFor(type) {
	if (type === "status") return "state";
	if (type === "connectors") return "connectors";
	if (type === "pending") return "pending";
	return "result";
}

/** Strict, FIFO JSONL client. Requests are exposed only through the validated methods below. */
class ConnectorHostClient extends EventEmitter {
	constructor(options) {
		super();
		privateClientState.set(this, {
			endpoint: options.endpoint,
			token: options.token,
			socketFactory: options.socketFactory ?? (() => net.createConnection(privateClientState.get(this).endpoint)),
			socket: undefined,
		});
		this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 3000;
		this.buffer = Buffer.alloc(0);
		this.pendingRequests = [];
		this.ready = false;
		this.closed = false;
		this.lastSeq = 0;
		this.handshakeTimer = undefined;
	}

	toJSON() { return { state: this.closed ? "closed" : this.ready ? "ready" : "connecting", pid: null, restarts: 0 }; }
	[util.inspect.custom]() { return this.toJSON(); }

	connectSocket() {
		const privateState = privateClientState.get(this);
		if (privateState.socket) return Promise.reject(new ConnectorHostError("unavailable"));
		return new Promise((resolve, reject) => {
			let socket;
			try { socket = privateState.socketFactory(); } catch { reject(new ConnectorHostError("unavailable")); return; }
			privateState.socket = socket;
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(this.handshakeTimer);
				if (error) reject(new ConnectorHostError("unavailable"));
				else resolve();
			};
			this.handshakeTimer = setTimeout(() => { socket.destroy(); finish(true); }, this.handshakeTimeoutMs);
			this.handshakeTimer.unref?.();
			socket.on("connect", () => {
				try { socket.write(`${JSON.stringify({ type: "hello", protocol: PROTOCOL, token: privateState.token })}\n`); }
				catch { finish(true); }
			});
			socket.on("data", (chunk) => {
				try {
					for (const frame of this.decode(chunk)) {
						if (!this.ready) {
							if (frame.type !== "ready" || frame.protocol !== PROTOCOL || frame.seq !== this.lastSeq + 1) throw new Error("invalid handshake");
							this.lastSeq = frame.seq;
							this.ready = true;
							finish();
						} else this.receive(frame);
					}
				} catch {
					finish(true);
					this.failAll("unavailable");
					socket.destroy();
				}
			});
			socket.on("error", () => { finish(true); this.failAll("unavailable"); });
			socket.on("close", () => {
				this.closed = true;
				if (!this.ready) finish(true);
				clearTimeout(this.handshakeTimer);
				this.failAll("unavailable");
				this.emit("close");
			});
		});
	}

	decode(chunk) {
		if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
		const frames = [];
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline === -1 ? chunk.length : newline;
			const part = chunk.subarray(offset, end);
			if (this.buffer.length + part.length > MAX_FRAME_BYTES) throw new Error("oversized");
			const line = this.buffer.length ? Buffer.concat([this.buffer, part]) : part;
			if (newline === -1) {
				this.buffer = Buffer.from(line);
				break;
			}
			this.buffer = Buffer.alloc(0);
			offset = newline + 1;
			if (line.length === 0) continue;
			const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
			const frame = JSON.parse(text);
			if (!isObject(frame)) throw new Error("not an object");
			frames.push(frame);
		}
		return frames;
	}

	receive(frame) {
		if (!Number.isSafeInteger(frame.seq) || frame.seq !== this.lastSeq + 1) throw new Error("invalid sequence");
		this.lastSeq = frame.seq;
		if (frame.type === "error") {
			const code = ERROR_CODES.has(frame.code) ? frame.code : "failed";
			const entry = this.pendingRequests.shift();
			if (entry) { clearTimeout(entry.timer); entry.reject(new ConnectorHostError(code)); }
			return;
		}
		if (frame.type === "connectors") {
			let built;
			try { built = buildConnectorsReply(frame); } catch { this.failAll("failed"); privateClientState.get(this).socket?.destroy(); return; }
			this.emit("connectors", built);
			this.resolveFrame("connectors", built);
			return;
		}
		if (frame.type === "pending") {
			let items;
			try { items = buildPending(frame.items); } catch { this.failAll("failed"); privateClientState.get(this).socket?.destroy(); return; }
			this.emit("pending", items);
			this.resolveFrame("pending", items);
			return;
		}
		if (frame.type === "state") {
			let state;
			try { state = buildState(frame); } catch { this.rejectNext("failed"); return; }
			this.resolveFrame("state", state);
			return;
		}
		if (frame.type === "result") {
			if (frame.ok !== true) return this.rejectNext("failed");
			this.resolveFrame("result", { ok: true });
			return;
		}
		// Unknown frames are not surfaced; if one occupies the FIFO reply position, fail it closed.
		if (this.pendingRequests.length) this.rejectNext("failed");
	}

	resolveFrame(type, value) {
		if (this.pendingRequests[0]?.expected !== type) return;
		const entry = this.pendingRequests.shift();
		clearTimeout(entry.timer);
		entry.resolve(value);
	}
	rejectNext(code) {
		const entry = this.pendingRequests.shift();
		if (!entry) return;
		clearTimeout(entry.timer);
		entry.reject(new ConnectorHostError(code));
	}
	failAll(code) {
		for (const entry of this.pendingRequests.splice(0)) {
			clearTimeout(entry.timer);
			entry.reject(new ConnectorHostError(code));
		}
	}

	#request(type, fields = {}) {
		const socket = privateClientState.get(this).socket;
		if (!this.ready || this.closed || !socket?.writable) return Promise.reject(new ConnectorHostError("unavailable"));
		let encoded;
		try {
			encoded = `${JSON.stringify({ type, ...fields })}\n`;
			if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES + 1) fail();
		} catch { return Promise.reject(new ConnectorHostError("bad_request")); }
		if (this.pendingRequests.length >= MAX_PENDING_REQUESTS) return Promise.reject(new ConnectorHostError("busy"));
		return new Promise((resolve, reject) => {
			let entry;
			const timer = setTimeout(() => {
				const index = this.pendingRequests.indexOf(entry);
				if (index === -1) return;
				this.pendingRequests.splice(index, 1);
				reject(new ConnectorHostError("unavailable"));
				this.closed = true;
				this.failAll("unavailable");
				privateClientState.get(this).socket?.destroy();
			}, this.requestTimeoutMs);
			timer.unref?.();
			entry = { expected: expectedFor(type), resolve, reject, timer };
			this.pendingRequests.push(entry);
			try { privateClientState.get(this).socket.write(encoded); }
			catch {
				this.closed = true;
				this.failAll("unavailable");
				privateClientState.get(this).socket?.destroy();
			}
			encoded = undefined;
		});
	}

	status() { return this.#request("status"); }
	connectors() { return this.#request("connectors"); }
	pendingItems() { return this.#request("pending"); }
	pending() { return this.pendingItems(); }
	subscribe(enabled) {
		if (typeof enabled !== "boolean") fail();
		return this.#request("subscribe", { enabled });
	}
	approve(proposalId, digest) {
		validateProposalId(proposalId);
		if (typeof digest !== "string" || !DIGEST.test(digest)) fail();
		return this.#request("approve", { proposal_id: proposalId, digest });
	}
	deny(proposalId) { validateProposalId(proposalId); return this.#request("deny", { proposal_id: proposalId }); }
	connect(id, revision, values) {
		validateId(id); validateRevision(revision);
		const clean = validateValues(values);
		return this.#request("connect", { id, revision, values: clean });
	}
	disconnect(id, revision) { validateId(id); validateRevision(revision); return this.#request("disconnect", { id, revision }); }
	setEnabled(id, enabled, revision) {
		validateId(id); validateRevision(revision);
		if (typeof enabled !== "boolean") fail();
		return this.#request("set_enabled", { id, enabled, revision });
	}
	setMode(id, mode, revision) {
		validateId(id); validateRevision(revision);
		if (!MODES.has(mode)) fail();
		return this.#request("set_mode", { id, mode, revision });
	}
	shutdown() { return this.#request("shutdown"); }
	close() {
		clearTimeout(this.handshakeTimer);
		this.failAll("unavailable");
		this.closed = true;
		const privateState = privateClientState.get(this);
		privateState.socket?.destroy();
		privateState.socket = undefined;
	}
}

module.exports = { ConnectorHostClient, ConnectorHostError, buildPending, buildState, validateValues };
