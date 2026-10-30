'use strict';
// #345 F031/F032: public pure catalog/model checks; no DOM, IPC, data or providers.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const catalogPath = path.join(__dirname, '../frontend/pill-catalog.js');
const modelPath = path.join(__dirname, '../frontend/pills.js');
const C = () => require(catalogPath);
const M = () => require(modelPath);
const ids = [
  'integration_claude', 'agent_cursor', 'agent_antigravity', 'agent_codex',
  'agent_gemini', 'agent_copilot', 'agent_muse', 'agent_opencode', 'agent_amp',
  'agent_hermes', 'agent_claude-desktop', 'ai_anthropic', 'ai_google', 'ai_openai',
  'ai_ollama', 'ai_lmstudio', 'integration_resend', 'integration_n8n',
  'integration_vercel', 'integration_github', 'integration_notion',
  'integration_calcom', 'integration_stripe', 'integration_music', 'integration_spotify',
];
const names = ['VS Code', 'Cursor', 'Antigravity', 'Codex', 'Gemini CLI', 'Copilot CLI',
  'Muse Code', 'OpenCode', 'Amp', 'Hermes', 'Claude Desktop', 'Anthropic', 'Google AI',
  'OpenAI', 'Ollama', 'LM Studio', 'Resend', 'n8n', 'Vercel', 'GitHub', 'Notion',
  'Cal.com', 'Stripe', 'Apple Music', 'Spotify'];
const defaults = ['integration_resend', 'integration_n8n', 'integration_vercel', 'integration_github'];

test('S3 exact25 identities, names, category order and immutable closed definitions', () => {
  const c = C();
  assert.deepEqual(c.CATALOG.map(x => x.id), ids);
  assert.deepEqual(c.CATALOG.map(x => x.name), names);
  assert.deepEqual(c.CATALOG.map(x => x.category), [
    ...Array(4).fill('workspace'), ...Array(7).fill('agent'),
    ...Array(5).fill('ai'), ...Array(9).fill('service'),
  ]);
  assert.deepEqual(c.CATEGORIES.map(x => x.id), ['workspace', 'agent', 'ai', 'service']);
  assert.equal(new Set(ids).size, 25);
  assert.ok(Object.isFrozen(c.CATALOG));
  for (const def of c.CATALOG) assert.ok(Object.isFrozen(def));
  for (const id of [null, '', '__proto__', 'constructor', 'unknown', 1]) assert.equal(c.definition(id), null);
});

test('S6 only23 Linux declarations; Apple Music excluded and desktop unsupported', () => {
  const c = C();
  assert.equal(c.available('linux').length, 23);
  assert.equal(c.offered('integration_music', 'linux'), false);
  assert.equal(c.offered('agent_claude-desktop', 'linux'), false);
  assert.equal(c.offered('integration_spotify', 'linux'), true);
  assert.equal(c.available('windows').length, 23);
  assert.equal(c.offered('integration_music', 'windows'), false);
  assert.equal(c.offered('integration_spotify', 'windows'), false);
  assert.equal(c.offered('agent_claude-desktop', 'windows'), true);
  assert.deepEqual(c.available('unknown'), []);
  assert.deepEqual(c.mainChoices('linux').map(x => x.id), ['integration_claude', 'agent_codex', 'agent_gemini', 'agent_hermes'], '0.2.1 S3: the main tool offers CLIs only');
  assert.deepEqual(c.acceptedMain('linux').map(x => x.id), ['integration_claude', 'agent_cursor', 'agent_antigravity', 'agent_codex', 'agent_gemini', 'agent_hermes'], 'a stored Cursor/Antigravity main is still read back');
});

test('S4 default main and four default declarations; explicit empty list stays empty', () => {
  const m = M();
  assert.deepEqual(m.normalize({}), { mainPill: ids[0], declaredPills: defaults, pillColors: {}, blobs: [] });
  assert.deepEqual(m.normalize({ declaredPills: [] }), { mainPill: ids[0], declaredPills: [], pillColors: {}, blobs: [] });
  assert.equal(m.MAX_DECLARED, undefined, 'S32: there is no limit on declared pills');
  const a = m.normalize({}); a.declaredPills.pop();
  assert.deepEqual(m.normalize({}).declaredPills, defaults, 'defaults are never mutable shared state');
});

test('S6 damaged saved input keeps EVERY valid distinct choice (no cap), excluding main', () => {
  const m = M();
  for (const raw of [null, [], 7, 'bad']) assert.deepEqual(m.normalize(raw), m.normalize({}));
  const raw = { mainPill: 'ai_openai', declaredPills: [null, 'unknown', ids[0],
    'agent_claude-desktop', 'integration_music', 'agent_gemini', 'agent_gemini',
    'ai_google', 'agent_amp', 'integration_notion', 'integration_spotify'] };
  const before = JSON.stringify(raw);
  assert.deepEqual(m.normalize(raw), { mainPill: ids[0],
    declaredPills: ['agent_gemini', 'ai_google', 'agent_amp', 'integration_notion', 'integration_spotify'], pillColors: {}, blobs: [] });
  assert.equal(JSON.stringify(raw), before, 'load normalization does not mutate input');
  assert.deepEqual(m.normalize({ mainPill: 'agent_codex', declaredPills: defaults }).declaredPills, defaults);
});

test('S6 submitted state rejects types, duplicates, unknowns and main; a fifth choice is valid', () => {
  const m = M();
  const good = { mainPill: ids[0], declaredPills: [] };
  assert.equal(m.valid(good), true);
  for (const mainPill of ['unknown', 'ai_openai', null, 1]) assert.equal(m.valid({ ...good, mainPill }), false);
  for (const declaredPills of [null, 'x', [1], ['unknown'], [ids[0]],
    ['agent_amp', 'agent_amp'], ['agent_claude-desktop'], ['integration_music'],
    ]) assert.equal(m.valid({ ...good, declaredPills }), false);
  assert.equal(m.valid({ ...good, declaredPills: [...defaults, 'ai_google'] }), true, 'five declared pills are valid');
  assert.equal(m.valid({ ...good, declaredPills: [...defaults, 'ai_google', 'ai_openai', 'agent_amp', 'integration_notion'] }), true, 'and nine');
});

test('S4 toggle: main is not a slot, any number of choices can be declared, refusals are immutable', () => {
  const m = M();
  let state = { mainPill: ids[0], declaredPills: [] };
  for (const id of defaults) state = m.toggle(state, id);
  assert.deepEqual(state.declaredPills, defaults);
  const before = JSON.stringify(state);
  for (const id of [ids[0], 'unknown', 'integration_music', null]) assert.equal(m.toggle(state, id), null);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(m.toggle(state, 'ai_google').declaredPills, [...defaults, 'ai_google'], 'the fifth is accepted');
  state = m.toggle(state, defaults[1]);
  assert.deepEqual(state.declaredPills, [defaults[0], defaults[2], defaults[3]]);
  assert.deepEqual(m.toggle(state, 'ai_google').declaredPills, [...state.declaredPills, 'ai_google']);
});

test('S4 main workspace-only; changing main removes new-main declaration only', () => {
  const m = M();
  const old = { mainPill: ids[0], declaredPills: ['agent_cursor', 'ai_google'] };
  assert.deepEqual(m.chooseMain(old, 'agent_cursor'), { mainPill: 'agent_cursor', declaredPills: ['ai_google'] });
  assert.deepEqual(old.declaredPills, ['agent_cursor', 'ai_google']);
  for (const id of ['ai_google', 'unknown', 'integration_music', null]) assert.equal(m.chooseMain(old, id), null);
  assert.deepEqual(m.chooseMain(old, old.mainPill), old);
  assert.equal(m.toggle({ mainPill: ids[0], declaredPills: ['agent_amp', 'agent_amp'] }, 'agent_amp'), null);
});

test('S4 order is main then external seam then the STORED declared order (#435); rendering uses real selections only', () => {
  const m = M();
  const tasks = [{ id: 'ai_google' }, { id: 'external2' }, { id: 'agent_cursor' },
    { id: 'external1' }, { id: ids[0] }, { id: 'ai_google' }];
  // #435: the stored (input) order of the catalog items is honoured — before this change
  // the catalog index sorted them ([main, external2, external1, agent_cursor, ai_google, ai_google]).
  assert.deepEqual(m.order(tasks, ids[0]).map(x => x.id), [ids[0], 'external2', 'external1', 'ai_google', 'agent_cursor', 'ai_google']);
  assert.deepEqual(tasks.map(x => x.id), ['ai_google', 'external2', 'agent_cursor', 'external1', ids[0], 'ai_google']);
  const state = { mainPill: ids[0], declaredPills: ['integration_notion', 'agent_amp', 'ai_google'] };
  // #435: stored order — before this change the catalog index gave [main, agent_amp, ai_google, integration_notion].
  assert.deepEqual(m.visible(state).map(x => x.id), [ids[0], 'integration_notion', 'agent_amp', 'ai_google']);
  assert.equal(m.selection(state, 'removed'), ids[0]);
  assert.equal(m.selection(state, 'ai_google'), 'ai_google');
});

test('S6 offline detail never claims provider credentials/URL imply connection', () => {
  const m = M();
  for (const def of C().CATALOG) {
    const view = m.detail(def.id, 'linux');
    assert.equal(view.connected, false);
    assert.equal(view.icon, 'plug-off');
    assert.ok(view.word && view.detail && view.aria);
    assert.doesNotMatch(view.word, /^Conectado$/);
  }
  assert.equal(m.detail('integration_music').offered, false);
  assert.equal(m.detail('agent_claude-desktop').offered, false);
  assert.equal(m.detail('unknown'), null);
});

// #346 F033 — per-pill colours: the closed palette is avatar-colors.js PALETTE, and raw
// input never survives normalize/colorOf/setColor/clearColor.
test('#346 normalize keeps only catalog ids carrying palette names; empty means no colour', () => {
  const m = M();
  assert.deepEqual(m.normalize({}).pillColors, {});
  // Valid literal fixtures parsed as JSON on purpose: `__proto__`/`constructor` must be
  // OWN properties (an object literal would make `__proto__` set the prototype instead).
  const raw = (() => { try {
    return JSON.parse('{"pillColors":{"agent_amp":"mint","agent_cursor":"#ff0000","agent_muse":"MINT","integration_claude":"expression(alert(1))","ai_google":7,"unknown_pill":"blue","__proto__":"purple","constructor":"red"}}');
  } catch (cause) { throw new Error('fixture must be valid JSON', { cause }); } })();
  assert.deepEqual(m.normalize(raw).pillColors, { agent_amp: 'mint' });
  for (const bad of [null, [], 7, 'green', true]) assert.deepEqual(m.normalize({ pillColors: bad }).pillColors, {});
  const before = JSON.stringify(raw);
  m.normalize(raw);
  assert.equal(JSON.stringify(raw), before, 'colour normalization does not mutate input');
});

test('#346 colorOf answers only an already-validated palette name, never raw input', () => {
  const m = M();
  const state = m.normalize({ pillColors: { agent_amp: 'mint', agent_cursor: 'nope' } });
  assert.equal(m.colorOf(state, 'agent_amp'), 'mint');
  assert.equal(m.colorOf(state, 'agent_cursor'), '');
  assert.equal(m.colorOf(state, 'unknown_pill'), '');
  assert.equal(m.colorOf(m.normalize({}), 'agent_amp'), '');
  assert.equal(m.colorOf(null, 'agent_amp'), '');
  const hostileColor = (() => { try { return JSON.parse('{"agent_amp":"<img src=x>"}'); }
    catch (cause) { throw new Error('fixture must be valid JSON', { cause }); } })();
  assert.equal(m.colorOf({ mainPill: ids[0], declaredPills: [],
    pillColors: hostileColor }, 'agent_amp'), '');
});

test('#346 setColor/clearColor gate on offered catalog ids and the closed palette; state is never mutated', () => {
  const m = M();
  const state = m.normalize({});
  assert.deepEqual(m.setColor(state, 'agent_amp', 'purple'),
    { mainPill: state.mainPill, declaredPills: state.declaredPills, pillColors: { agent_amp: 'purple' } });
  assert.deepEqual(m.clearColor(state, 'agent_amp'),
    { mainPill: state.mainPill, declaredPills: state.declaredPills, pillColors: {} });
  const withColor = m.normalize({ pillColors: { agent_amp: 'purple', agent_cursor: 'mint' } });
  assert.deepEqual(m.clearColor(withColor, 'agent_amp').pillColors, { agent_cursor: 'mint' });
  for (const [id, color] of [['integration_music', 'purple'], ['unknown_pill', 'purple'],
    ['agent_amp', '#0f0'], ['agent_amp', 'MINT'], ['agent_amp', 'green;background:url(x)'],
    ['agent_amp', ''], ['agent_amp', 'rgb(0,255,0)'], ['__proto__', 'purple'],
    [7, 'purple'], ['agent_amp', null], [null, 'purple']])
    assert.equal(m.setColor(state, id, color), null, `${String(id)}/${String(color)}`);
  for (const id of ['integration_music', 'unknown_pill', '__proto__', 7, null])
    assert.equal(m.clearColor(state, id), null, String(id));
  assert.deepEqual(state.pillColors, {}, 'the inputs were never mutated');
});

// #435 T6.4 — persisted declared/blob order: a closed permutation gate plus an order()
// that honours the STORED declared order (main first) instead of the catalog index.
test('#435 reorderDeclared/reorderBlobs are closed permutation gates; order() honours the stored declared order', () => {
  const m = M();
  const state = m.normalize({ declaredPills: ['integration_notion', 'agent_amp', 'ai_google'] });
  // main first, then the STORED order — not the catalog index
  assert.deepEqual(m.visible(state).map(x => x.id), [ids[0], 'integration_notion', 'agent_amp', 'ai_google']);
  // a valid permutation reorders and keeps the rest of the state
  assert.deepEqual(m.reorderDeclared(state, ['agent_amp', 'ai_google', 'integration_notion']),
    { mainPill: ids[0], declaredPills: ['agent_amp', 'ai_google', 'integration_notion'], pillColors: {} });
  // an empty list is its own (valid) permutation
  const empty = m.normalize({ declaredPills: [] });
  assert.deepEqual(m.reorderDeclared(empty, []), { mainPill: ids[0], declaredPills: [], pillColors: {} });
  // refusals: not exactly a permutation of the currently declared ids
  for (const order of [['agent_amp', 'agent_amp', 'ai_google'], ['agent_amp', 'ai_google'],
    ['agent_amp', 'ai_google', 'integration_notion', 'integration_resend'],
    ['agent_amp', 'ai_google', 'unknown'], ['agent_amp', 'ai_google', 7],
    ['agent_amp', 'ai_google', null], 'agent_amp', 7, null, [], undefined])
    assert.equal(m.reorderDeclared(state, order), null, JSON.stringify(order));
  assert.deepEqual(state.declaredPills, ['integration_notion', 'agent_amp', 'ai_google'], 'the input was never mutated');
  // custom blobs: the same gate over the stored names (exact, case-sensitive)
  const blobs = m.normalize({ customBlobs: [{ name: 'Dev', color: 'green' }, { name: 'Notas' }] });
  assert.deepEqual(m.reorderBlobs(blobs, ['Notas', 'Dev']).blobs.map(b => b.name), ['Notas', 'Dev']);
  assert.equal(m.reorderBlobs(blobs, ['Notas', 'Dev']).blobs[1].color, 'green', 'the entries are the same, only reordered');
  for (const order of [['dev', 'Notas'], ['Notas', 'Dev', 'Dev'], ['Notas'], ['Notas', 7], null, 'Notas', []])
    assert.equal(m.reorderBlobs(blobs, order), null, JSON.stringify(order));
  assert.deepEqual(blobs.blobs.map(b => b.name), ['Dev', 'Notas'], 'the input was never mutated');
});
