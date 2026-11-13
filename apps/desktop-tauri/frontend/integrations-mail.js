'use strict';
/* K2-10 T4 (S4, S8, S10, S11) — the Gmail card of Ajustes → Conexiones.
   ONE file, the house pattern (integrations-view.js): a pure view-model, a textContent-only
   renderer and a browser-only mount at the tail.

   WHAT IT IS NOW: the SETUP of the user's own Gmail. Nothing here reads mail (the island card does,
   K2-10 T5) and nothing here sends: this card saves the desktop client the user created in Google
   Cloud, connects with Google (desktop loopback + PKCE + the system browser), says whether the
   connection is alive and disconnects. Every call goes through the ONE closed host verb
   `gmail_action` (src/gmailcmd.rs); the token lives in the system keychain and the page never sees
   it, nor the client secret, nor a whole client id — at most the masked prefix the host returns.
   S8: IMAP/SMTP/Resend are gone from this card (the island's mail is Gmail now, and Resend was
   dropped by decision L1-8); the compose form and «Marcar como leído» are gone too (S5: read-only).
   S10: the help block guides the user to PUBLISH their own app (option B) and explains the «Google
   no verificó esta app → Configuración avanzada → Ir a … (no seguro)» warning, which appears
   because the app is the user's own — so the connection does not expire.

   ---- MOUNT CONTRACT (index.html wiring) ----
   1. one container inside Ajustes:  <section id="integrations-mail" hidden></section>
   2. one script tag after integrations-view.js:  <script src="integrations-mail.js" defer></script>
   With the container absent the module costs nothing. Styling: theme tokens only (`.snote`,
   `.sfield`, `.sbtn`, `.sform`: the classes every other Ajustes row already uses).

   Loaded as a classic script (window.AbitoMail) and by
   test-node/integrations-mail-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoMail = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const MAX_CLIENT_ID = 256;
  const MAX_SECRET = 128;
  const CLIENT_SUFFIX = '.apps.googleusercontent.com';
  const POLL_MS = 1000;
  const POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const MAX_POLLS = Math.ceil(POLL_TIMEOUT_MS / POLL_MS);
  const MAX_MASK = 16;
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

  // The four states the host answers and the words the card shows for them (S4, S11).
  const STATES = Object.freeze(['no_client', 'signed_out', 'connected', 'reconnect']);
  const STATE_LABELS = Object.freeze({
    no_client: 'Sin configurar',
    signed_out: 'Sin conectar',
    connected: 'Conectado',
    reconnect: 'Volvé a conectar Gmail',
  });
  const FLOW_STATES = Object.freeze(['waiting', 'done', 'none']);

  // One Spanish sentence per stable host code. An unknown code is a plain «no se pudo», never the
  // raw code shown to a person.
  const MESSAGES = Object.freeze({
    no_client: 'Falta guardar tu client ID de Google Cloud: pegálo arriba y tocá «Guardar».',
    needs_sign_in: 'Volvé a conectar Gmail: tocá «Conectar con Google».',
    denied: 'Cancelaste el permiso en Google. Podés volver a intentarlo cuando quieras.',
    expired: 'El inicio de sesión tardó demasiado. Volvé a tocar «Conectar con Google».',
    used: 'Ese inicio de sesión ya se usó. Volvé a tocar «Conectar con Google».',
    rejected: 'Google rechazó la conexión: revisá el client ID y el secreto en Google Cloud.',
    state: 'La respuesta de Google no era la esperada. Volvé a tocar «Conectar con Google».',
    scope_missing: 'Faltó el permiso de solo lectura: agregá gmail.readonly en la pantalla de consentimiento.',
    network: 'No se pudo conectar con Google. Revisá tu conexión e intentá de nuevo.',
    keychain: 'No se pudo leer el llavero del sistema.',
    invalid: 'Los datos no son válidos: revisá el client ID y el secreto.',
    port_busy: 'No se pudo abrir el puerto local donde Google devuelve la respuesta. Intentá de nuevo.',
    forbidden: 'Google no dejó leer el correo con ese permiso.',
    rate_limited: 'Gmail pidió esperar un momento. Probá de nuevo en un rato.',
    server: 'Gmail falló del lado de Google. Probá de nuevo en un rato.',
    opener_unavailable: 'No se pudo abrir tu navegador.',
    prefs: 'No se pudo guardar el estado del contador de correos nuevos.',
    timeout: 'Pasaron 10 minutos sin respuesta de Google. Volvé a tocar «Conectar con Google».',
    cancelled: 'Cancelaste la conexión.',
    failed: 'No se pudo completar la acción.',
  });

  // S10 (L4, human: «publicar la app sin verificar»): the steps of the user's own Google Cloud
  // project, and why the unverified warning appears — and why that does not expire.
  const HELP_TITLE = 'Cómo conectar tu Gmail (gratis)';
  const HELP_STEPS = Object.freeze([
    'Entrá a console.cloud.google.com con tu cuenta y creá un proyecto (por ejemplo «Koda»).',
    'Habilitá la API de Gmail: «APIs y servicios» → «Biblioteca» → «Gmail API» → «Habilitar».',
    'En «Pantalla de consentimiento de OAuth» elegí tipo «Externo» y completá el nombre de la app y tu correo.',
    'Agregá el permiso https://www.googleapis.com/auth/gmail.readonly — es de solo lectura: Koda no puede escribir, borrar ni marcar como leído.',
    'En «Credenciales» → «Crear credenciales» → «ID de cliente de OAuth», elegí «App de escritorio» y copiá el client ID (y el secreto, si te lo muestra).',
    'Pegá el client ID acá, tocá «Guardar» y después «Conectar con Google».',
    'Publicá la app: en «Pantalla de consentimiento» tocá «Publicar app». Así la conexión queda tuya y no vence (en «Prueba» Google la corta a los 7 días).',
    'Google va a decir «Google no verificó esta app». Es tu propia app, así que tocá «Configuración avanzada» → «Ir a … (no seguro)». Ese aviso aparece justamente porque la app es tuya y no está publicada para todo el mundo.',
    'Todo esto es gratis: el proyecto de Google Cloud y el permiso de solo lectura no se cobran.',
  ]);
  const HELP_FOOT = 'Koda nunca ve tu contraseña: el acceso queda en el llavero de tu sistema y podés cortarlo con «Desconectar».';
  const LOCAL_INVALID = 'Pegá el client ID completo: termina en «' + CLIENT_SUFFIX + '».';

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const chars = s => Array.from(s).length;

  // ---- the closed payloads -------------------------------------------------------
  /** Google's own shape for a pasted desktop client: `<digits>-….apps.googleusercontent.com`. */
  function clientOk(id) {
    if (!isStr(id) || chars(id) > MAX_CLIENT_ID || CONTROL.test(id)) return false;
    const trimmed = id.trim();
    if (trimmed !== id || !trimmed.endsWith(CLIENT_SUFFIX)) return false;
    const head = trimmed.slice(0, -CLIENT_SUFFIX.length);
    return head.length > 0 && /^[A-Za-z0-9-]+$/.test(head);
  }

  /** The secret is OPTIONAL (Google issues one for desktop clients and treats it as public). */
  function secretOk(secret) {
    if (!isStr(secret) || chars(secret) > MAX_SECRET || CONTROL.test(secret)) return false;
    const trimmed = secret.trim();
    return trimmed === secret && (trimmed === '' || /^[A-Za-z0-9_-]+$/.test(trimmed));
  }

  /** `{action:'set_client', clientId, clientSecret?}`, or null when the fields are not usable. */
  function setClientPayload(id, secret) {
    if (!clientOk(id)) return null;
    const s = secret === undefined || secret === null ? '' : secret;
    if (!secretOk(s)) return null;
    const payload = { action: 'set_client', clientId: id.trim() };
    if (s !== '') payload.clientSecret = s;
    return payload;
  }

  // ---- closed answers ------------------------------------------------------------
  /** The status/set_client answer: `{state, clientId, hasSecret}`, or null if off-shape. */
  function statusAnswer(a) {
    if (!isObject(a) || a.ok !== true || !STATES.includes(a.state) || typeof a.hasSecret !== 'boolean') return null;
    const id = a.clientId === undefined ? null : a.clientId;
    if (id !== null && !(isStr(id) && id.length > 0 && id.length <= MAX_MASK && !CONTROL.test(id))) return null;
    return Object.freeze({ state: a.state, clientId: id, hasSecret: a.hasSecret });
  }

  /** A begin/poll/cancel answer: `{state, browserOpened, authUrl}`, or null if off-shape. */
  function flowAnswer(a) {
    if (!isObject(a) || a.ok !== true || !FLOW_STATES.includes(a.state)) return null;
    if (a.state !== 'waiting') return Object.freeze({ state: a.state, browserOpened: null, authUrl: null });
    // `begin` says whether a browser was opened; `poll` answers waiting with nothing else.
    const opened = a.browserOpened === undefined || a.browserOpened === null ? null : a.browserOpened;
    if (opened !== null && typeof opened !== 'boolean') return null;
    const url = a.authUrl === undefined || a.authUrl === null ? null : a.authUrl;
    // Without a browser the host hands the URL back so the human can open it: only Google's own.
    if (url !== null && !(isStr(url) && url.startsWith('https://accounts.google.com/') && !CONTROL.test(url))) return null;
    return Object.freeze({ state: 'waiting', browserOpened: opened, authUrl: url });
  }

  const reasonOf = a => (isObject(a) && a.ok === false && isStr(a.reason) && Object.prototype.hasOwnProperty.call(MESSAGES, a.reason) && a.reason !== 'failed' ? a.reason : 'failed');
  const refusal = reason => Object.freeze({ ok: false, reason, message: MESSAGES[reason] });
  const statusView = view => Object.freeze({ ok: true, state: view.state, label: STATE_LABELS[view.state], clientId: view.clientId, hasSecret: view.hasSecret });
  const flowView = a => Object.freeze({ ok: true, state: a.state, browserOpened: a.browserOpened, authUrl: a.authUrl });

  // ---- the one closed host verb --------------------------------------------------
  async function call(invoke, payload) {
    if (typeof invoke !== 'function') return undefined;
    try { return await invoke('gmail_action', { payload }); } catch { return undefined; }
  }

  async function status(invoke) {
    const answer = await call(invoke, { action: 'status' });
    const view = statusAnswer(answer);
    return view ? statusView(view) : refusal(reasonOf(answer));
  }

  /** Saves the pasted client. The host keeps it in the keychain: the page keeps nothing. */
  async function saveClient(invoke, id, secret) {
    const payload = setClientPayload(id, secret);
    if (!payload) return Object.freeze({ ok: false, reason: 'invalid', message: LOCAL_INVALID });
    const answer = await call(invoke, payload);
    const view = statusAnswer(answer);
    return view ? statusView(view) : refusal(reasonOf(answer));
  }

  async function begin(invoke) {
    const answer = await call(invoke, { action: 'begin' });
    const flow = flowAnswer(answer);
    return flow ? flowView(flow) : refusal(reasonOf(answer));
  }

  async function poll(invoke) {
    const answer = await call(invoke, { action: 'poll' });
    const flow = flowAnswer(answer);
    return flow ? flowView(flow) : refusal(reasonOf(answer));
  }

  async function cancel(invoke) { await call(invoke, { action: 'cancel' }); return Object.freeze({ ok: true }); }

  async function forget(invoke) {
    const a = await call(invoke, { action: 'forget' });
    const view = statusAnswer(a);
    if (view) return statusView(view);
    if (isObject(a) && a.ok === true && a.state === 'no_client') return Object.freeze({ ok: true, state: 'no_client', label: STATE_LABELS.no_client, clientId: null, hasSecret: false });
    return refusal(reasonOf(a));
  }

  /**
   * The whole sign-in: open Google, then ask the host every second until it is done, fails, is
   * cancelled or ten minutes pass. `deps` ({wait, now}) exists so the whole loop is testable with
   * no browser, no network and no real time.
   */
  async function connect(invoke, deps) {
    const wait = (deps && deps.wait) || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = (deps && deps.now) || (() => Date.now());
    const started = now();
    const begun = await begin(invoke);
    if (!begun.ok) return begun;
    for (let i = 0; i < MAX_POLLS; i += 1) {
      await wait(POLL_MS);
      const next = await poll(invoke);
      if (!next.ok) { await cancel(invoke); return next; }
      if (next.state === 'done') return Object.freeze({ ok: true, state: 'done', browserOpened: begun.browserOpened, authUrl: begun.authUrl });
      if (next.state === 'none') { await cancel(invoke); return refusal('cancelled'); }
      if (now() - started >= POLL_TIMEOUT_MS) break;
    }
    await cancel(invoke);
    return refusal('timeout');
  }

  // ---- renderer (textContent only; events live in mount) -------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const button = (cls, action, label, id) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.dataset.action = action;
    if (id) b.id = id;
    return b;
  };
  const field = (id, label, control) => {
    const wrap = el('div', 'sform');
    const lab = el('label', 'snote', label);
    lab.htmlFor = id;
    control.id = id;
    wrap.append(lab, control);
    return wrap;
  };

  /** Draws the whole card. `model` = {state, clientId, hasSecret, connecting, saving, note, authUrl, draft}. */
  function render(host, model) {
    if (!(host && typeof host.appendChild === 'function')) return;
    const m = isObject(model) ? model : {};
    const state = STATES.includes(m.state) ? m.state : null;
    host.textContent = '';
    host.hidden = false;

    const head = el('div', 'ml-head');
    head.append(el('span', 'ml-title', 'Gmail'), el('span', 'ml-unread', state ? STATE_LABELS[state] : 'Estado desconocido'));
    host.append(head);
    host.append(el('p', 'snote', 'La isla muestra tus últimos correos y cuántos no leíste. Solo lectura: Koda no escribe, no borra y no marca como leído.'));

    const form = el('form', 'mail-client');
    form.noValidate = true;
    form.dataset.form = 'client';
    form.setAttribute('aria-label', 'Client de Google Cloud');
    const idInput = el('input', 'sfield');
    idInput.type = 'text';
    idInput.name = 'clientId';
    idInput.autocomplete = 'off';
    idInput.spellcheck = false;
    idInput.maxLength = MAX_CLIENT_ID;
    idInput.placeholder = CLIENT_SUFFIX;
    // What is typed (not yet saved) lives in the model so a repaint never loses it.
    idInput.value = isObject(m.draft) && isStr(m.draft.id) ? m.draft.id : '';
    const secretInput = el('input', 'sfield');
    secretInput.type = 'password';
    secretInput.name = 'clientSecret';
    secretInput.autocomplete = 'off';
    secretInput.maxLength = MAX_SECRET;
    secretInput.placeholder = 'Opcional';
    secretInput.value = isObject(m.draft) && isStr(m.draft.secret) ? m.draft.secret : '';
    form.append(field('mail-client-id', 'Client ID de Google Cloud', idInput));
    form.append(field('mail-client-secret', 'Secreto del cliente (opcional)', secretInput));
    const save = el('button', 'sbtn primary', m.saving ? 'Guardando…' : 'Guardar');
    save.type = 'submit';
    save.dataset.action = 'save';
    save.disabled = !!m.saving;
    form.append(save);
    host.append(form);

    if (state === 'no_client') {
      host.append(el('p', 'snote', 'Sin configurar: todavía no hay ningún client ID guardado.'));
    } else if (isStr(m.clientId) && m.clientId) {
      host.append(el('p', 'snote', `Client ID guardado: ${m.clientId}${m.hasSecret ? ' · con secreto guardado' : ''}`));
    } else if (state) {
      host.append(el('p', 'snote', 'Hay un client ID guardado.'));
    }

    const actions = el('div', 'sform');
    if (m.connecting) {
      actions.append(el('span', 'snote', 'Esperando a Google en tu navegador…'));
      actions.append(button('sbtn', 'cancel', 'Cancelar', 'mail-cancel'));
    } else {
      const go = button('sbtn primary', 'connect', 'Conectar con Google', 'mail-connect');
      go.disabled = state === null || state === 'no_client';
      actions.append(go);
    }
    if (state !== null && state !== 'no_client' && !m.connecting) {
      actions.append(button('sbtn', 'forget', 'Desconectar', 'mail-forget'));
    }
    host.append(actions);

    if (isObject(m.note) && isStr(m.note.text)) {
      const note = el('p', 'snote', m.note.text);
      note.setAttribute('role', 'status');
      note.dataset.tone = m.note.ok ? 'ok' : 'problem';
      host.append(note);
    }
    if (isStr(m.authUrl) && m.authUrl) {
      // No browser could be opened: the URL is shown so the human can open it by hand.
      host.append(el('p', 'snote', 'Abrí esta dirección en tu navegador para terminar de conectar:'));
      const url = el('p', 'sline', m.authUrl);
      url.dataset.field = 'authUrl';
      host.append(url);
    }

    const help = el('details', 'mail-help');
    help.append(el('summary', 'snote', HELP_TITLE));
    const steps = el('ol', 'snote');
    for (const step of HELP_STEPS) steps.append(el('li', 'sline', step));
    help.append(steps, el('p', 'snote', HELP_FOOT));
    host.append(help);
  }

  return { MAX_CLIENT_ID, MAX_SECRET, CLIENT_SUFFIX, POLL_MS, POLL_TIMEOUT_MS, MAX_POLLS, STATES, STATE_LABELS,
    HELP_TITLE, HELP_STEPS, HELP_FOOT, MESSAGES, clientOk, secretOk, setClientPayload, statusAnswer, flowAnswer,
    status, saveClient, begin, poll, cancel, forget, connect, render };
});

// ---- browser-only wiring: self-mount into #integrations-mail --------------------------------
function mount(V) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-mail');
  if (!host) return; // inert until index.html carries the container (mount contract)
  const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || (internals && internals.invoke);
  // The card only holds what is on screen; the client id and the token live in the keychain.
  let model = { state: null, clientId: null, hasSecret: false, connecting: false, saving: false, note: null, authUrl: null, draft: { id: '', secret: '' } };
  const paint = () => V.render(host, model);
  const note = (outcome) => ({
    ok: !!outcome.ok,
    text: outcome.ok ? (outcome.state === 'done' ? 'Gmail quedó conectado.' : null) : outcome.message,
  });
  async function refresh() {
    const r = await V.status(invoke);
    model = r.ok
      ? { ...model, state: r.state, clientId: r.clientId, hasSecret: r.hasSecret }
      : { ...model, state: null, note: { ok: false, text: r.message } };
    paint();
  }
  async function save() {
    if (model.saving) return;
    const idField = host.querySelector('input[name="clientId"]');
    const secretField = host.querySelector('input[name="clientSecret"]');
    const draft = { id: idField ? idField.value : '', secret: secretField ? secretField.value : '' };
    model = { ...model, draft, saving: true, note: null };
    paint();
    const r = await V.saveClient(invoke, draft.id, draft.secret);
    // Once it is saved nothing secret stays in the DOM: the fields are emptied and only the state
    // is drawn. A failed save keeps what the human typed so it can be corrected.
    model = r.ok
      ? { ...model, saving: false, draft: { id: '', secret: '' }, state: r.state, clientId: r.clientId, hasSecret: r.hasSecret, note: { ok: true, text: 'Client ID guardado.' } }
      : { ...model, saving: false, note: { ok: false, text: r.message } };
    paint();
  }
  async function startConnect() {
    if (model.connecting) return;
    model = { ...model, connecting: true, note: null, authUrl: null };
    paint();
    const r = await V.connect(invoke);
    model = { ...model, connecting: false, authUrl: r.ok ? r.authUrl : null, note: note(r) };
    paint();
    if (r.ok) await refresh();
  }
  async function disconnect() {
    if (model.connecting) return;
    const r = await V.forget(invoke);
    model = r.ok
      ? { ...model, state: r.state || 'no_client', clientId: null, hasSecret: false, note: { ok: true, text: 'Gmail quedó desconectado.' }, authUrl: null }
      : { ...model, note: { ok: false, text: r.message } };
    paint();
  }
  host.addEventListener('submit', e => {
    if (e) e.preventDefault(); // never a navigation
    if (!e || e.isTrusted !== true) return;
    save();
  });
  host.addEventListener('input', e => {
    if (!e || e.isTrusted !== true || !e.target || !e.target.name) return;
    if (e.target.name !== 'clientId' && e.target.name !== 'clientSecret') return;
    model = { ...model, draft: { ...(isObject(model.draft) ? model.draft : {}), [e.target.name]: e.target.value } };
  });
  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return;
    const target = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-action]') : null;
    if (!target || !host.contains(target)) return;
    if (target.dataset.action === 'cancel') { V.cancel(invoke).then(() => { model = { ...model, connecting: false, note: { ok: true, text: 'Cancelaste la conexión.' } }; paint(); }); return; }
    if (target.dataset.action === 'connect') { startConnect(); return; }
    if (target.dataset.action === 'forget') { disconnect(); return; }
  });
  paint();
  refresh();
}
