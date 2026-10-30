'use strict';
/* #306 — the settings panel's PURE view-model (no DOM, no IPC, no network, no secrets).
   Three sections: providers (accounts and sign-in through the island agent), connectors
   (persisted state, read-only) and general (sound, system motion, global shortcut).
   Every state is icon + at most one word (docs/desktop-visual-language.md §3); a problem
   is never hidden. Loaded as a classic script (window.AbitoSettings) and by
   test-node/settings-view-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSettings = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // ---- screens ------------------------------------------------------------------------------------------------
  // Copied from gentle-dot (MIT): one icon button per screen in the chat header; each screen COVERS the chat
  // body with a title, a close button and a one-line hint. Opening one closes the others.
// #442: five tabs, General first; #440 keeps the design's copy diet.
  const TABS = Object.freeze([
    Object.freeze({ id: 'general', title: 'General', icon: 'gear', label: 'General', hint: '' }),
    Object.freeze({ id: 'accounts', title: 'Conexiones', icon: 'plug', label: 'Conexiones', hint: '' }),
    Object.freeze({ id: 'models', title: 'Modelos', icon: 'chip', label: 'Modelos', hint: 'Modelos que usa Koda' }),
    Object.freeze({ id: 'pills', title: 'Blobs', icon: 'ring', label: 'Blobs', hint: '' }),
    Object.freeze({ id: 'appearance', title: 'Apariencia', icon: 'eye', label: 'Apariencia', hint: '' }),

  ]);
  const tabById = id => TABS.find(x => x.id === id) || null;
  // S8: Cuentas + Conectores are ONE tab now. #442 T7.4: Especialistas merged into Blobs.
  // Old ids (deep links, probe seam) resolve through this table.
  const TAB_ALIASES = Object.freeze({ connectors: 'accounts', specialists: 'pills' });
  // Ajustes -> Conexiones owns the FAKE services group; no other tab shows it.
  const servicesGroupVisible = id => tabAlias(id) === 'accounts';
  const tabAlias = id => (Object.prototype.hasOwnProperty.call(TAB_ALIASES, id) ? TAB_ALIASES[id] : (tabById(id) ? id : null));
  // Tablist keyboard (WAI-ARIA): arrows wrap, Home/End jump. Returns the id to focus, or null for any other key.
  function tabKeyTarget(current, key) {
    const at = TABS.findIndex(x => x.id === current);
    if (at < 0) return null;
    if (key === 'ArrowRight' || key === 'ArrowDown') return TABS[(at + 1) % TABS.length].id;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return TABS[(at - 1 + TABS.length) % TABS.length].id;
    if (key === 'Home') return TABS[0].id;
    if (key === 'End') return TABS[TABS.length - 1].id;
    return null;
  }

  // ---- connection to the island agent (the daemon) ------------------------------------
  const CONNECTION = Object.freeze({
    no_daemon: ['Sin motor', 'plug-off', 'faint', 'El motor del agente no está corriendo; las cuentas y los proveedores no están disponibles.'],
    lost: ['Motor caído', 'triangle', 'red', 'Se perdió la conexión con el motor del agente.'],
    bad_session: ['Sesión no válida', 'triangle', 'red', 'El archivo de sesión del motor no es de fiar (permisos o formato); no se usó.'],
    refused: ['Motor no responde', 'triangle', 'red', 'El motor rechazó o no completó la conexión.'],
  });
  const CONNECT_WAIT_MS = 4000; // how long the page may show «Conectando» before it stops waiting for a first state
  function connectionView(state) {
    // No state at all = the engine has not answered yet. That is a WAIT, not «Sin motor»: saying the engine is
    // missing before it was even asked made every first open look broken.
    if (state === null || state === undefined || (state && state.connection === 'connecting')) {
      return { kind: 'connecting', word: 'Conectando', icon: 'ring', tone: 'live', aria: 'Conectando con el motor del agente.' };
    }
    const c = state && state.connection;
    if (c === 'connected') return null;
    const missing = c === 'no_daemon' && state.last_error && state.last_error.code;
    if (missing === 'node_missing' || missing === 'pi_missing') {
      const word = missing === 'node_missing' ? 'Falta Node.js' : 'Falta Pi';
      const help = missing === 'node_missing' ? 'instalalo desde nodejs.org.' : 'instalalo con npm install -g @earendil-works/pi-coding-agent.';
      return { kind: c, word, icon: 'plug-off', tone: 'faint', aria: `${word}: ${help}` };
    }
    const row = Object.prototype.hasOwnProperty.call(CONNECTION, c) ? CONNECTION[c] : CONNECTION.no_daemon;
    return { kind: c in CONNECTION ? c : 'no_daemon', word: row[0], icon: row[1], tone: row[2], aria: `${row[0]}: ${row[3]}` };
  }
  // Island status-row deep links (abito:settings-select) -> the section id inside Ajustes -> Conexiones.
  const PI_SECTIONS = Object.freeze({ 'accounts:agentes': 'connections-agents', 'accounts:motor': 'daemon-restart', 'accounts:proveedores': 'provider-list' });
  const connected = state => !!state && state.connection === 'connected';

  // ---- #390 GD027: the manual restart of the island agent daemon (Ajustes → Conexiones) --------
  // Closed shape and OUR words only: the engine never writes this panel (and #305's
  // `portal_rejected` wording belongs to that worker — nothing here ever renders it).
  // T7.2 design (ajustes-ventana-conexiones-*.png): the Motor group is one card row —
  // «Motor local» with the «Último estado conocido» sub (the honest read: the chip shows the last
  // known state) — and the design's own «Reiniciar» button word.
  const DAEMON_RESTART = Object.freeze({
    title: 'Motor',
    rowTitle: 'Motor local',
    rowSub: 'Último estado conocido',
    label: 'Reiniciar',
    busyLabel: 'Reiniciando…',
    ok: 'Motor reiniciado.',
    refused: 'Hay un motor ajeno en uso; no lo puedo reiniciar desde acá.',
    late: 'El motor no respondió a tiempo; volvé a probar en un momento.',
    failed: 'No se pudo reiniciar el motor.',
  });
  // `busy` is the page's own in-flight flag: the button disables ITSELF while a restart runs.
  function daemonRestartView(busy) {
    return {
      title: DAEMON_RESTART.title,
      rowTitle: DAEMON_RESTART.rowTitle,
      rowSub: DAEMON_RESTART.rowSub,
      action: { label: busy === true ? DAEMON_RESTART.busyLabel : DAEMON_RESTART.label, disabled: busy === true,
        aria: 'Reiniciar el motor del agente' },
    };
  }
  // Success only for the closed `outcome` of the restart: `restarted` is the ONLY success,
  // `refused` names a foreign motor that we never touch (GD029), `timeout` is a timeout —
  // never a success. A reply without the closed outcome falls back to the connection truth.
  function daemonRestartOutcome(result, error) {
    if (!result || error) return { tone: 'red', icon: 'triangle', say: DAEMON_RESTART.failed };
    if (result.outcome === 'restarted') return { tone: 'go', icon: 'check', say: DAEMON_RESTART.ok };
    if (result.outcome === 'refused') return { tone: 'sun', icon: 'info', say: DAEMON_RESTART.refused };
    if (result.outcome === 'timeout') return { tone: 'sun', icon: 'clock', say: DAEMON_RESTART.late };
    if (result.ready === true) return { tone: 'go', icon: 'check', say: DAEMON_RESTART.ok };
    return { tone: 'sun', icon: 'clock', say: DAEMON_RESTART.late };
  }

  // ---- providers / accounts --------------------------------------------------------------
  const METHOD_ORDER = ['api_key', 'oauth'];
  function providerOf(state, id) {
    return ((state && state.providers) || []).find(p => p.id === id) || null;
  }
  function loginMethods(state, accountId) {
    const account = ((state && state.accounts) || []).find(a => a.accountId === accountId);
    if (!account || account.local === true) return [];
    const provider = providerOf(state, account.provider);
    const offered = provider ? provider.methods : [];
    return METHOD_ORDER.filter(m => offered.includes(m));
  }
  function accountRows(state) {
    const accounts = (state && state.accounts) || [];
    const profiles = (state && state.profiles) || { profiles: [], active: null };
    const activeProfile = (profiles.profiles || []).find(p => p.id === profiles.active) || null;
    return accounts.map(a => {
      const provider = providerOf(state, a.provider);
      const active = !!activeProfile && activeProfile.provider === a.provider;
      const inUse = (profiles.profiles || []).some(p => p.provider === a.provider);
      const local = a.local === true;
      const signedIn = a.configured === true;
      const actions = [];
      if (!local && loginMethods(state, a.accountId).length) actions.push('login');
      if (!local && signedIn) actions.push('logout');
      if (!inUse) actions.push('remove');
      const chips = local ? [{ icon: 'lock', text: 'local' }] : [];
      return {
        accountId: a.accountId, label: a.label, providerName: provider ? provider.name : a.provider, local, active, chips, actions,
        state: signedIn || local ? { word: '', icon: '', tone: 'go' } : { word: 'Sin sesión', icon: 'plug-off', tone: 'faint' },
      };
    });
  }
  const SAFE_LABEL = s => typeof s === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(s);
  function createValidity(state, providerId, label) {
    const no = (word = '') => ({ ok: false, word });
    if (!connected(state) || !providerOf(state, providerId)) return no();
    if (typeof label !== 'string' || !label.trim()) return no();
    if (!SAFE_LABEL(label)) return no('No válido');
    if (Array.from(label).length > 80) return no('Muy largo');
    return { ok: true, word: '' };
  }

  // ---- sign-in: secrets ---------------------------------------------------------------------------
  const KEYLIKE = /\b(api[\s_-]?key|key|token|secret|password|passphrase|contrase(?:ñ|n)a|clave|credencial|credential)\b/i;
  function maskInput(prompt) {
    if (!prompt || typeof prompt !== 'object') return true; // no data = mask (the safe default)
    if (prompt.secret === true) return true;
    if (KEYLIKE.test(String(prompt.message || ''))) return true;
    return /^(sk|pk|ghp|xox|AIza)[-_.]/i.test(String(prompt.placeholder || ''));
  }
  function promptView(prompt) {
    if (!prompt || typeof prompt !== 'object') return null;
    const control = prompt.kind === 'select' && Array.isArray(prompt.options) && prompt.options.length ? 'select' : prompt.kind === 'confirm' ? 'confirm' : 'input';
    return {
      flowId: String(prompt.flowId || ''), promptId: String(prompt.promptId || ''), control,
      message: String(prompt.message || ''), masked: control === 'input' && maskInput(prompt), placeholder: String(prompt.placeholder || ''),
      options: control === 'select' ? prompt.options.map(o => ({ id: String(o.id), label: String(o.label || o.id) })) : [],
    };
  }
  const MAX_REPLY = 4096;
  function replyValid(value) {
    return typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= MAX_REPLY && !/[\u0000-\u001f\u007f]/.test(value);
  }
  // #421: the sign-in URL is engine data. Same rules as the host open_chat_url validator
  // (desktop.rs validated_web_url): <= 2000 chars, no whitespace/control, credential-free, https only (an existing pin: plain http is not a login link; stricter than the host).
  function safeWebUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return null;
    let u; try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.href;
  }
  function eventView(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const raw = typeof ev.url === 'string' && ev.url ? ev.url : typeof ev.verificationUri === 'string' ? ev.verificationUri : '';
    const link = safeWebUrl(raw);
    return { message: String(ev.message || ''), instructions: String(ev.instructions || ''), userCode: String(ev.userCode || ''), link, linkRejected: !!raw && !link };
  }
  function flowOutcome(last) {
    if (!last || typeof last !== 'object') return null;
    if (last.ok === true) return { word: 'Conectada', icon: 'check', tone: 'go' };
    if (last.cancelled === true) return { word: 'Cancelado', icon: 'cross', tone: 'faint' };
    return { word: 'No se pudo', icon: 'triangle', tone: 'red' };
  }

  // ---- connectors (persisted, read-only) ---------------------------------------------------------------
  const CONNECTOR_STATUS = Object.freeze({
    connected: ['', '', 'go'], failed: ['Falló', 'triangle', 'red'], disabled: ['Apagado', 'plug-off', 'faint'],
    needs_setup: ['Falta configurar', 'info', 'sun'],
  });
  // T7.2 copy diet: the services state line is gone (the design draws no note under Servicios).
  function connectorsView(state) {
    const c = (state && state.connectors) || { state: 'loading', items: [] };
    if (c.state === 'unavailable') return { kind: 'unavailable', word: 'No disponible', icon: 'plug-off', tone: 'faint', aria: 'No disponible: el motor no tiene conectores configurados.' };
    if (c.state === 'failed') return { kind: 'failed', word: 'Sin datos', icon: 'triangle', tone: 'red', aria: 'Sin datos: no se pudieron leer los conectores.' };
    if (c.state !== 'ready' && state && state.connection && state.connection !== 'connected' && state.connection !== 'connecting') {
      const cv = connectionView(state); // no live engine: waiting forever would be a lie
      if (cv) return { kind: 'no_engine', word: cv.word, icon: cv.icon, tone: cv.tone, aria: cv.aria };
    }
    if (c.state !== 'ready') return { kind: 'loading', word: '', icon: 'ring', tone: 'live', aria: 'Leyendo conectores' };
    const items = (c.items || []).map(i => {
      const row = Object.prototype.hasOwnProperty.call(CONNECTOR_STATUS, i.status) ? CONNECTOR_STATUS[i.status] : ['Desconocido', 'info', 'faint'];
      return { id: i.id, label: i.label, word: row[0], icon: row[1], tone: row[2], sends: i.mode === 'read_and_send' };
    });
    return { kind: 'ready', items, empty: items.length === 0 };
  }

  // ---- general --------------------------------------------------------------------------------------------
  const soundDefault = () => true; // sound is ON by default (human decision); the stored preference, if any, wins

  // ---- #380: the theme, a closed shape the panel can render -------------------------------------------------
  // Exactly three choices. The saved mode is the truth; anything the host cannot persist
  // (an old file, a damaged value) reads as «system», so the panel never offers a fourth
  // theme. Labels are ours (Spanish, voseo-free nouns), never taken from any payload.
  const THEME_MODES = Object.freeze(['system', 'light', 'dark']);
  const THEME_LABELS = Object.freeze({ system: 'Sistema', light: 'Claro', dark: 'Oscuro' });
  const THEME_ARIA = Object.freeze({
    system: 'Tema: sigue el sistema. Cambia cuando tu computadora cambia de claro u oscuro.',
    light: 'Tema: claro. Fijo, no sigue al sistema.',
    dark: 'Tema: oscuro. Fijo, no sigue al sistema.',
  });
  function themeView(prefs) {
    const saved = prefs && typeof prefs === 'object' && typeof prefs.theme === 'string' ? prefs.theme : undefined;
    const mode = THEME_MODES.includes(saved) ? saved : 'system';
    return {
      mode,
      options: THEME_MODES.map(id => ({ id, label: THEME_LABELS[id], selected: id === mode, aria: THEME_ARIA[id] })),
      aria: THEME_ARIA[mode],
    };
  }
  function generalView(input) {
    const i = input || {};
    const h = i.hotkey || null;
    const hotkey = !h ? null : {
      combo: String(h.combo || ''), enabled: h.enabled !== false, status: String(h.status || ''),
      backend: h.backend === 'portal' ? 'portal' : (h.backend === 'gnome' ? 'gnome' : (h.backend === 'win32' ? 'win32' : (h.backend === 'macos' ? 'macos' : 'x11'))),
      backendLabel: h.backend === 'portal' ? 'Atajo del sistema' : h.backend === 'gnome' ? 'Atajo de GNOME' : (h.backend === 'win32' ? 'Atajo de Windows' : h.backend === 'macos' ? 'Atajo de macOS' : (h.limited ? 'Atajo limitado (X11)' : 'Atajo de X11')),
      effective: typeof h.effective === 'string' ? h.effective : '',
      note: h.backend === 'gnome' ? (h.status === 'taken' ? 'Esa combinación ya la usa GNOME u otro atajo: elegí otra.' : 'Funciona sin pedir confirmación; podés cambiarla acá.')
        : h.portal_note === 'permission_denied' ? 'Rechazaste el permiso del sistema, por eso usa el atajo limitado.'
        : h.portal_note === 'unsupported' ? 'El portal del sistema no respondió o no pudo registrarlo.' : '',
    };
    return {
      sound: { on: i.sound === true, gain: typeof i.gain === 'number' && Number.isFinite(i.gain) && i.gain >= 0 && i.gain <= 0.2 ? i.gain : 0.12 },
      // motionOverride true (the default) = animate: the system preference is NOT honored
      motion: { respectSystem: i.motionOverride === false },
      hotkey,
    };
  }

  // T6.3 #434: the volume control is a slider (design ajustes-ventana-general-*). The percent
  // shown is the position inside the 0..0.2 range: the design's «60%» is exactly the 0.12 default.
  function gainPercent(gain) {
    return typeof gain === 'number' && Number.isFinite(gain) && gain >= 0 && gain <= 0.2
      ? Math.round((gain / 0.2) * 100)
      : 60; // the same default generalView models (0.12)
  }

  // T6.3 #434, #438 (coordinator split): the design draws Auto-cierre as a segmented control
  // «8 s / 15 s / 30 s / Nunca» on the contract's {0} ∪ 5..=120: «Nunca» is stored 0 through
  // the same closed pair and is enabled. Presets use the existing closed pair; a stored
  // non-preset value stays honest as its own selected segment (never rewritten) and hostile
  // input reads as the same 15 s default islandInteractionView models.
  const AUTO_CLOSE_PRESETS = Object.freeze([8, 15, 30]);
  function autoCloseSegments(seconds) {
    const valid = Number.isInteger(seconds) && (seconds === 0 || (seconds >= 5 && seconds <= 120)) ? seconds : 15;
    const segments = AUTO_CLOSE_PRESETS.map(value => ({ seconds: value, label: `${value} s`, selected: value === valid, disabled: false, title: '' }));
    if (valid !== 0 && !AUTO_CLOSE_PRESETS.includes(valid)) {
      segments.push({ seconds: valid, label: `${valid} s`, selected: true, disabled: false, title: '' });
    }
    // #438: «Nunca» is stored 0 on the same closed pair — enabled, selected on a stored 0.
    segments.push({ seconds: 0, label: 'Nunca', selected: valid === 0, disabled: false, title: '' });
    return segments;
  }

  // HU-057 S9: «Tamaño de la isla» — closed set S/M/L/Auto on the prefs wire (island_size); a foreign stored value reads as Auto.
  const ISLAND_SIZES = Object.freeze([{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }, { id: 'auto', label: 'Auto' }]);
  function islandSizeSegments(size) {
    const valid = ISLAND_SIZES.some(x => x.id === size) ? size : 'auto';
    return ISLAND_SIZES.map(x => ({ id: x.id, label: x.label, selected: x.id === valid }));
  }
  function islandSizeProblem(size) { return ISLAND_SIZES.some(x => x.id === size) ? '' : 'Elegí S, M, L o Auto.'; }

  // ---- hotkey capture (a pressed combination -> canonical text) -------------------------------------------------------
  const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'Super']);
  function captureCombo(event) {
    if (!event || event.isTrusted !== true || event.isComposing || event.repeat) return { kind: 'ignore' };
    if (event.key === 'Escape') return { kind: 'cancel' };
    if (MODIFIER_KEYS.has(event.key)) return { kind: 'wait' };
    const code = String(event.code || '');
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
    else if (code === 'Space') key = 'Space';
    if (!key) return { kind: 'unsupported' };
    if (!(event.ctrlKey || event.altKey || event.metaKey)) return { kind: 'needs_modifier' };
    const mods = [];
    if (event.ctrlKey) mods.push('Ctrl');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    if (event.metaKey) mods.push('Super');
    return { kind: 'combo', text: [...mods, key].join('+') };
  }

  // ---- Cuentas: the two method cards, the provider list, the login plan (gentle-dot AccountsPanel) ------------------
  const METHOD_CARDS = Object.freeze([
    Object.freeze({ id: 'oauth', title: 'Usar una suscripción' }),
    Object.freeze({ id: 'api_key', title: 'Usar una clave de API' }),
  ]);
  function accountOfProvider(state, providerId) {
    return ((state && state.accounts) || []).find(a => a.provider === providerId && a.local !== true) || null;
  }
  function providerList(state, method, filter) {
    if (!METHOD_CARDS.some(c => c.id === method)) return [];
    const needle = String(filter || '').trim().toLowerCase();
    return ((state && state.providers) || [])
      .filter(p => Array.isArray(p.methods) && p.methods.includes(method) && String(p.name || '').toLowerCase().includes(needle))
      .map(p => {
        const account = accountOfProvider(state, p.id);
        return {
          id: p.id, name: String(p.name || p.id), connected: p.configured === true || (!!account && account.configured === true),
          accountId: account ? account.accountId : null, canLogout: !!account && account.configured === true,
          actionLabel: method === 'oauth' ? 'Iniciar sesión' : 'Usar una clave de API',
        };
      });
  }
  // #410 round 2: the compact LIST (the human's words: one row per provider — "OpenAI conecta,
  // conectar con API o conectar con autentificación" — and nothing else). Same engine truth as the
  // old cards: per-provider status, a live login collapses its row to «Cancelar», a connected one
  // adds «Cerrar sesión», an error/cancel stays on the row that caused it. The visible words of the
  // two buttons are the human's own: `API` (manual key) and `Auth` (account sign-in); the engine's
  // wording is never shown — the texts below are ours, so a failure leaks nothing.
  const FLOW_STATUS = Object.freeze({
    connected: { kind: 'connected', word: 'Conectado', icon: 'check', tone: 'go' },
    idle: { kind: 'idle', word: 'No conectado', icon: 'plug-off', tone: 'faint' },
    progress: { kind: 'progress', word: 'En curso', icon: 'ring', tone: 'live' },
    error: { kind: 'error', word: 'Error', icon: 'triangle', tone: 'red' },
  });
  const API_WORD = 'API';
  const AUTH_WORD = 'Auth';
  const CANCEL_WORD = 'Cancelar';
  const API_ARIA = name => `Conectar con clave de API: ${name}`;
  const AUTH_ARIA = name => `Conectar con autentificación: ${name}`;
  const CANCEL_ARIA = name => `Cancelar el inicio de sesión: ${name}`;
  const FLOW_ERROR = 'No se pudo iniciar sesión. No se guardó nada; probá de nuevo.';
  const FLOW_CANCELLED = 'Cancelado. No se cambió nada.';
  function providerRows(state, opts) {
    const o = opts || {};
    const flow = o.flow && typeof o.flow === 'object' ? o.flow : null;
    const needle = String(o.filter || '').trim().toLowerCase();
    const live = !!flow && flow.phase === 'active';
    return ((state && state.providers) || [])
      .filter(p => Array.isArray(p.methods) && p.methods.length
        && String(p.name || '').toLowerCase().includes(needle))
      .map(p => {
        const account = accountOfProvider(state, p.id);
        const isConnected = p.configured === true || (!!account && account.configured === true);
        const mine = !!flow && flow.providerId === p.id;
        const phase = mine ? flow.phase : null;
        let status = isConnected ? FLOW_STATUS.connected : FLOW_STATUS.idle;
        if (phase === 'active') status = FLOW_STATUS.progress;
        else if (phase === 'error') status = FLOW_STATUS.error;
        const blocked = !connected(state) || (live && !mine);
        const name = String(p.name || p.id);
        const button = m => ({ word: m === 'oauth' ? AUTH_WORD : API_WORD,
          aria: m === 'oauth' ? AUTH_ARIA(name) : API_ARIA(name),
          method: m, disabled: blocked || !loginPlan(state, p.id, m) });
        const connecting = phase === 'active';
        return {
          id: p.id, name, status,
          api: !isConnected && !connecting && p.methods.includes('api_key') ? button('api_key') : null,
          auth: !isConnected && !connecting && p.methods.includes('oauth') ? button('oauth') : null,
          cancel: connecting ? { word: CANCEL_WORD, aria: CANCEL_ARIA(name) } : null,
          logout: isConnected && !!account && account.configured === true && phase !== 'active',
          accountId: account ? account.accountId : null,
          error: phase === 'error' ? FLOW_ERROR : '', note: phase === 'cancelled' ? FLOW_CANCELLED : '',
        };
      });
  }
  // R16: «Cancelar» is bound to the flow THIS row started; with none yet there is nothing to send.
  function cancelPlan(target) {
    const id = target && target.sawFlow ? String(target.flowId || '') : '';
    return id ? { kind: 'send', flowId: id } : { kind: 'local' };
  }
  function labelFor(name, fallback) {
    const clean = Array.from(String(name || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()).slice(0, 80).join('').trim();
    return clean || String(fallback || '');
  }
  // The engine keys a sign-in on an ACCOUNT. gentle-dot logs in per provider, so: reuse the provider's account,
  // or create one named after the provider and log in when it appears (pendingLogin / pendingLoginReady).
  function loginPlan(state, providerId, method) {
    if (!connected(state)) return null;
    const provider = providerOf(state, providerId);
    if (!provider || !Array.isArray(provider.methods) || !provider.methods.includes(method) || !METHOD_ORDER.includes(method)) return null;
    const account = accountOfProvider(state, providerId);
    if (account) return { kind: 'start', accountId: account.accountId, method };
    return { kind: 'create', provider: providerId, label: labelFor(provider.name, providerId), method };
  }
  function pendingLogin(state, provider, method) {
    return { provider, method, known: ((state && state.accounts) || []).map(a => a.accountId) };
  }
  function pendingLoginReady(state, pending) {
    if (!pending) return null;
    const fresh = ((state && state.accounts) || []).find(a => a.provider === pending.provider && a.local !== true && !pending.known.includes(a.accountId));
    return fresh ? { accountId: fresh.accountId, method: pending.method } : null;
  }
  function connectedAccounts(state) {
    const signedIn = new Set(((state && state.accounts) || []).filter(a => a.configured === true || a.local === true).map(a => a.accountId));
    return accountRows(state).filter(r => signedIn.has(r.accountId)).map(r => Object.assign({}, r, { signedIn: !r.local }));
  }

  // ---- #414: Ajustes → Modelos — one group per provider, the models of the CONNECTED ones ------------------------
  // The engine reports the catalogue (`models` frame, folded by agentclient) and the typed pref
  // `chosen_models` holds what the human marked. Nothing here is invented: a provider the engine
  // does not name never renders, and a disconnected one is a hint to Conexiones, not a guess.
  const chosenOf = chosen => (chosen && typeof chosen === 'object' && !Array.isArray(chosen)) ? chosen : {};
  function isProviderConnected(state, providerId) {
    const provider = providerOf(state, providerId);
    return !!provider && (provider.configured === true || !!accountOfProvider(state, providerId));
  }
  const UNPROVEN_SUB = 'Guardado · sin probar';
  function modelsTabView(state, chosen) {
    // No engine (or not yet answered) is a wait or a problem in the same words as Conexiones.
    const cv = connectionView(state);
    if (cv && cv.kind !== 'connecting') return { kind: 'no_engine', word: cv.word, icon: cv.icon, tone: cv.tone, aria: cv.aria, groups: [] };
    if (!state || state.connection !== 'connected') return { kind: 'connecting', word: 'Conectando', icon: 'ring', tone: 'live', aria: 'Conectando con el motor del agente.', groups: [] };
    const store = chosenOf(chosen);
    const models = Array.isArray(state.models) ? state.models : [];
    const groups = ((state.providers) || []).map(p => {
      const name = String(p.name || p.id);
      // T7.2 (Q2): a provider whose ONLY account is a locally saved key (accounts frame:
      // local===true + configured, no engine account, provider not configured) lists its models
      // but is saved, never proven: «Guardado · sin probar». No new wire field.
      const savedLocal = ((state.accounts) || []).some(a => a && a.provider === p.id && a.local === true && a.configured === true);
      const onlyLocal = savedLocal && p.configured !== true && !accountOfProvider(state, p.id);
      if (!isProviderConnected(state, p.id) && !onlyLocal) {
        return { id: p.id, name, connected: false, hint: `Conectá ${name} en Conexiones para ver sus modelos.` };
      }
      const list = Array.isArray(store[p.id]) ? store[p.id].filter(x => typeof x === 'string') : [];
      return {
        id: p.id, name, connected: true,
        // T7.2: the capability chips read ONLY the closed fields the engine frame already
        // carries (agentclient `models` fold): reasoning and contextWindow. Nothing is
        // invented — an absent/zero context and a false reasoning draw no chip.
        models: models.filter(m => m && m.provider === p.id && typeof m.id === 'string')
          .map(m => ({ id: m.id, name: String(m.name || m.id), chosen: list.includes(m.id),
            sub: onlyLocal ? UNPROVEN_SUB : '',
            reasoning: m.reasoning === true,
            contextWindow: Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : null })),
      };
    });
    return { kind: 'ready', groups };
  }
  // One toggle: add the model to its provider's list, or take it out; an emptied provider drops its
  // key (the typed pref then stores no key at all). Plain objects only: prototype keys never survive.
  function chosenToggle(chosen, providerId, modelId) {
    const store = chosenOf(chosen);
    const list = Array.isArray(store[providerId]) ? store[providerId].filter(x => typeof x === 'string') : [];
    const next = list.includes(modelId) ? list.filter(x => x !== modelId) : [...list, modelId];
    const out = {};
    for (const key of Object.keys(store)) if (key !== providerId && Array.isArray(store[key])) out[key] = store[key];
    if (next.length) out[providerId] = next;
    return out;
  }
  // The closed wire payload: the WHOLE list of that provider replaces what is stored.
  function chosenModelsPayload(chosen, providerId) {
    const store = chosenOf(chosen);
    const list = Array.isArray(store[providerId]) ? store[providerId].filter(x => typeof x === 'string') : [];
    return { action: 'set_chosen_models', provider: String(providerId), models: list };
  }


  // ---- Claves (#467): the OS key store, presence only --------------------------------------------------------------
  // Layout of the section adapted from Coucou src/settings/main.ts (API keys), Copyright (c) 2026 Louis Raillé, MIT.
  // The ids mirror KNOWN_KEYS of src/secrets.rs (the host refuses anything else). Labels are OURS; the page never
  // shows a value, only «Guardada» / «Sin definir», and sends a value only inside one `set`.
  const KEY_LABELS = Object.freeze({
    'anthropic-api-key': 'Anthropic', 'openai-api-key': 'OpenAI', 'google-api-key': 'Google', 'openrouter-api-key': 'OpenRouter', 'nan-api-key': 'NaN', 'opencode-go-api-key': 'OpenCode Go',
    'openai-compatible-key': 'Compatible con OpenAI', 'n8n-url': 'n8n (dirección)', 'n8n-api-key': 'n8n (clave)',
    'vercel-token': 'Vercel', 'github-token': 'GitHub', 'stripe-api-key': 'Stripe', 'resend-api-key': 'Resend', 'resend-from': 'Resend (remitente)',
    'smtp-host': 'Correo SMTP (servidor)', 'smtp-user': 'Correo SMTP (usuario)', 'smtp-password': 'Correo SMTP (contraseña)', 'smtp-from': 'Correo SMTP (remitente)',
    'imap-host': 'Correo IMAP (servidor)', 'imap-user': 'Correo IMAP (usuario)', 'imap-password': 'Correo IMAP (contraseña)',
    'notion-api-key': 'Notion', 'calcom-api-key': 'Cal.com', 'elevenlabs-api-key': 'ElevenLabs',
  });
  const KEY_IDS = Object.freeze(Object.keys(KEY_LABELS));
  const KEY_MAX_BYTES = 2048;
  const keyRows = presence => KEY_IDS.map(id => {
    const known = presence && typeof presence === 'object' && Object.prototype.hasOwnProperty.call(presence, id) && typeof presence[id] === 'boolean';
    const state = !known ? 'unknown' : (presence[id] ? 'present' : 'absent');
    return { id, label: KEY_LABELS[id], state, word: state === 'present' ? 'Guardada' : (state === 'absent' ? 'Sin definir' : '…') };
  });
  function keyPayload(action, key, value) {
    if (!KEY_IDS.includes(key)) return null;
    if (action === 'present' || action === 'clear') return { action, key };
    if (action !== 'set' || typeof value !== 'string' || !value || value.includes('\0')) return null;
    if (new TextEncoder().encode(value).length > KEY_MAX_BYTES) return null;
    return { action, key, value };
  }
  const KEY_ERRORS = Object.freeze({
    unavailable: 'El llavero del sistema (Secret Service) no está disponible. La clave no se guardó y Koda no la guarda en ningún otro lado.',
    save_failed: 'No se pudo guardar el cambio en el llavero del sistema.',
    invalid_schema: 'La clave o el valor no son válidos. No se cambió nada.',
  });
  // Only the closed code picks the sentence: the host message (and anything else) is never shown.
  const keyError = error => {
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
    return Object.prototype.hasOwnProperty.call(KEY_ERRORS, code) ? KEY_ERRORS[code] : 'No se pudo completar el cambio de claves.';
  };

  // ---- agents: connect Claude Code / Codex / OpenCode with ONE click (no terminal) -------------------------------------
  // The state comes from the engine's `agents` frame. Names and sentences are OURS: nothing the engine sends is
  // shown as text, only chosen from these closed tables.
  const AGENT_NAMES = Object.freeze({ pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex', 'copilot-cli': 'Copilot CLI', opencode: 'OpenCode', recap: 'Resumen semanal', statusline: 'Uso del plan (relay)' });
  const AGENT_IDS = Object.freeze(Object.keys(AGENT_NAMES));
  // #436 T6.5 (D7): all SEVEN hook clients the daemon's `hooks` frame may name. The three extra
  // ones are DISPLAY-ONLY (no install/remove exists for them; a dead button would be a lie),
  // and their names derive from OUR closed ids, never from engine text — the trailing segment
  // reads as its upper-case product word (a client's proper name, not a terminal instruction).
  const HOOK_IDS = Object.freeze(['claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'amp', 'cursor']);
  const agentName = id => AGENT_NAMES[id]
    || id.split('-').map(s => (s ? s[0].toUpperCase() + s.slice(1) : s)).join(' ').replace(/Cli$/, 'CLI');
  const HOOK_STATES = Object.freeze({
    not_connected: ['Sin conectar', 'plug-off', 'faint'], connected: ['Hooks activos', 'check', 'go'],
    outdated: ['Desactualizado', 'info', 'sun'], working: ['En curso', 'ring', 'live'],
    unavailable: ['Sin instalar', 'plug-off', 'faint'], error: ['No se pudo', 'triangle', 'red'],
  });
  const UNKNOWN_HOOK = ['No disponible', 'plug-off', 'faint'];
  const BACKUP_NOTE = 'Con respaldo.';
  // The `hooks` frame folded once: first entry wins per known id, a row off the closed state
  // vocabulary is dropped (never sanitized into a lie) — the same rules as the Rust fold.
  const hookRows = state => {
    const list = state && state.hooks;
    if (!Array.isArray(list)) return null;
    const map = new Map();
    for (const c of list) {
      if (!c || typeof c !== 'object' || !HOOK_IDS.includes(c.id) || map.has(c.id)) continue;
      if (!Object.prototype.hasOwnProperty.call(HOOK_STATES, c.state)) continue;
      map.set(c.id, c);
    }
    return map;
  };
  const displayRow = (id, st, word, icon, tone, note) => ({
    id, name: agentName(id), state: st, word, icon, tone,
    primary: null, secondary: null, note: note || '', summary: '', reviewable: false, trust: false, busy: st === 'working',
    aria: `${agentName(id)}: ${word}${note ? '. ' + note : ''}`,
  });
  const hookRowOf = c => {
    const [word, icon, tone] = HOOK_STATES[c.state];
    return displayRow(c.id, c.state, word, icon, tone, c.backup === true ? BACKUP_NOTE : '');
  };
  const unknownRow = id => displayRow(id, 'unknown', UNKNOWN_HOOK[0], UNKNOWN_HOOK[1], UNKNOWN_HOOK[2], '');
  // The six rows in OUR closed order: an engine row wins for its id (the buttons live there),
  // the hooks frame fills the rest with honest state, and what nobody knows stays unknown.
  const mergeSix = (rows, hooks) => {
    const byId = new Map(rows.map(r => [r.id, r]));
    const extra = rows.filter(r => r.id === 'recap' || r.id === 'statusline' || r.id === 'pi'); // L32e: engine-only integrations, after the six
    return [...HOOK_IDS, ...extra.map(r => r.id)].map(id => byId.get(id) || (hooks && hooks.get(id) ? hookRowOf(hooks.get(id)) : unknownRow(id)));
  };
  const AGENT_STATES = Object.freeze({
    not_connected: ['Sin conectar', 'plug-off', 'faint'], connected: ['Conectado', 'check', 'go'], outdated: ['Desactualizado', 'info', 'sun'],
    working: ['En curso', 'ring', 'live'], unavailable: ['No encontrado', 'plug-off', 'faint'], error: ['No se pudo', 'triangle', 'red'],
  });
  const AGENT_ERRORS = Object.freeze({
    config_invalid: 'La configuración actual no es válida; no se tocó nada.',
    not_writable: 'No hay permiso de escritura en la configuración; no se tocó nada.',
    backup_failed: 'No se pudo hacer el respaldo; no se tocó nada.',
    plan_changed: 'Algo cambió desde la vista previa; revisá el nuevo cambio y volvé a intentar.',
    audit_unavailable: 'No se pudo abrir el registro de cambios, así que no se tocó nada.',
    install_failed: 'No se pudo completar; no se tocó nada.',
    unsafe_target: 'La carpeta o el archivo de configuración no es privado de tu usuario o pasa por un enlace; no se tocó nada.',
    install_unverified: 'No se pudieron verificar los archivos instalados de Koda; no se tocó nada. Reinstalá Koda.',
    foreign_extension: 'Ya hay una extensión de Pi en ~/.pi/agent/extensions/abito-island que Koda no instaló: borrala o renombrala y volvé a conectar.',
  });
  // HU-047: the refused folder is named exactly (the daemon forwards it with a closed reason); chmod only where chmod can fix it.
  const FOLDER_OK = (f, r) => typeof f === 'string' && f !== '' && f.length <= 400 && !/[\u0000-\u001f\u007f]/.test(f) && (r === 'writable' || r === 'foreign_owner' || r === 'acl');
  const shellArg = d => /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(d) ? d : `'${d.replace(/'/g, `'\\''`)}'`;
  function unsafeFolderNote(folder, reason) {
    if (!FOLDER_OK(folder, reason)) return AGENT_ERRORS.unsafe_target;
    if (reason === 'writable') return `La carpeta ${folder} la puede modificar otro usuario o grupo; quitale el permiso de escritura (chmod g-w,o-w ${shellArg(folder)}) y volvé a intentar.`;
    if (reason === 'foreign_owner') return `La carpeta ${folder} pertenece a otro usuario y Koda solo escribe en carpetas tuyas; cambiale el dueño a tu usuario (con permisos de administrador) y volvé a intentar.`;
    return `La carpeta ${folder} tiene permisos de Windows (ACL) que dan acceso a otros usuarios o no es tuya; dejala accesible solo para tu usuario (Propiedades > Seguridad) y volvé a intentar.`;
  }
  const PLAN_FALLBACK = 'Se van a agregar los hooks de Koda. Antes se hace un respaldo.';
  const PLAN_HASH = /^[0-9a-f]{64}$/;
  // The engine prints a CLOSED English template for the plan. The page never shows engine text: it recognises
  // the template and says the same thing in Spanish; anything else becomes one generic, true sentence.
  const PLAN_RE = /^(Adds|Updates) the Abito (hooks|plugin) (?:(\([A-Za-z.]+(?:, [A-Za-z.]+){0,5}\)) )?(?:to|in) (~\/[\w.\/-]{1,120}|\/[\w.\/-]{1,200})\. A backup is made first\.( Codex will ask you to trust them in \/hooks\.)?( This change is large: review it in the file\.)?$/;
  // L32e: the two notify-only integrations have their own closed summaries (daemon agents.cjs); only these exact
  // sentences (optionally followed by the one large-change line) are shown, in Spanish. Anything else falls back.
  const NOTIFY_PLANS = Object.freeze({
    'Installs the Abito Pi extension in the default ~/.pi/agent directory. A backup is made first.':
      'Instala la extensión de Koda en ~/.pi/agent. Antes se hace un respaldo. Reiniciá Pi para cargarla.',
    'Adds notify-only hooks that only count activity for the weekly recap. No command text, path or prompt is kept. A backup is made first.':
      'Agrega ganchos que solo cuentan tu actividad para el resumen semanal; no guardan comandos, rutas ni prompts. Antes se hace un respaldo.',
    'Adds the status-line relay in ~/.claude/settings.json. An existing status line keeps working (the relay prints it). A backup is made first.':
      'Agrega el relay de línea de estado en ~/.claude/settings.json. Si ya tenés una línea de estado, sigue funcionando (el relay la imprime). Antes se hace un respaldo.',
  });
  function planSummary(text) {
    if (typeof text === 'string') {
      const large = ' This change is large: review it in the file.';
      const base = text.endsWith(large) ? text.slice(0, -large.length) : text;
      if (Object.prototype.hasOwnProperty.call(NOTIFY_PLANS, base)) return NOTIFY_PLANS[base] + (base === text ? '' : ' Es un cambio grande: revisalo en el archivo.');
    }
    const m = typeof text === 'string' && text.length <= 400 ? PLAN_RE.exec(text) : null;
    if (!m) return PLAN_FALLBACK;
    const noun = m[2] === 'plugin' ? 'el plugin de Koda' : 'los hooks de Koda';
    const verb = (m[1] === 'Adds' ? 'Agrega ' : 'Actualiza ') + noun;
    const joiner = m[1] === 'Adds' ? 'a' : 'en';
    const withNames = m[3] && m[1] === 'Adds' ? ` ${m[3]}` : '';
    return `${verb}${withNames} ${joiner} ${m[4]}. Antes se hace un respaldo.${m[5] ? ' Codex te va a pedir que confíes en ellos en /hooks.' : ''}${m[6] ? ' Es un cambio grande: revisalo en el archivo.' : ''}`;
  }
  const AGENTS_WAIT_MS = 4000; // how long the page waits for the engine's `agents` frame before saying so
  const LOGOUT_WORD = 'Cerrar sesión'; // gentle-dot's «Sign out»
  const errorSeqOf = st => (st && st.last_error && Number.isInteger(st.last_error.n) ? st.last_error.n : 0);
  // opts.askedAtError: the engine error counter when `agents_list` was sent; opts.timedOut: the wait ran out.
  // HU-015: Ajustes → Agentes is read and written through the daemon-free host route, whose answer carries
  // `agentsRuntime` ('ok' | 'node_missing' | 'failed') + `directAgents` / `directHooks`. The chat engine's connection
  // (Pi, daemon) plays NO part in these rows: each row's state is its own hooks, never «Falta Pi» / «Sin motor».
  const directRuntimeRow = (id, word, tone, icon) => displayRow(id, 'unknown', word, icon, tone, '');
  function directAgentsView(state) {
    const kind = state.agentsRuntime;
    if (kind === 'node_missing' || kind === 'failed') {
      const [word, icon, tone] = kind === 'node_missing' ? ['Falta Node.js', 'plug-off', 'faint'] : ['No se pudo', 'triangle', 'red'];
      return { kind: 'ready', rows: [...HOOK_IDS, 'recap', 'statusline', 'pi'].map(id => directRuntimeRow(id, word, tone, icon)) };
    }
    const own = { agents: state.directAgents, hooks: state.directHooks };
    const view = agentsView(Object.assign({ connection: 'connected' }, own, { last_error: null }), {});
    for (const row of view.rows || []) {
      if (row.primary?.command?.action === 'agent_connect' && !row.primary.command.plan_hash)
        row.primary = { label: 'Reintentar', command: { action: 'agents_list' } };
    }
    return view;
  }
  function agentsView(state, opts) {
    const o = opts || {};
    if (state && typeof state.agentsRuntime === 'string') return directAgentsView(state);
    if (state && state.connection && state.connection !== 'connected' && state.connection !== 'connecting') {
      const cv = connectionView(state);
      if (cv) return { kind: 'no_engine', word: cv.word, icon: cv.icon, tone: cv.tone, aria: cv.aria };
    }
    const list = state && state.agents;
    if (!Array.isArray(list)) {
      const hooks = hookRows(state);
      if (hooks) return { kind: 'ready', rows: mergeSix([], hooks) }; // hooks-only knowledge is enough
      // The engine of today may not know `agents_list`: it answers error{bad_request|unavailable}, or nothing.
      // Either way the wait ENDS, in words, with no ring (the same class as the services spinner).
      const code = state && state.last_error && state.last_error.code;
      const newError = Number.isInteger(o.askedAtError) && errorSeqOf(state) > o.askedAtError && (code === 'bad_request' || code === 'unavailable');
      if (newError || o.timedOut === true) return { kind: 'unsupported', word: 'No disponible', icon: 'plug-off', tone: 'faint', note: 'El motor todavía no puede conectar agentes.', aria: 'No disponible: el motor todavía no puede conectar agentes.', rows: [] };
      return { kind: 'loading', rows: [] };
    }
    const seen = new Set();
    const rows = [];
    for (const a of list) {
      if (!a || typeof a !== 'object' || !AGENT_IDS.includes(a.id) || seen.has(a.id)) continue;
      seen.add(a.id);
      const st = Object.prototype.hasOwnProperty.call(AGENT_STATES, a.state) ? a.state : 'error';
      const [defaultWord, icon, tone] = AGENT_STATES[st];
      const platformUnavailable = st === 'unavailable' && a.detail === 'unsupported_platform';
      const word = platformUnavailable ? 'No disponible en esta plataforma todavía' : a.id === 'pi' && st === 'connected' ? 'Instalado en carpeta predeterminada' : defaultWord;
      const cmd = action => ({ action, agentId: a.id });
      const hash = typeof a.plan_hash === 'string' && PLAN_HASH.test(a.plan_hash) ? a.plan_hash : null;
      const reviewable = a.reviewable !== false;
      const offersPlan = st === 'not_connected' || st === 'outdated' || (st === 'error' && a.detail === 'plan_changed');
      // the click carries the hash of the plan the human SAW; no hash = nothing to approve = no button
      const connectCmd = () => ({ action: 'agent_connect', agentId: a.id, plan_hash: hash });
      const summary = offersPlan && hash ? planSummary(a.summary) : '';
      let primary = null, secondary = null, note = '';
      if (st === 'not_connected' || st === 'outdated') {
        if (st === 'outdated') secondary = { label: 'Desconectar', command: cmd('agent_disconnect') };
        if (!hash) note = 'No hay una vista previa del cambio; volvé a abrir esta pantalla.';
        else if (!reviewable) note = 'Es un cambio grande: revisalo en el archivo.';
        // #436 design: the connect word is the design's own «Agregar hooks» (was «Conectar»)
        else primary = { label: st === 'outdated' ? 'Actualizar' : 'Agregar hooks', command: connectCmd() };
      }
      if (st === 'connected') {
        secondary = { label: 'Desconectar', command: cmd('agent_disconnect') };
        if (a.backup === true) note = 'Con respaldo.'; // #436 design: the design's own subtitle
      }
      if (st === 'unavailable') note = platformUnavailable ? 'La instalación automática todavía no está disponible en Windows.' : 'No está instalado en esta computadora.';
      if (st === 'error') {
        primary = { label: 'Reintentar', command: hash ? connectCmd() : cmd('agent_connect') };
        note = a.detail === 'unsafe_folder' ? unsafeFolderNote(a.folder, a.folder_reason)
          : Object.prototype.hasOwnProperty.call(AGENT_ERRORS, a.detail) ? AGENT_ERRORS[a.detail] : 'No se pudo completar; no se tocó nada.';
      }
      if (a.id === 'pi' && !platformUnavailable) note += `${note ? ' ' : ''}Solo ~/.pi/agent. Si usás otro PI_CODING_AGENT_DIR, esa sesión no carga esta instalación. Reiniciá Pi después de cambiar los hooks.`;
      const trust = a.trust_review === true;
      if (trust) note = `${note ? note + ' ' : ''}Ahora confiá en los hooks desde /hooks dentro de ${AGENT_NAMES[a.id]}: hasta entonces no se activan.`;
      rows.push({ id: a.id, name: AGENT_NAMES[a.id], state: st, word, icon, tone, primary, secondary, note, summary, reviewable, trust, busy: st === 'working',
        ...(platformUnavailable ? { helpUrl: 'https://github.com/Alvarogds04/abito#windows-limitations' } : {}),
        aria: `${AGENT_NAMES[a.id]}: ${word}${summary ? '. ' + summary : ''}${note ? '. ' + note : ''}` });
    }
    return { kind: 'ready', rows: mergeSix(rows, hookRows(state)) };
  }

  // HU-015: what to say after a connect/disconnect that went through the daemon-free route. Only the host's own answer
  // counts (never the chat engine's connection): a runtime failure, or THAT agent's row in `error`, is a failure.
  function directOutcome(next, agentId, okSay) {
    const fail = { ok: false, say: agentActionFailure(agentId) };
    if (!next || typeof next !== 'object' || next.agentsRuntime === 'failed') return fail;
    if (next.agentsRuntime === 'node_missing') return { ok: false, say: 'Falta Node.js para cambiar los hooks.' };
    const row = Array.isArray(next.directAgents) ? next.directAgents.find(a => a && a.id === agentId) : null;
    if (!row || row.state === 'error' || row.state === 'unavailable') return fail;
    return { ok: true, say: okSay };
  }

  // #503 S20: the sentence for a FAILED ACTION on one agent. It is said once, at the moment the action failed; a standing `error`
  // STATE is shown by the state column only (it used to print this sentence under every row of the table at rest).
  const agentActionFailure = id => `No se pudo completar la acción${AGENT_NAMES[id] ? ' en ' + AGENT_NAMES[id] : ''}; no se tocó nada.`;

  // ---- what to tell the human after a command ---------------------------------------------------------------------
  // The page used to say «Cuenta creada» when it WROTE the command. The engine answers later (state
  // frames) and may refuse (`error{failed|busy|bad_request|...}`): success is only said when the state
  // that came back carries no error newer than the one we had when we sent it.
  const ENGINE_ERRORS = Object.freeze({
    failed: ['No se pudo', 'triangle', 'red'], busy: ['Motor ocupado', 'lock', 'sun'],
    bad_request: ['Pedido no válido', 'triangle', 'red'], rate_limited: ['Demasiados pedidos', 'clock', 'sun'],
    store_not_private: ['Los archivos de tu cuenta no son privados en este equipo. Quitá la cuenta y volvé a iniciar sesión.', 'lock', 'red'],
    unavailable: ['No disponible', 'plug-off', 'faint'], not_busy: ['Nada en curso', 'info', 'faint'], unknown_ask: ['Pedido desconocido', 'info', 'faint'],
  });
  const errorSeq = st => (st && st.last_error && Number.isInteger(st.last_error.n) ? st.last_error.n : 0);
  function commandOutcome(before, after, okSay) {
    const failure = (word, icon, tone) => ({ ok: false, word, icon, tone, say: /[.!?]$/.test(word) ? word : `${word}.` });
    if (!after || typeof after !== 'object') return failure('No se pudo', 'triangle', 'red');
    if (after.connection && after.connection !== 'connected') {
      const cv = connectionView(after);
      return cv ? failure(cv.word, cv.icon, cv.tone) : failure('No se pudo', 'triangle', 'red');
    }
    if (errorSeq(after) > errorSeq(before)) {
      const code = after.last_error && after.last_error.code;
      const row = Object.prototype.hasOwnProperty.call(ENGINE_ERRORS, code) ? ENGINE_ERRORS[code] : ENGINE_ERRORS.failed;
      return failure(row[0], row[1], row[2]);
    }
    return { ok: true, say: okSay };
  }

  // The shortcut backend answers `set` with the status it ended in. «Cambiado» only when it is really active.
  const HOTKEY_SET_FAILS = Object.freeze({
    taken: 'Atajo ocupado: lo usa otra aplicación.', invalid: 'Atajo inválido: necesita Ctrl, Alt o Súper.',
    unsupported: 'Atajo sin soporte: no se pudo registrar.', permission_denied: 'Atajo sin permiso: rechazaste el permiso del sistema.',
  });
  function hotkeySetOutcome(view, typed) {
    if (!view || typeof view !== 'object') return { ok: false, say: 'No se pudo cambiar el atajo.' };
    if (Object.prototype.hasOwnProperty.call(HOTKEY_SET_FAILS, view.status)) return { ok: false, say: HOTKEY_SET_FAILS[view.status] };
    if (view.status === 'permission_pending') return { ok: null, say: 'Falta confirmar el permiso del sistema para cambiar el atajo.' };
    const combo = typeof view.combo === 'string' && view.combo ? view.combo : String(typed || '');
    return { ok: true, say: `Atajo cambiado a ${combo}.` };
  }

  // ---- drafts: what the human is typing survives a re-render --------------------------------------------------------
  // The panel rebuilds its DOM on every state push (the portal pushes every 400 ms while its dialog is open),
  // which used to wipe a half-typed key. Kept here, per field id, inside one «scope» (one prompt/flow); a
  // new scope starts empty so one prompt's key is never carried into the next. Memory only, never persisted.
  function makeDrafts() {
    let scopeId = '';
    let values = Object.create(null);
    return {
      get: id => values[id] || '',
      set(id, v) { values[id] = String(v); },
      clear(id) { delete values[id]; },
      scope(next) { if (next !== scopeId) { scopeId = next; values = Object.create(null); } },
      reset() { scopeId = ''; values = Object.create(null); },
    };
  }

  // ---- #384: the Dot's colour, chosen by the human (avatar-colors.js owns the contract) ------------------------------
  // Pure: the palette, the defaults, the validation all come from the injected
  // contract (`AbitoAvatarColors`); this only shapes rows the panel can render. With no real sub-Abito there
  // are no specialist rows: the panel never invents an identity, and a missing contract yields no control
  // rather than a broken one.
  function colorRows(prefs, identities, colors) {
    if (!colors || typeof colors.settingsRows !== 'function' || !Array.isArray(colors.PALETTE)) return [];
    const stored = prefs && typeof prefs === 'object' && prefs.avatarColors && typeof prefs.avatarColors === 'object'
      ? prefs.avatarColors : {};
    let entries = [];
    if (Array.isArray(identities)) {
      entries = identities.map(identity => typeof identity === 'string' ? { id: identity, name: identity } : identity)
        .filter(identity => identity && typeof identity.id === 'string');
    }
    return colors.settingsRows(entries.map(identity => identity.id), stored).map(row => {
      const identity = entries.find(identity => identity.id === row.id);
      const name = typeof identity.name === 'string' && identity.name ? identity.name : row.id;
      return { id: row.id, name, color: row.color, label: row.label, aria: `Color de ${name}: ${row.label}`,
        options: colors.PALETTE.map(color => ({
          color, label: colors.label(color), selected: color === row.color || !!(colors.normalizeChosenColor && colors.normalizeChosenColor(color) === colors.normalizeChosenColor(row.color)), aria: `${colors.label(color)} para ${name}`,
        })),
      };
    });
  }

  // Explicit public projection: never spread account/config objects containing private fields.
  function ownedAccounts(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.accounts)) return [];
    return snapshot.accounts.filter(a => a && typeof a.accountId === 'string' && a.config).map(a => ({
      accountId: a.accountId, provider: a.provider, hasCredential: a.hasCredential === true,
      config: { nombre: a.config.nombre, baseUrl: a.config.baseUrl, api: a.config.api,
        compat: Object.fromEntries(Object.entries(a.config.compat || {}).filter(([, v]) => typeof v === 'boolean')),
        models: Array.isArray(a.config.models) ? a.config.models.filter(m => typeof m === 'string') : [],
        defaultModel: a.config.defaultModel },
    }));
  }

  function soundGainProblem(text) {
    const n = Number(text);
    return String(text).trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 0.2
      ? '' : 'Ingresá un volumen entre 0 y 0,2.';
  }

  // #366 F093 — the page runs in window mode only inside the exact Rust-created
  // settings window (label "settings", the SAME page). Any other label — including
  // the island's own "main" and every look-alike — is island mode.
  function isSettingsWindow(label) {
    return label === 'settings';
  }

  // #366 F093 — the Ajustes → General toggle reads the effective placement from
  // the projection only: absent or false is the in-island default (#408), an
  // explicit true opts into the own window. Never coerces a foreign value.
  // #366 F094 — the quick panel: exactly the three most-used toggles, read from the
  // saved projection only (sound, theme mode, auto-close seconds), reusing the full
  // panel's own view-models so the two can never disagree.
  function quickPanelView(prefs) {
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    return {
      sound: { on: p.sound === true },
      theme: themeView(p).options.map(o => ({ id: o.id, label: o.label, selected: o.selected === true, aria: o.aria })),
      autoCloseSeconds: islandInteractionView(p).autoCloseSeconds,
    };
  }

  function settingsWindowView(prefs) {
    const map = prefs && typeof prefs === 'object' ? prefs : {};
    return { on: map.settingsWindow === true };
  }

  // #336 F003/F004 — the typed interaction pair as the panel shows it: the
  // effective values behind the projection, each field falling back to the
  // public contract's default (15 seconds / hover off) on its own, never
  // coercing a foreign value. #438: 0 is «Nunca» — a real stored value, never clamped.
  function islandInteractionView(input) {
    const i = input || {};
    const seconds = i.autoCloseSeconds;
    return {
      autoCloseSeconds: Number.isInteger(seconds) && (seconds === 0 || (seconds >= 5 && seconds <= 120)) ? seconds : 15,
      openOnHover: i.openOnHover === true,
    };
  }

  // Canonical integer text only ('15', 15, ' 15 '): no floats, no exponents,
  // no signed forms, no coercion — 0 («Nunca») or the inclusive 5..120 range
  // of the wire (#438).
  function autoCloseProblem(text) {
    const raw = String(text).trim();
    const n = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(n) && (n === 0 || (n >= 5 && n <= 120))
      ? '' : 'Ingresá 0 (nunca) o un entero entre 5 y 120 segundos.';
  }

  function displayNameProblem(text) {
    if (Array.from(text).length > 80) return 'Usá hasta 80 caracteres.';
    if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return 'El nombre contiene caracteres de control.';
    return '';
  }

  return { PI_SECTIONS, KEY_IDS, keyRows, keyPayload, keyError, ownedAccounts, colorRows, soundGainProblem, gainPercent, autoCloseSegments, islandSizeSegments, islandSizeProblem, isSettingsWindow, settingsWindowView, quickPanelView, displayNameProblem, islandInteractionView, autoCloseProblem, commandOutcome, hotkeySetOutcome, makeDrafts, providerRows, cancelPlan, TABS, tabById, tabAlias, servicesGroupVisible, tabKeyTarget, METHOD_CARDS, providerList, loginPlan, pendingLogin, pendingLoginReady, connectedAccounts, AGENT_IDS, agentsView, directOutcome, agentActionFailure, planSummary, AGENTS_WAIT_MS, CONNECT_WAIT_MS, LOGOUT_WORD, SOUND_DEFAULT: false, connectionView, accountRows, loginMethods, createValidity,
    modelsTabView, chosenToggle, chosenModelsPayload,
    maskInput, promptView, replyValid, eventView, safeWebUrl, flowOutcome, connectorsView, soundDefault, generalView, captureCombo,
    maskInput, promptView, replyValid, eventView, safeWebUrl, flowOutcome, connectorsView, soundDefault, generalView, captureCombo,
    daemonRestartView, daemonRestartOutcome,
    THEME_MODES, THEME_LABELS, themeView };
});
