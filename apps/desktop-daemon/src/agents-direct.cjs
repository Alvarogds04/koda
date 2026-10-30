"use strict";

/**
 * Daemon-free entry for the Settings hook installer (HU-015). The Tauri host runs this file with node, ONCE per
 * Settings action, so Claude Code / Codex / ... hooks can be listed, installed and removed whether the chat engine
 * (the daemon, which needs Pi) is up or not. It adds NO new installer logic: it drives the very same AgentsManager
 * (preview -> plan-hash check -> apply-plan, backup, audit, trusted fixed installer script, bounded time/output,
 * shell:false) and the same hooks catalogue the daemon uses, then prints the two closed protocol frames.
 *
 * Trust boundary: argv is a closed grammar (op + allowlisted agent id + required 64-hex plan hash for connect). The installer
 * is NEVER taken from argv/env: it is the harness that ships next to this file. Output is one line of JSON built by
 * protocol.cjs agentsFrame/hooksFrame (closed vocabularies), never installer text.
 *
 *   node agents-direct.cjs list
 *   node agents-direct.cjs connect <agentId> <planHash>
 *   node agents-direct.cjs disconnect <agentId>
 *
 * Env: ABITO_ISLAND_DIR (absolute; audit goes to <dir>/audit), HOME or USERPROFILE.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AGENTS, AgentsManager } = require("./agents.cjs");
const { createAgentHooks } = require("./agent-hooks.cjs");
const { ensurePrivateDir } = require("./isolation.cjs");
const { validateHome } = require("./mcp-import.cjs");
const P = require("./protocol.cjs");

const HASH = /^[0-9a-f]{64}$/;
const HARD_LIMIT_MS = 120_000;

/** Closed grammar. Returns undefined for anything else. */
function parseArgs(argv) {
	if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) return undefined;
	const [op, id, planHash, ...rest] = argv;
	if (rest.length > 0) return undefined;
	if (op === "list") return id === undefined ? { op } : undefined;
	if (op !== "connect" && op !== "disconnect") return undefined;
	if (!AGENTS.some((a) => a.id === id)) return undefined;
	if (op === "disconnect") return planHash === undefined ? { op, id } : undefined;
	if (typeof planHash !== "string" || !HASH.test(planHash)) return undefined;
	return { op, id, planHash };
}

/** The harness installer that ships next to this file (same layout as cli.cjs packagedInstallerBin). */
function packagedInstallerBin(srcDir = __dirname) {
	const file = path.resolve(srcDir, "..", "..", "desktop-harness", "bin", "abito-hook.cjs");
	try {
		return fs.statSync(file).isFile() ? file : undefined;
	} catch {
		return undefined;
	}
}

/** Runs one parsed command and returns { agents: <agents frame>, hooks: <hooks frame> }. */
async function execute(cmd, { home, islandDir, installerBin, agentsOptions = {}, hooksOptions = {} }) {
	const agents = new AgentsManager({ installerBin, home, islandDir, ...agentsOptions });
	const hooks = createAgentHooks({ home, agents, nodeExe: process.execPath, ...hooksOptions });
	let entries;
	if (cmd.op === "connect") entries = await agents.connect(cmd.id, cmd.planHash);
	else if (cmd.op === "disconnect") entries = await agents.disconnect(cmd.id);
	else entries = await agents.list();
	return { agents: P.agentsFrame(entries), hooks: P.hooksFrame(await hooks.preview()) };
}

/**
 * CLI body. `deps` is a test seam (installerBin/agentsOptions/hooksOptions). Resolves the process exit code;
 * writes exactly one line to `out` (the answer, or {"error":"failed"|"bad_request"}).
 */
async function main(argv, env, out, deps = {}) {
	const cmd = parseArgs(argv);
	const say = (value) => out.write(`${JSON.stringify(value)}\n`);
	if (!cmd) {
		say({ error: "bad_request" });
		return 2;
	}
	try {
		const home = validateHome(env.HOME || env.USERPROFILE || os.homedir());
		const dir = env.ABITO_ISLAND_DIR || path.join(home, ".abito-island");
		if (!path.isAbsolute(dir)) throw new Error("island dir");
		const islandDir = ensurePrivateDir(dir);
		ensurePrivateDir(path.join(islandDir, "audit"));
		const installerBin = "installerBin" in deps ? deps.installerBin : packagedInstallerBin();
		say(await execute(cmd, { home, islandDir, installerBin, agentsOptions: deps.agentsOptions, hooksOptions: deps.hooksOptions }));
		return 0;
	} catch (error) {
		say({ error: error?.code === "bad_request" ? "bad_request" : "failed" });
		return 1;
	}
}

if (require.main === module) {
	const timer = setTimeout(() => process.exit(1), HARD_LIMIT_MS);
	timer.unref?.();
	main(process.argv.slice(2), process.env, process.stdout).then((code) => {
		process.exitCode = code;
	});
}

module.exports = { parseArgs, packagedInstallerBin, execute, main };
