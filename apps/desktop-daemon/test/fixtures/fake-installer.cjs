"use strict";

// Fake `abito-hook.cjs install ...` for the AgentsManager unit tests. A generated wrapper script
// in a temp dir calls `require(<this file>)(<scenarioFile>)`. The scenario is re-read on every call,
// so a test can change what the "installer" answers between calls. Every invocation is appended to
// `<scenarioFile>.calls` (argv, full child env, ppid) so tests can assert exactly what was spawned.
//
// Scenario: { "<harness>": { "<kind>": SPEC }, "<kind>": SPEC }  with kind in
//   preview | previewRemove | apply | applyRemove
// SPEC: { exit, stdout (object -> one JSON line | string raw), stderr?, delayMs?, mode? }
//   mode "hang": spawns a grandchild (pid -> scenario.pidFile) and never exits
//   mode "oversize": prints 2 MiB
//   mode "stderr-flood": prints a valid answer after flooding stderr

const fs = require("node:fs");
const { spawn } = require("node:child_process");

module.exports = function main(scenarioFile) {
	const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
	const argv = process.argv.slice(2);
	fs.appendFileSync(`${scenarioFile}.calls`, `${JSON.stringify({ argv, env: process.env, ppid: process.ppid, pid: process.pid })}\n`);
	const harness = argv[1];
	const kind = `${argv.includes("--apply-plan") ? "apply" : "preview"}${argv.includes("--remove") ? "Remove" : ""}`;
	const spec = scenario[harness]?.[kind] ?? scenario[kind] ?? { exit: 65, stdout: { schema: "abito-hook-install/1", ok: false, code: "refused", message: "input or settings file refused" } };
	const finish = () => {
		if (spec.stderr) process.stderr.write(spec.stderr);
		if (spec.mode === "hang") {
			spawn(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(scenario.pidFile)},String(process.pid));setInterval(()=>{},1000)`], { stdio: "ignore" });
			setInterval(() => {}, 1000);
			return;
		}
		if (spec.mode === "oversize") {
			process.stdout.write("x".repeat(2 * 1024 * 1024), () => process.exit(spec.exit ?? 0));
			return;
		}
		if (spec.mode === "stderr-flood") process.stderr.write("E".repeat(2 * 1024 * 1024));
		const out = typeof spec.stdout === "string" ? spec.stdout : `${JSON.stringify(spec.stdout)}\n`;
		process.stdout.write(out, () => process.exit(spec.exit ?? 0));
	};
	if (spec.delayMs) setTimeout(finish, spec.delayMs);
	else finish();
};
