'use strict';
// #503 T3 · S22 · 22 Voz / OK Koda → Opción A: a live status banner on top (icon + word) and three blocks:
// Activación (listen switch + sensitivity with its value and «Probar»), Respuestas, Privacidad (collapsible).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, all, text, dom, Element, base, load } = require('./settings-designs-check.cjs');

async function mount(over = {}) {
  dom();
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'Linux' }, configurable: true });
  const { voicePage } = await load('voice-page.js'); const { setInvoke } = await load('flow-shim.js'); const { hero } = await load('hero.js');
  const events = new Map(), calls = [];
  global.window = { __TAURI__: { event: { listen: async (name, fn) => { const l = events.get(name) || new Set(); events.set(name, l); l.add(fn); return () => l.delete(fn); } } } };
  let st = { prefs: { enabled: false, output: 'system', gender: 'female', sensitivity: 50 }, vad: { state: 'ready' }, parakeet: { state: 'ready' }, downloadMb: 1, listening: false, error: null, ...over };
  setInvoke(async (cmd, { payload: p }) => {
    calls.push([cmd, structuredClone(p)]);
    if (cmd === 'voice_action') { if (p.action === 'set_prefs') st = { ...st, prefs: { ...p.prefs }, listening: p.prefs.enabled && st.vad.state === 'ready' && st.parakeet.state === 'ready' }; return structuredClone(st); }
    return { parakeet: { state: 'ready' }, downloadMb: 700 };
  });
  const page = new Element('div');
  await voicePage(page, { hero, status: { prefs: { key: 'right_ctrl' }, platform: 'linux' }, navigate() {}, set onLeave(_) {} });
  const push = next => { st = { ...st, ...next }; for (const f of events.get('voice-model') || []) f({ payload: structuredClone(st) }); };
  return { page, calls, push, flush: () => new Promise(r => setImmediate(r)) };
}
const banner = page => all(page).find(e => e.attrs.id === 'voice-status');
const words = e => text(e).replace(/\s+/g, ' ').trim();
const cardTitles = page => all(page).filter(e => e.className === 'hub-label').map(words);

test('S22 Voz: the status banner is on top and says icon + word from the REAL state (listening, off, missing model, downloading, error)', async () => {
  const off = await mount(); assert(banner(off.page)); assert.equal(words(banner(off.page)), '○ Apagado');
  assert.equal(banner(off.page).attrs.role, 'status'); assert.equal(banner(off.page).attrs['aria-live'], 'polite');
  assert(all(banner(off.page)).some(e => e.className === 'state-ico' && e.attrs['aria-hidden'] === 'true'));
  const order = off.page.children.map(e => e.attrs?.id === 'voice-status' ? 'banner' : 'other'); assert.equal(order.indexOf('banner'), 1, 'right after the hero band, above every block');
  const on = await mount({ prefs: { enabled: true, output: 'system', gender: 'female', sensitivity: 50 }, listening: true }); assert.equal(words(banner(on.page)), '● Escuchando');
  const idle = await mount({ prefs: { enabled: true, output: 'system', gender: 'female', sensitivity: 50 }, listening: false }); assert.equal(words(banner(idle.page)), '… Activando');
  const missing = await mount({ vad: { state: 'missing' } }); assert.equal(words(banner(missing.page)), '✗ Falta descargar los modelos');
  const down = await mount({ vad: { state: 'downloading', fraction: .4 } }); assert.equal(words(banner(down.page)), '… Descargando modelos');
  const bad = await mount({ error: 'sin micrófono' }); assert.equal(words(banner(bad.page)), '✗ Error: sin micrófono');
  // live: the banner follows the pushed status
  off.push({ prefs: { enabled: true, output: 'system', gender: 'female', sensitivity: 50 }, listening: true }); assert.equal(words(banner(off.page)), '● Escuchando');
});

test('S22 Voz: blocks in the approved order: Activación first, then Modelo de voz (S5/L5) and Tu voz (S2), Respuestas, Privacidad last (collapsible, collapsed)', async () => {
  const { page } = await mount();
  // The original three blocks keep their relative order; the model picker (S5, L5: «en el mismo ajuste») and the
  // training (S2) sit between Activación and Respuestas. Activación stays first and Privacidad last.
  // 0.2.1 (L2 «OK Koda: A · Avanzado desplegable»): Activación and Respuestas first; the shared model, the language and the training sit in one fold
  assert.deepEqual(cardTitles(page), ['Activación', 'Respuestas', 'Reconocimiento', 'Entrenamiento', 'Privacidad']);
  assert(all(page).some(e => e.tagName === 'details' && e.attrs.id === 'voice-advanced'), 'the fold exists');
  assert.deepEqual(cardTitles(page).filter(t => ['Activación', 'Respuestas', 'Privacidad'].includes(t)), ['Activación', 'Respuestas', 'Privacidad']);
  assert.equal(all(page).filter(e => e.className === 'hub-card').length, 5);
  const act = all(page).find(e => e.className === 'hub-card');
  assert(text(act).includes('Escuchar « OK Koda »')); assert(text(act).includes('Parakeet, en tu ordenador')); assert(text(act).includes('Sensibilidad de « OK Koda »'));
  const privacy = all(page).find(e => e.tagName === 'details' && e.attrs.id === 'voice-privacy');
  assert(privacy, 'Privacidad is a real disclosure'); assert(!privacy.attrs.open, 'collapsed by default');
  assert(all(privacy).some(e => e.tagName === 'summary' && e.textContent === 'Privacidad'));
  assert(text(privacy).includes('Tu voz nunca sale de este ordenador') && text(privacy).includes('Koda nunca envía un correo'), 'both privacy notes are kept, only folded');
});

test('S22 Voz: sensitivity shows its numeric value live and «Probar» checks it locally without opening the microphone', async () => {
  const { page, calls, flush } = await mount({ prefs: { enabled: true, output: 'system', gender: 'female', sensitivity: 50 }, listening: true });
  const range = all(page).find(e => e.tagName === 'input' && e.attrs.type === 'range'), value = all(page).find(e => e.attrs.id === 'voice-sensitivity-value');
  assert.equal(value.textContent, '50 %'); assert.equal(range.attrs['aria-describedby'], 'voice-sensitivity-value');
  range.value = '80'; range.fire('input'); assert.equal(value.textContent, '80 %', 'the number follows the slider while dragging');
  assert.deepEqual(calls.filter(([c]) => c === 'voice_action' && true).filter(([, p]) => p.action === 'set_prefs'), [], 'dragging writes nothing; only the committed change does');
  calls.length = 0; range.fire('change', false); await flush(); assert.deepEqual(calls, [], 'synthetic change does nothing');
  range.fire('change'); await flush(); assert.deepEqual(calls.splice(0), [['voice_action', { action: 'set_prefs', prefs: { enabled: true, output: 'system', gender: 'female', sensitivity: 80 } }]]);
  const probe = all(page).find(e => e.tagName === 'button' && e.textContent === 'Consultar estado');
  assert(probe && !probe.disabled); probe.fire('click', false); await flush(); assert.deepEqual(calls, []);
  probe.fire('click'); await flush();
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'status' }]], 'a read of the status, nothing else: the microphone is never opened by a test');
  const result = all(page).find(e => e.attrs.id === 'voice-probe-result');
  assert(words(result).includes('Sensibilidad 80 %') && words(result).includes('Escuchando') && words(result).includes('No se abrió el micrófono'), words(result));
  // when it would not hear anything, it says why
  const off = await mount(); all(off.page).find(e => e.tagName === 'button' && e.textContent === 'Consultar estado').fire('click'); await off.flush();
  assert(words(all(off.page).find(e => e.attrs.id === 'voice-probe-result')).includes('Apagado'));
});

test('S22 Voz: every control and closed command that existed survives (switch, download/remove, output, sensitivity)', async () => {
  const { page, calls, flush } = await mount({ vad: { state: 'missing' }, parakeet: { state: 'missing' } });
  const sw = all(page).find(e => e.className.includes('switch')); sw.fire('click', false); await flush(); assert.deepEqual(calls.filter(([, p]) => p.action === 'set_prefs'), []);
  calls.length = 0; sw.fire('click'); await flush();
  assert.deepEqual(calls.splice(0), [['voice_action', { action: 'set_prefs', prefs: { enabled: true, output: 'system', gender: 'female', sensitivity: 50 } }]]);
  const dl = all(page).find(e => e.tagName === 'button' && e.textContent === 'Descargar'); assert(dl && !dl.disabled);
  assert.equal(all(page).filter(e => e.tagName === 'button' && ['Voz del sistema', 'ElevenLabs', 'Solo texto'].includes(e.textContent)).length, 3);
  const src = fs.readFileSync(path.join(base, 'voice-page.ts'), 'utf8');
  assert(!/innerHTML|setAttribute\('style|console\./.test(src));
});
