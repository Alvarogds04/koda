'use strict';
/* welcome-minikodas T3 (odd/tasks/welcome-minikodas.md S4/S5; design/koda-bienvenida/10-koda-botones-a-los-lados.html, comment m8eankv9).
   The Minikodas the engine lists become discs in the island's apps row (the right column of the Inicio). Read-only end to end:
   - it asks with the closed `minikodas_list` (agent_action, no fields) and listens to `agent:state`, where the Rust client folds the daemon's `minikodas`
     frame (id, name, status, running, lastRun.outcome — nothing else ever reaches the page);
   - one disc per minikoda through the row's own contract, AbitoShortcuts.registerCard; the row draws, orders, caps (15 discs) and wraps them;
   - a click opens a READ-ONLY card: name, state and how the last run ended. There is no button in it and no command behind it: launching a Minikoda
     could spend a model and is out of scope (S5). Everything is drawn with textContent. */
(function () {
  const S = window.AbitoShortcuts, doc = document;
  if (!S || typeof S.registerCard !== 'function') return;
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  const STATUS = { draft: 'Borrador: todavía no corre solo', active: 'Activo' };
  const LAST = { done: 'La última vez terminó bien', failed: 'La última vez falló' };
  const regs = new Map(); // card id -> { sig, off }
  // the row's ids are [a-z0-9-], at most 32, and never collide with the apps' own (gmail, github…): a prefix and a cap
  const cardId = id => (/^mk-/.test(id) ? id : 'mk-' + id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);

  function mountFor(mk) {
    return host => {
      const box = doc.createElement('div');
      box.className = 'mk-card';
      const add = (cls, text) => { const p = doc.createElement('p'); p.className = cls; p.textContent = text; box.append(p); };
      add('mk-name', mk.name);
      add('mk-state', mk.running ? 'Corriendo ahora' : (STATUS[mk.status] || ''));
      const last = mk.lastRun && LAST[mk.lastRun.outcome];
      if (last) add('mk-last', last);
      host.append(box);
      return () => box.remove();
    };
  }

  function sync(list) {
    const want = new Map();
    for (const mk of list) {
      if (!mk || typeof mk !== 'object' || typeof mk.id !== 'string' || typeof mk.name !== 'string' || !mk.name.trim()) continue;
      want.set(cardId(mk.id), mk);
    }
    for (const [cid, reg] of regs) if (!want.has(cid)) { reg.off(); regs.delete(cid); }
    for (const [cid, mk] of want) {
      const sig = [mk.name, mk.status, mk.running === true, mk.lastRun && mk.lastRun.outcome].join('|');
      const had = regs.get(cid);
      if (had && had.sig === sig) continue;
      if (had) { had.off(); regs.delete(cid); }
      try { regs.set(cid, { sig, off: S.registerCard({ id: cid, label: mk.name, icon: 'app', available: () => true, mount: mountFor(mk) }) }); }
      catch { /* an id the row refuses is simply not drawn */ }
    }
  }

  const apply = view => { const m = view && typeof view === 'object' ? view.minikodas : null; if (m && Array.isArray(m.items)) sync(m.items); };
  let askedAt = 0;
  function ask() {
    if (!invoke) return;
    const now = Date.now();
    if (now - askedAt < 4000) return;
    askedAt = now;
    try { invoke('agent_action', { payload: { action: 'minikodas_list' } }).then(apply, () => {}); } catch { /* optional bridge */ }
  }
  if (listen) listen('agent:state', ev => {
    const p = ev && ev.payload;
    if (!p) return;
    apply(p);
    if (p.minikodas == null && p.connection === 'connected') ask(); // connected but never answered: ask once (throttled)
  }).catch(() => {});
  ask();
})();
