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
  for (const f of ['dictation', 'voice', 'integrations', 'spotify', 'phone']) assert.equal(P.paused(f), true, f);
  for (const f of ['chat', 'agents', 'general', 'shortcuts', 'privacy', 'sessions', 'notifications']) assert.equal(P.paused(f), false, f);
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src', 'paused.rs'), 'utf8');
  assert.match(rust, /Feature::Dictation \| Feature::Voice \| Feature::Integrations \| Feature::Spotify \| Feature::Phone => true/);
  const shell = fs.readFileSync(path.join(frontend, 'vendor', 'coucou', 'hub', 'shell.ts'), 'utf8');
  assert.match(shell, /ACTIVE_PAGES: readonly string\[\] = Object\.freeze\(\["general", "agents", "chat", "shortcuts", "privacy"\]\)/, 'Ajustes keeps exactly the active pages');
});
test('Spotify: no card while paused, even with the pill declared on Linux; the old rule is kept for the next version', () => {
  const prefs = { mainPill: 'integration_spotify' };
  assert.equal(S.wanted(prefs, 'linux'), false);
  assert.equal(S.wantedIgnoringPause(prefs, 'linux'), true);
  assert.equal(S.wantedIgnoringPause({ mainPill: 'integration_claude', declaredPills: ['integration_spotify'] }, 'linux'), true);
  assert.equal(S.wantedIgnoringPause(prefs, 'windows'), false);
});
test('GitHub: no card and no polling while paused; the old rule is kept', () => {
  assert.equal(G.wanted({ mainPill: 'integration_github' }), false);
  assert.equal(G.wantedIgnoringPause({ mainPill: 'integration_github' }), true);
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
