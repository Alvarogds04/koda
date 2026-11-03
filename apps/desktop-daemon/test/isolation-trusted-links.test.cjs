"use strict";

// K2-01b C1 (human decision «1a»): a symlink ANCESTOR is accepted only when the system owns it — the link is owned by
// root AND its parent directory is owned by root and not group/world-writable — and the walk then continues on the
// link's target, which must pass the whole rule again. macOS temp dirs live under /var → private/var (and /tmp, /etc);
// Linux merged-usr systems have /lib → usr/lib, /bin → usr/bin. Everything else stays refused exactly as before:
// user- or foreign-owned links, links inside a writable or sticky dir, a symlink LEAF, a target that fails the rule.
// These tests drive the public assertSecurePath with an injected file system so the same cases run on every OS; the
// last test uses a real root-owned system link when this machine has one (macOS /var on CI, /lib on Ubuntu).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { assertSecurePath } = require("../src/isolation.cjs");

const ME = 501;
const DIR = 0o040000, LNK = 0o120000;
// Trees are written with POSIX paths; R() maps them onto this OS's absolute form (on Windows "/var" is "<drive>:\\var"),
// so the same cases run unchanged on Linux, macOS and Windows.
const R = (p) => path.resolve(p);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const linkRefusal = (p) => new RegExp(`refusing symlink component in island path: ${escape(R(p))}$`);
/** Fake POSIX tree: path -> {uid, mode (permission bits), link?: target}. Directories otherwise. */
function fakeFs(tree) {
	const nodes = new Map(Object.entries(tree).map(([k, v]) => [R(k), v]));
	const lstatSync = (p) => {
		const n = nodes.get(p);
		if (!n) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
		const link = n.link !== undefined;
		return { uid: n.uid, mode: (link ? LNK : DIR) | n.mode, isSymbolicLink: () => link };
	};
	const readlinkSync = (p) => {
		const n = nodes.get(p);
		if (!n || n.link === undefined) throw Object.assign(new Error(`EINVAL: ${p}`), { code: "EINVAL" });
		return n.link;
	};
	return { lstatSync, readlinkSync };
}
const root = (mode = 0o755) => ({ uid: 0, mode });
const mine = (mode = 0o700) => ({ uid: ME, mode });
const check = (p, tree, platform = "darwin") => assertSecurePath(R(p), { uid: ME, fs: fakeFs(tree), platform });

const MAC = {
	"/": root(),
	"/var": { uid: 0, mode: 0o755, link: "private/var" },
	"/private": root(),
	"/private/var": root(),
	"/private/var/folders": root(),
	"/private/var/folders/xy": root(),
	"/private/var/folders/xy/abc": mine(),
	"/private/var/folders/xy/abc/T": mine(),
};

test("a root-owned system link under a root-owned, non-writable parent is followed: /var → private/var", () => {
	assert.equal(check("/var/folders/xy/abc/T/island", MAC), R("/var/folders/xy/abc/T/island"), "returns the path as given");
	assert.equal(check("/var/folders/xy/abc/T", MAC), R("/var/folders/xy/abc/T"));
});

test("a relative or absolute target is resolved against the real parent, including `..`", () => {
	const tree = { "/": root(), "/usr": root(), "/usr/lib": root(), "/usr/local": root(), "/usr/local/l": { uid: 0, mode: 0o777, link: "../lib" }, "/lib": { uid: 0, mode: 0o777, link: "/usr/lib" } };
	assert.equal(check("/usr/local/l/x", tree, "linux"), R("/usr/local/l/x"));
	assert.equal(check("/lib/x", tree, "linux"), R("/lib/x"));
});

test("refused as before: a link owned by the user (or anyone but root)", () => {
	for (const uid of [ME, 777]) {
		const tree = { "/": root(), "/Users": root(), "/Users/me": mine(), "/Users/me/real": mine(), "/Users/me/link": { uid, mode: 0o755, link: "/Users/me/real" } };
		assert.throws(() => check("/Users/me/link/island", tree), linkRefusal("/Users/me/link"));
	}
	// a root-owned link whose parent belongs to the user: the user could have swapped it
	const swapped = { "/": root(), "/Users": root(), "/Users/me": mine(), "/Users/me/real": mine(), "/Users/me/link": { uid: 0, mode: 0o755, link: "/Users/me/real" } };
	assert.throws(() => check("/Users/me/link/island", swapped), /refusing symlink component/);
});

test("refused as before: a root-owned link inside a world-writable sticky dir or a group/world-writable root dir", () => {
	for (const mode of [0o1777, 0o775, 0o1775, 0o765]) { // dirs the existing rule itself accepts; only the link trust refuses
		const tree = { "/": root(), "/tmp": { uid: 0, mode }, "/opt": root(), "/opt/real": mine(), "/tmp/l": { uid: 0, mode: 0o777, link: "/opt/real" } };
		assert.throws(() => check("/tmp/l/island", tree), linkRefusal("/tmp/l"), mode.toString(8));
	}
});

test("refused as before: the LEAF itself being a symlink, even a trusted one", () => {
	assert.throws(() => check("/var", MAC), linkRefusal("/var"));
	const tree = { ...MAC, "/private/var/folders/xy/abc/T/leaf": { uid: 0, mode: 0o755, link: "/private/var/folders/xy/abc" } };
	assert.throws(() => check("/var/folders/xy/abc/T/leaf", tree), /refusing symlink component/);
});

test("the target must pass the whole rule again: foreign owner, untrusted inner link, writable dir, loops", () => {
	const foreign = { "/": root(), "/opt": root(), "/home": root(), "/home/evil": { uid: 777, mode: 0o755 }, "/opt/l": { uid: 0, mode: 0o755, link: "/home/evil" } };
	assert.throws(() => check("/opt/l/island", foreign), /owned by uid 777/);
	const inner = { "/": root(), "/opt": root(), "/home": root(), "/home/me": mine(), "/home/me/real": mine(), "/home/me/hop": { uid: ME, mode: 0o755, link: "/home/me/real" }, "/opt/l": { uid: 0, mode: 0o755, link: "/home/me/hop" } };
	assert.throws(() => check("/opt/l/island", inner), linkRefusal("/home/me/hop"));
	const writable = { "/": root(), "/opt": root(), "/shared": { uid: 0, mode: 0o777 }, "/opt/l": { uid: 0, mode: 0o755, link: "/shared" } };
	assert.throws(() => check("/opt/l/island", writable), /world-writable component without the sticky bit/);
	const loop = { "/": root(), "/a": { uid: 0, mode: 0o755, link: "/b" }, "/b": { uid: 0, mode: 0o755, link: "/a" } };
	assert.throws(() => check("/a/island", loop), /refusing symlink component/);
});

test("Windows keeps today's rule: every symlink/junction component is refused (Windows reports uid 0 for all files)", () => {
	const tree = { "/": root(), "/var": { uid: 0, mode: 0o755, link: "private/var" }, "/private": root(), "/private/var": root() };
	assert.throws(() => assertSecurePath(R("/var/island"), { uid: undefined, fs: fakeFs(tree), platform: "win32" }), /refusing symlink component/);
});

/** A real root-owned link at the top level whose target is a directory, if this machine has one (macOS /var, Ubuntu /lib). */
function realSystemLink() {
	if (process.platform === "win32") return undefined;
	for (const name of ["var", "tmp", "etc", "lib", "bin", "sbin"]) {
		const p = path.join("/", name);
		try {
			const st = fs.lstatSync(p);
			if (st.isSymbolicLink() && st.uid === 0 && fs.statSync(p).isDirectory()) return p;
		} catch {}
	}
	return undefined;
}
const REAL = realSystemLink();
test("a real root-owned system link on this machine is followed (macOS /var/folders, Ubuntu /lib)", { skip: !REAL && "no root-owned top-level symlink on this machine; the injected cases above cover the rule on every OS" }, () => {
	const p = path.join(REAL, "abito-k2-01b-does-not-exist", "island");
	assert.equal(assertSecurePath(p), p);
});

test("a `..` inside the link target never skips a component the OS will traverse (no lexical collapse)", () => {
	// /opt/l → /home/me/hop/../real : the OS follows `hop` (a user-owned link) before `..`, so it must be checked.
	const tree = { "/": root(), "/opt": root(), "/home": root(), "/home/me": mine(), "/home/me/real": mine(), "/elsewhere": root(),
		"/home/me/hop": { uid: ME, mode: 0o755, link: "/elsewhere" }, "/opt/l": { uid: 0, mode: 0o755, link: "/home/me/hop/../real" } };
	assert.throws(() => check("/opt/l/island", tree), linkRefusal("/home/me/hop"));
});
