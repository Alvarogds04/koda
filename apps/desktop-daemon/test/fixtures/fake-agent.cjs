"use strict";

// Test double for a Pi-style RPC agent (JSONL over stdin/stdout).
// Used only by the engine tests; it never contacts a real provider or the network.
//
// Behaviour:
// - get_state -> success with a session file inside the --session-dir it was given
// - echo      -> success echoing { value } back (correlation tests)
// - prompt    -> success { disposition: "started" } plus an event burst whose
//                message_update contains U+2028/U+2029 and an emoji
// - hang      -> never answered (timeout and pending-rejection tests)
// - crash     -> exits with FAKE_EXIT_CODE (default 1)
// - stdin end -> exits 0 (orderly shutdown like `pi --mode rpc`)
// --argv-out / --env-out / --spawn-log dump the spawn evidence for assertions.

const fs = require("node:fs");
const path = require("node:path");

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const spawnLog = argValue("--spawn-log");
if (spawnLog) fs.appendFileSync(spawnLog, `${process.pid}\n`);
const argvOut = argValue("--argv-out");
if (argvOut) fs.writeFileSync(argvOut, JSON.stringify(process.argv.slice(1)));
const envOut = argValue("--env-out");
if (envOut) fs.writeFileSync(envOut, JSON.stringify(process.env));
const cmdLog = argValue("--cmd-log");
const cwdOut = argValue("--cwd-out");
if (cwdOut) fs.writeFileSync(cwdOut, process.cwd());

const delayMs = Number(process.env.FAKE_DELAY_MS || 0);
const chunkedEvents = process.env.FAKE_CHUNKED === "1" || process.argv.includes("--chunked-events");
const sessionDir = argValue("--session-dir") || ".";

// Session file is per-spawn so a restart sees a different current session than
// the persisted one (exercises the switch_session recovery path).
const sessionFile = path.join(sessionDir, `fake-session-${process.pid}.jsonl`);

// Diagnostics-hygiene fixtures: this raw content must never reach engine logs.
if (process.argv.includes("--malformed-first")) {
	process.stdout.write("MALFORMED-SECRET-LINE not json\n");
}
if (process.argv.includes("--oversized-first")) {
	// ~1.5 MiB with no LF: crosses the 1 MiB record cap before its LF arrives.
	// The LF follows later; command handling starts only after the flush so a
	// response can never be glued onto the unterminated junk line.
	process.stdout.write("OVERSIZE-SECRET-".repeat(120000) + "OVERSIZE-SECRET-TAIL");
}

function logCommand(command) {
	if (cmdLog) fs.appendFileSync(cmdLog, `${JSON.stringify(command)}\n`);
}

function writeRecord(record) {
	process.stdout.write(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
}

/**
 * Writes one record across three stdout writes with gaps (records stay
 * strictly sequential — a real agent never interleaves partial records),
 * then calls done() so later records land after the reassembly.
 */
function writeChunked(record, done) {
	const data = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
	const third = Math.ceil(data.length / 3);
	process.stdout.write(data.subarray(0, third));
	setTimeout(() => {
		process.stdout.write(data.subarray(third, 2 * third));
		setTimeout(() => {
			process.stdout.write(data.subarray(2 * third));
			done();
		}, 15);
	}, 15);
}

function respond(id, command, data) {
	writeRecord({ id, type: "response", command, success: true, data });
}

function handle(command) {
	logCommand(command);
	switch (command.type) {
		case "get_state":
			if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "", { mode: 0o600 });
			respond(command.id, "get_state", { sessionFile });
			break;
		case "switch_session":
			respond(command.id, "switch_session", { sessionFile: command.sessionPath });
			break;
		case "echo":
			respond(command.id, "echo", { value: command.value });
			break;
		case "hang":
			// Never answered on purpose.
			break;
		case "prompt": {
			respond(command.id, "prompt", { disposition: "started" });
			writeRecord({ type: "agent_start" });
			const emitRest = () => {
				writeRecord({ type: "agent_end" });
				writeRecord({ type: "agent_settled" });
			};
			const update = {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hola 😀 línea\u2028separada\u2029fin" },
			};
			if (chunkedEvents) writeChunked(update, emitRest);
			else {
				writeRecord(update);
				emitRest();
			}
			break;
		}
		case "crash":
			process.exit(Number(process.env.FAKE_EXIT_CODE || 1));
			break;
		default:
			respond(command.id, command.type, {});
	}
}

function startStdin() {
	let buffer = Buffer.alloc(0);
	process.stdin.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		let newline = buffer.indexOf(0x0a);
		while (newline >= 0) {
			const line = buffer.subarray(0, newline).toString("utf8");
			buffer = buffer.subarray(newline + 1);
			if (line.trim() !== "") {
				let command;
				try {
					command = JSON.parse(line);
				} catch {
					continue;
				}
				if (delayMs > 0) setTimeout(() => handle(command), delayMs);
				else handle(command);
			}
			newline = buffer.indexOf(0x0a);
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

if (process.argv.includes("--oversized-first")) {
	setTimeout(() => {
		process.stdout.write("\n");
		startStdin();
	}, 30);
} else {
	startStdin();
}
