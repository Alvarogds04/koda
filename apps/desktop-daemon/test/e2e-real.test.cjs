"use strict";

// REAL offline smoke: the installed `pi` in a temporary island. Skipped unless ABITO_E2E_PI=1.
// No prompt is sent and no model/provider is contacted (PI_OFFLINE=1 is set by the engine).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { Daemon, readSession } = require("../src/daemon.cjs");

const enabled = process.env.ABITO_E2E_PI === "1";

test("real pi: daemon start, handshake, status, stop (no prompt)", { skip: !enabled && "set ABITO_E2E_PI=1 to run", timeout: 90_000 }, async () => {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-e2e-")));
	const root = path.join(base, "i");
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH, HOME: base },
		engineOptions: { startTimeoutMs: 60_000 },
	});
	await daemon.start();
	let socket;
	try {
		const session = readSession(root);
		assert.ok(session);
		assert.equal(fs.statSync(path.join(root, "runtime", "session.json")).mode & 0o777, 0o600);
		const frames = [];
		socket = net.connect(session.endpoint);
		let buf = "";
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				frames.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		await new Promise((resolve, reject) => {
			socket.once("error", reject);
			socket.once("connect", resolve);
		});
		socket.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token: session.token })}\n`);
		const waitFrame = async (pred) => {
			const end = Date.now() + 10_000;
			while (Date.now() < end) {
				const f = frames.find(pred);
				if (f) return f;
				await new Promise((r) => setTimeout(r, 20));
			}
			assert.fail("frame not received");
		};
		const ready = await waitFrame((f) => f.type === "ready");
		assert.equal(ready.protocol, "island-agent/1");
		socket.write(`${JSON.stringify({ type: "status" })}\n`);
		const state = await waitFrame((f) => f.type === "agent_state");
		assert.equal(state.status, "ready");
		assert.equal(state.busy, false);
		assert.equal(daemon.status().state, "ready");
		assert.equal(JSON.stringify(frames).includes(session.token), false);
	} finally {
		socket?.destroy();
		await daemon.stop();
	}
	assert.equal(fs.existsSync(path.join(root, "runtime", "session.json")), false);
});
