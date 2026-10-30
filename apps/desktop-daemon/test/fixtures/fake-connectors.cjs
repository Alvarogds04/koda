"use strict";

// Test double for the `abito-connectors` CLI (query layer abito-connectors/view/1).
// Never contacts anything. Behaviour is chosen by the generated shim, which sets:
//   FAKE_MODE        ok | poison | wrongschema | exit1 | hang | oversize | twolines | badutf8
//                    | toomany | bidi | nonjson | noeol
//   FAKE_ONLY        optional "catalog" | "status": the mode applies to that command only
//   FAKE_FIXTURES    directory holding the golden catalog.json / status.json
//   FAKE_SPAWN_LOG   append one line per invocation
//   FAKE_ENV_OUT     dump process.env as JSON
//   FAKE_PID_OUT     write the pid (hang test: the daemon must kill it)
//   FAKE_ARGV_OUT    append the argv as a JSON line
// stderr always carries a decoy that must never reach the daemon surface.

const fs = require("node:fs");
const path = require("node:path");

const env = process.env;
const [command] = process.argv.slice(2);
if (env.FAKE_SPAWN_LOG) fs.appendFileSync(env.FAKE_SPAWN_LOG, `${command}\n`);
if (env.FAKE_ENV_OUT) fs.writeFileSync(env.FAKE_ENV_OUT, JSON.stringify(process.env));
if (env.FAKE_PID_OUT) fs.writeFileSync(env.FAKE_PID_OUT, String(process.pid));
if (env.FAKE_ARGV_OUT) fs.appendFileSync(env.FAKE_ARGV_OUT, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
process.stderr.write("STDERR-DECOY /home/secret/path sk-STDERRSECRET\n");

const golden = (name) => JSON.parse(fs.readFileSync(path.join(env.FAKE_FIXTURES, `${name}.json`), "utf8"));
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (command !== "catalog" && command !== "status") {
	process.stderr.write("usage\n");
	process.exit(2);
}
const mode = env.FAKE_ONLY && env.FAKE_ONLY !== command ? "ok" : (env.FAKE_MODE ?? "ok");
const base = golden(command);
const list = command === "catalog" ? "entries" : "connectors";

const POISON = {
	url: "https://SECRETMARK.example/mcp",
	command: "SECRETMARK-cmd",
	args: ["SECRETMARK"],
	env: { TOKEN: "SECRETMARK" },
	headers: { Authorization: "Bearer SECRETMARK" },
	token: "SECRETMARK",
	capability: "SECRETMARK",
	oauth: { client_secret: "SECRETMARK" },
	upstream: { url: "SECRETMARK" },
	ref: "secret://SECRETMARK",
	secret_ref: "SECRETMARK",
	value: "SECRETMARK",
	__proto__x: "SECRETMARK",
};

switch (mode) {
	case "ok":
		out(base);
		break;
	case "poison": {
		const poisoned = { ...base, ...POISON };
		poisoned[list] = base[list].map((item) => {
			const next = { ...item, ...POISON };
			if (item.status) next.status = { ...item.status, ...POISON };
			if (item.fields) next.fields = item.fields.map((f) => ({ ...f, ...POISON }));
			if (item.guide) next.guide = { ...item.guide, ...POISON };
			return next;
		});
		out(poisoned);
		break;
	}
	case "wrongschema":
		out({ ...base, schema: "abito-connectors/view/2" });
		break;
	case "exit1":
		process.stderr.write('{"error":"unsafe_directory","path":"/home/secret"}\n');
		process.exit(1);
		break;
	case "grandchild":
	case "grandchild_exit": {
		// grandchild in the same process group: writes a marker after 1.5 s unless the group is killed
		require("node:child_process").spawn(process.execPath, ["-e", `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(env.FAKE_MARKER)},"x"),1500)`], { stdio: "ignore" });
		if (mode === "grandchild_exit") process.exit(1);
		setInterval(() => {}, 1000);
		break;
	}
	case "hang":
		setInterval(() => {}, 1000);
		break;
	case "oversize":
		process.stdout.write(`${JSON.stringify({ ...base, pad: "a".repeat(400 * 1024) })}\n`);
		break;
	case "twolines":
		process.stdout.write(`${JSON.stringify(base)}\n${JSON.stringify(base)}\n`);
		break;
	case "badutf8":
		process.stdout.write(Buffer.concat([Buffer.from('{"schema":"abito-connectors/view/1","x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]));
		break;
	case "toomany": {
		const max = command === "catalog" ? 33 : 257;
		const items = [];
		for (let i = 0; i < max; i++) items.push({ ...base[list][i % base[list].length], ...(command === "status" ? { id: `c${i}` } : { key: `k${i}` }) });
		out({ ...base, [list]: items });
		break;
	}
	case "bidi": {
		const items = base[list].map((item, i) => (i === 0 ? { ...item, label: "Evil\u202eLabel" } : item));
		out({ ...base, [list]: items });
		break;
	}
	case "nonjson":
		process.stdout.write("not json\n");
		break;
	case "noeol":
		process.stdout.write(JSON.stringify(base));
		break;
	default:
		process.exit(3);
}
