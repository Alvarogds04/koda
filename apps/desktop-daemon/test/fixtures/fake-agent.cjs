"use strict";

// Test double for a Pi-style RPC agent (JSONL over stdin/stdout).
// Used only by the engine tests; it never contacts a real provider or the network.
//
// Behaviour:
// - get_state -> success with a session file inside the --session-dir it was given
// - echo      -> success echoing { value } back (correlation tests)
// - prompt    -> success { disposition: "started" } plus an event burst: agent_start, the
//                user message it records (message_start/message_end role user, as Pi does),
//                and a message_update that contains U+2028/U+2029 and an emoji
// --persist-messages appends the user message and the reply to the session file the way Pi
// does (each message right after it is announced), so history reads what the engine recorded.
// - hang      -> never answered (timeout and pending-rejection tests)
// - crash     -> exits with FAKE_EXIT_CODE (default 1)
// - stdin end -> exits 0 (orderly shutdown like `pi --mode rpc`)
// --argv-out / --env-out / --spawn-log dump the spawn evidence for assertions.
// --lazy-session-file (K2-05 boot reopen B1): like real Pi (session-manager.js:794-799), the
// session file is written only once there is a conversation: get_state reports the path but
// creates nothing, the first prompt creates it.
// --ask-on-prompt (K2-05 U4b): after recording the user message the engine asks the user
// (extension_ui_request `input`, with a hidden engine name in the title/placeholder) and
// answers only once the extension_ui_response arrives, quoting what it received.

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
// the persisted one (exercises the switch_session recovery path). Like Pi, a
// finished switch_session moves the open session, so a later get_state reports it.
let sessionFile = path.join(sessionDir, `fake-session-${process.pid}.jsonl`);

// K2-05 boot reopen (L44): --switch-script <file> scripts the switch_session
// answers, one line consumed per switch (shared by every spawn of one test):
// `fail` answers an error and stays put, `hang` never answers and never switches,
// `late <ms>` switches and answers only after <ms> (Pi handles RPC lines
// concurrently: a get_state meanwhile still reports the old file, rpc-mode.js
// :474-479). An empty or missing script switches at once.
const switchScript = argValue("--switch-script");
function nextSwitchStep() {
	if (!switchScript || !fs.existsSync(switchScript)) return "";
	const lines = fs.readFileSync(switchScript, "utf8").split("\n").filter(Boolean);
	fs.writeFileSync(switchScript, lines.slice(1).map((line) => `${line}\n`).join(""));
	return lines[0] ?? "";
}

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

const persistMessages = process.argv.includes("--persist-messages");
const lazySessionFile = process.argv.includes("--lazy-session-file");

/** Pi's SessionManager.appendMessage: one `type:"message"` line per message, appended. */
function persist(role, text) {
	if (!persistMessages) return;
	fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } })}\n`, { mode: 0o600 });
}

function respond(id, command, data) {
	writeRecord({ id, type: "response", command, success: true, data });
}

const askOnPrompt = process.argv.includes("--ask-on-prompt");
/** K2-05 U4b: the turn waiting for the user's answer (ask id → its continuation). */
const waitingAsks = new Map();
let askCounter = 0;

function handle(command) {
	logCommand(command);
	switch (command.type) {
		case "extension_ui_response": {
			// a dialog answer is not a command: no response record (Pi's RPC shape)
			const next = waitingAsks.get(command.id);
			if (next) {
				waitingAsks.delete(command.id);
				next(command);
			}
			break;
		}
		case "get_state":
			if (!lazySessionFile && !fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "", { mode: 0o600 });
			respond(command.id, "get_state", { sessionFile });
			break;
		case "switch_session": {
			const step = nextSwitchStep();
			if (step === "hang") break;
			if (step === "fail") {
				writeRecord({ id: command.id, type: "response", command: "switch_session", success: false, error: "could not open the session" });
				break;
			}
			const finish = () => {
				sessionFile = command.sessionPath;
				respond(command.id, "switch_session", { sessionFile: command.sessionPath });
			};
			if (step.startsWith("late ")) setTimeout(finish, Number(step.slice(5)));
			else finish();
			break;
		}
		case "echo":
			respond(command.id, "echo", { value: command.value });
			break;
		case "hang":
			// Never answered on purpose.
			break;
		case "prompt": {
			if (lazySessionFile && !fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "", { mode: 0o600 });
			respond(command.id, "prompt", { disposition: "started" });
			writeRecord({ type: "agent_start" });
			// K2-05 bind by id: the engine records the user message (Pi: message_start, then the
			// append, then message_end) before the reply starts
			const user = { role: "user", content: [{ type: "text", text: String(command.message) }] };
			writeRecord({ type: "message_start", message: user });
			persist("user", String(command.message));
			writeRecord({ type: "message_end", message: user });
			const reply = "hola 😀 línea\u2028separada\u2029fin";
			if (askOnPrompt) {
				const id = `ask-${process.pid}-${++askCounter}`;
				waitingAsks.set(id, (answer) => {
					const said = answer.cancelled ? "sin respuesta" : typeof answer.value === "string" ? `recibí ${answer.value.length} caracteres` : `confirmó ${answer.confirmed}`;
					writeRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: said } });
					persist("assistant", said);
					writeRecord({ type: "agent_end" });
					writeRecord({ type: "agent_settled" });
				});
				writeRecord({ type: "extension_ui_request", id, method: "input", title: "Gentle Shell necesita un nombre", placeholder: "nombre para engram" });
				break;
			}
			const emitRest = () => {
				persist("assistant", reply);
				writeRecord({ type: "agent_end" });
				writeRecord({ type: "agent_settled" });
			};
			const update = {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: reply },
			};
			if (process.argv.includes("--prompt-holds")) {
				// F2: the assistant message is mid-stream and never settles, like a
				// real turn the daemon aborts/timeout-cancels mid-answer.
				writeRecord(update);
				break;
			}
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
