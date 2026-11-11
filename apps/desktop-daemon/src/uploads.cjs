"use strict";

/**
 * K2-05 attachments (L11 2a: «any file, stored daemon-side in the engine workspace (uploads),
 * images sent to vision models»).
 *
 * Port of Gentle Dot's packages/daemon/src/uploads.ts (MIT, Copyright (c) 2026 Gentleman
 * Programming; see THIRD-PARTY-NOTICES.md): `sanitizeName`, `sniffMime`, the per-message limits
 * (25 MB per file, 50 MB and 10 files per message), the one-hour expiry of files never sent,
 * `composePrompt` (the `<attachments>` block the history's `splitAttachments` reads back) and
 * the «a sent file stays for the assistant, no other message can send it» rule.
 *
 * Koda differences (the transport is the authenticated island socket, not HTTP):
 * - a file arrives as `upload` frames (base64 chunks, in order) instead of `POST /upload`;
 * - every stored file gets its OWN opaque id `a-<16 hex>` issued by the daemon, owned by the
 *   client connection that uploaded it: only that client can send it, once, or discard it;
 * - the limits are a per-client QUOTA of files waiting to be sent (Gentle Dot's per-message
 *   numbers), so one client cannot fill the disk, and a client that goes away loses (and the
 *   daemon removes) whatever it never sent;
 * - an upload idle for two minutes is dropped (a crashed sender never holds its quota);
 * - files are opened with O_NOFOLLOW and re-checked by size when read back, the uploads folder
 *   must be a private directory (no planted link), names are the last segment only.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ensurePrivateDir } = require("./isolation.cjs");

/** Gentle Dot's ATTACHMENT_LIMITS (protocol index.ts): per file, per message (here: per client, unsent). */
const ATTACHMENT_LIMITS = Object.freeze({ fileBytes: 25 * 1024 * 1024, messageBytes: 50 * 1024 * 1024, files: 10 });
/** The longest image passed to the model: about 5 MB once base64-encoded, the strictest provider limit. */
const MAX_IMAGE_BYTES = 3_750_000;
/** The daemon's own opaque id of one stored file (and the name of its folder). */
const UPLOAD_ID = /^a-[0-9a-f]{16}$/;
const UNSENT_TTL_MS = 60 * 60 * 1000;
const IDLE_UPLOAD_MS = 2 * 60 * 1000;
const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION = 16;
const SNIFF_BYTES = 16;
/** Control characters, invisible and direction-changing marks. */
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * A safe file name: the last path segment only, without control or invisible characters,
 * a leading dot (hidden files), or a reserved name; "file" when nothing is left.
 */
function sanitizeName(raw) {
	let name = (String(raw ?? "").split(/[\\/]/).pop() ?? "").normalize("NFC").replace(HIDDEN_CHARS, "");
	name = name
		.replace(/[<>:"|?*]/g, "_")
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	let extension = path.extname(name);
	if (extension.length > MAX_EXTENSION) extension = "";
	let stem = name.slice(0, name.length - extension.length);
	if (stem === "" || RESERVED.test(stem)) stem = "file";
	return `${stem.slice(0, MAX_NAME_LENGTH - extension.length).trimEnd()}${extension}`;
}

/** The type of an image or PDF from its first bytes; anything else is `application/octet-stream`. */
function sniffMime(head) {
	const starts = (bytes, at = 0) => {
		const expected = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes);
		return head.length >= at + expected.length && head.subarray(at, at + expected.length).equals(expected);
	};
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts("GIF87a") || starts("GIF89a")) return "image/gif";
	if (starts("RIFF") && starts("WEBP", 8)) return "image/webp";
	if (starts("%PDF-")) return "application/pdf";
	return "application/octet-stream";
}

/**
 * Reads one stored file back as the engine would: never through a link (O_NOFOLLOW), and only
 * when it is still a regular file of the size that was stored. Throws otherwise.
 */
function readStored(file) {
	const fd = fs.openSync(file.path, fs.constants.O_RDONLY | NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size !== file.size) throw new Error("stored file changed");
		const out = Buffer.alloc(file.size);
		let at = 0;
		while (at < file.size) {
			const n = fs.readSync(fd, out, at, file.size - at, at);
			if (n === 0) throw new Error("stored file changed");
			at += n;
		}
		return out;
	} finally {
		fs.closeSync(fd);
	}
}

function removeQuietly(file) {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// already gone
	}
}

function removeDirQuietly(dir) {
	try {
		fs.rmdirSync(dir);
	} catch {
		// not empty or already gone
	}
}

/**
 * Files the user attaches, stored under `<workspace>/uploads/<id>/<name>` until a message sends
 * them, once. Nothing is opened or run. Every method is synchronous (one frame at a time).
 */
class UploadStore {
	/**
	 * @param {object} options
	 * @param {() => (string|undefined)} options.workspace the engine's workspace (read at every upload)
	 * @param {{fileBytes:number,messageBytes:number,files:number}} [options.limits]
	 * @param {number} [options.ttlMs] unsent files expire after this (default one hour)
	 * @param {number} [options.idleMs] an unfinished upload with no chunk for this long is dropped
	 * @param {() => number} [options.now]
	 * @param {(line: string) => void} [options.log]
	 */
	constructor(options) {
		this.workspace = options.workspace;
		this.limits = options.limits ?? ATTACHMENT_LIMITS;
		this.ttlMs = options.ttlMs ?? UNSENT_TTL_MS;
		this.idleMs = options.idleMs ?? IDLE_UPLOAD_MS;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		/** owner -> { files: Map<id, StoredFile & {createdAt}>, partial: Map<requestId, Partial> } */
		this.owners = new Map();
	}

	slot(owner) {
		let slot = this.owners.get(owner);
		if (!slot) {
			slot = { files: new Map(), partial: new Map() };
			this.owners.set(owner, slot);
		}
		return slot;
	}

	/** Bytes and files this owner holds unsent (finished files + the declared size of unfinished ones). */
	usage(slot) {
		let bytes = 0;
		for (const file of slot.files.values()) bytes += file.size;
		for (const part of slot.partial.values()) bytes += part.size;
		return { bytes, files: slot.files.size + slot.partial.size };
	}

	/**
	 * One chunk of one file. `requestId` names the upload (the client's own id), `size` is the
	 * declared whole size (the same on every chunk), `offset` where this chunk goes (chunks come in
	 * order). Returns `{ok:true, done:false}`, `{ok:true, done:true, file:{id,name,size,mime}}` on
	 * the last byte, or `{ok:false, code}`; a refused upload leaves nothing behind.
	 */
	receive(owner, { requestId, name, size, offset, data }) {
		this.prune();
		const slot = this.slot(owner);
		let part = slot.partial.get(requestId);
		if (!part) {
			if (offset !== 0) return { ok: false, code: "upload_failed" };
			if (size > this.limits.fileBytes) return { ok: false, code: "file_too_large" };
			const usage = this.usage(slot);
			if (usage.files >= this.limits.files) return { ok: false, code: "too_many_files" };
			if (usage.bytes + size > this.limits.messageBytes) return { ok: false, code: "message_too_large" };
			part = this.open(name, size);
			if (!part) return { ok: false, code: "upload_failed" };
			part.rawName = name;
			slot.partial.set(requestId, part);
		} else if (part.rawName !== name || part.size !== size || part.received !== offset) {
			this.abort(slot, requestId);
			return { ok: false, code: "bad_request" };
		}
		if (part.received + data.length > part.size) {
			this.abort(slot, requestId);
			return { ok: false, code: "bad_request" };
		}
		try {
			let at = 0;
			while (at < data.length) at += fs.writeSync(part.fd, data, at, data.length - at);
		} catch {
			this.abort(slot, requestId);
			return { ok: false, code: "upload_failed" };
		}
		part.received += data.length;
		part.lastAt = this.now();
		if (part.head.length < SNIFF_BYTES) part.head = Buffer.concat([part.head, data.subarray(0, SNIFF_BYTES)]).subarray(0, SNIFF_BYTES);
		if (part.received < part.size) return { ok: true, done: false };
		slot.partial.delete(requestId);
		try {
			fs.closeSync(part.fd);
		} catch {
			removeQuietly(part.path);
			removeDirQuietly(part.dir);
			return { ok: false, code: "upload_failed" };
		}
		const file = { id: part.id, name: part.name, size: part.size, mime: sniffMime(part.head), path: part.path, createdAt: part.createdAt };
		slot.files.set(file.id, file);
		return { ok: true, done: true, file: { id: file.id, name: file.name, size: file.size, mime: file.mime } };
	}

	/** Creates the private folder and the file of a new upload; undefined when it cannot. */
	open(rawName, size) {
		const workspace = this.workspace();
		if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return undefined;
		const id = `a-${crypto.randomBytes(8).toString("hex")}`;
		const name = sanitizeName(rawName);
		const root = path.join(workspace, "uploads");
		const dir = path.join(root, id);
		const file = path.join(dir, name);
		let fd;
		try {
			ensurePrivateDir(root);
			const stat = fs.lstatSync(root);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("uploads folder is not a directory");
			fs.mkdirSync(dir, { mode: 0o700 });
			fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
		} catch (error) {
			this.log(`uploads: could not store a file (${error?.code ?? "error"})`);
			removeDirQuietly(dir);
			return undefined;
		}
		const now = this.now();
		return { id, name, size, fd, path: file, dir, head: Buffer.alloc(0), received: 0, createdAt: now, lastAt: now };
	}

	abort(slot, requestId) {
		const part = slot.partial.get(requestId);
		if (!part) return;
		slot.partial.delete(requestId);
		try {
			fs.closeSync(part.fd);
		} catch {
			// already closed
		}
		removeQuietly(part.path);
		removeDirQuietly(part.dir);
	}

	/**
	 * The stored files a message names, checked against this owner and the per-message limits;
	 * nothing is used up. An id the owner did not upload, already sent, or named twice is refused.
	 */
	resolve(owner, ids) {
		this.prune();
		const slot = this.owners.get(owner);
		const files = [];
		const seen = new Set();
		for (const id of ids) {
			const file = slot?.files.get(id);
			if (!file || seen.has(id)) return { ok: false, code: "attachment_not_found" };
			seen.add(id);
			files.push({ id: file.id, name: file.name, size: file.size, mime: file.mime, path: file.path });
		}
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		if (files.length > this.limits.files || bytes > this.limits.messageBytes) return { ok: false, code: "message_too_large" };
		return { ok: true, files };
	}

	/** The files were sent: they stay on disk for the assistant, but no message can send them again. */
	consume(owner, ids) {
		const slot = this.owners.get(owner);
		if (!slot) return;
		for (const id of ids) slot.files.delete(id);
	}

	/** The user removed a file before sending it: it is deleted. Returns whether it was this owner's. */
	discard(owner, id) {
		const file = this.owners.get(owner)?.files.get(id);
		if (!file) return false;
		this.owners.get(owner).files.delete(id);
		removeQuietly(file.path);
		removeDirQuietly(path.dirname(file.path));
		return true;
	}

	/** The client went away: whatever it never sent (finished or not) is removed. */
	dropOwner(owner) {
		const slot = this.owners.get(owner);
		if (!slot) return;
		for (const requestId of [...slot.partial.keys()]) this.abort(slot, requestId);
		for (const id of [...slot.files.keys()]) this.discard(owner, id);
		this.owners.delete(owner);
	}

	/** Unsent files older than the TTL and uploads idle too long are removed (sent files are never here). */
	prune() {
		const now = this.now();
		for (const [owner, slot] of this.owners) {
			for (const [requestId, part] of slot.partial) if (now - part.lastAt > this.idleMs) this.abort(slot, requestId);
			for (const [id, file] of slot.files) if (now - file.createdAt > this.ttlMs) this.discard(owner, id);
			if (slot.files.size === 0 && slot.partial.size === 0) this.owners.delete(owner);
		}
	}
}

const INTRO = "The user attached these files, saved in your workspace. Read them with your tools when needed.";
const BLOCK_START = "<attachments>";
const BLOCK_END = "</attachments>";

/**
 * The prompt for a message with files (Gentle Dot composePrompt): the user's text, then a block
 * with each file's name, size, type and absolute path. Images go to the model as images only
 * when it accepts them (`images === true`), and only when they can be read back unchanged.
 */
function composePrompt(text, files, options = {}) {
	// default: read back as stored (no link, same size); a test may inject a path reader (Gentle Dot's shape)
	const read = (file) => (options.read ? options.read(file.path) : readStored(file));
	const images = [];
	const lines = files.map((file) => {
		const entry = { name: file.name, size: file.size, type: file.mime, path: file.path };
		if (IMAGE_TYPES.has(file.mime)) {
			if (file.size > MAX_IMAGE_BYTES) entry.image = "too large to show you; read it from the path if needed";
			else if (options.images === true) {
				let data;
				try {
					data = read(file).toString("base64");
				} catch {
					data = undefined;
				}
				if (data !== undefined) {
					images.push({ type: "image", mimeType: file.mime, data });
					entry.image = "attached to this message";
				} else entry.image = "saved, but it could not be read; read it from the path if needed";
			} else entry.image = "saved, but the current model cannot see images";
		}
		return JSON.stringify(entry);
	});
	const block = [BLOCK_START, INTRO, ...lines, BLOCK_END].join("\n");
	const message = text === "" ? block : `${text}\n\n${block}`;
	return images.length > 0 ? { message, images } : { message };
}

module.exports = {
	ATTACHMENT_LIMITS,
	MAX_IMAGE_BYTES,
	UPLOAD_ID,
	UploadStore,
	sanitizeName,
	sniffMime,
	readStored,
	composePrompt,
};
