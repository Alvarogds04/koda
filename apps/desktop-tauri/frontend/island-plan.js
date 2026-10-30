'use strict';
/* S10 (L30) — plan usage in the island header, as Coucou's views/usage.ts: a Claude pill (and a Codex pill) before the gear
   and the card that replaces the overview's left card while a pill is open. The DOM and the numbers' presentation are the
   vendored Coucou modules (vendor/coucou/views/usage.js, core/plan.js, MIT); THIS file only feeds them from Abito's closed
   host verbs and decides when they show:
     - Claude pill: only when the human turned `showPlanInNotch` on (Ajustes → Agentes). Its numbers come from `plan_action`
       {action:'claude'} (the status-line channel file); `available:false` → no numbers, never a guess.
     - Codex pill: only when the prefs view carries `showCodexPlanInNotch: true` (the human's explicit opt-in). Its numbers come
       from `plan_action {action:'codex'}`, asked at most once a minute and only while the pill is on screen: asking Codex
       spawns the user's own `codex app-server`, so nothing is ever asked while the pref is off.
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandPlan = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = v => typeof v === 'number' && Number.isFinite(v);
  /** Which pills the prefs allow. Anything but a literal `true` is off. */
  function pillsView(prefs) {
    const p = isObject(prefs) ? prefs : {};
    return { claude: p.showPlanInNotch === true, codex: p.showCodexPlanInNotch === true };
  }
  const windowOf = w => (isObject(w) && num(w.usedPct) && w.usedPct >= 0 && w.usedPct <= 100 && num(w.resetsAt) && w.resetsAt > 0
    ? { usedPct: w.usedPct, resetsAt: w.resetsAt } : null);
  /** `plan_action {action:'claude'}` answer → PlanUsage, or null (unavailable, or anything off-shape). Never invents a number. */
  function claudeUsage(answer) {
    if (!isObject(answer) || answer.available !== true || !num(answer.updatedAt)) return null;
    const fiveHour = windowOf(answer.fiveHour), sevenDay = windowOf(answer.sevenDay);
    if (!fiveHour && !sevenDay) return null;
    const usage = { updatedAt: answer.updatedAt };
    if (fiveHour) usage.fiveHour = fiveHour;
    if (sevenDay) usage.sevenDay = sevenDay;
    return usage;
  }
  /** Whether the island shows the pills now: the overview itself, nothing waiting on the human, nothing covering it. */
  function onOverview(d) {
    return !!d && d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices';
  }
  const CLAUDE_POLL_MS = 30000;   // the channel file changes with every Claude Code update; 30 s is plenty for a gauge
  const CARD_TICK_MS = 30000;     // Coucou re-renders the open card every 30 s for the countdowns
  const CODEX_STALE_MS = 60000;   // Coucou: a Codex answer stays good for a minute
  return { pillsView, claudeUsage, onOverview, CLAUDE_POLL_MS, CARD_TICK_MS, CODEX_STALE_MS };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const capsule = doc.getElementById('capsule');
  const actions = doc.querySelector('#island-header .header-actions');
  const overview = doc.getElementById('overview-view');
  const leftCard = overview && overview.querySelector('.card-left');
  if (!capsule || !actions || !leftCard) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!invoke || label === 'settings') return;

  let usage = null, model = null, card = null, claudePill = null, codexPill = null, pills = null, prefs = {}, codexAt = 0, codexBusy = false;
  let pollTimer = null, cardTimer = null;

  const shown = () => api.onOverview(capsule.dataset) && !doc.hidden;
  function closeCard() { if (model) model.showingPlanDetail = false; }
  function paint() {
    if (!usage) return;
    const want = api.pillsView(prefs), visible = shown();
    const claudeOn = want.claude && visible, codexOn = want.codex && visible;
    claudePill.el.style.display = claudeOn ? '' : 'none';
    codexPill.el.style.display = codexOn ? '' : 'none';
    pills.classList.toggle('on', claudeOn || codexOn);
    actions.classList.toggle('both-plans', claudeOn && codexOn);
    if (claudeOn) claudePill.sync();
    if (codexOn) codexPill.sync();
    // a card whose pill is gone (or whose view left the overview) closes, as in Coucou
    if (model.showingPlanDetail && !(model.planDetailIsCodex ? codexOn : claudeOn)) closeCard();
    const open = model.showingPlanDetail;
    if (open) card.sync();
    leftCard.classList.toggle('has-plan', open);
    card.el.hidden = !open;
    if (open) overview.dataset.plan = 'on'; else delete overview.dataset.plan;
    schedule(claudeOn, open);
  }
  function askClaude() {
    invoke('plan_action', { payload: { action: 'claude' } }).then(answer => { model.planUsage = api.claudeUsage(answer); paint(); }, () => { model.planUsage = null; paint(); });
  }
  function askCodex() {
    if (codexBusy || (Date.now() - codexAt < api.CODEX_STALE_MS && model.codexPlanUsage)) return;
    codexBusy = true;
    invoke('plan_action', { payload: { action: 'codex' } }).then(answer => {
      codexAt = Date.now();
      const parsed = answer && answer.available === true ? usage.parseCodexPlan(answer) : null;
      model.codexPlanUsage = parsed; paint();
    }, () => {}).finally(() => { codexBusy = false; });
  }
  function schedule(claudeOn, open) {
    if (claudeOn && !pollTimer) { askClaude(); pollTimer = setInterval(askClaude, api.CLAUDE_POLL_MS); }
    else if (!claudeOn && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (open && !cardTimer) cardTimer = setInterval(paint, api.CARD_TICK_MS);
    else if (!open && cardTimer) { clearInterval(cardTimer); cardTimer = null; }
  }

  import('./vendor/coucou/core/plan.js').then(plan => import('./vendor/coucou/views/usage.js').then(view => {
    usage = { parseCodexPlan: plan.parseCodexPlan };
    model = view.newPlanModel();
    const onToggle = () => { if (model.showingPlanDetail && model.planDetailIsCodex) askCodex(); paint(); };
    claudePill = view.buildPlanPill(model, false, onToggle);
    codexPill = view.buildPlanPill(model, true, onToggle);
    pills = doc.createElement('div'); pills.className = 'plan-pills';
    pills.append(claudePill.el, codexPill.el);
    actions.insertBefore(pills, actions.firstChild);
    card = new view.PlanCard(model);
    card.el.hidden = true; leftCard.append(card.el);
    claudePill.el.style.display = 'none'; codexPill.el.style.display = 'none';
    if (typeof MutationObserver !== 'undefined') new MutationObserver(paint).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
    doc.addEventListener('visibilitychange', paint);
    paint();
  })).catch(() => {});

  const apply = p => { prefs = isObject(p) ? p : {}; paint(); };
  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  invoke('prefs_action', { payload: { action: 'view' } }).then(apply, () => {});
  if (listen) listen('prefs:state', e => apply(e && e.payload)).catch(() => {});
}
