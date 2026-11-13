"use strict";

/**
 * K2-13 Minikodas (T3/T4): the daemon-side service. Owns the recipe store, the approve-to-create step, the
 * launcher (manual and scheduled) and the per-Minikoda engine roots. Finished runs go to a results sink («Hoy»).
 *
 * Layout under the island root (every directory 0700, every file 0600):
 *   minikodas/recipes.json        {version: 1, minikodas: [{recipe, status: draft|active, createdAt, approvedAt?, firedAt?, lastRun?}]}
 *   minikodas/hoy/                «Hoy» store and approved log (hoy.cjs, wired by the daemon)
 *   minikodas/engines/<id>/       the Minikoda's OWN private engine root (HOME, agent dir, sessions, tmp, workspace)
 *   minikodas/sources/<id>.txt    default source content for the next run (a plain-text source)
 *   minikodas/telegram/<id>.json  the cached channel {channel, lastSeenId} of a Telegram source (0600)
 *   minikodas/media/<runId>/      the media a source downloaded for ONE run (videos/audios, S6); removed after the run
 *   minikodas/transcribe/<uuid>/  the transcriber's work files (transcribe.cjs); removed after each transcription
 *   minikodas/youtube/<uuid>/     the work files of a run's YouTube links (youtube.cjs, S19); removed after the run
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
 *
 * S6 («el canal publica ambos»: video posts are transcribed first): a source may return `{text, media: [files]}`
 * instead of a string. Every media file must be a regular file inside the run's own media folder; each one is
 * transcribed (options.transcriber, transcribe.cjs) and deleted, and its transcript is appended to the source the
 * Minikoda reads. A transcription failure ends the run before its engine starts: a «Hoy» error item that says why.
 * Cancelling the run (pause, delete, daemon stop) cancels the transcription too.
 * A Telegram channel read (`telegram:@canal`) hands its media to the same transcriber through the source's own
 * `transcribe` callback: each transcript sits right after the post it belongs to (post id and date only, never a file
 * name), and a media that cannot be transcribed is a short Spanish note for that post PLUS a «Hoy» error item — one bad
 * media never loses the other posts and never fails the run. Only a cancelled run or the 30-minute budget ends it.
 *
 * S17: transcription has its OWN budget (`TRANSCRIPTION_BUDGET_MS`, 30 min) and never counts toward the run's engine
 * budget (`runTimeoutMs`, 300 s). That clock starts only when `runMinikoda` starts the engine, i.e. AFTER the source
 * and its transcripts are ready; a 40-minute video cannot eat the engine's time. A run slot IS held while a video is
 * transcribed: a transcribing run counts against `maxConcurrentRuns` (2) exactly like a running one. When the
 * transcription budget runs out, the helper/ffmpeg/remote request is killed, the temp media is deleted by the existing
 * cleanup, the engine never starts and «Hoy» gets an error item saying the video was too long to transcribe in time.
 */

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const { ensurePrivateDir, islandPaths, writePrivateFile } = require("../isolation.cjs");
const { LIMITS, RecipeError, validateRecipe, recipeToJson } = require("./recipe.cjs");
const { resolveModelChoice, projectModel, chatModel } = require("./model.cjs");
const { runMinikoda, DEFAULT_RUN_TIMEOUT_MS } = require("./runner.cjs");
const { buildSummary } = require("./summary.cjs");
const { Scheduler } = require("./scheduler.cjs");
const { freshestCredential, isOauth, readRunCredential, writeBackCredential } = require("./credentials.cjs");
const { TranscriptionError, removeWorkDir, TRANSCRIPTION_BUDGET_MS } = require("./transcribe.cjs");
const { YouTubeError, MAX_LINKS_PER_RUN } = require("./youtube.cjs");
const { TelegramSource, TelegramError, parseSource } = require("./telegram-source.cjs");

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

const MAX_MEDIA_PER_RUN = 20;
/** A transcript with no text (silence, music): the post says so instead of carrying an empty transcript. */
const NO_SPEECH = "no se reconoció voz en el audio";

/**
 * S19 / F4: how much of a run's text came from each place. The three closed provenance values are counted, plus `own`:
 * the text the run's source already carried (the channel's posts, the plain-text file), which is none of the three and
 * therefore competes with them for dominance.
 */
function newSourceCounts() {
	return { own: 0, youtube_subtitles: 0, local_transcription: 0, remote_transcription: 0 };
}

/** The provenance bucket a transcription's setting belongs to: the user's account, or this PC. */
const transcriptionBucket = (mode) => (mode === "remote" ? "remote_transcription" : "local_transcription");

/**
 * THE PROVENANCE RULE. A result carries the closed value whose source contributed the MOST characters of the text the
 * Minikoda read — but only when that value is STRICTLY the biggest. A tie between the three (or with `own`), `own` on
 * top (the channel's own words, or the plain-text file, dominating) or nothing marked at all means the daemon cannot
 * say where the result came from, and the item carries no `provenance` at all: the island then draws no chip, instead
 * of one that would be a guess. Counted per phase, before the 200 000-char cap of the source text.
 */
function dominantProvenance(counts) {
	const marked = [["youtube_subtitles", counts?.youtube_subtitles ?? 0], ["local_transcription", counts?.local_transcription ?? 0], ["remote_transcription", counts?.remote_transcription ?? 0]];
	const best = Math.max(counts?.own ?? 0, ...marked.map(([, n]) => n));
	if (best <= 0 || (counts?.own ?? 0) === best) return undefined;
	const leaders = marked.filter(([, n]) => n === best);
	return leaders.length === 1 ? leaders[0][0] : undefined;
}

/** A run that ended in its transcription phase (never reaches the engine). */
class TranscriptionPhaseError extends Error {
	constructor(reason, detail) {
		super(`transcription phase: ${reason}`);
		this.reason = reason;
		this.detail = detail;
	}
}

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
	 * @param {(recipe, {mediaDir, runId, signal}) => string|{text, media?: string[]}|Promise<…>} [options.source]
	 *        content of `reads.source` for a run; media files (inside `mediaDir`) are transcribed first (S6)
	 * @param {{transcribe(file, {signal, deleteMedia, deadline}): Promise<{text}>}} [options.transcriber]  transcribe.cjs
	 * @param {{read(text, {signal}): Promise<{text, skipped, failures}>}} [options.youtube]  youtube.cjs (S19)
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
		this.mediaDir = ensurePrivateDir(path.join(this.dir, "media"));
		// K2-13 (S6, S10): a `telegram:@canal` source reads the channel with the user's account. Built only when the daemon
		// has a session, and every run's media land in the same private `media/<runId>` folder the transcriber reads.
		this.telegramSource = options.telegram
			? new TelegramSource({
				stateDir: path.join(this.dir, "telegram"),
				mediaRoot: this.mediaDir,
				// The live client, or undefined when no account is connected. NOT `connectedClient?.() ?? connectedClient`:
				// that handed the source the method itself whenever the call yielded undefined, so a daemon with no
				// session failed the run with «Telegram no respondió» instead of «no hay ninguna cuenta conectada».
				getClient: () => options.telegram.connectedClient(),
				log: (line) => this.log(line),
			})
			: undefined;
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
	 * Sweeps what a killed run or daemon left behind, arms the scheduler for every stored active Minikoda and settles (writes back, then removes) any credential
	 * copy an earlier daemon kept because its write-back failed (S11/F-C). Runs wait for that settling. Resolves
	 * when it is done; never rejects (a copy that still cannot be written back stays for the next try).
	 */
	start() {
		this.sweepWorkDirs();
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
	 * K2-13 (S6, S9, S19): removes whatever a previous daemon left in its three private work folders — a killed run's
	 * media, a transcription's work files, a YouTube read's downloads. Only inside `minikodas/media`,
	 * `minikodas/transcribe` and `minikodas/youtube`, and every entry is
	 * `lstat`ed, so a symlink is removed as a link and its target is never followed. The two folders themselves are
	 * `lstat`ed too: a work folder that is not a real directory (a link, a file, a junction) is skipped, never read
	 * through. Both listings are taken before the FIRST await, so a run that starts while the sweep is removing what a
	 * previous daemon left keeps its own work folder. A failure is logged instead of stopping the service.
	 */
	sweepWorkDirs() {
		const listings = [this.mediaDir, path.join(this.dir, "transcribe"), path.join(this.dir, "youtube")].map((dir) => {
			try {
				if (!lstatSync(dir).isDirectory()) {
					this.log(`minikodas: ${path.basename(dir)} is not a folder of ours any more, left alone`);
					return undefined;
				}
				return { dir, names: readdirSync(dir) };
			} catch (error) {
				if (error.code !== "ENOENT") this.log(`minikodas: could not list ${path.basename(dir)} (${error.code})`);
				return undefined;
			}
		});
		const sweep = async () => {
			for (const listing of listings) {
				if (!listing) continue;
				for (const name of listing.names) {
					const entry = path.join(listing.dir, name);
					try {
						if (lstatSync(entry).isDirectory()) await removeWorkDir(entry, { log: this.log });
						else unlinkSync(entry); // a file or a symlink: the link goes, its target is never touched
					} catch (error) {
						if (error.code !== "ENOENT") this.log(`minikodas: could not sweep ${path.basename(listing.dir)} (${error.code ?? "error"})`);
					}
				}
			}
		};
		// Best effort and off the caller's path: `start()` stays synchronous, and the listings above are already taken.
		sweep().catch(() => this.log("minikodas: the work-folder sweep failed"));
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
		this.telegramSource?.forget(id);
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

	/**
	 * K2-13 (S6): what this run reads. An injected `options.source` (tests, embedding) gets a private `mediaDir` of its
	 * own and its media are transcribed before the engine starts; a `telegram:` descriptor resolves the channel with
	 * the user's account and downloads its new posts; anything else keeps the `sources/<id>.txt` behaviour. Returns
	 * `{text, media, commit?}`: `commit()` is the only thing that moves the last-seen marker, and `execute()` calls it
	 * only when the run succeeded.
	 */
	async prepareSource(recipe, runId, signal) {
		const counts = newSourceCounts();
		if (this.options.source) {
			let text;
			const mediaDir = ensurePrivateDir(path.join(this.mediaDir, runId ?? randomUUID()));
			try {
				const got = await this.options.source(recipe, { mediaDir, runId, signal });
				text = String(got !== null && typeof got === "object" ? got.text ?? "" : got ?? "");
				counts.own = text.length;
				if (got !== null && typeof got === "object") text = await this.withTranscripts(text, Array.isArray(got.media) ? got.media : [], mediaDir, signal, counts);
			} finally {
				await removeWorkDir(mediaDir, { log: this.log }); // retried, never throws: the run's own error stands
			}
			const withYouTube = await this.withYouTube(recipe, text, { signal, counts });
			return { text: withYouTube, media: [], provenance: dominantProvenance(counts) };
		}
		const parsed = parseSource(recipe.reads.source);
		if (parsed !== undefined && parsed.type === "telegram") {
			if (!this.telegramSource) throw new TelegramError("telegram_unavailable");
			// S6/S17: every media of the read is transcribed under ONE 30-minute budget, before the engine starts. The
			// source translates the result into the run's text (its own post keeps its transcript or its note).
			const deadline = Date.now() + TRANSCRIPTION_BUDGET_MS;
			const got = await this.telegramSource.prepare({
				recipe,
				runId,
				signal,
				transcribe: (entry) => this.transcribePostMedia(recipe, entry, { signal, deadline, counts }),
			});
			counts.own = Number.isSafeInteger(got.ownChars) ? got.ownChars : 0;
			// S19: the posts' YouTube links are read like any other source text.
			const withYouTube = await this.withYouTube(recipe, got.text, { signal, counts });
			return { ...got, text: withYouTube, provenance: dominantProvenance(counts) };
		}
		if (parsed === undefined) {
			// A malformed `telegram:` descriptor is refused whenever this daemon can really read Telegram (a typo must
			// never read an empty text file instead of the channel). A daemon embedded without a Telegram session only
			// knows plain-text sources, and reads `sources/<id>.txt` as it always did.
			if (this.telegramSource) throw new TelegramError("telegram_channel_invalid");
			this.log(`minikoda ${recipe.id}: the source descriptor is not a Telegram channel (reading the text source)`);
		}
		const text = this.readTextSource(recipe);
		counts.own = text.length;
		const withYouTube = await this.withYouTube(recipe, text, { signal, counts });
		return { text: withYouTube, media: [], provenance: dominantProvenance(counts) };
	}

	/** The plain-text source of a run: `sources/<id>.txt`, bounded, and never through a link or a folder. */
	readTextSource(recipe) {
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
	 * S6: transcribes every media file of the run (in order) and appends the transcripts to the source text. A file
	 * outside the run's own media folder is refused and never touched. Throws TranscriptionPhaseError. The whole batch
	 * shares ONE 30-minute budget (S17), exactly like a channel read's media.
	 */
	async withTranscripts(text, media, mediaDir, signal, counts) {
		if (media.length === 0) return text;
		const failed = (error) => {
			if (signal?.aborted || error?.code === "cancelled") throw new TranscriptionPhaseError(signal?.reason === "paused" ? "paused" : "cancelled");
			throw new TranscriptionPhaseError("transcription", error instanceof TranscriptionError ? error.userText : new TranscriptionError("failed").userText);
		};
		if (media.length > MAX_MEDIA_PER_RUN) failed(new TranscriptionError("too_long"));
		const inside = (file) => typeof file === "string" && path.isAbsolute(file) && path.dirname(path.resolve(file)) === mediaDir;
		if (!media.every(inside)) failed(new TranscriptionError("bad_media"));
		if (!this.options.transcriber) failed(new TranscriptionError("ffmpeg_unavailable"));
		const deadline = Date.now() + TRANSCRIPTION_BUDGET_MS;
		const parts = [text];
		for (const [i, file] of media.entries()) {
			let out;
			try {
				out = await this.options.transcriber.transcribe(file, { signal, deleteMedia: true, deadline });
			} catch (error) {
				failed(error);
			}
			parts.push(`\n[Transcripción automática (${i + 1} de ${media.length}) del video o audio del post]\n${out.text}`);
			if (counts) counts[transcriptionBucket(out?.mode)] += String(out?.text ?? "").length;
		}
		const joined = parts.join("\n");
		return joined.length > MAX_SOURCE_BYTES ? joined.slice(0, MAX_SOURCE_BYTES) : joined;
	}

	/**
	 * S6/S17: ONE media file of a Telegram post, transcribed for the run's text. Resolves `{text}` with the transcript or
	 * `{note}` with a short Spanish sentence for that post — a media that cannot be transcribed (too long, unreadable,
	 * no ffmpeg, no voice) is a «Hoy» error item and a note, never a silent drop and never a failed run. Two things DO
	 * end the run: a cancellation (pause, delete, daemon stop) and the transcription budget (S17), exactly like any other
	 * transcription phase. The file is deleted by `transcribe` whatever the outcome; the run's folder goes in `execute()`.
	 */
	async transcribePostMedia(recipe, entry, { signal, deadline, counts }) {
		const name = recipe.name;
		const note = async (userText) => {
			this.log(`minikoda ${recipe.id}: a media of the channel could not be transcribed`);
			try {
				await this.results.addError({ minikoda: recipe.id, text: `La corrida de «${name}» no pudo transcribir un video o audio del canal (${userText}).` });
			} catch {
				this.log(`minikoda ${recipe.id}: could not record a transcription notice in «Hoy»`);
			}
			return { note: userText };
		};
		if (!this.options.transcriber) return note(new TranscriptionError("ffmpeg_unavailable").userText);
		let out;
		try {
			out = await this.options.transcriber.transcribe(entry.path, { signal, deleteMedia: true, deadline });
		} catch (error) {
			if (signal?.aborted || error?.code === "cancelled") throw new TranscriptionPhaseError(signal?.reason === "paused" ? "paused" : "cancelled");
			if (error?.code === "budget_exceeded") throw new TranscriptionPhaseError("transcription", new TranscriptionError("budget_exceeded").userText);
			return note(error instanceof TranscriptionError ? error.userText : new TranscriptionError("failed").userText);
		}
		const transcript = String(out?.text ?? "").trim();
		// An empty transcript (silence, music, a language the model does not know) says nothing to the Minikoda: say so.
		if (transcript === "") return note(NO_SPEECH);
		if (counts) counts[transcriptionBucket(out?.mode)] += transcript.length;
		return { text: transcript };
	}

	/**
	 * S19: the YouTube video links of the source are read from YouTube (subtitles first, else audio + transcription)
	 * and appended behind their markers. One failed video is a «Hoy» `error` item in Spanish and the run goes on; more
	 * videos than the cap is also said there. A cancelled run or an exhausted transcription budget ends the run
	 * (S17), exactly like a failing transcription. Without a wired reader (tests, a checkout with no daemon) the text
	 * is returned untouched.
	 */
	async withYouTube(recipe, text, { signal, counts } = {}) {
		if (!this.options.youtube) return text;
		let out;
		try {
			out = await this.options.youtube.read(text, { signal });
		} catch (error) {
			if (error instanceof YouTubeError) {
				if (error.code === "cancelled") throw new TranscriptionPhaseError(signal?.reason === "paused" ? "paused" : "cancelled");
				if (error.code === "budget_exceeded") throw new TranscriptionPhaseError("transcription", error.userText);
			}
			throw error;
		}
		const name = recipe.name;
		const landed = async (line) => {
			try {
				await this.results.addError({ minikoda: recipe.id, text: line });
			} catch {
				this.log(`minikoda ${recipe.id}: could not record a YouTube notice in «Hoy»`);
			}
		};
		for (const failure of out.failures ?? []) await landed(`La corrida de «${name}» no pudo leer un video de YouTube (${failure.userText}).`);
		if (out.skipped > 0) {
			await landed(`La corrida de «${name}» leyó como mucho ${MAX_LINKS_PER_RUN} videos de YouTube: ${out.skipped} video(s) más del post quedaron sin leer.`);
		}
		if (counts && out.sources) for (const key of ["youtube_subtitles", "local_transcription", "remote_transcription"]) counts[key] += Number(out.sources[key]) || 0;
		const joined = String(out.text ?? "");
		return joined.length > MAX_SOURCE_BYTES ? joined.slice(0, MAX_SOURCE_BYTES) : joined;
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

	/**
	 * One run, from its source to «Hoy». The media the source downloaded for this run are removed when it ends, whatever
	 * the outcome (done, engine failure, timeout, cancel): nothing reads them after the run on this branch, and the
	 * transcription step (feat/k2-13-transcribe) will consume `source.media` before this point once merged.
	 */
	async execute(recipe, runId, signal) {
		try {
			return await this.executeRun(recipe, runId, signal);
		} finally {
			this.telegramSource?.removeRun(runId);
		}
	}

	async executeRun(recipe, runId, signal) {
		const account = () => this.options.accounts.listAccounts().find((a) => a.accountId === recipe.model.accountId);
		const agentDir = islandPaths(this.engineRoot(recipe.id)).agentDir;
		let copied;
		let result;
		let notice = "";
		await this.leftovers;
		let source = { text: "", media: [], provenance: undefined };
		try {
			try {
				source = await this.prepareSource(recipe, runId, signal);
			} catch (error) {
				if (error instanceof TranscriptionPhaseError) {
					// S17: the run ended in its transcription phase and never reaches the engine.
					this.log(`minikoda ${recipe.id}: transcription phase ended (${error.reason})`);
					result = { runId, minikoda: recipe.id, outcome: "failed", reason: error.reason, ...(error.detail ? { detail: error.detail } : {}), proposals: [] };
				} else {
					// S6: a channel that cannot be read is a failed run with its Spanish reason in «Hoy», never a silent skip.
					this.log(`minikoda ${recipe.id}: run failed before start (source)`);
					result = { runId, minikoda: recipe.id, outcome: "failed", reason: "source", proposals: [] };
					// The Spanish sentence ends with its own full stop; «Hoy» adds the sentence's, so drop the duplicate.
					const sentence = typeof error?.notice === "string" && error.notice !== "" ? error.notice.replace(/\.+$/, "") : "no se pudo leer el canal";
					notice = `: ${sentence}`;
				}
			}
			// A source that could not be read already failed this run: the engine never starts.
			if (result === undefined) result = await runMinikoda({
				recipe,
				root: this.engineRoot(recipe.id),
				runId,
				source: source.text ?? "",
				signal,
				// S17: this budget (300 s) is spent by the ENGINE only. runMinikoda starts its clock here, after the
				// transcription, so transcription time never counts toward it (transcribe.cjs has its own 30 min).
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
			if (result === undefined) {
				this.log(`minikoda ${recipe.id}: run failed before start`);
				result = { runId, minikoda: recipe.id, outcome: "failed", reason: "failed", proposals: [] };
			}
		}
		// Every outcome (done, crash, timeout, cancel): the engine may have refreshed the token before it ended.
		// Written back first (S11), then the copy is removed; a copy that could not be written back stays so the
		// next run retries it (removing it would lose a rotated refresh token).
		if (copied !== undefined && (await this.settleRunCredential(recipe, agentDir, copied))) this.removeRunCredential(agentDir);
		if (result.outcome === "done") {
			// S19/F4: «Hoy» shows where the text came from when one source dominated it (the rule is `dominantProvenance`).
			await this.results.addRun({ minikoda: recipe.id, resultText: result.resultText, proposals: result.proposals, provenance: source.provenance });
			// S6: the channel marker moves only now, so a failed run reads the same posts again instead of skipping them.
			await source.commit?.();
		} else {
			// S13: what the kit really parked before the failure is kept pending, and «Hoy» says the run failed.
			const parked = result.proposals ?? [];
			await this.results.addError({
				minikoda: recipe.id,
				text: `La corrida de «${recipe.name}» falló (${result.reason === "transcription" ? `transcripción: ${result.detail}` : result.reason})${notice}.${parked.length ? ` ${parked.length} propuesta(s) de esa corrida quedaron pendientes en «Hoy».` : ""}`,
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

module.exports = { MinikodaService, MinikodaError, MAX_MINIKODAS, RecipeError, dominantProvenance };
