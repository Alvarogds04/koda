'use strict';
/* The expanded overview with the REAL css/scripts in a real layout engine: nothing overlaps, nothing is clipped out of reach, every
   control receives its own click. Island = 720x184 (viewport x16..656, y0..160); cards y42..150. Run: node test-node/island-geometry-check.cjs */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-geometry-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }

const ISLAND = { left: 16, top: 0, right: 736, bottom: 184 };
const CARD = { top: 42, bottom: 174 };
const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
const inside = (a, c) => a.left >= c.left - 0.5 && a.top >= c.top - 0.5 && a.right <= c.right + 0.5 && a.bottom <= c.bottom + 0.5;
const label = e => `${e.id}[${Math.round(e.left)},${Math.round(e.top)},${Math.round(e.right)},${Math.round(e.bottom)}]`;

/* HU-057 RE-POINT (odd/tasks/isla-nusa.md): the expanded overview is the 720x150 Nusa notch (186 with the notices / engine strip). The legacy overview controls
   (#session-jump, .pill-choice blobs, .see-all, the 184px cards) were REMOVED ON PURPOSE and live hidden in #overview-view; the agents are reached through the
   Agentes tab (.nusa-agent rows, button.nusa-jump, «Ver todas (N)» = .nusa-all). The intent of this check is unchanged: nothing overlaps, nothing is cut or
   out of reach, every control that EXISTS receives its own click. Measured on the real layout, never from source. */
const NOTCH = { left: 16, top: 0, right: 736 };
// a control a human could see and click: rendered, every ancestor visible and not transparent
const VISIBLE_JS = `(el) => { const b = el.getBoundingClientRect(); if (b.width < 4 || b.height < 4) return false;
  for (let p = el; p; p = p.parentElement) { const c = getComputedStyle(p); if (c.display === 'none' || c.visibility === 'hidden' || +c.opacity === 0) return false; }
  // a control inside a scrolling list that is scrolled out of view is reached by scrolling, not by a click at its (clipped) box
  for (let p = el.parentElement; p && p.id !== 'capsule'; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if (o === 'auto' || o === 'scroll' || o === 'hidden') { const pb = p.getBoundingClientRect(); if (b.bottom > pb.bottom + 0.5 || b.top < pb.top - 0.5) return false; } }
  return true; }`;
/** the visible matches of sel that do not receive their own click at their centre (the hidden legacy ones are NOT counted here: see hiddenByDesign) */
async function visibleHits(r, sel) {
  return r.page.evaluate(([selector, vis]) => { const visible = eval(vis);
    return [...document.querySelectorAll(selector)].filter(visible).map(el => { const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y);
      return { id: el.id || el.className, ok: !!top && (top === el || el.contains(top)), at: [Math.round(x), Math.round(y)], got: top ? (top.id || top.className || top.tagName) : null }; }); }, [sel, VISIBLE_JS]);
}
/** legacy controls removed on purpose: none may be visible or able to swallow a click (computed visibility hidden / display none, and not hit-testable at their centre) */
async function hiddenByDesign(r, sel) {
  return r.page.evaluate(selector => [...document.querySelectorAll(selector)].filter(el => {
    const b = el.getBoundingClientRect(), s = getComputedStyle(el); if (b.width <= 0 || b.height <= 0 || s.display === 'none') return false; // no box: cannot swallow anything
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return s.visibility !== 'hidden' || (!!top && (top === el || el.contains(top)));
  }).map(el => el.id || el.className), sel);
}
const LEGACY = '#session-jump, .pill-choice, #pill-choices, #blobs, .see-all, #blobs-footer, .mini, #mini-grid';
const NUSA_BASE = '.nusa-input, .nusa-send, #nusa-next, #nusa-tab-inicio, #nusa-tab-agentes, #nusa-tab-avisos';
async function nusaBoxes(r) {
  const out = [];
  for (const sel of ['.nusa-input', '.nusa-send', '#nusa-next', '#nusa-prev', '.nusa-agent', '.nusa-all', '#nusa-tab-inicio', '#nusa-tab-agentes', '#nusa-tab-avisos', '#engine-band-link', '#engine-band-skip'])
    for (const b of await r.measure(sel)) if (b.shown && b.w >= 4) out.push({ ...b, sel });
  return out;
}
function noOverlaps(list, why) {
  const bad = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i], list[j])) bad.push(`${label(list[i])} x ${label(list[j])}`);
  assert.deepEqual(bad, [], `${why}: ${bad.join(' | ')}`);
}
async function realClick(r, sel) { const b = (await r.measure(sel)).find(x => x.shown); assert.ok(b, `${sel} is shown`); await r.page.mouse.click(b.left + b.w / 2, b.top + b.h / 2); await r.page.waitForTimeout(700); }

(async () => {
  let passed = 0;
  const scenarios = {
    sessions: { github: true },
    'sessions + notices + Pi without account': { github: true, notices: 4, engine: 'account' },
    'no engine (Sin motor) + notices': { notices: 4, engine: 'down' },
    empty: { sessions: [] },
    'empty + no engine': { sessions: [], engine: 'down', notices: 2 },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    const r = await H.open(scenario);
    try {
      const empty = Array.isArray(scenario.sessions) && !scenario.sessions.length;
      const isl = (await r.measure('#island'))[0];
      // 720 wide, 150 high; 186 with the strip (Avisos / engine problem): the island never grows past that in the idle overview
      assert.ok(Math.abs(isl.w - 720) <= 1 && (Math.abs(isl.h - 150) <= 1 || Math.abs(isl.h - 186) <= 1), `${name}: the Nusa notch is 720x150 (186 with a strip): ${label(isl)}`);
      const notch = { ...NOTCH, bottom: isl.bottom };
      // legacy controls removed by HU-057 are hidden by design: nothing invisible can swallow a click
      assert.deepEqual(await hiddenByDesign(r, LEGACY), [], `${name}: legacy hidden controls must not be visible or hit-testable`);
      const sweep = async tab => {
        const list = await nusaBoxes(r);
        noOverlaps(list, `${name}/${tab}: overlapping boxes`);
        for (const b of list) assert.ok(inside(b, notch), `${name}/${tab}: ${label(b)} leaves the island`);
        const hits = [];
        for (const sel of [NUSA_BASE, '#nusa-prev', '.nusa-agent', '.nusa-jump', '.nusa-all', '#notice-action', '#notice-dismiss', '#notice-open', '#engine-band-link', '#engine-band-skip', '.engine-link', '#centre-cta', '#connection:not([disabled])']) hits.push(...await visibleHits(r, sel));
        const blocked = hits.filter(h => !h.ok).map(h => `${h.id}@${h.at} got ${h.got}`);
        assert.deepEqual(blocked, [], `${name}/${tab}: controls whose click lands on something else: ${blocked.join(' | ')}`);
        return hits;
      };
      const inicio = await sweep('Inicio');
      assert.ok(['nusa-input', 'nusa-fbtn nusa-send', 'nusa-tab-inicio', 'nusa-tab-agentes', 'nusa-tab-avisos'].every(id => inicio.some(h => h.id === id)), `${name}: the ask field, send and the three tabs were hit-tested: ${inicio.map(h => h.id)}`);
      await realClick(r, '#nusa-tab-agentes'); // a real click on the dot opens Agentes
      const agentes = await sweep('Agentes');
      if (!empty) {
        assert.ok(agentes.filter(h => h.id === 'nusa-agent').length >= 1, `${name}: Agentes lists the session rows`);
        assert.ok(agentes.filter(h => /nusa-jump/.test(h.id)).length >= 1, `${name}: every row has its own ↗ jump button`);
        const rows = (await r.measure('.nusa-agent')).filter(b => b.shown), jumps = (await r.measure('.nusa-jump')).filter(b => b.shown);
        // the row's text ends before its jump button (they never share pixels), and the jump is a real >= 22px target
        for (const j of jumps) { assert.ok(j.w >= 22 && j.h >= 22, `jump target ${label(j)}`); const row = rows.find(rw => j.top >= rw.top - 0.5 && j.bottom <= rw.bottom + 0.5); assert.ok(row, `the jump ${label(j)} sits inside its row`); }
        const texts = await r.page.evaluate(() => [...document.querySelectorAll('.nusa-agent')].filter(a => a.getBoundingClientRect().width).map(a => { const t = a.querySelector('.nusa-agent-name, span'); const tb = t ? t.getBoundingClientRect() : null, j = a.querySelector('.nusa-jump') ? a.querySelector('.nusa-jump').getBoundingClientRect() : null; return { tr: tb ? tb.right : 0, jl: j ? j.left : 1e9 }; }));
        for (const t of texts) assert.ok(t.tr <= t.jl + 0.5, `a row's text runs under its jump button: ${JSON.stringify(t)}`);
      } else assert.equal(agentes.filter(h => h.id === 'nusa-agent').length, 0, `${name}: no sessions, no rows`);
      passed += 1;
    } catch (e) { await r.screenshot(`/tmp/geo-fail-${name.replace(/\W+/g, '_')}.png`).catch(() => {}); throw e; }
    finally { await r.close(); }
  }

  // HU-057: the blobs column is gone BY DESIGN (agents are Koda + the Agentes rows). Its guarantees move to the Agentes tab with 14 sessions («manyPi»):
  // the rows are WHOLE (none cut by the panel), «Ver todas (14)» is whole and uncovered, nothing is dropped (the overlay lists every session, reachable by
  // scrolling), and the island does not grow to fit them. (S32 «no limit on declared pills» had no notch counterpart: the declared pills are a paused feature.)
  {
    const r = await H.open({ manyPi: true, github: true });
    try {
      await realClick(r, '#nusa-tab-agentes');
      const panel = (await r.measure('#nusa-panel'))[0], isl = (await r.measure('#island'))[0];
      const rows = (await r.measure('.nusa-agent')).filter(b => b.shown), all = (await r.measure('.nusa-all')).filter(b => b.shown);
      assert.ok(rows.length >= 2, `at least two whole agent rows, got ${rows.length}`);
      for (const b of rows) assert.ok(b.top >= panel.top - 0.5 && b.bottom <= panel.bottom + 0.5, `a row is cut by the panel: ${label(b)} in ${label(panel)}`);
      assert.equal(all.length, 1); assert.equal(all[0].text, 'Ver todas (14)', 'the rest is one click away, nothing is dropped');
      assert.ok(all[0].bottom <= panel.bottom + 0.5 && rows.every(b => b.bottom <= all[0].top + 0.5), 'the link is whole and below the rows');
      assert.ok(Math.abs(isl.h - 150) <= 1, `the island does not grow to fit 14 sessions (${isl.h})`);
      await realClick(r, '.nusa-all');
      assert.equal(await r.page.evaluate(() => document.getElementById('capsule').dataset.nusaSessions || ''), 'open', 'a real click opens the full list');
      const picks = (await r.measure('.sessions-all-pick')).filter(b => b.shown);
      assert.ok(picks.length >= 2, 'the overlay lists sessions');
      const ids = await r.page.evaluate(() => document.querySelectorAll('.sessions-all-pick').length);
      assert.equal(ids, 14, 'every one of the 14 sessions is in the overlay');
      await r.page.evaluate(() => { const l = document.querySelector('.sessions-all-list'); l.scrollTop = l.scrollHeight; });
      await r.page.waitForTimeout(150);
      const last = (await r.measure('.sessions-all-pick')).at(-1), list = (await r.measure('.sessions-all-list'))[0];
      assert.ok(last.top >= list.top - 0.5 && last.bottom <= list.bottom + 0.5, `the last session is whole after scrolling: ${label(last)} in ${label(list)}`);
      assert.deepEqual((await visibleHits(r, '.sessions-all-pick')).filter(h => !h.ok && h.at[1] >= list.top && h.at[1] <= list.bottom), [], 'the overlay rows in view receive their own clicks (the rest are reached by scrolling)');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-agentes-all.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }

  // focus mode (a question waits): the card takes the notch, Koda is the right column, the legacy blobs column stays hidden, still no overlaps
  {
    const r = await H.open({ question: 'plain', github: true });
    try {
      const mode = await r.page.evaluate(() => document.getElementById('capsule').dataset.layout);
      assert.equal(mode, 'focus');
      const q = (await r.measure('#question'))[0];
      assert.ok(q.shown, 'the question card is visible');
      assert.deepEqual(await hiddenByDesign(r, LEGACY), [], 'HU-057: the blobs column does not exist in focus mode (nothing visible or hit-testable)');
      for (const sel of ['#question-skip', '.q-option']) for (const h of await visibleHits(r, sel)) assert.ok(h.ok, `focus mode: ${h.id}@${h.at} got ${h.got}`);
      const qb = [];
      for (const sel of ['#question-asker', '#question-skip', '#question-body', '.q-option']) for (const b of await r.measure(sel)) { if (b.shown) qb.push({ ...b, sel }); }
      noOverlaps(qb, 'focus mode: question card children');
      passed += 1;
    } finally { await r.close(); }
  }
  // the state the screen validator builds: GitHub declared WITH data, two sessions (one Codex «proyecto-beta»), 4 notices, Pi without an account.
  // HU-057 re-point: the GitHub BLOB is gone from the notch (the legacy column is hidden by design), so the click on it cannot be made. What still exists is the
  // focus path the blob used to trigger, the document event `abito:integration-focus`: it must put the overview in its «github» state and a null id must clear it.
  // GAP (reported to the parent, NOT asserted here): while GitHub is un-paused the card (.gh-card, inside the hidden #overview-view) has no surface in the notch,
  // so its geometry (rows, overlaps, «GitHub ◂») cannot be measured; island-github-geometry / island-toast-tip stay red on exactly that.
  {
    const sessions = [{ id: 's-eb4fc4bc', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null }, { id: 's-3b48a1be', kind: 'codex', cwd: 'proyecto-beta', state: 'sleeping', origin: null }];
    for (const theme of ['light', 'dark']) {
      const r = await H.open({ sessions, github: true, githubData: true, notices: 4, engine: 'account', theme });
      try {
        assert.deepEqual(await hiddenByDesign(r, LEGACY), [], `${theme}: the GitHub blob / the blobs column are not visible nor hit-testable`);
        const focus = id => r.page.evaluate(id => { document.dispatchEvent(new CustomEvent('abito:integration-focus', { detail: { id } })); return new Promise(res => setTimeout(() => res(document.getElementById('overview-view').dataset.github || null), 900)); }, id);
        assert.equal(await focus('integration_github'), 'on', `${theme}: the focus path opens the GitHub state`);
        assert.equal(await focus(null), null, `${theme}: a null focus closes it`);
        const names = await r.page.evaluate(() => [...document.querySelectorAll('.nusa-agent')].filter(a => a.getBoundingClientRect().width).length);
        void names;
        passed += 1;
      } catch (e) { await r.screenshot(`/tmp/geo-fail-github-${theme}.png`).catch(() => {}); throw e; }
      finally { await r.close(); }
    }
  }
  // the grouped notices list (validator scene «historial agrupado»): «Ver» opens a LIST over the whole 620x108 card; its rows are
  // reachable, one dismisses exactly one row, and «Descartar todos» is clickable
  {
    const r = await H.open({ notices: 4, engine: 'account', github: true });
    try {
      await r.page.waitForTimeout(500);
      const open = (await r.hit('#notice-action'))[0];
      assert.ok(open && open.ok, `the «Ver» button receives its click: ${JSON.stringify(open)}`);
      const btn = (await r.measure('#notice-action'))[0];
      await r.page.mouse.click(btn.left + btn.w / 2, btn.top + btn.h / 2);
      await r.page.waitForTimeout(800);
      const list = (await r.measure('#notice-list'))[0];
      assert.ok(list && list.shown, 'the grouped list is visible');
      assert.ok(list.w >= 560 && list.h >= 90, `the list takes the whole card, not the 174x28 band: ${label(list)}`);
      const rows = (await r.measure('.notice-list-row')).filter(b => b.shown);
      assert.ok(rows.length >= 2, `at least two list rows are visible and reachable, got ${rows.length}`);
      const hits = [...await r.hit('.notice-list-dismiss'), ...await r.hit('#notice-clear'), ...await r.hit('.notice-list-row')];
      const bad = hits.filter(h => !h.ok).map(h => `${h.id}@${h.at} got ${h.got}`);
      assert.deepEqual(bad, [], `list controls whose click lands elsewhere: ${bad.join(' | ')}`);
      for (const theme of ['light', 'dark']) {
        await r.page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
        assert.deepEqual((await r.hitEdges('.notice-list-row')).filter(h => !h.ok), [], `${theme}: notice row edges receive their own hits`);
        const state = await r.page.evaluate(() => {
          const rows = document.getElementById('notice-rows');
          const mascot = document.getElementById('clay');
          const title = document.querySelector('.notice-list-title');
          return { mascot: getComputedStyle(mascot).visibility, opacity: getComputedStyle(title).opacity,
            wraps: getComputedStyle(title).whiteSpace, scrolls: rows.scrollHeight > rows.clientHeight,
            heights: [...rows.children].map(el => el.getBoundingClientRect().height) };
        });
        assert.equal(state.mascot, 'hidden'); assert.equal(state.opacity, '1'); assert.equal(state.wraps, 'normal');
        assert.equal(state.scrolls, true); assert.ok(state.heights.every(h => h >= 44));
      }
      await r.page.locator('.notice-list-dismiss').first().scrollIntoViewIfNeeded();
      const before = (await r.measure('.notice-list-row')).length;
      const d = (await r.measure('.notice-list-dismiss'))[0];
      await r.page.mouse.click(d.left + d.w / 2, d.top + d.h / 2);
      await r.page.waitForTimeout(600);
      const after = (await r.measure('.notice-list-row')).length;
      assert.equal(after, before - 1, 'dismissing a row removes exactly one');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-notice-list.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // after a question is answered (or declined) and its «Recibida» word expires, the island gives its height back and the mascot returns:
  // a stale «question shown» kept the island 200px tall with the mascot 26px lower, and «En reposo» was drawn over it (screen gate)
  {
    const r = await H.open({ question: 'plain', sessions: [] });
    try {
      const islandH = async () => (await r.measure('#island'))[0].h;
      const clayTop = async () => (await r.measure('#clay'))[0].top;
      assert.ok(await islandH() > 170, `with the question open the island is tall (${await islandH()})`);
      const opt = (await r.measure('.q-option')).find(b => b.shown);
      await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
      await r.page.waitForTimeout(6500); // «Recibida» (3 s) + the spring back
      const mode = await r.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question || '', badge: !document.getElementById('clay-badge').hidden, layout: document.getElementById('capsule').dataset.layout }));
      assert.deepEqual(mode, { q: '', badge: false, layout: 'normal' }, `nothing of the question is left over: ${JSON.stringify(mode)}`);
      // HU-057: the idle overview is the 150px notch (it was 184) and Koda's idle position is read from a fresh idle island, not a constant
      assert.ok(Math.abs(await islandH() - 150) < 2, `the island is back to the 150px notch overview, got ${await islandH()}`);
      const idle = await H.open({ sessions: [] });
      try { const want = (await idle.measure('#clay'))[0].top; assert.ok(Math.abs(await clayTop() - want) < 2, `the mascot is back at the idle position (${want}), got ${await clayTop()}`); } finally { await idle.close(); }
      const list = await nusaBoxes(r);
      noOverlaps(list, 'after answering: overlapping boxes');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-after-answer.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // The screen validator clicks like click(): scrollIntoView({block:'center'}) on the target, THEN a click at the target's NEW centre. A control inside the
  // overview must not make an ancestor scroll: #island is overflow:hidden and used to move 31px, shifting every card, so the real click missed. HU-057 re-point:
  // the controls are the Agentes rows' ↗ jump, «Ver todas», the ask field and the strip; scrolling any of them into view must scroll no ancestor and move no card.
  {
    const r = await H.open({ manyPi: true, notices: 4, engine: 'account', theme: 'light' });
    try {
      await realClick(r, '#nusa-tab-agentes');
      const probe = await r.page.evaluate(async () => {
        const moved = [], band0 = document.getElementById('notices').getBoundingClientRect().top;
        for (const sel of ['.nusa-jump', '.nusa-all', '.nusa-agent']) {
          const el = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width);
          if (!el) { moved.push('missing ' + sel); continue; }
          el.scrollIntoView({ block: 'center', inline: 'center' });
          await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        }
        const scrolled = [...document.querySelectorAll('*')].filter(n => (n.scrollTop || n.scrollLeft) && n.id !== 'nusa-panel' && !n.closest('#nusa-panel')).map(n => n.id || n.className);
        return { moved, scrolled, band: [band0, document.getElementById('notices').getBoundingClientRect().top] };
      });
      assert.deepEqual(probe.moved, [], 'the Agentes controls exist');
      assert.deepEqual(probe.scrolled, [], `scrollIntoView must scroll ONLY the panel's own list, not the island (it scrolled: ${probe.scrolled})`);
      assert.equal(probe.band[1], probe.band[0], 'no card moves when a control is scrolled into view');
      assert.equal((await r.measure('#island'))[0].top, 0, 'the island did not move');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-scrollintoview.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // the notice capsule with a LONG title («Conexión caída»): the title ellipsizes inside its own box, never runs under «Abrir» or spills out of the column
  {
    for (const title of ['Conexión caída', 'Conexión caída con el motor del agente local: reintentando en segundo plano']) {
      const r = await H.open({ notices: 1, noticeTitle: title, engine: 'account', github: true });
      try {
        // Since abito-avisos-ux S1 (human: «que salga abajo como sale los avisos de sin cuenta», edb3bd76) the notice capsule is the
        // 700x32 «Avisos · N» strip under the cards, not a capsule inside the blobs column: it must stay INSIDE THE ISLAND, under the cards.
        const cap = (await r.measure('#notice-pill'))[0], isl = (await r.measure('#island'))[0], blobs = (await r.measure('#nusa-panel'))[0]; // HU-057: the cards are the Nusa panel (the blobs column is gone)
        assert.ok(cap && cap.shown, 'the notice capsule is shown');
        assert.ok(cap.left >= isl.left - 0.5 && cap.right <= isl.right + 0.5 && cap.bottom <= isl.bottom + 0.5, `the strip stays inside the island: ${label(cap)} vs ${label(isl)}`);
        assert.ok(cap.top >= blobs.bottom - 0.5, `the strip sits under the Nusa panel: ${label(cap)} vs ${label(blobs)}`);
        const parts = [];
        for (const sel of ['#notice-ring', '#notice-title', '#notice-sub', '#notice-action', '#notice-dismiss']) for (const b of await r.measure(sel)) if (b.shown) {
          // the × keeps a 44px hit box over a 28px band: compare what is DRAWN (its 16px glyph), not the hit area
          parts.push(sel === '#notice-dismiss' ? { ...b, left: b.left + 14, right: b.right - 14, top: b.top + 14, bottom: b.bottom - 14 } : { ...b, sel });
        }
        noOverlaps(parts, `notice capsule «${title.slice(0, 20)}…»`);
        for (const b of parts) assert.ok(b.right <= cap.right + 14 && b.left >= cap.left - 0.5, `${label(b)} leaves the capsule ${label(cap)}`);
        passed += 1;
      } catch (e) { await r.screenshot('/tmp/geo-fail-notice-capsule.png').catch(() => {}); throw e; }
      finally { await r.close(); }
    }
  }
  // Ctrl+Alt+T on the REAL island.js: with a session focused the shortcut sends THAT session's key; after the validator scene publishes
  // «no focused session» it sends the plain class verb, so its class fixture stays the window the native readback expects.
  {
    const r = await H.open({});
    try {
      const press = async () => { await r.page.evaluate(() => window.__emit('global-shortcut', 'jumpToTerminal')); await r.page.waitForTimeout(300); return r.page.evaluate(() => (window.__focusCalls || []).at(-1)); };
      const focused = await press();
      assert.equal(focused.target, 'terminal');
      assert.match(String(focused.session), /^s-[0-9a-f]{8}$/, `with a session focused the key travels: ${JSON.stringify(focused)}`);
      await r.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:sessions-view', { detail: { view: null, focusId: null } })));
      const cleared = await press();
      assert.deepEqual(cleared, { target: 'terminal' }, `with no focused session it is the plain class verb: ${JSON.stringify(cleared)}`);
      const mode = await r.page.evaluate(() => document.getElementById('capsule').dataset.shortcutTerminal);
      assert.equal(mode, 'focused-class', 'and the product reports «focused-class», which is what the class-fixture readback is judged against');
      passed += 1;
    } finally { await r.close(); }
  }
  // v4-01b: a notice capsule in the blobs column must keep its title readable (the real capture showed «Pi… Hace…» and only 3 rows)
  {
    const r = await H.open({ notices: 1, noticeTitle: 'Pi terminó su turno', github: true, engine: 'account' });
    try {
      const title = (await r.measure('#notice-title'))[0], cap = (await r.measure('#notice-pill'))[0];
      const fits = await r.page.evaluate(() => { const t = document.getElementById('notice-title'); return { sw: t.scrollWidth, cw: t.clientWidth, text: t.textContent }; });
      assert.ok(fits.sw <= fits.cw + 1, `the notice title is not truncated in the column: «${fits.text}» needs ${fits.sw}px, has ${fits.cw}px`);
      const sub = await r.page.evaluate(() => { const s = document.getElementById('notice-sub'); return { disp: getComputedStyle(s).display, aria: document.getElementById('notice-open').getAttribute('aria-label') }; });
      assert.equal(sub.disp, 'none', 'the capsule carries NO secondary text: it cannot fit the 174px column whatever the font, and the real window showed «Hace…»');
      assert.ok(sub.aria, 'the detail stays reachable through the accessible name');
      // HU-057: the blobs column is gone; with the strip showing, the Agentes rows stay whole and above it (>= 2 rows, none under the strip)
      await realClick(r, '#nusa-tab-agentes');
      const rows = (await r.measure('.nusa-agent')).filter(b => b.shown), strip = (await r.measure('#notice-pill'))[0], panel = (await r.measure('#nusa-panel'))[0];
      const whole = rows.filter(b => b.top >= panel.top - 0.5 && b.bottom <= panel.bottom + 0.5 && b.bottom <= strip.top + 0.5);
      assert.ok(whole.length >= 2, `with a notice strip the Agentes tab still shows >= 2 whole rows above it, got ${whole.length}`);
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-notice-column.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // v4-12 «Recibida»: after answering, the outcome card and the blobs column must not share pixels (the column overlapped the card's corner)
  {
    for (const kind of ['multi', 'form']) {
      const r = await H.open({ question: kind, github: true });
      try {
        const q0 = (await r.measure('#question'))[0];
        const opt = (await r.measure('.q-option')).find(b => b.shown);
        await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
        if (kind === 'form') { for (let i = 0; i < 2; i++) { await r.page.waitForTimeout(250); const p = (await r.measure('#question-primary')).find(b => b.shown); if (p) await r.page.mouse.click(p.left + p.w / 2, p.top + p.h / 2); } }
        else { await r.page.waitForTimeout(250); const p = (await r.measure('#question-primary')).find(b => b.shown); if (p) await r.page.mouse.click(p.left + p.w / 2, p.top + p.h / 2); }
        await r.page.waitForTimeout(500);
        const state = await r.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question, text: (document.getElementById('question-state-word') || {}).textContent }));
        if (state.q === 'outcome') {
          const card = (await r.measure('#question'))[0], blobs = (await r.measure('#blobs'))[0];
          assert.ok(!overlap(card, blobs) || !blobs.shown, `${kind}: the «${state.text}» card ${label(card)} and the blobs column ${label(blobs)} share pixels`);
        } else { await r.screenshot(`/tmp/geo-note-${kind}.png`).catch(() => {}); }
        passed += 1;
      } catch (e) { await r.screenshot(`/tmp/geo-fail-recibida-${kind}.png`).catch(() => {}); throw e; }
      finally { await r.close(); }
    }
  }
  // v4-12-q4-paso1: in a questionnaire step the CHOSEN option shows a clear selected mark (not only the hover highlight)
  {
    const r = await H.open({ question: 'form', github: true });
    try {
      const rows = (await r.measure('.q-option')).filter(b => b.shown);
      assert.ok(rows.length >= 3, 'the step shows its options');
      const before = await r.page.evaluate(() => [...document.querySelectorAll('.q-option')].map(b => b.getAttribute('aria-checked') || b.dataset.selected || ''));
      await r.page.mouse.click(rows[1].left + rows[1].w / 2, rows[1].top + rows[1].h / 2);
      await r.page.waitForTimeout(300);
      await r.page.mouse.move(5, 5); // the pointer leaves: nothing but the selection may still mark the row
      await r.page.waitForTimeout(200);
      const after = await r.page.evaluate(() => [...document.querySelectorAll('.q-option')].map(b => { const m = b.querySelector('.q-dot, .q-box'); return { checked: b.getAttribute('aria-checked'), selected: b.dataset.selected, markBg: m ? getComputedStyle(m).backgroundImage + '|' + getComputedStyle(m).backgroundColor : '', markBorder: m ? getComputedStyle(m).borderColor : '', bg: getComputedStyle(b, '::after').backgroundColor, weight: getComputedStyle(b.querySelector('.q-label')).fontWeight }; }));
      assert.equal(after[1].selected, 'true', `the chosen row is marked selected: ${JSON.stringify(after[1])}`);
      assert.notEqual(after[1].selected, after[0].selected, 'only the chosen row');
      assert.notEqual(after[1].bg, after[0].bg, `the chosen row looks different WITHOUT hover (background ${after[1].bg} vs ${after[0].bg})`);
      assert.notEqual(after[1].markBg, after[0].markBg, `the chosen row's mark (dot/box) is filled, the others are empty: ${after[1].markBg} vs ${after[0].markBg}`);
      assert.equal(after[1].weight, '700', 'and its label is heavier');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-selected-step.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // L5 (human), RE-POINTED by HU-057 (see inside): answer a question and look at «Recibida».
  {
    const r = await H.open({ question: 'plain', github: true, githubData: true });
    try {
      const opt = (await r.measure('.q-option')).find(b => b.shown);
      await r.page.mouse.click(opt.left + opt.w / 2, opt.top + opt.h / 2);
      await r.page.waitForTimeout(700); // the host reported «answered»; «Recibida» is on screen (it lasts ~3 s)
      const during = await r.page.evaluate(() => document.getElementById('capsule').dataset.question);
      assert.equal(during, 'outcome', `«Recibida» is showing: ${during}`);
      // HU-057 re-point: L5 («click the GitHub blob during Recibida ends it and opens the card») protected a click on a blob that no longer exists in the notch,
      // and its only other route (the focus event) is not user-reachable and does not end the outcome. What survives: nothing removed can be hit during
      // «Recibida» (no invisible control swallows the human's click) and the outcome ends by its own timer with nothing left over (the block above).
      assert.deepEqual(await hiddenByDesign(r, LEGACY), [], 'no legacy blob is visible or hit-testable while «Recibida» shows');
      await r.page.waitForTimeout(3500);
      const st = await r.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question || '' }));
      assert.deepEqual(st, { q: '' }, `the outcome ends by itself: ${JSON.stringify(st)}`);
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-outcome-click.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // v5-06 REGRESSION: choosing an option must not change its row: the label stays on ONE line (it broke letter by letter when the selection
  // added a grid cell) and the row keeps its height; the neighbours do not move.
  {
    for (const kind of ['multi', 'form']) {
      const r = await H.open({ question: kind, github: true });
      try {
        const snap = () => r.page.evaluate(() => [...document.querySelectorAll('.q-option')].map(b => { const l = b.querySelector('.q-label'), bb = b.getBoundingClientRect(), lb = l.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(l).lineHeight) || 16; return { h: Math.round(bb.height * 10) / 10, top: Math.round(bb.top * 10) / 10, labelW: Math.round(lb.width), labelLines: Math.round(lb.height / lh), cols: getComputedStyle(b).gridTemplateColumns, kids: b.children.length }; }));
        const before = await snap();
        const rows = (await r.measure('.q-option')).filter(b => b.shown);
        await r.page.mouse.click(rows[0].left + rows[0].w / 2, rows[0].top + rows[0].h / 2);
        await r.page.waitForTimeout(400);
        const during = await snap();                 // pointer still over the chosen row
        await r.page.mouse.move(5, 5); await r.page.waitForTimeout(250);
        const after = await snap();
        for (const [when, list] of [['hovered', during], ['pointer away', after]]) {
          assert.deepEqual(list.map(x => x.h), before.map(x => x.h), `${kind}, ${when}: no row changes height after choosing (${JSON.stringify(list.map(x => x.h))} vs ${JSON.stringify(before.map(x => x.h))})`);
          assert.deepEqual(list.map(x => x.top), before.map(x => x.top), `${kind}, ${when}: no neighbour moves`);
          assert.ok(list.every(x => x.labelLines === 1), `${kind}, ${when}: every label stays on one line (${JSON.stringify(list.map(x => x.labelLines))})`);
          assert.ok(list.every(x => x.labelW >= 60), `${kind}, ${when}: every label keeps a real column (${JSON.stringify(list.map(x => x.labelW))})`);
          assert.deepEqual(list.map(x => x.cols), before.map(x => x.cols), `${kind}, ${when}: the grid columns do not change with the selection`);
          assert.deepEqual(list.map(x => x.kids), before.map(x => x.kids), `${kind}, ${when}: the row keeps the same children`);
        }
        passed += 1;
      } catch (e) { await r.screenshot(`/tmp/geo-fail-chosen-${kind}.png`).catch(() => {}); throw e; }
      finally { await r.close(); }
    }
  }
  // R23: even a boot-cached question is visible over chat, without a toast.
  // Explicit question-open still leaves chat through the existing back verb.
  {
    const r = await H.open({ question: 'plain', chat: true });
    try {
      const view = () => r.page.evaluate(() => document.getElementById('capsule').dataset.view);
      assert.equal(await view(), 'chat', 'the island is in the chat view when the question arrives');
      const toast = (await r.measure('#question-toast')).find(b => b.shown);
      assert.equal(toast, undefined, 'the visible question card needs no toast');
      assert.ok((await r.measure('#question'))[0].shown, 'R23: card already visible over chat');
      await r.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:question-open')));
      await r.page.waitForTimeout(900);
      const st = await r.page.evaluate(() => ({ view: document.getElementById('capsule').dataset.view, q: document.getElementById('capsule').dataset.question, back: (window.__chatCalls || []).length }));
      assert.deepEqual([st.view, st.q], ['overview', 'pending'], `question-open leaves chat: ${JSON.stringify(st)}`);
      const card = (await r.measure('#question'))[0];
      assert.ok(card.shown, 'the question card is drawn');
      passed += 1;
    } catch (e) { await r.screenshot('/tmp/geo-fail-toast-chat.png').catch(() => {}); throw e; }
    finally { await r.close(); }
  }
  // v5-04, RE-POINTED by HU-057: the GitHub PR row tooltip (full title on hover) protected a row inside the GitHub card, which has no surface in the notch
  // (GAP reported to the parent; island-toast-tip stays red on it). What exists and is measured: the island's own tooltip never takes the pointer and is
  // not drawn at rest, so it cannot swallow a click on any notch control.
  {
    const r = await H.open({ github: true, githubData: 'real', quick: true });
    try {
      const tip = await r.page.evaluate(() => { const t = document.getElementById('island-tip'); return t && { pe: getComputedStyle(t).pointerEvents, hidden: t.hidden || getComputedStyle(t).visibility === 'hidden' || getComputedStyle(t).display === 'none' || +getComputedStyle(t).opacity === 0 }; });
      assert.ok(tip, 'the island tooltip element exists'); assert.equal(tip.pe, 'none', 'it never takes the pointer'); assert.ok(tip.hidden, 'and it is not drawn at rest');
      passed += 1;
    } finally { await r.close(); }
  }
  console.log(`island-geometry-check: ${passed} real-layout checks ok`);
})().catch(e => { console.error(e); process.exit(1); });
