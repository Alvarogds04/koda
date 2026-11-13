'use strict';
/* K2-10 T5 (S1, S2, S3, S5, S6, S7, S9, S12) — pure checks for frontend/gmail-view.js, the Gmail card of the island's icon row
   (design/k2-09-atajos/08-isla-unida.html, «Gmail · solo lo nuevo»). No DOM, no IPC, no network: the card's model is driven with
   a fake `gmail_action` whose answers are the closed shapes src/gmailcmd.rs produces, and the registration is exercised against
   the real frontend/island-shortcuts.js.
   Run: node apps/desktop-tauri/test-node/gmail-view-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const G = require(path.join(frontend, 'gmail-view.js'));
const S = require(path.join(frontend, 'island-shortcuts.js'));
const src = fs.readFileSync(path.join(frontend, 'gmail-view.js'), 'utf8');
const css = fs.readFileSync(path.join(frontend, 'gmail-view.css'), 'utf8');
const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime(); // 13-nov-2026, 15:00 local
const at = (h, m, day) => new Date(2026, 10, day || 13, h, m, 0).getTime();

let passed = 0;
const queue = [];
const test = (name, fn) => { queue.push([name, fn]); };

/** A fake host: records every (command, payload) and answers from the handler. */
const host = handler => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args && args.payload]);
    return handler(cmd, (args && args.payload) || {}, calls.length);
  };
  return { calls, invoke, payloads: () => calls.map(c => c[1]) };
};
const answers = list => {
  const rest = list.slice();
  return host(() => (rest.length ? rest.shift() : undefined));
};
const statusAnswer = state => ({ ok: true, state, clientId: null, hasSecret: false });
const inboxAnswer = (n = 2) => ({
  ok: true,
  messages: Array.from({ length: n }, (_, i) => ({
    id: `id${i}`, from: `Remitente ${i}`, address: `r${i}@example.test`, subject: `Asunto ${i}`,
    snippet: `Vista previa ${i}`, dateMs: at(9, 30 - i), unread: i === 0, important: false,
  })),
  newCount: n, newCountCapped: false, unreadCount: 5, lastSeenMs: 0,
});
const detailAnswer = {
  ok: true,
  detail: {
    id: 'id0', from: 'Lucía Pérez', address: 'lucia.perez@estudiolua.es', subject: 'Presupuesto Q4',
    replySubject: 'Re: Presupuesto Q4', body: 'Hola **Álvaro**:\n- versión 3\n- antes del viernes',
    bodyTruncated: false, dateMs: at(9, 31), unread: true, important: true,
    links: [
      { text: 'Ver documento', url: 'https://docs.google.com/document/d/1', domain: 'docs.google.com', sameAsSender: false },
      { text: 'Hoja', url: 'https://estudiolua.es/q4', domain: 'estudiolua.es', sameAsSender: true },
    ],
  },
};

// ---- S5: the head counter and the icon count -------------------------------------------------
test('S5 counter: «N nuevos · M sin leer», singular, and «100+» when the host capped its page', () => {
  assert.equal(G.counterText({ newCount: 4, newCountCapped: false, unreadCount: 128 }), '4 nuevos · 128 sin leer');
  assert.equal(G.counterText({ newCount: 1, unreadCount: 1 }), '1 nuevo · 1 sin leer');
  assert.equal(G.counterText({ newCount: 0, unreadCount: 0 }), '0 nuevos · 0 sin leer');
  assert.equal(G.counterText({ newCount: 100, newCountCapped: true, unreadCount: 128 }), '100+ nuevos · 128 sin leer');
  assert.equal(G.counterText({}), '0 nuevos · 0 sin leer', 'an empty answer is zero, never a guess');
  assert.equal(G.counterText({ newCount: '3', unreadCount: -1 }), '3 nuevos · 0 sin leer');
  assert.equal(G.counterText({ newCount: -2, unreadCount: 2.9 }), '0 nuevos · 2 sin leer');
  assert.equal(G.counterText(null), '0 nuevos · 0 sin leer');
});

test('S12 badge: the icon counts «nuevos» (a number, whole and >= 0); a capped page reads 100', () => {
  assert.equal(G.badgeOf({ newCount: 4 }), 4);
  assert.equal(G.badgeOf({ newCount: 100, newCountCapped: true }), 100, 'the mount paints a number, so 100 stands for «100+»');
  assert.equal(G.badgeOf({ newCount: 3.7 }), 3);
  assert.equal(G.badgeOf({ newCount: -4 }), 0);
  assert.equal(G.badgeOf({}), 0);
  assert.equal(G.badgeOf(null), 0);
  assert.equal(G.BADGE_CAP, 100);
});

// ---- S5/S12: the four filters ----------------------------------------------------------------
test('S5 filters: Nuevos · Importantes · De personas · Todos — Nuevos by default, the closed payload', () => {
  assert.deepEqual(G.FILTERS.map(f => f.id), ['nuevos', 'importantes', 'personas', 'todos']);
  assert.deepEqual(G.FILTERS.map(f => f.label), ['Nuevos', 'Importantes', 'De personas', 'Todos']);
  assert.equal(G.DEFAULT_FILTER, 'nuevos');
  for (const f of G.FILTERS) assert.deepEqual(G.inboxPayload(f.id), { action: 'inbox', filter: f.id });
  for (const bad of ['Nuevos', 'imp', '', null, undefined, 5, {}, 'todos ']) {
    assert.deepEqual(G.inboxPayload(bad), { action: 'inbox', filter: 'nuevos' }, JSON.stringify(bad));
  }
  // the empty line speaks of the filter that is showing
  assert.equal(G.EMPTY.nuevos, 'No tenés correos nuevos');
  for (const f of G.FILTERS) assert.match(G.EMPTY[f.id], /^No /);
});

// ---- S1: a row is sender, subject and a one-line preview -------------------------------------
test('S1 rows: sender, subject, one-line preview, unread flag, and a readable line for a screen reader', () => {
  const now = NOW, today = at(9, 31);
  assert.equal(G.whenText(today, now), '09:31');
  assert.equal(G.whenText(at(9, 31, 12), now), 'ayer');
  assert.equal(G.whenText(at(9, 31, 11), now), '11/11');
  assert.equal(G.whenText(0, now), '');
  const r = G.rowView({ id: 'abc', from: 'Lucía Pérez', address: 'lucia.perez@estudiolua.es', subject: 'Presupuesto Q4',
    snippet: 'Hola\n\nÁlvaro:   te paso la versión 3', dateMs: today, unread: true, important: true }, now);
  assert.equal(r.id, 'abc');
  assert.equal(r.from, 'Lucía Pérez');
  assert.equal(r.subject, 'Presupuesto Q4');
  assert.equal(r.preview, 'Hola Álvaro: te paso la versión 3', 'one line: the newlines collapse');
  assert.equal(r.when, '09:31');
  assert.equal(r.unread, true);
  assert.match(r.aria, /^Sin leer/);
  assert.match(r.aria, /Lucía Pérez, Presupuesto Q4, 09:31/);
  const read = G.rowView({ id: 'x', from: '', address: 'r@example.test', subject: '', snippet: '', dateMs: today, unread: false }, now);
  assert.equal(read.from, 'r@example.test', 'no name: the address stands in');
  assert.equal(read.subject, '(Sin asunto)');
  assert.match(read.aria, /^Leído/);
  assert.equal(G.rowView({ id: 'y', from: 'A', snippet: '<b>x</b> y' }, now).preview, '<b>x</b> y', 'text stays text');
  assert.ok(G.rowView({ id: 'z', from: 'A', snippet: 'x'.repeat(400) }, now).preview.length <= G.MAX_PREVIEW);
});

test('S1/S3 inbox: up to 20 rows, the counter, and the empty state — never a sample row', () => {
  const many = inboxAnswer(40);
  const view = G.rowsOf(many, NOW, 'nuevos');
  assert.equal(view.ok, true);
  assert.equal(view.rows.length, G.MAX_ROWS, 'the host pages 20 and the card never paints more');
  assert.equal(G.MAX_ROWS, 20);
  assert.equal(view.counter, '40 nuevos · 5 sin leer');
  assert.equal(view.empty, false);
  const empty = G.rowsOf({ ok: true, messages: [], newCount: 0, newCountCapped: false, unreadCount: 128, lastSeenMs: 0 }, NOW, 'nuevos');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.rows, [], 'nothing connected to invent: an empty inbox paints no row');
  assert.equal(empty.empty, true);
  assert.equal(empty.emptyText, 'No tenés correos nuevos');
  assert.equal(G.rowsOf({ ok: true, messages: [] }, NOW, 'personas').emptyText, 'No tenés correos de personas');
  assert.equal(G.rowsOf(inboxAnswer(1), NOW, 'nope').filter, 'nuevos', 'an unknown filter falls back to the default');
});

test('S3 errors: one honest Spanish line per code, never the raw code nor an HTTP body', () => {
  const bad = G.rowsOf({ ok: false, reason: 'network' }, NOW);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'network');
  assert.match(bad.message, /conexión/);
  assert.match(bad.message, /reintentá|Probá/i);
  assert.match(G.errorText('rate_limited'), /esperar|rato/i);
  assert.match(G.errorText('forbidden'), /permiso/);
  assert.match(G.errorText('needs_sign_in'), /Ajustes|conectar/i);
  assert.equal(G.errorText('failed'), 'No pude traer tus correos. Reintentá en un rato.');
  for (const code of ['network', 'rate_limited', 'forbidden', 'needs_sign_in', 'invalid', 'server', 'keychain', 'prefs', 'failed']) {
    const text = G.errorText(code);
    assert.ok(text.length > 12, code);
    assert.doesNotMatch(text, new RegExp(code), `${code} is not shown to a person`);
    assert.doesNotMatch(text, /[<>{}]|http/i, `${code} never leaks markup or an address`);
  }
  assert.equal(G.errorText('weird_code_from_the_future'), G.errorText('failed'));
  assert.equal(G.rowsOf({ ok: false, reason: 'weird' }, NOW).reason, 'failed');
  assert.equal(G.rowsOf({ ok: true }, NOW).ok, false, 'an answer without a list is not a list');
  assert.equal(G.rowsOf(null, NOW).ok, false);
});

// ---- S3/S12: availability ---------------------------------------------------------------
test('S3 available(): true ONLY on a connected status; no_client, signed_out and reconnect leave no icon', () => {
  assert.deepEqual(G.STATUSES, ['no_client', 'signed_out', 'connected', 'reconnect']);
  for (const state of G.STATUSES) assert.equal(G.available(state), state === 'connected', state);
  for (const bad of [null, undefined, 'Connected', ' connected', '', 1, true, {}, { state: 'connected' }]) {
    assert.equal(G.available(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(G.statusAnswer(statusAnswer('reconnect')), { state: 'reconnect' });
  assert.equal(G.statusAnswer({ ok: false, reason: 'keychain' }), null);
  assert.equal(G.statusAnswer({ ok: true, state: 'spam' }), null, 'an unknown state is not a connection');
  assert.deepEqual(G.statusPayload(), { action: 'status' });
});

// ---- S6: the plain-text body ------------------------------------------------------------
test('S6 body: text with **bold** and lists becomes plain blocks; markup never becomes markup', () => {
  assert.deepEqual(G.bodyBlocks('Hola **Álvaro**:\n- versión 3\n- antes del viernes'), [
    { kind: 'p', runs: [{ text: 'Hola ', bold: false }, { text: 'Álvaro', bold: true }, { text: ':', bold: false }] },
    { kind: 'li', runs: [{ text: 'versión 3', bold: false }] },
    { kind: 'li', runs: [{ text: 'antes del viernes', bold: false }] },
  ]);
  assert.deepEqual(G.bodyBlocks('  \n\n '), []);
  assert.deepEqual(G.bodyBlocks(null), []);
  assert.deepEqual(G.bodyBlocks('<b>hola</b>'), [{ kind: 'p', runs: [{ text: '<b>hola</b>', bold: false }] }], 'HTML is text here');
  assert.deepEqual(G.bodyBlocks('*no* es negrita'), [{ kind: 'p', runs: [{ text: '*no* es negrita', bold: false }] }]);
  assert.deepEqual(G.bodyBlocks('• viñeta'), [{ kind: 'li', runs: [{ text: 'viñeta', bold: false }] }]);
  assert.deepEqual(G.bodyBlocks('**a** y **b**'),
    [{ kind: 'p', runs: [{ text: 'a', bold: true }, { text: ' y ', bold: false }, { text: 'b', bold: true }] }]);
});

// ---- S6/S7: link chips and the confirmation before a foreign domain ----------------------
test('S6 link chips: the chip shows the REAL domain, never the anchor text', () => {
  const chip = G.linkView({ text: 'Ver el documento compartido', url: 'https://docs.google.com/document/d/1', domain: 'docs.google.com', sameAsSender: false });
  assert.equal(chip.label, 'docs.google.com');
  assert.equal(chip.url, 'https://docs.google.com/document/d/1');
  assert.equal(chip.sameAsSender, false);
  assert.equal(G.linkView({ url: 'javascript:alert(1)', domain: 'x.test', sameAsSender: true }), null, 'a non-http link is not a chip');
  assert.equal(G.linkView(null), null);
  const noDomain = G.linkView({ url: 'https://mail.example.test/x', sameAsSender: true });
  assert.equal(noDomain.label, 'mail.example.test', 'without a host-supplied domain the URL\'s own host is shown');
  assert.ok(G.detailView(detailAnswer.detail, NOW).links.length <= G.MAX_LINKS);
  assert.equal(G.MAX_LINKS, 30);
});

test('S7 confirmation: the sender\'s own domain opens directly, another domain asks first, non-http never opens', () => {
  const opened = [];
  const f = answers([statusAnswer('connected')]);
  const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: url => opened.push(url) });
  const own = { text: 'Hoja', url: 'https://estudiolua.es/q4', domain: 'estudiolua.es', sameAsSender: true };
  const other = { text: 'Ver', url: 'https://bit.ly/3x', domain: 'bit.ly', sameAsSender: false };
  assert.deepEqual(ctl.openLink(own, 'lucia.perez@estudiolua.es'), { kind: 'open', url: 'https://estudiolua.es/q4' });
  assert.deepEqual(opened, ['https://estudiolua.es/q4'], 'the sender\'s own domain goes straight through the shared opener');
  const ask = ctl.openLink(other, 'lucia.perez@estudiolua.es');
  assert.equal(ask.kind, 'confirm');
  assert.equal(ask.domain, 'bit.ly');
  assert.equal(ask.url, 'https://bit.ly/3x');
  assert.equal(ask.text, 'Este enlace va a bit.ly, no a estudiolua.es · ¿Abrirlo igual?');
  assert.deepEqual(opened, ['https://estudiolua.es/q4'], 'nothing opens before the human says yes');
  assert.deepEqual(ctl.pendingView(), ask, 'the row that asks is drawn from the pending link');
  assert.equal(ctl.confirmPending(), true);
  assert.deepEqual(opened, ['https://estudiolua.es/q4', 'https://bit.ly/3x']);
  assert.equal(ctl.pendingView(), null, 'asking once is enough');
  assert.equal(ctl.confirmPending(), false);
  assert.deepEqual(G.CONFIRM, { yes: 'Abrir', no: 'Cancelar' });
  // Cancelar opens nothing and clears the question
  ctl.openLink(other, 'lucia.perez@estudiolua.es');
  assert.equal(ctl.cancelPending(), true);
  assert.equal(ctl.pendingView(), null);
  assert.equal(opened.length, 2);
  // a link without the host's verdict is never treated as the sender's
  assert.equal(ctl.openLink({ url: 'https://evil.test/x', domain: 'evil.test' }, 'a@estudiolua.es').kind, 'confirm');
  assert.equal(ctl.openLink({ url: 'https://evil.test/x', domain: 'evil.test', sameAsSender: 'true' }, 'a@estudiolua.es').kind, 'confirm');
  // non-http and credential-carrying URLs never reach the opener
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'http://u:p@example.test/', '', null]) {
    assert.equal(ctl.openLink({ url: bad, sameAsSender: true }, 'a@b.test').kind, 'refuse', String(bad));
  }
  assert.equal(ctl.openLink(null, 'a@b.test').kind, 'refuse');
  assert.equal(opened.length, 2, 'a refused link never opens anything');
  assert.equal(G.openAction({ url: 'https://mail.estudiolua.es/x', domain: 'mail.estudiolua.es', sameAsSender: true }, 'ana@estudiolua.es').kind, 'open',
    'a subdomain of the sender counts as the sender\'s (the host decides, the card copies)');
  assert.equal(G.confirmText('bit.ly', 'estudiolua.es'), 'Este enlace va a bit.ly, no a estudiolua.es · ¿Abrirlo igual?');
  assert.equal(G.confirmText('bit.ly', ''), 'Este enlace va a bit.ly · ¿Abrirlo igual?');
  assert.equal(G.senderDomain('lucia.perez@estudiolua.es'), 'estudiolua.es');
  assert.equal(G.senderDomain('nope'), '');
});

// ---- S6: the opened message --------------------------------------------------------------
test('S6 detail: sender, subject, plain body, truncation notice and the chips of its links', () => {
  const view = G.messageAnswer(detailAnswer, NOW);
  assert.equal(view.ok, true);
  const d = view.detail;
  assert.equal(d.from, 'Lucía Pérez');
  assert.equal(d.address, 'lucia.perez@estudiolua.es');
  assert.equal(d.initials, 'L');
  assert.equal(d.subject, 'Presupuesto Q4');
  assert.equal(d.when, '09:31');
  assert.equal(d.replySubject, 'Re: Presupuesto Q4');
  assert.equal(d.bodyTruncated, false);
  assert.deepEqual(d.links.map(l => l.label), ['docs.google.com', 'estudiolua.es']);
  assert.equal(d.blocks.length, 3);
  assert.equal(d.blocks[0].runs[1].bold, true);
  const truncated = G.messageAnswer({ ok: true, detail: { ...detailAnswer.detail, bodyTruncated: true } }, NOW);
  assert.equal(truncated.detail.bodyTruncated, true);
  assert.equal(G.messageAnswer({ ok: false, reason: 'forbidden' }, NOW).ok, false);
  assert.match(G.messageAnswer({ ok: false, reason: 'forbidden' }, NOW).message, /permiso/);
  assert.equal(G.messageAnswer({ ok: true }, NOW).ok, false, 'no detail, no card');
});

// ---- S2/S5: the host verbs the card sends ------------------------------------------------
test('S2 reply: «Responder» sends the closed reply verb (the HOST opens the mail client, never the page)', async () => {
  const f = answers([{ ok: true, opened: true }]);
  const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
  const r = await ctl.reply('id0');
  assert.equal(r.ok, true);
  assert.equal(r.opened, true);
  assert.deepEqual(f.payloads(), [{ action: 'reply', id: 'id0' }]);
  const refused = answers([{ ok: false, reason: 'invalid' }]);
  const other = G.makeCard({ invoke: refused.invoke, now: () => NOW, open: () => {} }).ctl;
  assert.equal((await other.reply('id0')).ok, false);
  const never = answers([]);
  const bad = G.makeCard({ invoke: never.invoke, now: () => NOW, open: () => {} }).ctl;
  for (const id of ['', 'a/b', '../etc', null, 5]) assert.equal((await bad.reply(id)).ok, false, String(id));
  assert.deepEqual(never.payloads(), [], 'a refused id never reaches the host');
  assert.deepEqual(G.messagePayload('a_b-1'), { action: 'message', id: 'a_b-1' });
  assert.equal(G.messagePayload('a b'), null);
  assert.equal(G.messagePayload('x'.repeat(G.MAX_ID + 1)), null);
});

test('S5 seen: the visit is stored AFTER the list is shown, with the page clock; a failure or a detail does not stamp it', async () => {
  const ok = answers([inboxAnswer(4), { ok: true, lastSeenMs: NOW }]);
  const { ctl } = G.makeCard({ invoke: ok.invoke, now: () => NOW, open: () => {} });
  const view = await ctl.showList('nuevos');
  assert.equal(view.ok, true);
  assert.deepEqual(ok.payloads(), [{ action: 'inbox', filter: 'nuevos' }, { action: 'seen', atMs: NOW }]);
  assert.equal(G.badgeOf(view), 4);
  const failed = answers([{ ok: false, reason: 'network' }]);
  const other = G.makeCard({ invoke: failed.invoke, now: () => NOW, open: () => {} }).ctl;
  assert.equal((await other.showList()).ok, false);
  assert.deepEqual(failed.payloads(), [{ action: 'inbox', filter: 'nuevos' }], 'no visit is stamped when nothing was shown');
  const detail = answers([detailAnswer]);
  const third = G.makeCard({ invoke: detail.invoke, now: () => NOW, open: () => {} }).ctl;
  await third.openMessage('id0');
  assert.deepEqual(detail.payloads(), [{ action: 'message', id: 'id0' }], 'reading one message is not a visit');
  assert.deepEqual(G.seenPayload(NOW), { action: 'seen', atMs: NOW });
  for (const bad of [0, -1, 1.5, null, 'now', NaN]) assert.equal(G.seenPayload(bad), null, String(bad));
});

test('S1 status: the card is available only after the host answered connected, and the icon count is «nuevos»', async () => {
  const f = answers([statusAnswer('no_client'), statusAnswer('connected'), inboxAnswer(4), { ok: true, lastSeenMs: NOW }, statusAnswer('reconnect')]);
  const { ctl, def } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
  assert.equal(ctl.available(), false, 'before the host answers there is nothing to show');
  assert.equal(await ctl.status(), 'no_client');
  assert.equal(ctl.available(), false);
  assert.equal(def.available(), false);
  assert.equal(await ctl.status(), 'connected');
  assert.equal(ctl.available(), true);
  assert.equal(def.available(), true);
  await ctl.showList();
  assert.equal(def.badge(), 4, 'the icon counts the mail that is new since the last visit');
  assert.equal(await ctl.status(), 'reconnect');
  assert.equal(ctl.available(), false, 'a dead connection hides the icon; Ajustes says what to do');
  assert.equal(def.badge(), 0, 'no connection, no counter');
  assert.deepEqual(f.payloads().map(p => p.action), ['status', 'status', 'inbox', 'seen', 'status']);
  // a host that throws or says something unknown is not a connection
  const boom = G.makeCard({ invoke: async () => { throw new Error('no ipc'); }, now: () => NOW, open: () => {} }).ctl;
  assert.equal(await boom.status(), null);
  assert.equal(boom.available(), false);
  assert.equal(G.makeCard({ now: () => NOW }).ctl.available(), false);
});

// ---- S12: the registration contract, against the real registry --------------------------
test('S12 registration: registerCard accepts it; with no connection there is no icon, no card and no sample row', async () => {
  S._reset();
  const connected = answers([statusAnswer('signed_out')]);
  const first = G.makeCard({ invoke: connected.invoke, now: () => NOW, open: () => {} });
  assert.equal(first.def.id, 'gmail');
  assert.equal(first.def.label, 'Gmail');
  assert.equal(first.def.icon, 'mail');
  assert.equal(typeof first.def.mount, 'function');
  assert.equal(typeof first.def.badge, 'function');
  const off = S.registerCard(first.def);
  assert.deepEqual(S.row(), [], 'not connected: no icon, so the island is the usual Nusa');
  await first.ctl.status();
  assert.deepEqual(S.row(), [], 'signed_out is still no connection');
  off();
  assert.deepEqual(S.row(), []);

  const live = answers([statusAnswer('connected'), inboxAnswer(4)]);
  const second = G.makeCard({ invoke: live.invoke, now: () => NOW, open: () => {} });
  S.registerCard(second.def);
  assert.deepEqual(S.row(), [], 'registered but still unanswered: no icon yet');
  await second.ctl.status();
  const row = S.row();
  assert.deepEqual(row.map(it => it.id), ['koda', 'gmail']);
  assert.equal(row[1].label, 'Gmail', 'the icon says Gmail, not a sample inbox');
  assert.equal(row[1].icon, 'mail');
  assert.equal(row[1].num, 2);
  assert.equal(row[1].badge, 0, 'nothing new until the inbox answers');
  await second.ctl.showList('nuevos');
  assert.equal(S.row()[1].badge, 4);
  S._reset();
});

// ---- source hygiene (S3, S5, S6) ---------------------------------------------------------
test('S6 hygiene: textContent only, no remote image, no navigation, no storage, only gmail_action', () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(code, /<img|createElement\('img'\)|new Image|background-image|<svg[^>]*href/);
  assert.doesNotMatch(code, /window\.open|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(code, /['"`]prefs_action['"`]|integration_action|resend/i, 'no prefs and no other integration: the card has ONE verb');
  assert.match(code, /'gmail_action'/);
  assert.match(code, /open_chat_url/, 'links leave through the existing validated opener');
  assert.doesNotMatch(code, /['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/, 'the colours live in the stylesheet');
  assert.match(code, /isTrusted (?:===|!==) true/, 'synthetic events never act');
  assert.doesNotMatch(code, /lucia|estudiolua|Presupuesto Q4|Xataka/, 'no sample mail in the source');
  assert.doesNotMatch(code, /Marcar como leído|markAsRead|mark_read|addLabelIds|removeLabelIds/i, 'S5: read only, nothing marks mail as read');
  assert.match(code, /label === 'settings'/, 'the settings window runs the same page: the card stays inert there');
  assert.match(code, /setInterval\(|REFRESH_MS/, 'the card refreshes while it is mounted');
  assert.match(code, /clearInterval\(/, 'and stops its timers when it unmounts');
  assert.equal(G.REFRESH_MS, 60000);
  assert.equal(G.STATUS_MS, 15000);
  assert.doesNotMatch(css, /<img|url\(|@import/i, 'the card ships no image and no remote font');
});

test('wiring: index.html loads the card and its stylesheet once, next to the row; packaging ships both', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="gmail-view\.js"/g) || []).length, 1);
  assert.equal((html.match(/href="gmail-view\.css"/g) || []).length, 1);
  assert.ok(html.indexOf('src="gmail-view.js"') > html.indexOf('src="spotify-view.js"'), 'after the Spotify card it follows');
  assert.ok(html.indexOf('src="gmail-view.js"') < html.indexOf('src="island.js"'), 'before the island boots');
  assert.ok(html.indexOf('href="gmail-view.css"') > html.indexOf('href="island-nusa.css"'), 'after the Nusa styles it refines');
  const L = require(path.join(__dirname, '..', 'packaging', 'lib.cjs'));
  assert.ok(L.FRONTEND_FILES.includes('gmail-view.js'));
  assert.ok(L.FRONTEND_FILES.includes('gmail-view.css'));
  const mount = fs.readFileSync(path.join(frontend, 'island-shortcuts-mount.js'), 'utf8');
  assert.match(mount, /mail: \{ d: \[/, 'the icon row can paint the `mail` icon the card registers');
  assert.match(src, /registerCard\(/, 'the card registers itself in the shared shell');
  assert.match(src, /id: 'gmail', label: 'Gmail', icon: 'mail'/);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
  }
  console.log(`gmail-view-check: ${passed} checks ok`);
})();
