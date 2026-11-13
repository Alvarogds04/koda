"use strict";

/**
 * K2-13 Minikodas (T4, S3/S5): the «Hoy» inbox with approve-later.
 *
 * Store: `<island>/minikodas/hoy/` (0700), outside every Minikoda engine root.
 * - hoy.jsonl       one item per line, rewritten atomically (writePrivateFile, 0600).
 *                   Item {id, minikoda, kind: result|proposal|error, text, action?, target?, status, createdAt, decidedAt?}
 *                   plus, on a result, `provenance` (S19: where the text came from — YouTube's own subtitles, Parakeet on
 *                   this PC or the user's account; a closed list shared with `protocol.cjs`, and an unknown value is
 *                   dropped instead of stored, because the frame would refuse it).
 *                   Proposals are created `pending`; result and error items are informational and are created
 *                   with status `approved` (nothing to decide). The list is built ONLY from this file: what the
 *                   daemon really stored, never what a Minikoda says it did.
 * - approved.jsonl  one line per executed approval. In K2-13 «executing» an approved proposal means exactly
 *                   this: the item is marked approved, this line is appended and an `approved` event is emitted.
 *                   Real buy/sell/send integrations do not exist yet.
 * Approval needs no PIN (human decision L17, criterion 3 rewritten): the human approves from «Hoy» in the island
 * or Kenai, over the authenticated session. Every mutation runs one at a time, so two approvals sent together
 * cannot execute twice; the decision is persisted before the execution record.
 */

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { ensurePrivateDir, writePrivateFile } = require("../isolation.cjs");
const { HOY_PROVENANCE } = require("../protocol.cjs");
const { PROPOSAL_ACTIONS } = require("./recipe.cjs");

const MAX_ITEMS = 500;
const MAX_TEXT_CHARS = 8000;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
/** A proposal target is one plain line: Unicode format characters (Cf: bidi overrides, zero-width) go, breaks become spaces. */
const cleanTarget = (value) => String(value ?? "").replace(/\p{Cf}/gu, "").replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim().slice(0, 200);

class HoyInbox extends EventEmitter {
	constructor({ dir, now = Date.now, log = () => {} }) {
		super();
		this.dir = ensurePrivateDir(dir);
		this.file = path.join(this.dir, "hoy.jsonl");
		this.approvedFile = path.join(this.dir, "approved.jsonl");
		this.now = now;
		this.log = log;
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
	 * the runner; re-checked here). `provenance` (S19) is where that text came from, when the service could tell: it is
	 * one of the closed values, and anything else is dropped and logged rather than stored (a stored unknown value would
	 * make the whole `hoy` frame invalid). Returns the added items.
	 */
	addRun({ minikoda, resultText, proposals = [], provenance }) {
		return this.serial(async () => {
			const createdAt = new Date(this.now()).toISOString();
			const item = { id: randomUUID(), minikoda, kind: "result", text: clean(resultText, MAX_TEXT_CHARS), status: "approved", createdAt };
			if (provenance !== undefined) {
				if (HOY_PROVENANCE.includes(provenance)) item.provenance = provenance;
				else this.log("hoy: discarded an unknown provenance");
			}
			const added = [item, ...this.proposalItems(minikoda, proposals, createdAt)];
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

	// ----- decisions ---------------------------------------------------------------------------

	/** Approves a pending proposal; only then is it executed (K2-13: approved line + event). No PIN (L17). */
	approve(id) {
		return this.serial(async () => {
			const items = this.list();
			const item = items.find((i) => i.id === id);
			if (!item || item.kind !== "proposal") return { ok: false, code: "unknown_item" };
			if (item.status !== "pending") return { ok: false, code: "not_pending" };
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

	/** Rejects a pending proposal. Rejecting never executes anything. */
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

module.exports = { HoyInbox };
