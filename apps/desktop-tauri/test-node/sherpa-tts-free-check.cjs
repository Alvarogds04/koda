'use strict';
// K2-13 (S8, S15; decisions L22/L23): the shipped binaries must not carry espeak-ng (GPL-3.0) or piper_phonemize.
// Koda only recognises speech, so abito-island and abito-transcribe link sherpa-onnx's own v1.13.8 libraries built with
// -DSHERPA_ONNX_ENABLE_TTS=OFF: build.rs stages them (sha256-verified against packaging/sherpa-onnx-no-tts.sha256) and
// .cargo/config.toml replaces sherpa-onnx-sys's link list with the same archives minus the three TTS ones, without
// +bundle so the staged directory is what the final link resolves. This check pins that wiring and, when artifacts
// exist, proves it on the bytes: no `espeak_` symbol in a built binary and no espeak/piper object inside the
// sherpa-onnx-sys rlib. It is structural + artifact evidence only; the native builds are the real proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crate = path.resolve(__dirname, '..');

// Chunked byte search: a release binary is hundreds of megabytes, so it is streamed, never loaded whole.
function contains(file, needles) {
  const needleBytes = needles.map((n) => Buffer.from(n, 'latin1'));
  const overlap = Math.max(...needleBytes.map((n) => n.length)) - 1;
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024 + overlap);
  let carry = Buffer.alloc(0);
  try {
    for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) break;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      for (let i = 0; i < needleBytes.length; i += 1) if (window.includes(needleBytes[i])) return needles[i];
      carry = window.subarray(window.length - overlap);
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

const rules = [];
const rule = (name, fn) => rules.push([name, fn]);

const read = (rel) => {
  const file = path.join(crate, rel);
  assert.ok(fs.existsSync(file), `missing ${rel}`);
  return fs.readFileSync(file, 'utf8');
};
const sherpaVersion = /\[\[package\]\]\nname = "sherpa-onnx-sys"\nversion = "([^"]+)"/.exec(read('Cargo.lock'))?.[1];
const pin = read('packaging/sherpa-onnx-no-tts.sha256').split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => { const [sha256, archive] = line.split(/\s+/); return { sha256, archive }; });
const STAGE = 'target/sherpa-onnx-no-tts/lib';
const TRIBLES = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'];
const LINK_STATIC = ['sherpa-onnx-c-api', 'sherpa-onnx-core', 'kaldi-decoder-core', 'sherpa-onnx-kaldifst-core',
  'sherpa-onnx-fstfar', 'sherpa-onnx-fst', 'kaldi-native-fbank-core', 'kissfft-float', 'onnxruntime',
  'ssentencepiece_core'];

rule('the pin lists the TTS-free archive of every shipped target, sha256-shaped, for the sherpa-onnx-sys version in Cargo.lock', () => {
  assert.ok(sherpaVersion, 'Cargo.lock pins sherpa-onnx-sys');
  assert.deepEqual(pin.map((p) => p.archive), [
    `sherpa-onnx-v${sherpaVersion}-linux-x64-static-no-tts-lib.tar.bz2`,
    `sherpa-onnx-v${sherpaVersion}-win-x64-static-MT-Release-no-tts-lib.tar.bz2`,
  ], 'one no-tts archive per shipped target, named after the pinned crate version');
  for (const { sha256, archive } of pin) assert.match(sha256, /^[0-9a-f]{64}$/, `${archive} has a sha256`);
});

rule('the Windows no-TTS archive is not the one the workflows pin: build.rs downloads it, the workflow pin is the now-unused TTS build', () => {
  const workflowPin = read('packaging/windows/sherpa-onnx.sha256').trim().split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => line.trim().split(/\s+/));
  assert.equal(workflowPin.length, 1, 'the workflow pin holds one line');
  const workflowArchive = workflowPin[0][1];
  assert.match(workflowArchive, /-MT-Release-lib\.tar\.bz2$/, 'the workflow line still pins the crate\'s TTS archive');
  assert.ok(!pin.some(({ archive }) => archive === workflowArchive), 'the no-TTS pin is a different file, downloaded separately');
  const pinFile = read('packaging/sherpa-onnx-no-tts.sha256');
  assert.match(pinFile, /build\.rs/, 'the pin file says who downloads it');
  assert.doesNotMatch(pinFile, /downloads nothing extra|pins the same/, 'and never claims the workflows already fetch it');
});

rule('build.rs stages exactly the directory .cargo/config.toml links from, sha256-verified, and names the pin file', () => {
  const buildRs = read('build.rs');
  assert.ok(buildRs.includes(`const STAGE_DIR: &str = "${STAGE}";`), `build.rs stages ${STAGE}`);
  assert.ok(buildRs.includes('const PIN_FILE: &str = "packaging/sherpa-onnx-no-tts.sha256";'), 'build.rs reads the pin');
  assert.match(buildRs, /if digest != pinned \{/, 'an archive whose sha256 differs from the pin is refused');
  assert.match(buildRs, /"linux", "x86_64"\) => \("linux-x64-static"/, 'linux-x64 has its own archive');
  assert.match(buildRs, /"windows", "x86_64"\) => \("win-x64-static-MT-Release"/, 'win-x64 has its own archive');
});

rule('the link list of both shipped targets is the crate\'s ten archives without espeak-ng, piper_phonemize and ucd, and resolves from the staged directory', () => {
  const config = read('.cargo/config.toml');
  for (const triple of TRIBLES) {
    const section = new RegExp(`\\[target\\.${triple.replaceAll('.', '\\.')}\\.sherpa-onnx\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`).exec(config);
    assert.ok(section, `a [target.${triple}.sherpa-onnx] table replaces the build script's link list`);
    const table = section[1];
    const libs = [...table.matchAll(/"static:([^=]+)=([a-z0-9_-]+)"/g)];
    assert.deepEqual(libs.map((m) => m[2]), LINK_STATIC, 'exactly the crate\'s libraries, in link order');
    assert.deepEqual([...new Set(libs.map((m) => m[1]))], ['-bundle'],
      'every archive is resolved at final link: +bundle would pack the TTS build into the rlib again');
    assert.doesNotMatch(table, /espeak|piper|ucd/, 'no TTS archive is named');
    assert.doesNotMatch(table, /static:[^"]*espeak|static:[^"]*piper|static:[^"]*ucd/);
    assert.ok(table.includes(`rustc-link-search = ["${STAGE}"]`), `the link resolves from ${STAGE}`);
  }
  // linux keeps the system libraries the crate adds for that platform.
  for (const lib of ['stdc++', 'm', 'pthread', 'dl']) assert.ok(read('.cargo/config.toml').includes(`"dylib=${lib}"`), `linux links ${lib}`);
});

rule('darwin is out of this mechanism on purpose: the tables are per shipped triple only', () => {
  assert.doesNotMatch(read('.cargo/config.toml'), /apple-darwin/, 'macOS keeps the crate\'s own link list until the Mac session (L12)');
  assert.match(read('build.rs'), /\(the macOS libraries and.*the Mac session are pending|pending for the Mac session|cannot stage the TTS-free/s);
});

rule('no source file synthesises speech through sherpa-onnx: this is an ASR-only link', () => {
  const speech = path.join(crate, 'src/speech');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const offenders = [...walk(speech), path.join(crate, 'src/bin/abito-transcribe.rs')]
    .filter((file) => file.endsWith('.rs'))
    .filter((file) => /offline_tts|OfflineTts|tts::|Tts\./.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], 'no speech synthesis is used, so removing the TTS libraries removes no feature');
});

rule('the no-TTS link is not optional: the crate config carries the marker and build.rs refuses linux-x64 / win-x64 without it', () => {
  const config = read('.cargo/config.toml');
  assert.match(config, /^\[env\]/m, 'an [env] table in the crate config');
  assert.match(config, /^KODA_NO_TTS_LINK = "1"/m, 'the marker lives in the same file as the link tables');
  const buildRs = read('build.rs');
  assert.match(buildRs, /const NO_TTS_MARKER: &str = "KODA_NO_TTS_LINK";/, 'build.rs names the marker');
  assert.match(buildRs, /require_no_tts_link_marker|env::var_os\(NO_TTS_MARKER\)/, 'build.rs checks it');
  assert.match(buildRs, /apps\/desktop-tauri/, 'the panic says where to build from');
});

rule('a built rlib and a built binary never carry espeak or piper code (streamed byte scan, no nm needed)', () => {
  const deps = path.join(crate, 'target/debug/deps');
  const inspected = [];
  if (fs.existsSync(deps)) {
    // Cargo keeps one rlib per build configuration; the newest one is what the last build linked. Older ones are
    // leftovers of a previous link list (a stale tree), not evidence about the current build.
    const rlibs = fs.readdirSync(deps)
      .filter((name) => /^libsherpa_onnx_sys-.*\.rlib$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(deps, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of rlibs.slice(0, 1)) {
      const found = contains(path.join(deps, name), ['espeak', 'piper-phonemize']);
      assert.equal(found, null, `${name} carries a TTS object (${found})`);
      inspected.push(`${name} (newest of ${rlibs.length})`);
    }
  }
  // The binaries that actually ship: target/{debug,release}, the release build of `packaging/build.cjs`
  // (target-ship/) and the Windows staging dir dist/ — whenever this checkout has them.
  const SHIP_DIRS = ['target/debug', 'target/release', 'target-ship/release', 'dist'];
  for (const dir of SHIP_DIRS) {
    for (const bin of ['abito-island', 'abito-transcribe', 'abito-notice-relay', 'abito-private-session']) {
      for (const name of [bin, `${bin}.exe`]) {
        const file = path.join(crate, dir, name);
        if (!fs.existsSync(file)) continue;
        const found = contains(file, ['espeak_', 'piper_phonemize']);
        assert.equal(found, null, `${dir}/${name} contains ${found}`);
        inspected.push(`${dir}/${name}`);
      }
    }
  }
  console.log(inspected.length
    ? `      inspected: ${inspected.join(', ')}`
    : '      no build artifacts yet: nothing to inspect (cargo build/test supplies them)');
});

let failed = 0;
for (const [name, fn] of rules) {
  try { fn(); console.log(`PASS: ${name}`); } catch (error) { failed += 1; console.log(`FAIL: ${name}\n      ${String(error.message).split('\n')[0]}`); }
}
if (failed > 0) { console.error(`FAIL: ${failed} TTS-free sherpa-onnx rule(s) failed`); process.exitCode = 1; }
else console.log('PASS TTS-free sherpa-onnx: no espeak-ng, piper_phonemize or ucd in the link of the shipped binaries');
