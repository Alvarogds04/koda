'use strict';
/* S10 (L30) — the GitHub card of the island: vendored Coucou logic and views fed by Abito's github_action answers.
   Pure parts run for real; the card DOM runs on a minimal fake DOM. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const frontend = path.join(__dirname, '..', 'frontend');
const vendor = path.join(frontend, 'vendor/coucou');
const G = require(path.join(frontend, 'island-github.js'));
const imp = f => import(pathToFileURL(path.join(vendor, f)));

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.style = { setProperty() {}, _s: {} };
    this.classList = { toggle: (c, on) => { const s = new Set(this.className.split(' ').filter(Boolean)); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' '); }, contains: c => this.className.split(' ').includes(c), add: c => { this.className += ' ' + c; } }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...n) { for (const c of n) this.children.push(typeof c === 'string' ? { text: c } : c); }
  addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
  click() { for (const f of this.listeners.click || []) f({ target: this }); }
  querySelector(sel) { return all(this).find(x => x !== this && (x.className || '').split(' ').includes(sel.replace(/^\./, ''))) || null; }
}
const all = e => [e, ...(e.children || []).flatMap(all)];
const text = e => all(e).map(x => x.textContent || x.text || '').join('|');
const cls = (e, c) => all(e).filter(x => (x.className || '').split(' ').includes(c));

(async () => {
  // ---- Abito's feed ----------------------------------------------------------------------------------------
  // the rule kept for when GitHub returns (abito-pausa: integrations are paused, so wanted() is false in this version)
  assert.equal(G.wantedIgnoringPause({ mainPill: 'integration_github' }), true);
  assert.equal(G.wantedIgnoringPause({ mainPill: 'integration_claude', declaredPills: ['integration_github'] }), true);
  for (const p of [null, {}, [], 'x', { mainPill: 'integration_claude' }, { declaredPills: 'integration_github' }, { declaredPills: ['integration_n8n'] }, { mainPill: ['integration_github'] }]) assert.equal(G.wantedIgnoringPause(p), false, JSON.stringify(p));
  assert.equal(G.wanted({ mainPill: 'integration_github' }), false, 'paused: no card, no polling');
  const pulse = { login: 'me', myPRs: [{ id: 'o/r#1', title: 'Fix', url: 'https://github.com/o/r/pull/1', repo: 'o/r', number: 1, isDraft: false, ci: 'failure', review: 'pending', headSha: null }, { id: 'o/r#2', title: 'Draft', url: 'https://github.com/o/r/pull/2', repo: 'o/r', number: 2, isDraft: true, ci: 'success', review: 'pending', headSha: null }],
    toReview: [{ id: 'o/x#9', title: 'Review me', url: 'https://github.com/o/x/pull/9', repo: 'o/x', number: 9, isDraft: false, ci: 'pending', review: 'pending', headSha: null }],
    mainCI: [{ repo: 'o/r', url: 'https://github.com/o/r', branch: 'main', ci: 'success', headSha: null }], fetchedAt: 1 };
  const act = { total: 1234, weeks: [[{ date: '2026-01-04', count: 3, level: 2, weekday: 0 }, { date: '2026-01-05', count: 0, level: 0, weekday: 1 }]], fetchedAt: 1 };
  assert.deepEqual(G.answerView({ available: true, fetched: true, pulse }, 'pulse'), { kind: 'pulse', data: pulse });
  assert.deepEqual(G.answerView({ available: true, activity: act }, 'activity'), { kind: 'activity', data: act });
  assert.equal(G.answerView({ available: false, reason: 'gh_not_installed' }, 'pulse').note, G.REASONS.gh_not_installed);
  assert.equal(G.answerView({ available: false, reason: 'gh_not_signed_in' }, 'pulse').note, G.REASONS.gh_not_signed_in);
  assert.equal(G.answerView({ available: false, reason: 'weird' }, 'pulse').note, G.REASONS.gh_bad_answer, 'an unknown reason is never echoed');
  for (const bad of [null, 'x', [], { available: 'yes' }, { available: true }, { available: true, pulse: { myPRs: [] } }, { available: true, pulse: { ...pulse, login: 5 } }, { available: true, pulse: { ...pulse, myPRs: 'x' } }])
    assert.equal(G.answerView(bad, 'pulse').kind, 'unavailable', JSON.stringify(bad));
  assert.equal(G.answerView({ available: true, activity: { weeks: [], total: 'x' } }, 'activity').kind, 'unavailable');
  assert.equal(G.safeUrl('https://github.com/o/r'), 'https://github.com/o/r');
  for (const bad of ['http://evil.com', 'https://github.com.evil.com/x', 'https://u:p@github.com/x', 'javascript:alert(1)', 'https://github.com/a b', '', null, 'https://api.github.com/x', 'https://github.com/' + 'a'.repeat(2000)]) assert.equal(G.safeUrl(bad), null, String(bad).slice(0, 40));

  assert.deepEqual(G.answerView({available:true, pulse, stats:{totalStars:18,totalRepos:23}}, 'pulse').stats, {totalStars:18,totalRepos:23});
  assert.deepEqual(G.navigateDetail('ArrowDown', null, 2), {selection:0});
  assert.deepEqual(G.navigateDetail('ArrowUp', 0, 2), {selection:1});
  assert.deepEqual(G.navigateDetail('Enter', 1, 2), {open:1});
  assert.deepEqual(G.navigateDetail('Escape', null, 0), {back:true});
  assert.equal(G.navigateDetail('Enter', null, 0), null);

  // ---- Coucou's logic (vendored) ---------------------------------------------------------------------------
  const core = await imp('core/github.js');
  assert.equal(core.myPRsValue(pulse.myPRs), '2 · 1 fallando');
  assert.equal(core.myPRsValue([]), '0');
  assert.deepEqual(core.mainCISummary(pulse.mainCI), { failing: false, color: '#22C55E', value: 'todo en verde' });
  assert.equal(core.mainCISummary([]).value, 'sin repos');
  assert.equal(core.worstCI(['success', 'pending', 'failure']), 'failure');
  assert.equal(core.formatCount(1234), '1.2k'); assert.equal(core.shortRepo('o/r'), 'r');
  assert.equal(core.contributionsLabel(0), 'Sin contribuciones'); assert.equal(core.contributionsLabel(1), '1 contribución'); assert.equal(core.contributionsLabel(5), '5 contribuciones');
  assert.equal(core.dayLabel('2026-01-05'), '5 ene');
  assert.equal(core.activityHeader(act, null, null), '1,234 el último año');
  assert.equal(core.safeGitHubUrl('https://github.com/o/r'), 'https://github.com/o/r'); assert.equal(core.safeGitHubUrl('https://example.com'), null);

  // ---- Coucou's card on a fake DOM -------------------------------------------------------------------------
  global.document = { createElement: t => new El(t), createElementNS: (ns, t) => new El(t), createTextNode: s => ({ text: s }) };
  global.window = {};
  const view = await imp('views/github.js');
  const opened = [], refreshed = [];
  view.hooks.openUrl = u => opened.push(u); view.hooks.refresh = s => refreshed.push(s);
  let details = 0;
  const card = view.githubPulseCard(pulse, null, act, () => { details++; });
  const t = text(card);
  // Design 16, option A: «GitHub · 2 PR · 1 revisión», then ONE row per PR with the CI state as icon + word and an explicit [Abrir]
  assert.match(t, /GitHub/); assert.match(t, /2 PR/); assert.match(t, /1 revisión/);
  assert.doesNotMatch(t, /Mis PRs|CI de la rama|todo en verde/, 'the metric/list mix of the old card is gone');
  const rows = cls(card, 'gh-row'); assert.equal(rows.length, 2, 'one row per own PR');
  assert.match(text(rows[0]), /r#1/); assert.match(text(rows[0]), /fallando/); assert.match(text(rows[1]), /pasando/); assert.match(text(rows[1]), /Borrador/);
  for (const r of rows) {
    assert.equal(cls(r, 'gh-ci').length, 1, 'a CI icon (shape, not only colour)');
    const open = cls(r, 'gh-open'); assert.equal(open.length, 1); assert.equal(open[0].tagName, 'button'); assert.match(text(open[0]), /^Abrir$/);
    assert.match(open[0].attrs['aria-label'], /^Abrir .+#\d+ en GitHub$/);
  }
  assert.notEqual(rows[0].tagName, 'button', 'the row is not itself a button: the action is the visible [Abrir]');
  cls(rows[0], 'gh-open')[0].click(); assert.deepEqual(opened, ['https://github.com/o/r/pull/1']);
  const noCI = view.githubPulseCard({ ...pulse, myPRs: [{ ...pulse.myPRs[0], ci: 'unknown' }] }, null, act, () => {});
  assert.match(text(cls(noCI, 'gh-row')[0]), /sin CI/, 'unknown CI says so in words');
  // the review count and the default-branch CI keep their detail lists
  cls(card, 'gh-review')[0].click(); assert.equal(details, 1); assert.deepEqual(refreshed, ['pulse'], 'opening a list asks the host again');
  const reviews = view.githubDetail(pulse, null, act, () => {});
  assert.equal(cls(reviews, 'gh-row').length, 1); assert.match(text(reviews), /x#9/); assert.match(text(reviews), /en curso/);
  assert.equal(cls(card, 'gh-ci-main').length, 1); assert.match(cls(card, 'gh-ci-main')[0].attrs['aria-label'], /CI de la rama: todo en verde/);
  cls(card, 'gh-ci-main')[0].click(); assert.equal(details, 2);
  const main = view.githubDetail(pulse, null, act, () => {});
  assert.equal(cls(main, 'gh-row').length, 1); assert.match(text(main), /main/); assert.match(text(main), /pasando/);
  cls(card, 'gh-spark')[0].click(); assert.deepEqual(refreshed, ['pulse', 'pulse', 'activity']);
  const grid = view.githubDetail(pulse, null, act, () => {});
  assert.ok(cls(grid, 'gh-grid').length === 1 && cls(grid, 'gh-cell').length >= 2);
  // the list is a bounded, internally scrolling box (max 4 rows) and never shows a row it cannot act on
  const five = { ...pulse, myPRs: Array.from({ length: 5 }, (_, i) => ({ ...pulse.myPRs[0], number: i + 1, id: 'o/r#' + (i + 1) })) };
  const big = view.githubPulseCard(five, null, act, () => {});
  assert.equal(cls(big, 'gh-list').length, 1);
  assert.equal(cls(big, 'gh-row').length, 4, 'design 16 A: at most 4 PR rows, the rest behind «Ver todas»');
  const all = cls(big, 'gh-all'); assert.equal(all.length, 1, 'a visible «Ver todas →» when there are more than 4');
  assert.match(text(all[0]), /Ver todas \(5\) →/); assert.equal(all[0].tagName, 'button');
  opened.length = 0; view.hooks.openUrl = u => opened.push(u); all[0].click();
  assert.deepEqual(opened, ['https://github.com/pulls?q=is%3Apr+is%3Aopen+author%3Ame'], 'it opens the full list on github.com (login URL-encoded)');
  assert.equal(cls(card, 'gh-all').length, 0, 'no «Ver todas» when everything is already shown');
  // the full title is reachable on hover / for assistive tech even when the row truncates it
  const longTitle = 'feat(telemetry): add local Pi sessions telemetry with a very long descriptive title that never fits one line';
  const lt = view.githubPulseCard({ ...pulse, myPRs: [{ ...pulse.myPRs[0], title: longTitle }] }, null, act, () => {});
  const titleEl = cls(lt, 'gh-title')[0]; assert.equal(titleEl.attrs.title, `r#1 ${longTitle}`, 'title attribute carries ref + full title');
  assert.equal(cls(lt, 'gh-row')[0].attrs.title, `r#1 ${longTitle}`);
  // validation v4: the tooltip must exist on EVERY element the pointer can land on inside a row (the text column, both lines, the ref and the
  // CI word, and the [Abrir] button), not only on the truncated span
  const target = `r#1 ${longTitle}`;
  for (const c of ['gh-text', 'gh-line1', 'gh-line2', 'gh-ref', 'gh-title', 'gh-word']) assert.equal(cls(lt, c)[0].attrs.title, target, `${c} carries the full title`);
  assert.equal(cls(lt, 'gh-open')[0].attrs.title, `Abrir r#1 en GitHub`, '[Abrir] says what it opens');
  view.hooks.openUrl = () => {}; // the page-level hook re-validates; the vendor view itself drops non-github urls
  const evil = { ...pulse, myPRs: [{ ...pulse.myPRs[0], url: 'https://evil.example/x' }] };
  const openedEvil = []; view.hooks.openUrl = u => openedEvil.push(u);
  cls(view.githubPulseCard(evil, null, act, () => {}), 'gh-open')[0].click(); assert.deepEqual(openedEvil, [], 'a non-GitHub link never reaches the host');
  assert.match(text(view.githubPulseCard({ ...pulse, myPRs: [] }, null, act, () => {})), /Nada por aquí/);
  // keyboard: rows are the children of .gh-list and Enter does what [Abrir] does
  const kb = view.githubPulseCard(pulse, null, act, () => {});
  assert.equal(view.listRows(kb).length, 2);
  opened.length = 0; view.hooks.openUrl = u => opened.push(u); view.openRow(view.listRows(kb)[1]); assert.deepEqual(opened, ['https://github.com/o/r/pull/2']);

  // ---- wiring (source level; the browser mount cannot run here) --------------------------------------------
  const src = fs.readFileSync(path.join(frontend, 'island-github.js'), 'utf8');
  assert.match(src, /github_action', \{ payload: \{ action: 'refresh', section \} \}/);
  assert.match(src, /invoke\('open_chat_url', \{ payload: \{ url: safe \} \}\)/, 'links go through the existing validated opener');
  assert.match(src, /label === 'settings'\) return/); assert.doesNotMatch(src, /innerHTML/);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="island-github\.js"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(vendor, 'island/island.css'), 'utf8');
  assert.match(css, /\.gh-row \{[^}]*min-height: 36px/, 'design 16 A: 36px rows');
  assert.match(css, /\.gh-list \{[^}]*max-height: 144px[^}]*overflow-y: auto/, 'at most 4 rows, then the list scrolls inside');
  assert.match(css, /\.gh-open \{[^}]*min-height: 28px/);
  console.log('PASS island-github');
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
