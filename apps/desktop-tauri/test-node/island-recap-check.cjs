'use strict';
/* S10 (L30) — the weekly recap card of the island: vendored Coucou summary + card fed by Abito's recap_action answers.
   Pure parts run for real; the card DOM runs on a minimal fake DOM. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const frontend = path.join(__dirname, '..', 'frontend');
const vendor = path.join(frontend, 'vendor/coucou');
const R = require(path.join(frontend, 'island-recap.js'));
const imp = f => import(pathToFileURL(path.join(vendor, f)));

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.disabled = false; this.title = ''; this.style = { _p: {}, setProperty(k, v) { this._p[k] = v; } };
    this.classList = { contains: c => this.className.split(' ').includes(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...n) { for (const c of n) this.children.push(typeof c === 'string' ? { text: c } : c); }
  get firstChild() { return this.children[0] || null; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
  click() { if (!this.disabled) for (const f of this.listeners.click || []) f({ target: this }); }
}
const all = e => [e, ...(e.children || []).flatMap(all)];
const text = e => all(e).map(x => x.textContent || x.text || '').join('|');
const cls = (e, c) => all(e).filter(x => (x.className || '').split(' ').includes(c));

(async () => {
  // ---- Abito's feed ------------------------------------------------------------------------------------
  assert.deepEqual(R.prefsView({ enabled: true, lastShownWeek: '' }), { enabled: true, lastShownWeek: '' });
  assert.deepEqual(R.prefsView({ enabled: true, lastShownWeek: '2026-10-12' }), { enabled: true, lastShownWeek: '2026-10-12' });
  for (const bad of [null, [], 'x', { enabled: false, lastShownWeek: '' }, { enabled: 'yes', lastShownWeek: '' }, { enabled: true }, { enabled: true, lastShownWeek: 'monday' }, { enabled: true, lastShownWeek: 5 }])
    assert.deepEqual(R.prefsView(bad), { enabled: false, lastShownWeek: '' }, 'off-shape = never auto-opens: ' + JSON.stringify(bad));
  const turn = (over = {}) => ({ agent: 'integration_claude', project: 'abito', start: 1000, end: 4600, filesChanged: 2, linesAdded: 10, linesRemoved: 1, commandsRun: 3, questions: 1, ...over });
  const h = R.historyView({ turns: [turn(), turn({ start: 'x' }), { nope: 1 }, turn({ filesChanged: -1 })], decisions: [{ agent: 'a', date: 1, decision: 'allow' }, { agent: 'a' }], prefs: { enabled: true, lastShownWeek: '' } });
  assert.equal(h.turns.length, 1, 'rows off-shape are dropped, never repaired'); assert.equal(h.decisions.length, 1); assert.equal(h.prefs.enabled, true);
  for (const bad of [null, [], {}, { turns: 'x', decisions: [] }, { turns: [] }]) assert.equal(R.historyView(bad), null);
  assert.equal(R.calm({ phase: 'expanded', view: 'overview' }), true);
  for (const d of [null, { phase: 'compact', view: 'overview' }, { phase: 'expanded', view: 'chat' }, { phase: 'expanded', view: 'overview', card: 'pending' }, { phase: 'expanded', view: 'overview', question: 'pending' }, { phase: 'expanded', view: 'overview', settings: 'open' }, { phase: 'expanded', view: 'notices', noticeView: 'notices' }])
    assert.equal(R.calm(d), false, JSON.stringify(d));
  assert.equal(R.SHOW_DELAY_MS, 1500);

  // ---- Coucou's summary logic (vendored) ---------------------------------------------------------------
  const S = await imp('recap/summary.js');
  const monday = new Date(2026, 9, 12); // Mon 12 Oct 2026, local
  assert.equal(S.mondayOf(new Date(2026, 9, 18)).getDate(), 12, 'Sunday belongs to the week that started Monday');
  assert.equal(S.dayKey(S.previousWeekStart(new Date(2026, 9, 19, 9))), '2026-10-12');
  assert.equal(S.shouldAutoShow(new Date(2026, 9, 19, 8, 0), ''), true);
  assert.equal(S.shouldAutoShow(new Date(2026, 9, 19, 7, 59), ''), false, 'before 8 am');
  assert.equal(S.shouldAutoShow(new Date(2026, 9, 20, 9), ''), false, 'only Mondays');
  assert.equal(S.shouldAutoShow(new Date(2026, 9, 19, 9), '2026-10-19'), false, 'once per week');
  const at = (d, hh, mm = 0) => Math.floor(new Date(2026, 9, 12 + d, hh, mm).getTime() / 1000);
  const hist = { turns: [turn({ start: at(0, 9), end: at(0, 11, 30), project: 'abito', filesChanged: 8, linesAdded: 300, linesRemoved: 80, commandsRun: 14, questions: 2 }), turn({ start: at(2, 10), end: at(2, 12), project: 'abito', filesChanged: 3, linesAdded: 100, linesRemoved: 20, commandsRun: 5, questions: 0 }), turn({ agent: 'agent_codex', project: 'other', start: at(2, 13), end: at(2, 13, 30), filesChanged: 1, linesAdded: 5, linesRemoved: 0, commandsRun: 0, questions: 0 })],
    decisions: [{ agent: 'a', date: at(0, 9, 30), decision: 'allow' }, { agent: 'a', date: at(0, 10), decision: 'always' }, { agent: 'a', date: at(2, 10), decision: 'deny' }], prefs: { enabled: true, lastShownWeek: '' } };
  const sum = S.summarize(hist, monday);
  assert.deepEqual([sum.sessionCount, sum.filesChanged, sum.linesAdded, sum.linesRemoved, sum.commandsRun, sum.questions], [3, 12, 405, 100, 19, 2]);
  assert.deepEqual([sum.permissionsAllowed, sum.permissionsDenied], [2, 1]);
  assert.equal(sum.totalMinutes, 150 + 120 + 30); assert.equal(sum.topAgent, 'Claude Code'); assert.equal(sum.topProject, 'abito'); assert.equal(sum.longestSessionMinutes, 150);
  assert.equal(S.summarize({ turns: [], decisions: [], prefs: {} }, monday), null, 'an empty week has no summary');
  assert.equal(S.summarize(hist, new Date(2026, 9, 5)), null, 'a week with no turns in range');
  assert.equal(S.formatDuration(45), '45 min'); assert.equal(S.formatDuration(120), '2 h'); assert.equal(S.formatDuration(135), '2 h 15 min');
  assert.equal(S.formatCount(1234), '1,234'); assert.equal(S.formatCount(12345), '12.3k');
  assert.equal(S.weekRangeLabel(sum), '12 oct – 18 oct');

  // ---- Coucou's card on a fake DOM ----------------------------------------------------------------------
  global.document = { createElement: t => new El(t), createElementNS: (ns, t) => new El(t), createTextNode: s => ({ text: s }) };
  global.window = {};
  const view = await imp('views/recap.js');
  let oks = 0;
  const card = view.buildRecapCard(sum, () => { oks++; });
  const t = text(card);
  assert.match(t, /Resumen semanal/); assert.match(t, /12 oct – 18 oct/); assert.match(t, /5 h/); assert.match(t, /3\|sesiones/); assert.match(t, /\+405 \/ −100/); assert.match(t, /Agente principal\|Claude Code/);
  assert.match(t, /Proyecto principal\|abito/); assert.match(t, /Día más activo\|(lunes|miércoles)/); assert.match(t, /2 permitidos, 1 denegados/); assert.match(t, /Preguntas\|2/);
  assert.equal(card.style._p['--wash'], 'rgba(99,102,241,0.5)', 'indigo wash');
  const btns = all(card).filter(x => x.tagName === 'button');
  assert.equal(btns.length, 2);
  assert.equal(btns[0].disabled, true, 'the share image is honest about not existing'); assert.match(btns[0].title, /no está disponible/);
  btns[0].click(); assert.equal(oks, 0, 'a disabled share button does nothing');
  btns[1].click(); assert.equal(oks, 1, 'OK closes');
  const empty = view.buildRecapCard(null, () => { oks++; });
  assert.match(text(empty), /Sin actividad la semana pasada/); assert.equal(all(empty).filter(x => x.tagName === 'button').length, 1);
  all(empty).filter(x => x.tagName === 'button')[0].click(); assert.equal(oks, 2);

  // ---- wiring (source level; the browser mount cannot run here) -----------------------------------------
  const src = fs.readFileSync(path.join(frontend, 'island-recap.js'), 'utf8');
  assert.match(src, /send\(\{ action: 'prefs' \}\)/); assert.match(src, /action: 'view', since:/); assert.match(src, /send\(\{ action: 'mark_shown', week \}\)/);
  assert.match(src, /label === 'settings'\) return/); assert.doesNotMatch(src, /innerHTML/);
  assert.doesNotMatch(src, /desktop\.expand|window\.desktop/, 'the recap never wakes or expands the island by itself');
  assert.doesNotMatch(src, /save_png|reveal_saved|set_enabled|clear/, 'only the read verbs and mark_shown');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="island-recap\.js"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(vendor, 'island/island.css'), 'utf8');
  assert.match(css, /\.recap-chip \.v \{ font: 700 17px var\(--font\)/); assert.match(css, /#recap-card \.btn::after \{[^}]*inset: 7px 0/);
  // L32: Coucou's recap view is 184 high; the card asks island.js for that island and gives it back on close
  const island = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(island, /const RECAP_H = 208;/);
  // HU-057 (odd/tasks/isla-nusa.md): the height expression grew cardH / fitFinished, so the old source regex on it was a design fossil. The invariant
  // («the recap card asks island.js for the RECAP height and gives the overview height back on close») is asserted BEHAVIOURALLY below, on the real
  // island in a real browser: the card's own event, then the measured #island box.
  assert.match(island, /document\.addEventListener\('abito:recap'/); assert.match(src, /new CustomEvent\('abito:recap', \{ detail: \{ show \} \}\)/);
  assert.match(css, /#recap-card \{[^}]*height: 156px; z-index: 3;/, 'the card sits under the character (z 4)');
  const H = require('./island-geometry-harness.cjs');
  if (!H.findPlaywright()) { console.log('SKIPPED island-recap-check (real-layout part): no playwright — NOT a pass'); return; }
  const ui = await H.open({ quick: true, sessions: [] });
  try {
    const islandH = async () => (await ui.measure('#island'))[0];
    const recap = async show => { await ui.page.evaluate(show => document.dispatchEvent(new CustomEvent('abito:recap', { detail: { show } })), show); await ui.page.waitForTimeout(1500); };
    const before = await islandH();
    assert.ok(before.shown && Math.abs(before.h - 150) <= 1 && Math.abs(before.w - 720) <= 1, 'HU-057 overview notch is 720x150 before the recap: ' + JSON.stringify(before));
    await recap(true);
    const open = await islandH();
    assert.ok(Math.abs(open.h - 208) <= 1, 'recap open: the island grows to RECAP_H (208), measured ' + open.h);
    assert.ok(Math.abs(open.w - 720) <= 1, 'recap keeps the 720 width, measured ' + open.w);
    await recap(false);
    const after = await islandH();
    assert.ok(Math.abs(after.h - before.h) <= 1, 'recap closed: the island gives the overview height back (' + before.h + '), measured ' + after.h);
  } finally { await ui.close(); }
  console.log('PASS island-recap');
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
