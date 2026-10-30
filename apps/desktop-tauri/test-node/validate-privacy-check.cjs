'use strict';
// ajustes-privacy (#503 reportar fallos): the Privacidad switch persists to failure-prefs.json through `failure_action`, NOT to the prefs
// the generic hub scene snapshots (prefs/dictation/voice). The generic branch therefore waited for a change that could never show up
// («tiempo agotado: preferencia persistida privacy»). The scene must flip the switch, read the REAL answer of failure_action, and put the
// switch back as it found it. It must never press «Reportar» (that would open a browser).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function scene({ persists = true, startEnabled = true } = {}) {
  const calls = [], clicks = [];
  const host = { enabled: startEnabled, pending: [] };
  const el = (id, text = '', extra = {}) => ({ id, textContent: text, disabled: false, hidden: false, value: '', classList: { contains: () => true }, scrollIntoView() {}, closest: () => null,
    getBoundingClientRect: () => ({ x: 30, y: 0, width: 10, height: 10 }), ...extra });
  const tab = el('tab');
  const sw = el('sw', '', { className: 'switch' });
  const report = el('rep', 'Reportar un problema');
  const root = { textContent: 'Privacidad Avisos de fallos Avisarme cuando Abito tenga un problema Reporte manual y más texto para pasar el mínimo',
    scrollIntoView() {}, querySelector: sel => (sel === 'button,input,select,textarea' ? sw : sel.includes('.switch') ? sw : null),
    querySelectorAll: sel => (sel === 'button' ? [report] : [sw, report]) };
  let current = null;
  const window = { __validateOrigin: { x: 0, y: 0, scale: 1 }, __TAURI__: { core: { invoke: async (cmd, args) => {
      const action = args && args.payload && args.payload.action; calls.push([cmd, action]);
      if (cmd === 'failure_action') { if (action === 'view') return structuredClone(host); throw new Error('the scene may only read'); }
      if (cmd === 'prefs_action') return {}; if (cmd === 'dictation_action') return { prefs: {} }; if (cmd === 'voice_action') return { prefs: {} };
      return {}; } },
    event: { emit: async () => { clicks.push(1); if (!current) { current = root; return; } if (persists) host.enabled = !host.enabled; } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8'), {
    window, document: { querySelector: sel => (sel === '.hub-page' ? current : sel === '.hub-page .switch:not(:disabled)' ? sw : sel === '.hub-side .hub-item[data-page="privacy"]' ? tab : null), querySelectorAll: () => [tab], getElementById: () => null },
    addEventListener() {}, console: { error() {} }, performance, setTimeout: fn => { fn(); return 1; }, requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  let result, error;
  try { result = await window.AbitoValidate.hub(0, 'privacy'); } catch (e) { error = e; }
  return { result, error, calls, clicks, host };
}

(async () => {
  for (const startEnabled of [true, false]) {
    const ok = await scene({ startEnabled });
    assert(!ok.error, `the scene must pass when the switch persists (start ${startEnabled}): ${ok.error && ok.error.message}`);
    assert.equal(ok.result.ok, true, JSON.stringify(ok.result));
    assert(ok.calls.some(([c, a]) => c === 'failure_action' && a === 'view'), 'it reads the real failure_action state');
    assert.equal(ok.host.enabled, startEnabled, 'the switch is put back as the scene found it');
    assert(!ok.calls.some(([c, a]) => c === 'failure_action' && a !== 'view'), 'the scene only reads failure_action; the page itself does the writes');
    assert.equal(ok.clicks.length, 3, 'tab + switch + switch back; never «Reportar un problema»');
  }
  const broken = await scene({ persists: false });
  assert(broken.error && /privacy|aviso|fallo/i.test(broken.error.message), 'a switch that does not persist must FAIL the scene, not pass it');
  console.log('validate-privacy: 4 scene checks passed');
})().catch(e => { console.error(e); process.exit(1); });
