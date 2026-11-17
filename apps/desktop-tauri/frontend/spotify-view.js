'use strict';
/* #467 / #470 — the Spotify card of the island (the overview's left card, where Coucou puts its now-playing card).
   Layout and wording adapted from Coucou src/views/spotify.ts (SpotifyCardView), commit 434d6a2b,
   Copyright (c) 2026 Louis Raillé, MIT. Abito's own icons and copy; local raster artwork decoded into a canvas (no URL fetch and no CSP relaxation) and no Spotify mark.

   Wire (src/spotifyhost.rs, island window ONLY — the host refuses the settings label):
     invoke('spotify_action', {payload:{action:'view'|'stop'|'play_pause'|'next'|'previous'|'open_permission'}}) -> {ok, state}
     event 'spotify:state' -> PlayerState {running, track:{id,title,artist,album,duration,artUrl}|null, playing, needsPermission?, ...}
   `view` when the card becomes visible, `stop` when it goes away (and on unload). Pure view-model first,
   textContent-only renderer, browser-only mount at the tail (house pattern, see integrations-view.js).

   K2-09: the same card, three systems — Linux reads MPRIS, Windows the system media controls (SMTC) and
   macOS AppleScript; `os` comes from AbitoPillCatalog.HOST_OS. macOS only: if the user refused the
   Automation prompt, the state carries `needsPermission` and the card becomes design 08 F7 («Spotify
   necesita permiso», one button «Dar permiso» that asks the host to open Ajustes del Sistema ›
   Automatización — the deep link lives in src/spotify_mac.rs, never here). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoSpotify = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const PILL_ID = 'integration_spotify';
  const MAX_TEXT = 120;
  const CONTROLS = Object.freeze({ previous: 'Anterior', play_pause: 'Reproducir o pausar', next: 'Siguiente' });
  // K2-09 S3/S6 (design 08 F7): macOS refused the Automation prompt. One phrase and one button; the
  // Ajustes del Sistema deep link is the host's secret, never a URL in the page.
  const PERMISSION = Object.freeze({ action: 'open_permission', label: 'Dar permiso', title: 'Spotify necesita permiso', line: 'Permití a Koda controlar Spotify en Automatización' });
  const OSES = Object.freeze(['linux', 'windows', 'macos']);
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clean = (v, max = MAX_TEXT) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('') : '');

  // The card exists on a Linux, Windows or macOS host whose prefs name the Spotify pill (main or declared).
  const wantedIgnoringPause = (prefs, os) => OSES.includes(os) && isObject(prefs) &&
    (prefs.mainPill === PILL_ID || (Array.isArray(prefs.declaredPills) && prefs.declaredPills.includes(PILL_ID)));
  // abito-pausa: Spotify is paused in this version — no card, no D-Bus call (the stored prefs are kept)
  const pausedNow = () => { const P = typeof module === 'object' && module.exports ? require('./paused.js') : (typeof window !== 'undefined' ? window.AbitoPaused : null); return !!(P && P.paused('spotify')); };
  const wanted = (prefs, os) => !pausedNow() && wantedIgnoringPause(prefs, os);

  // PlayerState -> what the card says. Anything off-shape reads as «not open»: never a guess.
  function cardView(state) {
    // macOS only: the user said no to Automation, so there is no state to show — say how to say yes.
    if (isObject(state) && state.needsPermission === true) {
      return { kind: 'permission', title: PERMISSION.title, artist: PERMISSION.line, playing: false, controls: false, permission: true, aria: `${PERMISSION.title}. ${PERMISSION.line}` };
    }
    if (!isObject(state) || state.running !== true) {
      return { kind: 'closed', title: 'Spotify no está abierto', artist: '', playing: false, controls: false, aria: 'Spotify no está abierto' };
    }
    const track = isObject(state.track) ? state.track : null;
    const title = track ? clean(track.title) : '';
    if (!title) {
      return { kind: 'idle', title: 'Nada en reproducción', artist: '', playing: false, controls: true, aria: 'Spotify: nada en reproducción' };
    }
    const album = clean(track.album);
    const artist = clean(track.artist) + (clean(track.artist) && album ? ' · ' + album : '');
    const playing = state.playing === true;
    return { kind: 'track', title, artist, playing, controls: true, aria: `Spotify: ${title}${artist ? ', ' + artist : ''}. ${playing ? 'Reproduciendo' : 'En pausa'}` };
  }

  // ---- the extra controls of Coucou's now-playing card (spotify.rs parse_command accepts them) ----------
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
  /** m:ss, as Coucou's formatTime. */
  const formatTime = seconds => { const t = Math.max(0, Math.floor(num(seconds, 0, 359999) ?? 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const isAd = track => isObject(track) && typeof track.id === 'string' && track.id.startsWith('spotify:ad:');
  /** Where the bar is `now` (ms): the position runs on from positionAt while playing. */
  function progressView(state, now) {
    const track = isObject(state) && state.running === true && isObject(state.track) ? state.track : null;
    const duration = track ? num(track.duration, 0, 359999) : null;
    if (!track || !duration) return { fraction: 0, elapsed: '0:00', remaining: '0:00', seekable: false, duration: 0 };
    const base = num(state.position, 0, duration) ?? 0;
    const at = num(state.positionAt, 0, Number.MAX_SAFE_INTEGER);
    const run = state.playing === true && at !== null && Number.isFinite(now) ? Math.max(0, (now - at) / 1000) : 0;
    const position = Math.min(duration, base + run);
    return { fraction: position / duration, elapsed: formatTime(position), remaining: '-' + formatTime(duration - position), seekable: !isAd(track), duration };
  }
  const volumeOf = state => (isObject(state) ? (num(state.volume, 0, 100) ?? 0) : 0);
  /** The valued commands, closed: seek (seconds), volume (0..100 int), shuffle/repeat (bool). Anything else is null. */
  function valuedPayload(action, value) {
    if (action === 'seek') { const v = num(value, 0, 359999); return v === null ? null : { action, value: v }; }
    if (action === 'volume') { const v = num(value, 0, 100); return v === null ? null : { action, value: Math.round(v) }; }
    if (action === 'shuffle' || action === 'repeat') return typeof value === 'boolean' ? { action, value } : null;
    return null;
  }

  function artworkView(state) {
    const art = state?.artwork;
    if (state?.running !== true || !isObject(art) || art.artUrl !== state.track?.artUrl ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(art.mime) || typeof art.data !== 'string' ||
        !art.data || art.data.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(art.data)) return null;
    return art;
  }

  const payload = action => (Object.prototype.hasOwnProperty.call(CONTROLS, action) || action === PERMISSION.action ? { action } : null);

  // The lifecycle: `view` on show, `stop` on hide, nothing twice. `invoke` and `onState` are injected.
  function controller({ invoke, onState }) {
    let shown = false, generation = 0;
    const apply = r => { if (r && isObject(r) && 'state' in r) onState(r.state); };
    return {
      show() {
        if (shown) return Promise.resolve();
        shown = true; const mine = ++generation;
        return invoke('spotify_action', { payload: { action: 'view' } }).then(r => { if (mine === generation && shown) apply(r); }, () => { if (mine === generation) onState(null); });
      },
      hide() {
        if (!shown) return Promise.resolve();
        shown = false; generation += 1;
        return invoke('spotify_action', { payload: { action: 'stop' } }).then(() => {}, () => {});
      },
      control(action, value) {
        const body = value === undefined ? payload(action) : valuedPayload(action, value);
        if (!body || !shown) return Promise.resolve();
        const mine = generation;
        return invoke('spotify_action', { payload: body }).then(r => { if (shown && mine === generation) apply(r); }, () => {});
      },
      isShown: () => shown,
    };
  }

  return { PILL_ID, CONTROLS, PERMISSION, OSES, wanted, wantedIgnoringPause, cardView, payload, controller, formatTime, progressView, volumeOf, valuedPayload, artworkView };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const host = doc.getElementById('spotify-card');
  const overview = doc.getElementById('overview-view');
  const capsule = doc.getElementById('capsule');
  const internals = root.__TAURI_INTERNALS__;
  // The settings window runs this same page and the host refuses it: stay inert there.
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  if (!host || !overview || !capsule || label === 'settings') return;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!invoke) return;
  // K2-09: three systems (macOS no longer reads as Linux); the card shows only where the host has a backend
  const os = root.AbitoPillCatalog ? root.AbitoPillCatalog.HOST_OS : 'linux';
  // K2-09 S7 (option A): the card is a card of the island's icon row (island-shortcuts.js). Without that model it keeps the legacy
  // path (the left card of the overview) exactly as before.
  const shortcuts = root.AbitoShortcuts || null;
  const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  // Coucou's now-playing card (views/spotify.ts, NowPlayingViews.swift): green dot + title, subtitle, then
  // backward / play-pause / forward. Glyph paths are Coucou's ICONS (MIT, 24x24 grid, filled). There is no
  // remote artwork fetch: local raster bytes are decoded below; all transport controls use the closed host verbs.
  const GLYPH = {
    previous: 'M21.5 6.2c0-.7-.8-1.1-1.4-.7l-7.6 5.8c-.5.4-.5 1 0 1.4l7.6 5.8c.6.4 1.4 0 1.4-.7V6.2zm-10 0c0-.7-.8-1.1-1.4-.7l-7.6 5.8c-.5.4-.5 1 0 1.4l7.6 5.8c.6.4 1.4 0 1.4-.7V6.2z',
    next: 'M2.5 6.2c0-.7.8-1.1 1.4-.7l7.6 5.8c.5.4.5 1 0 1.4l-7.6 5.8c-.6.4-1.4 0-1.4-.7V6.2zm10 0c0-.7.8-1.1 1.4-.7l7.6 5.8c.5.4.5 1 0 1.4l-7.6 5.8c-.6.4-1.4 0-1.4-.7V6.2z',
    play: 'M7 4.6c0-.8.9-1.3 1.6-.9l11 6.9c.6.4.6 1.4 0 1.8l-11 6.9c-.7.4-1.6-.1-1.6-.9V4.6z',
    pause: 'M6 4.5h4v15H6zM14 4.5h4v15h-4z',
  };
  const NS = 'http://www.w3.org/2000/svg';
  const glyph = (name, size) => {
    const el = doc.createElementNS(NS, 'svg'); el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', String(size)); el.setAttribute('height', String(size)); el.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(NS, 'path'); path.setAttribute('d', GLYPH[name]); path.setAttribute('fill', 'currentColor');
    el.append(path); return el;
  };
  const title = mk('span', 'np-title'), artist = mk('div', 'np-sub');
  const dot = mk('span', 'np-dot');
  const row = mk('div', 'np-title-row'); row.append(dot, title);
  const text = mk('div', 'np-text');  // title, artist and (below) the transport controls: filled once `bar` exists
  const art = mk('div', 'np-art'); art.setAttribute('aria-hidden', 'true');
  const noteSvg = doc.createElementNS(NS, 'svg'); noteSvg.setAttribute('viewBox', '0 0 24 24'); noteSvg.setAttribute('width', '15'); noteSvg.setAttribute('height', '15');
  const notePath = doc.createElementNS(NS, 'path'); notePath.setAttribute('d', 'M12.2 3.6h1.7c.3 2.3 1.8 3.5 4.2 4.6l-.6 1.6c-1.4-.5-2.7-1.2-3.6-2.1v9.5a3.3 3.3 0 1 1-1.7-2.88V3.6z'); notePath.setAttribute('fill', 'currentColor');
  noteSvg.append(notePath); art.append(noteSvg);
  // Decode bytes directly into a canvas: no remote/file src, data URL, blob URL or CSP change.
  let artGeneration = 0, artKey = '';
  async function paintArtwork(state) {
    const a = api.artworkView(state), key = a ? a.artUrl + a.data : '';
    if (key === artKey) return;
    artKey = key; const mine = ++artGeneration;
    art.replaceChildren(noteSvg); delete host.dataset.artwork;
    if (!a) return;
    let bitmap;
    try {
      const bytes = Uint8Array.from(atob(a.data), c => c.charCodeAt(0));
      bitmap = await createImageBitmap(new Blob([bytes], {type:a.mime}), {resizeWidth:64, resizeHeight:64});
      if (mine !== artGeneration) return;
      const canvas = mk('canvas', 'np-cover'); canvas.width = 64; canvas.height = 64;
      canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.objectFit = 'cover';
      canvas.getContext('2d').drawImage(bitmap, 0, 0, 64, 64); art.replaceChildren(canvas); host.dataset.artwork = 'local';
    } catch (_) { /* invalid raster: keep the musical-note fallback */ }
    finally { bitmap?.close(); }
  }
  const head = mk('div', 'np-head');
  const buttons = {};
  const bar = mk('div', 'np-buttons');
  for (const [action, name] of Object.entries(api.CONTROLS)) {
    const b = mk('button', action === 'play_pause' ? 'np-play' : 'np-icon'); b.type = 'button'; b.dataset.action = action; b.setAttribute('aria-label', name);
    if (action !== 'play_pause') b.append(glyph(action, 11));
    else b.append(glyph('play', 9));
    b.addEventListener('click', e => { if (e.isTrusted === true) ctl.control(action); });
    buttons[action] = b; bar.append(b);
  }
  // K2-09 S3/S6 (design 08 F7): with Automation refused the transport gives way to ONE button. Text via
  // textContent; the styling rides in CSSOM properties because the card stylesheet is not this file's to edit.
  const perm = mk('button', 'np-perm');
  perm.type = 'button'; perm.textContent = api.PERMISSION.label;
  perm.style.height = '30px'; perm.style.padding = '0 13px'; perm.style.border = '0'; perm.style.borderRadius = '999px';
  perm.style.background = 'var(--ink)'; perm.style.color = 'var(--card-flat)'; perm.style.font = '500 12px var(--font)';
  perm.style.cursor = 'pointer'; perm.style.margin = '7px 0 7px 8px';
  perm.addEventListener('click', e => { if (e.isTrusted === true) ctl.control(api.PERMISSION.action); });
  perm.hidden = true; bar.append(perm);
  // progress row: elapsed, bar, remaining (Coucou .np-progress); controls: shuffle, previous, play, next, repeat | volume.
  const barOf = (label, onCommit) => {
    const el = mk('div', 'np-bar'), track = mk('i', 'np-track'), fill = mk('i', 'np-fill'), knob = mk('i', 'np-knob');
    el.setAttribute('role', 'slider'); el.setAttribute('aria-label', label); el.tabIndex = 0; el.append(track, fill, knob);
    const api2 = { el, fraction: 0, dragging: false, enabled: false };
    api2.paint = f => { api2.fraction = Math.min(1, Math.max(0, f)); fill.style.width = (api2.fraction * 100) + '%'; knob.style.left = `calc(${api2.fraction * 100}% - 4.5px)`; };
    const at = e => { const r = el.getBoundingClientRect(); return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0; };
    el.addEventListener('pointerdown', e => {
      if (!api2.enabled || e.button !== 0 || e.isTrusted !== true) return;
      e.stopPropagation(); api2.dragging = true; el.classList.add('active');
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      api2.paint(at(e));
    });
    el.addEventListener('pointermove', e => { if (api2.dragging) api2.paint(at(e)); });
    const end = e => { if (!api2.dragging) return; api2.dragging = false; el.classList.remove('active'); onCommit(at(e)); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', () => { api2.dragging = false; el.classList.remove('active'); });
    el.addEventListener('keydown', e => {
      if (!api2.enabled || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault(); const f = Math.min(1, Math.max(0, api2.fraction + (e.key === 'ArrowRight' ? 0.05 : -0.05))); api2.paint(f); onCommit(f);
    });
    return api2;
  };
  const elapsed = mk('span', 'np-time elapsed'), remaining = mk('span', 'np-time remaining');
  let last = null, lastRunning = null;
  const progress = barOf('Posición', f => { const p = api.progressView(last, Date.now()); if (p.seekable) ctl.control('seek', f * p.duration); });
  const progressRow = mk('div', 'np-progress'); progressRow.append(elapsed, progress.el, remaining);
  const GLYPH_FLAGS = {
    shuffle: 'M3 7h3.2c1.9 0 3.1.9 4.1 2.5l3.4 5c1 1.6 2.2 2.5 4.1 2.5H21M3 17h3.2c1.6 0 2.7-.6 3.6-1.8M14.2 8.8C15.1 7.6 16.2 7 17.8 7H21M18.6 4.6 21 7l-2.4 2.4M18.6 14.6 21 17l-2.4 2.4',
    repeat: 'M4 11.5V10a3 3 0 0 1 3-3h13.5M17.6 4.1 20.5 7l-2.9 2.9M20 12.5V14a3 3 0 0 1-3 3H3.5M6.4 19.9 3.5 17l2.9-2.9',
  };
  const flagBtn = (name, label) => {
    const b = mk('button', 'np-icon np-flag'); b.type = 'button'; b.dataset.action = name; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', 'false');
    const el = doc.createElementNS(NS, 'svg'); el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('width', '10'); el.setAttribute('height', '10'); el.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(NS, 'path'); path.setAttribute('d', GLYPH_FLAGS[name]); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.2'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); el.append(path); b.append(el);
    b.addEventListener('click', e => { if (e.isTrusted === true && last) ctl.control(name, !(last[name] === true)); });
    return b;
  };
  const shuffle = flagBtn('shuffle', 'Mezclar'), repeat = flagBtn('repeat', 'Repetir');
  // Design 17 (option A): cover on the left; title, artist and the 44x44 transport controls beside it; the progress row under both.
  // Shuffle and repeat ride in the title row (secondary toggles); the volume bar left the card (Option A has none; the host verb stays).
  row.append(shuffle, repeat);
  text.append(row, artist, bar);
  head.append(art, text);
  const card = mk('div', 'np-card'); card.append(head, progressRow);
  host.append(card);
  // S7/S2: the row's icon exists only while Spotify is really running. `mount` hands the SAME card node to #nusa-card and its unmount
  // gives it back, so the paint code and the host verbs stay in one place.
  let prefs = {};
  if (shortcuts) {
    shortcuts.registerCard({
      id: 'spotify', label: 'Spotify', icon: 'note',
      available: () => api.wanted(prefs, os) && lastRunning === true,
      mount: el => { el.append(card); return () => { host.append(card); }; },
    });
  }
  function tickProgress() {
    const p = api.progressView(last, Date.now());
    progress.enabled = p.seekable; if (!progress.dragging) progress.paint(p.fraction);
    elapsed.textContent = p.elapsed; remaining.textContent = p.remaining;
    progress.el.setAttribute('aria-valuenow', String(Math.round(p.fraction * 100)));
  }
  let clock = null;
  const runClock = on => { if (on && !clock) clock = setInterval(tickProgress, 500); else if (!on && clock) { clearInterval(clock); clock = null; } };
  const live = mk('span', 'sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); host.append(live);
  let lastAria = '';
  function paint(state) {
    const v = api.cardView(state);
    paintArtwork(state);
    title.textContent = v.title; artist.textContent = v.artist;
    host.dataset.kind = v.kind; host.dataset.playing = v.playing ? 'true' : 'false';
    host.setAttribute('aria-label', v.aria);
    last = state && typeof state === 'object' ? state : null;
    const ok = v.controls && v.kind === 'track';
    shuffle.setAttribute('aria-pressed', ok && last.shuffle === true ? 'true' : 'false');
    repeat.setAttribute('aria-pressed', ok && last.repeat === true ? 'true' : 'false');
    tickProgress(); runClock(v.kind === 'track' && v.playing);
    const permission = v.kind === 'permission';
    dot.hidden = permission;
    perm.hidden = !permission;
    for (const b of Object.values(buttons)) { b.hidden = permission; b.disabled = !v.controls; }
    buttons.play_pause.replaceChildren(glyph(v.playing ? 'pause' : 'play', 9));
    if (v.aria !== lastAria) { lastAria = v.aria; live.textContent = v.aria; }
    // S2: a closed Spotify leaves no icon and no card; the row repaints as soon as `running` moves
    const running = !!last && last.running === true;
    if (running !== lastRunning) { lastRunning = running; if (shortcuts) shortcuts.refresh(); }
  }
  const ctl = api.controller({ invoke, onState: paint });
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices' && !doc.hidden;
  };
  function sync() {
    // The host session belongs to the PILL, not to the card: `view` is what answers whether Spotify is running (S2 decides the row's
    // icon) and keeps that answer live while the user looks at the island; `stop` comes when the prefs stop naming it or the page hides.
    // The legacy left card still only shows in the overview it was written for.
    // only while the island is open: on macOS the session is an osascript poll, never a background loop behind a folded disc
    const want = api.wanted(prefs, os) && !doc.hidden && capsule.dataset.phase === 'expanded';
    if (want) ctl.show(); else ctl.hide();
    const legacy = want && onScreen();
    host.hidden = !legacy;
    if (legacy) overview.dataset.spotify = 'on'; else delete overview.dataset.spotify;
    if (shortcuts) shortcuts.refresh();
  }
  host.hidden = true; paint(null);
  if (listen) {
    listen('spotify:state', e => { if (ctl.isShown()) paint(e && e.payload); }).catch(() => {});
    listen('prefs:state', e => { prefs = e && isPlain(e.payload) ? e.payload : {}; sync(); }).catch(() => {});
  }
  function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  invoke('prefs_action', { payload: { action: 'view' } }).then(p => { prefs = isPlain(p) ? p : {}; sync(); }, () => {});
  doc.addEventListener('visibilitychange', sync);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(sync).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
  }
  root.addEventListener('pagehide', () => { ctl.hide(); });
}
