'use strict';
// #415 WU1 — the human reads «blob»/«blobs», never «pill»: every visible word of the
// pills UI (settings labels, aria-labels, notes, tab title, overview failure copy) is the
// new word, while every stored/wire contract keeps its shipped name (mainPill, declaredPills,
// pillColors; main_pill, declared_pills, pill_colors; the set_main_pill/toggle_declared_pill/
// set_pill_color/clear_pill_color actions; the 'pills' tab id). No IPC, no network.
// Run: node apps/desktop-tauri/test-node/blobs-copy-check.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const frontend = path.join(__dirname, '../frontend');
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');

// A minimal DOM: textContent composition, append, attributes, dataset, listeners.
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.className = '';
    this.dataset = {}; this.attrs = {}; this.handlers = {}; this.value = '';
    this.disabled = false; this.id = ''; this.htmlFor = ''; this.hidden = false;
  }
  set textContent(text) { this.children = []; if (text) this.children.push(String(text)); }
  get textContent() {
    return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('');
  }
  append(...items) { for (const item of items) this.children.push(item); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn); }
}
const doc = { createElement: tag => new Node(tag), createElementNS: (_ns, tag) => new Node(tag) };

const walk = (node, visit) => {
  visit(node);
  for (const child of node.children) if (typeof child !== 'string') walk(child, visit);
};
// Every visible word of a rendered tree: text nodes plus aria-labels.
const words = root => {
  const texts = [], arias = [];
  walk(root, n => {
    if (n.textContent) texts.push(n.textContent);
    if (n.attrs['aria-label']) arias.push(n.attrs['aria-label']);
  });
  return { texts, arias };
};

// The pure model loads through require; the settings renderer attaches to a window object.
const model = require(path.join(frontend, 'pills.js'));
global.window = {
  AbitoAvatarColors: require(path.join(frontend, 'avatar-colors.js')),
  AbitoPillCatalog: require(path.join(frontend, 'pill-catalog.js')),
  AbitoPills: model,
};
const settings = global.window.AbitoPillSettings =
  (() => { require(path.join(frontend, 'pill-settings.js')); return global.window.AbitoPillSettings; })();
const view = require(path.join(frontend, 'settings-view.js'));

test('S1 the Blobs screen speaks blob/agent, never pill (#442: agents; the chip disclaimer moved to the principal «Qué hace»)', () => {
  assert.ok(settings.render, 'render entry point');
  const host = new Node('div');
  host.ownerDocument = doc;
  global.window.AbitoSpecialists = require(path.join(frontend, 'specialists-view.js'));
  settings.render(host, { prefs: {}, store: { v: 1, active: null, persisted: true, load_error: false, specialists: [] }, listing: null }, { saving: false, error: '' });
  const { texts, arias } = words(host);
  const joined = [...texts, ...arias].join('\n');
  assert.match(joined, /Siempre en la isla/, 'the principal chip is there');
  assert.equal((joined.match(/pill/gi) || []).length, 0, 'no visible word says pill');
  for (const word of joined.split(/\s+/)) {
    assert.doesNotMatch(word, /pill/i, `visible word must not say pill: ${word}`);
  }
});

test('S2 the settings model keeps the shipped wire names and the tab id', () => {
  const normalized = model.normalize({});
  assert.deepEqual(Object.keys(normalized), ['mainPill', 'declaredPills', 'pillColors', 'blobs'],
    'the shipped wire keys are unchanged; #415 adds only the created-blob list');
  assert.equal(model.DEFAULT_MAIN, 'integration_claude');
  assert.equal(model.MAX_DECLARED, undefined, 'S32: no declared-pill limit');
  assert.equal(view.TABS.find(x => x.id === 'pills').id, 'pills', 'the tab id is a shipped contract');
});

test('S3 the tab the human clicks is titled «Blobs»', () => {
  const tab = view.TABS.find(x => x.id === 'pills');
  assert.equal(tab.title, 'Blobs');
  assert.equal(tab.label, 'Blobs');
});

test('S4 the Rust store keeps the shipped keys and the closed action names', () => {
  const prefs = fs.readFileSync(path.join(__dirname, '../src/prefs.rs'), 'utf8');
  for (const key of ['"main_pill"', '"declared_pills"', '"pill_colors"']) {
    assert.ok(prefs.includes(key), `${key} survives as the stored key`);
  }
  for (const action of ['set_main_pill', 'toggle_declared_pill', 'set_pill_color', 'clear_pill_color']) {
    assert.ok(prefs.includes(`"${action}"`), `the ${action} action survives`);
  }
});

test('S5 the index aria group and the failure copy speak of blobs', () => {
  const html = read('index.html');
  assert.match(html, /aria-label="Blobs"/, 'the right column list speaks of blobs');
  assert.ok(!/aria-label="Pills declaradas"/.test(html));
  const overview = read('pills-view.js');
  assert.match(overview, /blobs guardados/, 'the failure copy the human reads says blobs');
  assert.ok(!/tus pills guardadas/.test(overview));
});
