"use strict";

/**
 * K2-13 Minikodas (T3/T4): the daemon-side service. Owns the recipe store, the approve-to-create step, the
 * launcher (manual and scheduled) and the per-Minikoda engine roots. Finished runs go to a results sink («Hoy»).
 *
 * Layout under the island root (every directory 0700, every file 0600):
 *   minikodas/recipes.json        {version: 1, minikodas: [{recipe, status: draft|active, createdAt, approvedAt?, firedAt?, lastRun?}]}
 *   minikodas/hoy/                «Hoy» store and approved log (hoy.cjs, wired by the daemon)
 *   minikodas/engines/<id>/       the Minikoda's OWN private engine root (HOME, agent dir, sessions, tmp, workspace)
 *   minikodas/sources/<id>.txt    default source content for the next run (until T1b brings Telegram reading)
 * The engine roots never contain the «Hoy» store or the daemon token, and the kit has no tool
 * that reads files, so a Minikoda cannot reach them through its kit. Same-uid processes can still read them
 * (known limit: running the agent as another OS user is K2-14 criterion 3).
 *
 * A Minikoda is created in two steps: `createDraft` stores a validated draft (status `draft`, never runs) and
 * only `approveCreate` makes it `active` (S1: «solo lo crea si lo apruebo»). Only active Minikodas launch or
 * get scheduled. One run per Minikoda at a time, at most `maxConcurrentRuns` overall; a failed run (crash,
 * timeout, start failure, model unavailable) lands in the results sink («Hoy») as an `error` item, never
 * silently. Results reach «Hoy» only through `options.results` ({addRun, addError}); the service never
 * builds «Hoy» from the model's text.
 */

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { lstatSync, readFileSync, rmSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const { ensurePrivateDir, islandPaths, writePrivateFile } = require("../isolation.cjs");
const { LIMITS, RecipeError, validateRecipe, recipeToJson } = require("./recipe.cjs");
const { resolveModelChoice, projectModel, chatModel } = require("./model.cjs");
const { runMinikoda, DEFAULT_RUN_TIMEOUT_MS } = require("./runner.cjs");
const { buildSummary } = require("./summary.cjs");
const { Scheduler } = require("./scheduler.cjs");
const { freshestCredential, isOauth, readRunCredential, writeBackCredential } = require("./credentials.cjs");

const MAX_MINIKODAS = 32;
const MAX_SOURCE_BYTES = 200_000;
const DEFAULT_MAX_CONCURRENT_RUNS = 2;
/**
 * S11/F-B: an OAuth session copied into a run must outlive the run, its engine's stop grace and a margin, so the
 * Minikoda's engine never refreshes it (the chat could be refreshing the same refresh token under its own lock).
 * The daemon has no refresh path of its own (the SDK helper only signs in and out), so a session closer to its
 * expiry is not copied: the run fails as model_unavailable and «Hoy» asks the user to renew it in the chat.
 */
const SESSION_MIN_LIFETIME_EXTRA_MS = 5 * 60_000 + 60_000;

class MinikodaError extends Error {
	constructor(code, message = code) {
		super(message);
		this.name = "MinikodaError";
		this.code = code;
	}
}

const slug = (name) => {
	const s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	return /^[a-z0-9]/.test(s) ? s : `minikoda${s ? `-${s}` : ""}`.slice(0, 32);
};

class MinikodaService extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} options.islandRoot
	 * @param {{listAccounts(): object[], models(provider, accountId): Promise<object[]>}} options.accounts
	 * @param {{list(): {profiles, active}}} [options.profiles]  the chat's profiles (default model)
	 * @param {string} options.accountsRoot
	 * @param {{agentDir: string, activeAccountPath: string}} [options.chat]  the chat engine's agent dir and active-account
	 *        marker: its live credential is read (freshest wins) and receives a Minikoda's refreshed OAuth token (S11)
	 * @param {number} [options.credentialLockWaitMs]
	 * @param {object} [options.engine]        {command, commandArgs, env, startTimeoutMs} for every Minikoda engine
	 * @param {(recipe) => string|Promise<string>} [options.source]  content of `reads.source` for a run
	 * @param {() => boolean} [options.isPaused]  #379 global pause: no launch while on
	 * @param {number} [options.minEveryMs]   smallest `when.everyMs` (tests lower it)
	 * @param {number} [options.runTimeoutMs]
	 * @param {number} [options.maxConcurrentRuns]
	 * @param {{addRun(run): Promise, addError(err): Promise}} options.results  where finished runs land («Hoy»)
	 */
	constructor(options) {
		super();
		this.options = options;
		this.log = options.log ?? (() => {});
		this.now = options.now ?? Date.now;
		this.dir = ensurePrivateDir(path.join(options.islandRoot, "minikodas"));
		this.file = path.join(this.dir, "recipes.json");
		this.enginesDir = ensurePrivateDir(path.join(this.dir, "engines"));
		this.sourcesDir = ensurePrivateDir(path.join(this.dir, "sources"));
		this.minEveryMs = options.minEveryMs ?? LIMITS.minEveryMs;
		this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
		this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
		this.isPaused = options.isPaused ?? (() => false);
		if (typeof options.results?.addRun !== "function" || typeof options.results?.addError !== "function") throw new Error("a results sink is required");
		this.results = options.results;
		this.running = new Map(); // id -> {runId, controller, promise}
		this.deleting = new Set(); // ids whose deletion is cancelling their run: never relaunched meanwhile
		this.queue = Promise.resolve();
		this.leftovers = Promise.resolve(); // settling of copies kept by an earlier daemon (start())
		this.stopped = false;
		this.scheduler = new Scheduler({
			launch: (id, meta) => this.launch(id, meta),
			markFired: (id) => this.markFired(id),
			isPaused: this.isPaused,
			onMissed: (e) => this.reportMissed(e),
			now: this.now,
			log: this.log,
		});
	}

	/** A one-time scheduled run that could not start when due: an error item in «Hoy», never silent. */
	reportMissed({ minikoda, reason }) {
		const entry = this.find(minikoda);
		const name = entry?.recipe.name ?? minikoda;
		this.results
			.addError({ minikoda, text: `La corrida programada de «${name}» no se hizo (${reason}) y no se repetirá.` })
			.then(() => this.emit("missed", { minikoda, reason }))
			.catch(() => this.log(`minikoda ${minikoda}: could not record the missed run`));
	}

	/**
	 * Arms the scheduler for every stored active Minikoda and settles (writes back, then removes) any credential
	 * copy an earlier daemon kept because its write-back failed (S11/F-C). Runs wait for that settling. Resolves
	 * when it is done; never rejects (a copy that still cannot be written back stays for the next try).
	 */
	start() {
		const entries = this.load().minikodas;
		this.leftovers = (async () => {
			for (const entry of entries) {
				try {
					await this.settleLeftover(entry.recipe);
				} catch {
					this.log(`minikoda ${entry.recipe.id}: could not settle its kept credential copy`);
				}
			}
		})();
		for (const entry of entries) if (entry.status === "active") this.scheduler.add(entry.recipe, { firedAt: entry.firedAt });
		return this.leftovers;
	}

	/** Writes back and removes a kept credential copy in a Minikoda's agent dir; false when it must stay. */
	async settleLeftover(recipe) {
		const agentDir = islandPaths(this.engineRoot(recipe.id)).agentDir;
		if (!(await this.settleRunCredential(recipe, agentDir, undefined))) return false;
		this.removeRunCredential(agentDir);
		return true;
	}

	/**
	 * #379 the global pause turned on: every run in flight is cancelled (failed run, reason `paused`, its
	 * parked proposals kept pending, S13). Resolves when they have landed.
	 */
	async cancelRuns(reason = "paused") {
		const runs = [...this.running.values()];
		for (const run of runs) run.controller.abort(reason);
		await Promise.all(runs.map((r) => r.promise.catch(() => {})));
	}

	/** Stops the timers, cancels runs in flight and waits for them to land (as failed runs). */
	async stop() {
		this.stopped = true;
		this.scheduler.stop();
		for (const run of this.running.values()) run.controller.abort();
		await Promise.all([...this.running.values()].map((r) => r.promise.catch(() => {})));
		await this.leftovers;
	}

	serial(fn) {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => {}, () => {});
		return run;
	}

	// ----- store -------------------------------------------------------------------------------

	/** The stored Minikodas; an entry that no longer validates is dropped (fail closed) and logged. */
	load() {
		let raw;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return { version: 1, minikodas: [] };
			throw error;
		}
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new MinikodaError("failed", "recipes.json is unreadable");
		}
		const minikodas = [];
		for (const entry of Array.isArray(data?.minikodas) ? data.minikodas : []) {
			try {
				const recipe = validateRecipe(entry?.recipe, { minEveryMs: this.minEveryMs });
				if (entry.status !== "draft" && entry.status !== "active") throw new Error("status");
				minikodas.push({ ...entry, recipe });
			} catch {
				this.log("minikodas: dropped an invalid stored recipe");
			}
		}
		return { version: 1, minikodas };
	}

	persist(state) {
		const doc = { version: 1, minikodas: state.minikodas.map((e) => ({ ...e, recipe: recipeToJson(e.recipe) })) };
		writePrivateFile(this.file, `${JSON.stringify(doc, null, 2)}\n`);
	}

	find(id) {
		return this.load().minikodas.find((e) => e.recipe.id === id);
	}

	dto(entry, { withPrompt = false } = {}) {
		const r = recipeToJson(entry.recipe);
		if (!withPrompt) delete r.prompt;
		return {
			...r,
			status: entry.status,
			createdAt: entry.createdAt,
			running: this.running.has(r.id),
			...(entry.status === "draft" ? { summary: this.summary(entry.recipe) } : {}),
			...(entry.lastRun ? { lastRun: { ...entry.lastRun } } : {}),
		};
	}

	/**
	 * The plain-language summary of a draft (S1/S7; summary.cjs): deterministic, built only from the validated
	 * recipe. The model section carries the account's VISIBLE label or «el mismo del chat» when the recipe kept
	 * the chat's current model; the accountId and every credential stay out of it.
	 */
	summary(recipe) {
		const chat = chatModel(this.options.profiles);
		const modelIsDefault =
			chat !== undefined &&
			chat.provider === recipe.model.provider &&
			chat.id === recipe.model.id &&
			chat.accountId === recipe.model.accountId;
		let accountLabel;
		try {
			accountLabel = this.options.accounts.listAccounts().find((a) => a.accountId === recipe.model.accountId)?.label;
		} catch {
			accountLabel = undefined; // no label: the summary falls back to provider/id, never to the accountId
		}
		return buildSummary(recipe, { accountLabel, modelIsDefault });
	}

	list() {
		return this.load().minikodas.map((e) => this.dto(e));
	}

	get(id) {
		const entry = this.find(id);
		if (!entry) throw new MinikodaError("unknown_minikoda");
		return this.dto(entry, { withPrompt: true });
	}

	// ----- create (two steps), delete --------------------------------------------------------------

	/**
	 * Stores a validated DRAFT. `id` defaults to a slug of the name; `model` defaults to the chat's current
	 * model; the model is validated against the accounts Koda already has. A draft never runs.
	 */
	async createDraft(raw) {
		let draft;
		try {
			draft = validateRecipe(raw, { draft: true, minEveryMs: this.minEveryMs, now: this.now() });
		} catch (error) {
			throw new MinikodaError("bad_request", error.message);
		}
		const model = await resolveModelChoice({
			choice: draft.model,
			listAccounts: () => this.options.accounts.listAccounts(),
			profiles: this.options.profiles,
			listModels: (provider, accountId) => this.options.accounts.models(provider, accountId),
			accountsRoot: this.options.accountsRoot,
		}).catch((error) => {
			throw new MinikodaError(error?.name === "ModelChoiceError" ? "model_unavailable" : "failed", error?.message);
		});
		return this.serial(async () => {
			const state = this.load();
			if (state.minikodas.length >= MAX_MINIKODAS) throw new MinikodaError("limit");
			let id = draft.id;
			if (id === undefined) {
				const base = slug(draft.name);
				id = base;
				for (let n = 2; state.minikodas.some((e) => e.recipe.id === id); n++) id = `${base}-${n}`;
			} else if (state.minikodas.some((e) => e.recipe.id === id)) {
				throw new MinikodaError("exists");
			}
			const recipe = validateRecipe({ ...recipeToJson({ ...draft, model }), id }, { minEveryMs: this.minEveryMs });
			const entry = { recipe, status: "draft", createdAt: new Date(this.now()).toISOString() };
			state.minikodas.push(entry);
			this.persist(state);
			this.emit("changed");
			return this.dto(entry, { withPrompt: true });
		});
	}

	/** The explicit approval that turns a draft into an active Minikoda (and arms its schedule). */
	approveCreate(id) {
		return this.serial(async () => {
			const state = this.load();
			const entry = state.minikodas.find((e) => e.recipe.id === id);
			if (!entry) throw new MinikodaError("unknown_minikoda");
			if (entry.status !== "draft") throw new MinikodaError("not_pending");
			if (entry.recipe.when.at !== undefined && Date.parse(entry.recipe.when.at) <= this.now()) throw new MinikodaError("bad_request", "when.at is in the past");
			entry.status = "active";
			entry.approvedAt = new Date(this.now()).toISOString();
			this.persist(state);
			if (!this.stopped) this.scheduler.add(entry.recipe);
			this.emit("changed");
			return this.dto(entry, { withPrompt: true });
		});
	}

	/**
	 * Deletes a Minikoda: unschedules it, cancels its run, removes its private engine root. «Hoy» items stay.
	 * The run is cancelled and awaited OUTSIDE serial(): its last step queues its own serial() write (lastRun),
	 * so awaiting it inside the queue would deadlock the store (and every later stop()). While the deletion is
	 * pending the Minikoda cannot be launched again. A credential copy kept in its root is written back first
	 * (S11/F-C); while that fails the deletion fails (`failed`) and the Minikoda, its schedule and its copy stay.
	 */
	async delete(id) {
		if (!this.find(id)) throw new MinikodaError("unknown_minikoda");
		this.deleting.add(id);
		try {
			this.scheduler.remove(id);
			const run = this.running.get(id);
			run?.controller.abort();
			await run?.promise.catch(() => {});
			return await this.serial(async () => this.deleteStored(id));
		} catch (error) {
			const entry = this.find(id);
			if (entry?.status === "active" && !this.stopped) this.scheduler.add(entry.recipe, { firedAt: entry.firedAt });
			throw error;
		} finally {
			this.deleting.delete(id);
		}
	}

	/** The store change and folder removal of delete(); runs inside serial(), after the run has landed. */
	async deleteStored(id) {
		await this.leftovers;
		const state = this.load();
		const entry = state.minikodas.find((e) => e.recipe.id === id);
		if (!entry) throw new MinikodaError("unknown_minikoda");
		if (!(await this.settleLeftover(entry.recipe))) throw new MinikodaError("failed", "the refreshed credential could not be written back yet");
		state.minikodas = state.minikodas.filter((e) => e.recipe.id !== id);
		this.persist(state);
		this.removeEngineRoot(id);
		this.emit("changed");
		return { id, deleted: true };
	}

	removeEngineRoot(id) {
		const root = this.engineRoot(id);
		try {
			const stats = lstatSync(root);
			if (!stats.isDirectory() || stats.isSymbolicLink()) return;
			rmSync(root, { recursive: true, force: true });
		} catch (error) {
			if (error.code !== "ENOENT") this.log(`minikoda ${id}: could not remove its engine root`);
		}
	}

	engineRoot(id) {
		const root = path.join(this.enginesDir, id);
		if (path.dirname(root) !== this.enginesDir) throw new MinikodaError("bad_request");
		return root;
	}

	markFired(id) {
		return this.serial(async () => {
			const state = this.load();
			const entry = state.minikodas.find((e) => e.recipe.id === id);
			if (!entry) return;
			entry.firedAt = new Date(this.now()).toISOString();
			this.persist(state);
		});
	}

	// ----- runs ----------------------------------------------------------------------------------

	async readSource(recipe) {
		if (this.options.source) return String((await this.options.source(recipe)) ?? "");
		const file = path.join(this.sourcesDir, `${recipe.id}.txt`);
		try {
			const stats = lstatSync(file);
			if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SOURCE_BYTES) return "";
			return readFileSync(file, "utf8");
		} catch {
			return "";
		}
	}

	/**
	 * Launches one run of an active Minikoda. Resolves {started: true, runId} at once (the run continues in the
	 * background) or {started: false, reason} when it is already running, the global cap is reached or the
	 * daemon is paused. Throws MinikodaError for an unknown or not-yet-approved Minikoda.
	 */
	async launch(id, { trigger = "manual" } = {}) {
		if (this.stopped) return { started: false, reason: "stopped" };
		const entry = this.find(id);
		if (!entry) throw new MinikodaError("unknown_minikoda");
		if (entry.status !== "active" || this.deleting.has(id)) throw new MinikodaError(entry.status !== "active" ? "not_active" : "unknown_minikoda");
		if (this.isPaused()) return { started: false, reason: "paused" };
		if (this.running.has(id)) return { started: false, reason: "running" };
		if (this.running.size >= this.maxConcurrentRuns) return { started: false, reason: "busy" };
		const runId = randomUUID();
		const controller = new AbortController();
		const record = { runId, controller, trigger };
		this.running.set(id, record);
		record.promise = this.execute(entry.recipe, runId, controller.signal).finally(() => {
			if (this.running.get(id) === record) this.running.delete(id);
			this.emit("changed");
		});
		record.promise.catch(() => {});
		this.emit("changed");
		return { started: true, runId };
	}

	/** Where a run's credential comes from and goes back to (S11). */
	credentialScope(recipe) {
		return {
			accountsRoot: this.options.accountsRoot,
			accountId: recipe.model.accountId,
			provider: recipe.model.provider,
			chat: this.options.chat,
			lockWaitMs: this.options.credentialLockWaitMs,
		};
	}

	/**
	 * S11 write-back: the Minikoda's copy, possibly refreshed (and its refresh token rotated) by its engine, goes
	 * back to the account and to the chat's live credential when it is fresher (credentials.cjs). `before` is
	 * what was copied in; undefined for a copy left by an earlier run whose write-back did not complete.
	 * Returns false when the write-back failed (the copy is then kept; it is retried before the next run, at the
	 * next daemon start and before a delete).
	 */
	async settleRunCredential(recipe, agentDir, before) {
		const after = readRunCredential(agentDir, recipe.model.provider);
		if (after === undefined) return true;
		try {
			await writeBackCredential({ ...this.credentialScope(recipe), before, after });
			return true;
		} catch {
			this.log(`minikoda ${recipe.id}: could not write the refreshed credential back (kept for the next run)`);
			return false;
		}
	}

	/** Removes the copied credential from a Minikoda's agent dir (never a symlink target). */
	removeRunCredential(agentDir) {
		const file = path.join(agentDir, "auth.json");
		try {
			const stats = lstatSync(file);
			if (stats.isFile() || stats.isSymbolicLink()) unlinkSync(file);
		} catch (error) {
			if (error.code !== "ENOENT") this.log("minikoda: could not remove the copied credential");
		}
	}

	async execute(recipe, runId, signal) {
		const account = () => this.options.accounts.listAccounts().find((a) => a.accountId === recipe.model.accountId);
		const agentDir = islandPaths(this.engineRoot(recipe.id)).agentDir;
		let copied;
		let result;
		let notice = "";
		await this.leftovers;
		try {
			const source = await this.readSource(recipe);
			result = await runMinikoda({
				recipe,
				root: this.engineRoot(recipe.id),
				runId,
				source,
				signal,
				timeoutMs: this.runTimeoutMs,
				engine: this.options.engine,
				log: this.log,
				prepareModel: async (dir) => {
					const a = account();
					if (!a || a.configured !== true) throw Object.assign(new Error("account unavailable"), { name: "ModelChoiceError" });
					// A copy an earlier run could not write back goes back first, so no rotated token is lost.
					if (!(await this.settleRunCredential(recipe, dir, undefined))) throw new Error("earlier credential not written back");
					this.removeRunCredential(dir);
					const fresh = await freshestCredential(this.credentialScope(recipe));
					if (!fresh) throw Object.assign(new Error("account not signed in"), { name: "ModelChoiceError" });
					if (isOauth(fresh) && fresh.expires < this.now() + this.runTimeoutMs + SESSION_MIN_LIFETIME_EXTRA_MS) {
						notice = `: la sesión de ${a.label || a.accountId} vence pronto; abrí el chat para renovarla`;
						throw Object.assign(new Error("session expires soon"), { name: "ModelChoiceError" });
					}
					let files;
					try {
						files = projectModel({ agentDir: dir, accountsRoot: this.options.accountsRoot, model: recipe.model, custom: a.custom === true, credential: fresh });
					} catch (error) {
						this.removeRunCredential(dir); // the copy step failed: the credential never stays behind
						throw error;
					}
					copied = fresh;
					// `-ne` turns off the auto-loaded agent extensions, so a custom gateway's guarded provider
					// extension is passed explicitly, exactly like the kit.
					return a.custom === true ? { extraExtensions: [files.extension] } : {};
				},
			});
		} catch {
			this.log(`minikoda ${recipe.id}: run failed before start`);
			result = { runId, minikoda: recipe.id, outcome: "failed", reason: "failed", proposals: [] };
		}
		// Every outcome (done, crash, timeout, cancel): the engine may have refreshed the token before it ended.
		// Written back first (S11), then the copy is removed; a copy that could not be written back stays so the
		// next run retries it (removing it would lose a rotated refresh token).
		if (copied !== undefined && (await this.settleRunCredential(recipe, agentDir, copied))) this.removeRunCredential(agentDir);
		if (result.outcome === "done") {
			await this.results.addRun({ minikoda: recipe.id, resultText: result.resultText, proposals: result.proposals });
		} else {
			// S13: what the kit really parked before the failure is kept pending, and «Hoy» says the run failed.
			const parked = result.proposals ?? [];
			await this.results.addError({
				minikoda: recipe.id,
				text: `La corrida de «${recipe.name}» falló (${result.reason})${notice}.${parked.length ? ` ${parked.length} propuesta(s) de esa corrida quedaron pendientes en «Hoy».` : ""}`,
				proposals: parked,
			});
		}
		await this.serial(async () => {
			const state = this.load();
			const entry = state.minikodas.find((e) => e.recipe.id === recipe.id);
			if (!entry) return;
			entry.lastRun = { runId, at: new Date(this.now()).toISOString(), outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) };
			this.persist(state);
		});
		this.emit("run", { minikoda: recipe.id, runId, outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
		return result;
	}
}

module.exports = { MinikodaService, MinikodaError, MAX_MINIKODAS, RecipeError };
