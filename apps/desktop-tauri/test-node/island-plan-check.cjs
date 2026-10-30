'use strict';
/* S10 (L30) — plan usage in the island: the vendored Coucou plan logic + pills/card, fed by Abito's plan_action.
   Pure parts run for real; the pill/card DOM runs on a minimal fake DOM. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const frontend = path.join(__dirname, '..', 'frontend');
const vendor = path.join(frontend, 'vendor/coucou');
const P = require(path.join(frontend, 'island-plan.js'));
const imp = f => import(pathToFileURL(path.join(vendor, f)));

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.style = { _p: {}, setProperty(k, v) { this._p[k] = v; }, width: '', background: '' };
    this.classList = { toggle: (c, on) => { const s = new Set(this.className.split(' ').filter(Boolean)); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' '); }, contains: c => this.className.split(' ').includes(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...n) { for (const c of n) this.children.push(typeof c === 'string' ? { text: c } : c); }
  get firstChild() { return this.children[0] || null; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
  click() { for (const f of this.listeners.click || []) f({ target: this }); }
}
const all = e => [e, ...(e.children || []).flatMap(all)];
const text = e => all(e).map(x => x.textContent || x.text || '').join('|');
const cls = (e, c) => all(e).filter(x => (x.className || '').split(' ').includes(c));

(async () => {
  // ---- the plan logic (Coucou core/plan.ts, vendored) ----------------------------------------------------------
  const plan = await imp('core/plan.js');
  const now = Date.now(); // the pill reads the real clock by default, so the fixtures are relative to it
  const w = (pct, minsLeft) => ({ usedPct: pct, resetsAt: now + minsLeft * 60000 });
  assert.equal(plan.planColor(10), '#22C55E'); assert.equal(plan.planColor(60), '#F59E0B'); assert.equal(plan.planColor(95), '#F4505E'); assert.equal(plan.planColor(null), '#6B7079');
  assert.equal(plan.dominantPct({ updatedAt: now, fiveHour: w(30, 60), sevenDay: w(72, 5000) }, now), 72);
  assert.equal(plan.dominantPct({ updatedAt: now, fiveHour: { usedPct: 90, resetsAt: now - 1 } }, now), 0, 'a window past its reset reads 0');
  assert.equal(plan.dominantPct(null, now), null);
  assert.equal(plan.pillLabel('Claude', { updatedAt: now, fiveHour: w(72.4, 60) }, now), 'Claude 72%');
  assert.equal(plan.pillLabel('Claude', null, now), 'Claude —', 'no numbers: a dash, never a guess');
  assert.equal(plan.resetLabel(w(1, 80), false, now), 'en 1 h 20');
  assert.equal(plan.resetLabel(w(1, 5), false, now), 'en 5 min');
  assert.equal(plan.resetLabel({ usedPct: 1, resetsAt: now - 5 }, false, now), 'Reiniciando…');
  assert.equal(plan.ageLabel(now - 30000, now), 'ahora mismo'); assert.equal(plan.ageLabel(now - 12 * 60000, now), 'hace 12 min'); assert.equal(plan.ageLabel(now - 3 * 3600000, now), 'hace 3 h');
  assert.equal(plan.claudeSubtitle(null, now), 'Esperando una respuesta de Claude Code');
  assert.equal(plan.codexSubtitle(null, now), 'Consultando a Codex…');
  const codex = plan.parseCodexPlan({ rateLimits: { planType: 'plus', primary: { usedPercent: 12, resetsAt: Math.floor(now / 1000) + 3600, windowDurationMins: 300 }, secondary: { usedPercent: 40, resetsAt: Math.floor(now / 1000) + 86400 * 3, windowDurationMins: 10080 } }, rateLimitResetCredits: { availableCount: 2, credits: [{ status: 'available', expiresAt: Math.floor(now / 1000) + 86400 }] } }, now);
  assert.equal(codex.fiveHour.usedPct, 12); assert.equal(codex.sevenDay.usedPct, 40); assert.equal(codex.resetCredits, 2); assert.equal(codex.planType, 'plus');
  assert.match(plan.codexResetsLabel(codex), /^2 disponibles · hasta \d+ \w+$/);
  assert.equal(plan.codexResetsLabel(null), '—');
  assert.equal(plan.parseCodexPlan({ rateLimits: {} }, now), null);
  assert.equal(plan.parseCodexPlan(null, now), null);

  // ---- Abito's feed: pillsView / claudeUsage / onOverview -----------------------------------------------------
  assert.deepEqual(P.pillsView(null), { claude: false, codex: false });
  assert.deepEqual(P.pillsView({}), { claude: false, codex: false }, 'absent = off');
  for (const v of ['yes', 1, null, [], {}]) assert.equal(P.pillsView({ showPlanInNotch: v }).claude, false, JSON.stringify(v));
  assert.deepEqual(P.pillsView({ showPlanInNotch: true }), { claude: true, codex: false });
  assert.equal(P.pillsView({ showCodexPlanInNotch: true }).codex, true);
  assert.equal(P.claudeUsage({ available: false }), null, 'unavailable: no numbers');
  assert.equal(P.claudeUsage(null), null); assert.equal(P.claudeUsage('x'), null); assert.equal(P.claudeUsage([]), null);
  assert.equal(P.claudeUsage({ available: true, updatedAt: 5 }), null, 'available but no window: nothing');
  assert.deepEqual(P.claudeUsage({ available: true, updatedAt: 5, fiveHour: { usedPct: 12, resetsAt: 9 }, extra: 1 }), { updatedAt: 5, fiveHour: { usedPct: 12, resetsAt: 9 } });
  assert.deepEqual(P.claudeUsage({ available: true, updatedAt: 5, sevenDay: { usedPct: 100, resetsAt: 9 } }), { updatedAt: 5, sevenDay: { usedPct: 100, resetsAt: 9 } });
  for (const bad of [{ usedPct: -1, resetsAt: 9 }, { usedPct: 101, resetsAt: 9 }, { usedPct: NaN, resetsAt: 9 }, { usedPct: '5', resetsAt: 9 }, { usedPct: 5, resetsAt: 0 }, { usedPct: 5 }]) {
    assert.equal(P.claudeUsage({ available: true, updatedAt: 5, fiveHour: bad }), null, JSON.stringify(bad));
  }
  assert.equal(P.onOverview({ phase: 'expanded', view: 'overview' }), true);
  for (const d of [{ phase: 'compact', view: 'overview' }, { phase: 'expanded', view: 'chat' }, { phase: 'expanded', view: 'overview', card: 'pending' }, { phase: 'expanded', view: 'overview', question: 'pending' }, { phase: 'expanded', view: 'notices', noticeView: 'notices' }, { phase: 'expanded', view: 'overview', settings: 'open' }, null])
    assert.equal(P.onOverview(d), false, JSON.stringify(d));

  // ---- Coucou's pill and card on a fake DOM -------------------------------------------------------------------
  global.document = { createElement: t => new El(t), createElementNS: (ns, t) => new El(t), createTextNode: s => ({ text: s }) };
  global.window = {};
  const view = await imp('views/usage.js');
  const m = view.newPlanModel();
  let toggled = 0;
  const pill = view.buildPlanPill(m, false, () => { toggled++; });
  pill.sync();
  assert.match(text(pill.el), /Claude —/, 'no numbers yet: a dash');
  m.planUsage = { updatedAt: now, fiveHour: w(72, 60), sevenDay: w(30, 5000) };
  pill.sync();
  assert.match(text(pill.el), /Claude 72%/);
  assert.equal(pill.el.style._p['--plan'], '#F59E0B', 'orange between 50 and 80');
  pill.el.click();
  assert.equal(m.showingPlanDetail, true); assert.equal(m.planDetailIsCodex, false); assert.equal(toggled, 1);
  pill.sync(); assert.ok(pill.el.classList.contains('active'));
  pill.el.click(); assert.equal(m.showingPlanDetail, false, 'a second click closes it');

  const card = new view.PlanCard(m);
  m.showingPlanDetail = true; card.sync(now);
  const t = text(card.el);
  assert.match(t, /Plan de Claude/); assert.match(t, /5 horas/); assert.match(t, /Semana/); assert.match(t, /72%/); assert.match(t, /30%/); assert.match(t, /en (1 h 0|59 min)/);
  assert.equal(cls(card.el, 'plan-fill').length, 2);
  const fills = cls(card.el, 'plan-fill'); assert.equal(fills[0].style.width, '72%'); assert.equal(fills[1].style.width, '30%');
  // unavailable / one window: a dash in the missing row, no invented bar
  m.planUsage = { updatedAt: now, fiveHour: w(10, 30) }; card.sync(now + 30000 * 2);
  assert.equal(cls(card.el, 'plan-fill').length, 1); assert.equal(cls(card.el, 'plan-none').length, 1); assert.match(text(card.el), /—/);
  m.planUsage = null; card.sync(now + 60000 * 3);
  assert.equal(cls(card.el, 'plan-fill').length, 0); assert.match(text(card.el), /Esperando una respuesta de Claude Code/);
  m.planDetailIsCodex = true; m.codexPlanUsage = codex; card.sync(now + 60000 * 4);
  assert.match(text(card.el), /Plan de Codex/); assert.match(text(card.el), /Reinicios/); assert.match(text(card.el), /2 disponibles/);
  assert.equal(view.openPlanColor(m), plan.planColor(plan.dominantPct(codex)));

  // ---- wiring contracts (source level; the browser mount cannot run here) ------------------------------------
  const src = fs.readFileSync(path.join(frontend, 'island-plan.js'), 'utf8');
  assert.match(src, /plan_action', \{ payload: \{ action: 'claude' \} \}/);
  assert.match(src, /plan_action', \{ payload: \{ action: 'codex' \} \}/);
  assert.match(src, /want\.codex && visible/, 'Codex only when its pref is literally on');
  assert.match(src, /label === 'settings'\) return/, 'inert in the settings window');
  assert.doesNotMatch(src, /innerHTML/);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="island-plan\.js"/g) || []).length, 1);
  assert.ok(html.indexOf('src="island-header.js"') < html.indexOf('src="island-plan.js"'));
  const css = fs.readFileSync(path.join(vendor, 'island/island.css'), 'utf8');
  assert.match(css, /\.plan-pills \{ display: none;/); assert.match(css, /\.plan-bar \{ flex: 0 0 50px; height: 4px;/);
  assert.match(css, /\.header-actions \.plan-pill::after \{[^}]*inset: -12px -2px/, '44px hit around the 20px pill');
  console.log('PASS island-plan');
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
