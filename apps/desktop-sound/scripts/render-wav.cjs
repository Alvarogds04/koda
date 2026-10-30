#!/usr/bin/env node
'use strict';
// Renders each cue through the SAME engine + the software AudioContext into 16-bit PCM mono WAV
// files so the human can audition them. Never plays audio. Refuses relative out-dirs and any dir
// inside the repository (the repo must contain no audio files).
//   node scripts/render-wav.cjs /tmp/abito-cues
const fs = require('node:fs');
const path = require('node:path');
const AbitoSound = require('../sound-engine.js');
const { createSoftContext, createFakeTime } = require('../test/support/soft-audio.cjs');

const SAMPLE_RATE = 44100;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function realish(p) {
  // resolve symlinks of the deepest existing ancestor so a link into the repo is caught
  let cur = p; const rest = [];
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) break; rest.unshift(path.basename(cur)); cur = up; }
  let base = cur;
  try { base = fs.realpathSync(cur); } catch (e) { /* keep */ }
  return path.join(base, ...rest);
}
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function assertSafeOutDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('out-dir must be an absolute path');
  const abs = realish(path.resolve(dir));
  const roots = [REPO_ROOT, realish(REPO_ROOT)];
  for (const r of roots) if (inside(abs, r)) throw new Error('out-dir must be outside the repository');
  return abs;
}

function assertGain(gain) {
  if (gain !== undefined && (!Number.isFinite(gain) || typeof gain !== 'number' || gain <= 0)) {
    throw new Error('gain must be a finite number greater than zero');
  }
}
function assertSampleRate(sampleRate) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > 0x7fffffff) {
    throw new Error('sample rate must be a positive integer');
  }
  return sampleRate;
}

// the engine schedules synchronously when the context is running
function renderCueSync(id, gain, sampleRate = SAMPLE_RATE) {
  assertGain(gain);
  assertSampleRate(sampleRate);
  const time = createFakeTime();
  const ctx = createSoftContext();
  const engine = AbitoSound.createSoundEngine({
    enabled: true, gain, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, createContext: () => ctx,
  });
  if (!AbitoSound.CUES[id] || !Object.prototype.hasOwnProperty.call(AbitoSound.CUES, id)) throw new Error('unknown cue: ' + id);
  engine.ready();
  engine.play(id);
  time.advance(30);
  const render = ctx.render(sampleRate);
  if (!render.samples.length) throw new Error('cue did not schedule: ' + id);
  return { render, ctx };
}

function wavBuffer(samples, sampleRate = SAMPLE_RATE) {
  assertSampleRate(sampleRate);
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.sign(v) * Math.round(Math.abs(v) * 32767), 44 + i * 2);
  }
  return b;
}

function writeAll(outDir, gain) {
  assertGain(gain);
  const dir = assertSafeOutDir(outDir);
  const rendered = AbitoSound.CUE_IDS.map((id) => {
    const { render } = renderCueSync(id, gain, SAMPLE_RATE);
    return [id, wavBuffer(render.samples, SAMPLE_RATE)];
  });
  fs.mkdirSync(dir, { recursive: true });
  for (const [id] of rendered) {
    if (fs.existsSync(path.join(dir, id + '.wav'))) throw new Error('output file already exists');
  }
  const files = [];
  for (const [id, buffer] of rendered) {
    const f = path.join(dir, id + '.wav');
    const fd = fs.openSync(f, 'wx');
    try { fs.writeFileSync(fd, buffer); } finally { fs.closeSync(fd); }
    files.push(f);
  }
  return files;
}

module.exports = { assertSafeOutDir, renderCue: renderCueSync, wavBuffer, writeAll, REPO_ROOT, SAMPLE_RATE };

if (require.main === module) {
  try {
    const files = writeAll(process.argv[2]);
    for (const f of files) process.stdout.write(f + '\n');
  } catch (e) {
    process.stderr.write(String(e.message) + '\n');
    process.exitCode = 1;
  }
}
