'use strict';
/* #370 F103 — the Mail service card: a read-list, an open message and a compose
   form inside the island. ONE file, the house pattern (integrations-view.js):
   pure view-model, textContent-only renderer, a FAKE provider, browser-only
   mount at the tail.

   SEND IS LIVE (#490): `send` validates the draft and then calls the closed host verb
   `mail_action {action:'send', to, subject, body, attachment?}` (src/mailcmd.rs: Resend, or the user's
   own SMTP account, with credentials from the keychain). The page never sees a key. The READ-LIST is the user's own IMAP inbox
   through `mail_action {action:'inbox'|'mark_read'|'reply'|'open_client'}` (src/imapcmd.rs); `fakeFrame` survives
   only for the pure checks and is never mounted.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   1. one container inside the Ajustes body:  <section id="integrations-mail" hidden></section>
   2. one script tag after integrations-view.js:  <script src="integrations-mail.js" defer></script>
   With the container absent the module costs nothing. Styling: the append-only
   `.ml-*` block in style.css uses theme tokens only (light + dark).

   Loaded as a classic script (window.AbitoMail) and by
   test-node/integrations-mail-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoMail = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-mail/view/1';
  const MAX_MESSAGES = 20;
  const MAX_FROM = 40;
  const MAX_SUBJECT = 120;
  const MAX_BODY = 4000;
  const MAX_PREVIEW = 90;
  const MAX_TO = 254;
  const MAX_AGO = 60 * 24 * 365; // minutes
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  const SENT = 'Mensaje enviado.';
  const REFUSALS = Object.freeze({
    not_configured: 'Falta configurar el envío: guardá tu clave de Resend y el remitente, o tu cuenta SMTP, en Ajustes.',
    smtp_config: 'La cuenta SMTP no es válida: revisá el servidor y el remitente en Ajustes.',
    no_sender: 'Falta el remitente: guardalo en Ajustes.',
    keychain_unavailable: 'No se pudo leer el llavero del sistema.',
    rejected: 'El servicio de correo rechazó el mensaje: revisá las credenciales y el remitente.',
    network: 'No se pudo conectar con el servicio de correo.',
    failed: 'No se pudo enviar el mensaje.',
  });
  const INBOX_REFUSALS = Object.freeze({
    imap_not_configured: 'Falta configurar la bandeja: guardá el servidor IMAP, el usuario y la contraseña en Ajustes.',
    imap_config: 'La cuenta IMAP no es válida: revisá el servidor en Ajustes.',
    imap_auth: 'El servidor IMAP rechazó el usuario o la contraseña.',
    imap_tls: 'No se pudo establecer una conexión segura con el servidor IMAP.',
    imap_network: 'No se pudo conectar con el servidor IMAP.',
    imap_protocol: 'El servidor IMAP respondió algo inesperado.',
    keychain_unavailable: 'No se pudo leer el llavero del sistema.',
    failed: 'No se pudo leer la bandeja.',
  });
  const UID_MAX = 4294967295;
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
  const FIELDS = Object.freeze(['to', 'subject', 'body']);
  const FIELD_MAX = Object.freeze({ to: MAX_TO, subject: MAX_SUBJECT, body: MAX_BODY });
  // One plain address: no whitespace, one @, a dotted domain. Not a deliverability check.
  const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>.]+(\.[^\s@,;<>.]+)+$/;
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/; // refuses line breaks too
  const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/; // keeps \n and \t

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const chars = s => Array.from(s).length;
  const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));

  function agoLabel(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0) return null;
    if (minutes === 0) return 'ahora';
    if (minutes < 60) return `hace ${minutes} min`;
    if (minutes < 60 * 24) return `hace ${Math.floor(minutes / 60)} h`;
    return `hace ${Math.floor(minutes / (60 * 24))} d`;
  }

  // ---- store ------------------------------------------------------------------
  /** A closed `mail` frame to a frozen store; anything off-shape is null. */
  function storeFromFrame(frame) {
    if (!isObject(frame) || frame.type !== 'mail' || frame.schema !== SCHEMA) return null;
    if (!onlyKeys(frame, ['type', 'schema', 'fake', 'messages'])) return null;
    if (typeof frame.fake !== 'boolean' || !Array.isArray(frame.messages) || frame.messages.length > MAX_MESSAGES) return null;
    const seen = new Set();
    const messages = [];
    for (const m of frame.messages) {
      if (!isObject(m) || Object.keys(m).length !== 6 || !onlyKeys(m, ['id', 'from', 'subject', 'body', 'minutesAgo', 'read'])) return null;
      if (!isStr(m.id) || !ID_RE.test(m.id) || seen.has(m.id)) return null;
      if (!isStr(m.from) || !m.from.trim() || chars(m.from) > MAX_FROM || CONTROL.test(m.from)) return null;
      if (!isStr(m.subject) || !m.subject.trim() || chars(m.subject) > MAX_SUBJECT || CONTROL.test(m.subject)) return null;
      if (!isStr(m.body) || chars(m.body) > MAX_BODY || BODY_CONTROL.test(m.body)) return null;
      if (!Number.isInteger(m.minutesAgo) || m.minutesAgo < 0 || m.minutesAgo > MAX_AGO) return null;
      if (typeof m.read !== 'boolean') return null;
      seen.add(m.id);
      messages.push(Object.freeze({ id: m.id, from: m.from, subject: m.subject, body: m.body, minutesAgo: m.minutesAgo, read: m.read }));
    }
    return Object.freeze({ fake: frame.fake, messages: Object.freeze(messages), openId: null });
  }

  const isStore = s => isObject(s) && typeof s.fake === 'boolean' && Array.isArray(s.messages) &&
    (s.openId === null || isStr(s.openId));

  /** Opens one message. Like NotchBuddy, opening does NOT mark it read: that is the explicit «Marcar como leído». Unknown ids change nothing (null). */
  function openMessage(store, id) {
    if (!isStore(store) || !isStr(id)) return null;
    const at = store.messages.findIndex(m => m.id === id);
    if (at < 0) return null;
    return Object.freeze({ fake: store.fake, messages: store.messages, openId: id });
  }

  /** Marks one message read in the store (after the host confirmed it). Unknown ids change nothing (null). */
  function setRead(store, id) {
    if (!isStore(store) || !isStr(id)) return null;
    const at = store.messages.findIndex(m => m.id === id);
    if (at < 0) return null;
    const messages = store.messages.map((m, i) => (i === at ? Object.freeze({ ...m, read: true }) : m));
    return Object.freeze({ fake: store.fake, messages: Object.freeze(messages), openId: store.openId });
  }

  /** Back to the list; the read state stays. */
  function closeMessage(store) {
    if (!isStore(store)) return null;
    return Object.freeze({ fake: store.fake, messages: store.messages, openId: null });
  }

  const previewOf = body => {
    const flat = body.replace(/\s+/g, ' ').trim();
    const cps = Array.from(flat);
    return cps.length > MAX_PREVIEW ? `${cps.slice(0, MAX_PREVIEW - 1).join('')}…` : flat;
  };

  /** The closed projection for the renderer; null for anything that is not a store. */
  function view(store) {
    if (!isStore(store)) return null;
    const rows = store.messages.map(m => Object.freeze({
      id: m.id, from: m.from, subject: m.subject, preview: previewOf(m.body),
      ago: agoLabel(m.minutesAgo), read: m.read, open: m.id === store.openId }));
    const opened = store.messages.find(m => m.id === store.openId);
    return Object.freeze({
      fake: store.fake, banner: store.fake ? FAKE_BANNER : null,
      unread: rows.filter(r => !r.read).length, rows: Object.freeze(rows),
      open: opened ? Object.freeze({ id: opened.id, read: opened.read, from: opened.from, subject: opened.subject,
        body: opened.body, ago: agoLabel(opened.minutesAgo) }) : null,
    });
  }

  // ---- compose: a pure form model --------------------------------------------------
  const isDraft = d => isObject(d) && FIELDS.every(f => isStr(d[f])) && Object.keys(d).length === FIELDS.length;
  function createDraft() { return Object.freeze({ to: '', subject: '', body: '' }); }

  /** One field, immutably. Unknown fields, non-strings and over-long text are refused (null). */
  function setField(draft, field, value) {
    if (!isDraft(draft) || !FIELDS.includes(field) || !isStr(value) || chars(value) > FIELD_MAX[field]) return null;
    return Object.freeze({ ...draft, [field]: value });
  }

  /** `{ ok, errors }` with one Spanish message per failing field. */
  function validateDraft(draft) {
    const errors = {};
    if (!isDraft(draft)) return Object.freeze({ ok: false, errors: Object.freeze({ to: 'El borrador no es válido.' }) });
    const to = draft.to.replace(/^ +| +$/g, ''); // only plain spaces are forgiven; a pasted line break is an error
    // NotchBuddy only requires the recipient: an empty subject falls back to the file name, an empty body is sent as a space.
    if (!to.trim()) errors.to = 'Falta el destinatario.';
    else if (to.length > MAX_TO || CONTROL.test(to) || !ADDRESS_RE.test(to)) errors.to = 'El destinatario no es una dirección válida.';
    if (CONTROL.test(draft.subject)) errors.subject = 'El asunto no admite saltos de línea ni caracteres de control.';
    if (BODY_CONTROL.test(draft.body)) errors.body = 'El mensaje contiene caracteres de control.';
    return Object.freeze({ ok: Object.keys(errors).length === 0, errors: Object.freeze(errors) });
  }

  /** A picked file to the closed `{name,data}` (base64 of the bytes); empty, oversized or unnamed → null. */
  function attachmentFromBytes(name, bytes) {
    if (!isStr(name) || !name.trim() || !bytes || !Number.isInteger(bytes.length) || bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) return null;
    const base = name.split(/[\\/]/).pop();
    if (!base.trim() || typeof btoa !== 'function' && typeof Buffer === 'undefined') return null;
    let data;
    if (typeof Buffer !== 'undefined') data = Buffer.from(bytes).toString('base64');
    else { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); data = btoa(bin); }
    return Object.freeze({ name: base, data });
  }

  const refusal = reason => Object.freeze({ ok: false, reason, message: REFUSALS[reason] });

  /**
   * Validates, then asks the host to send. `invoke` is Tauri's; the answer is closed
   * ({ok:true} or {ok:false, reason}); anything else, or a throw, is a plain «failed».
   * An invalid draft never reaches the host.
   */
  async function send(draft, attachment, invoke) {
    const v = validateDraft(draft);
    if (!v.ok) return Object.freeze({ ok: false, reason: 'invalid', errors: v.errors });
    if (typeof invoke !== 'function') return refusal('failed');
    const payload = { action: 'send', to: draft.to.replace(/^ +| +$/g, ''), subject: draft.subject, body: draft.body };
    if (attachment) payload.attachment = { name: attachment.name, data: attachment.data };
    let answer;
    try { answer = await invoke('mail_action', { payload }); } catch (_) { return refusal('failed'); }
    if (isObject(answer) && answer.ok === true && Object.keys(answer).length === 1) return Object.freeze({ ok: true, message: SENT });
    if (isObject(answer) && answer.ok === false && Object.keys(answer).length === 2 && isStr(answer.reason) &&
      Object.prototype.hasOwnProperty.call(REFUSALS, answer.reason) && answer.reason !== 'failed') return refusal(answer.reason);
    return refusal('failed');
  }

  // ---- live inbox (IMAP through the closed host verb) ---------------------------------------
  const isUid = u => Number.isInteger(u) && u >= 1 && u <= UID_MAX;
  /** A closed `inbox` answer → { frame (real, not fake), meta: id → { uid, address } }; anything off-shape is null. */
  function inboxFromAnswer(a) {
    if (!isObject(a) || a.ok !== true || !onlyKeys(a, ['ok', 'messages']) || !Array.isArray(a.messages) || a.messages.length > MAX_MESSAGES) return null;
    const meta = {};
    const messages = [];
    for (const m of a.messages) {
      if (!isObject(m) || Object.keys(m).length !== 7 || !onlyKeys(m, ['uid', 'from', 'address', 'subject', 'preview', 'minutesAgo', 'read'])) return null;
      if (!isUid(m.uid) || !isStr(m.address) || chars(m.address) > MAX_TO || CONTROL.test(m.address) || typeof m.read !== 'boolean') return null;
      const id = `u${m.uid}`;
      if (Object.prototype.hasOwnProperty.call(meta, id)) return null;
      meta[id] = Object.freeze({ uid: m.uid, address: m.address });
      messages.push({ id, from: m.from, subject: m.subject, body: m.preview, minutesAgo: m.minutesAgo, read: m.read });
    }
    const frame = { type: 'mail', schema: SCHEMA, fake: false, messages };
    return storeFromFrame(frame) ? Object.freeze({ frame, meta: Object.freeze(meta) }) : null;
  }
  const inboxRefusal = reason => Object.freeze({ ok: false, reason, message: INBOX_REFUSALS[reason] });
  async function call(invoke, payload) {
    if (typeof invoke !== 'function') return undefined;
    try { return await invoke('mail_action', { payload }); } catch (_) { return undefined; }
  }
  async function loadInbox(invoke) {
    const a = await call(invoke, { action: 'inbox' });
    const live = inboxFromAnswer(a);
    if (live) return Object.freeze({ ok: true, frame: live.frame, meta: live.meta });
    if (isObject(a) && a.ok === false && Object.keys(a).length === 2 && isStr(a.reason) &&
      Object.prototype.hasOwnProperty.call(INBOX_REFUSALS, a.reason) && a.reason !== 'failed') return inboxRefusal(a.reason);
    return inboxRefusal('failed');
  }
  const okAnswer = a => Object.freeze({ ok: isObject(a) && a.ok === true && Object.keys(a).length === 1 });
  async function markRead(invoke, uid) { return isUid(uid) ? okAnswer(await call(invoke, { action: 'mark_read', uid })) : okAnswer(null); }
  async function reply(invoke, to, subject) {
    if (!isStr(to) || !ADDRESS_RE.test(to) || !isStr(subject) || chars(subject) > MAX_SUBJECT || CONTROL.test(subject)) return okAnswer(null);
    return okAnswer(await call(invoke, { action: 'reply', to, subject }));
  }
  async function openClient(invoke) { return okAnswer(await call(invoke, { action: 'open_client' })); }

  // ---- fake provider (LOUD, deterministic, no network) ------------------------
  const FAKE_MESSAGES = Object.freeze([
    ['m1', 'Lucía Fernández', 'Reunión del jueves', 'Hola, te confirmo la reunión del jueves a las 10. Llevá el resumen del trimestre así lo repasamos juntos.', 6, false],
    ['m2', 'Equipo de Facturación', 'Tu factura de ejemplo está lista', 'Adjuntamos la factura de ejemplo del mes. Este mensaje es de muestra y no corresponde a ninguna cuenta real.', 52, false],
    ['m3', 'Martín Gómez', 'Re: presupuesto', 'Gracias por la propuesta. Lo charlamos con el equipo y te respondo mañana.', 190, true],
    ['m4', 'Soporte Ejemplo', 'Tu consulta fue recibida', 'Recibimos tu consulta y la estamos revisando. Mensaje de muestra.', 1500, true],
  ]);
  function fakeFrame() {
    return { type: 'mail', schema: SCHEMA, fake: true,
      messages: FAKE_MESSAGES.map(([id, from, subject, body, minutesAgo, read]) => ({ id, from, subject, body, minutesAgo, read })) };
  }

  // ---- renderer (textContent only; events live in mount) -----------------------
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
    if (id) b.dataset.id = id;
    return b;
  };
  const field = (name, label, control, error) => {
    const wrap = el('div', 'ml-field');
    const lab = el('label', 'ml-label', label);
    control.id = `ml-${name}`;
    control.name = name;
    control.dataset.field = name;
    lab.htmlFor = control.id;
    wrap.append(lab, control);
    if (error) {
      const err = el('p', 'ml-error', error);
      err.id = `ml-${name}-error`;
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', err.id);
      wrap.append(err);
    }
    return wrap;
  };

  /** `result` is the last send() outcome (or null); the draft re-fills the form. */
  function render(host, v, draft, result, attachment, sending, inbox, canReply) {
    if (!(host && typeof host.appendChild === 'function')) return;
    host.textContent = '';
    if (!v || !Array.isArray(v.rows)) { host.hidden = true; return; }
    host.hidden = false;
    const d = isDraft(draft) ? draft : createDraft();
    const errors = result && result.reason === 'invalid' ? result.errors : {};
    const head = el('div', 'ml-head');
    head.append(el('span', 'ml-title', 'Mail'), el('span', 'ml-unread', `${v.unread} sin leer`), button('ml-refresh', 'refresh', 'Actualizar'));
    host.append(head);
    if (inbox && inbox.note) { const n = el('p', 'ml-refusal', inbox.note); n.setAttribute('role', 'status'); host.append(n); }
    if (v.banner) host.append(el('p', 'ml-fake', v.banner));
    else if (!v.rows.length && !(inbox && inbox.note)) host.append(el('p', 'ml-empty', inbox && inbox.loading ? 'Cargando…' : 'No hay mensajes.'));
    if (v.open) {
      const art = el('article', 'ml-open');
      art.append(el('h3', 'ml-open-subject', v.open.subject),
        el('p', 'ml-open-meta', `${v.open.from} · ${v.open.ago}`),
        el('p', 'ml-open-body', v.open.body));
      if (!v.open.read && canReply) art.append(button('ml-markread', 'markread', 'Marcar como leído'));
      if (canReply) art.append(button('ml-reply', 'reply', 'Responder'));
      art.append(button('ml-client', 'client', 'Abrir el correo'), button('ml-back', 'close', 'Volver a la lista'));
      host.append(art);
    } else {
      const list = el('ul', 'ml-list');
      for (const r of v.rows) {
        const li = el('li', 'ml-item');
        const b = button(`ml-row${r.read ? '' : ' ml-row--unread'}`, 'open', null, r.id);
        b.append(el('span', 'ml-row-from', r.from), el('span', 'ml-row-ago', r.ago),
          el('span', 'ml-row-subject', r.subject), el('span', 'ml-row-preview', r.preview));
        li.append(b);
        list.append(li);
      }
      host.append(list);
    }
    const form = el('form', 'ml-compose');
    form.noValidate = true;
    form.setAttribute('aria-label', 'Redactar mensaje');
    form.append(el('h3', 'ml-compose-title', 'Redactar'));
    const to = el('input'); to.type = 'text'; to.value = d.to; to.maxLength = MAX_TO; to.autocomplete = 'off';
    const subject = el('input'); subject.type = 'text'; subject.value = d.subject; subject.maxLength = MAX_SUBJECT;
    const body = el('textarea'); body.value = d.body; body.maxLength = MAX_BODY; body.rows = 4;
    form.append(field('to', 'Para', to, errors.to), field('subject', 'Asunto', subject, errors.subject),
      field('body', 'Mensaje', body, errors.body));
    const pick = el('input'); pick.type = 'file'; pick.dataset.field = 'attachment'; pick.id = 'ml-attachment';
    const pickLabel = el('label', 'ml-label', 'Adjunto'); pickLabel.htmlFor = pick.id;
    const pickWrap = el('div', 'ml-field'); pickWrap.append(pickLabel, pick);
    if (attachment) pickWrap.append(el('p', 'ml-attached', attachment.name));
    form.append(pickWrap);
    const send = el('button', 'ml-send', sending ? 'Enviando…' : 'Enviar');
    send.type = 'submit';
    send.disabled = !!sending;
    form.append(send);
    if (result && result.message) {
      const note = el('p', result.ok ? 'ml-sent' : 'ml-refusal', result.message);
      note.setAttribute('role', 'status');
      form.append(note);
    }
    host.append(form);
  }

  return { SCHEMA, MAX_MESSAGES, MAX_FROM, MAX_SUBJECT, MAX_BODY, MAX_PREVIEW, MAX_TO,
    storeFromFrame, openMessage, setRead, closeMessage, view, createDraft, setField, validateDraft, send, attachmentFromBytes, MAX_ATTACHMENT_BYTES, inboxFromAnswer, loadInbox, markRead, reply, openClient, fakeFrame, render };
});

// ---- browser-only wiring: self-mount into #integrations-mail, FAKE provider only ----
function mount(V) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-mail');
  if (!host) return; // inert until index.html carries the container (mount contract)
  let store = V.storeFromFrame({ type: 'mail', schema: V.SCHEMA, fake: false, messages: [] });
  let meta = {};
  let inbox = { note: '', loading: true };
  let polling = false;
  let draft = V.createDraft();
  let result = null;
  let attachment = null;
  let sending = false;
  const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || (internals && internals.invoke);
  const paint = () => V.render(host, V.view(store), draft, result, attachment, sending, inbox, !!(store.openId && meta[store.openId] && meta[store.openId].address));
  async function refresh() {
    if (polling) return;
    polling = true;
    const r = await V.loadInbox(invoke);
    polling = false;
    if (r.ok) {
      const next = V.storeFromFrame(r.frame);
      const keep = store.openId && next.messages.some(m => m.id === store.openId) ? store.openId : null;
      store = keep ? V.openMessage(next, keep) : next;
      meta = r.meta; inbox = { note: '', loading: false };
    } else {
      inbox = { note: r.message, loading: false, stop: r.reason === 'imap_not_configured' };
    }
    paint();
  }
  const visible = () => !host.hidden && typeof document !== 'undefined' && document.visibilityState !== 'hidden' && host.offsetParent !== null;
  setInterval(() => { if (visible() && !(inbox && inbox.stop)) refresh(); }, 60000);
  setTimeout(() => { if (visible()) refresh(); }, 0);

  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const t = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-action]') : null;
    if (!t || !host.contains(t)) return;
    const action = t.dataset.action;
    if (action === 'refresh') { inbox = { note: '', loading: true }; refresh(); return; }
    if (action === 'markread') {
      const id = store.openId;
      if (id && meta[id]) V.markRead(invoke, meta[id].uid).then(r => { if (r.ok) { const n = V.setRead(store, id); if (n) { store = n; paint(); } } });
      return;
    }
    if (action === 'client') { V.openClient(invoke); return; }
    if (action === 'reply') {
      const m = store.messages.find(x => x.id === store.openId);
      const info = m && meta[m.id];
      if (info && info.address) V.reply(invoke, info.address, m.subject);
      return;
    }
    const next = action === 'open' ? V.openMessage(store, t.dataset.id)
      : action === 'close' ? V.closeMessage(store) : null;
    if (next) { store = next; paint(); }
  });
  host.addEventListener('input', e => {
    if (!e || e.isTrusted !== true || !e.target || !e.target.dataset) return;
    const next = V.setField(draft, e.target.dataset.field, e.target.value);
    if (next) draft = next;
  });
  host.addEventListener('change', e => {
    if (!e || e.isTrusted !== true || !e.target || !e.target.dataset || e.target.dataset.field !== 'attachment') return;
    const file = e.target.files && e.target.files[0];
    if (!file) { attachment = null; paint(); return; }
    if (file.size < 1 || file.size > V.MAX_ATTACHMENT_BYTES) { attachment = null; result = { ok: false, reason: 'failed', message: 'El adjunto está vacío o supera los 10 MB.' }; paint(); return; }
    file.arrayBuffer().then(buf => {
      attachment = V.attachmentFromBytes(file.name, new Uint8Array(buf));
      result = attachment ? null : { ok: false, reason: 'failed', message: 'No se pudo leer el adjunto.' };
      if (!draft.subject.trim() && attachment) draft = V.setField(draft, 'subject', attachment.name.slice(0, V.MAX_SUBJECT)) || draft;
      paint();
    }, () => { attachment = null; paint(); });
  });
  host.addEventListener('submit', e => {
    if (e) e.preventDefault(); // never a navigation
    if (!e || e.isTrusted !== true || sending) return;
    sending = true; result = null; paint();
    V.send(draft, attachment, invoke).then(r => {
      sending = false; result = r;
      if (r.ok) { draft = V.createDraft(); attachment = null; }
      paint();
    });
  });
  paint();
}
