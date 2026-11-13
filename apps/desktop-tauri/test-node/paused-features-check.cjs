'use strict';
// abito-pausa S1-S2 (human: «Visibles en gris y apagadas»): on the island, every paused feature is switched off — no Spotify card,
// no GitHub/service cards or pollers, no integration rows — even when the stored prefs still name it (prefs are never rewritten).
// The previous behaviour stays pinned through `wantedIgnoringPause`, so the next version turns a feature back on in one place.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const P = require(path.join(frontend, 'paused.js'));
const S = require(path.join(frontend, 'spotify-view.js'));
const G = require(path.join(frontend, 'island-github.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

test('one frontend list, the same as Ajustes and Rust', () => {
  assert.equal(P.LABEL, 'En pausa · próxima versión');
  // K2 T1 (S2, S3): `phone` is out of the pause — Ajustes › Teléfono is live and the link still starts OFF there.
  // K2-09 S5: «se quita la pausa de Spotify»
  for (const f of ['dictation', 'voice', 'integrations']) assert.equal(P.paused(f), true, f);
  for (const f of ['spotify', 'chat', 'agents', 'general', 'shortcuts', 'privacy', 'sessions', 'notifications', 'phone', 'mail', 'github', 'calendar']) assert.equal(P.paused(f), false, f);
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src', 'paused.rs'), 'utf8');
  assert.match(rust, /Feature::Dictation \| Feature::Voice \| Feature::Integrations => true,\s*Feature::Phone => false/);
  assert.match(rust, /Feature::Spotify => false/, 'K2-09: Spotify is no longer paused in Rust either');
  const shell = fs.readFileSync(path.join(frontend, 'vendor', 'coucou', 'hub', 'shell.ts'), 'utf8');
  assert.match(shell, /ACTIVE_PAGES: readonly string\[\] = Object\.freeze\(\["general", "agents", "chat", "phone", "shortcuts", "privacy"\]\)/, 'Ajustes keeps exactly the active pages');
});
test('Spotify (K2-09): not paused any more, so the card follows the prefs on a supported OS', () => {
  const prefs = { mainPill: 'integration_spotify' };
  assert.equal(S.wanted(prefs, 'linux'), true);
  assert.equal(S.wantedIgnoringPause(prefs, 'linux'), true);
  assert.equal(S.wantedIgnoringPause({ mainPill: 'integration_claude', declaredPills: ['integration_spotify'] }, 'linux'), true);
  // K2-09 S1: the card exists on the three systems (MPRIS, SMTC, AppleScript)
  for (const os of ['windows', 'macos']) assert.equal(S.wanted(prefs, os), true, os);
  assert.equal(S.wanted(prefs, 'unknown'), false);
});
test('K2-11 S6: GitHub and the calendar have their OWN entry and are not paused — no stored pill is needed any more', () => {
  for (const id of ['github', 'calendar']) assert.equal(P.paused(id), false, `${id} has its own, active entry`);
  assert.equal(P.paused('integrations'), true, 'the 0.3 service cards stay paused');
  // the card no longer reads the declared pill: its own pause entry plus the truth of the host answer decide it (S3)
  assert.equal(G.pausedNow(), false);
  assert.equal(G.available({ available: true, pulse: { login: 'me', myPRs: [], toReview: [], mainCI: [], issues: [] } }), true);
  const src = fs.readFileSync(path.join(frontend, 'island-github.js'), 'utf8');
  assert.doesNotMatch(src, /declaredPills|mainPill/, 'no stored pill gate: criterion 1 only asks for the saved token');
});
test('island wiring: integration rows, service cards and the integration_action call all go through the pause', () => {
  const pv = fs.readFileSync(path.join(frontend, 'pills-view.js'), 'utf8');
  assert.match(pv, /AbitoPaused && root\.AbitoPaused\.paused\('integrations'\)/, 'no integration rows in the right column');
  const ii = fs.readFileSync(path.join(frontend, 'island-integrations.js'), 'utf8');
  assert.match(ii, /AbitoPaused && window\.AbitoPaused\.paused\('integrations'\)\) return;/, 'the service cards never mount nor call integration_action');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  // the classic-script factories do not receive `root`: a paused check there must read `window` (the live page threw «root is not defined»)
  for (const f of ['spotify-view.js', 'island-github.js']) assert.doesNotMatch(fs.readFileSync(path.join(frontend, f), 'utf8'), /: root\.AbitoPaused/, f);
  assert.ok(html.indexOf('src="paused.js"') > 0 && html.indexOf('src="paused.js"') < html.indexOf('src="spotify-view.js"'), 'paused.js loads before the features that read it');
});
console.log(`paused-features-check: ${passed} checks ok`);
