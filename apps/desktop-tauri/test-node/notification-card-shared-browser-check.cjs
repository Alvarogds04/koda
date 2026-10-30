'use strict';
/* T4 (Sileo notifications): the REAL question card in a real browser, through its public flow.
   ATTACHES to the existing shared Chrome on 127.0.0.1:9222 (CDP). It NEVER launches, downloads or restarts a
   browser: if none answers it fails clearly. It closes only its own context/page, never the browser.
   Real frontend (index.html + real CSS/JS) served from a scratch HTTP server, with a FAKE Tauri bridge: the card is
   opened by the real trusted «Responder» click; the host's phase hook (__islandSetState) is emulated exactly as Rust
   evals it. NO backend, NO live agents: it proves rendered geometry + the payloads the card hands to question_action.
   Side effects of loading the full page (pre-existing, unrelated to this check): island.js/desktop.js call
   agent_action/prefs_action/island_shape/record_frontend_evidence/chat_action on the FAKE bridge, which answers null.
   Run: node apps/desktop-tauri/test-node/notification-card-shared-browser-check.cjs
   Optional: ABITO_SHOT_DIR=<dir> writes one PNG per scenario. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const MIN_TARGET = 40;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); } };
const uid = n => `0b3a5c9e-8f27-4d11-9a0e-${String(n).padStart(12, '0')}`;

(async () => {
  let pw;
  try { pw = require(process.env.HOME + '/.local/lib/node_modules/playwright'); } catch { pw = require('playwright'); }
  let browser;
  try { browser = await pw.chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 5000 }); }
  catch (e) { console.error('NO SHARED BROWSER on 127.0.0.1:9222 (this check never launches one): ' + e.message); process.exit(2); }
  const server = http.createServer((req, res) => {
    const f = path.join(frontend, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(frontend) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ctx = await browser.newContext({ viewport: { width: 752, height: 560 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => {
    const L = {}; const sent = []; let cur = { available: true, pending: null, queued: [], queued_count: 0, notice: null };
    window.__sent = sent;
    window.__emit = s => { cur = s; (L['question:state'] || []).forEach(f => f({ payload: s })); };
    window.__desktop = s => (L['desktop:state'] || []).forEach(f => f({ payload: s }));
    window.__TAURI__ = { event: { listen: async (n, f) => { (L[n] ||= []).push(f); return () => {}; } }, core: { invoke: async (cmd, a) => {
      if (cmd === 'desktop_action') {
        if (a.payload.action === 'expand') { const s = { state: 'expanded', revision: 1, notices: [], card: null };
          setTimeout(() => { (L['desktop:state'] || []).forEach(f => f({ payload: s })); window.__islandSetState('overview'); }, 0); return s; }
        return { state: 'compact', revision: 0, notices: [], card: null };
      }
      if (cmd === 'island_window_height') return { h: a.payload.h };
      // like chathost::apply_view: the host answers the chat verbs by moving the island's view
      if (cmd === 'chat_action' && a.payload && (a.payload.action === 'open' || a.payload.action === 'back')) {
        const v = a.payload.action === 'open' ? 'chat' : 'overview';
        setTimeout(() => { if (window.__islandSetView) window.__islandSetView(v, 720, 360); }, 0);
        return null;
      }
      if (cmd !== 'question_action') return null;
      const p = a.payload;
      if (p.action === 'view') return cur;
      if (p.action === 'budget') return { allowed: true };
      sent.push(p); // answer / answer_many / answer_form / text / decline: recorded, the fake host settles it
      cur = { ...cur, pending: null, notice: 'sent' };
      return cur;
    } } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForTimeout(900);

  const pending = over => ({ kind: 'question', agent: 'pi', text: '¿Qué?', options: [], expires_at: Date.now() + 600000, allow_free_text: false, ...over });
  const show = async p => { // a real trusted «Responder» click opens the island on the question
    await page.evaluate(() => __emit({ available: true, pending: null, queued: [], queued_count: 0, notice: null }));
    await page.waitForTimeout(200);
    await page.evaluate(p => __emit({ available: true, pending: p, queued: [], queued_count: 0, notice: null }), p);
    await page.waitForTimeout(700);
    if (await page.evaluate(() => document.getElementById('capsule').dataset.phase) !== 'expanded') await page.click('#compact-reply');
    await page.waitForFunction(() => { const c = document.getElementById('capsule'); return c.dataset.phase === 'expanded' && c.dataset.question === 'pending'; }, null, { timeout: 5000 });
    await page.waitForTimeout(700);
  };
  const sentNow = () => page.evaluate(() => window.__sent.slice());
  const resetSent = () => page.evaluate(() => { window.__sent.length = 0; });
  const shot = async name => { if (process.env.ABITO_SHOT_DIR) await page.screenshot({ path: path.join(process.env.ABITO_SHOT_DIR, `t4-${name}.png`) }); };
  // geometry of every interactive control the card shows (rendered boxes, not CSS text)
  const targets = () => page.evaluate(() => [...document.querySelectorAll('#question button, #question textarea, #question input')]
    .map(b => ({ id: b.id || b.className || b.tagName, text: (b.textContent || '').trim().slice(0, 18), r: b.getBoundingClientRect() }))
    .filter(t => t.r.width > 0 && t.r.height > 0).map(t => ({ id: t.id, text: t.text, w: Math.round(t.r.width * 10) / 10, h: Math.round(t.r.height * 10) / 10 })));
  const small = list => list.filter(t => t.h < MIN_TARGET || t.w < MIN_TARGET).map(t => `${t.id}«${t.text}» ${t.w}x${t.h}`).join('; ');
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#question-options .q-option')].map(b => ({ n: b.dataset.number, checked: b.getAttribute('aria-checked'), role: b.getAttribute('role') })));

  // ---- 1. multi-select: toggling, targets, keyboard, payload --------------------------------------------------
  const MULTI = pending({ id: uid(1), multi_select: true, text: '¿Qué lenguajes?', options: [{ index: 0, label: 'Go', description: '' }, { index: 1, label: 'Rust', description: 'rápido' }, { index: 2, label: 'Zig', description: '' }] });
  await show(MULTI);
  let t = await targets();
  ok('S5 multi: rendered rows are role=checkbox, none preselected', (await rows()).length === 3 && (await rows()).every(r => r.role === 'checkbox' && r.checked === 'false'), JSON.stringify(await rows()));
  ok(`S5 multi: every control >= ${MIN_TARGET}px`, small(t) === '', small(t));
  ok('S5 multi: Hecho is disabled until something is chosen', await page.evaluate(() => document.getElementById('question-primary').disabled));
  await page.click('.q-option[data-number="1"]'); await page.click('.q-option[data-number="3"]');
  ok('S5 multi: trusted clicks toggle rows 1 and 3', (await rows()).map(r => r.checked).join() === 'true,false,true', JSON.stringify(await rows()));
  await page.click('.q-option[data-number="3"]');
  ok('S5 multi: a second click un-toggles', (await rows()).map(r => r.checked).join() === 'true,false,false');
  await page.keyboard.press('2');
  ok('S5 multi: digit key toggles row 2', (await rows()).map(r => r.checked).join() === 'true,true,false', JSON.stringify(await rows()));
  await page.evaluate(() => document.getElementById('question-primary').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(150);
  ok('S5 multi: a synthetic (untrusted) Hecho click sends nothing', (await sentNow()).length === 0);
  await shot('multi');
  await page.click('#question-primary'); await page.waitForTimeout(200);
  const many = await sentNow();
  ok('S5 multi: Hecho sends ONE answer_many with the chosen indexes', many.length === 1 && many[0].action === 'answer_many' && many[0].id === uid(1) && JSON.stringify(many[0]).includes('[0,1]'), JSON.stringify(many));

  // ---- 2. questionnaire: 1 and 4 steps -----------------------------------------------------------------------
  const item = (header, o = {}) => ({ header, text: `¿${header}?`, options: [{ index: 0, label: 'Sí', description: '' }, { index: 1, label: 'No', description: '' }], ...o });
  for (const steps of [1, 4]) {
    await resetSent();
    const form = [item('Uno'), item('Dos', { multi_select: true }), item('Tres'), item('Cuatro', { allow_free_text: true })].slice(0, steps);
    await show(pending({ id: uid(10 + steps), text: 'Cuestionario', form }));
    t = await targets();
    const head = await page.evaluate(() => document.getElementById('question-step-header').textContent);
    ok(`S5 form(${steps}): header says «Paso 1 de ${steps}»`, new RegExp(`1 de ${steps}\\b`).test(head), head);
    ok(`S5 form(${steps}): back is hidden on the first step`, await page.evaluate(() => document.getElementById('question-prev').hidden));
    for (let s = 0; s < steps; s++) {
      t = await targets();
      ok(`S5 form(${steps}) step ${s + 1}: every control >= ${MIN_TARGET}px`, small(t) === '', small(t));
      await page.click('.q-option[data-number="1"]');
      if (s === steps - 1 && steps === 1) await shot('form1');
      if (s === 3) await shot('form4');
      await page.click('#question-primary'); await page.waitForTimeout(120);
    }
    // review step (the last primary press of a 1-step form already advanced to it)
    ok(`S5 form(${steps}): the review step lists ${steps} answer(s)`, (await page.evaluate(() => document.querySelectorAll('#question-summary .q-sum-row').length)) === steps);
    t = await targets();
    ok(`S5 form(${steps}) review: every control >= ${MIN_TARGET}px`, small(t) === '', small(t));
    if (steps === 4) { await page.click('#question-prev'); await page.waitForTimeout(120);
      ok('S5 form(4): Atrás from the review returns to step 4 keeping answers', /4 de 4/.test(await page.evaluate(() => document.getElementById('question-step-header').textContent)));
      await page.click('#question-primary'); await page.waitForTimeout(120); }
    ok(`S5 form(${steps}): nothing is sent before the explicit send`, (await sentNow()).length === 0);
    await page.click('#question-primary'); await page.waitForTimeout(200);
    const f = await sentNow();
    ok(`S5 form(${steps}): send emits ONE answer_form with ${steps} answer(s)`, f.length === 1 && f[0].action === 'answer_form' && f[0].answers.length === steps, JSON.stringify(f));
  }

  // ---- 2b. live regression (installed a8b2d779): Enter with the page focused answers the card and must NOT also open the chat ----
  // chat.js's document Enter handler ("Enter opens from the overview") ran before notify.js's, so the chat view slid over the card.
  const bodyFocus = () => page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  const view = () => page.evaluate(() => document.getElementById('capsule').dataset.view || '');
  await resetSent();
  await show(pending({ id: uid(15), text: 'Cuestionario', form: [item('Uno'), item('Dos')] }));
  await bodyFocus(); await page.keyboard.press('2'); await bodyFocus(); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  ok('S5 form keyboard: Enter on step 1 goes to «Paso 2 de 2»', /2 de 2/.test(await page.evaluate(() => document.getElementById('question-step-header').textContent)));
  ok('S5 form keyboard: Enter on a step never opens the chat over the card', (await view()) !== 'chat', await view());
  await resetSent();
  await show(pending({ id: uid(16), multi_select: true, text: '¿Cuáles?', options: [{ index: 0, label: 'A', description: '' }, { index: 1, label: 'B', description: '' }] }));
  await bodyFocus(); await page.keyboard.press('1'); await bodyFocus(); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  const viaEnter = await sentNow();
  ok('S5 multi keyboard: Enter sends ONE answer_many', viaEnter.length === 1 && viaEnter[0].action === 'answer_many', JSON.stringify(viaEnter));
  ok('S5 multi keyboard: Enter that answers never opens the chat', (await view()) !== 'chat', await view());
  // previous behaviour kept: with NO question on screen, Enter on the overview still opens the chat
  await page.evaluate(() => __emit({ available: true, pending: null, queued: [], queued_count: 0, notice: null }));
  await page.waitForTimeout(500);
  await bodyFocus(); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  ok('chat keyboard (unchanged): Enter on the overview with no question opens the chat', (await view()) === 'chat', await view());
  await page.evaluate(() => window.__islandSetView('overview', 720, 360)); await page.waitForTimeout(400);

  // ---- S2 (abito-avisos-ux): «Recibida» was a tiny word on a faded card with Abito still wearing «?». Now Abito comes forward and
  // nods (confirm pose, held by the island while the outcome shows), the badge goes away and the word is the content.
  await show(pending({ id: uid(80), text: '¿Rojo o azul?', options: [{ index: 0, label: 'Rojo', description: '' }, { index: 1, label: 'Azul', description: '' }] }));
  await page.evaluate(() => __emit({ available: true, pending: null, queued: [], queued_count: 0, notice: 'answered' }));
  await page.waitForTimeout(500);
  const rec = await page.evaluate(() => {
    const c = document.getElementById('capsule'), clay = document.getElementById('clay'), q = document.getElementById('question');
    return { question: c.dataset.question, outcome: c.dataset.outcome || '', pose: clay.dataset.pose || '', badge: document.getElementById('clay-badge').hidden ? '' : (document.getElementById('clay-badge').dataset.kind || ''),
      clayOver: Number(getComputedStyle(clay).zIndex) > Number(getComputedStyle(q).zIndex || 0), word: document.getElementById('question-state-word').textContent,
      size: parseFloat(getComputedStyle(document.getElementById('question-state')).fontSize) };
  });
  ok('S2 recibida: the outcome is marked on the island (answered)', rec.question === 'outcome' && rec.outcome === 'answered', JSON.stringify(rec));
  ok('S2 recibida: Abito nods (confirm pose) in front of the card, never under it', rec.pose === 'confirm' && rec.clayOver, JSON.stringify(rec));
  ok('S2 recibida: no «?» badge left on Abito', rec.badge === '', JSON.stringify(rec));
  ok('S2 recibida: «Recibida» is the visible content, larger than body text', rec.word === 'Recibida' && rec.size >= 18, JSON.stringify(rec));
  await page.waitForTimeout(3300);
  ok('S2 recibida: after the outcome Abito is released (no held confirm pose)', await page.evaluate(() => (document.getElementById('clay').dataset.pose || '') !== 'confirm'));

  // ---- human 26-oct: the Sileo toast is OPAQUE — its title/body always sit on the solid pill/body, never on what is behind ----------
  await page.evaluate(() => __emit({ available: true, pending: null, queued: [], queued_count: 0, notice: null }));
  await page.waitForTimeout(300);
  // the order that broke it live: the question arrives while Abito is visible (no toast), THEN Abito hides
  await page.evaluate(() => { window.__islandSetState && window.__islandSetState('compact'); });
  await page.waitForTimeout(400);
  await page.evaluate(p => __emit({ available: true, pending: p, queued: [], queued_count: 0, notice: null }),
    pending({ id: uid(90), agent: 'codex', text: 'Codex pregunta algo largo para ver el cuerpo', options: [{ index: 0, label: 'A', description: '' }, { index: 1, label: 'B', description: '' }] }));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__islandConceal(true));
  await page.waitForTimeout(1600);
  const op = await page.evaluate(() => {
    const t = document.getElementById('question-toast'); const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const pill = box(t.querySelector('.q-toast-pill')), title = box(t.querySelector('.q-toast-title')), badge = box(t.querySelector('.q-toast-badge'));
    let o = 1; for (let e = t; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return { shown: !t.hidden, pill, title, badge, opacity: o, fillOpacity: getComputedStyle(t.querySelector('.q-toast-pill')).fillOpacity };
  });
  const covers = (a, b) => a.l <= b.l + 1 && a.r >= b.r - 1 && a.t <= b.t + 1 && a.b >= b.b - 1;
  ok('opaque toast: shown while Abito is hidden', op.shown, JSON.stringify(op));
  ok('opaque toast: the solid pill covers the title and Abito badge (nothing drawn over the background)', covers(op.pill, op.title) && covers(op.pill, op.badge), JSON.stringify(op));
  ok('opaque toast: fully opaque (no element opacity < 1, fill opacity 1)', op.opacity === 1 && Number(op.fillOpacity) === 1, JSON.stringify(op));
  await page.evaluate(() => { __emit({ available: true, pending: null, queued: [], queued_count: 0, notice: null }); window.__islandConceal(false); });
  await page.waitForTimeout(500);

  // ---- S1 (abito-avisos-ux): the Avisos band is a compact strip in the SAME bottom slot as «Sin cuenta», not a 288x44 capsule over
  // the sessions column. Geometry is measured on the rendered page (real index.html + CSS), through the host's own desktop:state.
  await page.evaluate(() => __emit({ available: true, pending: null, queued: [], queued_count: 0, notice: null }));
  await page.waitForTimeout(300);
  const notes = [1, 2].map(i => ({ id: `0b3a5c9e-8f27-4d11-9a0e-00000000009${i}`, kind: 'settled', severity: 'info', title: `Codex terminó ${i}`,
    agent: 'codex', projectName: 'abito', at: Date.now(), expiresAt: Date.now() + 600000 }));
  await page.evaluate(n => window.__desktop({ state: 'expanded', revision: 9, notices: n, card: null }), notes);
  // HU-057: the host's phase hook is emulated exactly as Rust evals it on «expanded» (see the header); without it `#island` stays the 40x32 compact
  // pill in this fake bridge, and «island y» told nothing about the expanded overview. Now `isl` below IS the expanded overview notch.
  await page.evaluate(() => window.__islandSetState('overview'));
  await page.waitForTimeout(6500); // past the 5.2 s «terminó» lane: the plain overview with its Avisos band
  const strip = await page.evaluate(() => {
    const r = el => { const b = document.getElementById(el).getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
    const isl = r('island'), pill = r('notice-pill'), band = r('engine-band');
    return { isl, pill, band, engineShown: getComputedStyle(document.getElementById('engine-band')).display !== 'none',
      title: document.getElementById('notice-title').textContent, strip: document.getElementById('capsule').dataset.noticeStrip || '' };
  });
  // HU-057 (odd/tasks/isla-nusa.md): the overview card is the 150px Nusa notch (was a 184px card), bands start at its bottom - 6 = y 144. The old loose
  // «>= 170» becomes an exact window: the strip starts between 144 and 160 px under the island top, i.e. at/below the notch body's lower edge zone, is
  // 700x32, and never overlaps the Agentes/sessions body (pill top >= notch bottom - 6, band is outside the content area).
  const gap = strip.pill.y - strip.isl.y;
  ok('S1 avisos: the strip sits UNDER the 150px notch, in the «Sin cuenta» slot (not over the sessions column)', strip.strip === 'on' && strip.isl.w === 720 && strip.isl.h >= 150 && gap >= 144 && gap <= 160, JSON.stringify(strip));
  ok('S1 avisos: the strip is 700x32 and does not overlap the notch body content', strip.pill.w === 700 && strip.pill.h === 32 && strip.pill.y >= strip.isl.y + 144 && strip.pill.y + strip.pill.h <= strip.isl.y + strip.isl.h + 1, JSON.stringify(strip));
  ok('S1 avisos: compact — at most 32px tall and as wide as the bottom band', strip.pill.h <= 32 && strip.pill.w >= 600, JSON.stringify(strip.pill));
  ok('S1 avisos: it still says how many there are', /2/.test(strip.title), strip.title);
  ok('S1 avisos: a notice outranks «Sin cuenta» in the shared slot (never two bands on top of each other)', !strip.engineShown, JSON.stringify(strip));
  await page.evaluate(() => window.__desktop({ state: 'expanded', revision: 10, notices: [], card: null }));
  await page.waitForTimeout(500);
  ok('S1 avisos: with no notice the strip is gone', await page.evaluate(() => (document.getElementById('capsule').dataset.noticeStrip || '') !== 'on'));

  // ---- 3. Pi free text ----------------------------------------------------------------------------------------
  await resetSent();
  await show(pending({ id: uid(20), text: 'Escribe el nombre', allow_free_text: true, options: [] }));
  ok('S5 text: free text opens through the «Otra cosa…» row', (await rows()).length === 1 && await page.evaluate(() => document.querySelector('#question-options .q-other') !== null));
  await page.click('#question-options .q-other'); await page.waitForTimeout(200);
  t = await targets();
  ok(`S5 text: row, textarea and send are >= ${MIN_TARGET}px`, small(t) === '', small(t));
  ok('S5 text: send is disabled while empty', await page.evaluate(() => document.getElementById('question-send').disabled));
  await page.click('#question-text'); await page.keyboard.type('Abito ñandú'); await page.waitForTimeout(200);
  ok('S5 text: send enables once text is valid', !(await page.evaluate(() => document.getElementById('question-send').disabled)));
  await shot('text');
  await page.keyboard.press('Enter'); await page.waitForTimeout(250);
  const txt = await sentNow();
  ok('S5 text: Enter sends the typed text verbatim via action:text', txt.length === 1 && txt[0].action === 'text' && txt[0].id === uid(20) && txt[0].text === 'Abito ñandú', JSON.stringify(txt));

  // ---- 4. approval pair (Pi kind=approval) + the Claude/Codex Spanish pair through the same card ----------------
  const pair = (kind, a, b, text, extra = {}) => pending({ id: uid(30), kind, text, options: [{ index: 0, label: a, description: '' }, { index: 1, label: b, description: '' }], ...extra });
  const look = () => page.evaluate(() => ({ look: document.getElementById('question').dataset.look,
    buttons: [...document.querySelectorAll('#question-approval-actions button')].map(b => `${b.dataset.index}:${b.querySelector('.q-label').textContent}`) }));
  await resetSent();
  await show(pair('approval', 'Aprobar', 'Rechazar', 'Permiso para ejecutar: git push'));
  let lk = await look();
  ok('S5 approval: Pi pair Aprobar/Rechazar wears the approval look (reject first, approve second)', lk.look === 'approval' && lk.buttons.join() === '1:Rechazar,0:Aprobar', JSON.stringify(lk));
  t = await targets();
  ok(`S5 approval: both actions >= ${MIN_TARGET}px`, small(t) === '', small(t));
  await page.evaluate(() => document.querySelector('#question-approval-actions .q-approve').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(150);
  ok('S5 approval: a synthetic click never approves', (await sentNow()).length === 0);
  await shot('approval');
  await page.click('#question-approval-actions .q-approve'); await page.waitForTimeout(200);
  ok('S5 approval: the real click sends exactly the Aprobar index', JSON.stringify(await sentNow()) === JSON.stringify([{ action: 'answer', id: uid(30), index: 0 }]), JSON.stringify(await sentNow()));
  // T4b: the REAL Claude Code / Codex producer shape (hook-common.cjs: «<Agente> pide permiso para <detalle>», pair «Aprobar una vez» / «Rechazar»)
  const numbered = () => page.evaluate(() => [...document.querySelectorAll('#question-options .q-option')].map(b => b.textContent.trim()));
  const cmdText = () => page.evaluate(() => ({ cmd: document.getElementById('question-approval-cmd').textContent, html: document.getElementById('question-approval').querySelectorAll('img,script,b').length }));
  for (const [agent, swapped, n] of [['Claude Code', false, 40], ['Codex', false, 41], ['Claude Code', true, 42], ['Codex', true, 43]]) {
    const tag = `S5 approval ${agent}${swapped ? ' swapped' : ''}`;
    const a0 = swapped ? 1 : 0, r0 = swapped ? 0 : 1; // ORIGINAL indexes of Aprobar una vez / Rechazar
    const opts = swapped ? ['Rechazar', 'Aprobar una vez'] : ['Aprobar una vez', 'Rechazar'];
    await resetSent();
    await show({ ...pair('question', opts[0], opts[1], `${agent} pide permiso para Bash: echo "<img src=x onerror=1>" && ls`), id: uid(n) });
    lk = await look(); t = await targets();
    ok(`${tag}: approval look, exact labels, original indexes (reject left, approve right)`, lk.look === 'approval' && lk.buttons.join() === `${r0}:Rechazar,${a0}:Aprobar una vez`, JSON.stringify(lk));
    ok(`${tag}: no numbered list rows and both actions >= ${MIN_TARGET}px`, (await numbered()).length === 0 && small(t) === '', `${JSON.stringify(await numbered())} ${small(t)}`);
    const ct = await cmdText();
    ok(`${tag}: the command is shown as text, never injected as HTML`, ct.cmd === 'echo "<img src=x onerror=1>" && ls' && ct.html === 0, JSON.stringify(ct));
    await page.evaluate(() => document.querySelector('#question-approval-actions .q-approve').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(150);
    ok(`${tag}: a synthetic click submits nothing`, (await sentNow()).length === 0);
    if (n === 40) await shot('approval-es');
    await page.click('#question-approval-actions .q-approve'); await page.waitForTimeout(200);
    ok(`${tag}: the real Aprobar una vez click sends exactly the original index`, JSON.stringify(await sentNow()) === JSON.stringify([{ action: 'answer', id: uid(n), index: a0 }]), JSON.stringify(await sentNow()));
    await resetSent();
    await show({ ...pair('question', opts[0], opts[1], `${agent} pide permiso para Bash: ls`), id: uid(n + 10) });
    await page.click('#question-approval-actions .q-reject'); await page.waitForTimeout(200);
    ok(`${tag}: the real Rechazar click sends exactly the original index`, JSON.stringify(await sentNow()) === JSON.stringify([{ action: 'answer', id: uid(n + 10), index: r0 }]), JSON.stringify(await sentNow()));
  }
  // ---- 4b. live regression (installed a8b2d779): Abito must react as APPROVAL to the real Claude/Codex permission (SN2) ----------
  // The hooks send the permission as kind 'question'; the card already wears the approval look, the mascot kept the «?» question pose.
  const mascot = () => page.evaluate(() => ({ badge: document.getElementById('clay-badge').dataset.kind || '' }));
  await resetSent();
  await show({ ...pair('question', 'Aprobar una vez', 'Rechazar', 'Codex pide permiso para Bash: ls'), id: uid(60) });
  let m = await mascot();
  ok('SN2 Codex permission (kind question): the badge on Abito is approval, not «?»', m.badge === 'approval', JSON.stringify(m));
  await show({ ...pair('question', 'Uno', 'Dos', '¿Cuál preferís?'), id: uid(61) });
  m = await mascot();
  ok('SN2 (unchanged): an ordinary two-option question keeps the question badge', m.badge === 'question', JSON.stringify(m));
  // restrictive fallback: lossy / unknown wording / extra option / free text stay the ordinary numbered list
  for (const [name, p] of [
    ['lossy Rechazar + Decidir en la terminal', pair('question', 'Rechazar', 'Decidir en la terminal', 'Claude Code pide permiso para Bash: ls')],
    ['unknown wording', pair('question', 'Aprobar una vez', 'Rechazar', 'Claude Code quiere ejecutar Bash: ls')],
    ['three options', { ...pair('question', 'Aprobar una vez', 'Rechazar', 'Codex pide permiso para Bash: ls'), options: ['Aprobar una vez', 'Rechazar', 'Otra'].map((label, i) => ({ index: i, label, description: '' })) }],
    ['free text', pair('question', 'Aprobar una vez', 'Rechazar', 'Codex pide permiso para Bash: ls', { allow_free_text: true })]]) {
    await resetSent();
    await show({ ...p, id: uid(60) });
    const l2 = { ...(await look()), hidden: await page.evaluate(() => document.getElementById('question-approval').hidden) }, r2 = await numbered();
    ok(`S5 approval fallback (${name}): stays a numbered list, no approve button`, l2.look === '' && l2.hidden && r2.length >= 2, JSON.stringify([l2, r2]));
  }

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await page.close(); await ctx.close(); server.close(); await browser.close().catch(() => {}); // on a CDP connection this only detaches
  console.log(`\nnotification-card-shared-browser: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('BROWSER HARNESS ERROR', e.message); process.exit(2); });
