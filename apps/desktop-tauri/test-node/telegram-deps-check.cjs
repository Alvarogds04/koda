'use strict';
/* K2-13 T1b (S6, S20): the Telegram client library Koda ships, checked on the pin files only (no network, no install).
   Decided by the human (K2-13 L41): @mtcute/node is declared once as the daemon's development pin and once as the
   bundled runtime's shipped pin, and the bytes ship inside the runtime folder, because that is the one npm tree every
   installer already verifies, extracts and writes licence notices for. This check proves the two pins cannot drift —
   the direct pin, the @mtcute/* family and the @fuman/* family mtcute pulls, `long` and the better-sqlite3 stub — that
   both lockfiles resolve every one of them to the same version AND the same integrity, that better-sqlite3 is Koda's
   empty stub in both trees (the session never touches disk, so the native addon is never loaded), and — when the
   runtime tree is installed here — that no native addon of ours and no missing licence text would reach a user.
   Run: node apps/desktop-tauri/test-node/telegram-deps-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./tmpdirs.cjs');

const crate = path.resolve(__dirname, '..');
const apps = path.resolve(crate, '..');
const runtimeDir = path.join(crate, 'packaging/runtime');
const daemonDir = path.join(apps, 'desktop-daemon');
let passed = 0;
const test = (name, fn) => {
	try {
		fn();
		passed += 1;
	} catch (e) {
		e.message = `${name}: ${e.message}`;
		throw e;
	}
};

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`cannot read JSON ${file}: ${e.message}`);
	}
}
const MTCUTE = '@mtcute/node';
const STUB = 'better-sqlite3';
const STUB_MARKER = 'kodaStub';
/**
 * The families mtcute pulls beside itself. @mtcute/* is frozen by `overrides` in both packages; @fuman/* and `long` are
 * pinned by exact version here, because a fresh install of an updated @mtcute/node could otherwise move them silently
 * (both files are out of the daemon's package and cannot be regenerated without network).
 */
const FUMAN = Object.freeze({ '@fuman/io': '0.0.23', '@fuman/net': '0.0.23', '@fuman/node': '0.0.23', '@fuman/utils': '0.0.23' });
const LONG = '5.3.2';
const SPEC = `^\\d+\\.\\d+\\.\\d+$`;
const daemonPkg = readJson(path.join(daemonDir, 'package.json'));
const runtimePkg = readJson(path.join(runtimeDir, 'package.json'));
const daemonLock = readJson(path.join(daemonDir, 'package-lock.json'));
const runtimeLock = readJson(path.join(runtimeDir, 'package-lock.json'));
// build-runtime.cjs is a script executed as `node packaging/runtime/build-runtime.cjs …`; it also exports the guard the
// build runs, so this check can hold that guard to a fixture tree instead of grepping for it.
const builder = require(path.join(runtimeDir, 'build-runtime.cjs'));

/** The lockfile entry name of every @mtcute/* package npm resolves, as {name, version} (lockfile v3 layout). */
const mtcutePackages = (lock) =>
	Object.entries(lock.packages)
		.filter(([key]) => /^node_modules\/@mtcute\//.test(key))
		.map(([key, entry]) => ({ name: key.slice('node_modules/'.length), version: entry.version }));
/**
 * Every package the two trees must agree on, keyed by name: the @mtcute/* family, the @fuman/* family it pulls, `long`
 * (Apache-2.0, tl-runtime's 64-bit integers) and the better-sqlite3 stub. `integrity` is part of the comparison: same
 * version from a different tarball is still drift.
 */
const sharedPackages = (lock) => {
	const out = {};
	for (const [key, entry] of Object.entries(lock.packages)) {
		const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : undefined;
		if (!name) continue;
		if (!/^@mtcute\//.test(name) && !/^@fuman\//.test(name) && name !== 'long' && name !== STUB) continue;
		out[name] = { version: entry.version, integrity: entry.integrity, resolved: entry.resolved };
	}
	return out;
};
const exact = (value, what) => {
	assert.equal(typeof value, 'string', `${what} is declared`);
	assert.match(value, new RegExp(SPEC), `${what} is an exact version, not a range (${value})`);
	return value;
};
/** Normalised (posix, resolution-free) form of a `file:` dependency spec. */
const fileSpec = (spec) => String(spec).replace(/^file:/, '').replaceAll('\\', '/').replace(/\/+$/, '');

test('@mtcute/node is one exact pin, identical in the daemon (dev) and in the shipped runtime tree', () => {
	assert.equal(exact(daemonPkg.dependencies?.[MTCUTE], `apps/desktop-daemon pin for ${MTCUTE}`), '0.32.8');
	assert.equal(exact(runtimePkg.dependencies?.[MTCUTE], `packaging/runtime pin for ${MTCUTE}`), '0.32.8');
	assert.equal(daemonPkg.dependencies[MTCUTE], runtimePkg.dependencies[MTCUTE], 'the two pins never drift');
	for (const [label, lock] of [['apps/desktop-daemon', daemonLock], ['packaging/runtime', runtimeLock]]) {
		assert.equal(lock.packages[`node_modules/${MTCUTE}`].version, '0.32.8', `${label} lock resolves ${MTCUTE} 0.32.8`);
	}
});

test('every @mtcute/* package the lockfile installs is pinned exactly by overrides in BOTH packages', () => {
	for (const [label, pkg, lock] of [['apps/desktop-daemon', daemonPkg, daemonLock], ['packaging/runtime', runtimePkg, runtimeLock]]) {
		const overrides = pkg.overrides ?? {};
		// The direct dependency is already an exact pin (first test); the overrides freeze the @mtcute/* family mtcute pulls.
		const pins = mtcutePackages(lock).filter(({ name }) => name !== MTCUTE);
		assert.ok(pins.length >= 6, `${label} lock carries the whole @mtcute family (${pins.length})`);
		for (const { name, version } of pins) {
			assert.equal(exact(overrides[name], `${label} overrides ${name}`), version, `${label} freezes ${name}@${version}`);
		}
	}
});

test('every @fuman/* package mtcute pulls is an exact pin, equal in both lockfiles, and `long` with it', () => {
	for (const name of Object.keys(FUMAN)) {
		for (const [label, lock] of [['apps/desktop-daemon', daemonLock], ['packaging/runtime', runtimeLock]]) {
			const entry = lock.packages[`node_modules/${name}`];
			assert.ok(entry, `${label} lock resolves ${name}`);
			assert.equal(exact(entry.version, `${label} ${name}`), FUMAN[name], `${label} pins ${name}@${FUMAN[name]}`);
		}
	}
	// tl-runtime writes 64-bit values through `long` (Apache-2.0); it is not ours to choose, but it must be one version.
	for (const [label, lock] of [['apps/desktop-daemon', daemonLock], ['packaging/runtime', runtimeLock]]) {
		assert.equal(exact(lock.packages['node_modules/long']?.version, `${label} long`), LONG, `${label} resolves long@${LONG}`);
	}
});

test('both lockfiles resolve every shared package to the same version AND the same integrity', () => {
	const daemon = sharedPackages(daemonLock);
	const runtime = sharedPackages(runtimeLock);
	const names = Object.keys(daemon).sort();
	assert.ok(names.length >= 12, `the shared set is the whole Telegram dependency tree (${names.length} packages)`);
	for (const name of names) {
		assert.ok(runtime[name], `packaging/runtime lock also resolves ${name}`);
		assert.deepEqual(runtime[name].version, daemon[name].version, `${name} is the same version in both lockfiles`);
		if (name === STUB) continue; // the stub is a local file: no registry integrity by design (asserted below)
		assert.match(String(daemon[name].integrity), /^sha512-/, `${name} is pinned by sha512 in the daemon lock`);
		assert.equal(runtime[name].integrity, daemon[name].integrity, `${name} is the same tarball in both lockfiles`);
	}
});

test('better-sqlite3 is Koda\'s empty stub in both trees, and npm installs no real one', () => {
	const declared = (pkg) => pkg.dependencies?.[STUB];
	for (const [label, pkg] of [['apps/desktop-daemon', daemonPkg], ['packaging/runtime', runtimePkg]]) {
		assert.match(String(declared(pkg)), /^file:/, `${label} replaces ${STUB} with the stub (a file: dependency)`);
	}
	// The stub is ONE package on disk, reached from both trees by a relative path.
	assert.equal(fileSpec(declared(daemonPkg)), '../desktop-tauri/packaging/runtime/stubs/better-sqlite3');
	assert.equal(fileSpec(declared(runtimePkg)), './stubs/better-sqlite3');
	const stubDir = path.resolve(runtimeDir, fileSpec(declared(runtimePkg)));
	assert.equal(path.resolve(daemonDir, fileSpec(declared(daemonPkg))), stubDir, 'both point at the same stub');
	const stub = readJson(path.join(stubDir, 'package.json'));
	assert.equal(stub.name, STUB);
	assert.equal(stub[STUB_MARKER], STUB, 'the stub marks itself');
	assert.ok(fs.lstatSync(path.join(stubDir, 'index.js')).isFile(), 'the stub has its constructor');
	// The stub declares a version inside the range mtcute asks for (the lock records that range), so npm hoists the stub
	// to the root instead of installing the real package beside it: the native addon never enters the tree at all.
	const wanted = String(runtimeLock.packages[`node_modules/${MTCUTE}`].dependencies[STUB]);
	const range = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(wanted);
	assert.ok(range, `mtcute asks for ${STUB}@${wanted}, a plain caret range this check can read`);
	const [gotMajor, gotMinor, gotPatch] = stub.version.split('.').map(Number);
	const [wantMajor, wantMinor, wantPatch] = range.slice(1).map(Number);
	const inRange = gotMajor === wantMajor && (gotMinor > wantMinor || (gotMinor === wantMinor && gotPatch >= wantPatch));
	assert.ok(inRange, `the stub version ${stub.version} satisfies ${wanted}`);
	for (const [label, lock] of [['apps/desktop-daemon', daemonLock], ['packaging/runtime', runtimeLock]]) {
		const entries = Object.entries(lock.packages).filter(([key]) => key === `node_modules/${STUB}` || key.endsWith(`/node_modules/${STUB}`));
		assert.equal(entries.length, 1, `${label} lock has exactly one ${STUB} (no real one nested under @mtcute/node)`);
		const [key, entry] = entries[0];
		assert.equal(key, `node_modules/${STUB}`, `${label} ${STUB} is hoisted to the root`);
		assert.match(String(entry.resolved), /^file:/, `${label} ${STUB} resolves to the local stub, never the registry`);
		assert.equal(entry.integrity, undefined, `${label} ${STUB} has no registry integrity because it is not the registry package`);
	}
});

test('build-runtime refuses a runtime tree whose Telegram dependencies added a native addon or the real better-sqlite3', () => {
	const guard = builder.assertNoNativeAddons;
	assert.equal(typeof guard, 'function', 'build-runtime.cjs exports the guard its build runs');
	const root = T.make('abito-telegram-deps-');
	const tree = (name, files) => {
		const dir = path.join(root, name);
		for (const [rel, body] of Object.entries(files)) {
			const file = path.join(dir, 'node_modules', rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
		}
		fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
		return dir;
	};
	const stubPkg = JSON.stringify({ name: STUB, version: '12.11.1', main: 'index.js', [STUB_MARKER]: STUB });
	const clean = tree('clean', {
		'@mtcute/node/package.json': JSON.stringify({ name: '@mtcute/node', version: '0.32.8' }),
		'@mtcute/node/index.js': 'export const TelegramClient = 1;\n',
		'@mtcute/core/index.js': 'export const core = 1;\n',
		'@fuman/utils/index.js': 'export const utils = 1;\n',
		'better-sqlite3/package.json': stubPkg,
		'better-sqlite3/index.js': 'module.exports = function () { throw new Error("stubbed"); };\n',
	});
	assert.doesNotThrow(() => guard(clean), 'mtcute (WASM only) plus the stub is what ships');
	const addon = tree('addon', { '@mtcute/node/package.json': '{}', '@mtcute/core/native/ige.node': 'fake addon\n' });
	assert.throws(() => guard(addon), /ship a native addon: @mtcute\/core\/native\/ige\.node/, 'a .node file under @mtcute fails closed');
	const sqliteAddon = tree('sqlite-addon', { 'better-sqlite3/package.json': '{"name":"better-sqlite3"}', 'better-sqlite3/build/Release/better_sqlite3.node': 'fake\n' });
	assert.throws(() => guard(sqliteAddon), /ship a native addon: better-sqlite3\/build\/Release\/better_sqlite3\.node/);
	const real = tree('real', { 'better-sqlite3/package.json': '{"name":"better-sqlite3","version":"12.11.1"}', 'better-sqlite3/lib/database.js': '\n' });
	assert.throws(() => guard(real), /better-sqlite3 is the real package, not Koda's empty stub/, 'the real package (even addon-less) is refused');
	const empty = path.join(root, 'empty');
	fs.mkdirSync(empty);
	assert.doesNotThrow(() => guard(empty), 'a runtime with no dependencies at all (the offline build fixture) still builds');
});

test('build-runtime runs that guard before it ships the folder', () => {
	const source = fs.readFileSync(path.join(runtimeDir, 'build-runtime.cjs'), 'utf8');
	const call = source.indexOf('assertNoNativeAddons(partial)');
	assert.ok(call > 0, 'the build calls the guard');
	const rename = source.indexOf('fs.renameSync(partial, out)');
	assert.ok(rename > call, 'the guard runs before the built folder replaces the output');
});

test('the shipped runtime tree (when built here) carries no native addon of ours and every added licence text is available', () => {
	const modules = path.join(runtimeDir, 'node_modules');
	if (!fs.existsSync(modules)) {
		console.log('telegram-deps-check: packaging/runtime/node_modules not installed here: pin-only checks ran (the build proves the tree)');
		return;
	}
	assert.doesNotThrow(() => builder.assertNoNativeAddons(runtimeDir), 'the local runtime tree passes the guard');
	const PERMISSIVE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense', 'BlueOak-1.0.0']);
	const texts = path.join(runtimeDir, 'licenses');
	const added = [];
	for (const name of ['@mtcute', '@fuman']) {
		const scope = path.join(modules, name);
		if (!fs.existsSync(scope)) continue;
		for (const entry of fs.readdirSync(scope)) {
			const dir = path.join(scope, entry);
			const manifest = readJson(path.join(dir, 'package.json'));
			added.push(`${manifest.name}@${manifest.version}`);
			const id = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
			assert.ok(PERMISSIVE.has(id), `${manifest.name} is ${id}: no copyleft reaches a user`);
			const file = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.|-|$)/i.test(n) && fs.lstatSync(path.join(dir, n)).isFile());
			assert.ok(file || fs.existsSync(path.join(texts, `${id}.txt`)), `${manifest.name} ships its ${id} text (or licenses/ has it)`);
		}
	}
	assert.ok(added.length >= 7, `the tree carries the whole @mtcute family (${added.length} packages)`);
	console.log(`telegram-deps-check: ${added.length} shipped Telegram packages, all permissive with their licence text`);
});
console.log(`telegram-deps-check: ${passed} passed`);
