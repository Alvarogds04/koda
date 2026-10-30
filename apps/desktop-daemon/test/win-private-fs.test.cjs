"use strict";

// HU-061: the Windows branch of the credential writers, driven on any OS through the HU-047 fake backend
// (winfs.useForTests). Fail-closed: nothing is written when the helper cannot be trusted or refuses.

const { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const baseTest = require("node:test");
const assert = require("node:assert/strict");

const winfs = require("../src/win-fs.cjs");
const { ensurePrivateDir, writePrivateFile } = require("../src/isolation.cjs");
const { AccountManager, CredentialStoreError, STORE_NOT_PRIVATE_MESSAGE } = require("../src/auth.cjs");
const { fakeBackend } = require("./win-fake-backend.cjs");

// The fake backend judges POSIX mode bits, which NTFS does not have (lstat reports 0o666/0o777): on Windows the REAL helper is exercised by the
// twins in auth.test.cjs / profiles.test.cjs (assertPrivate) instead.
const test = (name, fn) => baseTest(name, { skip: process.platform === "win32" && "fake POSIX backend; Windows twins use the real helper (auth.test.cjs, profiles.test.cjs)" }, fn);
const root0 = () => mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "abito-winfs-test-"));
const sha = (s) => winfs.sha256(Buffer.from(s));

/** Fake backend wrapped with a spy over every mutating call. */
function spied() {
	const calls = [];
	const base = fakeBackend();
	const backend = {
		...base,
		makeDir: (p) => (calls.push(["makeDir", p]), base.makeDir(p)),
		writePrivate: (p, d, e) => (calls.push(["writePrivate", p, e]), base.writePrivate(p, d, e)),
		remove: (p) => (calls.push(["remove", p]), base.remove(p)),
		move: (a, b) => (calls.push(["move", a, b]), base.move(a, b)),
	};
	return { backend, calls };
}

async function withBackend(backend, fn) {
	winfs.useForTests(backend);
	try {
		return await fn();
	} finally {
		winfs.useForTests(null);
	}
}

test("writePrivateFile goes through the helper: every missing dir via makeDir outermost first, file via writePrivate(expect null)", async () => {
	const root = root0();
	try {
		const { backend, calls } = spied();
		await withBackend(backend, () => {
			const target = path.join(root, "a", "b", "c.json");
			writePrivateFile(target, "{}\n");
			assert.deepEqual(calls.filter((c) => c[0] === "makeDir").map((c) => c[1]), [path.join(root, "a"), path.join(root, "a", "b")]);
			assert.deepEqual(calls.find((c) => c[0] === "writePrivate"), ["writePrivate", target, null]);
			assert.equal(readFileSync(target, "utf8"), "{}\n");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writePrivateFile overwrites with the expect hash of what it read", async () => {
	const root = root0();
	try {
		const { backend, calls } = spied();
		await withBackend(backend, () => {
			const target = path.join(root, "x.json");
			writePrivateFile(target, "one\n");
			writePrivateFile(target, "two\n");
			const writes = calls.filter((c) => c[0] === "writePrivate");
			assert.equal(writes[0][2], null);
			assert.equal(writes[1][2], sha("one\n"));
			assert.equal(readFileSync(target, "utf8"), "two\n");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writePrivateFile retries a bounded number of times on mismatch, then fails closed", async () => {
	const root = root0();
	try {
		const base = fakeBackend();
		let n = 0;
		const flaky = { ...base, writePrivate: (p, d, e) => (++n < 3 ? (() => { throw new winfs.WinFsError("mismatch"); })() : base.writePrivate(p, d, e)) };
		await withBackend(flaky, () => {
			writePrivateFile(path.join(root, "r.json"), "ok\n");
			assert.equal(n, 3);
		});
		n = -1000;
		const always = { ...base, writePrivate: () => { n++; throw new winfs.WinFsError("mismatch"); } };
		await withBackend(always, () => {
			assert.throws(() => writePrivateFile(path.join(root, "s.json"), "no\n"), /mismatch/);
			assert.ok(n < -1000 + 20, "retries are bounded");
		});
		assert.equal(existsSync(path.join(root, "s.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writePrivateFile refuses a symlinked target and leaves the victim intact", async () => {
	const root = root0();
	try {
		const victim = path.join(root, "victim.txt");
		writeFileSync(victim, "VICTIM\n", { mode: 0o644 });
		const { backend, calls } = spied();
		await withBackend(backend, () => {
			symlinkSync(victim, path.join(root, "link.json"));
			assert.throws(() => writePrivateFile(path.join(root, "link.json"), "x"), /reparse|symlink/);
			assert.equal(calls.some((c) => c[0] === "writePrivate"), false);
		});
		assert.equal(readFileSync(victim, "utf8"), "VICTIM\n");
		assert.equal(statSync(victim).mode & 0o777, 0o644);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writePrivateFile refuses a loose existing target it cannot read privately", async () => {
	const root = root0();
	try {
		const target = path.join(root, "loose.json");
		writeFileSync(target, "SECRET\n", { mode: 0o600 });
		chmodSync(target, 0o644);
		const { backend, calls } = spied();
		await withBackend(backend, () => {
			assert.throws(() => writePrivateFile(target, "new\n"), /not_private/);
			assert.equal(calls.some((c) => c[0] === "writePrivate"), false);
		});
		assert.equal(readFileSync(target, "utf8"), "SECRET\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writePrivateFile refuses content over the 1 MiB helper cap (no loose fallback)", async () => {
	const root = root0();
	try {
		const { backend, calls } = spied();
		await withBackend(backend, () => {
			assert.throws(() => writePrivateFile(path.join(root, "big.json"), Buffer.alloc(winfs.MAX_FILE + 1, 97)), /too_large/);
			assert.equal(calls.some((c) => c[0] === "writePrivate"), false);
			assert.equal(existsSync(path.join(root, "big.json")), false);
			writePrivateFile(path.join(root, "edge.json"), Buffer.alloc(winfs.MAX_FILE, 97));
			assert.equal(statSync(path.join(root, "edge.json")).size, winfs.MAX_FILE);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("when the helper cannot be trusted, writePrivateFile and ensurePrivateDir throw and write nothing", () => {
	const root = root0();
	const original = winfs.active;
	try {
		winfs.active = () => {
			throw new winfs.WinFsError("helper_untrusted", "install manifest unreadable");
		};
		assert.throws(() => writePrivateFile(path.join(root, "d", "f.json"), "x"), /helper_untrusted/);
		assert.throws(() => ensurePrivateDir(path.join(root, "e")), /helper_untrusted/);
		assert.equal(existsSync(path.join(root, "d")), false);
		assert.equal(existsSync(path.join(root, "e")), false);
	} finally {
		winfs.active = original;
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensurePrivateDir verifies the result and fails closed when the helper reports it not private / a reparse point", async () => {
	const root = root0();
	try {
		const base = fakeBackend();
		const dir = path.join(root, "p", "q");
		for (const patch of [{ private: false }, { reparse: true }, { kind: "file" }, { parent_ok: false }]) {
			const bad = { ...base, checkPath: (p) => (p === dir ? { ...base.checkPath(p), ...patch } : base.checkPath(p)) };
			await withBackend(bad, () => assert.throws(() => ensurePrivateDir(dir), /private|reparse|directory/i, JSON.stringify(patch)));
		}
		const { backend } = spied();
		await withBackend(backend, () => {
			assert.equal(ensurePrivateDir(dir), dir);
			assert.equal(statSync(dir).mode & 0o777, 0o700);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("device-id path: created through the helper; a symlinked device-id is refused with the victim intact", async () => {
	const root = root0();
	try {
		const accounts = path.join(root, "island", "accounts");
		const file = path.join(accounts, "device-id");
		const { backend, calls } = spied();
		await withBackend(backend, () => {
			writePrivateFile(file, "uuid\n");
			assert.equal(statSync(file).mode & 0o777, 0o600);
			assert.ok(calls.some((c) => c[0] === "writePrivate" && c[1] === file));
			rmSync(file);
			const victim = path.join(root, "victim.txt");
			writeFileSync(victim, "VICTIM\n", { mode: 0o644 });
			symlinkSync(victim, file);
			assert.throws(() => writePrivateFile(file, "uuid2\n"), /reparse|symlink/);
			assert.equal(readFileSync(victim, "utf8"), "VICTIM\n");
			assert.equal(statSync(victim).mode & 0o777, 0o644);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- auth.json re-assert (enforceCredentialPermissions) ----------------------------

function manager(root) {
	const accountsRoot = path.join(root, "accounts");
	return new AccountManager({ accountsRoot, helper: { command: process.execPath, args: ["-e", ""], env: {} }, log: () => {} });
}
function account(root, id) {
	const dir = path.join(root, "accounts", id);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

test("re-assert REFUSES a loose auth.json (the helper cannot tighten an entry) and leaves it exactly as it was", async () => {
	const root = root0();
	try {
		const dir = account(root, "acc");
		const file = path.join(dir, "auth.json");
		writeFileSync(file, '{"k":1}\n', { mode: 0o600 });
		chmodSync(file, 0o644);
		const { backend, calls } = spied();
		await withBackend(backend, async () => assert.throws(() => manager(root).enforceCredentialPermissions("acc"), /no son privados/i));
		assert.equal(readFileSync(file, "utf8"), '{"k":1}\n');
		assert.deepEqual(calls, [], "no mutating helper call: nothing is rewritten, deleted or moved");
		assert.deepEqual(require("node:fs").readdirSync(dir), ["auth.json"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("re-assert leaves a private auth.json alone and does nothing when it is absent", async () => {
	const root = root0();
	try {
		const dir = account(root, "acc");
		const { backend, calls } = spied();
		await withBackend(backend, () => manager(root).enforceCredentialPermissions("acc"));
		writeFileSync(path.join(dir, "auth.json"), "{}\n", { mode: 0o600 });
		await withBackend(backend, () => manager(root).enforceCredentialPermissions("acc"));
		assert.deepEqual(calls, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("re-assert refuses a symlinked auth.json, a hard-linked one and a non-private account dir; the victim is untouched", async () => {
	const root = root0();
	try {
		const dir = account(root, "acc");
		const victim = path.join(root, "victim.json");
		writeFileSync(victim, "{}\n", { mode: 0o644 });
		const { backend, calls } = spied();
		symlinkSync(victim, path.join(dir, "auth.json"));
		await withBackend(backend, () => assert.throws(() => manager(root).enforceCredentialPermissions("acc")));
		rmSync(path.join(dir, "auth.json"));
		const other = path.join(root, "other.json");
		writeFileSync(other, "{}\n", { mode: 0o600 });
		linkSync(other, path.join(dir, "auth.json"));
		await withBackend(backend, () => assert.throws(() => manager(root).enforceCredentialPermissions("acc")));
		rmSync(path.join(dir, "auth.json"));
		writeFileSync(path.join(dir, "auth.json"), "{}\n", { mode: 0o600 });
		chmodSync(dir, 0o755);
		await withBackend(backend, () => assert.throws(() => manager(root).enforceCredentialPermissions("acc")));
		assert.deepEqual(calls, []);
		assert.equal(readFileSync(victim, "utf8"), "{}\n");
		assert.equal(statSync(victim).mode & 0o777, 0o644);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Parent request (HU-061): the refusal is a typed error with a closed code and the app-language text, so the UI can say what to do.
test("a refused credential store is a CredentialStoreError{store_not_private} with the Spanish instruction, secret-free", async () => {
	const root = root0();
	try {
		assert.equal(STORE_NOT_PRIVATE_MESSAGE, "Los archivos de tu cuenta no son privados en este equipo. Quitá la cuenta y volvé a iniciar sesión.");
		const dir = account(root, "acc");
		const file = path.join(dir, "auth.json");
		writeFileSync(file, '{"k":"sk-SECRET"}\n', { mode: 0o600 });
		chmodSync(file, 0o644);
		const { backend } = spied();
		await withBackend(backend, async () => {
			let error;
			try { manager(root).enforceCredentialPermissions("acc"); } catch (e) { error = e; }
			assert.ok(error instanceof CredentialStoreError);
			assert.equal(error.code, "store_not_private");
			assert.equal(error.message, STORE_NOT_PRIVATE_MESSAGE);
			assert.doesNotMatch(error.message, /SECRET/);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a login flow whose store is refused ends with the Spanish instruction, not the generic sign-in failure", async () => {
	const root = root0();
	try {
		const dir = account(root, "acc");
		writeFileSync(path.join(dir, "auth.json"), "{}\n", { mode: 0o600 });
		chmodSync(path.join(dir, "auth.json"), 0o644);
		const m = manager(root);
		const ended = [];
		m.endFlow = (flow, result) => ended.push(result);
		const { backend } = spied();
		await withBackend(backend, () => m.onLoginResult({ id: "f", accountId: "acc", finished: false }, { ok: true }));
		assert.deepEqual(ended, [{ ok: false, message: STORE_NOT_PRIVATE_MESSAGE }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
