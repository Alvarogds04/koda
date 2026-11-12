#!/usr/bin/env node
"use strict";

// K2-13 test double for `abito-transcribe` (offline, no model). argv as the daemon builds it:
//   transcribe --model ID --language L --timeout-sec N --max-seconds N <abs wav>
// Prints ONE JSON line like the real helper. FAKE_HELPER_LOG receives the argv (one JSON line per call).
// FAKE_HELPER_MODE: (default) a transcript naming the model and the audio length; model_missing; timeout (the
// helper's own deadline, which is the daemon's remaining budget); hang; garbage; huge (an endless stdout); crash
// (exit 3, no output). FAKE_HELPER_PID receives this process' pid.

const fs = require("node:fs");

const argv = process.argv.slice(2);
if (process.env.FAKE_HELPER_LOG) fs.appendFileSync(process.env.FAKE_HELPER_LOG, `${JSON.stringify(argv)}\n`);
// The pid, so a test can prove the daemon really killed this child (FAKE_HELPER_MODE=hang never exits by itself).
if (process.env.FAKE_HELPER_PID) fs.writeFileSync(process.env.FAKE_HELPER_PID, String(process.pid));
const mode = process.env.FAKE_HELPER_MODE || "";
const value = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const wav = argv[argv.length - 1];
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "crash") process.exit(3);
else if (mode === "garbage") process.stdout.write("this is not json\n");
else if (mode === "huge") {
	const line = "x".repeat(64 * 1024);
	const write = () => {
		while (process.stdout.write(line)) {}
		process.stdout.once("drain", write);
	};
	write();
} else if (mode === "model_missing") {
	process.stdout.write(`${JSON.stringify({ error: "model_missing", message: "the model or the voice detector is not downloaded" })}\n`);
	process.exit(1);
} else if (mode === "timeout") {
	process.stdout.write(`${JSON.stringify({ error: "timeout", message: "the audio took longer than --timeout-sec" })}\n`);
	process.exit(1);
} else {
	const seconds = (fs.statSync(wav).size - 44) / 32000;
	const text = `hola desde ${value("--model")} en ${value("--language")}`;
	process.stdout.write(`${JSON.stringify({ text, segments: [{ start: 0, end: Math.min(seconds, 25), text }], model: value("--model"), language: value("--language"), durationSec: seconds })}\n`);
}
