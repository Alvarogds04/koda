'use strict';
// 0.2.1 · S6 (L2 «Sin IA para el chat ni Claude repetido»; L1 «el botón IA para el chat… no tiene sentido») replaces the old #503 S19 pill-row
// design: the page no longer lists AI/workspace pills as rows. What remains of this part is the main-tool selector, and the hub still hands
// its navigator to renderNotch.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { test, all, text, dom, Element, load } = require('./settings-designs-check.cjs');

async function mount() {
  dom();
  Element.prototype.getBoundingClientRect = () => ({ left: 20, bottom: 30 });
  Element.prototype.querySelector = function (selector) { return all(this).find(e => selector === '.' + e.className.split(' ').join('.')) || null; };
  global.window = { innerWidth: 1100, addEventListener() {}, removeEventListener() {} };
  const { renderPills } = await load('personalization.js');
  const V = require('../frontend/settings-view.js'), S = require('../frontend/specialists-view.js'), A = require('../frontend/avatar-colors.js');
  const P = require('../frontend/pills.js'), C = require('../frontend/pill-catalog.js');
  const prefs = { theme: 'system', avatarColors: {}, pillColors: {}, declaredPills: [], mainPill: 'integration_claude', islandAgents: [], abitoInstructions: '' };
  const invoke = async (cmd, { payload: p }) => (cmd === 'specialists_action' ? { specialists: [], active: null } : cmd === 'models_action' ? { profiles: [] } : structuredClone(prefs));
  const ui = await renderPills({ invoke, V, S, A, P, C, part: 'tools', listen: async () => () => {} });
  await ui.settled();
  return { ui };
}

test('S6 Agentes: no «IA para el chat» group, no pill rows, no repeated Claude Code: the part holds the main tool only', async () => {
  const { ui } = await mount();
  assert(!text(ui).includes('IA para el chat') && !text(ui).includes('Píldoras activas') && !text(ui).includes('Dónde programas'));
  assert.equal(all(ui).filter(e => String(e.className).split(' ').includes('pill-row')).length, 0, 'no pill rows');
  assert.equal(all(ui).filter(e => e.tagName === 'select').length, 0, 'the main tool is unavailable, not selectable');
});

test('HU-076: the unavailable main-tool slot is hidden, not announced', async () => {
  const { ui } = await mount();
  assert(!text(ui).includes('Herramienta principal'));
  ui.dispose();
});

test('unavailable main-tool body has no interactive controls', async () => {
  const { ui } = await mount();
  assert.equal(all(ui).filter(e => ['select', 'button', 'input', 'textarea'].includes(e.tagName)).length, 0);
  ui.dispose();
});

test('the hub passes its navigator to renderNotch and Agentes mounts the four parts', () => {
  const shell = fs.readFileSync(path.join(__dirname, '../frontend/vendor/coucou/hub/shell.ts'), 'utf8');
  assert.match(shell, /renderNotch\(def\.id, container, ctx\.navigate\)/);
  const entry = fs.readFileSync(path.join(__dirname, '../frontend/settings-app.js'), 'utf8');
  assert.match(entry, /async renderNotch\(page, container, navigate\)/);
  for (const part of ['tools', 'island', 'abito']) assert(entry.includes(`part: '${part}'`), part);
});
