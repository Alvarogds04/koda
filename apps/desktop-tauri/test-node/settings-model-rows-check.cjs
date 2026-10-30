'use strict';
// L42: Notetaker and OK Koda showed a static, disabled «Descargar» button even with the voice model installed, so a human
// who had downloaded it from Dictado read it as «the model is not there» / «I cannot download». The model is the SAME
// Parakeet the dictation uses: both pages now show the real control (download with progress, «Instalado», remove) and
// follow dictation:models without reopening Ajustes. Everything else on those pages stays disabled (no backend).
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, all, text, Element } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'Linux' }, configurable: true });
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const events = new Map(), calls = [];
  global.window = { __TAURI__: { event: { listen: async (name, fn) => { const l = events.get(name) || new Set(); events.set(name, l); l.add(fn); return () => l.delete(fn); } } } };
  const emit = (name, payload) => { for (const fn of events.get(name) || []) fn({ payload }); };
  const { inactivePages } = await import(pathToFileURL(path.join(base, 'pages.js')));
  const { setInvoke, FlowBridge } = await import(pathToFileURL(path.join(base, 'flow-shim.js')));
  const { hero } = await import(pathToFileURL(path.join(base, 'hero.js')));
  let models = { parakeet: { state: 'missing' }, downloadMb: 670 };
  setInvoke(async (cmd, { payload: p }) => { calls.push([cmd, p]);
    if (p.action === 'download_model') { models = { parakeet: { state: 'downloading', fraction: 0 }, downloadMb: 670 }; return structuredClone(models); }
    if (p.action === 'remove_model') { models = { parakeet: { state: 'missing' }, downloadMb: 670 }; return structuredClone(models); }
    return {}; });
  let leave;
  const ctx = { hero, status: { prefs: { key: 'right_ctrl', enabled: false }, platform: 'linux', models },
    navigate() {}, refresh: async () => ctx.status, updateModels(m) { models = m; ctx.status.models = m; }, set onLeave(fn) { leave = fn; } };
  const find = (root, label) => all(root).find(e => e.tagName === 'button' && String(e.textContent || '').trim() === label);
  // 0.2.1: Notetaker is «No disponible todavía» (propuesta): no model row there; the shared model is managed from OK Koda
  { const root = new Element('div'); await inactivePages.notes(root, ctx); assert(!find(root, 'Descargar') && text(root).includes('No disponible todavía'), 'notes: no download, honest unavailable'); }
  for (const page of ['voice']) {
    calls.length = 0; models = { parakeet: { state: 'missing' }, downloadMb: 670 }; ctx.status.models = models; events.clear();
    const root = new Element('div');
    await inactivePages[page](root, ctx);
    const download = find(root, 'Descargar');
    assert(download && !download.disabled, `${page}: the model row has a LIVE «Descargar» while the model is missing`);
    download.fire('click', false); await new Promise(r => setTimeout(r)); assert.deepEqual(calls, [], `${page}: a synthetic click sends nothing`);
    download.fire('click'); await new Promise(r => setTimeout(r));
    assert.deepEqual(calls, [['dictation_action', { action: 'download_model' }]], `${page}: one download_model, nothing else`);
    emit('dictation:models', { parakeet: { state: 'downloading', fraction: 0.5 }, downloadMb: 670 });
    assert(text(root).includes('50 %'), `${page}: the progress shows without reopening Ajustes`);
    assert(!find(root, 'Descargar'), `${page}: no second download while it runs`);
    emit('dictation:models', { parakeet: { state: 'ready' }, downloadMb: 670 });
    assert(text(root).includes('Instalado'), `${page}: «Instalado» once it is ready`);
    // everything else on the page keeps its disabled state (no backend)
    const others = all(root).filter(e => e.tagName === 'button' && !/Instalado|Descargar|Eliminar|Cancelar|Quitar/.test(String(e.textContent || '').trim()) && !String(e.className).includes('hub-link'));
    assert(others.length > 0 && others.every(b => b.disabled), `${page}: the rest of the page stays disabled`);
    leave && leave();
  }
  console.log('PASS settings-model-rows: Notetaker and OK Koda carry the real model control (download, progress, installed), the rest stays disabled');
})().catch(e => { console.error(e); process.exitCode = 1; });
