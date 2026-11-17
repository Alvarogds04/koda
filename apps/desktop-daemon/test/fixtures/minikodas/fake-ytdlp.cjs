#!/usr/bin/env node
"use strict";

// K2-13 (S19) test double for the bundled yt-dlp (offline, no network). It understands exactly the argv youtube.cjs
// builds and records it (FAKE_YTDLP_LOG, one JSON line per call):
//
//   ... --dump-single-json  <url>              -> {id, title, duration, language, subtitles, automatic_captions}
//   ... --write-subs|--write-auto-subs ... -o <dir>/%(id)s.%(ext)s <url>  -> <dir>/<id>.<lang>.vtt
//   ... -f bestaudio/best --max-filesize NM -o <dir>/%(id)s.%(ext)s <url> -> <dir>/<id>.m4a
//
// The video is described by FAKE_YTDLP_FIXTURE (a JSON file, `{"<id>": {...}}`); an id it does not name gets
// `{duration: 120, manual: ["es"], auto: [], audio: true}`. Fields: duration (s), language, manual[]/auto[] (subtitle
// language lists), audio (bool), audioBytes (size of the fake audio file), subsText/autoText (the VTT to write).
// FAKE_YTDLP_MODE: fail (exit 1 with an ERROR line naming the video), hang (never exits).
// FAKE_YTDLP_PID receives this process' pid, so a test can prove the daemon really killed this child.

const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
if (process.env.FAKE_YTDLP_LOG) fs.appendFileSync(process.env.FAKE_YTDLP_LOG, `${JSON.stringify(argv)}\n`);
if (process.env.FAKE_YTDLP_PID) fs.writeFileSync(process.env.FAKE_YTDLP_PID, String(process.pid));
const mode = process.env.FAKE_YTDLP_MODE || "";

const value = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const url = argv[argv.length - 1] || "";
const id = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url)?.[1] ?? url.split("/").filter(Boolean).at(-1) ?? "";
const fixture = process.env.FAKE_YTDLP_FIXTURE && fs.existsSync(process.env.FAKE_YTDLP_FIXTURE)
	? JSON.parse(fs.readFileSync(process.env.FAKE_YTDLP_FIXTURE, "utf8"))
	: {};
const video = fixture[id] ?? { duration: 120, manual: ["es"], auto: [], audio: true };

/* A manual track: plain cues. An automatic one: the rolling captions YouTube really writes (each cue repeats the
   previous line and grows it, with inline timestamps and <c> tags), which the converter has to fold. */
const MANUAL_VTT = [
	"WEBVTT",
	"Kind: captions",
	"Language: es",
	"",
	"00:00:00.160 --> 00:00:03.359",
	"Hola a todos, hoy vemos el mercado.",
	"",
	"00:00:03.359 --> 00:00:06.000",
	"Primero, <i>lo importante</i>: no vendan por pánico &amp; esperen.",
	"",
].join("\n");
const AUTO_VTT = [
	"WEBVTT",
	"Kind: captions",
	"Language: es",
	"",
	"00:00:00.160 --> 00:00:03.359 align:start position:0%",
	"hola<00:00:00.879><c> a</c><00:00:01.000><c> todos</c>",
	"",
	"00:00:03.359 --> 00:00:05.120 align:start position:0%",
	"hola a todos",
	"",
	"00:00:05.120 --> 00:00:08.000 align:start position:0%",
	"hola a todos hoy",
	"",
	"00:00:08.000 --> 00:00:11.000 align:start position:0%",
	"hablamos del mercado",
	"",
].join("\n");

if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") {
	process.stderr.write("ERROR: [youtube] video unavailable: Private video. Sign in if you've been granted access\n");
	process.exit(1);
} else if (argv.includes("--dump-single-json")) {
	const tracks = (list) => Object.fromEntries((list || []).map((l) => [l, [{ ext: "vtt", url: `https://example.invalid/${l}.vtt` }]]));
	process.stdout.write(`${JSON.stringify({
		id,
		title: `Video ${id}`,
		duration: video.duration ?? 120,
		language: video.language ?? "es",
		subtitles: tracks(video.manual),
		automatic_captions: tracks(video.auto),
	})}\n`);
} else {
	const template = value("-o");
	const dir = template ? path.dirname(template) : process.cwd();
	const subs = argv.includes("--write-subs") ? video.manual : argv.includes("--write-auto-subs") ? video.auto : undefined;
	if (subs) {
		const lang = value("--sub-langs");
		if (subs.includes(lang)) {
			const body = argv.includes("--write-subs") ? video.subsText ?? MANUAL_VTT : video.autoText ?? AUTO_VTT;
			fs.writeFileSync(path.join(dir, `${id}.${lang}.vtt`), body);
		}
	} else if (video.audio === false) {
		// No audio stream at all: yt-dlp writes nothing (the reader answers no_media).
	} else {
		const bytes = Number(video.audioBytes ?? 0);
		const maxMb = Number(String(value("--max-filesize") ?? "").replace(/M$/, "")) || Infinity;
		if (bytes / 1048576 <= maxMb) {
			const body = JSON.stringify({ seconds: video.duration ?? 120 });
			fs.writeFileSync(path.join(dir, `${id}.m4a`), bytes > body.length ? body + " ".repeat(bytes - body.length) : body);
		}
	}
}
