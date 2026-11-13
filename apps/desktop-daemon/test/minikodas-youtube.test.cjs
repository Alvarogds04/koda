"use strict";

// K2-13 T2c-8 (S19): YouTube links of the source a Minikoda reads. Offline: a fake yt-dlp that records its argv and
// writes the tracks/media of a fixture video, a fake transcriber, and a fake `pi` for the end-to-end service test.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findYouTubeLinks, youtubeId, vttToText, YouTubeReader, YouTubeError, SAFETY_FLAGS, MAX_LINKS_PER_RUN, MAX_VIDEO_SECONDS, bundledYtDlp, bundledNode } = require("../src/minikodas/youtube.cjs");
const { Transcriber, TRANSCRIPTION_BUDGET_MS } = require("../src/minikodas/transcribe.cjs");
const { MinikodaService } = require("../src/minikodas/service.cjs");

const FIX = path.join(__dirname, "fixtures", "minikodas");
const FAKE_YTDLP = path.join(FIX, "fake-ytdlp.cjs");
const FAKE_FFMPEG = path.join(FIX, "fake-ffmpeg.cjs");
const FAKE_HELPER = path.join(FIX, "fake-transcribe.cjs");
const FAKE_PI = path.join(FIX, "fake-pi.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await sleep(10);
	}
	assert.ok(await fn(), "waitFor timed out");
}

function tmp(t) {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-yt-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
	return base;
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
const calls = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
// A distinct, valid 11-character video id per test number (the id regex is exactly 11 URL-safe characters).
const VID = (n) => `id${String(n).padStart(9, "0")}`;
const WATCH = (id) => `https://www.youtube.com/watch?v=${id}`;

/** A reader wired to the fake yt-dlp, with recording / timing out transcriber doubles. */
function reader(t, base, { fixture = {}, env = {}, limits = {}, transcriber, logs = [], setting, jsRuntime } = {}) {
	const island = path.join(base, "island");
	fs.mkdirSync(island, { recursive: true, mode: 0o700 });
	const log = path.join(base, "ytdlp.log");
	const fixtureFile = path.join(base, "videos.json");
	fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
	const transcribed = [];
	const tr = transcriber ?? {
		transcribe: async (file, options) => {
			const existed = fs.existsSync(file);
			const size = existed ? fs.lstatSync(file).size : 0;
			transcribed.push({ file, existed, size, options });
			if (options?.deleteMedia) fs.rmSync(file, { force: true });
			return { text: "texto transcripto del audio" };
		},
	};
	const r = new YouTubeReader({
		islandRoot: island,
		ytdlp: { command: process.execPath, commandArgs: [FAKE_YTDLP] },
		jsRuntime,
		transcriber: tr,
		setting: setting ?? (() => ({ mode: "local-parakeet", language: "es" })),
		env: { PATH: process.env.PATH, FAKE_YTDLP_LOG: log, FAKE_YTDLP_FIXTURE: fixtureFile, ...env },
		log: (line) => logs.push(line),
		limits,
	});
	return { r, log, logs, transcribed, workRoot: path.join(island, "minikodas", "youtube"), fixtureFile };
}

// ---------- which links ----------

test("S19 only YouTube VIDEO links are read: watch, shorts, youtu.be and m.youtube.com; every other site is ignored", () => {
	const id = "dQw4w9WgXcQ";
	assert.equal(youtubeId(`https://www.youtube.com/watch?v=${id}`), id);
	assert.equal(youtubeId(`https://youtube.com/watch?v=${id}&list=PL123`), id, "a link inside a playlist is still that video");
	assert.equal(youtubeId(`https://m.youtube.com/watch?v=${id}`), id);
	assert.equal(youtubeId(`http://www.youtube.com/watch?v=${id}`), id);
	assert.equal(youtubeId(`https://youtu.be/${id}`), id);
	assert.equal(youtubeId(`https://www.youtube.com/shorts/${id}`), id);
	assert.equal(youtubeId(`https://www.youtube.com/watch?v=${id}.`), id, "trailing punctuation of a sentence is not part of the id");
	for (const other of [
		"https://vimeo.com/123456789", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://evilyoutube.com/watch?v=dQw4w9WgXcQ",
		`https://www.youtube.com.evil.test/watch?v=${id}`, "https://www.youtube.com/playlist?list=PL123", "https://www.youtube.com/@canal",
		"https://www.youtube.com/watch?v=short", `https://www.youtube.com/watch?v=${id}x`, `https://youtu.be/${id}/extra`,
		"javascript:alert(1)", "youtube.com/watch?v=dQw4w9WgXcQ", `ftp://youtube.com/watch?v=${id}`, "", undefined,
	]) assert.equal(youtubeId(other), undefined, String(other));
});

test("S19 at most three different videos per run, repeats counted once, and the rest is counted so «Hoy» can say so", () => {
	const ids = ["aaaaaaaaaa1", "bbbbbbbbbb2", "cccccccccc3", "dddddddddd4", "eeeeeeeeee5"].map((s) => s.slice(0, 11));
	const text = `${WATCH(ids[0])} y otra vez ${WATCH(ids[0])} <${WATCH(ids[1])}> ${WATCH(ids[2])}, ${WATCH(ids[3])} ${WATCH(ids[4])}`;
	const found = findYouTubeLinks(text);
	assert.equal(MAX_LINKS_PER_RUN, 3);
	assert.deepEqual(found.links.map((l) => l.id), ids.slice(0, 3));
	assert.equal(found.skipped, 2);
	assert.deepEqual(findYouTubeLinks("solo texto, sin enlaces"), { links: [], skipped: 0 });
	assert.deepEqual(findYouTubeLinks(text, { max: 1 }).links.map((l) => l.id), [ids[0]]);
});

// ---------- subtitles -> text ----------

test("S19 a WebVTT track becomes plain text: no timings, no cue numbers, no tags, and YouTube's rolling captions are folded", () => {
	const vtt = [
		"WEBVTT", "Kind: captions", "Language: es", "",
		"1", "00:00:00.160 --> 00:00:03.359", "hola<00:00:00.879><c> a</c><00:00:01.000><c> todos</c>", "",
		"2", "00:00:03.359 --> 00:00:05.120", "hola a todos", "",
		"3", "00:00:05.120 --> 00:00:08.000", "hola a todos hoy", "",
		"NOTE una nota del autor", "",
		"4", "00:00:08.000 --> 00:00:11.000", "<i>hablamos</i> &amp; del mercado", "",
	].join("\n");
	assert.equal(vttToText(vtt), "hola a todos hoy hablamos & del mercado");
	assert.equal(vttToText(""), "");
});

// ---------- subtitles first ----------

test("S19 manual subtitles win: one call for the metadata, one for the track, no audio, and the source gets its marker", async (t) => {
	const base = tmp(t);
	const id = VID(1);
	const { r, log, transcribed, workRoot } = reader(t, base, { fixture: { [id]: { duration: 90, manual: ["es"], auto: ["es"], audio: true } } });
	const out = await r.read(`Post del canal: mirá ${WATCH(id)}`);
	assert.match(out.text, /Post del canal: mirá/);
	assert.ok(out.text.includes(`[Video de YouTube ${WATCH(id)} · subtítulos de YouTube]`), out.text);
	assert.match(out.text, /Hola a todos, hoy vemos el mercado\./);
	assert.match(out.text, /no vendan por pánico & esperen\./, "the inline tags are gone and the entities decoded");
	assert.deepEqual(out.failures, []);
	assert.equal(transcribed.length, 0, "a video with subtitles never downloads its audio");
	const argv = calls(log);
	assert.equal(argv.length, 2);
	assert.equal(argv[0].at(-1), WATCH(id), "the URL is built from the validated id, never taken from the text");
	assert.ok(argv[0].includes("--dump-single-json"));
	assert.ok(argv[1].includes("--skip-download") && argv[1].includes("--write-subs") && !argv[1].includes("--write-auto-subs"));
	assert.deepEqual(argv[1].slice(argv[1].indexOf("--sub-format"), argv[1].indexOf("--sub-format") + 2), ["--sub-format", "vtt"]);
	assert.deepEqual(argv[1].slice(argv[1].indexOf("--sub-langs"), argv[1].indexOf("--sub-langs") + 2), ["--sub-langs", "es"]);
	assert.deepEqual(allFiles(workRoot), [], "the work folder is removed");
});

test("S19 without manual subtitles YouTube's automatic captions are used, in the video's own language", async (t) => {
	const base = tmp(t);
	const id = VID(2);
	const { r, log } = reader(t, base, { fixture: { [id]: { duration: 90, language: "en", manual: [], auto: ["es", "en"] } } });
	const out = await r.read(`Video: https://youtu.be/${id}`);
	const track = calls(log)[1];
	assert.ok(track.includes("--write-auto-subs") && !track.includes("--write-subs"));
	assert.deepEqual(track.slice(track.indexOf("--sub-langs"), track.indexOf("--sub-langs") + 2), ["--sub-langs", "en"], "the video's language, not the setting's");
	assert.match(out.text, /subtítulos de YouTube/);
	assert.match(out.text, /hola a todos hoy hablamos del mercado/, "the rolling captions are folded once");
});

test("S19 the video's own language picks the track, and YouTube's non-language entries (live_chat) are never a subtitle track", async (t) => {
	// Real videos showed this: `subtitles` also lists non-subtitle entries such as `live_chat`, and a manual track in
	// ANOTHER language must not win over the automatic captions of the video's own language (S19: «in the video's
	// language», manual first).
	const base = tmp(t);
	const chat = VID(10);
	const portuguese = VID(11);
	const both = VID(12);
	const { r, log } = reader(t, base, {
		fixture: {
			[chat]: { duration: 60, language: "es", manual: ["live_chat"], auto: ["es"] },
			[portuguese]: { duration: 60, language: "es-US", manual: ["pt-PT"], auto: ["pt-PT", "es", "es-orig"] },
			[both]: { duration: 60, language: "es", manual: ["pt-PT", "es"], auto: [] },
		},
	});
	await r.read(`${WATCH(chat)} ${WATCH(portuguese)} ${WATCH(both)}`);
	const calls_ = calls(log).filter((a) => a.includes("--write-subs") || a.includes("--write-auto-subs"));
	assert.deepEqual(calls_.map((a) => [a.includes("--write-auto-subs") ? "auto" : "manual", a[a.indexOf("--sub-langs") + 1]]), [
		["auto", "es"], ["auto", "es"], ["manual", "es"],
	]);
	for (const call of calls_) assert.ok(!call.includes("live_chat"), "live_chat is never requested");
});

// ---------- no subtitles: audio only ----------

test("S19 no subtitles at all: only the audio is downloaded and the chosen transcriber produces the text («transcripto»)", async (t) => {
	const base = tmp(t);
	const id = VID(3);
	const { r, log, transcribed, workRoot } = reader(t, base, { fixture: { [id]: { duration: 100, manual: [], auto: [], audio: true, audioBytes: 4096 } } });
	const out = await r.read(`Escuchá esto ${WATCH(id)}`);
	assert.ok(out.text.includes(`[Video de YouTube ${WATCH(id)} · transcripto]`), out.text);
	assert.match(out.text, /texto transcripto del audio/);
	assert.equal(transcribed.length, 1);
	assert.equal(transcribed[0].existed, true, "the audio file is handed to the transcriber");
	assert.equal(transcribed[0].size, 4096);
	assert.equal(transcribed[0].options.deleteMedia, true, "the media is deleted after its audio is extracted");
	assert.ok(Number.isFinite(transcribed[0].options.deadline), "the transcription shares the read's deadline (S17)");
	const audio = calls(log).find((a) => a.includes("-f"));
	assert.ok(audio, "the audio download really ran");
	assert.deepEqual(audio.slice(audio.indexOf("-f"), audio.indexOf("-f") + 2), ["-f", "bestaudio/best"]);
	assert.ok(audio.includes("--max-filesize"));
	assert.deepEqual(allFiles(workRoot), []);
});

test("S19 every yt-dlp call carries the safety flags: no config file, one video, nothing executed, no cookies or plugins", async (t) => {
	const base = tmp(t);
	const id = VID(4);
	const { r, log } = reader(t, base, { fixture: { [id]: { duration: 100, manual: ["es"], auto: [], audio: true } }, jsRuntime: "/opt/koda/runtime/node" });
	await r.read(WATCH(id));
	const argv = calls(log);
	assert.equal(argv.length, 2, "the metadata call and the subtitle call");
	for (const call of argv) {
		for (const flag of SAFETY_FLAGS) assert.ok(call.includes(flag), `${flag} is in ${call.join(" ")}`);
		for (const flag of ["--cookies", "--cookies-from-browser", "--plugin-dirs", "--load-info-json", "--exec"]) assert.ok(!call.includes(flag), `${flag} is never passed`);
		// YouTube extraction needs a JavaScript runtime: Koda's own bundled Node, by absolute path (never PATH), and no
		// remote component is ever fetched.
		assert.deepEqual(call.slice(call.indexOf("--js-runtimes"), call.indexOf("--js-runtimes") + 2), ["--js-runtimes", "node:/opt/koda/runtime/node"]);
		assert.ok(call.includes("--no-remote-components"));
		assert.ok(!call.some((a) => a.includes(";") || a.includes("|") || a.includes("$(")), "no shell metacharacter reaches the argv");
		assert.equal(call.at(-1), WATCH(id));
	}
});

// ---------- refusals ----------

test("S19 a video longer than 3 hours is refused from its metadata, before anything is downloaded", async (t) => {
	const base = tmp(t);
	const id = VID(5);
	const { r, log, transcribed, workRoot } = reader(t, base, { fixture: { [id]: { duration: MAX_VIDEO_SECONDS + 1, manual: ["es"], audio: true } } });
	const out = await r.read(WATCH(id));
	assert.equal(out.text, WATCH(id), "nothing is appended");
	assert.equal(out.failures.length, 1);
	assert.equal(out.failures[0].code, "too_long");
	assert.match(out.failures[0].userText, /más de 3 horas/);
	assert.equal(calls(log).length, 1, "only the metadata call ran");
	assert.equal(transcribed.length, 0);
	assert.deepEqual(allFiles(workRoot), []);
});

test("S19 an audio download over the 200 MB cap is refused, and a video with neither subtitles nor audio says so", async (t) => {
	const base = tmp(t);
	const big = VID(6);
	const mute = VID(7);
	const { r } = reader(t, base, {
		fixture: { [big]: { duration: 100, manual: [], audio: true, audioBytes: 4096 }, [mute]: { duration: 100, manual: [], audio: false } },
		limits: { maxAudioBytes: 1024 },
	});
	const out = await r.read(`${WATCH(big)} ${WATCH(mute)}`);
	assert.deepEqual(out.failures.map((f) => f.code), ["too_large", "no_media"]);
	assert.match(out.failures[0].userText, /200 MB/);
	assert.match(out.failures[1].userText, /no tiene subtítulos ni audio/);
	assert.equal(out.text, `${WATCH(big)} ${WATCH(mute)}`, "the source is left as it was");
});

test("S19 a failing video is a Spanish «Hoy» item, not the end of the read: the other links are still read", async (t) => {
	const base = tmp(t);
	const good = VID(8);
	const bad = VID(9);
	const { r } = reader(t, base, { fixture: { [good]: { duration: 60, manual: ["es"] }, [bad]: { duration: 60, manual: ["es"] } } });
	// The second video's metadata call fails (`Private video`), the first one has subtitles.
	const failing = new YouTubeReader({
		islandRoot: path.join(base, "island2"),
		ytdlp: { command: process.execPath, commandArgs: [FAKE_YTDLP] },
		transcriber: { transcribe: async () => ({ text: "x" }) },
		setting: () => ({ language: "es" }),
		env: { PATH: process.env.PATH, FAKE_YTDLP_FIXTURE: path.join(base, "videos.json"), FAKE_YTDLP_MODE: "fail" },
		log: () => {},
	});
	const onlyFailing = await failing.read(WATCH(bad));
	assert.equal(onlyFailing.failures.length, 1);
	assert.equal(onlyFailing.failures[0].code, "unavailable");
	assert.match(onlyFailing.failures[0].userText, /privado/);
	const ok = await r.read(WATCH(good));
	assert.deepEqual(ok.failures, []);
	assert.match(ok.text, /subtítulos de YouTube/);
});

test("S19 no yt-dlp on this computer (macOS, a checkout): youtube_unavailable per link and the post is still read", async (t) => {
	const base = tmp(t);
	const island = path.join(base, "island");
	fs.mkdirSync(island, { recursive: true, mode: 0o700 });
	const r = new YouTubeReader({ islandRoot: island, ytdlp: undefined, transcriber: { transcribe: async () => ({ text: "x" }) }, log: () => {} });
	assert.equal(r.status(), "unavailable");
	const out = await r.read(`Mirá ${WATCH(VID(1))}`);
	assert.equal(out.failures.length, 1);
	assert.equal(out.failures[0].code, "youtube_unavailable");
	assert.equal(out.text, `Mirá ${WATCH(VID(1))}`);
});

test("S19 a cancelled read kills yt-dlp and removes its work folder", async (t) => {
	const base = tmp(t);
	const pidFile = path.join(base, "ytdlp.pid");
	const { r, workRoot } = reader(t, base, { env: { FAKE_YTDLP_MODE: "hang", FAKE_YTDLP_PID: pidFile } });
	const controller = new AbortController();
	const pending = r.read(WATCH(VID(1)), { signal: controller.signal });
	await waitFor(() => fs.existsSync(pidFile));
	const pid = Number(fs.readFileSync(pidFile, "utf8"));
	controller.abort();
	await assert.rejects(pending, (e) => e instanceof YouTubeError && e.code === "cancelled");
	const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
	await waitFor(() => !alive());
	assert.deepEqual(allFiles(workRoot), [], "the work folder is removed on cancel");
});

test("S19 the shared 30-minute budget bounds the whole read: a hanging yt-dlp is budget_exceeded and the folder goes away", async (t) => {
	const base = tmp(t);
	const { r, workRoot } = reader(t, base, { env: { FAKE_YTDLP_MODE: "hang" }, limits: { budgetMs: 600 } });
	assert.equal(TRANSCRIPTION_BUDGET_MS, 30 * 60 * 1000);
	await assert.rejects(r.read(WATCH(VID(1))), (e) => e instanceof YouTubeError && e.code === "budget_exceeded");
	assert.deepEqual(allFiles(workRoot), []);
});

test("bundled yt-dlp and the bundled Node it runs with: fixed paths inside the runtime folder, never PATH, never a symlink", (t) => {
	const base = tmp(t);
	const root = path.join(base, "prefix");
	fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
	assert.equal(bundledYtDlp({ installRoot: root, platform: "linux" }), undefined, "nothing there: unavailable, no fallback");
	// «linux» asks for the execute bit, which NTFS cannot hold (see minikodas-transcribe.test.cjs): POSIX hosts only.
	if (process.platform !== "win32") {
		fs.writeFileSync(path.join(root, "runtime", "yt-dlp"), "bin", { mode: 0o755 });
		assert.equal(bundledYtDlp({ installRoot: root, platform: "linux" }), path.join(root, "runtime", "yt-dlp"));
	}
	fs.writeFileSync(path.join(root, "runtime", "yt-dlp.exe"), "bin");
	assert.equal(bundledYtDlp({ installRoot: root, platform: "win32" }), path.join(root, "runtime", "yt-dlp.exe"));
	if (process.platform !== "win32") {
		fs.rmSync(path.join(root, "runtime", "yt-dlp"));
		fs.symlinkSync("/usr/bin/true", path.join(root, "runtime", "yt-dlp"));
		assert.equal(bundledYtDlp({ installRoot: root, platform: "linux" }), undefined, "a symlink is never run");
	}
	// The JavaScript runtime yt-dlp needs is the Node the runtime already ships, at its own absolute path.
	assert.equal(bundledNode({ installRoot: root, platform: "linux" }), undefined, "no bundled Node there");
	if (process.platform !== "win32") {
		fs.writeFileSync(path.join(root, "runtime", "node"), "bin", { mode: 0o755 });
		assert.equal(bundledNode({ installRoot: root, platform: "linux" }), path.join(root, "runtime", "node"));
	}
	fs.writeFileSync(path.join(root, "runtime", "node.exe"), "bin");
	assert.equal(bundledNode({ installRoot: root, platform: "win32" }), path.join(root, "runtime", "node.exe"));
});

// ---------- the run ----------

const MODEL = { provider: "fake", id: "fake-minikoda", accountId: "main" };
const recipe = (over = {}) => ({
	id: "videos",
	name: "Videos",
	when: { manual: true },
	reads: { source: "telegram:canal_x" },
	kit: ["source_read", "inbox_propose"],
	prompt: "Resumí el canal.",
	model: { ...MODEL },
	never: ["buy", "sell", "send", "delete"],
	...over,
});
function service(t, base, { fixture, env = {}, limits, youtube, steps } = {}) {
	const accountsRoot = path.join(base, "accounts");
	fs.mkdirSync(path.join(accountsRoot, "main"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(accountsRoot, "main", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }), { mode: 0o600 });
	const scriptFile = path.join(base, "script.json");
	fs.writeFileSync(scriptFile, JSON.stringify({ steps: steps ?? [{ tool: "source_read" }, { text: "Resumen listo." }] }));
	const results = { runs: [], errors: [], addRun: async (r) => { results.runs.push(r); }, addError: async (e) => { results.errors.push(e); } };
	const transcriber = new Transcriber({
		islandRoot: path.join(base, "island"),
		setting: () => ({ mode: "local-parakeet", language: "es" }),
		ffmpeg: { command: process.execPath, commandArgs: [FAKE_FFMPEG] },
		helper: { command: process.execPath, commandArgs: [FAKE_HELPER] },
		env: { PATH: process.env.PATH },
		log: () => {},
	});
	const { r } = reader(t, base, { fixture, env, limits, transcriber });
	const svc = new MinikodaService({
		islandRoot: path.join(base, "island"),
		accounts: { listAccounts: () => [{ accountId: "main", provider: "fake", configured: true }], models: async () => [MODEL] },
		profiles: { list: () => ({ profiles: [], active: undefined }) },
		accountsRoot,
		results,
		minEveryMs: 1,
		runTimeoutMs: 20_000,
		engine: { command: process.execPath, commandArgs: [FAKE_PI, "--script", scriptFile], env: { PATH: process.env.PATH }, startTimeoutMs: 10_000 },
		transcriber,
		youtube: youtube ?? r,
		source: async () => `Post del canal: mirá ${WATCH(VID(1))}`,
	});
	t.after(() => svc.stop());
	svc.start();
	return { svc, results, island: path.join(base, "island"), reader: r };
}

test("S19 a run whose post links a video reads its subtitles: the Minikoda sees them behind the marker", async (t) => {
	const base = tmp(t);
	const { svc, results, island } = service(t, base, { fixture: { [VID(1)]: { duration: 60, manual: ["es"] } } });
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	assert.equal((await svc.launch("videos")).started, true);
	await waitFor(() => results.runs.length + results.errors.length === 1);
	assert.deepEqual(results.errors, []);
	const source = fs.readFileSync(path.join(island, "minikodas", "engines", "videos", "run", "source.txt"), "utf8");
	assert.match(source, /Post del canal/);
	assert.match(source, /subtítulos de YouTube/);
	assert.match(source, /Hola a todos, hoy vemos el mercado/);
});

test("S19 a video without subtitles is transcribed by the daemon's own transcription service during the run", async (t) => {
	const base = tmp(t);
	const { svc, results, island } = service(t, base, { fixture: { [VID(1)]: { duration: 40, manual: [], auto: [], audio: true } } });
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	await svc.launch("videos");
	await waitFor(() => results.runs.length + results.errors.length === 1, 40_000);
	assert.deepEqual(results.errors, []);
	const source = fs.readFileSync(path.join(island, "minikodas", "engines", "videos", "run", "source.txt"), "utf8");
	assert.match(source, /· transcripto\]/);
	assert.match(source, /hola desde parakeet-tdt-0\.6b-v3-int8 en es/);
	assert.deepEqual(allFiles(path.join(island, "minikodas", "youtube")), [], "the read's work folder is gone");
	assert.deepEqual(allFiles(path.join(island, "minikodas", "transcribe")), [], "the transcription's work folder is gone");
});

test("S19 a video that cannot be read leaves a Spanish «Hoy» item and the run still happens", async (t) => {
	const base = tmp(t);
	const { svc, results } = service(t, base, { fixture: { [VID(1)]: { duration: 60, manual: ["es"] } }, env: { FAKE_YTDLP_MODE: "fail" } });
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	await svc.launch("videos");
	await waitFor(() => results.runs.length + results.errors.length >= 1);
	await waitFor(() => results.errors.length >= 1);
	assert.match(results.errors[0].text, /no pudo leer un video de YouTube/);
	assert.match(results.errors[0].text, /privado, fue eliminado o tiene restricciones/);
});

test("S19 more videos than the cap: the run reads three and «Hoy» says how many were left out", async (t) => {
	const base = tmp(t);
	const ids = ["aaaaaaaaaa1", "bbbbbbbbbb2", "cccccccccc3", "dddddddddd4"].map((s) => s.slice(0, 11));
	const fixture = Object.fromEntries(ids.map((id) => [id, { duration: 60, manual: ["es"] }]));
	const youtube = {
		read: async (text) => {
			const { findYouTubeLinks } = require("../src/minikodas/youtube.cjs");
			const found = findYouTubeLinks(text);
			return { text, videos: found.links.length, skipped: found.skipped, failures: [] };
		},
	};
	const { svc, results } = service(t, base, { fixture, youtube });
	await svc.createDraft(recipe());
	await svc.approveCreate("videos");
	svc.options.source = async () => `Post con ${ids.map(WATCH).join(" ")}`;
	await svc.launch("videos");
	await waitFor(() => results.runs.length + results.errors.length >= 1);
	await waitFor(() => results.errors.length >= 1);
	assert.match(results.errors[0].text, /leyó como mucho 3 videos de YouTube: 1 video\(s\) más/);
});
