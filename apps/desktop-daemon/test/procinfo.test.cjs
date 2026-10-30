"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parsePsLine, runPs, PS, PS_ARGS } = require("../src/procinfo.cjs");

test("parsePsLine parses lstart, ppid, state, uid and the full command", () => {
	const line = "Mon Jan  2 15:04:05 2006     1 Ss     501 /usr/local/bin/node /app/cli.cjs run --app-owned";
	const info = parsePsLine(line);
	assert.deepStrictEqual({ ...info, start: undefined }, { start: undefined, ppid: 1, state: "S", uid: 501, command: "/usr/local/bin/node /app/cli.cjs run --app-owned" });
	assert.match(info.start, /^[0-9]+$/);
});

test("parsePsLine fails closed on anything unexpected", () => {
	for (const bad of ["", "garbage", "Mon Jan  2 15:04:05 2006", "Xxx Foo  2 15:04:05 2006     1 Ss     501 cmd", "Mon Jan  2 15:04:05 2006   abc Ss     501 cmd", undefined, 7]) {
		assert.strictEqual(parsePsLine(bad), undefined, String(bad));
	}
});

test("runPs uses /bin/ps by absolute path with a fixed argv, no shell, C locale", () => {
	let seen;
	const info = runPs(4242, (file, args, options) => {
		seen = { file, args, options };
		return "Mon Jan  2 15:04:05 2006     7 Z      501 node cli.cjs\n";
	});
	assert.strictEqual(seen.file, PS);
	assert.strictEqual(PS, "/bin/ps");
	assert.deepStrictEqual(seen.args, [...PS_ARGS, "-p", "4242"]);
	assert.ok(PS_ARGS.includes("-ww"));
	assert.strictEqual(seen.options.env.LC_ALL, "C");
	assert.strictEqual(seen.options.shell, undefined);
	assert.strictEqual(info.state, "Z");
});

test("runPs: bad pid, ps failure and multi-line output are all undefined", () => {
	const never = () => { throw new Error("must not run"); };
	for (const pid of [0, -1, 1.5, "1", NaN]) assert.strictEqual(runPs(pid, never), undefined);
	assert.strictEqual(runPs(5, () => { throw new Error("ps gone"); }), undefined);
	assert.strictEqual(runPs(5, () => "a\nb\n"), undefined);
	assert.strictEqual(runPs(5, () => ""), undefined);
});
