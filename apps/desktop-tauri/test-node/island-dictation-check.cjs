'use strict';
/* S10 (L30) — the dictation pill in the island: view-model contracts and wiring. No DOM, no events, no microphone. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const D = require(path.join(frontend, 'island-dictation.js'));
const src = fs.readFileSync(path.join(frontend, 'island-dictation.js'), 'utf8');
const rust = fs.readFileSync(path.join(__dirname, '..', 'src', 'dictation_cmd.rs'), 'utf8');
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('phases: exactly the six the host emits; anything else changes nothing', () => {
  for (const p of ['idle', 'listening', 'locked', 'thinking', 'copied', 'failed']) assert.equal(D.phaseOf({ phase: p }), p);
  for (const bad of [null, [], 'x', {}, { phase: 'recording' }, { phase: 5 }, { phase: null }]) assert.equal(D.phaseOf(bad), null, JSON.stringify(bad));
  // the page's list is the host's list (dictation_cmd.rs event())
  for (const name of ['idle', 'listening', 'locked', 'thinking', 'copied', 'failed']) assert.ok(rust.includes(`"${name}"`), name);
});

test('notes: the three the host emits map to closed Spanish text; an unknown note is never echoed', () => {
  assert.deepEqual(Object.keys(D.NOTES).sort(), ['clipboardRefused', 'needModel', 'noMicrophone']);
  for (const k of Object.keys(D.NOTES)) assert.ok(rust.includes(`"${k}"`), k);
  assert.match(D.noteOf({ note: 'needModel' }), /modelo de voz/); assert.match(D.noteOf({ note: 'noMicrophone' }), /micrófono/); assert.match(D.noteOf({ note: 'clipboardRefused' }), /portapapeles/);
  for (const bad of [null, {}, { note: '<b>x</b>' }, { note: 'constructor' }, { note: '__proto__' }, { note: 7 }, []]) assert.equal(D.noteOf(bad), null, JSON.stringify(bad));
});

test('bands: always exactly 9 numbers clamped to 0..1; a payload that is not a bands frame is ignored', () => {
  assert.equal(D.BANDS, 9);
  assert.deepEqual(D.bandsOf({ bands: [0, 0.5, 1, 2, -1, NaN, 'x', null, Infinity, 0.3, 0.9] }), [0, 0.5, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(D.bandsOf({ bands: [] }), new Array(9).fill(0));
  for (const bad of [null, [], 'x', {}, { bands: 'x' }, { bands: {} }]) assert.equal(D.bandsOf(bad), null);
  assert.equal(D.barSize(0), 3.4); assert.ok(Math.abs(D.barSize(1) - 19.4) < 1e-9); assert.equal(D.barSize(5), D.barSize(1)); assert.equal(D.barSize(-3), 3.4);
});

test('looks and sizes follow Coucou: listening/thinking = live, locked = hands-free 158, copied/failed = message, idle = resting or toolbar on hover', () => {
  assert.equal(D.lookOf('listening', false), 'live'); assert.equal(D.lookOf('thinking', true), 'live'); assert.equal(D.lookOf('locked', false), 'handsFree');
  assert.equal(D.lookOf('copied', false), 'message'); assert.equal(D.lookOf('failed', false), 'message');
  assert.equal(D.lookOf('idle', false), 'resting'); assert.equal(D.lookOf('idle', true), 'toolbar');
  assert.equal(D.lengthOf('resting'), 44); assert.equal(D.lengthOf('toolbar'), 150); assert.equal(D.lengthOf('handsFree'), 158); assert.equal(D.lengthOf('live'), 118);
  assert.ok(D.lengthOf('message', D.messageOf('copied')) > D.lengthOf('message', D.messageOf('failed')) - 40);
  assert.equal(D.messageOf('copied'), 'Copiado · pegalo con Ctrl+V'); assert.equal(D.messageOf('failed'), 'Micrófono no disponible'); assert.equal(D.messageOf('idle'), null);
});

test('dots: the voice while listening or locked, a slow wave while thinking, nothing otherwise', () => {
  const target = [0.7, 0.2, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(D.dotGoal('listening', 0, 0, target), 0.7); assert.equal(D.dotGoal('locked', 99, 1, target), 0.2);
  assert.equal(D.dotGoal('idle', 0, 0, target), 0); assert.equal(D.dotGoal('copied', 0, 0, target), 0);
  for (let i = 0; i < 9; i++) { const g = D.dotGoal('thinking', 1234 + i * 77, i, target); assert.ok(g >= 0 && g <= 0.5, String(g)); }
});

test('the pill exists only with dictation on: status.prefs.enabled === true; the verbs are the closed ones', () => {
  // abito-pausa 0.1.2: while dictation is paused the pill is hidden even with the stored preference on (the preference is untouched)
  assert.equal(require(path.join(frontend, 'paused.js')).paused('dictation'), true, 'this version pauses dictation');
  assert.equal(D.enabledOf({ prefs: { enabled: true } }), false, 'paused: no dictation pill, whatever the stored preference says');
  assert.equal(D.enabledIgnoringPause({ prefs: { enabled: true } }), true, 'the previous rule survives for the next version');
  for (const bad of [null, [], {}, { prefs: {} }, { prefs: { enabled: 'yes' } }, { prefs: { enabled: false } }, { prefs: [] }]) assert.equal(D.enabledIgnoringPause(bad), false, JSON.stringify(bad));
  assert.deepEqual(D.VERBS, { handsFree: 'hands_free', finish: 'finish', cancel: 'cancel', status: 'status' });
  for (const v of Object.values(D.VERBS)) assert.ok(rust.includes(`"${v}"`), v + ' is a verb of dictation_action');
});

test('wiring: closed events and verbs only; trusted clicks; inert in the settings window; never starts the mic or expands the island', () => {
  for (const e of ['dictation:phase', 'dictation:bands', 'dictation:note']) assert.match(src, new RegExp(`listen\\('${e}'`));
  for (const verb of src.match(/payload: \{ action: [^}]+\}/g) || []) assert.match(verb, /action: (verb|api\.VERBS\.status)/, verb);
  assert.match(src, /e\.isTrusted !== true\) return; e\.stopPropagation\(\)/);
  assert.match(src, /label === 'settings'\) return/);
  assert.doesNotMatch(src, /set_prefs|download_model|remove_model|getUserMedia|innerHTML/);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="island-dictation\.js"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
  assert.match(css, /\.dcapsule \{[^}]*border-radius: 999px/); assert.match(css, /\.dcapsule\.handsfree \{ box-shadow: inset 0 0 0 1\.5px rgba\(249, 115, 22, 0\.85\)/);
  assert.match(css, /\.dpill \.bars i \{ width: 3\.4px; height: 3\.4px/); assert.match(css, /\.dpill \.pbtn::after \{ content: ""; position: absolute; inset: -8px; \}/, '44px hit around the 28px button');
  assert.match(css, /#capsule\[data-phase="compact"\]\[data-dictation="locked"\] #island/, 'the folded dot shows a live dictation');
});

// ---- #479: dictation opens a folded island, and only gives it back if WE opened it ------------------------------------
test('reveal: a live dictation expands a folded or hidden island, never one that is already open or busy', () => {
  for (const phase of ['listening', 'locked']) assert.equal(D.revealPlan({ phase, was: 'idle', enabled: true, island: { phase: 'compact', state: 'compact' } }), 'expand', phase);
  assert.equal(D.revealPlan({ phase: 'listening', was: 'idle', enabled: true, island: { phase: 'compact', state: 'hidden' } }), 'expand', 'a hidden island is revealed too');
  assert.equal(D.revealPlan({ phase: 'listening', was: 'idle', enabled: true, island: { phase: 'expanded', state: 'expanded' } }), 'none', 'already open');
  assert.equal(D.revealPlan({ phase: 'locked', was: 'listening', enabled: true, island: { phase: 'compact', state: 'compact' } }), 'none', 'only the START of a dictation opens it, not hands-free after listening');
  assert.equal(D.revealPlan({ phase: 'thinking', was: 'idle', enabled: true, island: { phase: 'compact', state: 'compact' } }), 'none');
  for (const phase of ['idle', 'copied', 'failed']) assert.equal(D.revealPlan({ phase, was: 'idle', enabled: true, island: { phase: 'compact', state: 'compact' } }), 'none', phase);
  assert.equal(D.revealPlan({ phase: 'listening', was: 'idle', enabled: false, island: { phase: 'compact', state: 'compact' } }), 'none', 'dictation off: no pill, no reveal');
  assert.equal(D.revealPlan({ phase: 'listening', was: 'idle', enabled: true, island: null }), 'none');
});

test('restore: it collapses only when WE expanded it, the dictation ended and the human has not taken the island', () => {
  const base = { phase: 'idle', was: 'copied', weExpanded: true, touched: false, island: { phase: 'expanded', view: 'overview' } };
  assert.equal(D.restorePlan(base), 'collapse');
  for (const was of ['listening', 'locked', 'thinking']) assert.equal(D.restorePlan({ ...base, phase: 'idle', was }), 'collapse', 'ends straight from ' + was + ' (cancelled)');
  assert.equal(D.restorePlan({ ...base, weExpanded: false }), 'none', 'it was already open: leave it');
  assert.equal(D.restorePlan({ ...base, touched: true }), 'none', 'the human clicked the island: it is theirs now');
  for (const phase of ['listening', 'locked', 'thinking', 'copied', 'failed']) assert.equal(D.restorePlan({ ...base, phase }), 'none', 'still ' + phase);
  for (const island of [{ phase: 'expanded', view: 'chat' }, { phase: 'expanded', view: 'overview', card: 'pending' }, { phase: 'expanded', view: 'overview', question: 'pending' }, { phase: 'expanded', view: 'overview', settings: 'open' }, { phase: 'compact', view: 'overview' }, null])
    assert.equal(D.restorePlan({ ...base, island }), 'none', JSON.stringify(island));
});

test('reveal wiring: the host verbs expand / close (same closed verbs as the notice reveal), one call at a time, trusted pointer = the human took it', () => {
  assert.match(src, /hostCall\('expand'/); assert.match(src, /hostCall\('close'\)/); assert.match(src, /d\[verb\]\(\)/);
  assert.match(src, /revealPlan\(\{ phase: next, was: phase,/); assert.match(src, /restorePlan\(\{ phase: next, was: phase,/);
  assert.match(src, /pointerdown', e => \{ if \(e\.isTrusted === true\) touched = true; \}/);
  assert.match(src, /if \(flight\) return;/, 'one host call at a time');
});

if (failed) process.exit(1);
