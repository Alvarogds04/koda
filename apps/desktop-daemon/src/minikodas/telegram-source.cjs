"use strict";

/**
 * K2-13 (T1b, S6): a Telegram channel as a Minikoda's source.
 *
 * A recipe says `reads.source: "telegram:@canal"` (or a `t.me` link) and the daemon reads that PUBLIC channel with the
 * user's own account (S6), never with a bot. Per run:
 *
 * 1. the channel is resolved ONCE and `{channelId, accessHash}` is cached in the Minikoda's private state
 *    (`<island>/minikodas/telegram/<id>.json`, 0600), so later runs do not spend `contacts.resolveUsername`;
 * 2. only posts newer than `lastSeenId` are fetched (`getHistory({minId})`), capped per run: the first run reads the
 *    latest 5, later runs at most 20;
 * 3. video, audio, voice and round-video media are downloaded with `downloadAsNodeStream` into the run's private folder
 *    (`<island>/minikodas/media/<run>/`, 0700/0600) — but only after Telegram's OWN metadata says they are within
 *    200 MB and 3 hours; photos and documents are ignored, and content-protected (noforwards) media are skipped with a
 *    note. `FILE_REFERENCE_EXPIRED` refetches that one message and retries the download ONCE;
 * 4. the result is `{text, media:[{path, mimeType, durationSec, messageId, kind}], commit}`. `text` is what the Minikoda
 *    reads through `source_read`; `media` is the contract the transcription step consumes (K2-13 T2c, branch
 *    feat/k2-13-transcribe): it turns each file into text and deletes it, so nothing is transcribed here;
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

/** A public channel's username: a letter followed by 4-31 letters, digits or underscores (Telegram's own rule). */
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
			this.log(`minikoda ${id}: the cached telegram channel is unreadable (resolving again)`);
			return undefined;
		}
		const valid = state?.version === 1
			&& typeof state.channel === "string"
			&& Number.isSafeInteger(state.channelId) && state.channelId > 0
			&& (typeof state.accessHash === "string" || Number.isSafeInteger(state.accessHash))
			&& Number.isSafeInteger(state.lastSeenId) && state.lastSeenId >= 0;
		if (!valid) {
			this.log(`minikoda ${id}: the cached telegram channel is invalid (resolving again)`);
			return undefined;
		}
		return { channel: state.channel, channelId: state.channelId, accessHash: String(state.accessHash), lastSeenId: state.lastSeenId };
	}

	saveState(id, state) {
		const file = this.#stateFile(id);
		ensurePrivateDir(path.dirname(file));
		writePrivateFile(file, `${JSON.stringify({ version: 1, ...state, accessHash: String(state.accessHash) }, null, 2)}\n`);
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
		// The resolved channel is cached as soon as it is known: a run that fails later must not pay resolveUsername
		// again. Only `lastSeenId` waits for commit().
		let peer = useCache ? { _: "inputPeerChannel", channelId: state.channelId, accessHash: state.accessHash } : undefined;
		let resolved = undefined;
		try {
			if (peer === undefined) resolved = await this.#resolve(client, parsed.channel);
			else resolved = { channelId: state.channelId, accessHash: state.accessHash };
		} catch (error) {
			throw this.#map(error);
		}
		const minId = useCache && state.lastSeenId > 0 ? state.lastSeenId : undefined;
		const limit = minId === undefined ? this.limits.firstRunPosts : this.limits.maxPostsPerRun;
		let messages;
		try {
			messages = await client.getHistory(peer ?? resolved.peer, { limit, ...(minId !== undefined ? { minId } : {}) });
		} catch (error) {
			// A cached channel Telegram no longer accepts is resolved again ONCE, then the run fails with a closed code.
			if (peer !== undefined && /CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID/.test(String(error?.text ?? error?.message ?? ""))) {
				try {
					resolved = await this.#resolve(client, parsed.channel);
					messages = await client.getHistory(resolved.peer, { limit, ...(minId !== undefined ? { minId } : {}) });
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
				const block = await this.#post(message, client, mediaDir, media, signal);
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
			const alreadySeen = state !== undefined && state.channel === parsed.channel ? state.lastSeenId : 0;
			this.saveState(id, { channel: parsed.channel, channelId: resolved.channelId, accessHash: resolved.accessHash, lastSeenId: alreadySeen });
			this.log(`minikoda ${id}: telegram run ${runId} read ${posts.length} post(s), ${media.length} media file(s)`);
			return {
				text: text.slice(0, this.limits.maxTextChars),
				media,
				commit: async () => this.saveState(id, { channel: parsed.channel, channelId: resolved.channelId, accessHash: resolved.accessHash, lastSeenId: Math.max(highest, minId ?? 0) }),
			};
		} catch (error) {
			// A run that could not finish leaves no media behind.
			this.#removeRunMedia(mediaDir);
			throw error;
		}
	}

	/** One post as the Minikoda reads it, downloading its media when Telegram's metadata says it is within the caps. */
	async #post(message, client, mediaDir, media, signal) {
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
					const file = await this.#download(message, client, mediaDir, signal);
					media.push({ path: file, mimeType: String(message.media?.mimeType ?? "application/octet-stream"), durationSec, messageId: message.id, kind });
					blocks.push(`(${kind} de ${durationSec} s, adjunto; se transcribe aparte)`);
				}
			}
		}
		return blocks.join(" ");
	}

	/** Streams one media file into the run's private folder; FILE_REFERENCE_EXPIRED refetches the message and retries once. */
	async #download(message, client, mediaDir, signal) {
		ensurePrivateDir(mediaDir);
		const file = path.join(mediaDir, `${message.id}-${message.media?.type ?? "media"}.${fileExtension(message.media?.mimeType)}`);
		const attempt = (media) => pipeline(client.downloadAsNodeStream(media, { abortSignal: signal, fileSize: media?.fileSize }), fs.createWriteStream(file, { mode: 0o600 }));
		try {
			await attempt(message.media);
		} catch (error) {
			if (!/FILE_REFERENCE_EXPIRED/.test(String(error?.text ?? error?.message ?? ""))) throw this.#map(error);
			// Telegram expired the file reference: ask for the message again (fresh reference) and retry exactly once.
			const [fresh] = await client.getMessages(message.media?.chat ? message.media.chat : undefined, [message.id]).catch(() => []);
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

	async #resolve(client, channel) {
		const resolved = await client.resolveChannel(channel);
		if (!resolved || typeof resolved !== "object" || !Number.isSafeInteger(resolved.channelId) || resolved.accessHash === undefined) {
			throw new TelegramError("telegram_channel_invalid");
		}
		return { peer: resolved, channelId: resolved.channelId, accessHash: String(resolved.accessHash) };
	}

	#map(error) {
		if (error instanceof TelegramError) return error;
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

module.exports = { TelegramSource, TelegramSourceError: TelegramError, TelegramError, parseSource, normalizeChannel, SOURCE_LIMITS };
