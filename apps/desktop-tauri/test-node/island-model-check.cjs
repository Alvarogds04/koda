'use strict';
// 0.2.1 Ajustes T2 (HIGH RISK, S1/S3): ONE «En la isla» model over declaredPills + islandAgents. Nothing is migrated: both stored keys keep
// their own order and their own commands; the model is a pure read. Parent decision: no new stored key, pills first, specialists after, cap 3.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const f = file => require(path.join(__dirname, '../frontend', file));
const P = f('pills.js'), S = f('specialists-view.js'), A = f('avatar-colors.js');
const rec = id => ({ id, name: `Esp ${id}`, instructions: 'x', model: null, space: '', spaces: [], permissions: [] });
const store = ids => ({ persisted: true, specialists: ids.map(rec), active: null });
const model = raw => P.islandModel(raw, S.agentsView(store(['a1', 'b2', 'c3', 'd4']), raw, A), 'linux');

// A pure stand-in for what the closed Rust commands do to the two stored keys (src/prefs.rs ToggleDeclaredPill / SetIslandAgents).
function apply(raw, cmd) {
  const next = JSON.parse(JSON.stringify(raw));
  if (cmd.action === 'toggle_declared_pill') {
    const cur = P.normalize(raw, 'linux').declaredPills;
    next.declaredPills = cur.includes(cmd.id) ? cur.filter(x => x !== cmd.id) : [...cur, cmd.id];
  } else next.islandAgents = cmd.order;
  return next;
}

test('old prefs (both keys) read as one model: everything ON in either stays ON, pills first then specialists, each in its own order', () => {
  const raw = { mainPill: 'agent_codex', declaredPills: ['agent_gemini', 'integration_github'], islandAgents: ['b2', 'a1'] };
  const m = model(raw);
  assert.deepEqual(m.pills.map(p => [p.id, p.on, p.main]), [['agent_codex', true, true], ['agent_gemini', true, false], ['integration_github', true, false]]);
  assert.deepEqual(m.specialists.map(s => [s.id, s.on]), [['b2', true], ['a1', true], ['c3', false], ['d4', false]]);
  assert.equal(m.specialistsOn, 2); assert.equal(m.specialistsMax, 3); assert.equal(m.specialistsFull, false);
});
test('absent islandAgents keeps the stored default (the first three on); a stored max of 3 is respected', () => {
  const m = model({ declaredPills: [] });
  assert.deepEqual(m.specialists.filter(s => s.on).map(s => s.id), ['a1', 'b2', 'c3']);
  assert.equal(m.specialistsFull, true);
  assert.deepEqual(model({ islandAgents: ['a1', 'b2', 'c3', 'd4'] }).specialistOrder, ['a1', 'b2', 'c3'], 'a hostile longer list is cut at 3');
  assert.equal(P.islandToggleCommand(m, 'specialist', 'd4', 'linux'), null, 'a fourth specialist is refused');
});
test('idempotent: reading the model, feeding its order back and reading again gives the same model', () => {
  const raw = { mainPill: 'integration_claude', declaredPills: ['agent_hermes', 'ai_google'], islandAgents: ['c3', 'a1'] };
  const m1 = model(raw);
  const again = model({ mainPill: m1.pills.find(p => p.main).id, declaredPills: m1.order, islandAgents: m1.specialistOrder });
  assert.deepEqual(again, m1);
});
test('round trip through the UI writes: toggle off then on rewrites the same keys byte for byte (no new key, no reorder of others)', () => {
  const raw = { sound: true, mainPill: 'agent_codex', declaredPills: ['agent_gemini', 'integration_github'], islandAgents: ['b2', 'a1'], customBlobs: [{ name: 'x', color: '' }] };
  let cur = raw;
  const ops = [['pill', 'integration_github'], ['pill', 'integration_github'], ['specialist', 'a1'], ['specialist', 'a1']];
  for (const [kind, id] of ops) cur = apply(cur, P.islandToggleCommand(model(cur), kind, id, 'linux'));
  // github re-added at the end (same position here); a1 re-added at the end (same position here): identical bytes.
  assert.equal(JSON.stringify(cur), JSON.stringify(raw));
  assert.deepEqual(Object.keys(cur), Object.keys(raw), 'no new stored key');
  // turning one OFF never touches the other list
  const off = apply(raw, P.islandToggleCommand(model(raw), 'pill', 'agent_gemini', 'linux'));
  assert.deepEqual(off.islandAgents, raw.islandAgents);
  const off2 = apply(raw, P.islandToggleCommand(model(raw), 'specialist', 'b2', 'linux'));
  assert.deepEqual(off2.declaredPills, raw.declaredPills);
});
test('refusals: main pill, unknown ids and unoffered pills produce no command', () => {
  const m = model({ mainPill: 'agent_codex', declaredPills: [] });
  assert.equal(P.islandToggleCommand(m, 'pill', 'agent_codex', 'linux'), null);
  assert.equal(P.islandToggleCommand(m, 'pill', 'nope', 'linux'), null);
  assert.equal(P.islandToggleCommand(m, 'specialist', 'zz', 'linux'), null);
  assert.equal(P.islandToggleCommand(m, 'other', 'a1', 'linux'), null);
  assert.deepEqual(P.islandToggleCommand(m, 'pill', 'agent_hermes', 'linux'), { action: 'toggle_declared_pill', id: 'agent_hermes' });
});
test('downgrade-safe: a stored Cursor main (no longer offered) still reads as main, and the model reads without a specialists store', () => {
  const m = P.islandModel({ mainPill: 'agent_cursor', declaredPills: ['agent_codex'] }, null, 'linux');
  assert.equal(m.pills[0].id, 'agent_cursor'); assert.deepEqual(m.specialists, []);
});
