'use strict';
/* K2-13 T6b-1 «Hoy»: the REAL island, in the real frontend, in headless Chromium (design/k2-13-minikodas/
   02-hoy-todo-en-la-isla.html, the human's choice L38). What this check can see and the pure tests cannot: the notch really
   grows to 300 with the Hoy panel inside it, nothing overlaps Koda's column, Aprobar / Rechazar are really reachable with a
   click and really 24 high, an empty day really gives the room back, and the page really reports the grown box to the host
   (without that report the lower half of Hoy would take no clicks at all).
   Screenshots: $HOY_SHOT_DIR (default /tmp). Playwright is a dev tool of this machine: when it is absent the check SKIPS
   loudly, never green. Run: node test-node/island-hoy-visual-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-hoy-visual-check: no playwright — NOT a pass'); process.exit(0); }
const SHOTS = process.env.HOY_SHOT_DIR || '/tmp';
fs.mkdirSync(SHOTS, { recursive: true });

const A = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const B = '11111111-2222-4333-8444-555555555555';
const C = '99999999-8888-4777-8666-555555555555';
const D = '12121212-3434-4565-8787-909090909090';
const E = 'abababab-cdcd-4efe-8a8a-b0b0b0b0b0b0';
const at = hhmm => { const d = new Date(); const [h, m] = hhmm.split(':').map(Number); d.setHours(h, m, 0, 0); return d.toISOString(); };

const DAY = [
  { id: A, minikoda: 'valmar', kind: 'proposal', status: 'pending', action: 'buy', target: '10 CEDEARs de YPF',
    text: 'el balance sale el jueves y el precio está 8 % abajo', createdAt: at('09:12') },
  { id: B, minikoda: 'valmar', kind: 'proposal', status: 'pending', action: 'sell', target: '40 acciones de Pampa Energía',
    text: 'publicó que tomó ganancia con la suba del martes', createdAt: at('08:40') },
  { id: C, minikoda: 'valmar', kind: 'proposal', status: 'approved', action: 'send', target: 'el resumen a Lucía',
    text: 'por Telegram, desde tu cuenta', createdAt: at('08:20'), decidedAt: at('09:46') },
  { id: D, minikoda: 'videos', kind: 'result', status: 'approved',
    text: 'Uno trajo los subtítulos de YouTube; el otro se transcribió en esta PC (Parakeet). Los cortos rinden más y hay tres anuncios nuevos.',
    createdAt: at('08:15'), provenance: 'local_transcription' },
  { id: E, minikoda: 'valmar', kind: 'error', status: 'approved',
    text: 'La corrida de «Valmar» falló (crash). 2 propuesta(s) de esa corrida quedaron pendientes en «Hoy».', createdAt: at('08:00') },
];

function measure(page) {
  return page.evaluate(() => {
    const box = el => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    const island = document.getElementById('island'), nusa = document.getElementById('nusa'), hoy = document.getElementById('hoy');
    const koda = document.querySelector('.koda-sprite[data-koda-slot="nusa"]');
    const reach = el => { if (!el) return null; const r = box(el); const top = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2); return { w: r.w, h: r.h, ok: !!top && (top === el || el.contains(top)), got: top ? (top.id || top.className) : null }; };
    const rows = [...document.querySelectorAll('#hoy-list .hoy-row')].map(el => {
      const buttons = [...el.querySelectorAll('.hoy-acts .hoy-btn')];
      return { kind: el.dataset.kind, state: el.dataset.state, ...box(el), lines: el.querySelectorAll('.hoy-tt, .hoy-sub').length,
        text: (el.textContent || '').trim().slice(0, 130), chip: el.querySelector('.hoy-chip') ? el.querySelector('.hoy-chip').textContent : '',
        approve: reach(buttons[0]), reject: reach(buttons[1]) };
    });
    const tabs = [...document.querySelectorAll('#hoy-tabs [role="tab"]')].map(el => ({ text: (el.textContent || '').trim(), selected: el.getAttribute('aria-selected'), ...box(el), reach: reach(el) }));
    return {
      island: box(island), nusa: box(nusa), hoy: box(hoy), shown: getComputedStyle(hoy).display !== 'none',
      koda: koda ? box(koda) : null, rows, tabs,
      shapes: (window.__shapes || []).slice(-6), title: document.getElementById('nusa-title').textContent,
      summary: document.getElementById('hoy-summary').textContent,
      empty: document.getElementById('hoy-empty').hidden ? null : document.getElementById('hoy-empty').textContent,
      problem: document.getElementById('hoy-problem').hidden ? null : document.getElementById('hoy-problem').textContent,
      calls: (window.__allCalls || []).filter(c => c.cmd === 'agent_action').map(c => c.payload && c.payload.action),
      focus: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : null,
    };
  });
}

function verify(name, m, { grown = true } = {}) {
  const height = grown ? 300 : 150;
  assert.equal(m.title, 'Hoy', `${name}: the notch header says Hoy`);
  assert.ok(m.shown, `${name}: #hoy is visible`);
  assert.equal(Math.round(m.island.h), height, `${name}: #island is ${height} (was ${m.island.h})`);
  assert.equal(Math.round(m.nusa.h), height, `${name}: the notch is ${height}`);
  assert.ok(m.hoy.bottom <= m.island.bottom + 1, `${name}: the panel stays inside the island (${m.hoy.bottom} > ${m.island.bottom})`);
  assert.ok(m.hoy.x >= m.island.x && m.hoy.right <= m.island.right, `${name}: the panel is inside the island horizontally`);
  const last = m.shapes[m.shapes.length - 1];
  assert.ok(last, `${name}: the page reported its box to the host`);
  assert.equal(last.h, height, `${name}: the reported box is the grown one (${JSON.stringify(m.shapes)})`);
  for (const row of m.rows) {
    assert.ok(row.bottom <= m.island.bottom + 1, `${name}: row «${row.text.slice(0, 30)}» fits the island`);
    if (m.koda) assert.ok(!(row.x < m.koda.right && row.right > m.koda.x), `${name}: row «${row.text.slice(0, 30)}» never covers Koda`);
    for (const [label, b] of [['Aprobar', row.approve], ['Rechazar', row.reject]]) {
      if (!b) continue;
      assert.ok(b.h >= 23, `${name}: ${label} is ${b.h} high (>= 24 target)`);
      assert.ok(b.ok, `${name}: ${label} receives the click (got ${b.got})`);
    }
  }
  for (const t of m.tabs) assert.ok(t.reach.ok, `${name}: tab «${t.text}» receives the click (got ${t.reach.got})`);
}

(async () => {
  // 1 · a full day, both themes, the default tab, the rows and their buttons
  for (const theme of ['dark', 'light']) {
    const r = await H.open({ hoy: DAY, hoyTab: true, theme });
    if (!r) { console.log('SKIPPED island-hoy-visual-check: no playwright'); return; }
    try {
      const m = await measure(r.page);
      verify(`day/${theme}`, m);
      assert.equal(m.tabs.length, 3, 'three tabs');
      assert.equal(m.tabs.filter(t => t.selected === 'true').length, 1, 'one tab selected');
      assert.match(m.tabs.find(t => t.selected === 'true').text, /^Propuestas/, 'a pending day opens on Propuestas');
      assert.match(m.summary, /2 esperan tu sí · 1 resultado/, `the header line counts what waits: ${m.summary}`);
      assert.equal(m.rows.length, 3, 'Propuestas lists the three proposals of the day, decided ones included');
      assert.deepEqual(m.rows.map(x => x.kind), ['proposal', 'proposal', 'proposal']);
      assert.equal(m.rows[0].approve.ok && m.rows[0].reject.ok, true, 'a pending row offers both buttons');
      assert.equal(m.rows[2].approve, null, 'an answered row offers nothing to press');
      assert.equal(m.rows[2].state, 'approved', 'the decided row carries its closed state (what the CSS keys on)');
      assert.match(m.rows[2].text, /Aprobada · se ejecutó · \d\d:\d\d/, 'and says what was decided, in words');
      assert.ok(m.rows[0].lines >= 2, 'a proposal row is two lines (what + where it came from)');
      assert.ok(Math.round(m.rows[0].h) >= 32, `a proposal row is at least 32 high (${m.rows[0].h})`);
      await r.page.locator('#island').screenshot({ path: path.join(SHOTS, `hoy-propuestas-${theme}.png`) });
      await r.page.screenshot({ path: path.join(SHOTS, `hoy-window-${theme}.png`) });

      // Resultados: the summary in full, and the provenance chip only where the item carries it
      await r.page.click('#hoy-tab-resultados');
      await r.page.waitForTimeout(250);
      const res = await measure(r.page);
      verify(`results/${theme}`, res);
      assert.equal(res.tabs.find(t => t.selected === 'true').text.startsWith('Resultados'), true);
      assert.equal(res.rows.length, 1);
      assert.match(res.rows[0].text, /transcribió en esta PC/, 'the stored summary is read in the row');
      assert.equal(res.rows[0].chip, 'transcripto en esta PC', 'the provenance chip appears when the item carries it');
      assert.equal(res.rows[0].approve, null, 'a result NEVER offers an approval (only a proposal executes)');
      assert.ok(Math.round(res.rows[0].h) >= 44, `a result with its summary is at least 44 high (${res.rows[0].h})`);
      await r.page.locator('#island').screenshot({ path: path.join(SHOTS, `hoy-resultados-${theme}.png`) });

      // Errores: what failed and what was kept
      await r.page.click('#hoy-tab-errores');
      await r.page.waitForTimeout(250);
      const err = await measure(r.page);
      verify(`errors/${theme}`, err);
      assert.equal(err.rows.length, 1);
      assert.match(err.rows[0].text, /quedaron pendientes/, 'the error says what was kept (S13)');
      assert.equal(err.rows[0].approve, null, 'an error is read, never approved');
      await r.page.locator('#island').screenshot({ path: path.join(SHOTS, `hoy-errores-${theme}.png`) });
    } finally { await r.close(); }
  }

  // 2 · Enter on a row never approves; the button does, and the word comes back from the daemon
  {
    const r = await H.open({ hoy: DAY, hoyTab: true });
    try {
      const before = await measure(r.page);
      await r.page.focus('#hoy-list .hoy-row');
      await r.page.keyboard.press('Enter');
      await r.page.waitForTimeout(300);
      const afterEnter = await measure(r.page);
      assert.equal(afterEnter.calls.filter(c => c === 'hoy_approve').length, 0, 'Enter on a row sends nothing: Aprobar is never the default');
      assert.equal(afterEnter.rows.length, before.rows.length);
      const approveId = (await r.page.evaluate(() => document.querySelector('#hoy-list .hoy-row').dataset.id));
      await r.page.click('#hoy-list .hoy-row .hoy-approve');
      await r.page.waitForTimeout(400);
      const after = await measure(r.page);
      // the ticker also polls `sessions_list` and the mount connects with `view`: only the Hoy verbs matter here, and exactly
      // ONE approval must have travelled — after one read
      assert.deepEqual(after.calls.filter(c => /^hoy_(list|approve|reject)$/.test(c)), ['hoy_list', 'hoy_approve'], 'exactly one approval travelled');
      const row = after.rows.find(x => x.text.includes('Comprar')) || after.rows[0];
      assert.equal(row.state, 'approved', 'the row follows the daemon, not the click');
      assert.match(row.text, /Aprobada · se ejecutó/, 'and it says it ran');
      assert.equal(row.approve, null, 'the buttons leave once it is decided');
      assert.equal(await r.page.evaluate(id => window.__hoy.items.find(i => i.id === id).status, approveId), 'approved', 'the daemon-side store moved');
      assert.ok(after.focus && /hoy-row/.test(after.focus), `focus stays on the row that was decided (${after.focus})`);
      const live = await r.page.evaluate(() => document.getElementById('hoy-live').textContent);
      assert.match(live, /^Aprobada: Comprar/, `the decision is announced once (${live})`);
      await r.page.locator('#island').screenshot({ path: path.join(SHOTS, 'hoy-aprobada.png') });
      // Resolved items stay all day: the row is still there after the decision
      assert.equal(after.rows.length, before.rows.length, 'a resolved proposal keeps its row');
    } finally { await r.close(); }
  }

  // 3 · a refused approval shows the daemon's own closed reason, and claims nothing
  {
    const r = await H.open({ hoy: DAY, hoyTab: true, hoyRefuse: 'not_pending' });
    try {
      await r.page.click('#hoy-list .hoy-row .hoy-approve');
      await r.page.waitForTimeout(400);
      const m = await measure(r.page);
      verify('refusal', m);
      assert.ok(m.problem, 'a refusal is shown, never swallowed');
      assert.match(m.problem, /ya no espera tu respuesta/, `read from the closed code: ${m.problem}`);
      const stillPending = m.rows.find(x => x.kind === 'proposal' && x.approve);
      assert.equal(stillPending.state, 'pending', 'and the row stays pending: nothing was approved');
      assert.ok(!/Aprobada/.test(stillPending.text), 'nothing claims a success');
      const live = await r.page.evaluate(() => document.getElementById('hoy-live').textContent);
      assert.ok(!/^Aprobada/.test(live || ''), 'a refusal never announces a success');
      await r.page.locator('#island').screenshot({ path: path.join(SHOTS, 'hoy-rechazo-del-daemon.png') });
    } finally { await r.close(); }
  }

  // 4 · an empty day: the notch gives the room back and says why (artboard F5)
  {
    const r = await H.open({ hoy: [], hoyTab: true });
    try {
      await r.page.waitForTimeout(400);
      const m = await measure(r.page);
      verify('empty', m, { grown: false });
      assert.equal(Math.round(m.island.h), 150, 'an empty day is the 150 notch');
      assert.ok(m.empty, 'and it says that nothing waits');
      assert.match(m.empty, /Todavía no hay resultados|Nada espera tu sí/, m.empty);
      await r.page.locator('#island').screenshot({ path: path.join(SHOTS, 'hoy-vacio.png') });
    } finally { await r.close(); }
  }

  // 5 · the pager still works from Hoy: leaving closes it and the island goes back to the flat notch
  {
    const r = await H.open({ hoy: DAY, hoyTab: true });
    try {
      verify('before-leaving', await measure(r.page));
      // the notch hides the legacy .tabs row (HU-057): the real way out is the pager dot, which stays under Hoy
      await r.page.click('#nusa-tab-inicio');
      await r.page.waitForTimeout(600);
      const m = await measure(r.page);
      assert.equal(m.shown, false, 'Hoy closes when the pager leaves for Inicio');
      assert.equal(Math.round(m.island.h), 150, 'the notch is 150 again');
      const pressed = await r.page.getAttribute('#open-hoy', 'aria-pressed');
      assert.equal(pressed, 'false', 'and its tab says so');
    } finally { await r.close(); }
  }

  console.log(`island-hoy-visual-check: ok (screenshots in ${SHOTS})`);
})().catch(e => { console.error(e); process.exit(1); });
