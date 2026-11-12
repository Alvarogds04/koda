"use strict";

/**
 * K2-13 Minikodas (T3): Koda's own timer. `everyMs` repeats, `at` fires once, `manual` never fires by itself.
 * Nobody presses anything: the timer calls `launch(id, {trigger: "time"})`. A Minikoda never overlaps itself:
 * the launcher refuses a second run while one is going, and the tick is counted as `skipped`, never queued.
 * `at` is persisted through `markFired` so a daemon restart never fires it twice. Timers longer than the
 * platform maximum (~24.8 days) are re-armed in steps.
 */

const { EventEmitter } = require("node:events");

const MAX_TIMER_MS = 2_147_483_647;

class Scheduler extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {(id:string, meta:{trigger:string, firedAt:string}) => Promise<{started:boolean}>} options.launch
	 * @param {(id:string) => void} [options.markFired]  persists that an `at` recipe fired
	 * @param {() => boolean} [options.isPaused]          #379 global pause: a tick while paused is skipped
	 */
	constructor({ launch, markFired = () => {}, isPaused = () => false, now = Date.now, log = () => {} }) {
		super();
		this.launch = launch;
		this.markFired = markFired;
		this.isPaused = isPaused;
		this.now = now;
		this.log = log;
		this.entries = new Map();
		this.stopped = false;
	}

	/** Arms a validated, active recipe. `firedAt` set means an `at` recipe already fired (never again). */
	add(recipe, { firedAt } = {}) {
		this.remove(recipe.id);
		if (this.stopped || recipe.when.manual) return;
		if (recipe.when.at !== undefined && firedAt) return;
		const entry = { recipe, timer: undefined, runs: 0, skipped: 0 };
		this.entries.set(recipe.id, entry);
		this.arm(entry, recipe.when.everyMs ?? Math.max(0, Date.parse(recipe.when.at) - this.now()));
	}

	remove(id) {
		const entry = this.entries.get(id);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.entries.delete(id);
	}

	arm(entry, delay) {
		if (this.stopped || this.entries.get(entry.recipe.id) !== entry) return;
		const step = Math.min(delay, MAX_TIMER_MS);
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			if (step < delay) return this.arm(entry, delay - step);
			this.fire(entry);
		}, step);
		entry.timer.unref?.();
	}

	fire(entry) {
		if (this.stopped || this.entries.get(entry.recipe.id) !== entry) return;
		const { id, when } = entry.recipe;
		const firedAt = new Date(this.now()).toISOString();
		if (when.at !== undefined) {
			this.entries.delete(id);
			try {
				this.markFired(id);
			} catch {
				this.log(`minikoda ${id}: could not persist the fired mark`);
			}
		} else {
			this.arm(entry, when.everyMs);
		}
		if (this.isPaused()) {
			entry.skipped += 1;
			this.emit("skipped", { minikoda: id, firedAt, reason: "paused" });
			return;
		}
		Promise.resolve()
			.then(() => this.launch(id, { trigger: "time", firedAt }))
			.then((out) => {
				if (out?.started === false) {
					entry.skipped += 1;
					this.emit("skipped", { minikoda: id, firedAt, reason: out.reason ?? "running" });
					this.log(`minikoda ${id}: tick skipped (${out.reason ?? "running"})`);
				} else {
					entry.runs += 1;
					this.emit("fired", { minikoda: id, firedAt });
				}
			})
			.catch(() => this.log(`minikoda ${id}: scheduled launch failed`));
	}

	stats(id) {
		const e = this.entries.get(id);
		return e && { runs: e.runs, skipped: e.skipped };
	}

	stop() {
		this.stopped = true;
		for (const e of this.entries.values()) clearTimeout(e.timer);
		this.entries.clear();
	}
}

module.exports = { Scheduler, MAX_TIMER_MS };
