#!/usr/bin/env node
"use strict";

// K2-13 test double for the bundled ffmpeg (offline, no codecs). It understands exactly the argv the transcription
// service builds and records it (FAKE_FFMPEG_LOG, one JSON line per call):
//   ... -i file:<in> ... <out.wav>   -> a 16 kHz mono 16-bit WAV whose length is the input's `seconds`
//                                       (the fake media file is JSON {"seconds": N}; a WAV input is measured)
//   ... -ss S -t T -i file:<wav> ... <out.ogg>  -> a small fake "OGG" chunk naming its window
// FAKE_FFMPEG_MODE: fail (exit 1, a line on stderr that names the input), hang (never exits), huge (a 26 MB chunk).

const fs = require("node:fs");

const argv = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, `${JSON.stringify(argv)}\n`);
const mode = process.env.FAKE_FFMPEG_MODE || "";
if (mode === "hang") setInterval(() => {}, 1000);
else {
	const value = (flag) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const input = String(value("-i") || "").replace(/^file:/, "");
	const out = argv[argv.length - 1];
	if (mode === "fail") {
		process.stderr.write(`Error opening input file ${input}.\n`);
		process.exit(1);
	}
	let seconds;
	const bytes = fs.readFileSync(input);
	if (bytes.subarray(0, 4).toString() === "RIFF") seconds = (bytes.length - 44) / 32000;
	else seconds = Number(JSON.parse(bytes.toString("utf8")).seconds);
	if (out.endsWith(".wav")) {
		const t = Math.min(seconds, Number(value("-t") ?? Infinity));
		const data = Buffer.alloc(Math.round(t * 16000) * 2);
		const h = Buffer.alloc(44);
		h.write("RIFF", 0);
		h.writeUInt32LE(36 + data.length, 4);
		h.write("WAVEfmt ", 8);
		h.writeUInt32LE(16, 16);
		h.writeUInt16LE(1, 20);
		h.writeUInt16LE(1, 22);
		h.writeUInt32LE(16000, 24);
		h.writeUInt32LE(32000, 28);
		h.writeUInt16LE(2, 32);
		h.writeUInt16LE(16, 34);
		h.write("data", 36);
		h.writeUInt32LE(data.length, 40);
		fs.writeFileSync(out, Buffer.concat([h, data]));
	} else if (out.endsWith(".ogg")) {
		const ss = Number(value("-ss") ?? 0);
		const t = Math.min(Number(value("-t") ?? seconds), seconds - ss);
		const body = Buffer.from(`OggS fake chunk ss=${ss} t=${t}`);
		fs.writeFileSync(out, mode === "huge" ? Buffer.concat([body, Buffer.alloc(26 * 1024 * 1024)]) : body);
	} else {
		process.exit(2);
	}
}
