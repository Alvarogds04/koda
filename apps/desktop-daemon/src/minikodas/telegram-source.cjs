"use strict";

/**
 * K2-13 (T1b, S6): a Telegram channel as a Minikoda's source.
 *
 * A recipe says `reads.source: "telegram:@canal"` (or a `t.me` link) and the daemon reads that PUBLIC channel with the
 * user's own account (S6), never with a bot. Per run:
 *
 * 1. the channel is read by its `@username` (`getHistory("@canal")`). Only the username and the last post read are
 *    kept in the Minikoda's private state (`<island>/minikodas/telegram/<id>.json`, 0600): mtcute resolves and caches
 *    usernames itself, and a peer rebuilt from a cached access hash would arrive at Telegram as access hash 0;
 * 2. only posts newer than `lastSeenId` are fetched (`getHistory({minId})`), capped per run: the first run reads the
 *    latest 5, later runs at most 20;
 * 3. video, audio, voice and round-video media are downloaded with `downloadAsNodeStream` into the run's private folder
 *    (`<island>/minikodas/media/<run>/`, 0700/0600) — but only after Telegram's OWN metadata says they are within
 *    200 MB and 3 hours; photos and documents are ignored, and content-protected (noforwards) media are skipped with a
 *    note. `FILE_REFERENCE_EXPIRED` refetches that one message and retries the download ONCE;
 * 4. the result is `{text, media:[{path, mimeType, durationSec, messageId, kind}], commit}`. `text` is what the Minikoda
 *    reads through `source_read`; `media` is the contract the transcription step consumes (K2-13 T2c, branch
 *    feat/k2-13-transcribe): it turns each file into text. Nothing is transcribed here, and the run's media folder is
 *    removed as soon as the run ends (`removeRun`, called by the service in a finally);
 * 5. `commit()` moves `lastSeenId`, and the service calls it only when the run really succeeded. A failed run reads the
 *    same posts again next time instead of skipping them.
 *
 * Errors are the Telegram session's closed codes (`telegram_not_connected`, `telegram_flood_wait` with its minutes,
 * `telegram_session_invalid`, …) so «Hoy» can explain them in Spanish. There is no retry loop: a long FLOOD_WAIT fails
 * the run.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { ensurePrivateDir, writePrivateFile } = require("../isolation.cjs");
const { TelegramError, mapRpcError } = require("./telegram.cjs");

/**
 * A public channel's username: a letter followed by 4-31 letters, digits or underscores (Telegram's own rule).
 */
const CHANNEL_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
/** Names that are links of their own, never channels this daemon can read by username. */
const RESERVED = new Set(["joinchat", "addstickers", "addemoji", "share", "iv", "proxy", "socks"]);
const LINK_PREFIXES = [/^(?:https?:\/\/)?(?:www\.)?t\.me\//i, /^(?:https?:\/\/)?(?:www\.)?telegram\.me\//i];
const MARKER = /^telegram:(.*)$/i;
/** Media kinds worth transcribing; `video` also covers round video notes (Video.isRound) and GIF animations. */
const MEDIA_KINDS = new Set(["video", "audio", "voice"]);

const SOURCE_LIMITS = Object.freeze({
	firstRunPosts: 5,
	maxPostsPerRun: 20,
	maxMediaBytes: 200 * 1024 * 1024,
	maxMediaDurationSec: 3 * 60 * 60,
	/** Bound of the text the Minikoda reads (the kit itself caps its content at 200 000 chars). */
	maxTextChars: 60_000,
	maxPostChars: 4_000,
});

const MEGABYTES = SOURCE_LIMITS.maxMediaBytes / (1024 * 1024);

/** `@name`, `name`, `t.me/name`, `https://t.me/name`, `telegram.me/name` → `@name`; anything else → undefined. */
function normalizeChannel(value) {
	if (typeof value !== "string") return undefined;
	let name = value.trim();
	if (name === "") return undefined;
	if (!name.startsWith("@")) {
		const prefix = LINK_PREFIXES.find((candidate) => candidate.test(name));
		if (prefix) name = name.replace(prefix, "").replace(/\/+$/, "");
		else if (!/^[A-Za-z0-9_]+$/.test(name)) return undefined; // a bare username, or nothing at all
	} else {
		name = name.slice(1);
	}
	if (!CHANNEL_USERNAME.test(name) || RESERVED.has(name.toLowerCase())) return undefined;
	return `@${name}`;
}

/**
 * Reads a recipe's `reads.source` descriptor. `{type:"text"}` means the existing `sources/<id>.txt` source;
 * `{type:"telegram", channel}` a public channel; `undefined` a malformed descriptor (refused, never repaired).
 */
function parseSource(descriptor) {
	if (typeof descriptor !== "string") return undefined;
	const marker = MARKER.exec(descriptor.trim());
	if (!marker) return { type: "text" };
	const channel = normalizeChannel(marker[1]);
	return channel === undefined ? undefined : { type: "telegram", channel };
}

/**
 * True for a channel that was typed WITHOUT the `telegram:` prefix (`@nombre`, a `t.me`/`telegram.me` link): the creation
 * step refuses it instead of letting the run read it as an empty text source, so the daemon never has to guess.
 */
function looksLikeChannel(value) {
	if (typeof value !== "string") return false;
	const name = value.trim();
	return name.startsWith("@") || LINK_PREFIXES.some((candidate) => candidate.test(name));
}

/** The text Telegram/mtcute put in an error (`RpcError.text`, a message): the only thing the checks below read. */
const rpcTextOf = (error) => String(error?.text ?? error?.errorMessage ?? error?.message ?? "");

const fileExtension = (mimeType) => {
	const known = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/opus": "opus", "audio/x-wav": "wav", "audio/wav": "wav" };
	return known[String(mimeType)] ?? "bin";
};

/** An `@canal` source reader. One per daemon; every run gets its own state read, its own media folder and its own commit. */
class TelegramSource {
	/**
	 * @param {object} options
	 * @param {string} options.stateDir   `<island>/minikodas/telegram` (0700): the cached channels and last seen ids
	 * @param {string} options.mediaRoot  `<island>/minikodas/media`: one private folder per run
	 * @param {() => object|undefined} options.getClient the live mtcute client, or undefined when no account is connected
	 * @param {(line: string) => void} [options.log]     content-free progress log (never a message text or an access hash)
	 * @param {object} [options.limits]   SOURCE_LIMITS overrides (tests)
	 */
	constructor(options) {
		if (typeof options?.getClient !== "function") throw new TypeError("a TelegramSource needs getClient()");
		if (typeof options.stateDir !== "string" || typeof options.mediaRoot !== "string") throw new TypeError("a TelegramSource needs stateDir and mediaRoot");
		this.stateDir = options.stateDir;
		this.mediaRoot = options.mediaRoot;
		this.getClient = options.getClient;
		this.log = options.log ?? (() => {});
		this.limits = { ...SOURCE_LIMITS, ...(options.limits ?? {}) };
	}

	/** The cached state of one Minikoda, or undefined when it has none or it cannot be trusted. */
	loadState(id) {
		let raw;
		try {
			raw = fs.readFileSync(this.#stateFile(id), "utf8");
		} catch {
			return undefined;
		}
		let state;
		try {
			state = JSON.parse(raw);
		} catch {
			this.log(`minikoda ${id}: the cached telegram channel is unreadable (reading it again)`);
			return undefined;
		}
		// v2 dropped the cached `{channelId, accessHash}`: see saveState.
		const valid = state?.version === 2
			&& typeof state.channel === "string"
			&& Number.isSafeInteger(state.lastSeenId) && state.lastSeenId >= 0;
		if (!valid) {
			this.log(`minikoda ${id}: the cached telegram channel is invalid (reading it again)`);
			return undefined;
		}
		return { channel: state.channel, lastSeenId: state.lastSeenId };
	}

	/**
	 * The only thing Koda keeps between runs is the channel's `@username` and the last post it read.
	 *
	 * An `accessHash` is NOT cached: mtcute's TL writer serializes it with `.low`/`.high`, so a hash stored as a string
	 * (JSON has no 64-bit integer) was written as 0, and every later run had to re-resolve the channel after Telegram
	 * answered CHANNEL_INVALID. mtcute already caches usernames per client in its own storage, so the username alone is
	 * both simpler and correct: `getHistory("@canal")` resolves once per daemon lifetime, not once per run.
	 */
	saveState(id, state) {
		const file = this.#stateFile(id);
		ensurePrivateDir(path.dirname(file));
		writePrivateFile(file, `${JSON.stringify({ version: 2, channel: state.channel, lastSeenId: state.lastSeenId }, null, 2)}\n`);
	}

	/** Drops a Minikoda's cached channel (its delete path): the next Minikoda with the same id resolves again. */
	forget(id) {
		try {
			fs.unlinkSync(this.#stateFile(id));
		} catch (error) {
			if (error.code !== "ENOENT") this.log(`minikoda ${id}: could not remove its cached telegram channel`);
		}
	}

	#stateFile(id) {
		if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new TelegramError("telegram_channel_invalid");
		const file = path.join(this.stateDir, `${id}.json`);
		if (path.dirname(file) !== this.stateDir) throw new TelegramError("telegram_channel_invalid");
		return file;
	}

	/**
	 * Reads the channel for one run. Resolves `{text, media, commit}`; `commit()` is the only thing that moves the marker.
	 * `signal` aborts a download (the run was cancelled or timed out).
	 */
	async prepare({ recipe, runId, signal }) {
		const parsed = parseSource(recipe?.reads?.source);
		if (!parsed || parsed.type !== "telegram") throw new TelegramError("telegram_channel_invalid");
		const client = this.getClient();
		if (!client) throw new TelegramError("telegram_not_connected");
		const id = recipe.id;
		const state = this.loadState(id);
		const useCache = state !== undefined && state.channel === parsed.channel;
		// The peer IS the username: mtcute resolves it once per client and caches it, so no hand-built peer (and no
		// access hash turned into 0) can ever be sent to Telegram.
		const peer = parsed.channel;
		const minId = useCache && state.lastSeenId > 0 ? state.lastSeenId : undefined;
		const limit = minId === undefined ? this.limits.firstRunPosts : this.limits.maxPostsPerRun;
		const history = { limit, ...(minId !== undefined ? { minId } : {}) };
		let messages;
		try {
			messages = await client.getHistory(peer, history);
		} catch (error) {
			// A username mtcute cached before the channel changed (CHANNEL_INVALID, CHANNEL_PRIVATE, PEER_ID_INVALID):
			// resolved again ONCE, then the run fails with a closed code.
			if (/CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID/.test(rpcTextOf(error))) {
				try {
					messages = await client.getHistory(await client.resolveChannel(peer, true), history);
				} catch (retryError) {
					throw this.#map(retryError);
				}
			} else {
				throw this.#map(error);
			}
		}
		const posts = (Array.isArray(messages) ? messages : [])
			.filter((message) => message && Number.isSafeInteger(message.id) && message.id > 0)
			.sort((a, b) => a.id - b.id);
		const mediaDir = path.join(this.mediaRoot, String(runId));
		const media = [];
		try {
			const lines = [];
			let truncated = false;
			for (const message of posts) {
				const block = await this.#post(message, client, peer, mediaDir, media, signal);
				if (lines.join("\n").length + block.length > this.limits.maxTextChars) {
					truncated = true;
					break;
				}
				lines.push(block);
			}
			const header = posts.length === 0
				? `Canal ${parsed.channel}: sin publicaciones nuevas.`
				: `Canal ${parsed.channel}: ${posts.length} ${posts.length === 1 ? "publicación nueva" : "publicaciones nuevas"}.`;
			const text = [header, ...lines, ...(truncated ? ["[… el resto de las publicaciones quedó fuera por tamaño]"] : [])].join("\n\n");
			const highest = posts.length > 0 ? posts[posts.length - 1].id : (minId ?? 0);
			const alreadySeen = useCache ? state.lastSeenId : 0;
			this.saveState(id, { channel: parsed.channel, lastSeenId: alreadySeen });
			this.log(`minikoda ${id}: telegram run ${runId} read ${posts.length} post(s), ${media.length} media file(s)`);
			return {
				text: text.slice(0, this.limits.maxTextChars),
				media,
				commit: async () => this.saveState(id, { channel: parsed.channel, lastSeenId: Math.max(highest, minId ?? 0) }),
			};
		} catch (error) {
			// A run that could not finish leaves no media behind.
			this.#removeRunMedia(mediaDir);
			throw error;
		}
	}

	/** One post as the Minikoda reads it, downloading its media when Telegram's metadata says it is within the caps. */
	async #post(message, client, peer, mediaDir, media, signal) {
		const text = typeof message.text === "string" ? message.text.trim().slice(0, this.limits.maxPostChars) : "";
		const blocks = [`[${message.id}]${text === "" ? "" : ` ${text}`}`];
		const kind = message.media?.type;
		if (typeof kind === "string" && MEDIA_KINDS.has(kind)) {
			if (message.isContentProtected === true) {
				blocks.push(`(${kind} con contenido protegido: se omite, no se puede reenviar)`);
			} else {
				const fileSize = Number(message.media?.fileSize);
				const durationSec = Number(message.media?.duration ?? 0);
				if (!Number.isFinite(fileSize) || fileSize <= 0) {
					blocks.push(`(${kind} omitido: Telegram no informó su tamaño)`);
				} else if (fileSize > this.limits.maxMediaBytes) {
					blocks.push(`(${kind} omitido: demasiado pesado, ${MEGABYTES} MB como máximo)`);
				} else if (Number.isFinite(durationSec) && durationSec > this.limits.maxMediaDurationSec) {
					blocks.push(`(${kind} omitido: demasiado largo, 3 horas como máximo)`);
				} else {
					const file = await this.#download(message, client, peer, mediaDir, signal);
					media.push({ path: file, mimeType: String(message.media?.mimeType ?? "application/octet-stream"), durationSec, messageId: message.id, kind });
					// Transcription is another branch (feat/k2-13-transcribe): until it is merged this run carries the file and
					// says so plainly. The Minikoda is told what was attached, never where the media went.
					blocks.push(`(${kind} de ${durationSec} s, adjunto; todavía sin transcribir)`);
				}
			}
		}
		return blocks.join(" ");
	}

	/**
	 * Streams one media file into the run's private folder; FILE_REFERENCE_EXPIRED refetches the message and retries once.
	 * `peer` is the channel the post was read from: mtcute's media objects carry no `.chat`, and `getMessages` needs one.
	 */
	async #download(message, client, peer, mediaDir, signal) {
		ensurePrivateDir(mediaDir);
		const file = path.join(mediaDir, `${message.id}-${message.media?.type ?? "media"}.${fileExtension(message.media?.mimeType)}`);
		const attempt = (media) => pipeline(client.downloadAsNodeStream(media, { abortSignal: signal, fileSize: media?.fileSize }), fs.createWriteStream(file, { mode: 0o600 }));
		try {
			await attempt(message.media);
		} catch (error) {
			if (!/FILE_REFERENCE_EXPIRED/.test(rpcTextOf(error))) throw this.#map(error);
			// Telegram expired the file reference: ask for the message again in ITS channel (fresh reference) and retry once.
			const [fresh] = await client.getMessages(peer, [message.id]).catch(() => []);
			if (!fresh?.media) throw this.#map(error);
			try {
				await attempt(fresh.media);
			} catch (retryError) {
				throw this.#map(retryError);
			}
		}
		fs.chmodSync(file, 0o600);
		return file;
	}

	/**
	 * Removes one run's media folder (the service calls it after EVERY run: success, engine failure or cancel).
	 * The transcription step (K2-13 T2c, branch feat/k2-13-transcribe) will consume `source.media` BEFORE this happens,
	 * so merging the two branches deletes the files the same way, only later.
	 */
	removeRun(runId) {
		if (typeof runId !== "string" && typeof runId !== "number") return;
		const dir = path.join(this.mediaRoot, String(runId));
		if (path.dirname(dir) !== this.mediaRoot) return;
		this.#removeRunMedia(dir);
	}

	#map(error) {
		if (error instanceof TelegramError) return error;
		// A channel that does not exist is a channel problem, not a Telegram outage: «usá @usuario o un enlace t.me».
		if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/.test(rpcTextOf(error)) || /was not found|is not found in local cache/.test(String(error?.message ?? ""))) {
			return new TelegramError("telegram_channel_invalid", { cause: error });
		}
		const mapped = mapRpcError(error);
		return new TelegramError(mapped.code, { ...mapped, cause: error });
	}

	#removeRunMedia(dir) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			this.log("telegram: could not remove this run's media folder");
		}
	}
}

module.exports = { TelegramSource, TelegramSourceError: TelegramError, TelegramError, parseSource, normalizeChannel, looksLikeChannel, SOURCE_LIMITS };
