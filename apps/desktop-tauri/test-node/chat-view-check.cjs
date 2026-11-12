'use strict';
/* U1 — pure checks for frontend/chat-view.js (no DOM, no network).
   Run: node apps/desktop-tauri/test-node/chat-view-check.cjs
   Also run by `cargo test` (tests/frontend_chat_view.rs). */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const V = require(path.join(__dirname, '..', 'frontend', 'chat-view.js'));

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

test('state labels are the contract states, in Spanish', () => {
  assert.equal(V.stateLabel('queued'), 'En cola');
  assert.equal(V.stateLabel('thinking'), 'Pensando…');
  assert.equal(V.stateLabel('streaming'), 'Escribiendo…');
  assert.equal(V.stateLabel('waiting_approval'), 'Esperando aprobación');
  assert.equal(V.stateLabel('completed'), 'Respondió');
  assert.equal(V.stateLabel('cancelled'), 'Cancelado');
  assert.equal(V.stateLabel('error'), 'Error');
  assert.equal(V.stateLabel('nope'), '');
});

test('draft problems mirror the Rust validation', () => {
  assert.equal(V.draftProblem('hola'), null);
  assert.match(V.draftProblem('  \n '), /vacío/);
  assert.equal(V.draftProblem('ñ'.repeat(8000)), null);
  assert.match(V.draftProblem('a'.repeat(8001)), /8\.000/);
  assert.match(V.draftProblem('a\u0000b'), /control/);
  assert.equal(V.draftProblem('a\nb\tc'), null);
  assert.equal(V.scalarCount('😀ñ'), 2);
});

test('send is enabled only with an available model, no active turn and a valid draft', () => {
  const ready = { availability: { state: 'ready' }, active_turn: null };
  assert.equal(V.canSend(ready, 'hola', false), true);
  assert.equal(V.canSend({ ...ready, availability: { state: 'busy' } }, 'hola', false), true);
  for (const state of ['unavailable', 'blocked', 'unchecked']) {
    assert.equal(V.canSend({ ...ready, availability: { state } }, 'hola', false), false, state);
  }
  assert.equal(V.canSend({ ...ready, active_turn: 't-1' }, 'hola', false), false);
  assert.equal(V.canSend(ready, '   ', false), false);
  assert.equal(V.canSend(ready, 'hola', true), false); // a submit is in flight
  assert.equal(V.canSend(null, 'hola', false), false);
});

test('S14 send rule (design 14, option A): the disc is disabled only for an empty draft, an active turn or a submit in flight; a model that is not ready answers WHEN pressed', () => {
  const ready = { availability: { state: 'ready' }, active_turn: null };
  assert.deepEqual(V.sendState(ready, 'hola', false), { disabled: false, blocked: null });
  assert.equal(V.sendState(ready, '', false).disabled, true);
  assert.equal(V.sendState(ready, '   \n', false).disabled, true);
  assert.equal(V.sendState(ready, 'hola', true).disabled, true, 'a submit in flight');
  assert.equal(V.sendState({ ...ready, active_turn: 't-1' }, 'hola', false).disabled, true, 'a turn is running: cancel is the control');
  for (const state of ['unavailable', 'blocked', 'unchecked']) {
    const s = V.sendState({ ...ready, availability: { state } }, 'hola', false);
    assert.equal(s.disabled, false, state + ': the human may press it');
    assert.equal(typeof s.blocked, 'string'); assert.ok(s.blocked.length > 0, state + ' says why instead of being silently grey');
  }
  assert.equal(V.sendState(null, 'hola', false).disabled, false);
  assert.ok(V.sendState(null, 'hola', false).blocked);
  assert.equal(V.sendState(ready, 'a\u0000b', false).disabled, false, 'a control character is refused with its own message, not a grey disc');
  // the old gate still decides what is actually sent
  assert.equal(V.canSend({ ...ready, availability: { state: 'unavailable' } }, 'hola', false), false);
});

test('S14 validation: a model that stays «unchecked» while the chat is open must be re-checked (the chip shows a spinner, never «Conectado», until someone asks)', () => {
  const view = (state, target = { alias: 'Abito-gpt', origin: 'http://127.0.0.1:11002' }) => ({ target, availability: { state }, active_turn: null });
  assert.equal(V.needsCheck(view('unchecked')), true);
  for (const state of ['ready', 'busy', 'unavailable', 'blocked']) assert.equal(V.needsCheck(view(state)), false, state + ' is an answer, not a pending check');
  assert.equal(V.needsCheck(view('unchecked', null)), false, 'no target: nothing to check');
  assert.equal(V.needsCheck(null), false);
  assert.equal(V.needsCheck({ target: { alias: 'a' }, active_turn: 't-1', availability: { state: 'unchecked' } }), false, 'a running turn already proves the model');
  // bounded: the page asks at most 3 times per «unchecked» episode, 4 s apart
  assert.deepEqual(V.checkPlan(0, 1000, 0), { ask: true, wait: 0 });
  assert.deepEqual(V.checkPlan(1, 1000, 1000), { ask: false, wait: 4000 }, 'a second ask only after 4 s');
  assert.deepEqual(V.checkPlan(1, 5000, 1000), { ask: true, wait: 0 });
  assert.equal(V.checkPlan(3, 99999, 0).ask, false, 'never more than 3 asks per episode'); assert.equal(V.checkPlan(3, 99999, 0).giveUp, true);
});

test('status line: active turn first, then availability, never a guess', () => {
  const view = {
    active_turn: 't-2', queue_note: 'en su cola',
    turns: [{ turn_id: 't-2', state: 'thinking' }],
    availability: { state: 'ready', message: 'Modelo local listo.' },
  };
  assert.equal(V.statusLine(view), 'Pensando… · en su cola');
  assert.equal(V.statusLine({ ...view, active_turn: null, queue_note: null }), 'Modelo local listo.');
  assert.equal(V.statusLine(null), 'Chat no disponible.');
});

test('announcements are per state change and completed turn, never per token', () => {
  const t = (state, reply = '', extra = {}) => ({ turn_id: 't-1', state, reply, ...extra });
  const v = turn => ({ active_turn: turn.state === 'completed' || turn.state === 'error' ? null : 't-1', turns: [turn] });
  assert.equal(V.announcement(v(t('queued')), v(t('thinking'))), 'Pensando…');
  assert.equal(V.announcement(v(t('streaming', 'Ho')), v(t('streaming', 'Hola'))), null);
  assert.equal(V.announcement(v(t('streaming', 'Hola')), v(t('completed', 'Hola'))), 'Koda respondió: Hola'); // Koda 0.1 T2 // Koda 0.1 T2
  assert.equal(
    V.announcement(v(t('thinking')), v(t('error', '', { error: { safe_message: 'El modelo local no responde.' } }))),
    'El modelo local no responde.');
  const long = 'x'.repeat(500);
  assert.ok(V.announcement(v(t('streaming', long)), v(t('completed', long))).length < 330);
  assert.equal(V.announcement(null, v(t('queued'))), 'En cola');
});

test('scroll pins only when the reader is already at the bottom', () => {
  assert.equal(V.atBottom(0, 100, 100), true);
  assert.equal(V.atBottom(296, 400, 100), true);
  assert.equal(V.atBottom(200, 400, 100), false);
});

test('request ids are bounded tokens the Rust gate accepts', () => {
  const id = V.newRequestId(new Uint8Array([0, 1, 2, 255, 16, 32, 64, 128]));
  assert.equal(id, 'req-000102ff10204080');
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
});

test('turn rows render plain text roles and truncation/trim notes', () => {
  const rows = V.turnRows({
    turn_id: 't-1', state: 'completed', user_text: '<b>hola</b>', reply: 'chau',
    finish_reason: 'limit', trimmed_turns: 2, error: null,
  });
  assert.deepEqual(rows.map(r => r.kind), ['user', 'note', 'assistant', 'note']);
  assert.equal(rows[0].text, '<b>hola</b>'); // rendered with textContent, never HTML
  assert.match(rows[1].text, /2 mensajes anteriores/);
  assert.match(rows[3].text, /límite/);
  const failed = V.turnRows({ turn_id: 't-2', state: 'error', user_text: 'x', reply: '', error: { safe_message: 'No disponible.' }, trimmed_turns: 0 });
  assert.deepEqual(failed.map(r => r.kind), ['user', 'error']);
  const cancelled = V.turnRows({ turn_id: 't-3', state: 'cancelled', user_text: 'x', reply: 'me', trimmed_turns: 0 });
  assert.match(cancelled[cancelled.length - 1].text, /Cancelado/);
});


test('UI.2 chat status: a word only for problems; shapes carry the rest', () => {
  const base = { turns: [], active_turn: null, queue_note: null };
  const v = (state, msg) => V.statusView({ ...base, availability: { state, message: msg || '' } });
  assert.deepEqual([v('ready').kind, v('ready').word, v('ready').tone], ['ready', 'Conectado', 'go']); // T7.3 isla-chat-*: the «Conectado» chip (was '')
  assert.equal(v('unavailable', 'El modelo local no responde').word, 'Modelo caído');
  assert.equal(v('unavailable', 'x').tone, 'red');
  assert.equal(v('blocked').word, 'Bloqueado');
  assert.equal(v('busy').word, 'Ocupado');
  assert.equal(v('unchecked').icon, 'ring');
  assert.match(v('unavailable', 'El modelo local no responde').aria, /no responde/);
  const turn = state => ({ turn_id: 't', state, user_text: 'x', reply: '', trimmed_turns: 0 });
  const act = state => V.statusView({ turns: [turn(state)], active_turn: 't', availability: { state: 'ready', message: '' } });
  assert.equal(act('thinking').icon, 'ring');
  assert.equal(act('streaming').tone, 'live');
  assert.equal(act('waiting_approval').tone, 'sun');
  assert.equal(act('queued').icon, 'clock');
  assert.equal(V.statusView(null).word, 'Modelo caído');
});

test('UI.2 composer: one visible word for draft problems, none for empty', () => {
  assert.equal(V.draftWord('a'.repeat(8001)), 'Muy largo');
  assert.equal(V.draftWord('hola\u0001'), 'Caracteres no válidos');
  assert.equal(V.draftWord(''), '');
  assert.equal(V.draftWord('   '), '');
});

test('UI.2 rows: short word + icon, full text kept for aria', () => {
  const rows = V.turnRows({ turn_id: 't', state: 'cancelled', user_text: 'x', reply: 'me', trimmed_turns: 2, finish_reason: 'limit' });
  assert.equal(rows.find(r => r.short === 'Recortado').icon, 'info');
  const cut = V.turnRows({ turn_id: 't', state: 'completed', user_text: 'x', reply: 'r', trimmed_turns: 0, finish_reason: 'limit' });
  assert.equal(cut[cut.length - 1].short, 'Cortado por largo');
  const can = V.turnRows({ turn_id: 't', state: 'cancelled', user_text: 'x', reply: 'r', trimmed_turns: 0 });
  assert.equal(can[can.length - 1].short, 'Cancelado');
  const err = V.turnRows({ turn_id: 't', state: 'error', user_text: 'x', reply: '', error: { safe_message: 'Sin modelo.' }, trimmed_turns: 0 });
  assert.equal(err[err.length - 1].icon, 'triangle');
});

test('UI.2 chat markup: icon-only controls are named, copy is voseo, labels Vos/Abito gone', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  for (const id of ['chat-back', 'chat-send', 'chat-cancel', 'chat-new']) {
    assert.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)[0], /aria-label="[^"]{3,}"/, id);
  }
  assert.match(html, /placeholder="Escribí…"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8');
  assert.doesNotMatch(css, /content: "(Vos|Abito): "/);
});

// Real cascade resolution (not a text regex): which `animation` declaration
// WINS for a described element under a given media preference. Supports the
// selector subset style.css uses: tag, #id, .class, [attr="v"], descendant.
function cascadeAnimation(css, chain, reduced) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = []; // {sel, value, spec, order}
  let order = 0;
  const walk = (text, _media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0; j++; }
      const body = text.slice(open + 1, j - 1);
      i = j;
      if (head.startsWith('@media')) {
        const ok = head.includes('prefers-reduced-motion: reduce') ? reduced
          : head.includes('prefers-reduced-motion: no-preference') ? !reduced : false;
        if (ok) walk(body, head);
        continue;
      }
      if (head.startsWith('@')) continue;
      const m = /(?:^|;)\s*animation\s*:\s*([^;]+)/.exec(body);
      if (!m) continue;
      for (const sel of head.split(',')) rules.push({ sel: sel.trim(), value: m[1].trim(), order: order++ });
    }
  };
  walk(plain, null);
  const parseCompound = c => {
    const out = { tag: null, id: null, classes: [], attrs: [], spec: [0, 0, 0] };
    const re = /([#.]?[\w-]+)|\[([\w-]+)="([^"]*)"\]/g;
    let m;
    while ((m = re.exec(c))) {
      if (m[2]) { out.attrs.push([m[2], m[3]]); out.spec[1]++; }
      else if (m[1][0] === '#') { out.id = m[1].slice(1); out.spec[0]++; }
      else if (m[1][0] === '.') { out.classes.push(m[1].slice(1)); out.spec[1]++; }
      else { out.tag = m[1]; out.spec[2]++; }
    }
    return out;
  };
  const matches = (c, el) => (!c.tag || c.tag === el.tag) && (!c.id || c.id === el.id) &&
    c.classes.every(k => (el.classes || []).includes(k)) && c.attrs.every(([k, v]) => (el.attrs || {})[k] === v);
  const winners = rules.map(r => {
    const parts = r.sel.split(/\s+/).map(parseCompound);
    // last compound must match the element; earlier ones an ancestor, in order
    let k = parts.length - 1;
    if (!matches(parts[k], chain[chain.length - 1])) return null;
    let e = chain.length - 2; k -= 1;
    while (k >= 0 && e >= 0) { if (matches(parts[k], chain[e])) k -= 1; e -= 1; }
    if (k >= 0) return null;
    return { ...r, spec: parts.reduce((a, p) => a.map((v, n) => v + p.spec[n]), [0, 0, 0]) };
  }).filter(Boolean);
  winners.sort((a, b) => a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order);
  return winners.length ? winners[winners.length - 1].value : null;
}

test('#304 motion: the CASCADE is keyed on Abito\'s OWN html[data-motion], never on the system media query (system reduced + Abito full → the ring spins)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8');
  assert.doesNotMatch(css, /@media[^{]*prefers-reduced-motion/, 'the page must not inherit the system preference through CSS');
  for (const kind of ['busy', 'checking']) {
    const under = mode => [{ tag: 'html', attrs: { 'data-motion': mode } }, { tag: 'span', id: 'chat-state', attrs: { 'data-kind': kind }, classes: ['chip'] },
      { tag: 'span', classes: ['ico'] }, { tag: 'svg' }];
    // second arg = the SYSTEM media query: TRUE in both cases (the WebKit-inherited reduced of the human's session)
    const reduce = cascadeAnimation(css, under('reduce'), true);
    assert.ok(reduce === null || reduce === 'none', `Abito reduce: ${kind} resolves to ${reduce}`);
    assert.match(cascadeAnimation(css, under('full'), true), /^spin /, `Abito full + system reduced: ${kind} still spins`);
    assert.match(cascadeAnimation(css, under('full'), false), /^spin /);
  }
  // the harness itself must detect the old bug: a spinning rule AFTER the stop wins
  const buggy = 'html[data-motion="reduce"] #a .b { animation: none; }\nhtml[data-motion="reduce"] #a .b { animation: spin 1s; }';
  assert.match(cascadeAnimation(buggy, [{ tag: 'html', attrs: { 'data-motion': 'reduce' } }, { tag: 'p', id: 'a' }, { tag: 'i', classes: ['b'] }], true), /^spin/);
});

test('Q2 poseFor: only real lane state maps to a pose; the rest is rest', () => {
  const t = state => ({ turn_id: 't', state, user_text: 'x', reply: '', trimmed_turns: 0 });
  const v = (state, turns = [], active = null) => ({ turns, active_turn: active, availability: { state, message: '' } });
  assert.equal(V.poseFor(null), null);
  assert.equal(V.poseFor(v('ready')), null);
  assert.equal(V.poseFor(v('ready', [t('thinking')], 't')), 'think');
  assert.equal(V.poseFor(v('ready', [t('streaming')], 't')), 'speak');
  assert.equal(V.poseFor(v('ready', [t('queued')], 't')), null);
  assert.equal(V.poseFor(v('ready', [t('waiting_approval')], 't')), null);
  assert.equal(V.poseFor(v('unavailable')), 'error');
  assert.equal(V.poseFor(v('blocked')), 'error');
  assert.equal(V.poseFor(v('ready', [t('error')])), 'error');
  assert.equal(V.poseFor(v('ready', [t('completed')])), null);
  assert.equal(V.poseFor(v('unchecked')), null);
});

test('UI.3: «Respuesta nueva» is hidden whenever the conversation is empty (found in the probe PNGs)', () => {
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(chatSrc, /if \(!turns\.length\) \{\s*newer\.hidden = true;/);
});

// ---- Q1: notices live region -----------------------------------------------
test('a notice is announced once, when a NEW one arrives, as text only', () => {
  const n = (id, title, detail) => ({ id, sessionId: 's', title, detail });
  assert.equal(V.noticeAnnouncement(null, [n('e1', 'Pi terminó su turno', 'Detalle')]),
    'Aviso: Pi terminó su turno. Detalle');
  assert.equal(V.noticeAnnouncement('e1', [n('e1', 'Pi terminó su turno', 'Detalle')]), null);
  assert.equal(V.noticeAnnouncement('e1', [n('e2', 'Otro', '')]), 'Aviso: Otro.');
  assert.equal(V.noticeAnnouncement('e1', []), null); // dismissal is not announced
  assert.equal(V.noticeAnnouncement(null, null), null);
});

test('compact island keyboard activation: Enter and Space only', () => {
  assert.equal(V.activates({ key: 'Enter' }), true);
  assert.equal(V.activates({ key: ' ' }), true);
  assert.equal(V.activates({ key: 'Enter', isComposing: true }), false);
  assert.equal(V.activates({ key: 'a' }), false);
  assert.equal(V.activates({ key: 'Enter', repeat: true }), false);
});

// ---- #309: the chat is a vertical column --------------------------------------------------------
const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const rule = sel => { const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };

test('column: the chat padding is symmetric (the 60px R6 gutter of the horizontal header is gone)', () => {
  const pad = rule('#chat').match(/padding:\s*([^;]+);/);
  assert.ok(pad, '#chat has padding');
  const parts = pad[1].trim().split(/\s+/).map(x => parseInt(x, 10));
  assert.ok(parts.length >= 3, pad[1]);
  const [, right, , left = right] = [parts[0], parts[1], parts[2], parts[3]];
  assert.equal(left, right, `left ${left} must equal right ${right}`);
  assert.ok(left <= 20, `a narrow column cannot spend ${left}px per side`);
});

test('S14 header: the agent state chip lives in the header next to the name and target («● Abito · local · Conectado»); no separate strip', () => {
  const header = html.slice(html.indexOf('id="chat-header"'), html.indexOf('</header>', html.indexOf('id="chat-header"')));
  assert.ok(header.indexOf('id="chat-title"') < header.indexOf('id="chat-target-chip"') && header.indexOf('id="chat-target-chip"') < header.indexOf('id="chat-state"'), 'name, then target, then state');
  assert.ok(header.indexOf('id="chat-state"') < header.indexOf('id="open-screen-settings"'), 'state before the right-hand controls');
  assert.doesNotMatch(html, /id="chat-status-strip"/, 'the strip is gone');
  assert.ok(html.indexOf('id="chat-state"') < html.indexOf('id="chat-log"'));
});

test('column: a message uses the column, not percentages of the old 640 width', () => {
  const user = rule('#chat-log li.user');
  const asst = rule('#chat-log li.assistant');
  assert.doesNotMatch(user, /margin-left:\s*\d+%/, 'no percentage gutter on the human bubble');
  assert.match(user, /max-width:\s*(8\d|9\d)%/);
  assert.match(asst, /max-width:\s*100%|max-width:\s*none/, 'the answer takes the whole column');
});

test('column: the composer is a full-width bottom bar and the log scrolls on its own', () => {
  assert.match(rule('#chat-body'), /flex:\s*1/);
  assert.match(rule('#chat-body'), /min-height:\s*0/);
  assert.match(rule('#chat-log'), /overflow-y:\s*auto/);
  assert.match(rule('#chat-log'), /flex:\s*1/);
  assert.match(rule('#chat-composer'), /align-items:\s*flex-end/);
  assert.match(rule('#chat-input'), /flex:\s*1/);
});

test('column: the composer grows with what is typed (up to a cap), never past the column', () => {
  const input = rule('#chat-input');
  assert.match(input, /min-height:\s*44px/);
  const max = input.match(/max-height:\s*(\d+)px/);
  assert.ok(max && Number(max[1]) >= 88 && Number(max[1]) <= 160, 'a few lines, then it scrolls');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(src, /scrollHeight/, 'the textarea is auto-sized from its content');
  assert.match(src, /input\.value = ''; autosize\(\)/, 'a sent draft shrinks the composer back');
});

test('column: touch targets stay >= 44px', () => {
  assert.match(rule('#chat-composer .round'), /width:\s*44px/);
  assert.match(rule('#chat-composer .round'), /height:\s*44px/);
  assert.match(rule('#chat-input'), /min-height:\s*44px/);
});

test('chat island: Coucou starts at 240 high inside the fixed window, at the overview width', () => {
  const island = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'island.js'), 'utf8');
  assert.match(island, /const CHAT = \{ w: 720, h: 240/);
  assert.match(island, /const CHAT = \{ w: 720/, 'S10 #480: the chat is as wide as the overview island');
  assert.match(island, /window\.__islandSetView = \(view, vw, vh\)/, 'the size still comes from Rust');
});

test('S14 composer: a 44px microphone sits before the send disc, hidden until dictation is on, and only ever sends the closed hands_free verb', () => {
  const form = html.slice(html.indexOf('id="chat-composer"'), html.indexOf('</form>', html.indexOf('id="chat-composer"')));
  assert.match(form, /<button id="chat-mic" class="round" type="button" hidden aria-label="Dictar con el micrófono">/);
  assert.ok(form.indexOf('id="chat-mic"') < form.indexOf('id="chat-send"'), 'mic, then send');
  assert.match(rule('#chat-composer .round'), /width:\s*44px/); assert.match(rule('#chat-composer .round'), /height:\s*44px/);
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(chat, /say\('hands_free'\)/); assert.match(chat, /say\('status'\)/);
  assert.match(chat, /e\.isTrusted === true/, 'a synthetic click never opens the microphone');
  assert.ok(require(path.join(__dirname, '..', 'frontend', 'icons.js')).NAMES.includes('mic'));
});
test('S14 validation: the mic is a full 44px disc and the send disc is a solid primary (white) that only dims, never greys out, for an empty draft', () => {
  const isl = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'vendor', 'coucou', 'island', 'island.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const last = sel => { const m = [...isl.matchAll(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g'))]; return m.length ? m[m.length - 1][1] : ''; };
  assert.match(last('#chat-composer #chat-mic::after'), /inset:\s*0\b/, 'the visible mic disc is the whole 44px box (it was a 28px disc inside it)');
  assert.match(last('#chat-composer #chat-send::after'), /inset:\s*0\b/, 'and so is the send disc');
  assert.match(last('#chat-composer #chat-send::after'), /background:\s*var\(--ink\)/, 'white primary');
  const dim = /opacity:\s*(0?\.\d+)/.exec(last('#chat-send:disabled::after'));
  assert.ok(dim && Number(dim[1]) >= 0.6, 'an empty draft only dims the white disc (>= .6), it does not turn it grey: ' + (dim && dim[1]));
  assert.doesNotMatch(last('#chat-send:not(:disabled)::after') + last('#chat-send::after'), /opacity:\s*0?\.[0-8]/, 'enabled is fully opaque');
});
test('S14 focus: the chat field\'s focus is a 1px accent edge (never the lime halo)', () => {
  assert.match(rule('#chat-input:focus-visible'), /outline:\s*1px solid var\(--island-live\)/);
});

test('S14 header: an undrawn state is not drawn at all (no empty dot-separator), and the header keeps its height', () => {
  assert.match(css + fs.readFileSync(path.join(__dirname, '..', 'frontend', 'vendor', 'coucou', 'island', 'island.css'), 'utf8'), /#chat-header #chat-state\[data-kind=""\]\s*\{[^}]*display:\s*none/);
});

// ---- #309 verifier: Settings and Models were designed for 640 and broke in the 400 column ---------
const COLUMN_W = 400;
const px = (text, re, d) => { const m = text.match(re); return m ? Number(m[1]) : d; };
const panelBox = id => {
  const r = rule(id);
  return { left: px(r, /left:\s*(\d+)px/, 0), right: px(r, /right:\s*(\d+)px/, 0) };
};

test('column: Settings spans the whole column (no 60px gutter left over from the 640 layout)', () => {
  for (const id of ['#settings']) {
    const b = panelBox(id);
    assert.ok(b.left <= 12, `${id} left ${b.left}px`);
    assert.ok(b.right <= 12, `${id} right ${b.right}px`);
    assert.ok(COLUMN_W - b.left - b.right >= 376, `${id} inner width ${COLUMN_W - b.left - b.right}px`);
  }
});

test('column: a settings screen is ONE row — title, connection chip and a close button pinned to the right — so nothing leaves the island', () => {
  const bar = html.slice(html.indexOf('id="settings-bar"'), html.indexOf('id="settings-hint"'));
  assert.ok(bar.indexOf('id="settings-title"') < bar.indexOf('id="settings-close"'), 'title first, close last');
  assert.ok(bar.indexOf('id="settings-conn"') < bar.indexOf('id="settings-close"'));
  assert.match(rule('#settings-close'), /margin-left:\s*auto/, 'close is pinned to the right edge');
  assert.match(rule('#settings-title'), /min-width:\s*0/, 'a long title shrinks instead of pushing close out');
  assert.match(rule('#settings-title'), /text-overflow:\s*ellipsis/);
});

test('column: #408 — the header keeps only Ajustes and Volver, so it fits the 400 header', () => {
  const header = html.slice(html.indexOf('id="chat-header"'), html.indexOf('</header>', html.indexOf('id="chat-header"')));
  const buttons = (header.match(/<button /g) || []).length;
  assert.equal(buttons, 2, 'settings, back');
  const gap = px(rule('#chat-header'), /gap:\s*(\d+)px/, 0);
  const inner = COLUMN_W - 24 /* gutters */ - 52 /* R6 */;
  const need = buttons * 44 + 70 /* the «local» chip */ + gap * buttons;
  assert.ok(need <= inner, `header needs ${need}px of ${inner}px`);
});

test('column: the sticky controls cannot be hidden by the content (close is not inside the scrolling body)', () => {
  assert.ok(html.indexOf('id="settings-close"') < html.indexOf('id="settings-body"'));
  assert.match(rule('#settings-body'), /overflow-y:\s*auto/);
});

test('column: with a screen open the chat header STAYS visible (gentle-dot): the header buttons switch screens, the panel carries its own close', () => {
  assert.doesNotMatch(css, /#capsule\[data-settings="open"\][^{]*#chat-header[^{]*\{[^}]*visibility:\s*hidden/, 'nothing hides the header');
  assert.ok(html.includes('id="settings-close"') && /aria-label="Cerrar/.test(html));
  const setCss = rule('#settings');
  assert.match(setCss, /left:\s*12px/);
  assert.match(setCss, /right:\s*12px/);
  assert.match(setCss, /top:\s*5\d px|top:\s*(5\d|6\d)px/, 'the panel starts BELOW the header');
  assert.match(html, /id="open-screen-settings"[^>]*aria-expanded="false"/);
});

test('column: the account-name field never truncates its own placeholder', () => {
  const field = rule('.sfield');
  assert.match(field, /min-width:\s*(\d+)px/);
  const min = px(field, /min-width:\s*(\d+)px/, 0);
  assert.ok(min >= 140 || /flex:\s*1\s+1\s+100%/.test(rule('#settings-body .sform .sfield[type="text"]')) , `min-width ${min}px cannot show «Nombre de la cuenta»`);
});

test('column: the provider search box is a single 44px field, never a stretched block', () => {
  const r = rule('#settings-filter');
  assert.match(r, /flex:\s*0\s+0\s+auto/, 'it must not grow inside the column body');
  assert.match(r, /height:\s*44px|min-height:\s*44px/);
  assert.match(r, /max-height:\s*44px|height:\s*44px/);
});

// ---- #310 flicker: the history is RECONCILED, never rebuilt ---------------------------------------
// Measured with the probe: sending one message removed 23 nodes to go from 2 to 4 rows and the first row jumped twice.
test('reconcile: rows that did not change are kept as they are', () => {
  const row = (kind, text) => ({ kind, text });
  const before = [row('user', 'hola'), row('assistant', 'Hola, soy')];
  assert.deepEqual(V.reconcileRows(before, before), { keep: 2, patch: [], append: [], remove: 0 }, 'identical = nothing to do');
  const grown = [row('user', 'hola'), row('assistant', 'Hola, soy Koda'), row('user', 'otra')];
  const plan = V.reconcileRows(before, grown);
  assert.equal(plan.keep, 1, 'the unchanged first row is untouched');
  assert.deepEqual(plan.patch, [{ index: 1, row: grown[1] }], 'a streaming answer is patched in place');
  assert.deepEqual(plan.append, [grown[2]]);
  assert.equal(plan.remove, 0);
});

test('reconcile: a shorter list removes only the tail; a kind change replaces one row; empty -> rows and back', () => {
  const r = (kind, text) => ({ kind, text });
  assert.deepEqual(V.reconcileRows([r('user', 'a'), r('user', 'b'), r('user', 'c')], [r('user', 'a')]), { keep: 1, patch: [], append: [], remove: 2 });
  const swap = V.reconcileRows([r('user', 'a'), r('note', 'x')], [r('user', 'a'), r('error', 'x')]);
  assert.equal(swap.keep, 1); assert.equal(swap.patch.length, 1);
  assert.deepEqual(V.reconcileRows([], [r('user', 'a')]), { keep: 0, patch: [], append: [r('user', 'a')], remove: 0 });
  assert.deepEqual(V.reconcileRows([r('user', 'a')], []), { keep: 0, patch: [], append: [], remove: 1 });
  assert.deepEqual(V.reconcileRows(null, null), { keep: 0, patch: [], append: [], remove: 0 });
});

test('reconcile: the key of a row covers everything the page draws (so a changed icon or word is never skipped)', () => {
  const a = { kind: 'note', text: 'x', short: 'Recortado', icon: 'info' };
  assert.equal(V.rowKey(a), V.rowKey({ ...a }));
  for (const change of [{ text: 'y' }, { short: 'Otro' }, { icon: 'cross' }, { kind: 'error' }]) assert.notEqual(V.rowKey(a), V.rowKey({ ...a, ...change }), JSON.stringify(change));
});

test('flicker: renderLog uses the reconciler and never empties the log while turns exist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  const fn = src.slice(src.indexOf('function renderLog'), src.indexOf('function renderControls'));
  assert.match(fn, /V\.reconcileRows\(/);
  assert.doesNotMatch(fn, /log\.textContent = ''(?![^]*empty)/, 'no unconditional wipe of the history');
  assert.match(fn, /classList\.add\('enter'\)/, 'only NEW rows animate');
});

// ---- F027 / TaskView342: the personalized empty-chat greeting -----------------
// The neutral sentence is shipped copy: it may not drift when a name is absent.
const NEUTRAL_EMPTY_ARIA = 'Escribile a Koda. Responde el modelo local de esta máquina; no ve tu pantalla ni ejecuta nada.';

test('greeting: an explicit name yields «Hola, <nombre>.», absent or blank keeps the shipped neutral sentence', () => {
  const named = V.emptyGreeting({ display_name: 'Ana' });
  assert.equal(named.greeting, 'Hola, Ana.');
  assert.equal(named.aria, `Hola, Ana. ${NEUTRAL_EMPTY_ARIA}`);
  assert.deepEqual(named.icons, [], 'T7.3 design isla-chat-empty: no lock/eye-off icons (was [lock, eye-off])');
  assert.equal(named.line, 'Escribile a Koda', 'the one visible line of the empty state');
  for (const view of [undefined, null, {}, { display_name: null }, { display_name: '' },
    { display_name: '   ' }, { display_name: '\n\t ' }, { display_name: '\u0000\u001f' }]) {
    assert.deepEqual(V.emptyGreeting(view), { greeting: '', aria: NEUTRAL_EMPTY_ARIA, icons: [], line: 'Escribile a Koda' },
      JSON.stringify(view));
  }
});

test('greeting: a non-string display_name is absent, never coerced (fail closed)', () => {
  for (const value of [42, true, {}, [], () => {}, Symbol('x')]) {
    assert.equal(V.emptyGreeting({ display_name: value }).greeting, '', String(typeof value));
    assert.equal(V.cleanDisplayName(value), '');
  }
});

test('greeting: the name is plain text — markup, quotes and ampersands stay text, control characters become spaces', () => {
  const markup = '<img src=x onerror=alert(1)>';
  assert.equal(V.emptyGreeting({ display_name: markup }).greeting, `Hola, ${markup}.`);
  assert.equal(V.emptyGreeting({ display_name: '"' }).greeting, 'Hola, ".');
  assert.equal(V.emptyGreeting({ display_name: '"&<>&' }).greeting, 'Hola, "&<>&.');
  assert.equal(V.emptyGreeting({ display_name: 'Ana\nMaría' }).greeting, 'Hola, Ana María.');
  assert.equal(V.emptyGreeting({ display_name: '  Ana  ' }).greeting, 'Hola, Ana.');
  assert.equal(V.emptyGreeting({ display_name: 'A\u0000B\u007fC' }).greeting, 'Hola, A B C.');
  assert.equal(V.emptyGreeting({ display_name: '<script>alert(1)</script>' }).greeting, 'Hola, <script>alert(1)</script>.');
});

test('greeting: the name is bounded to 80 Unicode scalars, never splitting a surrogate pair', () => {
  assert.equal(V.cleanDisplayName('a'.repeat(120)), 'a'.repeat(80));
  // the bound counts scalars, like the onboarding validator (len(name) <= 80 in Python)
  assert.equal(Array.from(V.cleanDisplayName('😀'.repeat(81))).length, 80);
  assert.equal(V.cleanDisplayName('😀'.repeat(81)), '😀'.repeat(80));
  assert.equal(V.emptyGreeting({ display_name: '😀'.repeat(81) }).greeting, `Hola, ${'😀'.repeat(80)}.`);
  assert.equal(V.cleanDisplayName('😀'.repeat(80)), '😀'.repeat(80), 'a name at the bound is untouched');
});

test('greeting: the page writes the greeting with textContent and never puts the name into HTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  const fn = src.slice(src.indexOf('function renderLog'), src.indexOf('function renderControls'));
  assert.match(fn, /V\.emptyGreeting\(/, 'the empty state comes from the frozen helper');
  assert.match(fn, /textContent = g\.greeting/, 'the greeting is written as text');
  // Only the empty-state path is in scope; existing closed-registry icon writes
  // elsewhere retain their previous implementation.
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no markup sink in the greeting renderer');
});

// ---- K2-05 U5c: the read-only line saying which model the engine answers with --------------------
test('U5c model line: the engine\'s model name as plain text, id when it has no name', () => {
  assert.deepEqual(V.engineModelLine({ engine_model: { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' } }),
    { text: 'Claude Sonnet 5.5', aria: 'Koda responde con el modelo Claude Sonnet 5.5' });
  assert.equal(V.engineModelLine({ engine_model: { id: 'gpt-x' } }).text, 'gpt-x');
  assert.equal(V.engineModelLine({ engine_model: { id: 'gpt-x', name: '  ' } }).text, 'gpt-x');
});

test('U5c model line: unknown shows NOTHING (never a placeholder name)', () => {
  for (const view of [null, undefined, {}, { engine_model: null }, { engine_model: {} }, { engine_model: 'x' }, { engine_model: { id: '' } }, { engine_model: { id: 7 } }]) {
    assert.equal(V.engineModelLine(view), null, JSON.stringify(view));
  }
});

test('U5c model line: control characters and length are bounded, it is only ever text', () => {
  const line = V.engineModelLine({ engine_model: { id: 'a\nb\u0000c', name: `${'x'.repeat(200)}` } });
  assert.equal(line.text.length, 128);
  assert.equal(V.engineModelLine({ engine_model: { id: 'a\nb\u0000c' } }).text, 'a b c');
});

test('U5c: the chat has NO model picker — no helper, no button, no picker markup, no models_action call', () => {
  for (const name of ['modelRows', 'modelMeters', 'modelsInfo', 'modelsCount', 'filterChosen', 'modelButtonLabel', 'modelButtonAria', 'modelButtonEnabled', 'modelRoleNote', 'gateLabel']) {
    assert.equal(V[name], undefined, `${name} is gone`);
  }
  for (const id of ['chat-model-row', 'chat-model-btn', 'chat-model-name', 'chat-model-picker', 'chat-model-note']) {
    assert.ok(!html.includes(`id="${id}"`), `${id} is gone`);
  }
  const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.doesNotMatch(chatSrc, /models_action|set_chosen_models|chosenModels|setPicker|selectModel/);
});

test('U5c markup: the line sits between «Respuesta nueva» and the composer, hidden until a model is known, with no control inside', () => {
  const tag = /<p[^>]*id="chat-model-line"[^>]*>/.exec(html);
  assert.ok(tag, 'the line exists');
  assert.match(tag[0], /hidden/, 'hidden until the engine reports a model');
  assert.doesNotMatch(tag[0], /<button|tabindex/);
  const newer = html.indexOf('id="chat-new"');
  const line = html.indexOf('id="chat-model-line"');
  const composer = html.indexOf('id="chat-composer"');
  assert.ok(newer > -1 && line > newer && composer > line, 'between the new-answer button and the composer');
});

test('B4: snapshot ordering uses per-turn sequence, never a global sequence across conversations', () => {
  const snap = (seq, state = 'thinking', conversation_id = 'c1') => ({ conversation_id, turns: [{ turn_id: 't-1', seq, state }] });
  for (const state of ['thinking', 'streaming', 'completed', 'cancelled', 'error']) {
    assert.equal(V.staleSnapshot(snap(3, state), snap(1)), true, state + ' never goes backwards');
    assert.equal(V.staleSnapshot(snap(3, state), snap(3, state)), false, 'duplicate is accepted');
    assert.equal(V.staleSnapshot(snap(3, state), snap(4)), false, 'newer is accepted');
  }
  assert.equal(V.staleSnapshot(snap(3), snap(0, 'queued', 'c2')), false, 'new conversation may start at zero');
  assert.equal(V.staleSnapshot(null, snap(1)), false, 'initial snapshot');
  assert.equal(V.staleSnapshot(snap(3), { conversation_id: 'c1', turns: [] }), false, 'no comparable turns');
  assert.equal(V.staleSnapshot(snap(3), { conversation_id: 'c1', turns: [{ turn_id: 't-2', seq: 0 }] }), false, 'a new turn has its own sequence');
});

test('S3 (#503): a turn that carried live context gets a «Contexto» disclosure row with the exact text; one without gets none', () => {
  const base = { turn_id: 't', state: 'completed', user_text: 'q', reply: 'r', trimmed_turns: 0 };
  assert.equal(V.turnRows(base).some(r => r.kind === 'context'), false);
  const rows = V.turnRows({ ...base, live_context: { text: 'Estado en vivo\n- Pi en api: trabajando', trimmed_lines: 0 } });
  assert.deepEqual(rows.map(r => r.kind), ['user', 'context', 'assistant']);
  assert.equal(rows[1].detail, 'Estado en vivo\n- Pi en api: trabajando');
  assert.equal(rows[1].short, 'Contexto');
  const cut = V.turnRows({ ...base, live_context: { text: 'x', trimmed_lines: 3 } })[1];
  assert.match(cut.text, /3 líneas recortadas/);
  assert.equal(V.turnRows({ ...base, live_context: { text: '', trimmed_lines: 0 } }).some(r => r.kind === 'context'), false);
  assert.equal(V.turnRows({ ...base, live_context: { text: 5 } }).some(r => r.kind === 'context'), false);
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(chat, /row\.kind === 'context'/);
});

test('K2-05 T4 U4: one continuous chat — the conversation and specialist row helpers are gone (L3/L4/L11)', () => {
  assert.equal(V.specialistRows, undefined);
  assert.equal(V.conversationRows, undefined);
});

console.log(`chat-view-check: ${passed} passed`);

// ---- S10 (human L35): Coucou's growing chat height -----------------------------------------------------------------
test('chat height: Coucou\'s chatPromptHeight (240 + 40 per message, capped at 300), counted on what the log shows', () => {
  assert.deepEqual([V.CHAT_MIN_H, V.CHAT_MAX_H], [240, 300]);
  const turn = (reply) => ({ turn_id: 't-1', user_text: 'hola', reply });
  assert.equal(V.chatHeight(null), 240); assert.equal(V.chatHeight({}), 240); assert.equal(V.chatHeight({ turns: [] }), 240);
  assert.equal(V.chatHeight({ turns: [turn('')] }), 280, 'a human message with no reply yet: 1 message');
  assert.equal(V.chatHeight({ turns: [turn('ok')] }), 300, 'human + reply = 2 messages: 240 + 80 = 320 → capped at 300');
  assert.equal(V.chatHeight({ turns: Array.from({ length: 50 }, () => turn('x')) }), 300, 'the cap, scrolling beyond');
  assert.equal(V.messageCount({ turns: [turn('a'), null, 5, turn('')] }), 3, 'garbage rows are not messages');
  assert.equal(V.messageCount({ turns: 'x' }), 0);
});

test('chat height wiring: the page reports it through the closed `height` verb, only in the chat view, only when it changed, once at a time', () => {
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(chat, /action\(\{ action: 'height', height: wanted \}\)/);
  assert.match(chat, /if \(capsule\.dataset\.view !== 'chat' \|\| reporting\) return;/);
  assert.match(chat, /if \(wanted === reportedHeight\) return;/);
  assert.match(chat, /view = next;\s*reportHeight\(\);/, 'every new conversation view is measured');
  assert.match(chat, /island:view[^\n]*reportedHeight = 0/, 'opening the chat measures it again');
});

// ---- K2-05 T4 U3: the daemon engine's chat:state renders through the SAME page helpers ----------------------------
// The shape below is exactly what chatclient::ChatHost::project + chathost::chat_view emit (the Rust unit test
// `chathost_the_projection_keeps_the_page_keys_and_turn_shape` pins the same key lists): one continuous chat
// (`c-koda`), no local target (the engine owns the model), producer.pi = the real engine state, and turn ids
// `t-<n>` numbered so older history pages sort first.
const U3_KEYS = ['active_turn', 'availability', 'chat_visible', 'conversation_id', 'conversation_specialist', 'display_name', 'evicted',
  'history_before', 'history_persisted', 'history_problem', 'history_skipped', 'producer', 'queue_note', 'target', 'turns', 'view'];
const U3_TURN_KEYS = ['attachments', 'error', 'finish_reason', 'profile_id', 'profile_revision', 'reply', 'request_id', 'seq', 'state',
  'trimmed_turns', 'turn_id', 'user_text'];
const u3Turn = (n, user, reply, state, seq, error = null) => ({ turn_id: `t-${n}`, request_id: null, state, seq, user_text: user, reply,
  finish_reason: null, error, trimmed_turns: 0, profile_id: null, profile_revision: null, attachments: [] });
const u3State = (turns, over = {}) => ({ conversation_id: 'c-koda', active_turn: null, turns, evicted: 0, queue_note: null,
  availability: { state: 'ready', message: 'El motor de Koda está listo.' }, history_before: null, history_skipped: 0, history_problem: null,
  history_persisted: true, conversation_specialist: null, target: null, producer: { pi: 'ready', note: 'Chat con el motor de Koda.' },
  display_name: null, view: 'chat', chat_visible: [400, 300], ...over });

test('U3: the engine chat:state keeps the page keys and the turn shape', () => {
  const v = u3State([u3Turn(1000000000, 'hola', 'buenas', 'completed', 4)]);
  assert.deepEqual(Object.keys(v).sort(), U3_KEYS);
  assert.deepEqual(Object.keys(v.turns[0]).sort(), U3_TURN_KEYS);
});

test('U3: a streamed engine reply renders, announces once and drives the controls', () => {
  const thinking = u3State([u3Turn(1000000000, '¿Quién sos?', '', 'thinking', 3)], {
    active_turn: 't-1000000000', availability: { state: 'busy', message: 'El motor de Koda está respondiendo.' }, producer: { pi: 'busy', note: 'Chat con el motor de Koda.' } });
  const streaming = u3State([u3Turn(1000000000, '¿Quién sos?', 'Soy Ko', 'streaming', 4)], {
    active_turn: 't-1000000000', availability: thinking.availability, producer: thinking.producer });
  const done = u3State([u3Turn(1000000000, '¿Quién sos?', 'Soy Koda.', 'completed', 5)]);
  assert.equal(V.activeTurn(streaming).turn_id, 't-1000000000');
  assert.equal(V.sendState(streaming, 'otra', false).disabled, true, 'a running turn: cancel is the control');
  assert.equal(V.poseFor(thinking), 'think');
  assert.equal(V.poseFor(streaming), 'speak');
  assert.deepEqual(V.turnRows(streaming.turns[0]).map(r => [r.kind, r.text]), [['user', '¿Quién sos?'], ['assistant', 'Soy Ko']]);
  assert.equal(V.staleSnapshot(thinking, streaming), false);
  assert.equal(V.staleSnapshot(done, streaming), true, 'an older push never resurrects the running turn');
  assert.equal(V.announcement(thinking, streaming), 'Escribiendo…');
  assert.equal(V.announcement(streaming, done), 'Koda respondió: Soy Koda.');
  assert.equal(V.statusView(done).word, 'Conectado');
  assert.equal(V.canSend(done, 'hola', false), true);
  assert.equal(V.needsCheck(done), false, 'no local target: the page never loops on the local-model check');
});

test('U3: engine errors, cancellation and an unavailable engine use the existing rows and words', () => {
  const err = u3State([u3Turn(1000000000, 'hola', '', 'error', 6, { code: 'busy', safe_message: 'El motor de Koda está atendiendo otro mensaje; probá de nuevo en un momento.', retryable: true })]);
  assert.deepEqual(V.turnRows(err.turns[0]).map(r => r.kind), ['user', 'error']);
  assert.equal(V.poseFor(err), 'error');
  const cancelled = u3State([u3Turn(1000000000, 'hola', 'parte', 'cancelled', 7)]);
  assert.deepEqual(V.turnRows(cancelled.turns[0]).map(r => r.kind), ['user', 'assistant', 'note']);
  const down = u3State([], { availability: { state: 'unavailable', message: 'El motor de Koda no está disponible todavía.' }, producer: { pi: 'unavailable', note: 'Chat con el motor de Koda.' } });
  assert.equal(V.statusView(down).kind, 'down');
  assert.equal(V.statusLine(down), 'El motor de Koda no está disponible todavía.');
  assert.ok(V.sendState(down, 'hola', false).blocked, 'pressing send says why');
  assert.equal(V.canSend(down, 'hola', false), false);
});

test('U3: an earlier engine history page joins the run before the live turns, in the order given (never re-sorted)', () => {
  const live = [u3Turn(40, 'segunda', 'dos', 'completed', 9), u3Turn(4503599627370497, 'tercera', 'tres', 'completed', 9)];
  const older = [u3Turn(12, 'primera', 'uno', 'completed', 10)];
  assert.deepEqual(V.mergeHistory(older, live).map(t => t.user_text), ['primera', 'segunda', 'tercera']);
  // an island turn the record does not carry sits where the host put it, even with a larger number
  const island = [u3Turn(4503599627370490, 'rechazada', '', 'error', 3), u3Turn(20, 'después', 'r', 'completed', 3)];
  assert.deepEqual(V.mergeHistory(island, live).map(t => t.user_text), ['rechazada', 'después', 'segunda', 'tercera']);
  // the live window wins on a shared id, and a repeated id is shown once
  assert.deepEqual(V.mergeHistory([u3Turn(40, 'vieja', '', 'completed', 1), ...older, ...older], live).map(t => t.user_text), ['primera', 'segunda', 'tercera']);
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.match(chat, /action\(\{ action: 'history', conversation_id: id, before: cursor \}\)/, 'the page passes the cursor back unchanged');
  assert.match(chat, /historyBefore = page\.before \|\| null;/);
  // U4 (F2): the cursor follows every chat:state (the conversation id is the constant c-koda), not only a reset
  assert.match(chat, /followWindow\(next\);\s*view = next;/);
  // F2 follow-up: until an earlier page answered (even with no whole turn) the cursor follows the window
  assert.match(chat, /if \(!runStarted\) \{ historyBefore = next\.history_before \|\| null; return; \}/);
});

test('S2 paging: turns that leave the live window keep their place; scroll-triggered pages are coalesced', () => {
  const t = n => u3Turn(n, `q${n}`, `r${n}`, 'completed', 1);
  assert.deepEqual(V.leftWindow([t(1), t(2), t(3)], [t(2), t(3), t(4)]).map(x => x.turn_id), ['t-1']);
  assert.deepEqual(V.leftWindow([t(1), t(2)], [t(1), t(2), t(3)]), [], 'a grown window drops nothing');
  assert.deepEqual(V.leftWindow([t(1), t(2)], [t(9)]).map(x => x.turn_id), ['t-1', 't-2'], 'a window that moved past: all of it left');
  assert.equal(V.pageWait(1000, 0), 0);
  assert.equal(V.pageWait(1000, 1000), V.PAGE_GAP_MS);
  assert.ok(60000 / V.PAGE_GAP_MS <= 100, 'paging stays inside the read share of the island budget (120 − 20 reserved)');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chat.js'), 'utf8');
  assert.doesNotMatch(chat, /capPage|newerCursor|detached|droppedNewer/, 'no cap, no detached slice, no host-computed cursor');
});

test('S2 paging: an earlier page is inserted on top without repainting what is drawn', () => {
  const r = (kind, text) => ({ kind, text });
  const drawn = [r('user', 'c'), r('assistant', 'C')];
  const plan = V.reconcileRows(drawn, [r('user', 'a'), r('assistant', 'A'), ...drawn]);
  assert.deepEqual(plan, { keep: 2, patch: [], append: [], remove: 0, prepend: [r('user', 'a'), r('assistant', 'A')] });
});
console.log(`chat-view-check (U3 engine shape): ${passed} passed`);

// K2-05 boot order = Gentle Dot (ChatSurface statusText + `ready` excludes starting/restarting): while the
// engine starts or restarts the chat SAYS so in Spanish, as a wait (live tone, spinner), never «Modelo caído»,
// and the send stays refused with the same sentence.
{
  const A = require('node:assert/strict');
  const V3 = require(path.join(__dirname, '..', 'frontend', 'chat-view.js'));
  const boot = (state, message) => ({ turns: [], active_turn: null, queue_note: null, target: null,
    availability: { state, message }, producer: { pi: state === 'starting' ? 'connected' : 'unavailable', note: 'Chat con el motor de Koda.' } });
  const starting = boot('starting', 'Koda está arrancando… abriendo tu conversación.');
  const restarting = boot('restarting', 'Koda se está reiniciando… abriendo tu conversación.');
  for (const [v, word] of [[starting, 'Arrancando…'], [restarting, 'Reiniciando…']]) {
    const sv = V3.statusView(v);
    A.deepEqual([sv.kind, sv.tone, sv.icon, sv.word], ['checking', 'live', 'ring', word], v.availability.state + ' (the existing spinner kind)');
    A.notEqual(sv.word, 'Modelo caído');
    A.equal(sv.aria, v.availability.message, 'the full Spanish sentence is the aria');
    A.equal(V3.statusLine(v), v.availability.message);
    A.equal(V3.canSend(v, 'hola', false), false, 'sends are refused until the engine is ready');
    A.equal(V3.sendState(v, 'hola', false).blocked, v.availability.message, 'pressing send says Koda is starting');
    A.equal(V3.poseFor(v), null, 'a start is not an error pose');
    A.equal(V3.needsCheck(v), false, 'no local-model check loop while the engine starts');
  }
  A.equal(V3.statusView(boot('unavailable', 'El motor de Koda no está disponible todavía.')).word, 'Modelo caído', 'a real outage keeps its word');
  console.log('chat-view-check: K2-05 boot order passed');
}

// K2-05 attachments (Gentle Dot): files alone may be sent; a turn's files are one chips row
{
  const V2 = require(require('node:path').join(__dirname, '..', 'frontend', 'chat-view.js'));
  const ready = { availability: { state: 'ready' }, active_turn: null };
  require('node:assert/strict').equal(V2.canSend(ready, '', false, 2), true);
  require('node:assert/strict').equal(V2.canSend(ready, '', false), false);
  const rows = V2.turnRows({ turn_id: 't-1', user_text: 'hola', attachments: [{ name: 'a\u0000b.txt', size: 3, mime: 'x' }, { name: 5 }] });
  require('node:assert/strict').deepEqual(rows.map(r => r.kind), ['user', 'attachments']);
  require('node:assert/strict').deepEqual(rows[1].files, [{ name: 'a b.txt', size: '3 B' }], 'names are cleaned, malformed entries dropped');
  require('node:assert/strict').equal(V2.sameTurn({ turn_id: 't-1', attachments: [{ name: 'a', size: 1 }] }, { turn_id: 't-1', attachments: [{ name: 'a', size: 2 }] }), false);
  console.log('chat-view-check: K2-05 attachments passed');
}
