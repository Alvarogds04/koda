'use strict';
/* Wiring of the dormant integration cards into Ajustes -> Conexiones (group «Servicios (datos de ejemplo)»).
   Static checks over index.html / settings.js / settings-view.js / style.css; no DOM, no network.
   Run: node apps/desktop-tauri/test-node/integrations-mount-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const read = f => fs.readFileSync(path.join(frontend, f), 'utf8');
const S = require(path.join(frontend, 'settings-view.js'));
const html = read('index.html');
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

const CARDS = ['github', 'deployments', 'email', 'mail', 'payments', 'finance', 'notion', 'n8n', 'calendar'];
const GROUP = /<div id="connections-more"[^>]*\bhidden\b[^>]*>([\s\S]*?)<!-- \/connections-more -->/;

test('the group wrapper lives inside #settings, outside #settings-body (render() wipes the body)', () => {
  const settings = html.slice(html.indexOf('<div id="settings"'));
  assert.ok(GROUP.test(settings), 'wrapper #connections-more (hidden) missing');
  const bodyTag = settings.indexOf('<div id="settings-body"');
  assert.ok(settings.indexOf('<div id="connections-more"') > settings.indexOf('</div>', bodyTag), 'wrapper must not be nested in the body');
});

// T7.2 design (R7): the group label is the design's own «Servicios · Datos de ejemplo».
// Was: «Servicios (datos de ejemplo)».
test('group title is «Servicios · Datos de ejemplo», a heading', () => {
  const g = html.match(GROUP)[1];
  assert.match(g, /<h3[^>]*>Servicios · Datos de ejemplo<\/h3>/);
});

test('framework container and every card get their OWN hidden sibling section inside the group', () => {
  const g = html.match(GROUP)[1];
  for (const id of ['integrations', ...CARDS.map(c => `integrations-${c}`)]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} once`);
    assert.match(g, new RegExp(`<section id="${id}" hidden></section>`), id);
  }
});

test('scripts: framework first, every card after it, deferred, once each', () => {
  const tags = [...html.matchAll(/<script[^>]*src="(integrations-[a-z0-9]+\.js)"[^>]*>/g)];
  const names = tags.map(m => m[1]);
  assert.deepEqual([...names].sort(), ['integrations-view.js', ...CARDS.map(c => `integrations-${c}.js`)].sort());
  assert.equal(names[0], 'integrations-view.js');
  for (const m of tags) assert.match(m[0], /\bdefer\b/);
});

test('visibility seam: the group shows only on the Conexiones tab', () => {
  assert.equal(S.servicesGroupVisible('accounts'), true);
  assert.equal(S.servicesGroupVisible('connectors'), true, 'alias resolves to the merged tab');
  for (const t of S.TABS.filter(x => x.id !== 'accounts')) assert.equal(S.servicesGroupVisible(t.id), false, t.id);
  assert.equal(S.servicesGroupVisible('nope'), false);
  const js = read('settings.js');
  assert.match(js, /connections-more/);
  assert.match(js, /servicesGroupVisible\(/);
});

test('style: new rules sit BEFORE the #410 compact block, tokens only', () => {
  const css = read('style.css');
  const at = css.indexOf('#connections-more');
  assert.ok(at > 0, 'rules missing');
  assert.ok(at < css.indexOf('/* ---- #410: Conexiones compacta'), 'must precede the #410 block');
  const rules = css.split('\n').filter(l => l.includes('#connections-more')).join('\n');
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  assert.match(rules, /#connections-more\[hidden\]\s*\{\s*display:\s*none/);
});

console.log(`integrations-mount-check: ${passed} passed`);
