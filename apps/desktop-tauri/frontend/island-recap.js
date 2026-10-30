'use strict';
/* S10 (L30) — the weekly recap card of the island, as Coucou's views/recap.ts + recap/recap.ts. The DOM and the numbers'
   presentation are the vendored Coucou modules (vendor/coucou/views/recap.js, recap/summary.js, MIT); THIS file feeds them
   from Abito's closed host verb `recap_action` and decides when the card shows, exactly as Coucou's controller does:
     - on its own once a week: Monday from 8 am, the human has the history on (`prefs.enabled`), this week not shown yet
       (`lastShownWeek`), last week had something to show, and the island is calm (overview, nothing waiting on the human);
       it never wakes a hidden island, and `mark_shown` is sent when it appears;
     - `window.AbitoIslandRecap.open()` shows it on demand, even for an empty week (Coucou's tray «Weekly recap»).
   The share image (drawn with Mochi on a canvas) is not part of Abito; the card says so on its own button.
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandRecap = Object.freeze({ ...api, open: () => (root.__abitoRecapOpen ? root.__abitoRecapOpen() : Promise.resolve(false)) });
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const WEEK = /^\d{4}-\d{2}-\d{2}$/;
  /** The recap prefs of `recap_action prefs`; anything off-shape = the history is OFF (never auto-opens). */
  function prefsView(raw) {
    return isObject(raw) && raw.enabled === true && typeof raw.lastShownWeek === 'string' && (raw.lastShownWeek === '' || WEEK.test(raw.lastShownWeek))
      ? { enabled: true, lastShownWeek: raw.lastShownWeek } : { enabled: false, lastShownWeek: '' };
  }
  const turnOk = t => isObject(t) && typeof t.agent === 'string' && typeof t.project === 'string' && num(t.start) && num(t.end)
    && ['filesChanged', 'linesAdded', 'linesRemoved', 'commandsRun', 'questions'].every(k => num(t[k]) && t[k] >= 0);
  const decisionOk = d => isObject(d) && typeof d.agent === 'string' && num(d.date) && typeof d.decision === 'string';
  /** The `view` answer → the history the summary reads, or null. Rows that are off-shape are dropped, never repaired. */
  function historyView(raw) {
    if (!isObject(raw) || !Array.isArray(raw.turns) || !Array.isArray(raw.decisions)) return null;
    return { turns: raw.turns.filter(turnOk).slice(0, 20000), decisions: raw.decisions.filter(decisionOk).slice(0, 20000), prefs: prefsView(raw.prefs) };
  }
  /** Calm: the overview itself, nothing waiting on the human, nothing covering it. */
  function calm(d) {
    return !!d && d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices';
  }
  const SHOW_DELAY_MS = 1500; // Coucou: so it never lands on top of the event that triggered it
  return { prefsView, historyView, calm, SHOW_DELAY_MS };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const capsule = doc.getElementById('capsule');
  const island = doc.getElementById('island');
  if (!capsule || !island) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  if (!invoke || label === 'settings') return;

  let mod = null, summary = null, open = false, checking = false, checkedDay = '';
  const host = doc.createElement('div'); host.id = 'recap-card'; host.hidden = true; host.inert = true;
  host.setAttribute('role', 'group'); host.setAttribute('aria-label', 'Resumen semanal');
  island.append(host);
  const send = payload => invoke('recap_action', { payload });

  function paint() {
    const show = open && !!mod && api.calm(capsule.dataset);
    host.hidden = !show; host.inert = !show;
    doc.dispatchEvent(new CustomEvent('abito:recap', { detail: { show } })); // island.js grows to Coucou's 184px recap island
    if (show) capsule.dataset.recap = 'on'; else delete capsule.dataset.recap;
  }
  function close() { open = false; paint(); }
  function draw() { host.replaceChildren(mod.recap.buildRecapCard(summary, close)); }
  async function load(now) {
    const start = mod.summary.previousWeekStart(now);
    const history = api.historyView(await send({ action: 'view', since: Math.max(0, Math.floor(start.getTime() / 1000)) }));
    summary = history ? mod.summary.summarize(history, start) : null;
    return { summary, history };
  }
  /** Coucou's `check`: only on Monday from 8 am, once a week, with something to show, when calm. */
  async function check(now = new Date()) {
    if (checking || !mod || !mod.summary.shouldAutoShow(now, '') || !api.calm(capsule.dataset)) return;
    const day = mod.summary.dayKey(now);
    if (checkedDay === day) return; // the clock and the prefs are asked once a day at most; a later calm moment retries only after a refusal
    checking = true;
    try {
      const prefs = api.prefsView(await send({ action: 'prefs' }));
      if (!prefs.enabled || !mod.summary.shouldAutoShow(now, prefs.lastShownWeek)) { checkedDay = day; return; }
      const loaded = await load(now);
      if (!loaded.summary) { checkedDay = day; return; }
      checkedDay = day;
      const week = mod.summary.dayKey(mod.summary.mondayOf(now));
      setTimeout(() => {
        if (!api.calm(capsule.dataset)) { checkedDay = ''; return; } // not calm any more: ask again at the next calm moment
        draw(); open = true; paint();
        send({ action: 'mark_shown', week }).catch(() => {});
      }, api.SHOW_DELAY_MS);
    } catch { /* the recap is optional: a failed read shows nothing */ } finally { checking = false; }
  }
  root.__abitoRecapOpen = async () => {
    if (!mod) return false;
    try { await load(new Date()); draw(); open = true; paint(); return true; } catch { return false; }
  };

  Promise.all([import('./vendor/coucou/recap/summary.js'), import('./vendor/coucou/views/recap.js')]).then(([summaryMod, recapMod]) => {
    mod = { summary: summaryMod, recap: recapMod };
    const react = () => { if (open && !api.calm(capsule.dataset)) close(); else paint(); check(); };
    if (typeof MutationObserver !== 'undefined') new MutationObserver(react).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
    doc.addEventListener('visibilitychange', react);
    check();
  }).catch(() => {});
}
