#!/usr/bin/env node
"use strict";

// Local Unix-socket fixture for the daemon supervisor tests. Never opens a network socket.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const island = process.argv[process.argv.indexOf("--island") + 1];
const parent = process.argv[process.argv.indexOf("--parent") + 1];
const modeFile = path.join(island, ".fake-host-mode.json");
let mode = {};
try { mode = JSON.parse(fs.readFileSync(modeFile, "utf8")); } catch {}
if (Number(parent) !== process.ppid) process.exit(1);
if (mode.refuse) process.exit(1);
if (mode.ignoreTerm) process.on("SIGTERM", () => {});
if (mode.hangStartup) { setInterval(() => {}, 1000); return; }

function procStart(pid) {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	return Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]);
}
const runRoot = path.join(island, "connector-host-run");
fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(runRoot, 0o700);
const runDir = fs.mkdtempSync(path.join(runRoot, "p-"));
fs.chmodSync(runDir, 0o700);
let endpoint = path.join(runDir, "s");
const token = "a".repeat(64);
if (mode.endpointOutside) endpoint = path.join(island, "outside", "s");
if (mode.endpointOutside) fs.mkdirSync(path.dirname(endpoint), { mode: 0o700 });
const handoff = { protocol: "abito-connector-host/1", endpoint, token, pid: mode.pidMismatch ? process.pid + 1 : process.pid, procStart: procStart(process.pid) + (mode.procMismatch ? 1 : 0), startedAt: Date.now() };
if (mode.extraKey) handoff.extra = true;
if (mode.wrongToken) handoff.token = "wrong";
if (mode.badToken) handoff.token = "g".repeat(64);
const handoffText = JSON.stringify(Object.fromEntries(Object.keys(handoff).sort().map((key) => [key, handoff[key]])));

const sockets = new Set();
const writers = new Map();
const subscribers = new Set();
let pendingItems = Array.isArray(mode.pendingItems) ? mode.pendingItems : [];
let connectorItems = Array.isArray(mode.connectorItems) ? mode.connectorItems : [];
function transcript(frame) {
	if (!mode.transcriptFile) return;
	const safe = frame.type === "connect" ? frame : Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "values"));
	fs.appendFileSync(mode.transcriptFile, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
}
function broadcast(frame) { for (const socket of subscribers) writers.get(socket)?.(frame); }
function sendConnectors() { broadcast({ type: "connectors", schema: "abito-connectors/view/1", entries: [], connectors: connectorItems }); }
function sendPending() { broadcast({ type: "pending", items: pendingItems }); }
const server = net.createServer((socket) => {
	sockets.add(socket);
	socket.once("close", () => { sockets.delete(socket); subscribers.delete(socket); writers.delete(socket); });
	let buffer = "";
	let seq = 0;
	let authed = false;
	const write = (frame) => socket.write(`${JSON.stringify({ ...frame, seq: ++seq })}\n`);
	writers.set(socket, write);
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let at;
		while ((at = buffer.indexOf("\n")) >= 0) {
			const text = buffer.slice(0, at); buffer = buffer.slice(at + 1);
			let frame;
			try { frame = JSON.parse(text); } catch { socket.destroy(); return; }
			if (!authed) {
				authed = true;
				if (frame.token !== token || mode.wrongTokenReply) { socket.destroy(); return; }
				write({ type: "ready", protocol: "abito-connector-host/1" });
				continue;
			}
			if (mode.malformed) { socket.write("{bad json}\n"); continue; }
			if (mode.oversized) { socket.write(`${"x".repeat(256 * 1024 + 1)}\n`); continue; }
			if (mode.errorCode) { write({ type: "error", code: mode.errorCode }); continue; }
			if (frame.type === "shutdown" && mode.neverAckShutdown) continue;
			transcript(frame);
			if (frame.type === "subscribe") {
				if (frame.enabled) subscribers.add(socket); else subscribers.delete(socket);
				write({ type: "result", ok: true });
				continue;
			}
			if (frame.type === "approve" || frame.type === "deny") {
				pendingItems = pendingItems.filter((item) => item.proposal_id !== frame.proposal_id);
				sendPending();
				sendConnectors();
				write({ type: "result", ok: true });
				continue;
			}
			if (frame.type === "connect") {
				let current = connectorItems.find((item) => item.id === frame.id);
				if (!current) {
					current = { id: frame.id, label: mode.connectorLabel || frame.id, catalog_key: mode.connectorCatalogKey || frame.id, mode: "read_only", enabled: true, status: { state: "connected" }, revision: 0, configured: true };
					connectorItems.push(current);
				} else { current.revision++; current.configured = true; current.status = { state: "connected" }; }
				sendConnectors();
				write({ type: "result", ok: true });
				continue;
			}
			if (frame.type === "disconnect" || frame.type === "set_mode") {
				const current = connectorItems.find((item) => item.id === frame.id);
				if (current) { current.revision++; if (frame.type === "set_mode") current.mode = frame.mode; else current.status = { state: "disabled" }; }
				sendConnectors();
				write({ type: "result", ok: true });
				continue;
			}
			const reply = frame.type === "status" ? { type: "state", protocol: "abito-connector-host/1", pid: process.pid, startedAt: handoff.startedAt, proxyPort: 1, connectors: connectorItems.length, pending: pendingItems.length, failedClosed: true }
				: frame.type === "connectors" ? { type: "connectors", schema: "abito-connectors/view/1", entries: [], connectors: connectorItems }
				: frame.type === "pending" ? { type: "pending", items: pendingItems }
				: { type: "result", ok: true };
			if (mode.delayMs) setTimeout(() => write(reply), mode.delayMs);
			else write(reply);
			if (frame.type === "shutdown") {
				if (mode.delayMs) setTimeout(cleanExit, mode.delayMs + 5);
				else setImmediate(cleanExit);
			}
		}
	});
});
function writeAtomic(file, text, mode = 0o600) {
	const temp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temp, text, { mode });
	fs.chmodSync(temp, mode);
	fs.renameSync(temp, file);
}
function cleanExit() {
	try { fs.unlinkSync(path.join(island, "connector-host.json")); } catch {}
	try { fs.unlinkSync(path.join(island, "connectors", "mcp-source.json")); } catch {}
	try { fs.unlinkSync(endpoint); } catch {}
	try { fs.rmdirSync(runDir); } catch {}
	try { fs.rmdirSync(runRoot); } catch {}
	for (const socket of sockets) socket.destroy();
	server.close(() => process.exit(0));
}
server.listen(endpoint, () => {
	fs.chmodSync(endpoint, mode.badSocket ? 0o666 : 0o600);
	const handoffFile = path.join(island, "connector-host.json");
	if (mode.symlinkHandoff) {
		const real = path.join(island, ".handoff-real");
		writeAtomic(real, handoffText + "\n");
		fs.symlinkSync(real, handoffFile);
	} else if (mode.escapedKey) {
		writeAtomic(handoffFile, (handoffText + "\n").replace('"protocol"', '"pro\\u0074ocol"'));
	} else {
		let text = handoffText + "\n";
		if (mode.reverseHandoffKeys) text = `${JSON.stringify(Object.fromEntries(Object.keys(handoff).sort().reverse().map((key) => [key, handoff[key]])))}\n`;
		if (mode.bomHandoff) text = `\uFEFF${text}`;
		if (mode.noHandoffLf) text = handoffText;
		if (mode.crlfHandoff) text = handoffText + "\r\n";
		if (mode.doubleHandoffLf) text = handoffText + "\n\n";
		if (mode.prettyHandoff) text = `${JSON.stringify(JSON.parse(handoffText), null, 2)}\n`;
		writeAtomic(handoffFile, text, mode.badMode ? 0o644 : 0o600);
	}
	if (mode.crashAfterMs) setTimeout(() => process.exit(70), mode.crashAfterMs);
});
