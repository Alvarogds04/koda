"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { ConnectorHostClient, ConnectorHostError } = require("../src/connector-host-client.cjs");

async function server(t, respond) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-client-"));
	const endpoint = path.join(dir, "s");
	const srv = net.createServer((socket) => {
		let buf = "";
		socket.on("error", () => {});
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				const frame = JSON.parse(line);
				if (frame.type === "hello") socket.write('{"type":"ready","protocol":"abito-connector-host/1","seq":1}\n');
				else respond(socket, frame);
			}
		});
	});
	await new Promise((resolve) => srv.listen(endpoint, resolve));
	t.after(async () => {
		await new Promise((resolve) => srv.close(resolve));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return endpoint;
}

function client(endpoint) { return new ConnectorHostClient({ endpoint, token: "a".repeat(64), requestTimeoutMs: 500 }); }

test("failedClosed is documented as store rollback health, not connector functionality", () => {
	for (const file of [path.join(__dirname, "..", "README.md"), path.join(__dirname, "..", "docs", "PROTOCOL.md")]) {
		const text = fs.readFileSync(file, "utf8");
		assert.match(text, /failedClosed:false.{0,10}not proof[\s\S]{0,120}keyring[\s\S]{0,40}transport/i, file);
		assert.match(text, /must never present[\s\S]{0,100}connectors work/i, file);
	}
});

test("socket factory failures are normalized and never expose raw details", async () => {
	const c = new ConnectorHostClient({ endpoint: "/private/path", token: "a".repeat(64), socketFactory: () => { throw new Error("PRIVATE-DETAIL"); } });
	await assert.rejects(c.connectSocket(), (error) => error.code === "unavailable" && !error.message.includes("PRIVATE-DETAIL"));
});

test("client validates methods and maps camelCase fields to host wire names", async (t) => {
	const requests = [];
	const endpoint = await server(t, (socket, frame) => {
		requests.push(frame);
		socket.write(`${JSON.stringify(frame.type === "connectors" ? { type: "connectors", schema: "abito-connectors/view/1", entries: [], connectors: [], seq: requests.length + 1 } : frame.type === "pending" ? { type: "pending", items: [], seq: requests.length + 1 } : { type: "result", ok: true, seq: requests.length + 1 })}\n`);
	});
	const c = client(endpoint);
	await c.connectSocket();
	assert.equal(c.request, undefined);
	await c.approve("ap-0123456789abcdef012345670000", "b".repeat(64));
	await c.deny("ap-0123456789abcdef012345670000");
	await c.setEnabled("dropbox", true, 4);
	await c.setMode("dropbox", "read_only", 5);
	assert.deepEqual(requests.map((r) => r.type), ["approve", "deny", "set_enabled", "set_mode"]);
	assert.equal(requests[0].proposal_id, "ap-0123456789abcdef012345670000");
	assert.equal(requests[2].enabled, true);
	c.close();
});

test("closed host errors expose only the fixed code and generic message", async (t) => {
	const endpoint = await server(t, (socket) => socket.write('{"type":"error","code":"unavailable","detail":"SECRET","seq":2}\n'));
	const c = client(endpoint);
	await c.connectSocket();
	await assert.rejects(c.status(), (error) => error instanceof ConnectorHostError && error.code === "unavailable" && !error.message.includes("SECRET"));
	c.close();
});

test("pending reply is rebuilt to camelCase, sanitizes text and drops unknown keys", async (t) => {
	const pending = { proposal_id: "ap-0123456789abcdef012345670000", connector_id: "dropbox", tool: "read", arguments_preview: "safe\u202e", arguments_truncated: false, arguments_sensitive: true, digest: "c".repeat(64), expires_in_ms: 30, secret: "drop" };
	const endpoint = await server(t, (socket) => socket.write(`${JSON.stringify({ type: "pending", items: [pending], seq: 2 })}\n`));
	const c = client(endpoint);
	await c.connectSocket();
	assert.deepEqual(await c.pending(), [{ proposalId: pending.proposal_id, connectorId: "dropbox", tool: "read", argumentsPreview: "safe", argumentsTruncated: true, argumentsSensitive: true, digest: "c".repeat(64), expiresInMs: 30 }]);
	c.close();
});

test("control, bidi, newline and RTL format chars are removed and mark the preview truncated", async (t) => {
	const preview = "left\u0001\u202eright\nשלום\u200f";
	const endpoint = await server(t, (socket) => socket.write(`${JSON.stringify({ type: "pending", items: [{
		proposal_id: "ap-0123456789abcdef012345670000", connector_id: "dropbox", tool: "read", arguments_preview: preview,
		arguments_truncated: false, arguments_sensitive: true, digest: "d".repeat(64), expires_in_ms: 30,
	}], seq: 2})}\n`));
	const c = client(endpoint);
	await c.connectSocket();
	const item = (await c.pending())[0];
	assert.equal(item.argumentsPreview, "leftrightשלום");
	assert.equal(item.argumentsTruncated, true);
	assert.doesNotMatch(item.argumentsPreview, /[\u0000-\u001f\u007f\u202e\u200f]/u);
	c.close();
});

test("malformed and oversized control frames fail closed without raw errors", async (t) => {
	for (const respond of [
		(socket) => socket.write("{not-json}\n"),
		(socket) => socket.write(`${"x".repeat(256 * 1024 + 1)}\n`),
		(socket) => socket.write("x".repeat(256 * 1024 + 1)),
		(socket) => socket.write('{"type":"error","code":"unknown","secret":"PRIVATE","seq":2}\n'),
	]) {
		const endpoint = await server(t, respond);
		const c = new ConnectorHostClient({ endpoint, token: "a".repeat(64), requestTimeoutMs: 200 });
		await c.connectSocket();
		await assert.rejects(c.status(), (error) => error instanceof ConnectorHostError && ["unavailable", "failed"].includes(error.code) && !error.message.includes("PRIVATE"));
		c.close();
	}
});

test("delayed host replies time out and do not retain a pending request", async (t) => {
	const endpoint = await server(t, (socket) => setTimeout(() => socket.write('{"type":"state","protocol":"abito-connector-host/1","pid":2,"startedAt":1,"proxyPort":1,"connectors":0,"pending":0,"failedClosed":true,"seq":2}\n'), 80));
	const c = new ConnectorHostClient({ endpoint, token: "a".repeat(64), requestTimeoutMs: 20 });
	await c.connectSocket();
	const status = c.status();
	const connectors = c.connectors();
	await assert.rejects(status, (error) => error.code === "unavailable");
	await assert.rejects(connectors, (error) => error.code === "unavailable");
	assert.equal(c.pendingRequests.length, 0);
	assert.equal(c.closed, true);
	c.close();
});
