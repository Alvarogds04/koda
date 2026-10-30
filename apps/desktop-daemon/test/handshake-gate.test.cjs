"use strict";

// W1 gate tests. The named pipe on Windows cannot carry a node-set DACL, so the token handshake is the
// only gate: these assert it on whatever transport the platform uses (Unix socket on Linux/macOS, a
// named pipe on Windows) and, on Windows only, that the endpoint really is a pipe.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { IslandServer } = require("../src/server.cjs");

const TOKEN = "g".repeat(43);

async function start(t, limits = {}) {
	const runtimeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), "r");
	t.after(() => fs.rmSync(path.dirname(runtimeDir), { recursive: true, force: true }));
	const engine = Object.assign(new EventEmitter(), { status: "ready", request: async () => ({}) });
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine, limits });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return endpoint;
}

/** Connects and records bytes + close; resolves the observation after `ms`. */
function observe(endpoint, ms, write) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(endpoint);
		let bytes = 0;
		let closedAt;
		const begin = Date.now();
		socket.on("data", (d) => (bytes += d.length));
		socket.on("close", () => (closedAt = Date.now() - begin));
		socket.on("error", () => {});
		socket.on("connect", () => write?.(socket));
		setTimeout(() => {
			socket.destroy();
			resolve({ bytes, closedAt });
		}, ms);
	});
}

test("a connection that never sends a token gets ZERO bytes and is closed within the handshake bound", async (t) => {
	const endpoint = await start(t, { handshakeMs: 400 });
	const seen = await observe(endpoint, 1200);
	assert.equal(seen.bytes, 0);
	assert.ok(seen.closedAt !== undefined && seen.closedAt <= 1000, `closed at ${seen.closedAt}`);
});

test("a wrong token gets ZERO bytes and the connection is closed", async (t) => {
	const endpoint = await start(t);
	const seen = await observe(endpoint, 600, (s) => s.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token: "x".repeat(43) })}\n`));
	assert.equal(seen.bytes, 0);
	assert.ok(seen.closedAt !== undefined);
});

test("garbage instead of a hello gets ZERO bytes and the connection is closed", async (t) => {
	const endpoint = await start(t);
	const seen = await observe(endpoint, 600, (s) => s.write("GET / HTTP/1.1\r\n\r\n"));
	assert.equal(seen.bytes, 0);
	assert.ok(seen.closedAt !== undefined);
});

test("the right token still gets a ready frame", async (t) => {
	const endpoint = await start(t);
	let got = "";
	await observe(endpoint, 400, (s) => {
		s.on("data", (d) => (got += d));
		s.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token: TOKEN })}\n`);
	});
	assert.equal(JSON.parse(got.split("\n")[0]).type, "ready");
});

test("windows: the endpoint is a named pipe with a random name", { skip: process.platform !== "win32" }, async (t) => {
	const a = await start(t);
	const b = await start(t);
	assert.match(a, /^\\\\\.\\pipe\\abito-[0-9a-f]{32}$/);
	assert.notEqual(a, b);
});
