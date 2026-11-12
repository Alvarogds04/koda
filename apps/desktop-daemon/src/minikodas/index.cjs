"use strict";

/**
 * K2-13 Minikodas: the facade the daemon wires and the island server talks to. It combines the Minikoda
 * service (recipes, approve-to-create, runs, scheduler) with the «Hoy» inbox (results, proposals, PIN).
 * Events: "changed" (the Minikoda list changed), "hoy" (the «Hoy» list changed), "approved" (an approved
 * proposal was executed; in K2-13 «executed» = recorded in approved.jsonl, no real integration yet).
 */

const { EventEmitter } = require("node:events");
const path = require("node:path");
const { HoyInbox } = require("./hoy.cjs");
const { MinikodaService, MinikodaError } = require("./service.cjs");

class Minikodas extends EventEmitter {
	/** Same options as MinikodaService (minus `results`), plus `scrypt` (TEST-ONLY cheaper parameters). */
	constructor(options) {
		super();
		const { scrypt, ...rest } = options;
		this.inbox = new HoyInbox({ dir: path.join(options.islandRoot, "minikodas", "hoy"), now: options.now, log: options.log, ...(scrypt ? { scrypt } : {}) });
		this.service = new MinikodaService({ ...rest, results: this.inbox });
		this.service.on("changed", () => this.emit("changed"));
		this.service.on("run", () => this.emit("hoy"));
		this.service.on("missed", () => this.emit("hoy"));
		this.inbox.on("approved", (entry) => this.emit("approved", entry));
	}

	start() { this.service.start(); }
	stop() { return this.service.stop(); }
	list() { return this.service.list(); }
	get(id) { return this.service.get(id); }
	createDraft(recipe) { return this.service.createDraft(recipe); }
	approveCreate(id) { return this.service.approveCreate(id); }
	delete(id) { return this.service.delete(id); }
	launch(id) { return this.service.launch(id, { trigger: "manual" }); }
	/** #379 the global pause turned on: cancels every running Minikoda (failed runs, reason paused). */
	pause() { return this.service.cancelRuns("paused"); }
	hoyList() { return this.inbox.list(); }
	pinStatus() { return this.inbox.pinStatus(); }

	async approve(id, pin) {
		const out = await this.inbox.approve(id, pin);
		if (out.ok) this.emit("hoy");
		return out;
	}

	async reject(id) {
		const out = await this.inbox.reject(id);
		if (out.ok) this.emit("hoy");
		return out;
	}

	setPin(pin, old) { return this.inbox.setPin(pin, old); }
}

module.exports = { Minikodas, MinikodaError };
