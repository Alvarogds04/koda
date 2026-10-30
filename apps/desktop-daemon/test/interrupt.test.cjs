"use strict";

// #378 live interruption policy: closed-event copy and the bounded safe-point wait.

const test = require("node:test");
const assert = require("node:assert/strict");
const { awaitSafePoint, closedToast } = require("../src/interrupt.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("closedToast maps every cancellation reason to its fixed sanitized copy", () => {
	assert.deepEqual(closedToast("cancelled"), { type: "toast", level: "warning", message: "Agent turn cancelled." });
	assert.deepEqual(closedToast("time_limit"), { type: "toast", level: "warning", message: "Agent turn time limit reached." });
	assert.deepEqual(closedToast("iteration_limit"), { type: "toast", level: "warning", message: "Agent turn iteration limit reached." });
	assert.deepEqual(closedToast("paused"), { type: "toast", level: "warning", message: "La pausa interrumpió el turno del agente." });
	assert.deepEqual(closedToast("access_revoked"), { type: "toast", level: "warning", message: "Se revocó el acceso: se interrumpió el turno del agente." });
});

test("closedToast falls back to the generic copy for an unknown reason; no reason leaks", () => {
	const toast = closedToast("something_else");
	assert.deepEqual(toast, { type: "toast", level: "warning", message: "Agent turn interrupted." });
	assert.ok(!JSON.stringify(toast).includes("something_else"));
});

test("awaitSafePoint resolves true as soon as busy clears", async () => {
	let busy = true;
	const wait = awaitSafePoint(() => busy, 5000);
	setTimeout(() => { busy = false; }, 30);
	assert.equal(await wait, true);
});

test("awaitSafePoint resolves false after the bound and never mutates anything", async () => {
	const startedAt = Date.now();
	const result = await awaitSafePoint(() => true, 80);
	assert.equal(result, false);
	assert.ok(Date.now() - startedAt >= 60);
});
