'use strict';
/* K2-10 T5 (S1, S2, S3, S5, S6, S7, S9, S12) — the GMAIL card of the island's icon row (design/k2-09-atajos/08-isla-unida.html
   «Gmail · solo lo nuevo», boards 2, 2b, 3 and 3c). One file, the house pattern (spotify-view.js): a PURE model first (Node-testable,
   no DOM), a textContent-only renderer and a browser-only mount at the tail.

   WHAT IT IS: the read-only mail of the island. The head says «N nuevos · M sin leer» (the icon counts «nuevos»: what arrived since
   the last visit), four filters — Nuevos · Importantes · De personas · Todos, Nuevos by default — and up to 20 rows of sender,
   subject and a one-line preview. Opening a row shows the message as PLAIN TEXT (the host already turned HTML into text with
   `**bold**`, `- list` and link chips); every link is a chip with its REAL domain and one whose domain is not the sender's asks
   before opening (3c). «Responder» hands a `mailto:` to the host, which opens the user's own mail client (S2, decision 7b). There is
   NO «Marcar como leído»: Gmail stays read-only (S5), and nothing here writes: the card only reads.

   S3 (criterion 3): with no connection, on `no_client`, `signed_out` or `reconnect` there is NO icon and NO card, and there is
   never a sample row. `available()` is true ONLY for the host's `connected`.

   Wire (src/gmailcmd.rs, `gmail_action`, ONE closed verb — host src/gmailhost.rs):
     {action:'status'}                         -> {ok, state:'no_client'|'signed_out'|'connected'|'reconnect', clientId, hasSecret}
     {action:'inbox', filter}                  -> {ok, messages:[Summary], newCount, newCountCapped, unreadCount, lastSeenMs}
     {action:'message', id}                    -> {ok, detail:{body, links:[{text,url,domain,sameAsSender}], ...}}
     {action:'reply', id}                      -> {ok, opened} (the HOST opens the mail client)
     {action:'seen', atMs}                     -> {ok, lastSeenMs} (the page asks; the host stores the mark in prefs)
   Links leave through the EXISTING validated opener `open_chat_url` (desktop::validated_web_url: credential-free http/https),
   never a raw navigation: `safeUrl` mirrors it, the host re-validates.

   Mount contract (island-shortcuts.js, S12): registerCard({id:'gmail', label:'Gmail', icon:'mail', available, mount, badge}).
   The mount paints #nusa-card when the icon is focused and returns its unmount (timers and listeners stop there). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoGmailView = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // S5/S12 — the four filters of the design, IN THIS ORDER, Nuevos by default. `id` is the closed host value.
  const FILTERS = Object.freeze([
    Object.freeze({ id: 'nuevos', label: 'Nuevos' }),
    Object.freeze({ id: 'importantes', label: 'Importantes' }),
    Object.freeze({ id: 'personas', label: 'De personas' }),
    Object.freeze({ id: 'todos', label: 'Todos' }),
  ]);
  const FILTER_IDS = Object.freeze(FILTERS.map(f => f.id));
  const DEFAULT_FILTER = 'nuevos';
  // The four states the host answers (gmail_oauth::Status); only `connected` has mail to show.
  const STATUSES = Object.freeze(['no_client', 'signed_out', 'connected', 'reconnect']);
  const EMPTY = Object.freeze({
    nuevos: 'No tenés correos nuevos',
    importantes: 'No tenés correos importantes',
    personas: 'No tenés correos de personas',
    todos: 'No hay correos en tu bandeja',
  });
  // One Spanish line per stable host code: never a token, never a body of an HTTP error, never the raw code.
  const ERRORS = Object.freeze({
    network: 'No pude traer tus correos. Revisá tu conexión y reintentá en un rato.',
    rate_limited: 'Gmail pidió esperar un momento. Reintentá en un rato.',
    forbidden: 'Google no dejó leer el correo con ese permiso.',
    needs_sign_in: 'Volvé a conectar Gmail desde Ajustes.',
    keychain: 'No pude leer tu conexión de Gmail del llavero.',
    prefs: 'No pude guardar la hora de tu última visita.',
    server: 'Gmail falló del lado de Google. Reintentá en un rato.',
    invalid: 'No pude entender la respuesta de Gmail. Reintentá en un rato.',
    failed: 'No pude traer tus correos. Reintentá en un rato.',
  });
  // Design 3c: «Cancelar» (focus starts here, Esc too) and «Abrir» (the one primary action).
  const CONFIRM = Object.freeze({ yes: 'Abrir', no: 'Cancelar' });
  const REFRESH_MS = 60000;   // the list refreshes every minute while the card is on screen (design 2b: «nuevos» moves)
  const STATUS_MS = 15000;    // the connection is read again slowly, so the icon appears/disappears on its own
  const MAX_ROWS = 20;        // gmail_api::MAX_MESSAGES: the host pages 20, the card never paints more
  const MAX_LINKS = 30;       // gmail_api::MAX_LINKS
  const MAX_ID = 64;          // gmailcmd::MAX_ID
  const MAX_PREVIEW = 120;
  const MAX_TEXT = 160;
  const BADGE_CAP = 100;      // newCountCapped: the icon paints a NUMBER (island-shortcuts-mount.js), so «100+» reads 100
  const CONTROL = /[\u0000-\u001f\u007f]/g;

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  /** One line of plain text: control characters out, whitespace collapsed, bounded. */
  const clean = (v, max = MAX_TEXT) => (isStr(v) ? [...v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '');
  const count = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const pad = n => String(n).padStart(2, '0');

  // ---- the closed payloads ------------------------------------------------------------------
  const statusPayload = () => ({ action: 'status' });
  /** The filter is one of the four; anything else falls back to the default rather than being sent. */
  function inboxPayload(filter) { return { action: 'inbox', filter: FILTER_IDS.includes(filter) ? filter : DEFAULT_FILTER }; }
  const idOk = id => isStr(id) && id.length > 0 && id.length <= MAX_ID && /^[A-Za-z0-9_-]+$/.test(id);
  const messagePayload = id => (idOk(id) ? { action: 'message', id } : null);
  const replyPayload = id => (idOk(id) ? { action: 'reply', id } : null);
  /** 0 is «never visited», not a visit: it could only un-count mail as new (gmailcmd::parse). */
  const seenPayload = atMs => (Number.isInteger(atMs) && atMs > 0 ? { action: 'seen', atMs } : null);

  // ---- the closed answers -------------------------------------------------------------------
  const statusAnswer = a => (isObject(a) && a.ok === true && STATUSES.includes(a.state) ? Object.freeze({ state: a.state }) : null);
  const refusal = answer => {
    const reason = isObject(answer) && answer.ok === false && isStr(answer.reason) && Object.prototype.hasOwnProperty.call(ERRORS, answer.reason)
      ? answer.reason : 'failed';
    return Object.freeze({ ok: false, reason, message: ERRORS[reason] });
  };
  const errorText = code => (isStr(code) && Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : ERRORS.failed);
  /** S3/S12: the card exists ONLY for a real connection. */
  const available = state => state === 'connected';
  /** S12: the icon counts «nuevos»; a capped page is the cap itself (the mount paints a number). */
  const badgeOf = inbox => (isObject(inbox) && inbox.newCountCapped === true ? BADGE_CAP : count(isObject(inbox) ? inbox.newCount : 0));
  /** S5: «4 nuevos · 128 sin leer» — 128 sin leer is said in small text, never as the icon's count. */
  function counterHead(inbox) {
    const o = isObject(inbox) ? inbox : {};
    const n = count(o.newCount), u = count(o.unreadCount), capped = o.newCountCapped === true;
    const nuevo = capped ? `${BADGE_CAP}+` : String(n);
    return Object.freeze({ nuevo: `${nuevo} ${n === 1 && !capped ? 'nuevo' : 'nuevos'}`, unread: `${u} sin leer` });
  }
  function counterText(inbox) { const head = counterHead(inbox); return `${head.nuevo} · ${head.unread}`; }

  /** Today is the clock, yesterday is «ayer», older is d/m (the design shows the hour and «ayer»). */
  function whenText(dateMs, nowMs) {
    const t = Number(dateMs);
    if (!Number.isFinite(t) || t <= 0) return '';
    const d = new Date(t);
    const now = Number.isFinite(Number(nowMs)) ? new Date(Number(nowMs)) : new Date();
    if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'ayer';
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }

  /** One row: sender, subject, a ONE-LINE preview, its time, whether it is unread, and what a screen reader says. */
  function rowView(summary, nowMs) {
    const m = isObject(summary) ? summary : {};
    const from = clean(m.from, 80) || clean(m.address, 120) || 'Sin remitente';
    const subject = clean(m.subject) || '(Sin asunto)';
    const when = whenText(m.dateMs, nowMs);
    const unread = m.unread === true;
    const aria = [unread ? 'Sin leer' : 'Leído', m.important === true ? 'importante' : '', `${from}, ${subject}${when ? `, ${when}` : ''}`]
      .filter(Boolean).join(', ');
    return Object.freeze({ id: clean(m.id, MAX_ID), from, subject, preview: clean(m.snippet, MAX_PREVIEW), when, unread, important: m.important === true, aria });
  }

  /** The inbox answer -> what the card paints (or the honest reason it cannot). */
  function rowsOf(answer, nowMs, filterId) {
    const filter = FILTER_IDS.includes(filterId) ? filterId : DEFAULT_FILTER;
    if (!isObject(answer) || answer.ok !== true || !Array.isArray(answer.messages)) return refusal(answer);
    const rows = answer.messages.filter(isObject).slice(0, MAX_ROWS).map(m => rowView(m, nowMs));
    const newCount = count(answer.newCount), unreadCount = count(answer.unreadCount), newCountCapped = answer.newCountCapped === true;
    return Object.freeze({
      ok: true, filter, rows, newCount, newCountCapped, unreadCount,
      lastSeenMs: count(answer.lastSeenMs),
      counter: counterText({ newCount, newCountCapped, unreadCount }),
      empty: rows.length === 0,
      emptyText: EMPTY[filter],
    });
  }

  // ---- S6: the plain-text body and the link chips -------------------------------------------
  /** `**bold**` runs inside one line; nothing else is interpreted (the host converted the HTML already). */
  function runsOf(line) {
    const runs = [];
    const re = /\*\*([^*]+)\*\*/g;
    let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) runs.push({ text: line.slice(last, m.index), bold: false });
      runs.push({ text: m[1], bold: true });
      last = m.index + m[0].length;
    }
    if (last < line.length) runs.push({ text: line.slice(last), bold: false });
    if (!runs.length) runs.push({ text: line, bold: false });
    return runs;
  }
  /** S6: one block per non-empty line — a list item when the line starts with `-`/`•`, a paragraph otherwise. */
  function bodyBlocks(text) {
    if (!isStr(text) || !text) return [];
    const blocks = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      const bullet = /^\s*[-•]\s+/.test(line);
      blocks.push({ kind: bullet ? 'li' : 'p', runs: runsOf(bullet ? line.replace(/^\s*[-•]\s+/, '') : line.trim()) });
    }
    return blocks;
  }

  /** The same rules the host's `desktop::validated_web_url` applies: credential-free http(s), bounded, no control/space. */
  function safeUrl(raw) {
    if (!isStr(raw) || !raw || raw.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
    let url;
    try { url = new URL(raw); } catch { return null; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
    return url.href;
  }
  const hostOf = href => { try { return new URL(href).hostname; } catch { return ''; } };
  /** S7: the chip shows the REAL domain, never the anchor text. A non-http link is not a chip at all. */
  function linkView(link) {
    if (!isObject(link)) return null;
    const url = safeUrl(link.url);
    if (!url) return null;
    const domain = clean(link.domain, 100) || hostOf(url);
    return Object.freeze({ label: domain, url, domain, text: clean(link.text, MAX_PREVIEW), sameAsSender: link.sameAsSender === true });
  }
  /** `lucia.perez@estudiolua.es` -> `estudiolua.es` (the host decides `sameAsSender`; this only says WHO it was). */
  function senderDomain(address) {
    const a = clean(address, 200);
    const at = a.lastIndexOf('@');
    return at > 0 && at < a.length - 1 ? a.slice(at + 1).toLowerCase() : '';
  }
  const confirmText = (domain, sender) => (sender
    ? `Este enlace va a ${domain}, no a ${sender} · ¿Abrirlo igual?`
    : `Este enlace va a ${domain} · ¿Abrirlo igual?`);

  /**
   * S7 (design 3c): `sameAsSender` is the HOST's verdict (a subdomain of the sender counts). True opens directly; false asks
   * first, whatever the URL looks like; anything that is not a credential-free http(s) URL never opens.
   */
  function openAction(link, senderAddress) {
    const chip = linkView(link);
    if (!chip) return { kind: 'refuse' };
    if (chip.sameAsSender) return { kind: 'open', url: chip.url };
    const sender = senderDomain(senderAddress);
    return { kind: 'confirm', url: chip.url, domain: chip.domain, text: confirmText(chip.domain, sender) };
  }

  /** The detail answer -> the opened-message card (plain text, chips, and what «Responder» needs). */
  function detailView(detail, nowMs) {
    const d = isObject(detail) ? detail : {};
    const from = clean(d.from, 80) || clean(d.address, 120) || 'Sin remitente';
    const links = Array.isArray(d.links) ? d.links.map(linkView).filter(Boolean).slice(0, MAX_LINKS) : [];
    return Object.freeze({
      id: clean(d.id, MAX_ID), from, address: clean(d.address, 120),
      initials: (from.trim()[0] || '?').toUpperCase(),
      subject: clean(d.subject) || '(Sin asunto)',
      when: whenText(d.dateMs, nowMs),
      replySubject: clean(d.replySubject),
      blocks: bodyBlocks(d.body), links,
      bodyTruncated: d.bodyTruncated === true,
      unread: d.unread === true,
    });
  }
  function messageAnswer(answer, nowMs) {
    if (!isObject(answer) || answer.ok !== true || !isObject(answer.detail)) return refusal(answer);
    return Object.freeze({ ok: true, detail: detailView(answer.detail, nowMs) });
  }

  // ---- the controller: every host call of the card, injectable, no DOM ----------------------
  /**
   * `invoke` is the island's own bridge, `now` the clock, `open` the shared opener (the mount hands `open_chat_url`).
   * Every method answers a closed view; nothing here touches the DOM, so the whole lifecycle is Node-testable.
   */
  function controller(deps) {
    const options = isObject(deps) ? deps : {};
    const invoke = typeof options.invoke === 'function' ? options.invoke : null;
    const clock = typeof options.now === 'function' ? options.now : () => Date.now();
    const open = typeof options.open === 'function' ? options.open : null;
    let state = null, filter = DEFAULT_FILTER, pending = null;
    let counts = Object.freeze({ newCount: 0, newCountCapped: false, unreadCount: 0 });
    const call = payload => {
      if (!invoke || !payload) return Promise.resolve(undefined);
      try { return Promise.resolve(invoke('gmail_action', { payload })).catch(() => undefined); } catch { return Promise.resolve(undefined); }
    };
    const ctl = {
      state: () => state,
      filter: () => filter,
      available: () => available(state),
      /** S12: the icon's counter — 0 with no connection, «nuevos» otherwise. */
      badge: () => (available(state) ? badgeOf(counts) : 0),
      /** Reads the connection (the island's slow timer and every time it is shown); the card wakes the row when it moves. */
      async status() {
        const view = statusAnswer(await call(statusPayload()));
        state = view ? view.state : null;
        if (!available(state)) counts = Object.freeze({ newCount: 0, newCountCapped: false, unreadCount: 0 });
        return state;
      },
      async inbox(next) {
        if (FILTER_IDS.includes(next)) filter = next;
        const view = rowsOf(await call(inboxPayload(filter)), clock(), filter);
        if (view.ok) counts = Object.freeze({ newCount: view.newCount, newCountCapped: view.newCountCapped, unreadCount: view.unreadCount });
        return view;
      },
      /** S5: «visto» lives only in this machine; the host stores the mark, monotonic and never in the future. */
      async seen() {
        const payload = seenPayload(clock());
        if (!payload) return false;
        const answer = await call(payload);
        return isObject(answer) && answer.ok === true;
      },
      /** The list, shown, and ONLY THEN the visit is stamped (a failed load is not a visit). */
      async showList(next) {
        const view = await ctl.inbox(next);
        if (view.ok) await ctl.seen();
        return view;
      },
      async openMessage(id) {
        const payload = messagePayload(id);
        if (!payload) return refusal({ ok: false, reason: 'invalid' });
        return messageAnswer(await call(payload), clock());
      },
      /** S2: the HOST builds the `mailto:` and opens the user's own mail client; the page never composes. */
      async reply(id) {
        const payload = replyPayload(id);
        if (!payload) return refusal({ ok: false, reason: 'invalid' });
        const answer = await call(payload);
        if (isObject(answer) && answer.ok === true) return Object.freeze({ ok: true, opened: answer.opened === true });
        return refusal(answer);
      },
      /** S7: opens the sender's own domain straight away; another domain becomes a question (`pendingView`). */
      openLink(link, senderAddress) {
        const action = openAction(link, senderAddress);
        if (action.kind === 'open') ctl.openNow(action.url);
        else if (action.kind === 'confirm') pending = action;
        return action;
      },
      openNow(url) {
        const safe = safeUrl(url);
        if (!safe || !open) return false;
        try { open(safe); return true; } catch { return false; }
      },
      pendingView: () => pending,
      confirmPending() { const p = pending; pending = null; return p ? ctl.openNow(p.url) : false; },
      cancelPending() { const had = !!pending; pending = null; return had; },
    };
    return ctl;
  }

  /** S12: the definition `AbitoShortcuts.registerCard` takes, plus the controller so a test can drive it. */
  function makeCard(deps) {
    const ctl = controller(deps);
    const def = {
      id: 'gmail', label: 'Gmail', icon: 'mail',
      available: () => ctl.available(),
      badge: () => ctl.badge(),
      mount: el => paintCard(el, ctl),
    };
    return { def, ctl };
  }

  // ---- renderer: textContent and DOM nodes only (never innerHTML), no image, nothing remote ---
  const mk = (doc, tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  const button = (doc, cls, text, name) => {
    const b = mk(doc, 'button', cls, text);
    b.type = 'button';
    if (name) b.dataset.action = name;
    return b;
  };

  /**
   * Paints the card into `el` (#nusa-card) and returns its unmount. The returned function also carries
   * `.refresh()` so the browser wrapper can re-read the list on its own timer and on window focus.
   */
  function paintCard(el, ctl) {
    if (typeof document === 'undefined' || !el) return () => {};
    const doc = document;
    const root = mk(doc, 'section', 'gm');
    root.setAttribute('aria-label', 'Gmail');
    const head = mk(doc, 'div', 'gm-head');
    const sum = mk(doc, 'span', 'gm-sum');
    const seg = mk(doc, 'span', 'gm-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Qué correos ver');
    const chips = new Map();
    for (const f of FILTERS) {
      const b = button(doc, 'gm-flt', f.label);
      b.dataset.filter = f.id;
      b.setAttribute('aria-pressed', String(f.id === DEFAULT_FILTER));
      b.addEventListener('click', e => { if (e.isTrusted !== true) return; load(f.id); });
      chips.set(f.id, b);
      seg.append(b);
    }
    head.append(sum, seg);
    const list = mk(doc, 'div', 'gm-list');
    list.setAttribute('role', 'list');
    const empty = mk(doc, 'p', 'gm-empty');
    empty.hidden = true;
    const problem = mk(doc, 'p', 'gm-problem');
    problem.hidden = true;
    problem.setAttribute('role', 'status');
    const openPage = mk(doc, 'section', 'gm-msg');
    openPage.hidden = true;
    openPage.setAttribute('aria-label', 'Correo abierto');
    root.append(head, list, empty, problem, openPage);
    el.replaceChildren(root);

    const state = { filter: DEFAULT_FILTER, message: null, question: null, ticket: 0 };
    const show = (node, on) => { node.hidden = !on; };
    const pressed = id => { for (const [key, b] of chips) b.setAttribute('aria-pressed', String(key === id)); };
    /** The design's head: «4 nuevos» in white bold, «· 128 sin leer» muted, on one line. */
    function paintSum(counts) {
      const parts = counterHead(counts);
      sum.replaceChildren(mk(doc, 'b', 'gm-new', parts.nuevo), mk(doc, 'span', 'gm-say', ` · ${parts.unread}`));
      sum.title = `${parts.nuevo} · ${parts.unread}`;
    }

    function fail(text) {
      problem.textContent = text;
      show(problem, true);
      list.replaceChildren();
      show(list, false);
      show(empty, false);
    }
    /** S3: an empty inbox paints the Spanish line of that filter and NOTHING else (never a sample row). */
    function noMail(text) {
      problem.textContent = '';
      show(problem, false);
      list.replaceChildren();
      show(list, false);
      empty.textContent = text;
      show(empty, true);
    }
    /** S1/S5: up to 20 rows; an unread row keeps its dot and its weight. */
    function paintRows(view) {
      show(openPage, false);
      state.message = null;
      state.question = null;
      ctl.cancelPending();
      paintSum(view);
      pressed(view.filter);
      if (view.empty) { noMail(view.emptyText); return; }
      problem.textContent = '';
      show(problem, false);
      show(empty, false);
      const rows = view.rows.map(row => {
        const b = button(doc, row.unread ? 'gm-row gm-un' : 'gm-row');
        b.dataset.id = row.id;
        b.setAttribute('role', 'listitem');
        b.setAttribute('aria-label', row.aria);
        b.title = row.aria;
        b.append(mk(doc, 'i', row.unread ? 'gm-dot' : 'gm-dot off'));
        b.append(mk(doc, 'span', 'gm-r1', row.from), mk(doc, 'span', 'gm-r2', row.subject), mk(doc, 'span', 'gm-r3', row.when));
        b.addEventListener('click', e => { if (e.isTrusted !== true) return; openMessage(row.id); });
        return b;
      });
      list.replaceChildren(...rows);
      show(list, true);
    }
    /** S5: the list of a filter; the visit is stamped by the controller once the rows are on screen. */
    async function load(next) {
      const ticket = ++state.ticket;
      state.filter = FILTER_IDS.includes(next) ? next : state.filter;
      const view = await ctl.showList(state.filter);
      if (ticket !== state.ticket) return; // a later filter won: never paint a stale answer
      if (view.ok) paintRows(view); else fail(view.message);
    }
    const refresh = () => { if (state.message === null) load(state.filter); };

    // ---- S6: the opened message, plain text with chips -------------------------------
    function paintText(blocks) {
      const body = mk(doc, 'div', 'gm-body');
      for (const block of blocks) {
        const line = mk(doc, block.kind === 'li' ? 'div' : 'p', block.kind === 'li' ? 'gm-li' : 'gm-p');
        if (block.kind === 'li') line.append(mk(doc, 'span', 'gm-bullet', '•'));
        const text = mk(doc, 'span');
        for (const run of block.runs) {
          if (run.bold) { const b = mk(doc, 'b'); b.textContent = run.text; text.append(b); }
          else text.append(doc.createTextNode(run.text));
        }
        line.append(text);
        body.append(line);
      }
      return body;
    }
    function paintQuestion() {
      const q = state.question;
      const host = openPage.querySelector('.gm-cf');
      if (!host) return;
      host.replaceChildren();
      if (!q) { host.hidden = true; return; }
      host.append(mk(doc, 'span', 'gm-cf-t', q.text));
      const no = button(doc, 'gm-btn', CONFIRM.no, 'cf-no');
      no.addEventListener('click', e => { if (e.isTrusted !== true) return; ctl.cancelPending(); state.question = null; paintQuestion(); });
      const yes = button(doc, 'gm-btn gm-pri', CONFIRM.yes, 'cf-yes');
      yes.addEventListener('click', e => { if (e.isTrusted !== true) return; ctl.confirmPending(); state.question = null; paintQuestion(); });
      host.append(no, yes);
      host.hidden = false;
      if (typeof no.focus === 'function') no.focus(); // design 3c: focus starts on «Cancelar»; Esc reaches it too
    }
    function paintDetail(view) {
      state.message = view;
      state.question = null;
      sum.textContent = `${view.from}${view.when ? ` · ${view.when}` : ''}`;
      sum.title = sum.textContent;
      show(list, false);
      show(empty, false);
      show(problem, false);
      openPage.replaceChildren();
      const bar = mk(doc, 'div', 'gm-msg-head');
      const back = button(doc, 'gm-back', '‹ Bandeja', 'back');
      back.addEventListener('click', e => { if (e.isTrusted !== true) return; load(state.filter); });
      const who = mk(doc, 'span', 'gm-who');
      who.append(mk(doc, 'b', 'gm-from', view.from), mk(doc, 'span', 'gm-addr', view.address));
      bar.append(back, who, mk(doc, 'span', 'gm-when', view.when));
      openPage.append(bar, mk(doc, 'h3', 'gm-subj', view.subject), paintText(view.blocks));
      if (view.bodyTruncated) openPage.append(mk(doc, 'p', 'gm-cut', 'El correo es largo: se ve el principio.'));
      if (view.links.length) {
        const links = mk(doc, 'div', 'gm-links');
        for (const link of view.links) {
          const chip = button(doc, 'gm-lnk', `${link.label} ↗`, 'link');
          chip.title = link.sameAsSender ? `Abrir ${link.domain}` : `Abrir ${link.domain} (no es el dominio del remitente)`;
          chip.addEventListener('click', e => {
            if (e.isTrusted !== true) return;
            const action = ctl.openLink(link, view.address);
            if (action.kind === 'confirm') { state.question = action; paintQuestion(); }
          });
          links.append(chip);
        }
        openPage.append(links);
      }
      const cf = mk(doc, 'div', 'gm-cf');
      cf.hidden = true;
      openPage.append(cf);
      const acts = mk(doc, 'div', 'gm-acts');
      const reply = button(doc, 'gm-btn gm-pri', 'Responder', 'reply');
      reply.setAttribute('aria-label', `Responder a ${view.from}: abre tu app de correo`);
      reply.addEventListener('click', e => { if (e.isTrusted !== true) return; ctl.reply(view.id); });
      acts.append(reply);
      openPage.append(acts);
      show(openPage, true);
    }
    async function openMessage(id) {
      const ticket = ++state.ticket;
      const view = await ctl.openMessage(id);
      if (ticket !== state.ticket) return;
      if (view.ok) paintDetail(view.detail); else fail(view.message);
    }

    paintSum({});
    load(DEFAULT_FILTER);

    const unmount = () => {
      state.ticket += 1;
      ctl.cancelPending();
      state.message = null;
      state.question = null;
      root.replaceChildren();
      if (el.firstChild === root) el.replaceChildren();
    };
    unmount.refresh = refresh;
    return unmount;
  }

  return { FILTERS, FILTER_IDS, DEFAULT_FILTER, STATUSES, EMPTY, ERRORS, CONFIRM, REFRESH_MS, STATUS_MS,
    MAX_ROWS, MAX_LINKS, MAX_ID, MAX_PREVIEW, BADGE_CAP, clean, counterHead, counterText, badgeOf, statusAnswer, errorText, refusal,
    available, whenText, rowView, rowsOf, runsOf, bodyBlocks, safeUrl, linkView, senderDomain, confirmText, openAction,
    detailView, messageAnswer, statusPayload, inboxPayload, messagePayload, replyPayload, seenPayload,
    controller, makeCard, paintCard };
});

// ---- the browser mount: the icon row's Gmail card ------------------------------------------
function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const shortcuts = root.AbitoShortcuts || null;
  const internals = root.__TAURI_INTERNALS__;
  // The settings window runs this same page and its own Gmail card (integrations-mail.js): stay inert there.
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  if (label === 'settings') return;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  if (!invoke || !shortcuts) return;
  const capsule = doc.getElementById('capsule');
  // Links leave through the EXISTING validated opener: the host re-validates, this only refuses what is not http(s).
  const open = url => {
    const safe = api.safeUrl(url);
    if (!safe) return;
    try { invoke('open_chat_url', { payload: { url: safe } }).catch(() => {}); } catch { /* optional bridge */ }
  };
  const { def, ctl } = api.makeCard({ invoke, now: () => Date.now(), open });
  // S1/S5: the card belongs to the expanded overview only; a take-over, a chat or Ajustes covers it.
  const islandOn = () => {
    if (doc.hidden) return false;
    if (!capsule) return true;
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question || '');
  };
  let painted = 0, lastState = null, statusTimer = null, inboxTimer = null;
  // S3/S12: the icon appears the moment the host says «connected» and disappears when it stops. `available()` is read on every
  // render; refresh() is what makes the row repaint, so every move of the state announces itself exactly once.
  function syncStatus() {
    return ctl.status().then(() => {
      if (ctl.state() !== lastState) { lastState = ctl.state(); shortcuts.refresh(); }
      return ctl.available();
    }, () => null);
  }
  let card = null; // the painted card's unmount (+ .refresh), while it is on screen
  function stopTimers() {
    if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null; }
  }
  shortcuts.registerCard({
    ...def,
    mount: el => {
      painted += 1;
      const off = def.mount(el);
      card = typeof off === 'function' ? off : null;
      syncStatus(); // the card asks who it is as soon as it is painted
      stopTimers();
      // S1/S5: the list moves under the human's eyes: every minute while the card is on screen.
      inboxTimer = setInterval(() => {
        if (painted > 0 && islandOn() && card && typeof card.refresh === 'function') card.refresh();
      }, api.REFRESH_MS);
      return () => {
        painted = Math.max(0, painted - 1);
        card = null;
        stopTimers();
        if (typeof off === 'function') off();
      };
    },
  });
  // The icon lives on the row even when the card is not focused: the connection is read when the island is shown and on a slow
  // timer, never in a tight loop; the card's own data refreshes only while it is painted and the island is on screen.
  statusTimer = setInterval(() => { if (islandOn()) syncStatus(); }, api.STATUS_MS);
  const wake = () => { if (islandOn()) syncStatus(); };
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) { stopTimers(); return; }
    wake();
    if (painted > 0 && card && typeof card.refresh === 'function') card.refresh();
  });
  root.addEventListener('focus', () => {
    wake();
    if (painted > 0 && card && typeof card.refresh === 'function') card.refresh();
  });
  if (capsule && typeof MutationObserver !== 'undefined') {
    new MutationObserver(wake).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-card', 'data-question', 'data-settings'] });
  }
  root.addEventListener('pagehide', () => { if (statusTimer) clearInterval(statusTimer); stopTimers(); });
  wake();
}
