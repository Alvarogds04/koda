'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { engine } = require('./character-harness.cjs');
const M = require('../frontend/character-minibots.js');
const view = (turns, id = 'c-1') => ({ conversation_id: id, turns: turns.map(([turn_id, state]) => ({ turn_id, state })) });
function dom() {
  const doc = { createElement: tag => node(tag), createElementNS: (_, tag) => node(tag) };
  function node(tag) { const n = { tag, attrs: {}, children: [], parent: null, textContent: '', hidden: false,
    setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute: k => n.attrs[k],
    appendChild(c) { c.parent = n; n.children.push(c); }, remove() { if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n); n.parent = null; } }; return n; }
  return { doc, container: node('ul') };
}
function setup(reduced = false) {
  const h = engine(reduced), d = dom(), made = [];
  const minis = M.create({ container: d.container, doc: d.doc, makeClay(svg, seed) { const c = h.api.create(h.element(), { seed }); made.push({ svg, clay: c }); return c; } });
  return { h, d, minis, made };
}
test('plan: one mini per real nonterminal turn keyed conversation_id+turn_id; terminal/unknown/duplicate/malformed yield none', () => {
  const p = M.plan(view([['t-1', 'queued'], ['t-2', 'thinking'], ['t-3', 'streaming'], ['t-4', 'waiting_approval'], ['t-5', 'done'], ['t-6', 'failed'], ['t-7', 'bogus'], ['t-1', 'queued']]));
  assert.deepEqual(p.map(x => x.state), ['idle', 'think', 'speak', 'approval']);
  assert.equal(new Set(p.map(x => x.key)).size, 4);
  assert.notEqual(M.plan(view([['t-1', 'thinking']], 'c-1'))[0].key, M.plan(view([['t-1', 'thinking']], 'c-2'))[0].key);
  for (const bad of [null, {}, { turns: [] }, { conversation_id: 'c', turns: 'x' }, view([[null, 'thinking']])]) assert.deepEqual(M.plan(bad), []);
  assert.equal(M.plan(view(Array.from({ length: 20 }, (_, i) => ['t' + i, 'queued']))).length, M.MAX_MINIS);
});
test('minis render neutral Abito clay with the honest «Turno» label; no specialist name; no state outside the turn', () => {
  const { d, minis, made } = setup(); minis.sync(view([['t-1', 'thinking']]));
  const li = d.container.children[0]; assert.equal(d.container.hidden, false);
  assert.equal(li.children[1].textContent, 'Turno · Piensa'); assert.equal(li.children[0].attrs['aria-hidden'], 'true');
  assert.equal(made[0].clay.state, 'think');
  minis.sync(view([['t-1', 'waiting_approval']])); assert.equal(made[0].clay.state, 'approval'); assert.equal(li.children[1].textContent, 'Turno · Espera tu decisión');
  assert.equal(made.length, 1, 'keyed instance reused, not recreated');
});
test('removed, terminal and cleared turns destroy their instance; no leftover frames or nodes', () => {
  const { h, d, minis } = setup(); h.api.setForced(true);
  minis.sync(view([['t-1', 'queued'], ['t-2', 'streaming']])); assert.equal(minis.size, 2); assert.equal(h.pending(), 1, 'one shared loop for all minis');
  minis.sync(view([['t-2', 'streaming']])); assert.equal(minis.size, 1); assert.equal(d.container.children.length, 1);
  minis.sync(view([['t-2', 'done']])); assert.equal(minis.size, 0); assert.equal(d.container.hidden, true);
  minis.sync(view([['t-9', 'thinking']])); minis.clear(); assert.equal(minis.size, 0); assert.equal(d.container.children.length, 0);
  h.frame(); assert.equal(h.pending(), 0, 'no live instance keeps the loop running');
});
test('honored reduced motion shows a static correct pose per mini; forced motion animates; pause freezes', () => {
  const r = setup(true); r.minis.sync(view([['t-1', 'thinking'], ['t-2', 'streaming']]));
  assert.equal(r.h.pending(), 0); assert.equal(r.made[0].clay.sample().state, 'think'); assert.equal(r.made[1].clay.sample().state, 'speak');
  assert.notEqual(r.made[0].clay.sample().d, r.made[1].clay.sample().d);
  const a = setup(); a.minis.sync(view([['t-1', 'thinking']])); assert.equal(a.h.pending(), 1);
  a.h.api.setPaused(true); assert.equal(a.h.pending(), 0);
});
test('island wires minis only into the overview, from the chat view, and releases them on pagehide', () => {
  const island = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(island, /AbitoMinis\.create/); assert.match(island, /dataset\.view === 'overview'/);
  assert.match(island, /minis\.clear\(\)/); assert.match(island, /characterView = view/);
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  assert.match(html, /character-minibots\.js/); assert.match(html, /id="minibots"/);
});
