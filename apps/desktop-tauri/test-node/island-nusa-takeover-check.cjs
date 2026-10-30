'use strict';
/* HU-057 T5 (S7, S8): Pregunta / Permiso / Terminó / Error take the notch look while the legacy cards keep their DOM and behaviour.
   Pure model (N.takeoverState / N.takeoverTitle) + static source check of the CSS selectors and of what the mount and island.js do NOT touch.
   Run: node test-node/island-nusa-takeover-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, '..', 'frontend');
const read = f => fs.readFileSync(path.join(F, f), 'utf8');
const N = require(path.join(F, 'island-nusa.js'));
const css = read('island-nusa.css'), mount = read('island-nusa-mount.js'), island = read('island.js');
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
const open = extra => ({ phase: 'expanded', view: 'overview', ...extra });

test('takeoverState: question pending / expired / outcome and a pending card wait for the human', () => {
  assert.equal(N.takeoverState(open({ question: 'pending' })), 'waiting');
  assert.equal(N.takeoverState(open({ question: 'expired' })), 'waiting');
  assert.equal(N.takeoverState(open({ question: 'outcome' })), 'waiting');
  assert.equal(N.takeoverState(open({ card: 'pending' })), 'waiting');
  assert.equal(N.takeoverState(open({ card: 'covered' })), 'waiting');
});
test('takeoverState: finished lane, error notice, engine band', () => {
  assert.equal(N.takeoverState({ phase: 'expanded', view: 'notices', noticeView: 'notices' }), 'finished');
  assert.equal(N.takeoverState({ phase: 'expanded', view: 'notices', noticeView: 'notices', severity: 'error' }), 'error');
  assert.equal(N.takeoverState(open({ engineBand: 'on' })), 'error');
});
test('takeoverState: nothing otherwise, and waiting outranks error outranks finished', () => {
  assert.equal(N.takeoverState(open({})), null);
  assert.equal(N.takeoverState(open({ engineBand: 'off', question: '' })), null);
  assert.equal(N.takeoverState(open({ engineBand: 'omitted' })), null);
  assert.equal(N.takeoverState({ phase: 'compact', question: 'pending' }), null);
  assert.equal(N.takeoverState(null), null);
  assert.equal(N.takeoverState(open({ question: 'pending', engineBand: 'on' })), 'waiting');
  assert.equal(N.takeoverState({ phase: 'expanded', view: 'notices', noticeView: 'notices', engineBand: 'on' }), 'error');
});
test('takeoverTitle: Pregunta / Permiso / Terminó / Error (engine band keeps the tab title)', () => {
  assert.equal(N.takeoverTitle(open({ question: 'pending' })), 'Pregunta');
  assert.equal(N.takeoverTitle(open({ question: 'pending', look: 'approval' })), 'Permiso');
  assert.equal(N.takeoverTitle(open({ card: 'pending' })), 'Permiso');
  assert.equal(N.takeoverTitle({ phase: 'expanded', view: 'notices', noticeView: 'notices' }), 'Terminó');
  assert.equal(N.takeoverTitle({ phase: 'expanded', view: 'notices', noticeView: 'notices', severity: 'error' }), 'Error');
  assert.equal(N.takeoverTitle(open({ question: 'outcome', outcomeWord: 'Recibida' })), 'Recibida'); // HU-075
  assert.equal(N.takeoverTitle(open({ question: 'outcome', outcomeWord: 'Ocupada' })), 'Ocupada');
  assert.equal(N.takeoverTitle(open({ question: 'outcome' })), 'Pregunta'); // no word yet: unchanged
  assert.equal(N.takeoverTitle(open({ question: 'pending', outcomeWord: 'Recibida' })), 'Pregunta'); // a stale word never leaks into a pending card
  assert.equal(N.takeoverTitle(open({ engineBand: 'on' })), '');
  assert.equal(N.takeoverTitle(open({})), '');
});
test('veil colour of a takeover keeps its role (S13): waiting=--sun, error=--red-11, finished=--go', () => {
  assert.equal(N.veilColor('waiting'), 'var(--sun)');
  assert.equal(N.veilColor('error'), 'var(--red-11)');
  assert.equal(N.veilColor('finished', undefined), 'var(--go)');
});
test('css: notch shell, hidden legacy chrome, veil shown for every takeover state', () => {
  for (const s of ['waiting', 'finished', 'error']) assert.ok(css.includes(`[data-takeover="${s}"]`), s);
  assert.ok(/data-takeover[^{]*#island\s*\{[^}]*background:\s*#000[^}]*border-radius:\s*0 0 26px 26px/.test(css), 'notch shell on #island');
  // HU-073 (human choice «02»): the legacy header is NO LONGER hidden wholesale in the Nusa states (that also hid Ajustes · Silenciar · Plegar, a regression of HU-057).
  // Blobs / minibots / overview stay hidden, and inside the header only the three action nodes show: its tabs, pin and plan pills are hidden. The real-layout
  // proof that the three controls are visible and clickable is island-nusa-header-controls-check.
  assert.ok(/data-takeover[^{]*:is\(#blobs, #minibots, #overview-view\)[^{]*\{[^}]*visibility:\s*hidden/.test(css), 'legacy blobs + minis + overview hidden');
  assert.ok(!/data-takeover[^{]*:is\(#island-header, #blobs/.test(css), 'the legacy header is not hidden wholesale (HU-073)');
  assert.ok(/data-takeover[^{]*#island-header :is\(\.tabs, #island-pin, \.plan-pills, \.plan-pill\)[^{]*\{[^}]*display:\s*none/.test(css), 'header tabs, pin and plan pills hidden in the notch (HU-073)');
  assert.ok(/data-takeover[^{]*#island-header[^{]*\{[^}]*visibility:\s*visible/.test(css), 'the header shows its three action nodes in the take-over states (HU-073)');
  assert.ok(/data-takeover[^{]*#nusa-veil/.test(css) && /data-takeover[^{]*#nusa-head/.test(css), 'veil + header strip shown');
  assert.ok(/data-takeover[^{]*:is\(#nusa-panel, #nusa-state, #nusa-dots[^{]*\{[^}]*display:\s*none/.test(css), 'tab body hidden in takeover');
  assert.ok(/#nusa-ear/.test(css) && /dataset\.takeover/.test(mount), 'ears follow the takeover');
});
test('css: finished lane band sits inside the 150 notch (top 144 no longer 178)', () => {
  assert.ok(/data-notice-view="notices"\] #notices[^{]*\{[^}]*top:\s*(144|\d{2})px/.test(css) || /data-takeover="finished"[^{]*#notices[^{]*\{[^}]*top:/.test(css));
});
test('mount: derives the state from the model, never from agent colour, and sends nothing', () => {
  assert.ok(/N\.takeoverState\(/.test(mount) && /N\.takeoverTitle\(/.test(mount));
  assert.ok(/dataset\.takeover/.test(mount));
  assert.ok(!/invoke\(|\.click\(\)|dispatchEvent\(new (Mouse|Keyboard)/.test(mount), 'no host verb or synthetic input');
});
test('legacy behaviour untouched: question / approval / card handlers keep their code', () => {
  assert.ok(/noticeCard\.dataset\.severity\s*=/.test(island), 'island.js only exposes the notice severity (display data)');
  assert.ok(!/\bapprove\b[^;\n]*dataset\.takeover/.test(island), 'no approval flow reads takeover');
});
test('HU-063 T4 mount: --agent-notice painted from the desktop snapshot; finished veil uses the notice agent; no island.js edit', () => {
  assert.ok(/--agent-notice/.test(mount) && /N\.noticeAgentColor\(/.test(mount));
  assert.ok(/desktop\.(snapshot|onState)/.test(mount), 'agent read from the published snapshot');
  assert.ok(!/--agent-notice/.test(island), 'island.js untouched');
});
console.log(`island-nusa-takeover-check: ${passed} passed`);

// ---- HU-063 bug (human decision A, 28-oct): the question WINS over the chat; the chat is dimmed and inert, never hidden ----
(() => {
  const chat = extra => ({ phase: 'expanded', view: 'chat', ...extra });
  test('chat view: a pending question / card / outcome is NOT a take-over (no black shell, header or veil under the chat)', () => {
    for (const d of [{ question: 'pending' }, { question: 'expired' }, { question: 'outcome' }, { card: 'pending' }]) assert.equal(N.takeoverState(chat(d)), null, JSON.stringify(d));
    assert.equal(N.takeoverTitle(chat({ question: 'pending' })), '');
  });
  test('the overview and the notices lane still take over for the same facts', () => {
    assert.equal(N.takeoverState({ phase: 'expanded', view: 'overview', question: 'pending' }), 'waiting');
    assert.equal(N.takeoverState({ phase: 'expanded', view: 'notices', noticeView: 'notices', question: 'pending' }), 'waiting');
    assert.equal(N.takeoverState({ phase: 'expanded', view: 'notices', noticeView: 'notices' }), 'finished');
  });
  test('chatInert: chat view + pending/expired/outcome question or a card', () => {
    for (const d of [{ question: 'pending' }, { question: 'expired' }, { question: 'outcome' }, { card: 'pending' }, { card: 'covered' }]) assert.equal(N.chatInert(chat(d)), true, JSON.stringify(d));
  });
  test('chatInert: false without a question/card, outside the chat, or on bad input', () => {
    for (const d of [chat({}), chat({ question: '' }), chat({ question: 'idle' }), { view: 'overview', question: 'pending' }, { view: 'notices', card: 'pending' }, null, undefined]) assert.equal(N.chatInert(d), false, JSON.stringify(d));
  });
  test('style.css dims the chat (pointer-events none) under a pending question and does NOT hide #question', () => {
    const sheet = read('style.css');
    assert.match(sheet, /#capsule\[data-view="chat"\]:is\(\[data-question="pending"\],\[data-question="expired"\],\[data-question="outcome"\],\[data-card\]\) #chat\s*\{[^}]*opacity:\s*\.45[^}]*pointer-events:\s*none/);
    assert.ok(!/data-view="chat"\][^{]*#question\s*\{[^}]*visibility:\s*hidden/.test(sheet), '#question is never hidden by the chat view');
  });
  test('mount applies inert + aria-hidden on #chat from chatInert and moves focus to the question card', () => {
    assert.match(mount, /N\.chatInert\(/); assert.match(mount, /\.inert\s*=/); assert.match(mount, /aria-hidden/);
  });
})();
console.log(`island-nusa-takeover-check (chat view): ${passed} passed`);

// ---- «un "Terminó" nunca sin contenido»: the lane take-over exists only while its card is shown (d.cardShown) ----
(() => {
  const lane = extra => ({ phase: 'expanded', view: 'notices', noticeView: 'notices', ...extra });
  test('cardShown false: the open lane takes nothing over (finished and error)', () => {
    assert.equal(N.takeoverState(lane({ cardShown: false })), null);
    assert.equal(N.takeoverState(lane({ cardShown: false, severity: 'error' })), null);
    assert.equal(N.takeoverTitle(lane({ cardShown: false })), '');
  });
  test('cardShown true / undefined keep finished and error', () => {
    for (const c of [{ cardShown: true }, {}]) {
      assert.equal(N.takeoverState(lane(c)), 'finished');
      assert.equal(N.takeoverState(lane({ ...c, severity: 'error' })), 'error');
    }
  });
  test('cardShown false leaves the engine band error and waiting untouched', () => {
    assert.equal(N.takeoverState({ phase: 'expanded', view: 'overview', engineBand: 'on', cardShown: false }), 'error');
    assert.equal(N.takeoverState(lane({ cardShown: false, question: 'pending' })), 'waiting');
    assert.equal(N.takeoverState(lane({ cardShown: false, card: 'pending' })), 'waiting');
  });
  test('mount passes cardShown from the DOM', () => { assert.match(mount, /cardShown:\s*!!noticeCardEl && !noticeCardEl\.hidden/); });
})();
console.log(`island-nusa-takeover-check (cardShown): ${passed} passed`);
