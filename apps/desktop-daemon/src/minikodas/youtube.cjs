"use strict";

/**
 * K2-13 (S19): the YouTube links in what a Minikoda reads.
 *
 * «de youtube nada más» (L32) + «2a» (L33): a video link in a post is read from YouTube itself, and only when it IS
 * YouTube — every other site is ignored. For each link:
 *
 *   1. YouTube's own subtitles first (manual tracks before automatic ones), in the video's language, via
 *      `yt-dlp --skip-download --write-subs|--write-auto-subs --sub-format vtt` into the run's private work folder;
 *   2. if the video has none, its audio only (`-f bestaudio`, refused above 3 h of metadata duration and above
 *      200 MB) is downloaded and transcribed by the SAME transcription service (Parakeet by default, or the remote
 *      account of the setting), inside the SAME 30-minute transcription budget (S17);
 *   3. the text joins the run's source with a short marker of where it came from («subtítulos de YouTube» /
 *      «transcripto»).
 *
 * Safety, always: yt-dlp is the BUNDLED binary at a fixed path (`<install>/runtime/yt-dlp[.exe]`, never PATH); it is
 * spawned with `shell:false` and a fixed argv, and a URL is never taken from the model's text — the argv carries
 * `https://www.youtube.com/watch?v=<11-char id>`, built from the id this module validated. `--ignore-config` (no
 * config file), `--no-playlist` (one video), `--no-exec` (nothing it downloads is executed), `--no-remote-components`
 * (nothing is fetched from npm or GitHub at run time), no cookies, no plugins, no cache dir, and a per-call timeout.
 * yt-dlp needs a JavaScript runtime for YouTube extraction (only deno is enabled by default), so Koda's own bundled
 * Node is passed as `--js-runtimes node:<absolute path>`: the same Node the runtime already ships, never PATH. Cancelling the run (pause, delete, daemon stop) kills the child; the work
 * folder is removed in `finally`, on success and on failure.
 *
 * A link that fails is not the end of the run: the failure becomes a «Hoy» error item in Spanish (video privado o no
 * disponible, demasiado largo, sin subtítulos ni audio) and the Minikoda reads the rest. A cancelled run, or the
 * 30-minute transcription budget running out, still ends the run (S17) — the job object and `budget_exceeded` are
 * shared with transcribe.cjs.
 *
 * macOS: neither ffmpeg nor yt-dlp is bundled yet (pending for the Mac session), so the reader is constructed without
 * a tool there and every link answers `youtube_unavailable` (documented in README/PROTOCOL).
 */

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ensurePrivateDir } = require("../isolation.cjs");
const { removeWorkDir, TRANSCRIPTION_BUDGET_MS, TRANSCRIPTION_BUDGET_MINUTES } = require("./transcribe.cjs");

/** At most this many DIFFERENT videos are read per run; the rest are reported in «Hoy». */
const MAX_LINKS_PER_RUN = 3;
/** Longest video read (metadata duration, checked BEFORE downloading anything). */
const MAX_VIDEO_SECONDS = 3 * 3600;
/** Largest audio download accepted. */
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
/** One yt-dlp call (metadata, subtitles, audio); the shared budget bounds the whole read. */
const CALL_TIMEOUT_MS = 180_000;
const CLOSE_GRACE_MS = 10_000;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
/** The video id YouTube uses: exactly 11 URL-safe base64 characters. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** A real language entry of `subtitles`/`automatic_captions` (`es`, `es-orig`, `pt-PT`); `live_chat` is not one. */
const LANGUAGE_TRACK = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]+)*$/;
/** Exactly the hosts of a YouTube video link; anything else in the text is ignored. */
const HOSTS = Object.freeze(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);
/** How a marker names where a text came from (S19: «un marcador corto de dónde vino»). */
const MARKS = Object.freeze({ subtitles: "subtítulos de YouTube", transcript: "transcripto" });
/** The fixed flags of EVERY yt-dlp call (see the header). A URL never reaches the shell: argv is an array. */
const SAFETY_FLAGS = Object.freeze([
	"--ignore-config", // never read a yt-dlp config file (of the user, the project or the machine)
	"--no-playlist", // one video, even when the link sits in a playlist
	"--no-exec", // nothing downloaded is ever executed
	"--no-cache-dir", // no cache folder outside the run's own work dir
	"--no-progress", "--no-warnings", "--no-color",
	"--no-remote-components", // never fetch a component (JavaScript module, plugin) from npm or GitHub at run time
	"--socket-timeout", "20",
	"--retries", "2",
]);
const USER_TEXT = Object.freeze({
	youtube_unavailable: "el lector de YouTube no está instalado en esta computadora",
	unavailable: "el video no está disponible (es privado, fue eliminado o tiene restricciones)",
	too_long: `el video dura más de ${MAX_VIDEO_SECONDS / 3600} horas`,
	too_large: "el audio del video supera los 200 MB",
	no_media: "el video no tiene subtítulos ni audio que se pudiera descargar",
	cancelled: "se canceló la lectura del video",
	budget_exceeded: `los videos de YouTube tardaron más de ${TRANSCRIPTION_BUDGET_MINUTES} minutos; no se resumieron`,
	failed: "el video de YouTube no se pudo leer",
});

class YouTubeError extends Error {
	constructor(code) {
		const known = Object.hasOwn(USER_TEXT, code) ? code : "failed";
		super(`youtube failed (${known})`);
		this.name = "YouTubeError";
		this.code = known;
		this.userText = USER_TEXT[known];
	}
}

const fail = (code) => {
	throw new YouTubeError(code);
};
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The video id of ONE candidate token, or undefined. Strict: the token must be an http(s) URL, its host must be a
 * YouTube host, and the shape must be one of the three video shapes Koda reads (`/watch?v=`, `/shorts/<id>`,
 * `youtu.be/<id>`). Playlists, channels, `/embed`, `/live` and every other site are not video links.
 */
function youtubeId(token) {
	const cleaned = String(token ?? "").replace(/[.,;:!?)\]}>»"']+$/, "");
	if (!/^https?:\/\//i.test(cleaned)) return undefined;
	let url;
	try {
		url = new URL(cleaned);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	const host = url.hostname.toLowerCase();
	if (!HOSTS.includes(host)) return undefined;
	const segments = url.pathname.split("/").filter(Boolean);
	if (host === "youtu.be" || host === "www.youtu.be") return segments.length === 1 && VIDEO_ID.test(segments[0]) ? segments[0] : undefined;
	if (segments.length === 1 && segments[0] === "watch") {
		const v = url.searchParams.get("v");
		return typeof v === "string" && VIDEO_ID.test(v) ? v : undefined;
	}
	if (segments.length === 2 && segments[0] === "shorts" && VIDEO_ID.test(segments[1])) return segments[1];
	return undefined;
}

/**
 * Every DIFFERENT YouTube video link of a text, in order, at most `max`. `skipped` counts the distinct videos left
 * out by the cap, so «Hoy» can say so. A repeated link is one video, not two.
 */
function findYouTubeLinks(text, { max = MAX_LINKS_PER_RUN } = {}) {
	const seen = new Set();
	const links = [];
	let skipped = 0;
	for (const token of String(text ?? "").split(/[\s<>"'`«»()[\]{}]+/)) {
		const id = youtubeId(token);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		if (links.length >= max) {
			skipped += 1;
			continue;
		}
		links.push({ id, url: `https://www.youtube.com/watch?v=${id}` });
	}
	return { links, skipped };
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
/**
 * A WebVTT file as plain text: no cue numbers, no timings, no inline tags (`<c>`, `<00:00:01.000>`), no note/style
 * blocks, and with YouTube's rolling captions folded — the repeated line is dropped, and a line that only grows the
 * previous one replaces it instead of being appended again.
 */
function vttToText(vtt) {
	const out = [];
	for (const raw of String(vtt ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.includes("-->")) continue;
		if (/^WEBVTT/.test(line) || /^(NOTE|STYLE|REGION|Kind:|Language:|X-TIMESTAMP-MAP)/.test(line)) continue;
		if (/^\d+$/.test(line)) continue; // the cue number
		const text = line
			.replace(/<[^>]*>/g, "")
			.replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e] ?? "")
			.replace(/[ \t]+/g, " ")
			.trim();
		if (text === "") continue;
		const last = out[out.length - 1];
		if (last === undefined) out.push(text);
		else if (text === last || last.startsWith(text)) continue;
		else if (text.startsWith(last)) out[out.length - 1] = text;
		else out.push(text);
	}
	return out.join(" ").slice(0, MAX_TEXT_CHARS);
}

/** A regular, executable (POSIX) file, or undefined: the bundled tool is never a symlink and never from PATH. */
function executableFile(file, platform) {
	try {
		const st = fs.lstatSync(file);
		if (!st.isFile() || st.isSymbolicLink()) return undefined;
		if (platform !== "win32" && (st.mode & 0o111) === 0) return undefined;
		return file;
	} catch {
		return undefined;
	}
}

/** The bundled yt-dlp of an install root (`<install>/runtime/yt-dlp[.exe]`); undefined where it is not bundled. */
function bundledYtDlp({ installRoot, platform = process.platform }) {
	const exe = platform === "win32" ? ".exe" : "";
	return executableFile(path.join(installRoot, "runtime", `yt-dlp${exe}`), platform);
}

/** Koda's own bundled Node (`<install>/runtime/node[.exe]`): the JavaScript runtime yt-dlp needs on YouTube. */
function bundledNode({ installRoot, platform = process.platform }) {
	const exe = platform === "win32" ? ".exe" : "";
	return executableFile(path.join(installRoot, "runtime", `node${exe}`), platform);
}

class YouTubeReader {
	/**
	 * @param {object} o
	 * @param {string} o.islandRoot                     work folders live in `<island>/minikodas/youtube/`
	 * @param {{command, commandArgs?}|undefined} o.ytdlp  the bundled yt-dlp (undefined: unavailable, e.g. macOS)
	 * @param {string} [o.jsRuntime]                    absolute path of Koda's bundled Node, for `--js-runtimes`
	 * @param {{transcribe(file, {signal, deleteMedia, deadline}): Promise<{text}>}} o.transcriber  transcribe.cjs
	 * @param {() => object} [o.setting]                the transcription setting (its `language` is used for the tracks)
	 * @param {(accountId) => Promise<object>} [o.remoteAccount]  forwarded to the transcriber's own configuration
	 * @param {object} [o.env]                          environment of the children
	 * @param {object} [o.limits]                       overrides (tests): budgetMs, maxAudioBytes, maxSeconds, callTimeoutMs
	 */
	constructor({ islandRoot, ytdlp, jsRuntime, transcriber, setting, env = process.env, log = () => {}, limits = {} }) {
		this.islandRoot = islandRoot;
		this.ytdlp = ytdlp;
		this.jsRuntime = jsRuntime;
		this.transcriber = transcriber;
		this.setting = setting ?? (() => ({ language: "es" }));
		this.env = env;
		this.log = log;
		this.limits = {
			budgetMs: TRANSCRIPTION_BUDGET_MS,
			maxAudioBytes: MAX_AUDIO_BYTES,
			maxSeconds: MAX_VIDEO_SECONDS,
			callTimeoutMs: CALL_TIMEOUT_MS,
			...limits,
		};
	}

	status() {
		return this.ytdlp && this.transcriber ? "available" : "unavailable";
	}

	/**
	 * Reads every YouTube video link of `text` and returns `{text, videos, skipped, failures}`: `text` is the source
	 * with the transcripts appended behind their markers; `failures` are `{id, url, code, userText}` for «Hoy».
	 * Throws YouTubeError(`cancelled`) when the run is cancelled and (`budget_exceeded`) when the shared transcription
	 * budget ran out — both end the run (S17).
	 */
	async read(text, { signal } = {}) {
		const source = String(text ?? "");
		const { links, skipped } = findYouTubeLinks(source);
		if (links.length === 0) return { text: source, videos: 0, skipped: 0, failures: [] };
		const failures = [];
		if (!this.ytdlp || !this.transcriber) {
			// macOS (no ffmpeg, no yt-dlp yet) and a development checkout: the post is still read, without the video.
			for (const link of links) failures.push({ ...link, code: "youtube_unavailable", userText: USER_TEXT.youtube_unavailable });
			return { text: source, videos: 0, skipped, failures };
		}
		const job = { signal, deadline: Date.now() + this.limits.budgetMs };
		let work;
		const parts = [];
		try {
			work = ensurePrivateDir(path.join(ensurePrivateDir(path.join(this.islandRoot, "minikodas", "youtube")), randomUUID()));
			for (const link of links) {
				if (signal?.aborted) fail("cancelled");
				if (Date.now() >= job.deadline) fail("budget_exceeded");
				try {
					const video = await this.readOne(link, work, job);
					parts.push(`\n[Video de YouTube ${link.url} · ${MARKS[video.from]}]\n${video.text}`);
				} catch (error) {
					if (error instanceof YouTubeError && (error.code === "cancelled" || error.code === "budget_exceeded")) throw error;
					const code = error instanceof YouTubeError ? error.code : "failed";
					this.log(`youtube: ${code}`);
					failures.push({ ...link, code, userText: new YouTubeError(code).userText });
				}
			}
		} finally {
			if (work) await this.removeWork(work);
		}
		return { text: parts.length ? source + parts.join("") : source, videos: parts.length, skipped, failures };
	}

	/** Work folders retry a few short times (Windows keeps a just-killed child's folder busy); cleanup never throws. */
	async removeWork(dir) {
		try {
			if (!(await removeWorkDir(dir, { log: this.log }))) this.log("youtube: could not remove its work folder");
		} catch {
			this.log("youtube: could not remove its work folder");
		}
	}

	/**
	 * One video: metadata, then subtitles, then (only if there are none) audio + transcription. Each video gets its own
	 * folder inside the run's work folder, so the files of one link can never be read as the files of another.
	 */
	async readOne(link, work, job) {
		const dir = ensurePrivateDir(path.join(work, link.id));
		const info = await this.metadata(link, job);
		const duration = Number(info?.duration);
		if (!Number.isFinite(duration) || duration <= 0) fail("unavailable");
		if (duration > this.limits.maxSeconds) fail("too_long");
		const track = this.pickTrack(info);
		if (track) {
			const text = await this.subtitles(link, track, dir, job);
			if (text !== "") return { from: "subtitles", text };
			this.log("youtube: no usable subtitle track, using the audio");
		}
		const audio = await this.downloadAudio(link, dir, job);
		const out = await this.transcriber.transcribe(audio, { signal: job.signal, deleteMedia: true, deadline: job.deadline });
		return { from: "transcript", text: String(out?.text ?? "").trim() };
	}

	/**
	 * The subtitle track to ask for. In order: a MANUAL track in the video's own language (`info.language`, else the
	 * setting's), else YouTube's AUTOMATIC captions in that same language, else any manual track, else any automatic
	 * one — the language of the video wins over the kind of the track, because a manual track in another language is
	 * not what S19 asks for. YouTube also lists entries that are not subtitle tracks at all (`live_chat`), and those
	 * are never requested. `undefined` when the video has neither.
	 */
	pickTrack(info) {
		const clean = (tracks) => Object.keys(isObject(tracks) ? tracks : {}).filter((l) => LANGUAGE_TRACK.test(l));
		const manual = clean(info?.subtitles);
		const auto = clean(info?.automatic_captions);
		const wanted = String(info?.language || this.setting().language || "es").toLowerCase().slice(0, 2);
		const inLanguage = (list) => list.find((l) => l.toLowerCase().slice(0, 2) === wanted);
		for (const [list, isAuto] of [[manual, false], [auto, true]]) {
			const match = inLanguage(list);
			if (match) return { language: match, auto: isAuto };
		}
		if (manual.length) return { language: manual[0], auto: false };
		if (auto.length) return { language: auto[0], auto: true };
		return undefined;
	}

	/** `--dump-single-json`: duration and available tracks, read before any media is downloaded. */
	async metadata(link, job) {
		const out = await this.run(["--skip-download", "--dump-single-json", link.url], job, { capture: true, failCode: "unavailable", maxBytes: MAX_METADATA_BYTES });
		try {
			const line = out.stdout.toString("utf8").trim();
			const doc = JSON.parse(line.split("\n").filter(Boolean).at(-1));
			if (!isObject(doc)) fail("unavailable");
			return doc;
		} catch (error) {
			if (error instanceof YouTubeError) throw error;
			this.log("youtube: unreadable metadata");
			fail("failed");
		}
	}

	/** Manual or automatic subtitles as plain text; "" when YouTube wrote no track Koda could use. */
	async subtitles(link, track, work, job) {
		await this.run([
			"--skip-download",
			track.auto ? "--write-auto-subs" : "--write-subs",
			"--sub-format", "vtt",
			"--sub-langs", track.language,
			"-o", path.join(work, "%(id)s.%(ext)s"), link.url,
		], job, { failCode: "unavailable" });
		const file = this.findFile(work, /\.vtt$/);
		if (!file) return "";
		const stats = fs.lstatSync(file);
		if (!stats.isFile() || stats.size > MAX_SUBTITLE_BYTES) return "";
		return vttToText(fs.readFileSync(file, "utf8"));
	}

	/** Audio only (`-f bestaudio`), then the size cap; the transcription deletes the file. */
	async downloadAudio(link, work, job) {
		await this.run([
			"-f", "bestaudio/best",
			"--max-filesize", String(Math.floor(this.limits.maxAudioBytes / 1048576)) + "M",
			"-o", path.join(work, "%(id)s.%(ext)s"), link.url,
		], job, { failCode: "unavailable" });
		const file = this.findFile(work, /\.(m4a|webm|opus|ogg|mp3|aac|wav|flac|mp4|mka|weba)$/);
		if (!file) fail("no_media");
		const size = fs.lstatSync(file).size;
		if (size <= 0) fail("no_media");
		if (size > this.limits.maxAudioBytes) fail("too_large");
		return file;
	}

	/** The first regular, non-symlink file of the work folder whose name matches. */
	findFile(dir, pattern) {
		for (const name of fs.readdirSync(dir).sort()) {
			if (!pattern.test(name)) continue;
			const file = path.join(dir, name);
			const stats = fs.lstatSync(file);
			if (stats.isFile() && !stats.isSymbolicLink()) return file;
		}
		return undefined;
	}

	/** The `--js-runtimes` pair for the bundled Node (empty when the caller injected no runtime, e.g. a test). */
	jsRuntimeArgs() {
		return this.jsRuntime ? ["--js-runtimes", `node:${this.jsRuntime}`] : [];
	}

	/**
	 * Runs the bundled yt-dlp with the safety flags, `shell:false` and a fixed argv. Killed on cancel and at the
	 * shared deadline; a killed child is waited for (bounded) so the work folder is never removed under a live process.
	 * stderr is drained and dropped: it can name the video.
	 */
	run(args, job, { capture = false, failCode = "failed", maxBytes = MAX_METADATA_BYTES } = {}) {
		return new Promise((resolve, reject) => {
			let settled = false;
			let child;
			const out = [];
			let outBytes = 0;
			const release = () => {
				settled = true;
				clearTimeout(timer);
				job.signal?.removeEventListener("abort", onAbort);
			};
			const settle = (fn, value) => {
				if (settled) return;
				release();
				fn(value);
			};
			const stopAndSettle = (fn, value) => {
				if (settled) return;
				if (!child || child.exitCode !== null || child.signalCode !== null) return settle(fn, value);
				release();
				child.kill("SIGKILL");
				let done = false;
				const finishNow = () => {
					if (done) return;
					done = true;
					clearTimeout(grace);
					fn(value);
				};
				const grace = setTimeout(finishNow, CLOSE_GRACE_MS);
				grace.unref?.();
				child.once("close", finishNow);
			};
			const onAbort = () => stopAndSettle(reject, new YouTubeError("cancelled"));
			const remaining = Math.max(1, job.deadline - Date.now());
			const timer = setTimeout(() => {
				this.log("youtube: yt-dlp timed out");
				stopAndSettle(reject, new YouTubeError("budget_exceeded"));
			}, Math.min(remaining, this.limits.callTimeoutMs));
			if (job.signal?.aborted) return onAbort();
			job.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				child = spawn(this.ytdlp.command, [...(this.ytdlp.commandArgs ?? []), ...SAFETY_FLAGS, ...this.jsRuntimeArgs(), ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: this.env });
			} catch {
				this.log("youtube: yt-dlp could not start");
				return settle(reject, new YouTubeError("failed"));
			}
			child.stdout.on("data", (c) => {
				if (!capture) {
					return; // `--no-progress` means there is nothing to read, and never buffering it is the bound
				}
				outBytes += c.length;
				if (outBytes > maxBytes) return stopAndSettle(reject, new YouTubeError("failed"));
				out.push(c);
			});
			child.stderr.resume();
			child.on("error", () => {
				this.log("youtube: yt-dlp could not start");
				stopAndSettle(reject, new YouTubeError("failed"));
			});
			child.on("close", (code) => {
				if (settled) return;
				if (code !== 0) {
					this.log(`youtube: yt-dlp exited ${code}`);
					return settle(reject, new YouTubeError(failCode));
				}
				settle(resolve, { stdout: Buffer.concat(out) });
			});
		});
	}
}

module.exports = {
	YouTubeReader,
	YouTubeError,
	findYouTubeLinks,
	youtubeId,
	vttToText,
	bundledYtDlp,
	bundledNode,
	SAFETY_FLAGS,
	MARKS,
	USER_TEXT,
	MAX_LINKS_PER_RUN,
	MAX_VIDEO_SECONDS,
	MAX_AUDIO_BYTES,
	CALL_TIMEOUT_MS,
};
