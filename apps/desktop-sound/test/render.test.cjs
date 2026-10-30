'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AbitoSound = require('../sound-engine.js');
const R = require('../scripts/render-wav.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'abito-sound-test-')); }

test('wavBuffer: header fields and sizes', () => {
  const s = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
  const b = R.wavBuffer(s, 44100);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.readUInt32LE(4), 36 + s.length * 2);
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  assert.equal(b.toString('ascii', 12, 16), 'fmt ');
  assert.equal(b.readUInt32LE(16), 16);
  assert.equal(b.readUInt16LE(20), 1); // PCM
  assert.equal(b.readUInt16LE(22), 1); // mono
  assert.equal(b.readUInt32LE(24), 44100);
  assert.equal(b.readUInt32LE(28), 88200);
  assert.equal(b.readUInt16LE(32), 2);
  assert.equal(b.readUInt16LE(34), 16);
  assert.equal(b.toString('ascii', 36, 40), 'data');
  assert.equal(b.readUInt32LE(40), s.length * 2);
  assert.equal(b.length, 44 + s.length * 2);
  assert.equal(b.readInt16LE(44 + 2), Math.round(0.5 * 32767));
  assert.equal(b.readInt16LE(44 + 4), -Math.round(0.5 * 32767));
  assert.equal(b.readInt16LE(44 + 10), 32767); // clamped, no wrap
});

test('renderCueWav: every cue renders through the real engine', () => {
  const { render } = R.renderCue('snd.attention');
  assert.ok(render.peak > 0 && render.peak <= 0.12 * 1.001);
  assert.throws(() => R.renderCue('snd.nope'));
});

test('assertSafeOutDir refuses relative and in-repo dirs', () => {
  assert.throws(() => R.assertSafeOutDir('out'), /absolute/);
  assert.throws(() => R.assertSafeOutDir('./out'), /absolute/);
  assert.throws(() => R.assertSafeOutDir(''), /absolute/);
  assert.throws(() => R.assertSafeOutDir(undefined), /absolute/);
  assert.throws(() => R.assertSafeOutDir(path.join(__dirname, '..', 'out')), /repository/);
  assert.throws(() => R.assertSafeOutDir(path.join(__dirname, '..', '..', 'desktop-tauri', 'x')), /repository/);
  assert.throws(() => R.assertSafeOutDir(R.REPO_ROOT), /repository/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'out')), false, 'refused dirs are not created');
});

test('writeAll writes one valid WAV per cue into a mkdtemp dir, then cleans up', () => {
  const dir = tmp();
  try {
    const files = R.writeAll(dir);
    assert.equal(files.length, AbitoSound.CUE_IDS.length);
    for (const id of AbitoSound.CUE_IDS) {
      const f = path.join(dir, id + '.wav');
      const b = fs.readFileSync(f);
      assert.equal(b.toString('ascii', 0, 4), 'RIFF');
      assert.equal(b.readUInt32LE(40), b.length - 44);
      const ms = (b.readUInt32LE(40) / 2 / 44100) * 1000;
      assert.ok(ms >= 80 && ms <= 612, id + ' ' + ms);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), AbitoSound.CUE_IDS.map((i) => i + '.wav').sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(dir), false);
});

test('the CLI refuses a relative dir without writing anything', () => {
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'render-wav.cjs'), 'rel-out'], { encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /absolute/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'rel-out')), false);
});
