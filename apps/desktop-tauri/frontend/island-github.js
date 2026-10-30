'use strict';
/* S10 (L30) — the GitHub card of the island, as Coucou's views/github.ts: the pulse (my PRs, to review, default-branch CI)
   with its detail lists, and the contribution grid. The DOM and the numbers' presentation are the vendored Coucou modules
   (vendor/coucou/views/github.js, core/github.js, MIT); THIS file only feeds them from Abito's closed host verb
   `github_action {action:'refresh', section:'pulse'|'activity'}` (native keychain token first, existing `gh` session otherwise) and
   decides when the card shows: it takes the overview's left card while `integration_github` is focused, exactly where
   Coucou puts it when that pill is focused. Links open through the existing `open_chat_url` (re-validated in Rust).
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandGithub = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const PILL_ID = 'integration_github';
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** Discover GitHub only when declared; focusing its pill, not the chat target, opens the card. */
  const wantedIgnoringPause = prefs => isObject(prefs) && (prefs.mainPill === PILL_ID || (Array.isArray(prefs.declaredPills) && prefs.declaredPills.includes(PILL_ID)));
  // abito-pausa: integrations are paused in this version — no card, no polling (the stored prefs are kept)
  const pausedNow = () => { const P = typeof module === 'object' && module.exports ? require('./paused.js') : (typeof window !== 'undefined' ? window.AbitoPaused : null); return !!(P && P.paused('integrations')); };
  const wanted = prefs => !pausedNow() && wantedIgnoringPause(prefs);
  const REASONS = Object.freeze({
    gh_not_installed: 'Guardá una clave GitHub en Ajustes o instalá la CLI de GitHub (gh).',
    gh_not_signed_in: 'Revisá tu clave GitHub en Ajustes o iniciá sesión con «gh auth login».',
    gh_bad_answer: 'GitHub no respondió como se esperaba.',
  });
  /** An answer of `github_action` → what the card draws. Anything off-shape is «unavailable», never a guess. */
  function answerView(answer, section) {
    if (!isObject(answer)) return { kind: 'unavailable', note: REASONS.gh_bad_answer };
    if (answer.available !== true) return { kind: 'unavailable', note: REASONS[answer.reason] || REASONS.gh_bad_answer };
    if (section === 'pulse') {
      const p = answer.pulse;
      return isObject(p) && Array.isArray(p.myPRs) && Array.isArray(p.toReview) && Array.isArray(p.mainCI) && typeof p.login === 'string'
        ? { kind: 'pulse', data: p, ...(validStats(answer.stats) ? { stats: answer.stats } : {}) } : { kind: 'unavailable', note: REASONS.gh_bad_answer };
    }
    const a = answer.activity;
    return isObject(a) && Array.isArray(a.weeks) && typeof a.total === 'number' ? { kind: 'activity', data: a } : { kind: 'unavailable', note: REASONS.gh_bad_answer };
  }
  /** Only https/http links to github.com leave the page (Coucou's safeGitHubUrl, plus the host's own checks). */
  function safeUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
    let u; try { u = new URL(raw); } catch { return null; }
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname === 'github.com' && !u.username && !u.password ? u.href : null;
  }
  const validStats = s => isObject(s) && Number.isSafeInteger(s.totalStars) && s.totalStars >= 0 && Number.isSafeInteger(s.totalRepos) && s.totalRepos >= 0;
  function navigateDetail(key, selection, count) {
    if (key === 'Escape' || key === 'ArrowLeft') return { back: true };
    if (key === 'Enter') return selection !== null && selection < count ? { open: selection } : null;
    if (!count) return null;
    if (key === 'ArrowDown') return { selection: selection === null ? 0 : (selection + 1) % count };
    if (key === 'ArrowUp') return { selection: selection === null ? count - 1 : (selection + count - 1) % count };
    return null;
  }
  const POLL_MS = 60000; // the host caches the pulse for 60 s and the grid for 300 s; polling faster only hits the cache
  return { PILL_ID, REASONS, wanted, wantedIgnoringPause, answerView, safeUrl, navigateDetail, POLL_MS };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const capsule = doc.getElementById('capsule');
  const overview = doc.getElementById('overview-view');
  const leftCard = overview && overview.querySelector('.card-left');
  if (!capsule || !leftCard) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!invoke || label === 'settings') return;

  let view = null, prefs = {}, pulse = null, stats = null, selection = null, activity = null, note = '', detail = false, timer = null, inFlight = false;
  let focused = false, connected = false, rendered = null;
  function announce(on) {
    if (connected === on) return;
    connected = on;
    doc.dispatchEvent(new CustomEvent('abito:integration-seen', { detail: { source: 'github', ids: on ? [api.PILL_ID] : [] } }));
  }
  const host = doc.createElement('div'); host.className = 'gh-card'; host.style.pointerEvents = 'auto'; host.hidden = true; leftCard.append(host);
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices' && !doc.hidden;
  };
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

  function draw() {
    // Poll declared GitHub even before focus: otherwise its pill can never be discovered.
    schedule(api.wanted(prefs) && onScreen());
    const show = !!view && focused && api.wanted(prefs) && onScreen();
    host.hidden = !show;
    if (show) overview.dataset.github = 'on'; else delete overview.dataset.github;
    if (!show) { detail = false; rendered = null; return; }
    // Capsule hover/focus writes attributes even when the values are unchanged.
    // Never detach a pressed button between pointerdown and pointerup.
    const next = [pulse, stats, activity, note, detail];
    if (rendered && next.every((v, i) => v === rendered[i])) return;
    rendered = next;
    host.replaceChildren();
    if (pulse) {
      host.append(detail ? view.githubDetail(pulse, stats, activity, () => { detail = false; selection = null; draw(); }) : view.githubPulseCard(pulse, stats, activity, () => { detail = true; selection = null; draw(); }));
    } else {
      const card = el('div', 'int-card'), head = el('div', 'int-head');
      head.append(el('i', 'dot'), el('b', '', 'GitHub'));
      card.append(head, el('div', 'int-status', note || 'Cargando…'));
      host.append(card);
    }
    if (pulse && note) { const status = el('div', 'int-status', note); status.setAttribute('role', 'status'); host.append(status); }
  }
  function fetchSection(section) {
    return invoke('github_action', { payload: { action: 'refresh', section } }).then(answer => api.answerView(answer, section), () => ({ kind: 'unavailable', note: api.REASONS.gh_bad_answer }));
  }
  function refresh() {
    if (inFlight || !api.wanted(prefs) || !onScreen()) return;
    inFlight = true;
    fetchSection('pulse').then(r => {
      if (!api.wanted(prefs)) return;
      if (r.kind === 'pulse') { pulse = r.data; stats = r.stats || null; note = ''; } else { pulse = null; activity = null; note = r.note; }
      announce(!!pulse);
      draw();
      return pulse && fetchSection('activity').then(a => { if (api.wanted(prefs) && a.kind === 'activity') { activity = a.data; draw(); } });
    }).finally(() => { inFlight = false; });
  }
  function schedule(on) {
    if (on && !timer) { timer = setInterval(refresh, api.POLL_MS); refresh(); }
    else if (!on && timer) { clearInterval(timer); timer = null; }
  }

  import('./vendor/coucou/views/github.js').then(mod => {
    view = mod;
    mod.hooks.openUrl = url => { const safe = api.safeUrl(url); if (safe) invoke('open_chat_url', { payload: { url: safe } }).catch(() => {}); };
    mod.hooks.refresh = section => { if (focused && api.wanted(prefs) && onScreen()) fetchSection(section).then(r => { if (r.kind === 'pulse') { pulse = r.data; stats = r.stats || null; note = ''; } else if (r.kind === 'unavailable') note = r.note; if (r.kind === 'activity') activity = r.data; draw(); }); };
    doc.addEventListener('keydown', e => {
      if (!detail || host.hidden || !focused || !onScreen() || !e.isTrusted || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const rows = view.listRows(host), next = api.navigateDetail(e.key, selection, rows.length);
      if (!next) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (next.back) { detail = false; selection = null; draw(); }
      else if ('open' in next) view.openRow(rows[next.open]);
      else { selection = next.selection; view.highlightRow(rows, selection, true); }
    }, true);
    if (typeof MutationObserver !== 'undefined') new MutationObserver(draw).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
    doc.addEventListener('visibilitychange', draw);
    draw();
  }).catch(() => {});

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  doc.addEventListener('abito:integration-focus', e => {
    focused = e?.detail?.id === api.PILL_ID;
    draw();
  });
  const apply = p => {
    prefs = isObject(p) ? p : {};
    if (!api.wanted(prefs)) { focused = false; pulse = null; activity = null; announce(false); }
    draw();
  };
  invoke('prefs_action', { payload: { action: 'view' } }).then(apply, () => {});
  if (listen) listen('prefs:state', e => apply(e && e.payload)).catch(() => {});
}
