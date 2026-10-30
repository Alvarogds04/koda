'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const O = require('../frontend/overview-view.js');
const NV = require('../frontend/notify-view.js');
const src = fs.readFileSync(require.resolve('../frontend/island.js'), 'utf8');
const css = fs.readFileSync(require.resolve('../frontend/vendor/coucou/island/island.css'), 'utf8');
let failed = 0;
function test(name, run) { try { run(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } }
test('R14: bell-labelled Avisos opens the list even for a lone transport notice', () => {
  for (const kind of ['settled', 'transport']) {
    const view = O.noticeBandView([{ id: 'transport-1', kind, title: 'Conexión caída', severity: 'error' }], Date.now());
    assert.equal(view.title, 'Avisos · 1');
    assert.equal(view.action, 'list');
    assert.equal(view.icon, 'bell');
    assert.equal(view.tone, 'red');
  }
  assert.doesNotMatch(src, /list\.count [<>] [12]/, 'no multiple-notice gate');
});
test('R14: each UUID row opens its own detail, transport has only dismiss, dismiss never opens', () => {
  const nodes = [];
  const calls = [];
  const context = { NV, window: { desktop: { click: payload => { calls.push(payload); return Promise.resolve(); } } }, document: { createElement: tag => {
    const node = { tag, dataset: {}, listeners: {}, children: [], setAttribute(k,v) { this[k]=v; }, addEventListener(k,v) { this.listeners[k]=v; }, replaceChildren(...v) { this.children=v; } }; nodes.push(node); return node;
  } } };
  const fn = src.slice(src.indexOf('  function noticeRowNode('), src.indexOf('  // «Descartar todos»'));
  vm.runInNewContext(fn + '\nthis.make = noticeRowNode;', context);
  const id = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
  const li = context.make({id, kind:'settled', title:'Codex terminó', time:'un momento'});
  const open = li.children.find(n => n.tag === 'button' && n.className !== 'notice-list-dismiss');
  assert.ok(open, 'UUID row is a keyboard-accessible button');
  open.listeners.click({isTrusted:false}); assert.equal(calls.length,0);
  open.listeners.click({isTrusted:true}); assert.equal(calls[0].id,id);
  assert.equal(calls[0].kind,'finished');
  const transport = context.make({id:'transport-2',kind:'transport', title:'Conexión caída'});
  assert.equal(transport.children.filter(n => n.tag === 'button').length,1,'transport only has ×');
});
test('S4/T2: an attention row is a pointer, never a button, and it says where to answer', () => {
  const nodes = [];
  const calls = [];
  const context = { NV, window: { desktop: { click: payload => { calls.push(payload); return Promise.resolve(); } } }, document: { createElement: tag => {
    const node = { tag, dataset: {}, listeners: {}, children: [], setAttribute(k,v) { this[k]=v; }, addEventListener(k,v) { this.listeners[k]=v; }, replaceChildren(...v) { this.children=v; } }; nodes.push(node); return node;
  } } };
  const fn = src.slice(src.indexOf('  function noticeRowNode('), src.indexOf('  // «Descartar todos»'));
  vm.runInNewContext(fn + '\nthis.make = noticeRowNode;', context);
  const id = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
  const li = context.make({ id, kind: 'attention', title: 'Codex te pide permiso', projectName: 'repo', agent: 'codex',
    detail: 'Bash: ls · Respondé en la terminal', time: 'un momento', tone: 'sun' });
  // only the × is a button: the agent's own terminal is the only place to answer
  assert.equal(li.children.filter(n => n.tag === 'button').length, 1, 'the attention row has no opener, only ×');
  const text = li.children[0].children.find(n => n.className === 'notice-list-text');
  const muted = text.children.find(n => n.className === 'notice-list-time');
  assert.match(muted.textContent, /^repo · Bash: ls · Respondé en la terminal · un momento$/);
  // the agent is NOT repeated when the title already names it (the pre-existing rule)
  assert.doesNotMatch(muted.textContent, /codex/);
  assert.deepEqual(calls, []);
});
test('R20: list owns an opaque surface, hides overview/mascot, wraps and uses 44px spaced rows', () => {
  assert.match(css, /#capsule\[data-notice-list="open"\] #overview-view\s*\{[^}]*visibility: hidden/);
  assert.match(css, /#capsule\[data-view="overview"\] #notices\[data-list="open"\]\s*\{[^}]*background: var\(--card-flat\)/);
  assert.match(css, /#capsule\[data-view="overview"\] #notices\[data-list="open"\] \.notice-list-row\s*\{[^}]*flex: 0 0 auto[^}]*min-height: 44px/);
  assert.match(css, /\.notice-list-title\s*\{[^}]*white-space: normal[^}]*overflow-wrap: anywhere/);
  assert.match(css, /#notice-rows\s*\{[^}]*gap: 6px[^}]*overflow-y: auto/);
});
test('project identity survives the list projection without leaking result detail', () => {
  const rows = O.noticeListView(['repo', 'api'].map((projectName, i) => ({
    id: String(i), kind: 'settled', title: 'Codex terminó', projectName, agent: 'codex', detail: 'private result', at: 1000,
  })), 121000).rows;
  assert.deepEqual(rows.map(r => r.projectName), ['repo', 'api']);
  assert.deepEqual(rows.map(r => r.agent), ['codex', 'codex']);
  assert.ok(rows.every(r => !Object.hasOwn(r, 'detail')));
});
if (failed) process.exitCode = 1;
