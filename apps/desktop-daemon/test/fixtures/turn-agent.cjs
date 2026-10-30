"use strict";
// Offline controllable Pi-style child. Every command/event crosses JSONL.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv;
const arg = (name) => args[args.indexOf(name) + 1];
const log = arg("--command-log");
const sessions = arg("--session-dir");
// #386 rotation fixture extensions (all optional):
//   --usage-percent <n>   get_session_stats reports contextUsage.percent = n
//   --usage-null          contextUsage.percent is null (real Pi after compaction)
//   --messages-file <p>   get_messages replies with the JSON array read from <p>
//   --messages-error      get_messages fails (success:false)
//   --messages-garbage    get_messages replies with a non-array messages field
//   --settle-all          every prompt settles (turn_start/turn_end/agent_end/agent_settled)
const usagePercent = args.includes("--usage-percent") ? Number(arg("--usage-percent")) : undefined;
const messagesFile = arg("--messages-file");
const settleAll = args.includes("--settle-all");
fs.appendFileSync(log, JSON.stringify({ type: "fixture_spawn", pid: process.pid }) + "\n");
let sessionFile = path.join(sessions, `turn-${process.pid}.jsonl`);
let sessionCounter = 0;
// Real Pi reports its session path but writes the file only after the first message.
const lazy = args.includes("--lazy-session");
const touch = () => { if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "", { mode: 0o600 }); };
if (!lazy) touch();
const write = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const reply = (c, data = {}) => write({ type: "response", id: c.id, command: c.type, success: true, data });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const c = JSON.parse(line);
	fs.appendFileSync(log, JSON.stringify({ ...c, pid: process.pid, sessionFile }) + "\n");
	switch (c.type) {
		case "get_state": return reply(c, { sessionFile });
		case "get_session_stats": {
			if (usagePercent === undefined && !args.includes("--usage-null")) return reply(c, { sessionFile });
			const percent = args.includes("--usage-null") ? null : usagePercent;
			return reply(c, { sessionFile, contextUsage: { tokens: 1000, contextWindow: 100000, percent } });
		}
		case "get_messages": {
			if (args.includes("--messages-error")) return write({ type: "response", id: c.id, command: c.type, success: false, error: "messages unavailable" });
			if (args.includes("--messages-garbage")) return reply(c, { messages: "not-an-array" });
			return reply(c, { messages: messagesFile ? JSON.parse(fs.readFileSync(messagesFile, "utf8")) : [] });
		}
		case "switch_session":
		case "new_session": {
			if (c.type === "switch_session" && args.includes("--reopen-crash-once") &&
				fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.type === "switch_session").length === 1) process.exit(1);
			if (c.type === "switch_session" && args.includes("--switch-unconfirmed")) return reply(c);
			if (c.type === "new_session" && args.includes("--reset-fail")) return write({ type: "response", id: c.id, command: c.type, success: false, error: "reset failed" });
			sessionFile = c.type === "switch_session" ? c.sessionPath : path.join(sessions, `new-${process.pid}-${++sessionCounter}.jsonl`);
			if (!lazy || c.type === "switch_session") touch();
			// Faults target the requested reset, not the separate recovery reopen.
			if (c.type === "new_session" && args.includes("--reset-crash")) return process.exit(1);
			if (c.type === "new_session" && args.includes("--reset-lost")) return;
			if (args.includes("--reset-delay")) return setTimeout(() => reply(c, { sessionFile }), 180);
			return reply(c, { sessionFile });
		}
		case "prompt":
			touch();
			write({ type: "agent_start" });
			if (c.message !== "lost-ack") reply(c, { disposition: "started" });
			if (c.message === "healthy" || settleAll) {
				write({ type: "turn_start" });
				write({ type: "turn_end" });
				write({ type: "agent_end" });
				write({ type: "agent_settled" });
			}
			return;
		case "abort":
			if (!args.includes("--abort-no-ack")) reply(c);
			if (args.includes("--abort-settle")) {
				write({ type: "agent_settled" });
				// Buffered terminal/output records may follow settlement in this child.
				write({ type: "agent_start" });
				write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "STALE" } });
				write({ type: "extension_ui_request", id: "late", method: "confirm", title: "STALE" });
			}
			return;
		case "emit":
			for (const event of c.events) write(event);
			return reply(c);
		default: return reply(c);
	}
}).on("close", () => process.exit(0));
