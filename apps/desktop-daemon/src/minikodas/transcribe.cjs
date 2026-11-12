"use strict";

/**
 * K2-13 (S6, S7, S8, S9, S15, S16): the daemon's transcription service. A Minikoda that reads a video or an audio
 * post gets its transcript first; the media never reaches the model.
 *
 *   media file ──ffmpeg──▶ 16 kHz mono WAV ──▶ local:  abito-transcribe (sherpa-onnx, Parakeet v3 / Whisper turbo)
 *                                          └─▶ remote: ffmpeg → ≤180 s mono OGG/Opus chunks (≤25 MB each)
 *                                                      → POST {base}/audio/transcriptions, JSON `.text`, joined
 *
 * - ffmpeg is the BUNDLED one (`<install>/runtime/ffmpeg[.exe]`, pinned LGPL build, packaging/runtime), never PATH;
 *   the helper is the bundled `<install>/abito-transcribe[.exe]`. Both run with `shell:false`, a fixed argv, a
 *   private working folder and a kill on cancel/timeout. ffmpeg only reads `file:` input (protocol whitelist) in a
 *   closed list of container formats (no playlists, no network). macOS (darwin-arm64): ffmpeg is NOT bundled yet
 *   (pending for the Mac session): every media transcription there answers `ffmpeg_unavailable`.
 * - Work files live in `<island>/minikodas/transcribe/<uuid>/` (0700) and are removed after every transcription;
 *   with `deleteMedia` the input media is deleted too (only a regular file, never through a symlink).
 * - Remote: the account is one Koda already has (a custom OpenAI-compatible gateway: its Base URL and key come from
 *   that account, `remoteAccount`). Redirects are never followed, responses are bounded, only `.text` is read.
 * - Never logged: the API key, the media path, the media content, the transcript. Errors are TranscriptionError
 *   with a closed `code` and a fixed Spanish `userText` for «Hoy».
 */

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { ensurePrivateDir } = require("../isolation.cjs");
const { validateCustomBaseUrl } = require("../protocol.cjs");
const { LOCAL_MODELS, TRANSCRIPTION_DEFAULT } = require("./transcribe-setting.cjs");

/** Remote chunks: at most 180 s (NaN's per-request limit) and 25 MB; 175 s leaves a margin for the encoder. */
const CHUNK_SECONDS = 175;
const MAX_CHUNK_BYTES = 24_000_000;
/** Longest wait for a killed child's `close` before the run settles anyway (a kill that did not take). */
const CLOSE_GRACE_MS = 10_000;
/** Containers ffmpeg may open (no playlists such as hls/concat, no devices, no network). */
const INPUT_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg,mp3,wav,flac,aac,avi,mpegts";
/**
 * The decoders those containers may use (`-codec_whitelist`). ffmpeg matches this option against DECODERS only, and by
 * exact name (no globs: `*` matches nothing — checked with `ffmpeg -h full` and with real runs), so every decoder the
 * accepted containers carry is named: AAC (plain, fixed and LATM for MPEG-TS), Opus and Vorbis (Ogg/WebM), MP3/MP2,
 * FLAC, Apple lossless, AC-3/E-AC-3 and the PCM variants WAV/AVI/MOV ship. Video and text decoders are left out, so a
 * hand-crafted file cannot reach them. */
const INPUT_CODECS = [
	"aac", "aac_fixed", "aac_latm", "opus", "vorbis", "flac", "alac", "mp3", "mp3float", "mp2", "ac3", "eac3",
	"pcm_s16le", "pcm_s16be", "pcm_s24le", "pcm_s24be", "pcm_s32le", "pcm_s32be", "pcm_f32le", "pcm_u8", "pcm_alaw", "pcm_mulaw",
].join(",");
const DEFAULT_LIMITS = Object.freeze({
	maxSeconds: 3 * 3600, // longest audio transcribed (same default as the helper)
	timeoutMs: 2 * 3600 * 1000, // whole transcription
	requestTimeoutMs: 180_000, // one remote request
	maxHelperOutputBytes: 4 * 1024 * 1024,
	maxResponseBytes: 1024 * 1024,
	maxTextChars: 200_000,
});

const USER_TEXT = Object.freeze({
	ffmpeg_unavailable: "ffmpeg no está disponible en esta computadora (en macOS todavía no se incluye)",
	local_unavailable: "el transcriptor local no está instalado",
	model_missing: "el modelo local no está descargado",
	bad_media: "el video o audio no se pudo leer",
	too_long: "el audio es más largo que el máximo permitido",
	too_large: "un fragmento supera el límite de 25 MB",
	timeout: "tardó demasiado",
	cancelled: "se canceló",
	remote_unavailable: "la cuenta elegida para transcribir no está disponible",
	remote_auth: "la cuenta elegida para transcribir rechazó la clave",
	remote_failed: "el servicio de transcripción respondió con un error",
	invalid_response: "la respuesta de la transcripción no es válida",
	failed: "la transcripción falló",
});

class TranscriptionError extends Error {
	constructor(code) {
		const known = Object.hasOwn(USER_TEXT, code) ? code : "failed";
		super(`transcription failed (${known})`);
		this.name = "TranscriptionError";
		this.code = known;
		this.userText = USER_TEXT[known];
	}
}

const fail = (code) => {
	throw new TranscriptionError(code);
};

/** A regular, non-symlink, executable (POSIX) file, or undefined. */
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

/**
 * The bundled tools for an install root (the folder that holds `desktop-daemon/`, `runtime/` and the binaries).
 * Fixed paths only, never PATH. darwin: ffmpeg is not bundled (out of scope for this version).
 */
function bundledTools({ installRoot, platform = process.platform }) {
	const exe = platform === "win32" ? ".exe" : "";
	return {
		ffmpeg: platform === "darwin" ? undefined : executableFile(path.join(installRoot, "runtime", `ffmpeg${exe}`), platform),
		helper: executableFile(path.join(installRoot, `abito-transcribe${exe}`), platform),
	};
}

/** Duration in seconds of a canonical 16 kHz mono 16-bit WAV (walks the chunks to `data`). */
function wavSeconds(file) {
	const fd = fs.openSync(file, "r");
	try {
		const head = Buffer.alloc(64 * 1024);
		const n = fs.readSync(fd, head, 0, head.length, 0);
		if (n < 12 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") fail("bad_media");
		let at = 12;
		while (at + 8 <= n) {
			const id = head.toString("latin1", at, at + 4);
			let size = head.readUInt32LE(at + 4);
			if (id === "data") {
				if (size === 0 || size === 0xffffffff) size = fs.fstatSync(fd).size - at - 8;
				return size / 32000;
			}
			at += 8 + size + (size % 2);
		}
		return fail("bad_media");
	} finally {
		fs.closeSync(fd);
	}
}

/** Removes a file only when it is a regular file (a symlink is never followed, never removed here). */
function removeRegular(file) {
	try {
		const st = fs.lstatSync(file);
		if (st.isFile() && !st.isSymbolicLink()) fs.unlinkSync(file);
	} catch {}
}

/**
 * Removes a private work folder, retrying a few short times. Windows keeps the folder of a just-killed child busy
 * (EBUSY) for a moment, so a bare `rmSync` in a `finally` could throw and replace the error that really ended the
 * transcription. Cleanup is therefore best effort: it never throws, and when it gives up it logs and returns false
 * (the caller's own error, if any, stands).
 *
 * @param {string} dir
 * @param {{attempts?: number, delayMs?: number, fs?: {rmSync: Function}, log?: (line: string) => void}} [options]
 * @returns {Promise<boolean>} true once the folder is gone
 */
async function removeWorkDir(dir, { attempts = 6, delayMs = 50, fs: remover = fs, log = () => {} } = {}) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			remover.rmSync(dir, { recursive: true, force: true });
			return true;
		} catch (error) {
			if (attempt >= attempts) {
				log(`transcription: could not remove its work folder (${error?.code ?? "error"})`);
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
		}
	}
}

/** One multipart/form-data body: text fields, then the file part. */
function multipart(fields, file) {
	const boundary = `----koda${randomUUID().replace(/-/g, "")}`;
	const parts = [];
	for (const [name, value] of fields) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
	parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

class Transcriber {
	/**
	 * @param {object} o
	 * @param {string} o.islandRoot
	 * @param {() => object} o.setting       the current global setting (transcribe-setting.cjs)
	 * @param {{command, commandArgs?}|undefined} o.ffmpeg   the bundled ffmpeg (undefined: unavailable)
	 * @param {{command, commandArgs?}|undefined} o.helper   the bundled abito-transcribe (undefined: unavailable)
	 * @param {(accountId) => Promise<{baseUrl, apiKey}>} [o.remoteAccount]  a usable OpenAI-compatible account
		 * @param {object} [o.env]               environment of the children (the helper finds the shared model store)
		 * @param {object} [o.limits]            overrides of DEFAULT_LIMITS (tests)
		 * @param {(dir: string) => Promise<boolean>} [o.removeDir]  work-folder cleanup (removeWorkDir)
		 */
	constructor({ islandRoot, setting, ffmpeg, helper, remoteAccount, env = process.env, log = () => {}, limits = {}, removeDir }) {
		this.islandRoot = islandRoot;
		this.setting = setting ?? (() => TRANSCRIPTION_DEFAULT);
		this.ffmpeg = ffmpeg;
		this.helper = helper;
		this.remoteAccount = remoteAccount ?? (async () => fail("remote_unavailable"));
		this.env = env;
		this.log = log;
		this.limits = { ...DEFAULT_LIMITS, ...limits };
		// Injectable so a test can prove cleanup never replaces the original error.
		this.removeDir = removeDir ?? ((dir) => removeWorkDir(dir, { log: this.log }));
	}

	/** What Ajustes shows: the setting plus whether the bundled tools are there. Never a URL or a key. */
	status() {
		return { ...this.setting(), ffmpeg: this.ffmpeg ? "available" : "unavailable", local: this.helper ? "available" : "unavailable" };
	}

	/**
	 * Transcribes one media file. Resolves {text, model, durationSec, segments?, chunks?}; rejects with a
	 * TranscriptionError. `signal` cancels (the running child is killed). `deleteMedia` removes the input after.
	 */
	async transcribe(file, { signal, deleteMedia = false } = {}) {
		const regular = typeof file === "string" && path.isAbsolute(file) && (() => {
			try {
				const st = fs.lstatSync(file);
				return st.isFile() && !st.isSymbolicLink();
			} catch {
				return false;
			}
		})();
		let work;
		const job = { signal, deadline: Date.now() + this.limits.timeoutMs };
		try {
			if (!regular) fail("bad_media");
			if (signal?.aborted) fail("cancelled");
			if (!this.ffmpeg) fail("ffmpeg_unavailable");
			const setting = this.setting();
			if (setting.mode !== "remote" && !this.helper) fail("local_unavailable");
			work = ensurePrivateDir(path.join(ensurePrivateDir(path.join(this.islandRoot, "minikodas", "transcribe")), randomUUID()));
			const wav = path.join(work, "audio.wav");
			await this.run(this.ffmpeg, [
				"-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-format_whitelist", INPUT_FORMATS,
				"-codec_whitelist", INPUT_CODECS,
				"-i", `file:${file}`, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
				"-ac", "1", "-ar", "16000", "-t", String(this.limits.maxSeconds + 1), "-c:a", "pcm_s16le", "-f", "wav", "-y", wav,
			], job, { label: "ffmpeg", failCode: "bad_media", cwd: work });
			const seconds = wavSeconds(wav);
			if (seconds > this.limits.maxSeconds) fail("too_long");
			if (deleteMedia) removeRegular(file); // the media is no longer needed once its audio is out
			return setting.mode === "remote" ? await this.remote(setting, wav, seconds, work, job) : await this.local(setting, wav, work, job);
		} catch (error) {
			if (error instanceof TranscriptionError) throw error;
			this.log("transcription: unexpected failure");
			throw new TranscriptionError("failed");
		} finally {
			if (deleteMedia && regular) removeRegular(file);
			// Cleanup never replaces the error above: the helper may have been killed a moment ago and Windows keeps its
			// folder busy (EBUSY), so `removeWorkDir` retries and gives up quietly.
			if (work) {
				try {
					await this.removeDir(work);
				} catch {
					this.log("transcription: could not remove its work folder");
				}
			}
		}
	}

	async local(setting, wav, work, job) {
		const model = LOCAL_MODELS[setting.mode];
		const remainingSec = Math.max(1, Math.ceil((job.deadline - Date.now()) / 1000));
		const { code, stdout } = await this.run(this.helper, [
			"transcribe", "--model", model, "--language", setting.language,
			"--timeout-sec", String(remainingSec), "--max-seconds", String(this.limits.maxSeconds), wav,
		], job, { label: "abito-transcribe", capture: true, allowFailure: true, cwd: work });
		let out;
		try {
			const line = stdout.toString("utf8").trim();
			if (line.includes("\n")) throw new Error("more than one line");
			out = JSON.parse(line);
		} catch {
			if (code !== 0) {
				this.log(`transcription: abito-transcribe exited ${code}`);
				fail("failed");
			}
			fail("invalid_response");
		}
		if (code !== 0 || typeof out?.error === "string") {
			const mapped = { model_missing: "model_missing", too_long: "too_long", timeout: "timeout", bad_audio: "bad_media", bad_input: "bad_media" }[out?.error] ?? "failed";
			this.log(`transcription: abito-transcribe answered ${mapped}`);
			fail(mapped);
		}
		if (typeof out?.text !== "string" || !Array.isArray(out.segments)) fail("invalid_response");
		const segments = out.segments
			.filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end) && typeof s?.text === "string")
			.map((s) => ({ start: s.start, end: s.end, text: s.text }));
		return { text: out.text.slice(0, this.limits.maxTextChars), segments, model, durationSec: Number(out.durationSec) || 0 };
	}

	async remote(setting, wav, seconds, work, job) {
		let account;
		try {
			account = await this.remoteAccount(setting.remote.accountId);
		} catch {
			fail("remote_unavailable");
		}
		const base = validateCustomBaseUrl(account?.baseUrl);
		if (!base || typeof account?.apiKey !== "string" || account.apiKey === "") fail("remote_unavailable");
		const texts = [];
		let index = 0;
		for (let start = 0; start < seconds; start += CHUNK_SECONDS) {
			const chunk = path.join(work, `chunk-${index}.ogg`);
			await this.run(this.ffmpeg, [
				"-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-format_whitelist", "wav",
				"-codec_whitelist", INPUT_CODECS,
				"-ss", String(start), "-t", String(CHUNK_SECONDS), "-i", `file:${wav}`,
				"-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "-y", chunk,
				// libopus is an ENCODER: `-codec_whitelist` filters decoders only (verified on ffmpeg 8.0.1).
			], job, { label: "ffmpeg", failCode: "failed", cwd: work });
			const size = fs.statSync(chunk).size;
			if (size > MAX_CHUNK_BYTES) fail("too_large");
			const data = fs.readFileSync(chunk);
			removeRegular(chunk);
			const text = await this.post(base, account.apiKey, setting, { name: `chunk-${index}.ogg`, type: "audio/ogg", data }, job);
			if (text.trim() !== "") texts.push(text.trim());
			index += 1;
		}
		return { text: texts.join(" ").slice(0, this.limits.maxTextChars), model: setting.remote.model, durationSec: seconds, chunks: index };
	}

	/** One POST {base}/audio/transcriptions; resolves the JSON `.text`. No redirect is ever followed. */
	post(base, apiKey, setting, file, job) {
		const url = new URL(`${base}/audio/transcriptions`);
		const client = url.protocol === "https:" ? https : http;
		const { body, contentType } = multipart([["model", setting.remote.model], ["language", setting.language], ["response_format", "json"]], file);
		const timeoutMs = Math.min(this.limits.requestTimeoutMs, Math.max(1, job.deadline - Date.now()));
		return new Promise((resolve, reject) => {
			let settled = false;
			let request;
			const finish = (fn, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				job.signal?.removeEventListener("abort", onAbort);
				request?.destroy();
				fn(value);
			};
			const onAbort = () => finish(reject, new TranscriptionError("cancelled"));
			const timer = setTimeout(() => finish(reject, new TranscriptionError("timeout")), timeoutMs);
			if (job.signal?.aborted) return onAbort();
			job.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				request = client.request({
					protocol: url.protocol,
					hostname: url.hostname.replace(/^\[|\]$/g, ""),
					port: url.port,
					path: url.pathname,
					method: "POST",
					agent: false,
					headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": contentType, "content-length": body.length },
				}, (res) => {
					const status = res.statusCode ?? 0;
					if (status === 401 || status === 403) {
						this.log(`transcription: remote answered ${status}`);
						return finish(reject, new TranscriptionError("remote_auth"));
					}
					if (status < 200 || status >= 300) {
						this.log(`transcription: remote answered ${status}`);
						return finish(reject, new TranscriptionError("remote_failed"));
					}
					const chunks = [];
					let bytes = 0;
					res.on("data", (c) => {
						bytes += c.length;
						if (bytes > this.limits.maxResponseBytes) return finish(reject, new TranscriptionError("invalid_response"));
						chunks.push(c);
					});
					res.on("end", () => {
						let doc;
						try {
							doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						} catch {
							return finish(reject, new TranscriptionError("invalid_response"));
						}
						if (typeof doc?.text !== "string") return finish(reject, new TranscriptionError("invalid_response"));
						finish(resolve, doc.text);
					});
					res.on("error", () => finish(reject, new TranscriptionError("remote_failed")));
				});
				request.on("error", () => finish(reject, new TranscriptionError("remote_failed")));
				request.end(body);
			} catch {
				finish(reject, new TranscriptionError("remote_failed"));
			}
		});
	}

	/**
	 * Runs one bundled tool (shell:false, fixed argv). Resolves {code, stdout}; kills the child on cancel or at the
	 * job deadline. stderr is drained and dropped (it can name the media), never logged. A killed child is gone (its
	 * `close` seen, or the grace period over) before the promise settles, so cleanup never races a live process.
	 */
	run(tool, args, job, { label, capture = false, allowFailure = false, failCode = "failed", cwd }) {
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
			// Kill, then wait for `close` (bounded): Windows keeps a just-killed child's folder busy until it really exits.
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
			const onAbort = () => stopAndSettle(reject, new TranscriptionError("cancelled"));
			const timer = setTimeout(() => {
				this.log(`transcription: ${label} timed out`);
				stopAndSettle(reject, new TranscriptionError("timeout"));
			}, Math.max(1, job.deadline - Date.now()));
			if (job.signal?.aborted) return onAbort();
			job.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				child = spawn(tool.command, [...(tool.commandArgs ?? []), ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: this.env, cwd });
			} catch {
				this.log(`transcription: ${label} could not start`);
				return settle(reject, new TranscriptionError("failed"));
			}
			child.stdout.on("data", (c) => {
				if (!capture) return;
				outBytes += c.length;
				if (outBytes > this.limits.maxHelperOutputBytes) return stopAndSettle(reject, new TranscriptionError("invalid_response"));
				out.push(c);
			});
			child.stderr.resume();
			child.on("error", () => {
				this.log(`transcription: ${label} could not start`);
				stopAndSettle(reject, new TranscriptionError("failed"));
			});
			child.on("close", (code) => {
				// A child Koda killed reports its `close` AFTER the transcription settled (with `null`): that exit line
				// would claim a failure the run already told apart.
				if (settled) return;
				if (code !== 0 && !allowFailure) {
					this.log(`transcription: ${label} exited ${code}`);
					return settle(reject, new TranscriptionError(failCode));
				}
				settle(resolve, { code, stdout: Buffer.concat(out) });
			});
		});
	}
}

module.exports = { Transcriber, TranscriptionError, bundledTools, wavSeconds, removeWorkDir, CHUNK_SECONDS, MAX_CHUNK_BYTES, INPUT_FORMATS, INPUT_CODECS, DEFAULT_LIMITS, USER_TEXT };
