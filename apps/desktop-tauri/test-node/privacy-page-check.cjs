'use strict';
// #503 reportar fallos S4-S6: the Privacidad page. Closed failure_action contract, synthetic gestures never reach IPC,
// the editable text is what gets sent, nothing is sent until the human clicks «Reportar».
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, Element, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'Linux' }, configurable: true });
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { privacyPage } = await import(pathToFileURL(path.join(base, 'privacy-page.js')));
  const { hero } = await import(pathToFileURL(path.join(base, 'hero.js')));
  const FP = '3fa9c01b7d2e', calls = [];
  let st = { enabled: true, pending: [{ fingerprint: FP, process: 'island', step: 'voice-load', count: 2, at: 1 }] };
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, structuredClone(p)]);
    if (p.action === 'view') return structuredClone(st);
    if (p.action === 'preview') return { title: '[island] voice-load (3fa9c01b7d2e)', body: 'Error: load failed\nFingerprint: `3fa9c01b7d2e`', fingerprint: FP, searchUrl: 'https://github.com/Alvarogds04/abito/issues?q=x' };
    if (p.action === 'set_enabled') { st = { ...st, enabled: p.enabled }; return structuredClone(st); }
    if (['never', 'later'].includes(p.action)) { st = { ...st, pending: [] }; return structuredClone(st); }
    if (p.action === 'send') return { opened: true, copied: p.body.length > 5000 };
    throw new Error('unexpected');
  };
  const page = new Element('div');
  await privacyPage(page, { hero, navigate() {}, set onLeave(_) {} }, invoke);
  assert.deepEqual(calls.splice(0), [['failure_action', { action: 'view' }]], 'opening only reads');
  const btn = label => all(page).find(e => e.tagName === 'button' && e.textContent === label);
  assert(text(page).includes('Koda tuvo un problema. ¿Querés reportarlo?'));
  assert(btn('No volver a preguntar') && btn('Ahora no') && btn('Reportar un problema'));
  btn('Reportar').fire('click', false);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, [], 'synthetic gestures never invoke');
  btn('Reportar').fire('click');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.splice(0), [['failure_action', { action: 'preview', fingerprint: FP }]]);
  assert(text(page).includes('exactamente lo que se enviará'));
  const body = all(page).find(e => e.tagName === 'textarea');
  assert(body.value.includes('Error: load failed'));
  body.value = body.value + '\nMi comentario';
  assert.deepEqual(calls, [], 'previewing sends nothing');
  const send = all(page).filter(e => e.tagName === 'button' && e.textContent === 'Reportar').pop();
  send.fire('click');
  await new Promise(r => setImmediate(r));
  const sent = calls.splice(0);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], { action: 'send', title: '[island] voice-load (3fa9c01b7d2e)', body: body.value }, 'the EDITED text is what is sent');
  assert(text(page).includes('Se abrió GitHub'));
  // switch
  const sw = all(page).find(e => e.className.includes('switch'));
  sw.fire('click', false);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, []);
  sw.fire('click');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.splice(0), [['failure_action', { action: 'set_enabled', enabled: false }]]);
  assert(!text(page).includes('¿Querés reportarlo?'), 'switch off: no failure notice');
  // manual report is available regardless
  btn('Reportar un problema').fire('click');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.splice(0), [['failure_action', { action: 'preview' }]]);
  console.log('PASS privacy-page: preview=edit=send, gestures gated, switch hides notices, manual report');
})().catch(e => { console.error(e); process.exit(1); });
