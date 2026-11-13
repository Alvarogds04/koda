'use strict';
/* K2-11 S1/S3/S6 — the GitHub card of the island's shortcuts row (island-shortcuts.js, the part built by K2-09; design
   k2-09-atajos/08-isla-unida.html F4/F4b: «el pulso de Coucou dentro de la misma tarjeta»). One closed host verb feeds it:

     invoke('github_action', {payload:{action:'refresh', section:'pulse'|'activity'}})
       -> {available:true, pulse:{login, myPRs, toReview, mainCI, issues, fetchedAt}, stats?}
       -> {available:false, reason:'gh_not_installed'|'gh_not_signed_in'|'gh_bad_answer'}
       -> {available:true, activity:{total, weeks}}

   S1: my open PRs, the PRs that ask me for a review, and the issues assigned to me or mentioning me (decision 10c), with the
   Coucou pulse as the card's own header: three tiles that open their list inside the SAME card («‹ Pulso» comes back). The tiles
   and rows are Abito's own DOM builders (textContent only); the CI vocabulary is Coucou's (`CI_WORDS` mirrors
   vendor/coucou/core/github.js `ciWord`, and the test keeps both equal).
   S3 (criterion 3): the card exists only while the answer really is available:true — no token and no `gh` means no card, and
   there is no sample row anywhere in this file. GitHub has its OWN pause entry (paused.js/paused.rs), so it is visible without
   un-pausing the 0.3 services.
   Links open with K2-01c's opener, through the existing `open_chat_url` (re-validated in Rust), and only github.com https URLs
   are ever offered. Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandGithub = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const CARD_ID = 'github';
  const LABEL = 'GitHub';
  const ICON = 'pr';
  const POLL_MS = 60000; // the host caches the pulse for 60 s and the grid for 300 s; polling faster only hits the cache
  const MAX_TEXT = 200;
  const BACK = '‹ Pulso';
  const NOTHING = 'Nada por aquí';
  const STRIP_DAYS = 14;
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** C0/C1 controls PLUS the bidi overrides, zero-width and separator characters a title (or a repo name) can carry from
      outside: each becomes a space and the result is capped, because they are text, never direction. */
  const HOSTILE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  const clean = (v, max = MAX_TEXT) => (typeof v === 'string' ? [...v.replace(HOSTILE, ' ').trim()].slice(0, max).join('') : '');
  /** Why there is no card. Closed: anything else reads as «bad answer», never as the user's fault. */
  const REASONS = Object.freeze({
    gh_not_installed: 'Guardá una clave GitHub en Ajustes o instalá la CLI de GitHub (gh).',
    gh_not_signed_in: 'Revisá tu clave GitHub en Ajustes o iniciá sesión con «gh auth login».',
    gh_bad_answer: 'GitHub no respondió como se esperaba.',
  });
  /** Coucou's CI vocabulary (vendor/coucou/core/github.js ciWord) plus the «no CI» case. */
  const CI_WORDS = Object.freeze({ failure: 'fallando', pending: 'en curso', success: 'pasando', unknown: 'sin CI' });
  /** The three tiles of design 08 F4, in the design's order. */
  const TILES = Object.freeze(['review', 'pr', 'issue']);
  const TITLES = Object.freeze({ review: 'Revisión pedida', pr: 'Tus PR', issue: 'Issues' });
  const REASON_WORDS = Object.freeze({ assigned: 'asignada', mentioned: 'te mencionan' });
  const isStat = v => Number.isSafeInteger(v) && v >= 0;

  /** Only https links to github.com leave the page (the host re-validates before handing it to the OS opener). */
  function safeUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
    let u; try { u = new URL(raw); } catch { return null; }
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password ? u.href : null;
  }
  const validStats = s => isObject(s) && isStat(s.totalStars) && isStat(s.totalRepos);

  /** An answer of `github_action` → what the card draws or why it has nothing to draw. */
  function answerView(answer, section) {
    if (!isObject(answer)) return { kind: 'unavailable', note: REASONS.gh_bad_answer };
    if (answer.available !== true) return { kind: 'unavailable', note: REASONS[answer.reason] || REASONS.gh_bad_answer };
    if (section === 'pulse') {
      const p = answer.pulse;
      const shaped = isObject(p) && Array.isArray(p.myPRs) && Array.isArray(p.toReview) && Array.isArray(p.mainCI)
        && Array.isArray(p.issues) && typeof p.login === 'string';
      return shaped ? { kind: 'pulse', data: p, ...(validStats(answer.stats) ? { stats: answer.stats } : {}) } : { kind: 'unavailable', note: REASONS.gh_bad_answer };
    }
    const a = answer.activity;
    return isObject(a) && Array.isArray(a.weeks) && typeof a.total === 'number' ? { kind: 'activity', data: a } : { kind: 'unavailable', note: REASONS.gh_bad_answer };
  }
  /** S3: true only for a real, complete pulse answer — the one thing that may put an icon in the row. */
  const available = answer => answerView(answer, 'pulse').kind === 'pulse';

  /** A PR of the pulse → the closed row data, or null when it is not the shape we know. */
  function prView(pr) {
    if (!isObject(pr) || typeof pr.title !== 'string' || typeof pr.repo !== 'string' || !Number.isSafeInteger(pr.number) || pr.number < 1) return null;
    const url = safeUrl(pr.url);
    if (!url) return null;
    // the ref is painted and goes into a tooltip: the same sanitiser and the same cap as every other text of the card
    const ref = clean(`${pr.repo.split('/').pop() || pr.repo}#${pr.number}`);
    const meta = pr.isDraft === true ? 'borrador' : (CI_WORDS[pr.ci] || CI_WORDS.unknown);
    return { ref, title: clean(pr.title), meta, url };
  }
  /** The issues assigned to me or mentioning me (10c): closed fields, unknown reasons dropped (never relabelled). */
  function issuesView(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const issue of list) {
      if (!isObject(issue) || typeof issue.title !== 'string' || typeof issue.repo !== 'string' || !Number.isSafeInteger(issue.number) || issue.number < 1) continue;
      if (!Object.prototype.hasOwnProperty.call(REASON_WORDS, issue.reason)) continue;
      const url = safeUrl(issue.url);
      if (!url) continue;
      out.push({ ref: clean(`${issue.repo.split('/').pop() || issue.repo}#${issue.number}`), title: clean(issue.title), repo: issue.repo, number: issue.number, url, reason: issue.reason });
    }
    return out;
  }
  /** The contribution strip of the design: the level of each of the last 14 days (colours belong to the stylesheet). */
  function stripView(activity) {
    if (!isObject(activity) || !Array.isArray(activity.weeks)) return [];
    const days = activity.weeks.flat().filter(isObject).slice(-STRIP_DAYS);
    return days.map(d => (Number.isInteger(d.level) && d.level >= 0 && d.level <= 4 ? d.level : 0));
  }

  const plural = (n, one, many) => (n === 1 ? one : many);
  /** The pulse: design 08 F4's three tiles, each with the count the answer really has (0 included). */
  function tilesOf(pulse) {
    const n = { review: pulse.toReview.length, pr: pulse.myPRs.length, issue: Array.isArray(pulse.issues) ? pulse.issues.length : 0 };
    return TILES.map(key => {
      const aria = key === 'review' ? `${n.review} ${plural(n.review, 'revisión pedida', 'revisiones pedidas')}. Ver la lista`
        : key === 'pr' ? `${n.pr} ${plural(n.pr, 'PR tuya abierta', 'PR tuyas abiertas')}. Ver la lista`
          : `${n.issue} ${plural(n.issue, 'issue asignada o que te menciona', 'issues asignadas o que te mencionan')}. Ver la lista`;
      return { key, label: TITLES[key], count: n[key], aria };
    });
  }
  /** The rows of one tile, built from the same pulse: what the user taps opens GitHub in the browser. */
  function rowsOf(section, pulse) {
    if (section === 'issue') {
      return issuesView(pulse.issues).map(i => ({ ref: i.ref, title: i.title, meta: REASON_WORDS[i.reason], url: i.url, aria: `Abrir ${i.ref} en GitHub` }));
    }
    const list = section === 'pr' ? pulse.myPRs : section === 'review' ? pulse.toReview : [];
    return list.map(prView).filter(Boolean).map(r => ({ ...r, aria: `Abrir ${r.ref} en GitHub` }));
  }

  /**
   * What the card paints: the pulse (`section` absent/«pulse») or one of its lists. `null` when there is no card to draw.
   */
  function cardView({ pulse, stats, activity, section } = {}) {
    if (!isObject(pulse) || !Array.isArray(pulse.myPRs) || !Array.isArray(pulse.toReview) || !Array.isArray(pulse.issues)) return null;
    const at = section === undefined || section === null || section === 'pulse' ? 'pulse' : section;
    if (at === 'pulse') {
      const tiles = tilesOf(pulse);
      return {
        kind: 'pulse', label: LABEL, login: clean(pulse.login),
        repos: isObject(stats) && isStat(stats.totalRepos) ? stats.totalRepos : null,
        tiles, strip: stripView(activity), activityLabel: `contribuciones · ${STRIP_DAYS} días`,
        aria: tiles.map(t => t.aria).join(' '),
      };
    }
    if (!TILES.includes(at)) return null;
    const rows = rowsOf(at, pulse);
    return { kind: 'list', section: at, label: LABEL, back: BACK, title: `${TITLES[at]} · ${rows.length}`, empty: rows.length === 0, nothing: NOTHING, rows };
  }

  // ── renderer: textContent only, buttons for everything the user can tap ────────────────────────────────────
  function render(host, view, open, pick) {
    const doc = host && host.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function' || typeof host.replaceChildren !== 'function') return;
    if (!view || view.kind === 'unavailable') { host.replaceChildren(); host.hidden = true; return; }
    const el = (tag, cls, txt) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n; };
    const button = (cls, aria, txt) => { const b = el('button', cls, txt); b.type = 'button'; b.setAttribute('aria-label', aria); return b; };
    const card = el('div', 'int-card gh-pulse-card');
    const head = el('div', 'int-head');
    const dot = el('i', 'dot gh-dot');
    head.append(dot, el('b', '', view.label));
    if (view.login) head.append(el('span', 'gh-login', '@' + view.login));
    if (view.kind === 'pulse' && view.repos !== null) head.append(el('span', 'gh-repos', `${view.repos} ${plural(view.repos, 'repo', 'repos')}`));
    if (view.kind === 'list') {
      const back = button('gh-back', 'Volver al pulso', view.back);
      back.addEventListener('click', e => { if (e.isTrusted === true && typeof pick === 'function') pick(null); });
      head.append(back, el('span', 'gh-list-title', view.title));
    }
    card.append(head);
    if (view.kind === 'pulse') {
      if (view.strip.length) {
        const strip = el('div', 'gh-strip');
        strip.setAttribute('role', 'img');
        strip.setAttribute('aria-label', view.activityLabel);
        for (const level of view.strip) strip.append(el('i', `gh-cell l${level}`));
        strip.append(el('span', 'gh-strip-label', view.activityLabel));
        card.append(strip);
      }
      const tiles = el('div', 'gh-tiles');
      for (const tile of view.tiles) {
        const b = button('gh-tile', tile.aria, null);
        b.setAttribute('data-tile', tile.key);
        b.append(el('b', 'gh-tile-count', String(tile.count)), el('span', 'gh-tile-label', tile.label));
        b.addEventListener('click', e => { if (e.isTrusted === true && typeof pick === 'function') pick(tile.key); });
        tiles.append(b);
      }
      card.append(tiles);
    } else if (view.empty) {
      card.append(el('div', 'gh-empty', view.nothing));
    } else {
      const list = el('div', 'gh-list');
      for (const row of view.rows) {
        const b = button('gh-row', row.aria, null);
        b.setAttribute('title', `${row.ref} ${row.title}`);
        b.append(el('span', 'gh-ref', row.ref), el('span', 'gh-title', row.title), el('span', 'gh-meta', row.meta));
        b.addEventListener('click', e => { if (e.isTrusted === true && typeof open === 'function' && row.url) open(row.url); });
        list.append(b);
      }
      card.append(list);
    }
    host.replaceChildren(card);
    host.hidden = false;
  }

  const pausedNow = () => {
    const P = typeof module === 'object' && module.exports ? require('./paused.js') : (typeof window !== 'undefined' ? window.AbitoPaused : null);
    return !!(P && P.paused('github'));
  };

  return { CARD_ID, LABEL, ICON, POLL_MS, REASONS, CI_WORDS, TILES, TITLES, REASON_WORDS, BACK, NOTHING, STRIP_DAYS, answerView, available, issuesView, stripView, tilesOf, rowsOf, cardView, render, safeUrl, pausedNow };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  // the host refuses any window but the island's; the settings window runs this same page, so stay inert there
  if (!invoke || label === 'settings') return;
  const shortcuts = root.AbitoShortcuts || null;
  if (!shortcuts) return;

  let pulse = null, stats = null, activity = null, section = null;
  let cardHost = null, timer = null, inFlight = false, drawn = null;
  const on = () => !!pulse && !api.pausedNow();
  const badge = () => (pulse ? pulse.toReview.length : 0);
  const paint = () => {
    if (!cardHost) return;
    // a poll that changed nothing must not detach the row the user is on nor reset the scroll: the guard is a stable serialisation
    // of the view model, never object identity (a host answer is a new object every poll)
    const view = api.cardView({ pulse, stats, activity, section });
    const next = JSON.stringify(view);
    if (drawn !== null && next === drawn) return;
    drawn = next;
    api.render(cardHost, view, open, pick);
  };
  function pick(key) { section = key; paint(); }
  function open(url) {
    const safe = api.safeUrl(url);
    if (safe) invoke('open_chat_url', { payload: { url: safe } }).catch(() => {});
  }
  // S3: the icon appears and disappears with the truth of the answer; the row is repainted only when that moves
  function settle(next) {
    const before = on(), count = badge();
    pulse = next.pulse;
    stats = next.stats;
    if (!pulse) { activity = null; section = null; }
    paint();
    if (on() !== before || badge() !== count) shortcuts.refresh();
  }
  const fetchSection = sectionName => invoke('github_action', { payload: { action: 'refresh', section: sectionName } })
    .then(answer => api.answerView(answer, sectionName), () => ({ kind: 'unavailable', note: api.REASONS.gh_bad_answer }));
  function refresh() {
    if (inFlight || doc.hidden || api.pausedNow()) return;
    inFlight = true;
    fetchSection('pulse').then(r => {
      inFlight = false;
      if (r.kind !== 'pulse') { settle({ pulse: null }); return; }
      settle({ pulse: r.data, stats: r.stats || null });
      if (!r.data.issues.length && !r.data.myPRs.length && !r.data.toReview.length) return;
      return fetchSection('activity').then(a => { if (a.kind === 'activity' && pulse === r.data) { activity = a.data; paint(); } });
    }, () => { inFlight = false; settle({ pulse: null }); });
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  shortcuts.registerCard({
    id: 'github', label: 'GitHub', icon: 'pr',
    available: () => on(),
    badge: () => badge(),
    mount: el => {
      const card = doc.createElement('div');
      card.className = 'gh-host';
      el.append(card);
      cardHost = card;
      drawn = null;
      paint();
      return () => { card.replaceChildren(); if (card.parentNode) card.parentNode.removeChild(card); cardHost = null; drawn = null; };
    },
  });

  // The pill column still speaks `abito:integration-focus` (pills-view.js) and the island stylesheet hides the overview's
  // left card under #overview-view[data-github="on"]. The card itself is a card of the shortcuts row now, so this mirror is
  // all that is left of the focused-pill path: it never paints anything (test-node/island-geometry-check.cjs pins it).
  doc.addEventListener('abito:integration-focus', e => {
    if (typeof doc.getElementById !== 'function') return;
    const overview = doc.getElementById('overview-view');
    if (!overview || !overview.dataset) return;
    if (e && e.detail && e.detail.id === 'integration_github') overview.dataset.github = 'on';
    else delete overview.dataset.github;
  });
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
  root.addEventListener('pagehide', stop);
  timer = setInterval(refresh, api.POLL_MS);
  refresh();
}
