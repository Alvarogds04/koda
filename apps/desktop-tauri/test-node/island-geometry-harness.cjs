'use strict';
/* Real-layout harness: the REAL frontend (index.html + its CSS + its scripts) in headless Chromium, served over HTTP like the app's
   own protocol (ES module imports fail under file://), with a fake Tauri backend. It expands the island exactly as Rust does
   (window.__islandSetState('overview')) and lets a test feed sessions, notices, integrations and a pending question, then measure
   bounding boxes and hit-test with elementFromPoint. Pure-function tests cannot see overlaps: the first A+E build passed every
   suite and still drew «En reposo» over the mascot. Playwright is a dev tool of this machine: when it is absent the callers SKIP
   loudly (never pass silently). */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');

function findPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, path.join(process.env.HOME || '', '.local/lib/node_modules/playwright'), 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch { /* next */ } }
  return null;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// abito-pausa (human, 0.1.2: integrations are paused in this version, frontend/paused.js): the GitHub / service cards these checks
// measure are switched off by the real product. A scenario that exercises them (`github`, `declared`) serves paused.js with
// `integrations` removed from PAUSED, so the layout is still verified for the version that turns them back on. Nothing else changes.
const needsIntegrations = scenario => Boolean(scenario.github || scenario.declared || scenario.focusGithub);
function serve(scenario = {}) {
  const server = http.createServer((req, res) => {
    const f = path.join(frontend, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(frontend) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    let body = fs.readFileSync(f);
    if (path.basename(f) === 'paused.js' && needsIntegrations(scenario)) {
      const text = body.toString('utf8'), live = text.replace("'integrations', ", '');
      if (live === text) throw new Error('paused.js no longer lists integrations: update the harness unpause rule');
      body = Buffer.from(live);
    }
    res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const SESSIONS = [
  { id: 's-0000000a', kind: 'codex', cwd: 'proyecto-beta', state: 'sleeping', origin: null },
  { id: 's-0000000b', kind: 'claude-code', cwd: 'api', state: 'running', origin: null },
  { id: 's-0000000c', kind: 'pi', cwd: 'workspace', state: 'sleeping', origin: null },
  { id: 's-0000000d', kind: 'gemini', cwd: 'web', state: 'sleeping', origin: null },
  { id: 's-0000000e', kind: 'opencode', cwd: 'docs', state: 'sleeping', origin: null },
];
const UUID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';

/** scenario = { sessions: [...]|[], notices: n, engine: 'down'|'account'|null, github: bool, question: 'plain'|'approval'|null, finished: text|null } */
async function open(scenario = {}) {
  const pw = findPlaywright();
  if (!pw) return null;
  const server = await serve(scenario);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 752, height: 340 } });
  await page.addInitScript(({ scenario, SESSIONS, UUID }) => {
    const listeners = {};
    const sessions = scenario.manyPi ? Array.from({ length: 14 }, (_, i) => ({ id: 's-' + (0x100 + i).toString(16).padStart(8, '0'), kind: 'pi', cwd: 'proyecto-' + i, state: i === 0 ? 'running' : 'sleeping', origin: null })) : scenario.sessions === undefined ? SESSIONS : scenario.sessions;
    const notices = scenario.noticeRows || Array.from({ length: scenario.notices || 0 }, (_, i) => ({ id: `n${i + 1}`, title: scenario.noticeTitle || 'Pi terminó su turno', detail: `Resultado número ${i + 1}`, severity: 'info', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'pi', projectName: 'workspace' }));
    if (scenario.finishedCard) notices.push({ id: UUID, title: 'Pi terminó su turno', detail: scenario.finishedText || 'Migración aplicada, 14 tests pasan.', severity: 'info', kind: 'settled', expiresAt: Date.now() + 600000, agent: scenario.finishedCard, projectName: 'api' });
    const snap = { state: 'expanded', notices, card: null, request: null, revision: 1, motionOverride: false, unavailable: scenario.unavailable === true, connections: scenario.engine === 'down' ? 0 : 1 };
    if (scenario.bridgeCard) snap.card = { operation: 'bash: npm run build', reason: null, state: 'pending', expires_at: new Date(Date.now() + 600000).toISOString() };
    const accounts = scenario.engine === 'account' ? [] : [{ configured: true, local: false }];
    const connection = scenario.engine === 'down' ? 'no_daemon' : 'connected';
    const OPT = (i, label, description = '') => ({ index: i, label, description });
    const pending = scenario.question === 'form' ? {
      id: UUID, kind: 'question', agent: 'pi', agent_label: 'Pi', project_name: 'e1-ajustes', text: 'Configurar', allow_free_text: false, options: [], expires_at: Date.now() + 600000, free_text_max: 4000,
      form: [{ header: 'Editor', text: '¿Cuál es tu editor favorito?', options: [OPT(0, 'vim'), OPT(1, 'emacs'), OPT(2, 'vscode')], multi_select: false, allow_free_text: false },
        { header: 'Extras', text: '¿Qué extras?', options: [OPT(0, 'eslint'), OPT(1, 'prettier')], multi_select: true, allow_free_text: true }],
    } : scenario.question === 'multi' ? {
      id: UUID, kind: 'question', agent: 'pi', agent_label: 'Pi', project_name: 'e1-ajustes', text: '¿Qué querés instalar?', allow_free_text: true, multi_select: true,
      options: [OPT(0, 'eslint'), OPT(1, 'prettier'), OPT(2, 'vitest')], expires_at: Date.now() + 600000, free_text_max: 4000,
    } : scenario.question ? {
      id: UUID, kind: scenario.question === 'approvalPi' ? 'approval' : 'question', agent: scenario.question === 'approval' ? 'claude-code' : 'pi', agent_label: 'Pi', project_name: 'api',
      text: scenario.question === 'approvalPi' ? '¿Me das permiso para ejecutar: rm -rf build/ && npm run build?' : scenario.question === 'approval' ? 'Claude Code asks permission: Bash: rm -rf build/ && npm run build' : '¿Qué editor preferís?',
      options: scenario.question === 'approvalPi' ? [{ index: 0, label: 'Aprobar', description: '' }, { index: 1, label: 'Rechazar', description: '' }] : scenario.question === 'approval' ? [{ index: 0, label: 'Allow once', description: '' }, { index: 1, label: 'Deny', description: '' }] : [{ index: 0, label: 'vim', description: scenario.described ? 'modal, ya lo usás en el servidor' : '' }, { index: 1, label: 'emacs', description: scenario.described ? 'extensible, más pesado' : '' }, { index: 2, label: 'vscode', description: '' }],
      allow_free_text: scenario.question !== 'approval' && scenario.question !== 'approvalPi', expires_at: Date.now() + 600000, free_text_max: 2000,
    } : null;
    window.__TAURI__ = {
      core: { invoke: async (cmd, args) => {
        const a = args && args.payload && args.payload.action;
        try { (window.__allCalls ||= []).push({ cmd, payload: args && args.payload ? structuredClone(args.payload) : null }); } catch { /* recording only (HU-073): never changes a response */ }
        if (cmd === 'settings_window_action') return { open: true };
        if (cmd === 'island_shape') { (window.__shapes = window.__shapes || []).push(args.payload); return {}; }
        if (cmd === 'desktop_action') {
          (window.__desktopCalls ||= []).push(structuredClone(args.payload));
          // the host's own dismissals: one id removes exactly that notice, no id removes the first (M2/#437), then the new snapshot is pushed
          if (a === 'dismiss') {
            const id = args.payload.id; const at = id ? snap.notices.findIndex(n => n.id === id) : 0;
            if (at >= 0) snap.notices.splice(at, 1);
            snap.revision += 1; queueMicrotask(() => window.__emit('desktop:state', structuredClone(snap)));
          }
          if (a === 'autoClose') { (window.__autoCloses = window.__autoCloses || []).push(performance.now()); if (!window.__refuseClose) { snap.state = 'compact'; snap.revision += 1; queueMicrotask(() => window.__islandSetState && window.__islandSetState('compact')); } else throw new Error('pendiente'); }
          if (a === 'expand') { snap.state = 'expanded'; snap.revision += 1; queueMicrotask(() => window.__islandSetState && window.__islandSetState('overview')); }
          return structuredClone(snap);
        }
        if (cmd === 'agent_action') return a === 'sessions_list' ? { connection, accounts, sessions: { rows: sessions, truncated: false } } : { connection, accounts };
        if (cmd === 'prefs_action') return { sound: true, declaredPills: scenario.declared ? scenario.declared : scenario.github ? ['integration_github'] : [], mainPill: 'abito', pillColors: {}, avatarColors: {}, autoCloseSeconds: 0, openOnHover: false, absenceSeconds: 600 };
        if (cmd === 'github_action' && scenario.githubData === 'real') {
          // the shape src/github.rs serialises (what the validator's fake `gh` produces): PRs carry `repo`/`isDraft`/`review`, mainCI rows carry repo+branch
          const pr = { id: 'fixture/repo#42', title: 'Fixture PR', url: 'https://github.com/fixture/repo/pull/42', repo: 'fixture/repo', number: 42, isDraft: false, ci: 'failure', review: 'pending', headSha: null };
          return a === 'refresh' && args.payload.section === 'pulse'
            ? { available: true, pulse: { login: 'validator', myPRs: [pr], toReview: [], mainCI: [{ repo: 'fixture/repo', url: 'https://github.com/fixture/repo', branch: 'main', ci: 'success', headSha: null }], fetchedAt: 1 }, stats: { totalStars: 18, totalRepos: 23 } }
            : { available: true, activity: { weeks: [{ days: [{ date: '2026-01-04', count: 17, level: 3, weekday: 0 }] }], total: 17 } };
        }
        if (cmd === 'github_action') return scenario.githubData
          ? (a === 'refresh' && args.payload.section === 'pulse'
            ? { available: true, pulse: { login: 'abito', myPRs: [{ number: 1, title: 'fix', url: 'https://github.com/o/r/pull/1', ci: 'failing' }], toReview: [], mainCI: [{ name: 'ci', state: 'success' }] }, stats: null }
            : { available: true, activity: { weeks: [], total: 18 } })
          : { available: false, reason: 'gh_missing' };
        if (cmd === 'question_action') {
          // answering consumes the pending question and the host reports «answered» (the producer's ack), like the real receiver
          if (a === 'answer' || a === 'decline' || a === 'text' || a === 'answer_many' || a === 'answer_form') { window.__answered = true; const v = { available: true, pending: null, queued: [], queued_count: 0, deliveries: [], notice: 'sent' }; setTimeout(() => window.__emit('question:state', { ...v, notice: 'answered' }), 20); return v; }
          return { available: true, pending: window.__answered ? null : pending, queued: [], queued_count: 0, deliveries: [], notice: window.__answered ? 'answered' : null };
        }
        if (cmd === 'chat_action') { if (a === 'back') { (window.__chatCalls ||= []).push('back'); queueMicrotask(() => window.__islandSetView && window.__islandSetView('overview')); } return {}; }
        if (cmd === 'focus_host') { (window.__focusCalls ||= []).push(args.payload); return {}; }
        if (cmd === 'island_window_height') {
          window.__grantedWindowHeight = scenario.windowCap || (args.payload && args.payload.h) || 340;
          return { h: window.__grantedWindowHeight };
        }
        return {};
      } },
      event: { listen: async (name, fn) => { (listeners[name] ||= []).push(fn); return () => {}; } },
    };
    window.__emit = (name, payload) => (listeners[name] || []).forEach(fn => fn({ payload }));
  }, { scenario, SESSIONS, UUID });
  if (scenario.fakeClock) await page.clock.install({ time: 0 }); // time still flows; runFor() jumps it (before any page script runs)
  await page.goto(`${base}/index.html`);
  if (scenario.theme) await page.evaluate(t => { document.documentElement.dataset.theme = t; }, scenario.theme);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__islandSetState('overview'));
  if (scenario.chat) { await page.evaluate(() => window.__islandSetView('chat', 720, 240)); await page.waitForTimeout(800); }
  // S32: every declared service that has a card counts as «seen» (the host answered for it), so its pill shows as a row
  if (scenario.declared) await page.evaluate(ids => document.dispatchEvent(new CustomEvent('abito:integration-seen', { detail: { ids, source: 'integrations' } })), scenario.declared);
  if (scenario.github) await page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:integration-seen', { detail: { ids: ['integration_github'], source: 'github' } })));
  if (scenario.focusGithub) { await page.waitForTimeout(600); await page.evaluate(() => document.getElementById('pill-choice-integration_github')?.click()); }
  await page.waitForTimeout(scenario.quick ? 1800 : 4200); // spring + the ticker's first poll (`quick`: measurements that only need the card, not the first ticker poll)
  if (scenario.finishedCard && !scenario.noLane) { await page.evaluate(id => window.__emit('desktop:notice-open', { id, kind: 'finished' }), UUID); await page.waitForTimeout(1500); }
  if (scenario.question) {
    await page.waitForTimeout(600);
    // The mock host grants the requested height; reflect that grant in the actual
    // viewport, as the native host does. Otherwise newly spaced controls can be
    // inside the card but outside the stale 340px test window.
    const height = await page.evaluate(() => window.__grantedWindowHeight || 340);
    await page.setViewportSize({ width: 752, height });
    await page.waitForTimeout(150);
  }
  return {
    page,
    measure: sel => page.evaluate(selector => [...document.querySelectorAll(selector)].map(el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { id: el.id || el.className || el.tagName, left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height,
        shown: s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && b.width > 0 && b.height > 0, text: (el.textContent || '').trim().slice(0, 40) };
    }), sel),
    /** the element that actually receives a click at the centre of each match (innermost), and whether it is the match itself/inside it */
    hit: sel => page.evaluate(selector => [...document.querySelectorAll(selector)].filter(el => {
      const b = el.getBoundingClientRect(); if (b.width <= 0 || b.height <= 0 || getComputedStyle(el).display === 'none') return false;
      // a control inside a scrolling list that is scrolled out of view is reached by scrolling, not by a click at its (clipped) box
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') { const pb = p.getBoundingClientRect(); if (b.bottom > pb.bottom + 0.5 || b.top < pb.top - 0.5) return false; }
        if (p.id === 'capsule') break;
      }
      return true;
    }).map(el => {
      const b = el.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const top = document.elementFromPoint(x, y);
      return { id: el.id || el.className, ok: !!top && (top === el || el.contains(top)), at: [Math.round(x), Math.round(y)], got: top ? (top.id || top.className || top.tagName) : null };
    }), sel),
    // Sample both sides of every horizontal edge, not just centres. Scroll each row
    // into view so clipped rows are tested too; outside samples may hit a gap,
    // but must never hit this row (nor may inside samples hit its neighbour).
    hitEdges: sel => page.evaluate(async selector => {
      const rows = [...document.querySelectorAll(selector)], hits = [];
      for (const [index, el] of rows.entries()) {
        if (!el.getBoundingClientRect().height || getComputedStyle(el).display === 'none') continue;
        el.scrollIntoView({ block: 'nearest' });
        await new Promise(resolve => requestAnimationFrame(resolve));
        const b = el.getBoundingClientRect();
        for (const x of [b.left + 1, (b.left + b.right) / 2, b.right - 1]) {
          for (const [y, inside] of [[b.top - 1, false], [b.top + 1, true], [b.bottom - 1, true], [b.bottom + 1, false]]) {
            const top = document.elementFromPoint(x, y), own = !!top && (top === el || el.contains(top));
            hits.push({ row: index, at: [x, y], inside, ok: inside === own, got: top?.closest(selector)?.textContent?.trim() || top?.id || top?.tagName });
          }
        }
      }
      return hits;
    }, sel),
    screenshot: file => page.screenshot({ path: file }),
    close: async () => { await browser.close(); server.close(); },
  };
}
module.exports = { open, findPlaywright };
