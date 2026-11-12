"use strict";

// K2-13 T2c-2 (S6, S7 transcription part, S8, S9, S15, S16): the daemon's transcription service. Offline: a fake
// ffmpeg, a fake `abito-transcribe` helper and a fake loopback OpenAI-compatible server; no model, no NaN, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { validateTranscriptionSetting, TRANSCRIPTION_DEFAULT } = require("../src/minikodas/transcribe-setting.cjs");
const { Transcriber, TranscriptionError, bundledTools, removeWorkDir, CHUNK_SECONDS, MAX_CHUNK_BYTES, TRANSCRIPTION_BUDGET_MS, TRANSCRIPTION_BUDGET_MINUTES } = require("../src/minikodas/transcribe.cjs");
const { MinikodaService } = require("../src/minikodas/service.cjs");
const config = require("../src/config.cjs");
const P = require("../src/protocol.cjs");

const FIX = path.join(__dirname, "fixtures", "minikodas");
const FAKE_FFMPEG = path.join(FIX, "fake-ffmpeg.cjs");
const FAKE_HELPER = path.join(FIX, "fake-transcribe.cjs");
const FAKE_PI = path.join(FIX, "fake-pi.cjs");
const KEY = "sk-test-transcribe-0123456789abcdef";
const posix = process.platform !== "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await sleep(10);
	}
	assert.ok(await fn(), "waitFor timed out");
}

function tmp(t) {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-tr-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
	return base;
}
function media(dir, seconds, name = "video.mp4") {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify({ seconds }));
	return file;
}
function allFiles(dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...allFiles(p));
		else out.push(p);
	}
	return out;
}
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A Transcriber wired to the fakes; `env` selects their modes. */
function transcriber(t, base, { setting = TRANSCRIPTION_DEFAULT, env = {}, remote, limits = {}, logs = [], removeDir } = {}) {
	const island = path.join(base, "island");
	fs.mkdirSync(island, { recursive: true, mode: 0o700 });
	const ffLog = path.join(base, "ffmpeg.log");
	const helperLog = path.join(base, "helper.log");
	const tr = new Transcriber({
		islandRoot: island,
		setting: () => setting,
		ffmpeg: { command: process.execPath, commandArgs: [FAKE_FFMPEG] },
		helper: { command: process.execPath, commandArgs: [FAKE_HELPER] },
		remoteAccount: remote ?? (async () => { throw new TranscriptionError("remote_unavailable"); }),
		env: { PATH: process.env.PATH, FAKE_FFMPEG_LOG: ffLog, FAKE_HELPER_LOG: helperLog, ...env },
		log: (line) => logs.push(line),
		limits,
		...(removeDir ? { removeDir } : {}),
	});
	return { tr, island, ffLog, helperLog, logs, workRoot: path.join(island, "minikodas", "transcribe") };
}

/** A loopback OpenAI-compatible server; `handler(req, body, n)` answers. Records every request. */
async function fakeServer(t, handler) {
	const seen = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			seen.push({ method: req.method, url: req.url, headers: req.headers, body });
			handler(req, res, body, seen.length);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => new Promise((r) => server.close(r)));
	return { base: `http://127.0.0.1:${server.address().port}/v1`, seen };
}
const field = (body, name) => {
	const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body.toString("latin1"));
	return m ? m[1] : undefined;
};

// ---------- the setting ----------

test("setting: local Parakeet by default; whisper-turbo and remote are the alternatives; anything else is refused", () => {
	assert.deepEqual(TRANSCRIPTION_DEFAULT, { mode: "local-parakeet", language: "es" });
	assert.deepEqual(validateTranscriptionSetting({ mode: "local-whisper-turbo", language: "en" }), { mode: "local-whisper-turbo", language: "en" });
	assert.deepEqual(validateTranscriptionSetting({ mode: "local-parakeet" }), { mode: "local-parakeet", language: "es" });
	assert.deepEqual(validateTranscriptionSetting({ mode: "remote", remote: { accountId: "nan", model: "whisper" } }), { mode: "remote", language: "es", remote: { accountId: "nan", model: "whisper" } });
	for (const bad of [
		null, [], "local-parakeet", {}, { mode: "local-whisper-small" }, { mode: "local-parakeet", language: "auto" }, { mode: "local-parakeet", language: "xx" },
		{ mode: "local-parakeet", extra: 1 }, { mode: "remote" }, { mode: "remote", remote: { accountId: "nan" } }, { mode: "remote", remote: { accountId: "../x", model: "whisper" } },
		{ mode: "remote", remote: { accountId: "nan", model: "wh\nisper" } }, { mode: "remote", remote: { accountId: "nan", model: "w", baseUrl: "https://evil" } },
		{ mode: "local-parakeet", remote: { accountId: "nan", model: "whisper" } },
	]) assert.throws(() => validateTranscriptionSetting(bad), /transcription/, JSON.stringify(bad));
});

test("setting: stored in the daemon config (0600), default when absent, a bad stored value is a config error", (t) => {
	const base = tmp(t);
	const island = path.join(base, "island");
	fs.mkdirSync(island, { mode: 0o700 });
	assert.deepEqual(config.loadConfig(island, { env: {} }).transcription, TRANSCRIPTION_DEFAULT);
	const out = config.setTranscription(island, { mode: "remote", language: "es", remote: { accountId: "nan", model: "whisper" } });
	assert.equal(out.changed, true);
	assert.deepEqual(config.loadConfig(island, { env: {} }).transcription, { mode: "remote", language: "es", remote: { accountId: "nan", model: "whisper" } });
	const file = path.join(island, "config.json");
	if (posix) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.throws(() => config.setTranscription(island, { mode: "cloud" }), (e) => e.name === "ConfigError" && e.field === "transcription");
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).transcription.mode, "remote", "a refused value changes nothing");
	fs.writeFileSync(file, JSON.stringify({ transcription: { mode: "x" } }), { mode: 0o600 });
	assert.throws(() => config.loadConfig(island, { env: {} }), (e) => e.field === "transcription");
});

test("protocol: transcription_get/set are validated; the frame carries the setting and availability, never a URL or key", () => {
	const parse = P.validateClientFrame;
	assert.deepEqual(parse({ type: "transcription_get" }), { type: "transcription_get" });
	assert.deepEqual(parse({ type: "transcription_set", setting: { mode: "local-whisper-turbo", language: "es" } }), { type: "transcription_set", setting: { mode: "local-whisper-turbo", language: "es" } });
	assert.equal(parse({ type: "transcription_set", setting: { mode: "remote" } }), undefined);
	assert.equal(parse({ type: "transcription_set" }), undefined);
	const frame = P.transcriptionFrame({ mode: "remote", language: "es", remote: { accountId: "nan", model: "whisper", baseUrl: "https://x", apiKey: KEY }, ffmpeg: "available", local: "unavailable" });
	assert.deepEqual(frame, { type: "transcription", setting: { mode: "remote", language: "es", remote: { accountId: "nan", model: "whisper" } }, ffmpeg: "available", local: "unavailable" });
	assert.ok(!JSON.stringify(frame).includes(KEY));
	assert.throws(() => P.transcriptionFrame({ mode: "nope", ffmpeg: "available", local: "available" }));
});

// ---------- the bundled tools ----------

test("bundled tools: fixed paths beside the daemon package, never PATH; macOS reports ffmpeg unavailable (out of scope)", (t) => {
	const base = tmp(t);
	const root = path.join(base, "prefix");
	fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
	const linux = bundledTools({ installRoot: root, platform: "linux" });
	assert.deepEqual(linux, { ffmpeg: undefined, helper: undefined }, "nothing there: unavailable, no fallback");
	fs.writeFileSync(path.join(root, "runtime", "ffmpeg"), "bin", { mode: 0o755 });
	fs.writeFileSync(path.join(root, "abito-transcribe"), "bin", { mode: 0o755 });
	assert.deepEqual(bundledTools({ installRoot: root, platform: "linux" }), { ffmpeg: path.join(root, "runtime", "ffmpeg"), helper: path.join(root, "abito-transcribe") });
	assert.deepEqual(bundledTools({ installRoot: root, platform: "darwin" }).ffmpeg, undefined, "darwin-arm64: ffmpeg is not bundled yet");
	fs.writeFileSync(path.join(root, "runtime", "ffmpeg.exe"), "bin");
	fs.writeFileSync(path.join(root, "abito-transcribe.exe"), "bin");
	assert.deepEqual(bundledTools({ installRoot: root, platform: "win32" }), { ffmpeg: path.join(root, "runtime", "ffmpeg.exe"), helper: path.join(root, "abito-transcribe.exe") });
	if (posix) {
		fs.rmSync(path.join(root, "runtime", "ffmpeg"));
		fs.symlinkSync("/usr/bin/true", path.join(root, "runtime", "ffmpeg"));
		assert.equal(bundledTools({ installRoot: root, platform: "linux" }).ffmpeg, undefined, "a symlink is never run");
		fs.rmSync(path.join(root, "abito-transcribe"));
		fs.writeFileSync(path.join(root, "abito-transcribe"), "bin", { mode: 0o644 });
		assert.equal(bundledTools({ installRoot: root, platform: "linux" }).helper, undefined, "not executable");
	}
});

test("ffmpeg unavailable (macOS, or not bundled): a clear ffmpeg_unavailable, nothing spawned, the media is still deleted", async (t) => {
	const base = tmp(t);
	const island = path.join(base, "island");
	fs.mkdirSync(island);
	const tr = new Transcriber({ islandRoot: island, setting: () => TRANSCRIPTION_DEFAULT, ffmpeg: undefined, helper: { command: process.execPath, commandArgs: [FAKE_HELPER] }, env: {}, log: () => {} });
	assert.deepEqual(tr.status(), { mode: "local-parakeet", language: "es", ffmpeg: "unavailable", local: "available" });
	const file = media(path.join(base, "in"), 10);
	await assert.rejects(tr.transcribe(file, { deleteMedia: true }), (e) => e instanceof TranscriptionError && e.code === "ffmpeg_unavailable");
	assert.equal(fs.existsSync(file), false);
});

// ---------- local ----------

test("S15/S16 local Parakeet (default): ffmpeg extracts 16 kHz mono with a fixed argv, the helper transcribes, temp files are gone", async (t) => {
	const base = tmp(t);
	const { tr, ffLog, helperLog, workRoot } = transcriber(t, base);
	const file = media(path.join(base, "in"), 42);
	const out = await tr.transcribe(file, { deleteMedia: true });
	assert.equal(out.text, "hola desde parakeet-tdt-0.6b-v3-int8 en es");
	assert.equal(out.model, "parakeet-tdt-0.6b-v3-int8");
	assert.equal(Math.round(out.durationSec), 42);
	const [ff] = lines(ffLog);
	assert.deepEqual(ff.slice(0, 6), ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file"]);
	assert.ok(ff.includes("-format_whitelist"));
	assert.equal(ff[ff.indexOf("-i") + 1], `file:${file}`, "the input goes through the file: protocol only");
	for (const [flag, value] of [["-ac", "1"], ["-ar", "16000"], ["-c:a", "pcm_s16le"], ["-map", "0:a:0"]]) assert.equal(ff[ff.indexOf(flag) + 1], value, flag);
	const [helper] = lines(helperLog);
	assert.deepEqual(helper.slice(0, 5), ["transcribe", "--model", "parakeet-tdt-0.6b-v3-int8", "--language", "es"]);
	assert.ok(path.isAbsolute(helper.at(-1)));
	assert.equal(fs.existsSync(file), false, "the downloaded media is deleted after");
	assert.deepEqual(allFiles(workRoot), [], "no extracted audio is left behind");
});

test("S9 ffmpeg may only decode audio: -codec_whitelist names the decoders the accepted containers carry", async (t) => {
	// ffmpeg's -codec_whitelist filters DECODERS and matches exact names (no globs): `ffmpeg -h full` and a real run
	// on this machine both confirm it, and `*` in that list blocks everything. The accepted containers (INPUT_FORMATS)
	// carry AAC, Opus, MP3, Vorbis, FLAC, Apple lossless and PCM, so those are what the list must name.
	const base = tmp(t);
	const { tr, ffLog } = transcriber(t, base);
	await tr.transcribe(media(path.join(base, "in"), 3)); // extract: <media> -> 16 kHz mono WAV
	assertCodecList(lines(ffLog)[0]);
	const srv = await fakeServer(t, (req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ text: "ok" }));
	});
	const remote = transcriber(t, base, {
		setting: { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper" } },
		remote: async () => ({ baseUrl: srv.base, apiKey: KEY }),
	});
	const before = lines(ffLog).length;
	await remote.tr.transcribe(media(path.join(base, "in2"), 200)); // extract + 2 chunks: the WAV is decoded too
	const calls = lines(ffLog).slice(before);
	assert.equal(calls.length, 3, "extract plus two 175 s chunks");
	for (const argv of calls) assertCodecList(argv);
});

/** Every ffmpeg call must allow exactly the audio decoders Koda needs, before -i (it is an input decoder option). */
function assertCodecList(argv) {
	const at = argv.indexOf("-codec_whitelist");
	assert.ok(at >= 0, `ffmpeg runs with a decoder whitelist: ${argv.join(" ")}`);
	assert.ok(at < argv.indexOf("-i"), "-codec_whitelist applies to the input decoder, so it comes before -i");
	const list = argv[at + 1].split(",");
	for (const needed of ["aac", "aac_fixed", "aac_latm", "opus", "mp3", "mp3float", "mp2", "vorbis", "flac", "alac", "ac3", "eac3",
		"pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8", "pcm_s16be", "pcm_s24be", "pcm_s32be", "pcm_alaw", "pcm_mulaw"]) {
		assert.ok(list.includes(needed), `${needed} is an audio decoder of the accepted containers`);
	}
	for (const never of ["h264", "hevc", "av1", "vp9", "vp8", "theora", "dts", "truehd", "subrip", "ass"]) assert.ok(!list.includes(never), `${never} is not an audio decoder Koda needs`);
	assert.ok(!list.some((name) => name.includes("*")), "this option has no globbing: a star would allow nothing at all");
}

test("S16 local whisper-turbo: the helper gets whisper-turbo with the language fixed", async (t) => {
	const base = tmp(t);
	const { tr, helperLog } = transcriber(t, base, { setting: { mode: "local-whisper-turbo", language: "en" } });
	const out = await tr.transcribe(media(path.join(base, "in"), 5));
	assert.equal(out.text, "hola desde whisper-turbo en en");
	assert.deepEqual(lines(helperLog)[0].slice(0, 5), ["transcribe", "--model", "whisper-turbo", "--language", "en"]);
});

test("local failures map to closed codes and never leave files: model_missing, garbage, crash, ffmpeg failure, too long", async (t) => {
	const base = tmp(t);
	const cases = [
		[{ FAKE_HELPER_MODE: "model_missing" }, "model_missing"],
		[{ FAKE_HELPER_MODE: "timeout" }, "budget_exceeded"], // the helper's deadline IS the remaining budget (S17)
		[{ FAKE_HELPER_MODE: "garbage" }, "invalid_response"],
		[{ FAKE_HELPER_MODE: "crash" }, "failed"],
		[{ FAKE_HELPER_MODE: "huge" }, "invalid_response"],
		[{ FAKE_FFMPEG_MODE: "fail" }, "bad_media"],
	];
	for (const [env, code] of cases) {
		const logs = [];
		const { tr, workRoot } = transcriber(t, base, { env, logs });
		const file = media(path.join(base, "in"), 10);
		await assert.rejects(tr.transcribe(file, { deleteMedia: true }), (e) => e.code === code, JSON.stringify(env));
		assert.equal(fs.existsSync(file), false);
		assert.deepEqual(allFiles(workRoot), []);
		assert.ok(!logs.join("\n").includes(file), "the media path is never logged");
	}
	const { tr } = transcriber(t, base, { limits: { maxSeconds: 30 } });
	await assert.rejects(tr.transcribe(media(path.join(base, "in"), 31)), (e) => e.code === "too_long");
});

test("input: only a regular file is accepted (no symlink, no directory, no relative path)", async (t) => {
	const base = tmp(t);
	const { tr, ffLog } = transcriber(t, base);
	const file = media(path.join(base, "in"), 3);
	await assert.rejects(tr.transcribe("relative.mp4"), (e) => e.code === "bad_media");
	await assert.rejects(tr.transcribe(path.join(base, "in")), (e) => e.code === "bad_media");
	if (posix) {
		const link = path.join(base, "in", "link.mp4");
		fs.symlinkSync(file, link);
		await assert.rejects(tr.transcribe(link, { deleteMedia: true }), (e) => e.code === "bad_media");
		assert.ok(fs.existsSync(file), "deleteMedia never deletes through a symlink");
	}
	assert.deepEqual(lines(ffLog), [], "ffmpeg never ran");
});

test("cancellation and budget: an aborted or slow transcription kills its child and cleans up", async (t) => {
	const base = tmp(t);
	for (const env of [{ FAKE_HELPER_MODE: "hang" }, { FAKE_FFMPEG_MODE: "hang" }]) {
		const { tr, workRoot } = transcriber(t, base, { env });
		const controller = new AbortController();
		const file = media(path.join(base, "in"), 10);
		const p = tr.transcribe(file, { signal: controller.signal, deleteMedia: true });
		await sleep(300);
		controller.abort("paused");
		await assert.rejects(p, (e) => e.code === "cancelled");
		assert.equal(fs.existsSync(file), false);
		assert.deepEqual(allFiles(workRoot), []);
		const slow = transcriber(t, base, { env, limits: { timeoutMs: 400 } });
		// S17: an exhausted transcription budget (here injected small) is its own code, not a slow single request.
		await assert.rejects(slow.tr.transcribe(media(path.join(base, "in"), 10)), (e) => e.code === "budget_exceeded");
	}
});

test("K2-13 Windows: a work folder removed right after a killed child is retried, and cleanup never throws", async (t) => {
	// Windows keeps a just-killed child's folder busy for a moment, so rmSync throws EBUSY. Cleanup is best effort:
	// a few short retries, then give up silently (logged) — it must never throw and replace the real error.
	const base = tmp(t);
	const dir = path.join(base, "work");
	fs.mkdirSync(dir, { recursive: true });
	const busy = () => Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
	let calls = 0;
	const lockedTwice = (target, options) => {
		calls += 1;
		if (calls < 3) throw busy();
		fs.rmSync(target, options);
	};
	assert.equal(await removeWorkDir(dir, { fs: { rmSync: lockedTwice }, delayMs: 1 }), true);
	assert.equal(calls, 3, "the two EBUSY answers are retried");
	assert.equal(fs.existsSync(dir), false);
	const stuck = path.join(base, "stuck");
	fs.mkdirSync(stuck, { recursive: true });
	const logs = [];
	assert.equal(await removeWorkDir(stuck, { fs: { rmSync: () => { throw busy(); } }, delayMs: 1, log: (line) => logs.push(line) }), false);
	assert.match(logs.join("\n"), /work folder/);
});

test("K2-13: a cleanup that cannot remove the work folder never replaces the transcription's own error code", async (t) => {
	const base = tmp(t);
	const { tr } = transcriber(t, base, {
		env: { FAKE_FFMPEG_MODE: "fail" },
		removeDir: async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
	});
	const file = media(path.join(base, "in"), 5);
	await assert.rejects(tr.transcribe(file, { deleteMedia: true }), (error) => error.code === "bad_media", "ffmpeg's failure stands");
	assert.equal(fs.existsSync(file), false, "the media is still deleted");
});

// ---------- remote ----------

test("S7/S9 remote: ≤180 s OGG chunks POSTed to {base}/audio/transcriptions with the account's key; JSON .text joined in order", async (t) => {
	const base = tmp(t);
	const srv = await fakeServer(t, (_req, res, _body, n) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ text: `parte ${n}`, segments: [] }));
	});
	const logs = [];
	const { tr, ffLog, workRoot } = transcriber(t, base, {
		setting: { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper" } },
		remote: async (accountId) => {
			assert.equal(accountId, "gw");
			return { baseUrl: srv.base, apiKey: KEY };
		},
		logs,
	});
	const file = media(path.join(base, "in"), 400);
	const out = await tr.transcribe(file, { deleteMedia: true });
	assert.equal(out.text, "parte 1 parte 2 parte 3");
	assert.equal(out.chunks, 3);
	assert.equal(out.model, "whisper");
	assert.equal(srv.seen.length, 3);
	for (const r of srv.seen) {
		assert.equal(r.method, "POST");
		assert.equal(r.url, "/v1/audio/transcriptions");
		assert.equal(r.headers.authorization, `Bearer ${KEY}`);
		assert.match(r.headers["content-type"], /^multipart\/form-data; boundary=/);
		assert.equal(field(r.body, "model"), "whisper");
		assert.equal(field(r.body, "language"), "es");
		assert.equal(field(r.body, "response_format"), "json");
		assert.match(r.body.toString("latin1"), /filename="chunk-\d+\.ogg"\r\nContent-Type: audio\/ogg/);
		assert.ok(r.body.length <= MAX_CHUNK_BYTES + 4096);
	}
	assert.ok(CHUNK_SECONDS <= 180);
	const chunkCalls = lines(ffLog).filter((a) => a.at(-1).endsWith(".ogg"));
	assert.deepEqual(chunkCalls.map((a) => Number(a[a.indexOf("-ss") + 1])), [0, CHUNK_SECONDS, 2 * CHUNK_SECONDS]);
	for (const a of chunkCalls) {
		assert.ok(Number(a[a.indexOf("-t") + 1]) <= 180);
		assert.equal(a[a.indexOf("-c:a") + 1], "libopus");
		assert.equal(a[a.indexOf("-ac") + 1], "1");
	}
	assert.equal(fs.existsSync(file), false);
	assert.deepEqual(allFiles(workRoot), []);
	assert.ok(!logs.join("\n").includes(KEY), "the key is never logged");
});

test("remote failures: 401 is remote_auth, non-JSON is invalid_response, a redirect is never followed, a slow server times out, an oversized chunk is never sent", async (t) => {
	const base = tmp(t);
	const run = async (handler, { env, limits } = {}) => {
		const srv = await fakeServer(t, handler);
		const logs = [];
		const { tr, workRoot } = transcriber(t, base, { env, limits, logs, setting: { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper" } }, remote: async () => ({ baseUrl: srv.base, apiKey: KEY }) });
		const file = media(path.join(base, "in"), 20);
		const err = await tr.transcribe(file, { deleteMedia: true }).then(() => undefined, (e) => e);
		assert.equal(fs.existsSync(file), false);
		assert.deepEqual(allFiles(workRoot), []);
		assert.ok(!logs.join("\n").includes(KEY));
		assert.ok(!String(err?.message).includes(KEY) && !String(err?.message).includes("127.0.0.1"));
		return { code: err?.code, seen: srv.seen };
	};
	assert.equal((await run((_q, s) => { s.writeHead(401); s.end("{}"); })).code, "remote_auth");
	assert.equal((await run((_q, s) => { s.writeHead(200, { "content-type": "text/plain" }); s.end("hola"); })).code, "invalid_response");
	assert.equal((await run((_q, s) => { s.writeHead(200); s.end(JSON.stringify({ nottext: 1 })); })).code, "invalid_response");
	const redirected = await run((_q, s) => { s.writeHead(302, { location: "http://127.0.0.1:9/steal" }); s.end(); });
	assert.equal(redirected.code, "remote_failed");
	assert.equal(redirected.seen.length, 1);
	assert.equal((await run((_q, s) => { s.writeHead(500); s.end("boom"); })).code, "remote_failed");
	assert.equal((await run(() => {}, { limits: { requestTimeoutMs: 300 } })).code, "timeout");
	const huge = await run((_q, s) => { s.writeHead(200); s.end(JSON.stringify({ text: "x" })); }, { env: { FAKE_FFMPEG_MODE: "huge" } });
	assert.equal(huge.code, "too_large");
	assert.equal(huge.seen.length, 0, "a chunk over 25 MB is never uploaded");
});

test("remote: an unusable account (signed out, not a gateway) is remote_unavailable and nothing is sent", async (t) => {
	const base = tmp(t);
	const { tr } = transcriber(t, base, { setting: { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper" } } });
	await assert.rejects(tr.transcribe(media(path.join(base, "in"), 5)), (e) => e.code === "remote_unavailable");
});

// ---------- the Minikoda run ----------

const MODEL = { provider: "fake", id: "fake-minikoda", accountId: "main" };
const recipe = (over = {}) => ({
	id: "videos",
	name: "Videos",
	when: { manual: true },
	reads: { source: "telegram:canal-x" },
	kit: ["source_read", "inbox_propose"],
	prompt: "Resumí el canal.",
	model: { ...MODEL },
	never: ["buy", "sell", "send", "delete"],
	...over,
});
function accountsFixture(base) {
	const accountsRoot = path.join(base, "accounts");
	fs.mkdirSync(path.join(accountsRoot, "main"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(accountsRoot, "main", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }), { mode: 0o600 });
	return {
		accountsRoot,
		accounts: { listAccounts: () => [{ accountId: "main", provider: "fake", configured: true }], models: async () => [{ provider: "fake", id: "fake-minikoda" }] },
		profiles: { list: () => ({ profiles: [], active: undefined }) },
	};
}
function service(t, base, { env = {}, source, steps, limits, transcriber: custom, runTimeoutMs = 20_000, maxConcurrentRuns } = {}) {
	const fx = accountsFixture(base);
	const scriptFile = path.join(base, "script.json");
	fs.writeFileSync(scriptFile, JSON.stringify({ steps: steps ?? [{ tool: "source_read" }, { text: "Resumen listo." }] }));
	const results = { runs: [], errors: [], addRun: async (r) => { results.runs.push(r); }, addError: async (e) => { results.errors.push(e); } };
	const { tr } = transcriber(t, base, { env, limits });
	const svc = new MinikodaService({
		islandRoot: path.join(base, "island"),
		accounts: fx.accounts,
		profiles: fx.profiles,
		accountsRoot: fx.accountsRoot,
		results,
		minEveryMs: 1,
		runTimeoutMs,
		...(maxConcurrentRuns ? { maxConcurrentRuns } : {}),
		engine: { command: process.execPath, commandArgs: [FAKE_PI, "--script", scriptFile], env: { PATH: process.env.PATH }, startTimeoutMs: 10_000 },
		transcriber: custom ?? tr,
		source,
	});
	t.after(() => svc.stop());
	svc.start();
	return { svc, results, island: path.join(base, "island") };
}

test("S6 a video post is transcribed first: the Minikoda reads the text plus the transcript, and the media is deleted", async (t) => {
	const base = tmp(t);
	let mediaFile;
	const { svc, results, island } = service(t, base, {
		source: async (_recipe, { mediaDir }) => {
			mediaFile = media(mediaDir, 12, "post-1.mp4");
			return { text: "Post del canal: mirá el video.", media: [mediaFile] };
		},
	});
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	assert.equal((await svc.launch("videos")).started, true);
	await waitFor(() => results.runs.length + results.errors.length === 1);
	assert.deepEqual(results.errors, []);
	const source = fs.readFileSync(path.join(island, "minikodas", "engines", "videos", "run", "source.txt"), "utf8");
	assert.match(source, /Post del canal: mirá el video\./);
	assert.match(source, /Transcripción automática \(1 de 1\)/);
	assert.match(source, /hola desde parakeet-tdt-0\.6b-v3-int8 en es/);
	assert.equal(fs.existsSync(mediaFile), false);
	assert.deepEqual(allFiles(path.join(island, "minikodas", "media")), []);
});

test("K2-13: starting the service sweeps its own stale media and transcription folders, and nothing else", async (t) => {
	// A killed run or daemon leaves work files behind; the next start removes them. Only inside minikodas/media and
	// minikodas/transcribe, and an entry is never followed through a symlink.
	const base = tmp(t);
	const island = path.join(base, "island");
	const staleMedia = media(path.join(island, "minikodas", "media", "run-old"), 3, "old.mp4");
	const staleWork = path.join(island, "minikodas", "transcribe", "u-old");
	fs.mkdirSync(staleWork, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(staleWork, "audio.wav"), "x", { mode: 0o600 });
	const loose = path.join(island, "minikodas", "media", "loose-file");
	fs.writeFileSync(loose, "x", { mode: 0o600 });
	const outside = path.join(base, "keep-me.txt");
	fs.writeFileSync(outside, "keep");
	const link = path.join(island, "minikodas", "transcribe", "link");
	if (posix) fs.symlinkSync(outside, link);
	const { svc } = service(t, base); // constructs and starts: the sweep runs here
	await waitFor(() => (!fs.existsSync(staleMedia) && !fs.existsSync(staleWork) && !fs.existsSync(loose)));
	assert.deepEqual(allFiles(path.join(island, "minikodas", "media")), [], "no stale media is left");
	assert.deepEqual(allFiles(path.join(island, "minikodas", "transcribe")), [], "no stale transcription work is left");
	assert.equal(fs.existsSync(outside), true, "a file outside the two folders is never touched");
	assert.ok(svc);
});

test("K2-13: the start sweep never follows a work folder that is a symlink to somewhere else", async (t) => {
	// `minikodas/transcribe` is a known name an attacker (or a stray link) could replace: the sweep lstats the folder
	// itself and skips anything that is not a real directory, so a link's target is never listed, never removed.
	const base = tmp(t);
	const island = path.join(base, "island");
	const outside = path.join(base, "outside");
	fs.mkdirSync(path.join(outside, "keeper"), { recursive: true, mode: 0o700 });
	const precious = path.join(outside, "keeper", "precious.txt");
	fs.writeFileSync(precious, "keep", { mode: 0o600 });
	// A stale entry under media proves the sweep really ran before the assertions below.
	const stale = media(path.join(island, "minikodas", "media", "run-old"), 3, "old.mp4");
	fs.mkdirSync(path.join(island, "minikodas"), { recursive: true, mode: 0o700 });
	if (posix) fs.symlinkSync(outside, path.join(island, "minikodas", "transcribe"));
	else fs.symlinkSync(outside, path.join(island, "minikodas", "transcribe"), "junction");
	const { svc } = service(t, base);
	await waitFor(() => !fs.existsSync(stale));
	await sleep(100);
	assert.equal(fs.existsSync(precious), true, "the target of a symlinked work folder is never swept");
	assert.equal(fs.existsSync(path.join(outside, "keeper")), true, "nor the folder itself");
	assert.ok(svc);
});

test("K2-13: a work folder created while the sweep is running is never swept", async (t) => {
	// Both listings are read before the first await: a run that starts (and so creates its work folder) while the
	// sweep is still removing what a previous daemon left keeps everything it wrote.
	const base = tmp(t);
	const island = path.join(base, "island");
	const stale = media(path.join(island, "minikodas", "media", "run-old"), 3, "old.mp4");
	fs.mkdirSync(path.join(island, "minikodas", "transcribe"), { recursive: true, mode: 0o700 });
	const { svc } = service(t, base);
	const fresh = path.join(island, "minikodas", "transcribe", "u-fresh");
	fs.mkdirSync(fresh, { recursive: true, mode: 0o700 });
	const wav = path.join(fresh, "audio.wav");
	fs.writeFileSync(wav, "x", { mode: 0o600 });
	await waitFor(() => !fs.existsSync(stale));
	await sleep(100);
	assert.equal(fs.existsSync(wav), true, "a transcription that started meanwhile keeps its work folder");
	assert.ok(svc);
});

test("K2-13: a killed tool logs its reason once, never a bogus exit line after the run settled", async (t) => {
	// The `close` of a child Koda killed arrives after the transcription settled (with `null` as its code). Logging it
	// then would claim a failure that already has its own, correct line.
	const base = tmp(t);
	const logs = [];
	const { tr } = transcriber(t, base, { env: { FAKE_FFMPEG_MODE: "hang" }, logs, limits: { timeoutMs: 400 } });
	await assert.rejects(tr.transcribe(media(path.join(base, "in"), 10)), (e) => e.code === "budget_exceeded");
	await sleep(300);
	assert.deepEqual(logs.filter((l) => /exited/.test(l)), [], "no exit line after the run settled");
	assert.ok(logs.some((l) => /timed out/.test(l)), `the real reason is logged: ${JSON.stringify(logs)}`);
});

test("S6 a transcription failure is a clear «Hoy» error and the Minikoda's engine never starts", async (t) => {
	const base = tmp(t);
	let mediaFile;
	const { svc, results, island } = service(t, base, {
		env: { FAKE_HELPER_MODE: "model_missing" },
		source: async (_recipe, { mediaDir }) => {
			mediaFile = media(mediaDir, 12, "post-1.mp4");
			return { text: "Post", media: [mediaFile] };
		},
	});
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	await svc.launch("videos");
	await waitFor(() => results.errors.length === 1);
	assert.equal(results.runs.length, 0);
	assert.match(results.errors[0].text, /falló \(transcripción: el modelo local no está descargado/);
	assert.equal(svc.get("videos").lastRun.reason, "transcription");
	assert.equal(fs.existsSync(path.join(island, "minikodas", "engines", "videos", "run", "source.txt")), false, "the engine never ran");
	assert.equal(fs.existsSync(mediaFile), false);
});

test("S17 transcription has its own 30-minute budget, separate from the run's engine budget", async (t) => {
	// The human's decision (L31, S17): transcription time does NOT count toward the 300 s run budget; it has its own
	// 30 min per run. When it runs out the helper is killed, the temp media and work folder are removed, the engine
	// never starts, and «Hoy» says the video was too long to transcribe in time.
	assert.equal(TRANSCRIPTION_BUDGET_MINUTES, 30);
	assert.equal(TRANSCRIPTION_BUDGET_MS, 30 * 60 * 1000);
	const base = tmp(t);
	const pidFile = path.join(base, "helper.pid");
	let mediaFile;
	const { svc, results, island } = service(t, base, {
		env: { FAKE_HELPER_MODE: "hang", FAKE_HELPER_PID: pidFile },
		limits: { timeoutMs: 600 }, // the injected budget stands in for the 30 min
		maxConcurrentRuns: 1,
		source: async (_recipe, { mediaDir }) => {
			mediaFile = media(mediaDir, 12, "post-1.mp4");
			return { text: "Post del canal", media: [mediaFile] };
		},
	});
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	await svc.createDraft(recipe({ id: "otro", name: "Otro" }));
	await svc.approveCreate("otro");
	assert.equal((await svc.launch("videos")).started, true);
	await waitFor(() => fs.existsSync(pidFile));
	const helperPid = Number(fs.readFileSync(pidFile, "utf8"));
	// The run slot is held while the video is transcribed: the 2-concurrent-runs rule counts a transcribing run.
	assert.deepEqual(await svc.launch("otro"), { started: false, reason: "busy" });
	await waitFor(() => results.errors.length === 1);
	assert.equal(results.runs.length, 0);
	assert.match(results.errors[0].text, /falló \(transcripción: el video tardó más de 30 minutos en transcribirse; no se resumió\)/);
	assert.equal(svc.get("videos").lastRun.reason, "transcription");
	assert.equal(fs.existsSync(mediaFile), false, "the temp media is deleted");
	assert.deepEqual(allFiles(path.join(island, "minikodas", "transcribe")), [], "the work folder is gone");
	assert.equal(fs.existsSync(path.join(island, "minikodas", "engines", "videos", "run", "source.txt")), false, "the engine never started");
	const alive = () => { try { process.kill(helperPid, 0); return true; } catch { return false; } };
	await waitFor(() => !alive());
});

test("S17 the run's engine budget starts only after the transcription ends", async (t) => {
	// runMinikoda() is called after the source (and its transcripts) is ready, so its OWN clock starts there. A
	// transcription longer than the engine budget must not count against it; the same budget still bounds the engine.
	const base = tmp(t);
	const slowMs = 4000;
	const slow = { transcribe: async () => { await sleep(slowMs); return { text: "transcrito despacio" }; } };
	const transcribing = async (_recipe, { mediaDir }) => ({ text: "Post del canal", media: [media(mediaDir, 12)] });
	const { svc, results, island } = service(t, base, { runTimeoutMs: 3000, transcriber: slow, source: transcribing });
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	assert.equal((await svc.launch("videos")).started, true);
	await waitFor(() => results.runs.length + results.errors.length === 1, 20_000);
	assert.deepEqual(results.errors, [], "a 4 s transcription does not spend the 3 s engine budget");
	assert.equal(results.runs.length, 1);
	assert.equal(svc.get("videos").lastRun.outcome, "done");
	assert.match(fs.readFileSync(path.join(island, "minikodas", "engines", "videos", "run", "source.txt"), "utf8"), /transcrito despacio/);
	// Negative control: the same engine budget does bound the engine once the transcription is over.
	const control = path.join(base, "control");
	fs.mkdirSync(control);
	const hang = service(t, control, { runTimeoutMs: 800, transcriber: { transcribe: async () => ({ text: "listo" }) }, steps: [{ hang: true }], source: transcribing });
	await hang.svc.createDraft(recipe());
	await hang.svc.approveCreate("videos");
	assert.equal((await hang.svc.launch("videos")).started, true);
	await waitFor(() => hang.results.errors.length === 1);
	assert.match(hang.results.errors[0].text, /falló \(timeout\)/);
});

test("S17 the remote path shares that one budget: the budget expiring is budget_exceeded, one slow chunk is timeout", async (t) => {
	// The same named constant bounds every remote request; only the request's own 180 s keeps the generic `timeout`.
	const base = tmp(t);
	const run = async (limits) => {
		const srv = await fakeServer(t, () => {}); // accepts the request and never answers
		const { tr, workRoot } = transcriber(t, base, {
			setting: { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper" } },
			remote: async () => ({ baseUrl: srv.base, apiKey: KEY }),
			limits,
		});
		const file = media(path.join(base, `in-${limits.timeoutMs ?? "default"}-${limits.requestTimeoutMs ?? 0}`), 10);
		const code = await tr.transcribe(file, { deleteMedia: true }).then(() => undefined, (e) => e.code);
		assert.equal(fs.existsSync(file), false);
		assert.deepEqual(allFiles(workRoot), []);
		return code;
	};
	assert.equal(await run({ timeoutMs: 600 }), "budget_exceeded", "the transcription budget ran out first");
	assert.equal(await run({ requestTimeoutMs: 400 }), "timeout", "one slow request keeps its own code");
});

test("S6 a media path outside the run's media folder is refused (never transcribed, never deleted)", async (t) => {
	const base = tmp(t);
	const outside = media(path.join(base, "elsewhere"), 3);
	const { svc, results } = service(t, base, { source: async () => ({ text: "Post", media: [outside] }) });
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	await svc.launch("videos");
	await waitFor(() => results.errors.length === 1);
	assert.match(results.errors[0].text, /transcripción/);
	assert.ok(fs.existsSync(outside), "a file the run does not own is never deleted");
});

test("pause and delete cancel a transcription in flight; the media is deleted and the run is reported", async (t) => {
	const base = tmp(t);
	for (const how of ["pause", "delete"]) {
		const dir = path.join(base, how);
		fs.mkdirSync(dir);
		let mediaFile;
		const { svc, results } = service(t, dir, {
			env: { FAKE_HELPER_MODE: "hang" },
			source: async (_recipe, { mediaDir }) => {
				mediaFile = media(mediaDir, 12, "post-1.mp4");
				return { text: "Post", media: [mediaFile] };
			},
		});
		await svc.createDraft(recipe());
		await svc.approveCreate("videos");
		await svc.launch("videos");
		await waitFor(() => mediaFile && fs.existsSync(mediaFile) === false ? true : svc.running.size === 1);
		await sleep(300);
		if (how === "pause") await svc.cancelRuns("paused");
		else await svc.delete("videos");
		await waitFor(() => results.errors.length === 1);
		assert.match(results.errors[0].text, how === "pause" ? /falló \(paused\)/ : /falló \(cancelled\)/);
		assert.equal(fs.existsSync(mediaFile), false);
	}
});

// ---------- the daemon ----------

const net = require("node:net");
const FAKE_AGENT = path.join(__dirname, "fixtures", "fake-agent.cjs");
const FAKE_AUTH = path.join(__dirname, "fixtures", "fake-auth.cjs");

async function daemonWith(t, base, { platform, transcriberOptions } = {}) {
	const { Daemon, readSession } = require("../src/daemon.cjs");
	const root = path.join(base, "i");
	fs.mkdirSync(path.join(root, "accounts", "gw"), { recursive: true, mode: 0o700 });
	fs.chmodSync(path.join(root, "accounts"), 0o700);
	// A custom (OpenAI-compatible) gateway account the user already has: Base URL + key live in the account.
	fs.writeFileSync(path.join(root, "accounts", "gw", "account.json"), JSON.stringify({ accountId: "gw", label: "Gateway", provider: "custom-gw", authMethod: "api_key", configured: true, createdAt: "2026-11-12T00:00:00.000Z", kind: "custom" }), { mode: 0o600 });
	fs.writeFileSync(path.join(root, "accounts", "gw", "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: KEY } }), { mode: 0o600 });
	fs.writeFileSync(path.join(root, "accounts", "gw", "models.json"), JSON.stringify({ providers: { "custom-gw": { baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "whisper" }] } } }), { mode: 0o600 });
	const logs = [];
	const daemon = new Daemon({
		root,
		platform,
		env: { PATH: process.env.PATH },
		log: (line) => logs.push(line),
		engineOptions: { command: process.execPath, commandArgs: [FAKE_AGENT], backoffMs: [20], stopTimeoutMs: 500, startTimeoutMs: 5000 },
		accountsOptions: { helper: { command: process.execPath, args: [FAKE_AUTH, "--accounts-root", path.join(root, "accounts")], env: { PATH: process.env.PATH } } },
		transcriberOptions,
	});
	await daemon.start();
	t.after(() => daemon.stop());
	const session = readSession(root);
	const client = await new Promise((resolve, reject) => {
		const socket = net.connect(session.endpoint);
		const frames = [];
		let buf = "";
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				frames.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token: session.token })}\n`);
			resolve({ socket, frames, send: (f) => socket.write(`${JSON.stringify(f)}\n`) });
		});
	});
	t.after(() => client.socket.destroy());
	await waitFor(() => client.frames.some((f) => f.type === "ready"));
	return { daemon, client, root, logs };
}

test("daemon: transcription_get/set over the socket; the setting persists in config.json; the remote account resolves from the store, never the frame", { skip: !posix && "Unix socket fixture", timeout: 60_000 }, async (t) => {
	const base = tmp(t);
	const { daemon, client, root, logs } = await daemonWith(t, base, { transcriberOptions: { ffmpeg: { command: process.execPath, commandArgs: [FAKE_FFMPEG] }, helper: { command: process.execPath, commandArgs: [FAKE_HELPER] } } });
	client.send({ type: "transcription_get" });
	await waitFor(() => client.frames.some((f) => f.type === "transcription"));
	assert.deepEqual(client.frames.find((f) => f.type === "transcription"), { type: "transcription", setting: { mode: "local-parakeet", language: "es" }, ffmpeg: "available", local: "available", seq: client.frames.find((f) => f.type === "transcription").seq });
	client.send({ type: "transcription_set", setting: { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper" } } });
	await waitFor(() => client.frames.some((f) => f.type === "transcription" && f.setting.mode === "remote"));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).transcription, { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper" } });
	client.send({ type: "transcription_set", setting: { mode: "remote", language: "es", remote: { accountId: "gw", model: "whisper", baseUrl: "https://evil" } } });
	await waitFor(() => client.frames.some((f) => f.type === "error" && f.code === "bad_request"));
	assert.deepEqual(await daemon.transcriptionAccount("gw"), { baseUrl: "http://127.0.0.1:9/v1", apiKey: KEY });
	await assert.rejects(daemon.transcriptionAccount("nobody"), (e) => e.code === "remote_unavailable");
	assert.ok(!client.frames.some((f) => JSON.stringify(f).includes(KEY) || JSON.stringify(f).includes("127.0.0.1:9")), "no frame carries the key or the URL");
	assert.ok(!logs.join("\n").includes(KEY));
});

test("daemon on macOS (darwin-arm64, out of scope): ffmpeg is reported unavailable even when a binary sits there", { skip: !posix && "Unix socket fixture", timeout: 60_000 }, async (t) => {
	const base = tmp(t);
	const { daemon, client } = await daemonWith(t, base, { platform: "darwin" });
	client.send({ type: "transcription_get" });
	await waitFor(() => client.frames.some((f) => f.type === "transcription"));
	assert.equal(client.frames.find((f) => f.type === "transcription").ffmpeg, "unavailable");
	await assert.rejects(daemon.transcriber.transcribe(media(path.join(base, "in"), 3)), (e) => e.code === "ffmpeg_unavailable");
});
