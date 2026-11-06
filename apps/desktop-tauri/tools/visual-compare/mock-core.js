// Injected BEFORE the page scripts (Page.addScriptToEvaluateOnNewDocument).
// Provides Tauri's internals (invoke, callbacks, events) over a per-side handler.
// Reference tooling only: it never ships (see README).
(() => {
  const label = window.__VC_LABEL || 'main';
  const callbacks = new Map();
  const listeners = []; // {event, id, handler}
  let cid = 1, eid = 1;
  window.__vcUnmocked = [];
  const transformCallback = (cb) => { const id = cid++; callbacks.set(id, cb); return id; };
  const invoke = async (cmd, args) => {
    if (cmd === 'plugin:event|listen') { const id = eid++; listeners.push({ event: args.event, id, handler: args.handler }); return id; }
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd.startsWith('plugin:') && cmd !== 'plugin:event|emit') return null;
    const h = window.__VC_INVOKE;
    const r = h ? h(cmd, args || {}) : undefined;
    if (r === undefined) window.__vcUnmocked.push(cmd + ' ' + JSON.stringify(args || {}).slice(0, 80));
    if (r && r.__reject) throw r.__reject;
    return r === undefined ? null : r;
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label }, windows: [{ label }], webviews: [{ windowLabel: label, label }] },
    transformCallback, unregisterCallback: (id) => callbacks.delete(id), convertFileSrc: (p) => p, invoke,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__vcEmit = (event, payload) => {
    for (const l of listeners) if (l.event === event) { const cb = callbacks.get(l.handler); if (cb) cb({ event, id: l.id, payload }); }
  };
  window.__vcListeners = listeners;
  window.__vcCore = { callbacks, listeners };
  // Shared fixture that depends on the clock: the GitHub grid.
  window.__vcGithub = () => {
    const g = window.__VC_FIX.github, weeks = [];
    for (let w = 0; w < 30; w++) { const wk = []; for (let d = 0; d < 7; d++) { const n = (w * 7 + d * 3) % 9; wk.push({ date: `2026-0${1 + (w % 9)}-${String(1 + d).padStart(2, '0')}`, count: n, level: n === 0 ? 0 : Math.min(4, 1 + (n >> 1)), weekday: d }); } weeks.push(wk); }
    return { pulse: { login: g.login, myPRs: g.myPRs, toReview: g.toReview, mainCI: g.mainCI, fetchedAt: Date.now() }, activity: { total: 1234, weeks, fetchedAt: Date.now() }, totalRepos: g.totalRepos, totalStars: g.totalStars };
  };
})();
