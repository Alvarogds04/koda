'use strict';
/* S10 / L22 slice 1 — Coucou's header on every expanded state. Pure view-model + markup/CSS contracts (no DOM). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const H = require(path.join(frontend, 'island-header.js'));
const read = f => fs.readFileSync(path.join(frontend, f), 'utf8');
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('soundView: on by default and for anything off-shape; muted only for an explicit sound:false', () => {
  for (const p of [null, undefined, {}, [], 'x', { sound: true }, { sound: 1 }]) assert.deepEqual(H.soundView(p), { on: true, icon: 'speakerOn', label: 'Silenciar', pressed: false, action: 'sound_off' }, JSON.stringify(p));
  assert.deepEqual(H.soundView({ sound: false }), { on: false, icon: 'speakerOff', label: 'Activar sonido', pressed: true, action: 'sound_on' });
});

test('the only prefs verbs the header can send are the existing sound ones', () => {
  for (const p of [{ sound: true }, { sound: false }]) assert.ok(['sound_on', 'sound_off'].includes(H.soundView(p).action));
});

test('markup: home / chat / + on the left, gear / mute on the right, each with an accessible name, drawn from Coucou icon names', () => {
  const html = read('index.html');
  const header = html.slice(html.indexOf('<header id="island-header"'), html.indexOf('</header>', html.indexOf('<header id="island-header"')));
  assert.match(header, /<div class="tabs"[\s\S]*id="home-tab"[\s\S]*id="open-chat"[\s\S]*id="open-new"[\s\S]*<\/div>\s*<div class="header-actions">[\s\S]*id="open-settings"[\s\S]*id="toggle-sound"/);
  for (const id of ['home-tab', 'open-chat', 'open-new', 'open-settings', 'toggle-sound']) assert.match(header, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`), id);
  for (const n of [...header.matchAll(/data-cc-icon="(\w+)"/g)].map(m => m[1])) assert.ok(H.ICON_NAMES.includes(n), n);
  // Human (21/10): the chat button did the same as «+» and did not work by itself; only «+» is shown.
  // #open-chat stays in the DOM (hidden) because «+», the chat shortcut and the ask button drive it.
  assert.match(header, /<button id="open-chat"[^>]*\shidden[\s>]/, 'the chat tab is hidden');
  assert.doesNotMatch(header, /<button id="open-new"[^>]*\shidden[\s>]/, '«+» stays visible');
  assert.equal((html.match(/src="island-header\.js"/g) || []).length, 1);
  assert.ok(html.indexOf('src="island.js"') < html.indexOf('src="island-header.js"'));
});

test('the header is shown in every expanded state: no rule hides it for a card or a pending question', () => {
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /\[data-card\] #island-header|\[data-question="(pending|expired)"\][^{]*#island-header/);
  assert.doesNotMatch(css, /\[data-card\] #open-settings|\[data-question="(pending|expired)"\][^{]*#open-(chat|settings)/, 'gear and chat tab stay');
  assert.match(css, /#capsule\[data-phase="expanded"\] #island-header \{ opacity: 1; visibility: visible/);
});

test('header-actions: Coucou gap 14 / padding-right 16, 44px hit around a 14px glyph', () => {
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(isl, /\.header-actions \{[^}]*gap: 14px;[^}]*padding-right: 16px/);
  assert.match(isl, /#island-header \.hdr-action \{ margin: 0 -15px; \}/);
});

test('wiring: «+» opens the chat and creates a conversation; mute uses prefs_action sound_on/off; trusted clicks only; inert in the settings window', () => {
  const src = read('island-header.js');
  assert.match(src, /getElementById\('open-chat'\)[\s\S]*getElementById\('chat-create'\)/);
  assert.match(src, /prefs_action', \{ payload: \{ action: view\.action \} \}/);
  assert.equal((src.match(/e\.isTrusted !== true/g) || []).length, 2);
  assert.match(src, /label !== 'settings'/);
  assert.doesNotMatch(src, /innerHTML/);
});

// ---- slice 2: approval + question as Coucou's stack ----------------------------------------------
test('approval: <name> needs permission, Deny [N] before Allow [Y] with key hints, the fold chevron on the card corner', () => {
  const html = read('index.html');
  const perm = html.slice(html.indexOf('<div id="permission"'), html.indexOf('<div id="question"'));
  assert.match(perm, /id="card-agent"[\s\S]*id="card-status-word"/);
  assert.match(perm, /id="allow"[^>]*aria-keyshortcuts="Y"[\s\S]*<span class="kbd"[^>]*>Y<\/span>/);
  assert.match(perm, /id="deny"[^>]*aria-keyshortcuts="N"[\s\S]*<span class="kbd"[^>]*>N<\/span>/);
  assert.match(perm, /id="card-fold"[^>]*>\s*<span class="ico" data-cc-icon="chevronUp"/);
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(isl, /#deny \{ order: 1; \} #allow \{ order: 2; \}/, 'Deny first, as Coucou');
  assert.match(isl, /#permission #card-actions \{ position: static; \}/, 'the fold anchors on the card');
  assert.match(isl, /#permission #operation \{[^}]*align-self: stretch/, 'the command is a full-width bar');
});

test('approval keys: Y allows and N denies through the same guarded decision path as a click (trusted, not typing, not repeated, card visible)', () => {
  const src = read('island.js');
  const k = src.slice(src.indexOf("S10 (L22): the key hints"), src.indexOf("F014 (#338)"));
  assert.match(k, /event\.repeat \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey \|\| event\.shiftKey/);
  assert.match(k, /tag === 'INPUT' \|\| tag === 'TEXTAREA'/);
  assert.match(k, /permission\.hidden \|\| permission\.inert/);
  assert.match(k, /decideCard\(key === 'y' \? 'allow' : 'deny', event\)/);
  assert.match(src, /async function decideCard[\s\S]*event\.isTrusted !== true \|\| !validCard\(card\) \|\| cardFeedback\(card\) \|\| cardFlight\) return;/, 'decideCard still refuses untrusted / non-pending / in-flight');
});

test('question: <asker> pregunta with a white dot, plain pill options (no key badge), quiet exit link, fold chevron like the approval', () => {
  const html = read('index.html');
  const q = html.slice(html.indexOf('<div id="question"'), html.indexOf('<section id="chat"'));
  assert.match(q, /id="question-asker"[^>]*><span class="dot"[\s\S]*id="question-asker-name"[\s\S]*id="question-asker-verb">pregunta</);
  assert.match(q, /id="question-fold"[^>]*aria-label="[^"]+"/);
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(isl, /\.q-key \{ display: none; \}/, 'the key badge is hidden; the number still drives aria-keyshortcuts');
  assert.match(isl, /#question-skip \{[^}]*font: 500 11px var\(--font\)/);
  const src = read('island.js');
  assert.match(src, /\[\$\('header-fold'\), \$\('card-fold'\), \$\('question-fold'\)\]\.filter\(Boolean\)\) foldButton\.addEventListener/, 'both chevrons are the same host collapse');
  const N = require(path.join(frontend, 'notify-view.js'));
  assert.equal(N.askerName(N.fromPending({ id: '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b', kind: 'question', agent: 'claude-code', agent_label: 'Claude Code', text: 'x', options: [{ index: 0, label: 'a', description: '' }], expires_at: Date.now() + 1e5 })), 'Claude Code');
  assert.equal(N.askedBy(N.fromPending({ id: '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b', kind: 'question', agent: 'claude-code', agent_label: 'Claude Code', text: 'x', options: [{ index: 0, label: 'a', description: '' }], expires_at: Date.now() + 1e5 })), 'Claude Code pregunta');
});

// ---- slice 3: notices lane = Coucou's finished card -----------------------------------------------
test('finishedCardView: name + verb from the host title, the detail is the bold message, «Abrir terminal» focuses the terminal through focus_host', () => {
  const O = require(path.join(frontend, 'overview-view.js'));
  const v = O.finishedCardView({ title: 'Pi terminó su turno', detail: 'Listo: 42 tests pasan.' });
  assert.deepEqual([v.name, v.verb, v.message, v.full], ['Pi', 'terminó', 'Listo: 42 tests pasan.', 'Listo: 42 tests pasan.']);
  assert.equal(O.finishedCardView({ title: 'Pi terminó su turno', detail: 'No confirma que la tarea haya salido bien ni que las pruebas hayan pasado.' }).message, '', 'v8: the standing caveat is not shown in the band');
  assert.ok(O.finishedCardView({ title: 'Pi terminó su turno', detail: 'Migración aplicada y todos los tests pasan sin errores en staging ahora.' }).message.length <= 44, 'v8: a long result is cut at a word to fit one line');
  assert.deepEqual(v.terminal, { label: 'Abrir terminal', available: true, target: 'terminal', hint: '' });
  assert.equal(v.ok.label, 'OK');
  const bare = O.finishedCardView({ title: 'Aviso local', detail: '' });
  assert.deepEqual([bare.name, bare.verb, bare.full], ['Aviso local', '', 'Aviso local']);
  // S10 (L25): the additive wire fields give Coucou's «<project> <agent> terminó»; bad or partial ones fall back to the title
  const label = slug => ({ 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' }[slug] || slug);
  const rich = O.finishedCardView({ title: 'Pi terminó su turno', detail: 'Hecho.', projectName: 'sb-second-brain', agent: 'claude-code' }, label);
  assert.deepEqual([rich.name, rich.verb, rich.message], ['Koda', 'Claude Code terminó', 'Hecho.'], 'S4: the Koda project folder (sb-second-brain) is shown as «Koda»'); // Koda 0.1 T2
  assert.equal(O.finishedCardView({ title: 'x terminó', detail: '', projectName: 'otro-proyecto', agent: 'codex' }, label).name, 'otro-proyecto', 'any other project keeps its own name');
  for (const bad of [{ projectName: 'x' }, { agent: 'pi' }, { projectName: 'a/b', agent: 'pi' }, { projectName: 'x', agent: 'Pi' }, { projectName: '<b>', agent: 'pi' }]) {
    const v2 = O.finishedCardView({ title: 'Pi terminó su turno', detail: 'd', ...bad }, label);
    assert.deepEqual([v2.name, v2.verb], ['Pi', 'terminó'], JSON.stringify(bad));
  }
  assert.deepEqual([O.finishedCardView({ title: 'Pi terminó su turno', detail: 'd', projectName: 'x', agent: 'pi' }).name], ['Pi'], 'no labeler: the old text');
  assert.equal(O.finishedCardView({ title: '  ' }), null); assert.equal(O.finishedCardView(null), null);
  assert.equal(O.finishedCardView({ title: 'Pi\u0007 terminó', detail: 'a\u0000b' }).message, 'a b');
});

test('finished card markup + wiring: lives inside #notices, survives the boot rebuild, OK = the band\'s dismissal (trusted only), terminal = focus_host', () => {
  const html = read('index.html');
  const notices = html.slice(html.indexOf('<div id="notices"'), html.indexOf('<p id="notice-live"'));
  assert.match(notices, /id="notice-card"[^>]*hidden[\s\S]*id="notice-card-name"[\s\S]*id="notice-card-verb"[\s\S]*id="notice-card-message"[\s\S]*id="notice-card-terminal"[\s\S]*id="notice-card-ok"/);
  assert.doesNotMatch(notices, /id="notice-card-terminal"[^>]*disabled/);
  const src = read('island.js');
  assert.match(src, /noticesEl\.replaceChildren\(noticeChips, noticePill, noticeDetail, noticeList, \.\.\.\(\$\('notice-card'\)/, 'the boot rebuild keeps the card');
  assert.match(src, /O\.finishedCardView\(selected, NV && NV\.agentLabel\)/);
  assert.match(src, /find\(n => n\.id === noticeLane\.id\)/, 'the active finished lane selects its exact host notice, not the oldest retained row');
  assert.match(src, /invoke\('focus_host', \{ payload: \{ target: 'terminal', origin: 'notice', id \} \}\)/, 'closed host verb, no command/path/window id');
  assert.match(src, /noticeCardTerminal\.addEventListener\('click', event => \{\s*if \(event\.isTrusted !== true \|\| !invoke\) return;/);
  assert.match(src, /noticeCardOk\.addEventListener\('click', event => \{[\s\S]*?const id = noticeLane\?\.id;[\s\S]*?event\.isTrusted !== true[\s\S]*?window\.desktop\.dismiss\(id\)/, 'trusted OK dismisses the exact displayed lane id');
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(isl, /\[data-notice-view="notices"\] #notice-card:not\(\[hidden\]\) \{[^}]*display: flex/);
  assert.match(isl, /\[data-notice-view="notices"\] #notices \{ --wash: rgba\(52, 211, 153, 0\.5\); \}/, 'green wash');
  assert.match(isl, /#notice-card \.title \{ font: 600 15px var\(--font\)/);
  assert.match(isl, /#notice-card \.btn::after \{[^}]*inset: 7px 0/, '30px visual in a 44px hit');
});

test('R21: finished Ver sends only the displayed host notice UUID, never a process identity; absent/hidden/untrusted cards do nothing', () => {
  const src = read('island.js');
  const begin = src.indexOf("if (noticeCardTerminal) noticeCardTerminal.addEventListener");
  const end = src.indexOf("  if (noticeCardOk)", begin);
  const wire = new Function('noticeCardTerminal', 'invoke', 'noticeTerminalId', 'noticeCard', '$', src.slice(begin, end));
  const id = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
  for (const [trusted, shown, selected, expected] of [[true, true, id, 1], [false, true, id, 0], [true, false, id, 0], [true, true, null, 0]]) {
    let click; const calls = [];
    const button = { addEventListener: (_, fn) => { click = fn; } };
    const invoke = (command, args) => { calls.push([command, args]); return { then: () => ({ finally: fn => fn() }) }; };
    wire(button, invoke, selected, { hidden: !shown }, () => null);
    click({ isTrusted: trusted });
    assert.equal(calls.length, expected);
    if (expected) assert.deepEqual(calls[0], ['focus_host', { payload: { target: 'terminal', origin: 'notice', id } }]);
  }
});

// ---- slice 4/5: overview with sessions, calm strip, Spotify tile, character badge -------------------
test('sessions feed keeps session identity without pretending process discovery is tool history', () => {
  const T = require(path.join(frontend, 'sessions-ticker.js'));
  const fr = rows => ({ type: 'sessions', schema: 'abito-sessions/view/1', sessions: rows, truncated: false });
  const row = (id, kind, cwd) => ({ id, kind, cwd, state: 'running', origin: null });
  const m = T.newMemory();
  let r = T.feed(m, T.sessionsView(fr([row('s-0123abcd', 'claude-code', 'sb')])));
  assert.deepEqual(r.who, { name: 'sb', tool: 'Claude Code', count: '' });
  r = T.feed(m, T.sessionsView(fr([row('s-0123abcd', 'claude-code', 'sb'), row('s-4567ef01', 'codex', 'abito')])));
  assert.deepEqual(r.who, { name: 'sb', tool: 'Claude Code', count: '' }, 'an unrelated session neither steals focus nor adds a tool step');
  r = T.feed(m, T.sessionsView(fr([row('s-0123abcd', 'claude-code', 'sb')])));
  assert.equal(r.who.name, 'sb', 'remaining session identity is stable');
  assert.equal(T.feed(m, T.sessionsView(fr([]))).who, null);
});

test('overview: empty card + calm strip + static status lines kept for assistive tech only', () => {
  const html = read('index.html');
  assert.match(html, /id="overview-empty"[\s\S]*Nada en ejecución ahora mismo[\s\S]*id="overview-ask"/);
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(isl, /\.agentline, \.overview-detail, \.pill-summary \{\s*clip-path: inset\(50%\)/);
  assert.match(isl, /#overview-view\[data-ticker="on"\] #overview-empty[^{]*\{ display: none; \}/);
  assert.match(isl, /#capsule\[data-notices-calm="true"\] #notices \{ display: none; \}/);
  assert.match(isl, /#capsule\[data-notices-calm="true"\] #blobs \{ padding-top: 0; \}/, 'A+E: a calm strip gives the 44px band back to the blobs card');
  const src = read('island.js');
  assert.match(src, /noticesEl\.dataset\.calm = \(!first && conn\.tone === 'go' && !bridge && !view\)/, 'a problem or a notice keeps its honest strip');
  assert.match(src, /\$\('hotkey'\)\.hidden/, 'a hotkey problem also keeps it');
  assert.match(src, /askButton\.addEventListener\('click', event => \{ if \(event\.isTrusted === true\)/);
});

test('Spotify: 36px art tile (no artwork fetch), «artist · album», card kept inside the 322px left card', () => {
  const S = require(path.join(frontend, 'spotify-view.js'));
  assert.equal(S.cardView({ running: true, playing: true, track: { title: 'T', artist: 'A', album: 'B' } }).artist, 'A · B');
  assert.equal(S.cardView({ running: true, playing: true, track: { title: 'T', artist: 'A' } }).artist, 'A');
  assert.equal(S.cardView({ running: true, playing: true, track: { title: 'T', artist: '', album: 'B' } }).artist, '');
  const src = read('spotify-view.js');
  assert.match(src, /mk\('div', 'np-art'\)/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//, ''), /createElement\('img'\)|new Image|fetch\(/);
});

test('character badge: «!» approval, «?» question, ✓ finished lane, decoration only, placed at Coucou\'s centre-(20,21)', () => {
  const html = read('index.html');
  assert.match(html, /<span id="clay-badge" aria-hidden="true" hidden>/);
  const src = read('island.js');
  assert.match(src, /noticeLane && noticeLane\.view === 'notices' \? 'finished' : cardShown \? 'approval' : questionShown \? questionLook : ''/);
  // SN2: a question card wearing the approval look (harness «pide permiso» pair) shows «!»; any other question keeps «?»
  assert.match(src, /const questionLook = capsule\.dataset\.question === 'outcome' \? '' : questionShown && \$\('question'\) && \$\('question'\)\.dataset\.look === 'approval' \? 'approval' : 'question';/, 'S2: no badge while an outcome shows');
  assert.match(src, /badge\.style\.left = at\.left \+ 'px'/, 'the badge sits where AbitoIslandLayout.badgePosition (centre - (20, 21)) puts it, from the mascot\'s own box');
  const isl = read('vendor/coucou/island/island.css');
  for (const [k, g, c] of [['approval', '!', '#f5a524'], ['question', '?', '#22d3ee'], ['finished', '✓', '#22c55e']]) {
    assert.ok(isl.includes(`#clay-badge[data-kind="${k}"] i { background: ${c}; }`), k);
    assert.ok(isl.includes(`#clay-badge[data-kind="${k}"] i::before { content: "${g}"; }`), k + ' glyph');
  }
});

// ---- slice 6: chat on Coucou's tokens (chat*.js untouched) -------------------------------------------
test('chat wears Coucou\'s tokens: bubble .13 r12 6/10 12.5px, reply #b0b5be, input .07 r12 13px, white send disc; chat*.js not part of the change', () => {
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(isl, /#chat-log li\.user \{ padding: 6px 10px; border-radius: 12px; background: rgba\(255, 255, 255, 0\.13\); color: var\(--ink-2\); font: 400 12\.5px var\(--font\); \}/);
  assert.match(isl, /#chat-log li\.assistant \{ color: #b0b5be; font: 400 12\.5px var\(--font\); \}/);
  assert.match(isl, /#chat-input \{\s*border: 0; border-radius: 12px; background: rgba\(255, 255, 255, 0\.07\); color: var\(--ink\); font: 400 13px\/1\.35 var\(--font\);/);
  assert.match(isl, /#chat-send \{ background: var\(--ink\) !important;/);
  assert.match(isl, /#chat-model-btn \{ padding: 4px 10px; border: 0; background: rgba\(255, 255, 255, 0\.06\); color: #7b8089; font: 500 10\.5px var\(--font\); \}/);
  for (const sel of ['#settings', '#models', '#conversations']) assert.ok(!new RegExp('(^|[\\s,}])' + sel + '[^{]*\\{').test(isl.slice(isl.indexOf('#chat-log li.user') - 1)), sel + ' untouched by the chat block');
});

// ---- #480: the chat in the island's own visual language -------------------------------------------------------------
test('chat: keeps every id and verb; the island header stays on top at the island width (720); body is a Coucou card; controls are Coucou tabs/discs with 44px hits', () => {
  const html = read('index.html');
  for (const id of ['chat-header', 'chat-title', 'chat-target-chip', 'chat-specialist', 'open-screen-settings', 'chat-back', 'chat-state', 'chat-history-controls', 'chat-create', 'chat-conversations', 'chat-history-label', 'chat-log', 'chat-model-btn', 'chat-composer', 'chat-input', 'chat-mic', 'chat-send', 'chat-cancel'])
    assert.match(html, new RegExp(`id="${id}"`), id + ' is still there');
  const isl = read('vendor/coucou/island/island.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const from = isl.indexOf('#capsule[data-phase="expanded"][data-view="chat"] #island-header');
  assert.ok(from > 0, 'the chat block exists'); const blk = isl.slice(from);
  assert.match(blk, /#island-header \{\s*opacity: 1; visibility: visible; pointer-events: auto; left: calc\(50% - 360px\); width: 720px; right: auto;/);
  assert.match(blk, /#chat \{ padding: 42px 10px 10px; \}/, 'the card starts under the 34px header');
  assert.match(blk, /#chat-title::before \{ content: ""; width: 8px; height: 8px; border-radius: 50%; background: #fff;/, 'the who-row dot');
  assert.match(blk, /#chat-body \{ background: var\(--card\); border: 1px solid var\(--hairline\); border-radius: 20px;/);
  assert.match(blk, /#capsule #chat-history-controls \.icon-btn::after \{ inset: 11px 7px; border: 0; border-radius: 11px;/, 'Coucou .tab 30x22 in a 44px hit');
  assert.match(blk, /#chat-composer \.round::after \{ inset: 8px; border: 0; border-radius: 50%;/, '28px discs in a 44px hit');
  assert.match(blk, /#chat-composer #chat-send::after \{ background: var\(--ink\);/, 'Coucou\'s white send disc');
  assert.match(blk, /#chat-header \.icon-btn \{[^}]*min-width: 44px; min-height: 44px;/, 'the quiet round buttons keep a 44px hit');
  // chat behaviour files are not part of this change: the verbs the chat sends are the same closed ones
  const chat = read('chat.js');
  for (const verb of ["action({ action: 'new' })", "action({ action: 'open' })", "action({ action: 'back' })", "action({ action: 'list' })"]) assert.ok(chat.includes(verb), verb);
});

if (failed) process.exit(1);
