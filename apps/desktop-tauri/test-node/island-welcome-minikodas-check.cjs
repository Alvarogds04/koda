'use strict';
/* welcome-minikodas (odd/tasks/welcome-minikodas.md S1-S3, S6; artboard design/koda-bienvenida/10-koda-botones-a-los-lados.html, comment m8eankv9):
   with apps connected the Inicio is three columns: the actions (Chat, Agentes, Avisos) on the LEFT, Koda centred with its state text, and the apps /
   minikodas on the RIGHT, at most 5 per row, every row centred in the right column; more than 5 wraps to a new centred row and the island grows 70 per
   extra row up to a ceiling of 290. Real layout, real clicks. Cards are registered from the page (the same contract gmail/github/calendar use). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-welcome-minikodas-check: no playwright — NOT a pass'); process.exit(0); }
const NAMES = ['Correo', 'GitHub', 'Agenda', 'Noticias', 'Gastos', 'Diario', 'Fotos', 'Notas', 'Clima', 'Bolsa', 'Podcast', 'Viajes', 'Recetas', 'Tareas', 'Libros', 'Musica'];
async function register(r, n, from) {
  await r.page.evaluate(({ names }) => { names.forEach((label, i) => { window.AbitoShortcuts.registerCard({ id: 'fx' + label.toLowerCase(), label, icon: 'mail', available: () => true, mount: () => () => {} }); }); }, { names: NAMES.slice(from, from + n) });
  await r.page.waitForTimeout(700);
}
const read = r => r.page.evaluate(() => {
  const box = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 }; };
  const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'), isl = document.getElementById('island'), nav = document.getElementById('nusa-apps');
  const apps = nav ? [...nav.querySelectorAll('button:not(.talk)')].filter(b => getComputedStyle(b).display !== 'none').map(b => ({ ...box(b), label: b.getAttribute('data-tip') || b.getAttribute('title') })) : [];
  const dock = [...document.querySelectorAll('#nusa-panel .nusa-dock button')].map(b => ({ ...box(b), label: b.getAttribute('aria-label') }));
  return { apps, dock, koda: k && box(k), island: box(isl), ih: Math.round(isl.getBoundingClientRect().height), apps2: document.getElementById('nusa').dataset.apps };
});
const tracks = cols => String(cols).trim().split(/\s+/).length; // 3 = the three-column Inicio, 2 = the usual body + Koda column
const rowsOf = apps => { const m = new Map(); for (const a of apps) { const k = Math.round(a.cy); m.set(k, [...(m.get(k) || []), a]); } return [...m.entries()].sort((x, y) => x[0] - y[0]).map(e => e[1]); };
(async () => {
  const r = await H.open({ sessions: [], engine: 'ok' });
  try {
    await r.page.waitForTimeout(500);
    await register(r, 3, 0);
    let m = await read(r);
    assert.equal(m.apps2, 'true', 'apps connected: the row is on');
    assert.equal(m.apps.length, 3, 'three minikodas drawn: ' + JSON.stringify(m.apps.map(a => a.label)));
    const kx = (m.island.l + m.island.r) / 2;
    assert.ok(Math.abs(m.koda.cx - kx) <= 3, `Koda stays centred ${m.koda.cx} vs ${kx}`);
    for (const a of m.apps) assert.ok(a.l > m.koda.r + 8, `S1: «${a.label}» is on the RIGHT of Koda (${a.l} vs ${m.koda.r})`);
    assert.deepEqual(m.dock.map(d => d.label), ['Conversar con Koda', 'Agentes', 'Avisos'], 'S2: the three actions stay');
    for (const d of m.dock) assert.ok(d.r < m.koda.l - 8, `S2: «${d.label}» is on the LEFT of Koda (${d.r} vs ${m.koda.l})`);
    assert.equal(rowsOf(m.apps).length, 1, 'three fit one row');
    assert.equal(m.ih, 150, 'S3: one row keeps the notch at 150');
    for (const a of m.apps) assert.ok(a.r <= m.island.r - 8 && a.b <= m.island.b, 'inside the island: ' + JSON.stringify(a));
    // 8 → two rows, 5 + 3, each centred on the same column; the island grows by 70
    await register(r, 5, 3); m = await read(r);
    let rows = rowsOf(m.apps); assert.deepEqual(rows.map(x => x.length), [5, 3], 'S1: 8 minikodas are 5 + 3: ' + JSON.stringify(rows.map(x => x.length)));
    const cxs = rows.map(x => (Math.min(...x.map(a => a.l)) + Math.max(...x.map(a => a.r))) / 2);
    assert.ok(Math.abs(cxs[0] - cxs[1]) <= 2, 'S1: every row is centred on the same column ' + JSON.stringify(cxs));
    assert.equal(m.ih, 220, 'S3: two rows → 220');
    assert.ok(Math.abs(m.koda.cx - kx) <= 3, 'Koda still centred with two rows');
    // 14 → three rows (5+5+4), the ceiling 290; more is capped, never taller
    await register(r, 6, 8); m = await read(r);
    rows = rowsOf(m.apps); assert.deepEqual(rows.map(x => x.length), [5, 5, 4], 'three rows: ' + JSON.stringify(rows.map(x => x.length)));
    assert.equal(m.ih, 290, 'S3: three rows → 290, the ceiling');
    await register(r, 2, 14); m = await read(r);
    rows = rowsOf(m.apps); assert.ok(rows.length <= 3 && rows.every(x => x.length <= 5), 'S6: never more than 3 rows of 5 (the last slot becomes «+N más»)');
    assert.equal(m.ih, 290, 'S3: never taller than the ceiling');
    assert.ok(m.apps.some(a => /más/.test(a.label)), 'S6: the overflow is one «+N más» disc: ' + JSON.stringify(m.apps.map(a => a.label)));
    const fit = await r.page.evaluate(() => { const i = document.getElementById('island').getBoundingClientRect(); return [...document.querySelectorAll('#nusa-apps button')].every(b => { const x = b.getBoundingClientRect(); return x.bottom <= i.bottom && x.right <= i.right; }); });
    assert.ok(fit, 'every disc stays inside the island at the ceiling');
  } finally { await r.close(); }
  // review R4-001: the three-column grid must NOT apply with a card up or a question waiting. A pending question also carries data-takeover=waiting (the older
  // exclusion), so it guards the scope; the data-card exclusion is pinned by setting the attribute and reading the grid in the SAME task (nothing can repaint it).
  const q = await H.open({ question: 'plain', sessions: [], engine: 'ok' });
  try {
    await q.page.waitForTimeout(600); await register(q, 8, 0); await q.page.waitForTimeout(500);
    const st = await q.page.evaluate(() => ({ q: document.getElementById('capsule').dataset.question || '', cols: getComputedStyle(document.getElementById('nusa-body')).gridTemplateColumns, rows: document.getElementById('capsule').dataset.appRows || null }));
    assert.equal(st.q, 'pending', 'a question is waiting: ' + JSON.stringify(st));
    assert.equal(tracks(st.cols), 2, 'a pending question does NOT get the three-column grid: ' + JSON.stringify(st));
    assert.equal(st.rows, null, 'the island does not grow rows behind a question: ' + JSON.stringify(st));
  } finally { await q.close(); }
  const c = await H.open({ sessions: [], engine: 'ok' });
  try {
    await c.page.waitForTimeout(500); await register(c, 3, 0);
    const both = await c.page.evaluate(() => { const cap = document.getElementById('capsule'), cols = () => getComputedStyle(document.getElementById('nusa-body')).gridTemplateColumns;
      const before = cols(); cap.dataset.card = 'github'; const withCard = cols(); delete cap.dataset.card; return { before, withCard }; });
    assert.equal(tracks(both.before), 3, 'plain Inicio with apps IS the three-column grid: ' + JSON.stringify(both));
    assert.equal(tracks(both.withCard), 2, 'R4-001: with a card up (data-card) the three-column grid does NOT apply: ' + JSON.stringify(both));
  } finally { await c.close(); }
  console.log('island-welcome-minikodas-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
