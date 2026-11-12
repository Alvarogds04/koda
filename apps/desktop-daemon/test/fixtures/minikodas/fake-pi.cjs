"use strict";

// K2-13 Minikodas test double for `pi --mode rpc` (JSONL over stdin/stdout). Offline: no model, no network.
// It mimics the parts of Pi a Minikoda run relies on, faithfully enough to exercise the REAL kit extension:
// - loads every `-e <file>` extension with import() and gives it registerTool/on;
// - declares only the tools named by `--tools` (built-in `bash` plus registered tools); a call to an
//   undeclared tool ends as isError "Tool <name> not found" (Pi 1.5.2 behaviour seen in the PoC);
// - runs `tool_call` handlers before executing; `{block:true, reason}` ends as isError with the reason;
// - executes the tool; a throw ends as isError with the message (docs/extensions.md «Signaling errors»).
// The built-in `bash` here only writes the marker file named by its `marker` argument into the cwd, so a
// test can prove it never ran (and, in the negative control, that it does run when both layers allow it).
//
// The turn is scripted by `--script <json file>`: {steps: [{tool, args} | {text} | {crash: code} | {hang: true}]}.
// `--report <file>` receives {argv, declared, envKeys} at startup (no env values except MINIKODA_KIT).

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const argv = process.argv.slice(2);
const argValue = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const allValues = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

const sessionDir = argValue("--session-dir") || ".";
const sessionFile = path.join(sessionDir, `fake-pi-${process.pid}.jsonl`);
const script = JSON.parse(fs.readFileSync(argValue("--script"), "utf8"));
const selection = (argValue("--tools") ?? "").split(",").filter(Boolean);

const tools = new Map();
const handlers = new Map();
tools.set("bash", {
	name: "bash",
	async execute(_id, params) {
		fs.writeFileSync(path.join(process.cwd(), String(params?.marker ?? "bash-ran.txt")), "ran\n");
		return { content: [{ type: "text", text: "ran" }] };
	},
});
const api = {
	registerTool(tool) { tools.set(tool.name, tool); },
	on(event, fn) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
};

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (c, data = {}) => write({ type: "response", id: c.id, command: c.type, success: true, data });

async function callTool(id, name, args) {
	write({ type: "tool_execution_start", toolCallId: id, toolName: name });
	const end = (isError, text) => write({ type: "tool_execution_end", toolCallId: id, toolName: name, isError, result: { content: [{ type: "text", text }] } });
	if (!selection.includes(name) || !tools.has(name)) return end(true, `Tool ${name} not found`);
	for (const fn of handlers.get("tool_call") ?? []) {
		const out = await fn({ toolName: name, toolCallId: id, input: args });
		if (out?.block) return end(true, String(out.reason ?? "blocked"));
	}
	try {
		const result = await tools.get(name).execute(id, args ?? {});
		return end(result?.isError === true, (result?.content ?? []).map((c) => c.text ?? "").join(""));
	} catch (error) {
		return end(true, error.message);
	}
}

async function runTurn() {
	write({ type: "agent_start" });
	let n = 0;
	for (const step of script.steps) {
		n += 1;
		if (step.crash !== undefined) process.exit(step.crash);
		if (step.hang) return; // never settles
		write({ type: "turn_start" });
		if (step.tool) await callTool(`call_${n}`, step.tool, step.args);
		if (step.text !== undefined) write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: step.text }] } });
		write({ type: "turn_end" });
	}
	write({ type: "agent_end" });
	write({ type: "agent_settled" });
}

async function main() {
	for (const file of allValues("-e")) {
		const mod = await import(pathToFileURL(path.resolve(file)).href);
		await mod.default(api);
	}
	const report = argValue("--report");
	if (report) {
		const declared = selection.filter((name) => tools.has(name));
		fs.writeFileSync(report, JSON.stringify({ argv, declared, kitEnv: process.env.MINIKODA_KIT ?? null, gentleAgents: process.env.GENTLE_PI_AGENTS ?? null, home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() }));
	}
	let buffer = "";
	process.stdin.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let i;
		while ((i = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (!line.trim()) continue;
			const c = JSON.parse(line);
			if (c.type === "get_state") {
				if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "", { mode: 0o600 });
				respond(c, { sessionFile });
			} else if (c.type === "prompt") {
				respond(c, { disposition: "started" });
				runTurn().catch((error) => {
					process.stderr.write(`fake-pi turn failed: ${error.message}\n`);
					process.exit(9);
				});
			} else respond(c);
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

main().catch((error) => {
	process.stderr.write(`fake-pi failed: ${error.message}\n`);
	process.exit(8);
});
