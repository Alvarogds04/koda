'use strict';
/* K2-11 S1/S3/S6 (design/k2-09-atajos/08-isla-unida.html F4/F4b) — the GitHub card of the island's shortcuts row
   (island-shortcuts.js, the part built by K2-09): the Coucou pulse inside one card — three tiles (Revisión pedida · Tus PR ·
   Issues, with mentions included) that open their list in the same card — fed ONLY by `github_action
   {action:'refresh', section:'pulse'|'activity'}` and shown only while that answer really is `available:true`
   (criterion 3: no token, no gh ⇒ no card, and never a sample row).
   Pure parts run for real; the card DOM runs on a minimal fake DOM.
   Run: node apps/desktop-tauri/test-node/island-github-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const frontend = path.join(__dirname, '..', 'frontend');
const vendor = path.join(frontend, 'vendor/coucou');
const G = require(path.join(frontend, 'island-github.js'));
const P = require(path.join(frontend, 'paused.js'));
const imp = f => import(pathToFileURL(path.join(vendor, f)));

// ── a minimal DOM: the renderer only creates elements, sets textContent and attributes ──────────────────────────
const all = e => [e, ...(e.children || []).flatMap(all)];
const text = e => e.childNodes.map(n => (typeof n === 'string' ? n : text(n))).join('|');
const cls = (e, c) => all(e).filter(x => (x.className || '').split(' ').includes(c));
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.attributes = new Map();
    this.className = ''; this.hidden = false; this.listeners = new Map(); this.style = { setProperty() {}, removeProperty() {} };
  }
  get children() { return this.childNodes.filter(n => typeof n !== 'string'); }
  set textContent(v) { this.childNodes = [String(v)]; }
  get textContent() { return text(this); }
  append(...nodes) { for (const n of nodes) this.childNodes.push(n); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { const v = this.attributes.get(k); return v === undefined ? null : v; }
  removeAttribute(k) { this.attributes.delete(k); if (k === 'hidden') this.hidden = false; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  click() { const fn = this.listeners.get('click'); if (fn) fn({ isTrusted: true, stopPropagation() {} }); }
}
const fakeDocument = () => ({ createElement: tag => new El(doc, tag), createElementNS: (_ns, tag) => new El(doc, tag) });
const doc = fakeDocument();

// ── the answer shape src/github.rs serialises ──────────────────────────────────────────────────────────────────
const pr = (o = {}) => ({ id: 'o/r#1', title: 'Fix', url: 'https://github.com/o/r/pull/1', repo: 'o/r', number: 1, isDraft: false, ci: 'failure', review: 'pending', headSha: null, ...o });
const issue = (o = {}) => ({ id: 'o/r#7', title: 'La isla tapa la barra', url: 'https://github.com/o/r/issues/7', repo: 'o/r', number: 7, reason: 'assigned', ...o });
const PULSE = {
  login: 'me',
  myPRs: [pr(), pr({ id: 'o/r#2', number: 2, title: 'Draft', url: 'https://github.com/o/r/pull/2', isDraft: true, ci: 'success' })],
  toReview: [pr({ id: 'o/x#9', number: 9, title: 'Review me', url: 'https://github.com/o/x/pull/9', repo: 'o/x', ci: 'pending' })],
  mainCI: [{ repo: 'o/r', url: 'https://github.com/o/r', branch: 'main', ci: 'success', headSha: null }],
  issues: [issue(), issue({ id: 'o/r#8', number: 8, title: 'Sonidos altos', url: 'https://github.com/o/r/issues/8', reason: 'mentioned' })],
  fetchedAt: 1,
};
const ACT = { total: 1234, weeks: [[{ date: '2026-01-04', count: 3, level: 2, weekday: 0 }, { date: '2026-01-05', count: 0, level: 0, weekday: 1 }]], fetchedAt: 1 };
const pulseOf = (o = {}) => ({ available: true, pulse: { ...PULSE, ...o } });

(async () => {
  let passed = 0;
  const test = (_name, fn) => { fn(); passed += 1; };
  const testAsync = async (_name, fn) => { await fn(); passed += 1; };

  // ---- the feed: closed answers only ----------------------------------------------------------
  test('answerView: a real pulse (with the issues of S1) is the only shape that shows the card', () => {
    assert.deepEqual(G.answerView(pulseOf(), 'pulse'), { kind: 'pulse', data: { ...PULSE } });
    assert.deepEqual(G.answerView({ available: true, activity: ACT }, 'activity'), { kind: 'activity', data: ACT });
    assert.deepEqual(G.answerView(pulseOf(), 'pulse').data.issues, PULSE.issues, 'S1: assigned issues and mentions ride in the pulse');
    for (const bad of [null, 'x', [], { available: 'yes' }, { available: true }, { available: true, pulse: { myPRs: [] } },
      { available: true, pulse: { ...PULSE, login: 5 } }, { available: true, pulse: { ...PULSE, myPRs: 'x' } },
      { available: true, pulse: { ...PULSE, issues: 'x' } }, { available: true, pulse: { ...PULSE, issues: undefined } }]) {
      assert.equal(G.answerView(bad, 'pulse').kind, 'unavailable', JSON.stringify(bad));
    }
  });

  test('answerView: every «no card» reason is one of ours, and an unknown one is never echoed', () => {
    assert.equal(G.answerView({ available: false, reason: 'gh_not_installed' }, 'pulse').note, G.REASONS.gh_not_installed);
    assert.equal(G.answerView({ available: false, reason: 'gh_not_signed_in' }, 'pulse').note, G.REASONS.gh_not_signed_in);
    assert.equal(G.answerView({ available: false, reason: 'weird' }, 'pulse').note, G.REASONS.gh_bad_answer);
    assert.equal(G.answerView({ available: false, reason: 'gh_not_installed' }, 'pulse').kind, 'unavailable');
    assert.equal(G.answerView({ available: true, activity: { weeks: [], total: 'x' } }, 'activity').kind, 'unavailable');
  });

  test('S3: the card is available only while the answer is available:true — no token and no gh means no card', () => {
    assert.equal(G.available(pulseOf()), true);
    for (const bad of [null, {}, { available: false, reason: 'gh_not_installed' }, { available: true }, { available: true, pulse: { myPRs: [] } }]) {
      assert.equal(G.available(bad), false, JSON.stringify(bad));
    }
    // K2-11 S6: GitHub left the pause of the 0.3 services and has its own entry, which is not paused in this version
    assert.equal(P.paused('github'), false);
    assert.equal(G.pausedNow(), false);
  });

  test('issues: only assigned/mentioned, closed fields, off-shape rows dropped (never rendered as another reason)', () => {
    const rows = G.issuesView(PULSE.issues);
    assert.deepEqual(rows.map(r => [r.ref, r.reason]), [['r#7', 'assigned'], ['r#8', 'mentioned']], 'the ref is the design\'s short repo#number');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['number', 'reason', 'ref', 'repo', 'title', 'url']);
    assert.deepEqual(G.issuesView([{ ...issue(), reason: 'starred' }, { ...issue(), number: 0 }, { ...issue(), url: 'https://evil.example/x' }]), []);
    assert.deepEqual(G.issuesView('x'), []);
  });

  test('safeUrl: only https github.com links leave the page', () => {
    assert.equal(G.safeUrl('https://github.com/o/r'), 'https://github.com/o/r');
    for (const bad of ['http://evil.com', 'https://github.com.evil.com/x', 'https://u:p@github.com/x', 'javascript:alert(1)', 'https://github.com/a b', '', null, 'https://api.github.com/x', 'https://github.com/' + 'a'.repeat(2000)]) {
      assert.equal(G.safeUrl(bad), null, String(bad).slice(0, 40));
    }
  });

  // F7: bidi overrides and separators are stripped like every other control character (a title comes from outside)
  const BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

  test('F7: hostile titles and refs lose their bidi controls, and the ref goes through the same cap', () => {
    // U+202E/U+2066/U+2069/U+200F/U+200E/FEFF/2028: the overrides and separators a title can carry from an outside invitation
    const hostile = 'Arreglar\u202E\u2066\u200F el \u2028login\uFEFF';
    const prRows = G.cardView({ pulse: { ...PULSE, myPRs: [pr({ title: hostile })] }, section: 'pr' }).rows;
    assert.doesNotMatch(prRows[0].title, BIDI, JSON.stringify(prRows[0].title));
    assert.match(prRows[0].title, /^Arreglar/);
    assert.match(prRows[0].title, /login$/);
    // the ref is repo + number, so a repo name can carry them too: same sanitiser, same length cap
    const issueRows = G.cardView({ pulse: { ...PULSE, issues: [issue({ title: 'ok', repo: 'o/r\u202Ex' })] }, section: 'issue' }).rows;
    assert.doesNotMatch(issueRows[0].ref, BIDI, JSON.stringify(issueRows[0].ref));
    assert.equal(issueRows[0].ref, 'r x#7');
    const long = G.issuesView([issue({ repo: 'o/' + 'p'.repeat(400) })]);
    assert.equal(long[0].ref.length, 200, 'the ref is capped like any other text');
    // the DOM only ever gets the sanitised strings
    const host = doc.createElement('div');
    G.render(host, G.cardView({ pulse: { ...PULSE, issues: [issue({ title: hostile })] }, section: 'issue' }), () => {});
    assert.doesNotMatch(text(host), BIDI);
    assert.doesNotMatch(host.children[0].children[1].children[0].getAttribute('title'), BIDI, 'the tooltip is sanitised too');
  });

  // ---- the pulse model of design 08 F4/F4b ---------------------------------------------------
  test('cardView: three tiles — Revisión pedida, Tus PR, Issues — with the counts the answer really has', () => {
    const v = G.cardView({ pulse: PULSE, stats: { totalStars: 18, totalRepos: 23 } });
    assert.equal(v.kind, 'pulse');
    assert.equal(v.login, 'me');
    assert.deepEqual(v.tiles.map(t => [t.key, t.label, t.count]), [['review', 'Revisión pedida', 1], ['pr', 'Tus PR', 2], ['issue', 'Issues', 2]]);
    assert.deepEqual(v.tiles.map(t => t.aria), [
      '1 revisión pedida. Ver la lista',
      '2 PR tuyas abiertas. Ver la lista',
      '2 issues asignadas o que te mencionan. Ver la lista',
    ]);
    const none = G.cardView({ pulse: { ...PULSE, myPRs: [], toReview: [], issues: [] } });
    assert.deepEqual(none.tiles.map(t => t.count), [0, 0, 0], 'zeros are shown as zeros, never hidden behind sample rows');
    assert.match(none.tiles[1].aria, /^0 PR/);
  });

  test('cardView: a tile opens ITS list in the same card, with «‹ Pulso» to come back', () => {
    const review = G.cardView({ pulse: PULSE, section: 'review' });
    assert.equal(review.kind, 'list');
    assert.equal(review.title, 'Revisión pedida · 1');
    assert.equal(review.back, '‹ Pulso');
    assert.deepEqual(review.rows.map(r => [r.ref, r.title, r.meta, r.url]), [['x#9', 'Review me', 'en curso', 'https://github.com/o/x/pull/9']]);
    const mine = G.cardView({ pulse: PULSE, section: 'pr' });
    assert.equal(mine.title, 'Tus PR · 2');
    assert.deepEqual(mine.rows.map(r => [r.ref, r.meta]), [['r#1', 'fallando'], ['r#2', 'borrador']], 'the CI state and the draft are words, not only colours');
    const issues = G.cardView({ pulse: PULSE, section: 'issue' });
    assert.equal(issues.title, 'Issues · 2');
    assert.deepEqual(issues.rows.map(r => [r.ref, r.title, r.meta]), [['r#7', 'La isla tapa la barra', 'asignada'], ['r#8', 'Sonidos altos', 'te mencionan']]);
    assert.deepEqual(G.cardView({ pulse: { ...PULSE, issues: [] }, section: 'issue' }).rows, []);
    assert.equal(G.cardView({ pulse: { ...PULSE, issues: [] }, section: 'issue' }).empty, true);
    assert.deepEqual(G.cardView({ pulse: PULSE, section: 'nope' }), null, 'a section that does not exist paints nothing');
  });

  test('cardView: every row carries the browser it opens, and only a GitHub link survives', () => {
    const v = G.cardView({ pulse: { ...PULSE, issues: [issue({ url: 'https://evil.example/x' })] }, section: 'issue' });
    assert.deepEqual(v.rows, [], 'a non-GitHub issue is never offered');
    for (const section of ['review', 'pr', 'issue']) {
      for (const row of G.cardView({ pulse: PULSE, section }).rows) {
        assert.match(row.url, /^https:\/\/github\.com\//);
        assert.equal(G.safeUrl(row.url), row.url);
        assert.match(row.aria, /^Abrir .+#\d+ en GitHub$/, 'the action says what it opens');
      }
    }
  });

  test('the contribution strip of the design: the last 14 days, levels only', () => {
    const days = Array.from({ length: 21 }, (_, i) => ({ date: '2026-01-' + String(i + 1).padStart(2, '0'), count: i % 5, level: i % 5, weekday: i % 7 }));
    const weeks = [days.slice(0, 7), days.slice(7, 14), days.slice(14)];
    const v = G.cardView({ pulse: PULSE, activity: { total: 30, weeks } });
    assert.equal(v.strip.length, G.STRIP_DAYS);
    assert.deepEqual(v.strip.slice(-2), [4, 0], 'the newest days are the last ones (Coucou lastDays)');
    for (const level of v.strip) assert.ok(Number.isInteger(level) && level >= 0 && level <= 4, String(level));
    assert.equal(v.activityLabel, 'contribuciones · 14 días');
    assert.deepEqual(G.cardView({ pulse: PULSE, activity: { weeks: [], total: 0 } }).strip, [], 'no activity, no strip: never a drawn guess');
    assert.deepEqual(G.stripView({ weeks: [[{ level: 9 }, { level: 'x' }, { level: 3 }]] }), [0, 0, 3], 'an unknown level is an empty day');
  });

  await testAsync('the CI words are Coucou’s own (one source, never a second vocabulary)', async () => {
    const core = await imp('core/github.js');
    for (const [ci, word] of Object.entries(G.CI_WORDS)) assert.equal(word, core.ciWord(ci) || 'sin CI', ci);
  });

  // ---- the card DOM ---------------------------------------------------------------------------
  test('render: tiles and rows are BUTTONS with textContent only; the row click never opens anything by itself', () => {
    const host = doc.createElement('div');
    const opened = [];
    G.render(host, G.cardView({ pulse: PULSE }), url => opened.push(url));
    assert.equal(host.hidden, false);
    const tiles = cls(host, 'gh-tile');
    assert.equal(tiles.length, 3);
    assert.deepEqual(tiles.map(t => t.getAttribute('data-tile')), ['review', 'pr', 'issue']);
    assert.deepEqual(tiles.map(t => t.getAttribute('aria-label')), G.cardView({ pulse: PULSE }).tiles.map(t => t.aria));
    for (const t of tiles) assert.equal(t.tagName, 'BUTTON');
    assert.match(text(host), /GitHub/);
    cls(host, 'gh-tile')[0].click();
    assert.deepEqual(opened, [], 'a tile asks for its list; it never opens a browser');

    const list = doc.createElement('div');
    G.render(list, G.cardView({ pulse: PULSE, section: 'issue' }), url => opened.push(url));
    const rows = cls(list, 'gh-row');
    assert.equal(rows.length, 2);
    assert.equal(cls(list, 'gh-back').length, 1, '「‹ Pulso」 comes back to the pulse');
    for (const r of rows) assert.equal(r.tagName, 'BUTTON');
    rows[0].click();
    assert.deepEqual(opened, ['https://github.com/o/r/issues/7'], 'clicking a row opens it in the browser');
    assert.equal(rows[0].getAttribute('title'), 'r#7 La isla tapa la barra');
    const empty = doc.createElement('div');
    G.render(empty, G.cardView({ pulse: { ...PULSE, issues: [] }, section: 'issue' }), () => {});
    assert.match(text(empty), /Nada por aquí/);
  });

  test('render: an unavailable answer paints nothing (S3: no invented row, no sample numbers)', () => {
    const host = doc.createElement('div');
    G.render(host, { kind: 'unavailable', note: G.REASONS.gh_not_installed }, () => {});
    assert.equal(host.hidden, true);
    assert.equal(text(host), '');
  });

  // ---- wiring (source level: the browser mount cannot run here) --------------------------------
  test('the wiring: one registered card, the closed host verb, the K2-01c opener, no innerHTML', () => {
    const src = fs.readFileSync(path.join(frontend, 'island-github.js'), 'utf8');
    assert.match(src, /registerCard\(\{/);
    assert.match(src, /id: 'github'/);
    assert.match(src, /icon: 'pr'/);
    assert.match(src, /invoke\('github_action', \{ payload: \{ action: 'refresh', section: sectionName \} \}\)/, 'the closed host verb, with the section it asks for');
    assert.match(src, /AbitoShortcuts\.refresh\(\)|shortcuts\.refresh\(\)/);
    assert.match(src, /invoke\('open_chat_url', \{ payload: \{ url: safe \} \}\)/, 'links go through the existing validated opener');
    assert.match(src, /label === 'settings'\) return/);
    assert.match(src, /paused\('github'\)/, 'the pause entry of K2-11 S6 is its own switch');
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    assert.equal(G.POLL_MS, 60000);
    const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
    assert.equal((html.match(/src="island-github\.js"/g) || []).length, 1);
  });

  // ---- the mount tail, sandboxed: register, poll, paint, pick a list, open the browser --------------------------
  const mounted = async answer => {
    const vm = require('node:vm');
    const registry = { card: null, refreshes: 0 };
    const calls = [];
    const state = { tick: null, paused: false };
    const page = { ...fakeDocument(), hidden: false, addEventListener: () => {} };
    const sandbox = {
      document: page,
      AbitoShortcuts: { registerCard: def => { registry.card = def; }, refresh: () => { registry.refreshes += 1; } },
      AbitoPaused: { paused: () => state.paused },
      setInterval: fn => { state.tick = fn; return 1; }, clearInterval: () => {}, addEventListener: () => {},
      URL, TextEncoder,
      // the host answer; a function builds a NEW object per poll, exactly as a real answer arrives
      __TAURI__: { core: { invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(typeof answer === 'function' ? answer(args) : answer); } } },
    };
    sandbox.window = sandbox; sandbox.self = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(frontend, 'island-github.js'), 'utf8'), sandbox, { filename: 'island-github.js' });
    for (let i = 0; i < 8; i += 1) await new Promise(r => setImmediate(r));
    return { page, registry, calls, state };
  };

  const ok = await mounted(pulseOf());
  assert.equal(ok.registry.card.id, 'github');
  assert.equal(ok.registry.card.label, 'GitHub');
  assert.equal(ok.registry.card.icon, 'pr');
  assert.equal(JSON.stringify(ok.calls.find(c => c.cmd === 'github_action').args), JSON.stringify({ payload: { action: 'refresh', section: 'pulse' } }));
  assert.equal(ok.registry.card.available(), true, 'a real available:true answer puts the icon in the row');
  assert.equal(ok.registry.card.badge(), 1, 'the row counter is the reviews that wait for me (design 08)');
  assert.ok(ok.registry.refreshes >= 1, 'and the row is repainted when that moves');
  const host = ok.page.createElement('div');
  const off = ok.registry.card.mount(host);
  assert.equal(cls(host, 'gh-tile').length, 3, 'the pulse is what the card shows first');
  cls(host, 'gh-tile')[2].click();
  assert.equal(cls(host, 'gh-row').length, 2, 'the Issues tile opens its own list in the same card');
  cls(host, 'gh-row')[1].click();
  const opened = ok.calls.filter(c => c.cmd === 'open_chat_url');
  assert.equal(opened.length, 1, 'a row opens the browser through the K2-01c opener');
  assert.equal(JSON.stringify(opened[0].args), JSON.stringify({ payload: { url: 'https://github.com/o/r/issues/8' } }));
  off();
  assert.equal(text(host), '', 'unmount leaves nothing behind');

  // S3: no card while the host answers «no» — and never a row built from a guess
  const no = await mounted({ available: false, reason: 'gh_not_installed' });
  assert.equal(no.registry.card.available(), false, 'no token and no gh: no icon, no card');
  assert.equal(no.registry.card.badge(), 0);
  assert.equal(no.registry.refreshes, 0, 'and nothing to repaint');
  const empty = await mounted(pulseOf({ myPRs: [], toReview: [], issues: [] }));
  assert.equal(empty.registry.card.available(), true, 'an empty but real pulse is still a connected GitHub');
  assert.equal(empty.registry.card.badge(), 0, 'nothing waiting for me: no counter');
  assert.equal(empty.calls.length, 1, 'one pulse call: with nothing to show it does not ask for the contribution grid');

  // F6: a poll that changed nothing must not repaint, or it detaches the row the user pressed and resets the scroll. The guard
  // compares a stable serialisation of the view model, exactly as the calendar card does.
  await testAsync('F6: two identical polls paint once, and a real change (a review answered) still repaints', async () => {
    let waiting = PULSE.toReview;
    const answerNow = args => (args && args.payload && args.payload.section === 'activity'
      ? { available: true, activity: { total: 30, weeks: [[{ date: '2026-01-04', count: 3, level: 2, weekday: 0 }]] } }
      : pulseOf({ toReview: waiting })); // a fresh object every poll, exactly as the host sends it
    const r = await mounted(answerNow);
    const host = r.page.createElement('div');
    const off = r.registry.card.mount(host);
    const cardHost = host.children[0];
    assert.equal(cls(cardHost, 'gh-tile').length, 3, 'first paint: the pulse');
    assert.equal(cls(cardHost, 'gh-cell').length, 1, 'and its contribution strip');
    const painted = cardHost.childNodes.slice();
    let repaints = 0;
    const replace = cardHost.replaceChildren.bind(cardHost);
    cardHost.replaceChildren = (...nodes) => { repaints += 1; replace(...nodes); };
    const tickAndSettle = async () => {
      const before = r.calls.length;
      r.state.tick();
      for (let i = 0; i < 8; i += 1) await new Promise(res => setImmediate(res));
      assert.ok(r.calls.length > before, 'the 60 s poll really ran');
    };
    await tickAndSettle();
    assert.equal(repaints, 0, 'F6: the same answer twice repaints nothing');
    assert.deepEqual(cardHost.childNodes, painted, 'F6: and the nodes on screen are the very same ones, so a pressed row is never detached');
    waiting = []; // the review was answered: the badge goes 1 → 0, and that IS a change
    await tickAndSettle();
    assert.equal(repaints, 1, 'a different answer repaints once');
    const review = cls(cardHost, 'gh-tile').find(t => t.getAttribute('data-tile') === 'review');
    assert.equal(review.children[0].textContent, '0', 'and the tile shows the count the new answer really has');
    off();
  });

  passed += 2;
  console.log(`island-github-check: ${passed} checks ok`);
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
