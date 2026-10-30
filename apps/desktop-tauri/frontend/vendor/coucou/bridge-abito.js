// Abito-owned adapter; not upstream core/bridge.ts. Only closed prefs_action IPC.
import { DEFAULT_SETTINGS } from './core/state.js';
import { PILL_PALETTE } from './core/pill-colors.js';
const writable = new Set(['soundEnabled', 'soundVolume', 'autoCloseInterval', 'openOnHover', 'screen', 'mainPill', 'activeIntegrations', 'pillColors']);
const equal = (a, b) => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
};
const check = (ok, field) => { if (!ok) throw new Error(`${field}: valor inválido en Koda`); };
function project(p) {
  check(p && typeof p.sound === 'boolean' && typeof p.gain === 'number' && Array.isArray(p.declaredPills) && p.pillColors && typeof p.pillColors === 'object', 'prefs_action/view');
  return { ...structuredClone(DEFAULT_SETTINGS), soundEnabled: p.sound, soundVolume: p.gain,
    autoCloseInterval: p.autoCloseSeconds, openOnHover: p.openOnHover,
    screen: p.monitor ?? 'primary', mainPill: p.mainPill,
    activeIntegrations: [...p.declaredPills], pillColors: { ...p.pillColors } };
}
export function createBridge(invoke) {
  let current = null, queue = Promise.resolve();
  const send = payload => invoke('prefs_action', { payload });
  async function boot() {
    current = null; // A failed read must never leave a usable stale snapshot.
    current = project(await send({ action: 'view' }));
    return structuredClone(current);
  }
  async function save(next) {
    if (!current) await boot();
    // Preflight the ENTIRE object before the first write, including unknown fields.
    for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
      if (!writable.has(key) && !equal(current[key], next[key])) throw new Error(`${key}: no disponible en Koda`);
    }
    check(typeof next.soundEnabled === 'boolean', 'soundEnabled');
    check(typeof next.soundVolume === 'number' && Number.isFinite(next.soundVolume) && next.soundVolume >= 0 && next.soundVolume <= 0.2, 'soundVolume');
    // Both upstream generalSection and Abito use seconds, NOT milliseconds.
    check(Number.isInteger(next.autoCloseInterval) && (next.autoCloseInterval === 0 || next.autoCloseInterval >= 5 && next.autoCloseInterval <= 120), 'autoCloseInterval');
    check(typeof next.openOnHover === 'boolean', 'openOnHover');
    check(typeof next.screen === 'string' && next.screen.trim() === next.screen && next.screen.length > 0, 'screen');
    if (next.screen !== current.screen && (next.screen === 'cursor' || next.screen.startsWith('at:'))) throw new Error('screen dinámico/geometría: no disponible en Abito; se requiere un nombre de monitor');
    check(typeof next.mainPill === 'string', 'mainPill');
    check(Array.isArray(next.activeIntegrations) && next.activeIntegrations.every(id => typeof id === 'string') && new Set(next.activeIntegrations).size === next.activeIntegrations.length, 'activeIntegrations');
    check(next.pillColors && typeof next.pillColors === 'object' && !Array.isArray(next.pillColors) && Object.values(next.pillColors).every(c => PILL_PALETTE.includes(c)), 'pillColors');
    const actions = [];
    if (next.soundEnabled !== current.soundEnabled) actions.push({ action: next.soundEnabled ? 'sound_on' : 'sound_off' });
    if (next.soundVolume !== current.soundVolume) actions.push({ action: 'set_sound_gain', gain: next.soundVolume });
    if (next.autoCloseInterval !== current.autoCloseInterval || next.openOnHover !== current.openOnHover) actions.push({ action: 'set_island_interaction', auto_close_seconds: next.autoCloseInterval, open_on_hover: next.openOnHover });
    if (next.screen !== current.screen) actions.push(next.screen === 'primary' ? { action: 'clear_monitor' } : { action: 'set_monitor', monitor: next.screen });
    const mainChanged = next.mainPill !== current.mainPill;
    if (mainChanged) actions.push({ action: 'set_main_pill', id: next.mainPill });
    // Rust removes the new main from declared pills. Account for that side effect;
    // remove old members before additions so replacing a full list cannot overflow.
    const declared = current.activeIntegrations.filter(id => !mainChanged || id !== next.mainPill);
    for (const id of declared.filter(id => !next.activeIntegrations.includes(id))) actions.push({ action: 'toggle_declared_pill', id });
    for (const id of next.activeIntegrations.filter(id => !declared.includes(id))) actions.push({ action: 'toggle_declared_pill', id });
    for (const id of new Set([...Object.keys(current.pillColors), ...Object.keys(next.pillColors)])) {
      if (next.pillColors[id] !== current.pillColors[id]) actions.push(Object.hasOwn(next.pillColors, id) ? { action: 'set_pill_color', id, color: next.pillColors[id] } : { action: 'clear_pill_color', id });
    }
    try {
      for (const action of actions) current = project(await send(action));
    } catch (error) {
      try { await boot(); } catch (resyncError) { throw new AggregateError([error, resyncError], 'Koda: guardado y resincronización fallaron'); }
      throw error;
    }
    return structuredClone(current);
  }
  // Serialize reads/writes and snapshot caller-owned objects before waiting.
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  return Object.freeze({ boot: () => serial(boot), saveSettings: next => { const snapshot = structuredClone(next); return serial(() => save(snapshot)); } });
}
