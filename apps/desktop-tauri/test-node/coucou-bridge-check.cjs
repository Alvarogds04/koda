'use strict';
// Node only: no document/window, IPC validates exact Rust payload shapes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const shapes = { view: [], sound_on: [], sound_off: [], set_sound_gain: ['gain'], set_island_interaction: ['auto_close_seconds', 'open_on_hover'], set_monitor: ['monitor'], clear_monitor: [], set_main_pill: ['id'], toggle_declared_pill: ['id'], set_pill_color: ['id', 'color'], clear_pill_color: ['id'] };
const rust = fs.readFileSync(path.join(root, 'src/prefs.rs'), 'utf8');
for (const action of Object.keys(shapes)) assert(rust.includes(`"${action}"`), `${action} removed from Rust`);
function fixture() {
  let view = { sound: true, gain: 0.12, autoCloseSeconds: 15, openOnHover: false, monitor: null, mainPill: 'integration_claude', declaredPills: ['agent_amp'], pillColors: {} };
  const calls = []; let fail = '', failView = false;
  const invoke = async (command, { payload: p }) => {
    assert.equal(command, 'prefs_action'); assert.deepEqual(Object.keys(p).sort(), ['action', ...shapes[p.action]].sort());
    calls.push(structuredClone(p));
    if (p.action === fail || (failView && p.action === 'view')) throw new Error('disk failed');
    switch (p.action) {
      case 'sound_on': view.sound = true; break;
      case 'sound_off': view.sound = false; break;
      case 'set_sound_gain': assert(typeof p.gain === 'number' && p.gain >= 0 && p.gain <= 0.2); view.gain = p.gain; break;
      case 'set_island_interaction': assert(Number.isInteger(p.auto_close_seconds) && (p.auto_close_seconds === 0 || p.auto_close_seconds >= 5 && p.auto_close_seconds <= 120)); view.autoCloseSeconds = p.auto_close_seconds; view.openOnHover = p.open_on_hover; break;
      case 'set_monitor': view.monitor = p.monitor; break;
      case 'clear_monitor': view.monitor = null; break;
      case 'set_main_pill': view.mainPill = p.id; view.declaredPills = view.declaredPills.filter(id => id !== p.id); break;
      case 'toggle_declared_pill': assert.notEqual(p.id, view.mainPill); view.declaredPills = view.declaredPills.includes(p.id) ? view.declaredPills.filter(id => id !== p.id) : [...view.declaredPills, p.id]; break;
      case 'set_pill_color': view.pillColors[p.id] = p.color; break;
      case 'clear_pill_color': delete view.pillColors[p.id]; break;
    }
    return structuredClone(view);
  };
  return { calls, invoke, fail: (action, read = false) => { fail = action; failView = read; } };
}
(async () => {
  const { createBridge } = await import(pathToFileURL(path.join(root, 'frontend/vendor/coucou/bridge-abito.js')));
  assert.equal(typeof createBridge, 'function');
  const f = fixture(), b = createBridge(f.invoke); let s = await b.boot();
  assert.equal(s.soundVolume, 0.12); assert.equal(s.autoCloseInterval, 15); assert.equal(s.screen, 'primary');
  f.calls.length = 0; await b.saveSettings(s); assert.deepEqual(f.calls, []);
  const changes = [
    [{ soundEnabled: false }, { action: 'sound_off' }], [{ soundEnabled: true }, { action: 'sound_on' }],
    [{ soundVolume: 0.2 }, { action: 'set_sound_gain', gain: 0.2 }],
    [{ autoCloseInterval: 0, openOnHover: true }, { action: 'set_island_interaction', auto_close_seconds: 0, open_on_hover: true }],
    [{ autoCloseInterval: 120 }, { action: 'set_island_interaction', auto_close_seconds: 120, open_on_hover: true }],
    [{ screen: 'DP-1' }, { action: 'set_monitor', monitor: 'DP-1' }], [{ screen: 'primary' }, { action: 'clear_monitor' }],
    [{ mainPill: 'agent_codex' }, { action: 'set_main_pill', id: 'agent_codex' }],
    [{ activeIntegrations: [] }, { action: 'toggle_declared_pill', id: 'agent_amp' }],
    [{ activeIntegrations: ['agent_amp'] }, { action: 'toggle_declared_pill', id: 'agent_amp' }],
    [{ pillColors: { agent_amp: '#2DD4BF' } }, { action: 'set_pill_color', id: 'agent_amp', color: '#2DD4BF' }],
    [{ pillColors: {} }, { action: 'clear_pill_color', id: 'agent_amp' }],
  ];
  for (const [delta, expected] of changes) { f.calls.length = 0; s = await b.saveSettings({ ...s, ...delta }); assert.deepEqual(f.calls, [expected]); }
  f.calls.length = 0;
  s = await b.saveSettings({ ...s, soundEnabled: false, soundVolume: 0, openOnHover: false, screen: 'HDMI-1' });
  assert.deepEqual(f.calls.map(p => p.action), ['sound_off', 'set_sound_gain', 'set_island_interaction', 'set_monitor']);
  for (const [key, value] of Object.entries({ autostart: true, language: 'es', shortcuts: { x: {} }, model: 'x', chatProvider: 'openai', chatModels: { x: 'y' }, ollamaUrl: 'x', lmstudioUrl: 'x', customUrl: 'x', planRelayInstalled: true, showPlanInNotch: true, showCodexPlanInNotch: true, hooksInstalled: true, phoneLink: true, phoneChat: true, phoneDetails: true, phoneChatModels: ['x'], mochiOutfit: 'x', absenceInterval: 30, unknown: true })) {
    f.calls.length = 0; await assert.rejects(b.saveSettings({ ...s, soundEnabled: true, [key]: value }), /no disponible en Koda/); assert.deepEqual(f.calls, []);
  }
  for (const delta of [{ soundVolume: 0.21 }, { soundVolume: NaN }, { soundVolume: '0.1' }, { autoCloseInterval: 4 }, { autoCloseInterval: 5.5 }, { autoCloseInterval: 121 }, { openOnHover: 1 }, { screen: '' }, { pillColors: { agent_amp: '#FFFFFF' } }]) {
    f.calls.length = 0; await assert.rejects(b.saveSettings({ ...s, ...delta })); assert.deepEqual(f.calls, []);
  }
  f.calls.length = 0; f.fail('set_sound_gain');
  await assert.rejects(b.saveSettings({ ...s, soundEnabled: true, soundVolume: 0.1 }), /disk failed/);
  assert.deepEqual(f.calls.map(p => p.action), ['sound_on', 'set_sound_gain', 'view']);
  f.fail(''); f.calls.length = 0; s = await b.saveSettings({ ...s, soundEnabled: true, soundVolume: 0.1 });
  assert.deepEqual(f.calls, [{ action: 'set_sound_gain', gain: 0.1 }]);
  f.calls.length = 0; s = await b.saveSettings({ ...s, mainPill: 'agent_amp', activeIntegrations: ['agent_codex'] });
  assert.deepEqual(f.calls, [{ action: 'set_main_pill', id: 'agent_amp' }, { action: 'toggle_declared_pill', id: 'agent_codex' }]);
  f.calls.length = 0; f.fail('set_sound_gain', true);
  await assert.rejects(b.saveSettings({ ...s, soundEnabled: false, soundVolume: 0.15 }));
  f.fail(''); f.calls.length = 0; await b.saveSettings({ ...s, soundEnabled: false, soundVolume: 0.15 });
  assert.equal(f.calls[0].action, 'view', 'failed resync requires boot before another diff');
  f.calls.length = 0; s = await b.boot(); f.calls.length = 0;
  const original = structuredClone(s);
  await Promise.all([b.saveSettings({ ...s, soundVolume: 0.05 }), b.saveSettings({ ...s, soundVolume: 0.05 })]);
  assert.deepEqual(f.calls, [{ action: 'set_sound_gain', gain: 0.05 }], 'concurrent saves serialize against the latest state');
  assert.deepEqual(s, original, 'caller snapshot not mutated');
  f.calls.length = 0; s = await b.boot(); f.calls.length = 0;
  await b.saveSettings({ ...s, activeIntegrations: ['agent_codex'], pillColors: { agent_amp: '#F4505E', agent_codex: '#2DD4BF' } });
  assert.deepEqual(f.calls, [{ action: 'set_pill_color', id: 'agent_amp', color: '#F4505E' }, { action: 'set_pill_color', id: 'agent_codex', color: '#2DD4BF' }]);
  f.calls.length = 0; s = await b.boot(); f.calls.length = 0;
  await b.saveSettings({ ...s, activeIntegrations: ['agent_cursor'], pillColors: { agent_amp: '#2DD4BF' }, autoCloseInterval: 5 });
  assert.deepEqual(f.calls, [{ action: 'set_island_interaction', auto_close_seconds: 5, open_on_hover: s.openOnHover }, { action: 'toggle_declared_pill', id: 'agent_codex' }, { action: 'toggle_declared_pill', id: 'agent_cursor' }, { action: 'set_pill_color', id: 'agent_amp', color: '#2DD4BF' }, { action: 'clear_pill_color', id: 'agent_codex' }]);
  const css = fs.readFileSync(path.join(root, 'frontend/vendor/coucou/settings/settings.css'), 'utf8');
  assert(!/url\s*\(|@import|@font-face/i.test(css));
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  assert([...css.matchAll(/var\((--[\w-]+)/g)].every(m => defined.has(m[1])), 'CSS tokens self-contained');
  console.log('PASS coucou-bridge: exact schemas, ordered diff, preflight, resync, only prefs_action');
})().catch(error => { console.error(error); process.exitCode = 1; });
