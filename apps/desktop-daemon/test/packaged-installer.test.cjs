"use strict";

// L42 F1: in the installed app NO hook installer ran: hookInstallerBin had no default and the package did not ship
// apps/desktop-harness, so every agent read "unavailable". The daemon now derives the installer from its OWN location
// (<package>/desktop-daemon/src -> <package>/desktop-harness/bin/abito-hook.cjs, the same relative layout as the repo).
// Nothing comes from the page; a value the user wrote in config.json still wins.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { packagedInstallerBin } = require("../src/cli.cjs");
const { Daemon } = require("../src/daemon.cjs");

function layout(t, { withInstaller = true } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-pkg-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "desktop-daemon", "src"), { recursive: true });
	fs.mkdirSync(path.join(root, "desktop-harness", "bin"), { recursive: true });
	if (withInstaller) fs.writeFileSync(path.join(root, "desktop-harness", "bin", "abito-hook.cjs"), "// installer\n");
	return root;
}

test("packagedInstallerBin: the sibling desktop-harness installer, only when the file exists", (t) => {
	const root = layout(t);
	assert.equal(packagedInstallerBin(path.join(root, "desktop-daemon", "src")), path.join(root, "desktop-harness", "bin", "abito-hook.cjs"));
	const bare = layout(t, { withInstaller: false });
	assert.equal(packagedInstallerBin(path.join(bare, "desktop-daemon", "src")), undefined, "no installer shipped: stays unavailable, never a guessed path");
});

test("packagedInstallerBin: the real repo layout resolves to the harness installer", () => {
	const found = packagedInstallerBin(path.join(__dirname, "..", "src"));
	assert.equal(found, path.resolve(__dirname, "..", "..", "desktop-harness", "bin", "abito-hook.cjs"));
});

test("the daemon's agent manager uses the packaged default; config.json still wins", (t) => {
	const dflt = "/opt/abito/desktop-harness/bin/abito-hook.cjs";
	const daemon = new Daemon({ root: fs.mkdtempSync(path.join(os.tmpdir(), "abito-d-")), defaultInstallerBin: dflt });
	t.after(() => fs.rmSync(daemon.root, { recursive: true, force: true }));
	assert.equal(daemon.makeAgents({}).installerBin, dflt, "unset in config: the packaged installer");
	const own = "/home/me/my-installer/abito-hook.cjs";
	assert.equal(daemon.makeAgents({ hookInstallerBin: own }).installerBin, own, "the user's own value wins");
	const plain = new Daemon({ root: daemon.root });
	assert.equal(plain.makeAgents({}).installerBin, undefined, "no default and no config: unavailable, as before");
});
