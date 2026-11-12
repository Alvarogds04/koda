"use strict";

/**
 * K2-13 Minikodas (T4, S3/S5): the «Hoy» inbox with approve-later and the PIN.
 *
 * Store: `<island>/minikodas/hoy/` (0700), outside every Minikoda engine root.
 * - hoy.jsonl       one item per line, rewritten atomically (writePrivateFile, 0600).
 *                   Item {id, minikoda, kind: result|proposal|error, text, action?, target?, status, createdAt, decidedAt?}.
 *                   Proposals are created `pending`; result and error items are informational and are created
 *                   with status `approved` (nothing to decide). The list is built ONLY from this file: what the
 *                   daemon really stored, never what a Minikoda says it did.
 * - approved.jsonl  one line per executed approval. In K2-13 «executing» an approved proposal means exactly
 *                   this: the item is marked approved, this line is appended and an `approved` event is emitted.
 *                   Real buy/sell/send integrations do not exist yet.
 * - pin.json        {version, kdf: scrypt, N, r, p, salt, hash, failures, lockedUntil} — never the PIN in clear.
 *                   5 wrong PINs in a row lock approvals (and PIN changes) for 15 minutes; the counter and the lock
 *                   live in the same file, so a restart does not reset them. An unreadable pin.json counts as
 *                   locked (fail closed). Idea from Gentle Dot web-pin.ts (MIT).
 * Every mutation runs one at a time, so two approvals sent together cannot execute twice.
 */

const { EventEmitter } = require("node:events");
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { ensurePrivateDir, writePrivateFile } = require("../isolation.cjs");
const { PROPOSAL_ACTIONS } = require("./recipe.cjs");

const PIN_PATTERN = /^[0-9]{6,12}$/;
const PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60_000;
const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const HASH_BYTES = 32;
const MAX_ITEMS = 500;
const MAX_TEXT_CHARS = 8000;

const derive = (pin, salt, opts) => new Promise((resolve, reject) => scrypt(pin, salt, HASH_BYTES, opts, (e, k) => (e ? reject(e) : resolve(k))));
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
/** A proposal target is one plain line: Unicode format characters (Cf: bidi overrides, zero-width) go, breaks become spaces. */
const cleanTarget = (value) => String(value ?? "").replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim().slice(0, 200);

class HoyInbox extends EventEmitter {
	constructor({ dir, now = Date.now, log = () => {}, scrypt: scryptOptions = SCRYPT }) {
		super();
		this.dir = ensurePrivateDir(dir);
		this.file = path.join(this.dir, "hoy.jsonl");
		this.approvedFile = path.join(this.dir, "approved.jsonl");
		this.pinFile = path.join(this.dir, "pin.json");
		this.now = now;
		this.log = log;
		this.scrypt = scryptOptions;
		this.queue = Promise.resolve();
		if (!existsSync(this.file)) writePrivateFile(this.file, "");
		if (!existsSync(this.approvedFile)) writePrivateFile(this.approvedFile, "");
	}

	serial(run) {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** Every item from disk, newest last (the store is the truth). */
	list() {
		const items = [];
		for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
			try {
				items.push(JSON.parse(line));
			} catch {
				this.log("hoy: discarded a malformed line");
			}
		}
		return items;
	}

	get(id) {
		return this.list().find((i) => i.id === id);
	}

	save(items) {
		// Bounded: the oldest decided/informational items go first; a pending proposal is never dropped.
		let kept = items;
		while (kept.length > MAX_ITEMS) {
			const drop = kept.findIndex((i) => !(i.kind === "proposal" && i.status === "pending"));
			if (drop === -1) break;
			kept = [...kept.slice(0, drop), ...kept.slice(drop + 1)];
		}
		writePrivateFile(this.file, kept.map((i) => `${JSON.stringify(i)}\n`).join(""));
	}

	approvedEntries() {
		const out = [];
		for (const line of readFileSync(this.approvedFile, "utf8").split("\n").filter(Boolean)) {
			try {
				out.push(JSON.parse(line));
			} catch {
				this.log("hoy: discarded a malformed approved line");
			}
		}
		return out;
	}

	/**
	 * Lands one finished run: its result text plus each proposal the kit REALLY parked (already re-validated by
	 * the runner; re-checked here). Returns the added items.
	 */
	addRun({ minikoda, resultText, proposals = [] }) {
		return this.serial(async () => {
			const createdAt = new Date(this.now()).toISOString();
			const added = [{ id: randomUUID(), minikoda, kind: "result", text: clean(resultText, MAX_TEXT_CHARS), status: "approved", createdAt }, ...this.proposalItems(minikoda, proposals, createdAt)];
			this.save([...this.list(), ...added]);
			return added;
		});
	}

	proposalItems(minikoda, proposals, createdAt) {
		const items = [];
		for (const p of Array.isArray(proposals) ? proposals : []) {
			if (!PROPOSAL_ACTIONS.includes(p?.action)) continue;
			const target = cleanTarget(p.target);
			if (target === "") continue;
			items.push({ id: randomUUID(), minikoda, kind: "proposal", text: clean(p.text, MAX_TEXT_CHARS), action: p.action, target, status: "pending", createdAt });
		}
		return items;
	}

	/**
	 * Records a failed run (crash, timeout, start failure, cancel) or a missed scheduled run: never silent.
	 * S13 («3 si guardalo como pendiente, aunque avise al usuario que fallo»): the proposals the kit really parked
	 * before the failure are stored as pending too, next to the error item. Returns the added items.
	 */
	addError({ minikoda, text, proposals = [] }) {
		return this.serial(async () => {
			const createdAt = new Date(this.now()).toISOString();
			const added = [{ id: randomUUID(), minikoda, kind: "error", text: clean(text, 500), status: "approved", createdAt }, ...this.proposalItems(minikoda, proposals, createdAt)];
			this.save([...this.list(), ...added]);
			return added;
		});
	}

	// ----- PIN ---------------------------------------------------------------------------------

	loadPin() {
		if (!existsSync(this.pinFile)) return undefined;
		try {
			const s = JSON.parse(readFileSync(this.pinFile, "utf8"));
			if (s?.version !== 1 || typeof s.salt !== "string" || typeof s.hash !== "string" || !Number.isSafeInteger(s.failures) || !Number.isSafeInteger(s.lockedUntil)) return "damaged";
			return s;
		} catch {
			return "damaged";
		}
	}

	savePin(saved) {
		writePrivateFile(this.pinFile, `${JSON.stringify(saved)}\n`);
	}

	pinStatus() {
		const saved = this.loadPin();
		if (saved === undefined) return { set: false, locked: false };
		if (saved === "damaged") return { set: true, locked: true };
		const locked = saved.lockedUntil > this.now();
		return { set: true, locked, ...(locked ? { lockedUntil: saved.lockedUntil } : {}), left: PIN_ATTEMPTS - saved.failures };
	}

	async hash(pin) {
		const salt = randomBytes(16);
		const hash = await derive(pin, salt, this.scrypt);
		const { N, r, p } = this.scrypt;
		return { version: 1, kdf: "scrypt", N, r, p, salt: salt.toString("base64"), hash: hash.toString("base64"), failures: 0, lockedUntil: 0 };
	}

	/** Checks a PIN against the stored hash, counting failures and locking after PIN_ATTEMPTS. Call inside serial(). */
	async verifyPin(pin) {
		const saved = this.loadPin();
		if (saved === "damaged") return { ok: false, code: "pin_locked" };
		if (saved === undefined) return { ok: false, code: "pin_not_set" };
		if (saved.lockedUntil > this.now()) return { ok: false, code: "pin_locked" };
		const expected = Buffer.from(saved.hash, "base64");
		const valid = typeof pin === "string" && PIN_PATTERN.test(pin);
		const given = valid ? await derive(pin, Buffer.from(saved.salt, "base64"), { N: saved.N, r: saved.r, p: saved.p, maxmem: SCRYPT.maxmem }) : Buffer.alloc(expected.length);
		if (valid && given.length === expected.length && timingSafeEqual(given, expected)) {
			if (saved.failures !== 0 || saved.lockedUntil !== 0) this.savePin({ ...saved, failures: 0, lockedUntil: 0 });
			return { ok: true };
		}
		const failures = saved.failures + 1;
		if (failures >= PIN_ATTEMPTS) {
			this.savePin({ ...saved, failures: 0, lockedUntil: this.now() + PIN_LOCK_MS });
			return { ok: false, code: "pin_locked" };
		}
		this.savePin({ ...saved, failures, lockedUntil: 0 });
		return { ok: false, code: "pin_wrong", left: PIN_ATTEMPTS - failures };
	}

	/** Sets the PIN once. Changing it requires the current PIN (`old`), which counts toward the lock. */
	setPin(pin, old) {
		return this.serial(async () => {
			if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) return { ok: false, code: "pin_invalid" };
			if (this.loadPin() !== undefined) {
				if (old === undefined) return { ok: false, code: "pin_exists" };
				const check = await this.verifyPin(old);
				if (!check.ok) return check;
			} else if (old !== undefined) {
				return { ok: false, code: "pin_not_set" };
			}
			this.savePin(await this.hash(pin));
			return { ok: true };
		});
	}

	// ----- decisions ---------------------------------------------------------------------------

	/** Approves a pending proposal with the PIN; only then is it executed (K2-13: approved line + event). */
	approve(id, pin) {
		return this.serial(async () => {
			const items = this.list();
			const item = items.find((i) => i.id === id);
			if (!item || item.kind !== "proposal") return { ok: false, code: "unknown_item" };
			if (item.status !== "pending") return { ok: false, code: "not_pending" };
			const check = await this.verifyPin(pin);
			if (!check.ok) return check;
			item.status = "approved";
			item.decidedAt = new Date(this.now()).toISOString();
			// Persist the decision first: a crash between the two writes can lose an execution, never repeat one.
			this.save(items);
			const entry = { itemId: item.id, minikoda: item.minikoda, action: item.action, target: item.target, text: item.text, executedAt: item.decidedAt };
			appendFileSync(this.approvedFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
			this.emit("approved", { ...entry });
			return { ok: true, item: { ...item } };
		});
	}

	/** Rejects a pending proposal. No PIN: rejecting never executes anything. */
	reject(id) {
		return this.serial(async () => {
			const items = this.list();
			const item = items.find((i) => i.id === id);
			if (!item || item.kind !== "proposal") return { ok: false, code: "unknown_item" };
			if (item.status !== "pending") return { ok: false, code: "not_pending" };
			item.status = "rejected";
			item.decidedAt = new Date(this.now()).toISOString();
			this.save(items);
			return { ok: true, item: { ...item } };
		});
	}
}

module.exports = { HoyInbox, PIN_PATTERN, PIN_ATTEMPTS, PIN_LOCK_MS };
