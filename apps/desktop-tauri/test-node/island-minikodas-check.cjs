'use strict';
/* welcome-minikodas T3 (odd/tasks/welcome-minikodas.md S4/S5): the minikodas the engine lists become discs in the island's apps row (the right column of the
   Inicio). The page asks with the read-only `minikodas_list`, listens to `agent:state`, draws one disc per minikoda with its name, and a click opens a
   READ-ONLY card (name, state, how the last run ended): it never launches, creates or deletes anything. Real DOM, real layout, real click. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-minikodas-check: no playwright — NOT a pass'); process.exit(0); }
const MK = [
  { id: 'mk-correo', name: 'Correo del lunes', status: 'active', running: false, lastRun: { outcome: 'done' } },
  { id: 'mk-gastos', name: 'Gastos', status: 'draft', running: false },
];
const discs = r => r.page.evaluate(() => [...document.querySelectorAll('#nusa-apps button:not(.talk)')].map(b => b.getAttribute('data-tip') || b.getAttribute('title')));
(async () => {
  const r = await H.open({ sessions: [], engine: 'ok', minikodas: MK });
  try {
    await r.page.waitForTimeout(1200);
    assert.deepEqual(await discs(r), ['Correo del lunes', 'Gastos'], 'S4: one disc per minikoda the engine lists, with its name');
    const asked = await r.page.evaluate(() => (window.__allCalls || []).filter(c => c.cmd === 'agent_action').map(c => c.payload && c.payload.action));
    assert.ok(asked.includes('minikodas_list'), 'the page asks with the read-only minikodas_list: ' + JSON.stringify(asked));
    // a real click opens the read-only card
    await r.page.click('#nusa-apps button[data-tip="Correo del lunes"]'); await r.page.waitForTimeout(400);
    const card = await r.page.evaluate(() => ({ app: document.getElementById('nusa').dataset.app || '', text: (document.getElementById('nusa-card') || {}).innerText || '', btns: [...document.querySelectorAll('#nusa-card button')].length }));
    assert.ok(card.app && /correo/.test(card.app), 'S4: the click focuses that minikoda: ' + JSON.stringify(card));
    assert.ok(card.text.includes('Correo del lunes') && /Activo/.test(card.text) && /terminó bien/.test(card.text), 'the card says its name, state and how the last run ended: ' + JSON.stringify(card.text));
    assert.equal(card.btns, 0, 'S5: the card has no button at all (nothing to launch, edit or delete)');
    // the engine changes the list: a minikoda goes away, another appears (agent:state push)
    await r.page.evaluate(() => window.__emit('agent:state', { connection: 'connected', accounts: [], minikodas: { items: [{ id: 'mk-nuevo', name: 'Nuevo', status: 'draft', running: true }], truncated: false } }));
    await r.page.waitForTimeout(600);
    assert.deepEqual(await discs(r), ['Nuevo'], 'the row follows the engine: removed ones go, new ones come');
    const calls = await r.page.evaluate(() => (window.__allCalls || []).filter(c => c.cmd === 'agent_action').map(c => c.payload && c.payload.action));
    assert.ok(!calls.some(a => /minikoda_(run|create|launch|delete|approve)|minikodas_(run|create)/.test(String(a))), 'S5: nothing but the read-only list is ever asked: ' + JSON.stringify(calls));
  } finally { await r.close(); }
  console.log('island-minikodas-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
