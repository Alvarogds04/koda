'use strict';
/* K2-10 T4 (S11) — la pausa del correo: `frontend/paused.js` y `src/paused.rs` tienen que quedar de
   acuerdo. El correo tiene entrada PROPIA y NO está en pausa en esta versión (la tarjeta de la isla y
   su ajuste tienen que andar); Integraciones sigue en pausa, sin cambios.
   Run: node apps/desktop-tauri/test-node/paused-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const P = require(path.join(frontend, 'paused.js'));
const rust = fs.readFileSync(path.join(__dirname, '..', 'src', 'paused.rs'), 'utf8');

let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

/** The Rust `true` arm of `paused()` names every paused feature; the JS list must name the same ones. */
function pausedArm() {
  const at = rust.indexOf('pub const fn paused');
  assert.ok(at > 0, 'src/paused.rs has no paused()');
  const body = rust.slice(at, rust.indexOf('\n}', at));
  const m = /=> true/.exec(body);
  assert.ok(m, 'src/paused.rs paused() has no `=> true` arm');
  const arm = body.slice(0, m.index + m[0].length);
  return [...arm.matchAll(/Feature::([A-Za-z]+)/g)].map(x => x[1].toLowerCase());
}

test('one list on both sides: the paused features of paused.rs are exactly the PAUSED list of paused.js', () => {
  assert.deepEqual(pausedArm().sort(), [...P.PAUSED].sort());
  for (const id of P.PAUSED) assert.equal(P.paused(id), true, id);
});

test('mail has its own entry and is NOT paused on either side', () => {
  assert.equal(P.paused('mail'), false, 'paused.js must not pause mail');
  assert.equal(P.PAUSED.includes('mail'), false, 'mail is never in the paused list');
  assert.deepEqual([...P.NOT_PAUSED], ['mail', 'spotify'], 'the features this version turns on (K2-10 mail, K2-09 music)');
  assert.match(rust, /Feature::Mail => false/, 'paused.rs gives mail its own, active entry');
  assert.doesNotMatch(pausedArm().join(' '), /mail/, 'mail never joins the paused arm');
});

test('the rest of the pause is untouched, and the label still matches', () => {
  assert.deepEqual(pausedArm().sort(), ['dictation', 'integrations', 'phone', 'voice']);
  assert.equal(P.paused('integrations'), true, 'Integraciones keeps its pause');
  // K2-09: «se quita la pausa de Spotify»
  assert.equal(P.paused('spotify'), false);
  assert.match(rust, /Feature::Spotify => false/);
  assert.equal(P.LABEL, 'En pausa · próxima versión');
  assert.match(rust, /pub const LABEL: &str = "En pausa · próxima versión"/);
  for (const active of ['chat', 'agents', 'general', 'mail']) assert.equal(P.paused(active), false, active);
});

console.log(`paused-check: ${passed} checks ok`);
