'use strict';
/* K2-13 T6b-3 (S7, S10, S16, S18) — Ajustes → Minikodas, in the REAL frontend and headless Chromium.
   What the pure check cannot see: that the card is reachable on its own tab, that the api_hash really starts masked, that
   every control is really clickable (elementFromPoint) and tall enough, that one and only one login step is «current», that
   the layout holds in the dark and the light theme, and that nothing overflows the panel.
   Screenshots go to $EVIDENCE_DIR (default $HOME/Apps/koda/odd/evidence/k2-13-ajustes): ours in both themes, the artboard's
   own cards, and one side-by-side per theme.
   Playwright is a dev tool of this machine: when it is absent the check SKIPS loudly, never green.
   Run: node test-node/minikodas-settings-visual-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const frontend = path.join(__dirname, '..', 'frontend');
/** The approved artboard lives in the WORKSPACE (design/), not inside the worktree: walk up until it is found. */
function findArtboard() {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'design', 'k2-13-minikodas', '06-ajustes-telegram.html');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}
const ARTBOARD = findArtboard();
const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.env.HOME || '', 'Apps', 'koda', 'odd', 'evidence', 'k2-13-ajustes');

function findPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, path.join(process.env.HOME || '', '.local/lib/node_modules/playwright'), 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) { try { return require(c); } catch { /* next */ } }
  return null;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(frontend, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(frontend) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const HASH = '8f3c1d9ae2b74c05d61fa8b3c0e7d294';
const ACCOUNTS = [{ accountId: 'nan', label: 'NaN', provider: 'custom', configured: true }];

/** The fake host: the panel runs with the `settings` window label, so settings.js paints its own panel and island.js stays inert. */
function initScript({ scenario }) {
  const listeners = {};
  const state = {
    connection: 'connected',
    accounts: [{ accountId: 'nan', label: 'NaN', provider: 'custom', configured: true }],
    telegram: scenario.telegram || { state: 'disconnected' },
    transcription: scenario.transcription || { setting: { mode: 'local-parakeet', language: 'es' }, ffmpeg: 'available', local: 'available' },
    telegramCredentials: scenario.credentials === true,
    telegramSessionStored: scenario.credentials === true,
    last_error: { code: null, n: 0 },
  };
  window.__state = state;
  window.__calls = [];
  const prefs = { sound: true, gain: 0.12, declaredPills: [], mainPill: 'koda', pillColors: {}, avatarColors: {}, displayName: 'Álvaro', autoCloseSeconds: 0, openOnHover: false };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'settings' } },
    invoke: async (cmd, args) => invoke(cmd, args),
  };
  const invoke = async (cmd, args) => {
    const p = (args && args.payload) || {};
    (window.__calls || []).push({ cmd, payload: p });
    if (cmd === 'agent_action') {
      if (scenario.delay) await new Promise(r => setTimeout(r, scenario.delay));
      if (p.action === 'view') return structuredClone(state);
      if (p.action === 'telegram_login_start') { state.telegram = { state: 'awaiting_code' }; setTimeout(() => window.__emit('agent:state', structuredClone(state)), 10); return structuredClone(state); }
      if (p.action === 'telegram_login_code') { state.telegram = { state: 'awaiting_password' }; setTimeout(() => window.__emit('agent:state', structuredClone(state)), 10); return structuredClone(state); }
      if (p.action === 'telegram_login_password') {
        state.telegram = { state: 'connected', account: { name: 'Álvaro', username: 'alvaro' } };
        state.telegramCredentials = true;
        state.telegramSessionStored = true;
        setTimeout(() => window.__emit('agent:state', structuredClone(state)), 10);
        return structuredClone(state);
      }
      if (p.action === 'telegram_logout') { state.telegram = { state: 'disconnected' }; state.telegramCredentials = false; state.telegramSessionStored = false; setTimeout(() => window.__emit('agent:state', structuredClone(state)), 10); return structuredClone(state); }
      if (p.action === 'transcription_set') {
        state.transcription = { ...state.transcription, setting: p.setting };
        setTimeout(() => window.__emit('agent:state', structuredClone(state)), 10);
        return structuredClone(state);
      }
      return structuredClone(state);
    }
    if (cmd === 'prefs_action') return p.action === 'view' ? prefs : prefs;
    if (cmd === 'hotkey_action') return { enabled: false, combo: 'Ctrl+Alt+A' };
    if (cmd === 'settings_view') return { open: p.open === true };
    if (cmd === 'secret_action') return { present: false };
    return {};
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => invoke(cmd, args) },
    event: { listen: async (name, fn) => { (listeners[name] ||= []).push(fn); return () => {}; } },
  };
  window.__emit = (name, payload) => (listeners[name] || []).forEach(fn => fn({ payload }));
}

async function openPanel(pw, base) {
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await page.addInitScript(initScript, { scenario: {} });
  await page.goto(`${base}/index.html`);
  await page.waitForTimeout(600);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:settings-select', { detail: 'minikodas' })));
  await page.waitForTimeout(500);
  return { page, browser };
}

function measure() {
  const box = el => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
  const reach = el => {
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { ok: !!top && (top === el || el.contains(top)), w: +b.width.toFixed(1), h: +b.height.toFixed(1), got: top ? (top.id || top.className || top.tagName) : null };
  };
  const panel = document.getElementById('settings');
  const card = document.getElementById('minikodas-settings');
  const pb = box(panel);
  const overflow = [...card.querySelectorAll('*')].filter(el => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && (b.right > pb.right + 0.5 || b.x < pb.x - 0.5);
  }).map(el => el.id || el.className);
  return {
    open: panel.dataset.open === 'true',
    screen: document.getElementById('settings-body').dataset.screen,
    cardShown: !card.hidden && getComputedStyle(card).display !== 'none',
    panel: pb, card: box(card),
    title: document.getElementById('settings-title').textContent,
    tab: [...document.querySelectorAll('#settings-tabs [role="tab"]')].map(b => ({ id: b.dataset.tab, selected: b.getAttribute('aria-selected') })),
    apiId: (() => { const i = document.getElementById('telegram-api-id'); return i ? { type: i.type, disabled: i.disabled, reach: reach(i) } : null; })(),
    apiHash: (() => { const i = document.getElementById('telegram-api-hash'); return i ? { type: i.type, reach: reach(i) } : null; })(),
    connect: reach(document.getElementById('telegram-pair') && document.getElementById('telegram-pair').querySelector('.sbtn.primary')),
    steps: [...document.querySelectorAll('#telegram-steps li')].map(li => ({ step: li.dataset.step, current: li.getAttribute('aria-current') === 'step', hidden: li.hidden, h: +li.getBoundingClientRect().height.toFixed(1) })),
    connected: (() => { const r = document.getElementById('telegram-connected'); return r ? { hidden: r.hidden, text: (r.textContent || '').trim().slice(0, 80) } : null; })(),
    disconnect: reach(document.getElementById('telegram-disconnect')),
    live: (() => { const l = document.getElementById('minikodas-live'); return l ? l.textContent : ''; })(),
    radios: [...document.querySelectorAll('#transcription-options input[type="radio"]')].map(r => ({ id: r.id, checked: r.checked, reach: reach(r) })),
    group: (() => { const g = document.getElementById('transcription-options'); return g ? { role: g.getAttribute('role'), label: g.getAttribute('aria-label') } : null; })(),
    remoteFields: (() => { const f = document.getElementById('transcription-remote-fields'); return f ? f.hidden : null; })(),
    localNote: (() => { const n = document.getElementById('transcription-local-note'); return n && !n.hidden ? n.textContent : ''; })(),
    options: [...document.querySelectorAll('#transcription-account option')].map(o => o.value),
    overflow, calls: (window.__calls || []).filter(c => c.cmd === 'agent_action').map(c => c.payload.action),
    apiNote: (() => { const n = document.getElementById('telegram-api-note'); return n ? n.textContent : ''; })(),
    theme: document.documentElement.dataset.theme || 'dark',
  };
}

async function artboardShots(pw, shots) {
  // the artboard's own cards, for the side-by-side (it is the design of record, not something to copy)
  if (!ARTBOARD) return false;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });
  await page.goto(`file://${ARTBOARD}`);
  await page.waitForTimeout(300);
  const telegram = page.locator('.aw').first();
  const transcription = page.locator('.aw').nth(4); // F5 · transcripción
  await telegram.screenshot({ path: path.join(shots, 'artboard-06-telegram.png') });
  await transcription.screenshot({ path: path.join(shots, 'artboard-06-transcripcion.png') });
  await page.locator('.aw').nth(1).screenshot({ path: path.join(shots, 'artboard-06-steps.png') });
  await page.locator('.aw').nth(2).screenshot({ path: path.join(shots, 'artboard-06-conectado.png') });
  await browser.close();
  return true;
}

async function sideBySide(pw, shots, theme) {
  for (const f of ['artboard-06-telegram.png', 'artboard-06-transcripcion.png']) if (!fs.existsSync(path.join(shots, f))) return false;
  const b64 = f => fs.readFileSync(path.join(shots, f)).toString('base64');
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 2100, height: 1400 } });
  const ours = `data:image/png;base64,${b64(`ajustes-minikodas-${theme}.png`)}`;
  const design = `data:image/png;base64,${b64('artboard-06-telegram.png')}`;
  const design2 = `data:image/png;base64,${b64('artboard-06-transcripcion.png')}`;
  const foreground = theme === 'light' ? '#1a1915' : '#f5f6f8';
  const background = theme === 'light' ? '#f4efe3' : '#0e0f11';
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${background};color:${foreground};font:13px system-ui,sans-serif">
    <div style="display:flex;gap:16px;padding:16px;align-items:flex-start">
      <figure style="margin:0"><figcaption style="margin-bottom:6px">Koda real · Ajustes › Minikodas (${theme})</figcaption>
        <img src="${ours}" style="width:1000px;display:block;border:1px solid rgba(128,128,128,.4);border-radius:12px"></figure>
      <div style="display:flex;flex-direction:column;gap:16px">
        <figure style="margin:0"><figcaption style="margin-bottom:6px">Artboard 06 · Telegram</figcaption>
          <img src="${design}" style="width:760px;display:block;border:1px solid rgba(128,128,128,.4);border-radius:12px"></figure>
        <figure style="margin:0"><figcaption style="margin-bottom:6px">Artboard 06 · Transcripción</figcaption>
          <img src="${design2}" style="width:760px;display:block;border:1px solid rgba(128,128,128,.4);border-radius:12px"></figure>
      </div>
    </div></body></html>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shots, `side-by-side-${theme}.png`), fullPage: true });
  await browser.close();
  return true;
}

(async () => {
  const pw = findPlaywright();
  if (!pw) { console.log('SKIPPED minikodas-settings-visual-check: no playwright — NOT a pass'); process.exit(0); }
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const theme of ['dark', 'light']) {
      const { page, browser } = await openPanel(pw, base);
      try {
        await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(300);
        const m = await page.evaluate(measure);
        assert.ok(m.open, `${theme}: Ajustes is open`);
        assert.equal(m.screen, 'minikodas', `${theme}: the panel is on the Minikodas tab`);
        assert.equal(m.cardShown, true, `${theme}: the card is visible`);
        assert.equal(m.tab.find(t => t.selected === 'true').id, 'minikodas', `${theme}: the tab reads as selected`);
        assert.match(m.title, /Minikodas/, `${theme}: the panel title names the section`);
        // the api pair: masked by default, reachable, and a real primary action to connect
        assert.equal(m.apiHash.type, 'password', `${theme}: the api_hash starts masked`);
        assert.ok(m.apiId.reach.ok && m.apiId.reach.h >= 28, `${theme}: the api_id field receives the click (${JSON.stringify(m.apiId.reach)})`);
        assert.ok(m.connect && m.connect.ok, `${theme}: «Conectar» receives the click (${JSON.stringify(m.connect)})`);
        // the three steps, exactly one of them current
        assert.deepEqual(m.steps.map(s => s.step), ['phone', 'code', 'password'], `${theme}: the three steps are drawn up front`);
        assert.equal(m.steps.filter(s => s.current).length, 1, `${theme}: exactly one step is current`);
        assert.equal(m.steps.find(s => s.current).step, 'phone', `${theme}: a disconnected account starts at the phone`);
        assert.equal(m.connected.hidden, true, `${theme}: no connected row before connecting`);
        // the visible Telegram-API note (S10) is on the card, not in a hidden tooltip
        assert.match(m.apiNote, /API de Telegram/, `${theme}: the note says Koda uses the Telegram API`);
        assert.match(m.apiNote, /llavero/, `${theme}: and where the session lives`);
        // transcription: a radiogroup, Parakeet chosen, the local state said in words
        assert.deepEqual(m.group, { role: 'radiogroup', label: 'Cómo se transcriben los videos' }, `${theme}: the options are one radiogroup`);
        assert.equal(m.radios.length, 2, `${theme}: exactly two options (S18: no second local model)`);
        assert.equal(m.radios.find(r => r.id === 'transcription-local').checked, true, `${theme}: Parakeet is the default (S16)`);
        for (const r of m.radios) assert.ok(r.reach.ok && r.reach.h >= 12, `${theme}: radio ${r.id} receives the click`);
        assert.equal(m.remoteFields, true, `${theme}: the remote fields stay hidden while Parakeet is chosen`);
        assert.match(m.localNote, /Parakeet está instalado/, `${theme}: the local state is what the daemon reported`);
        assert.deepEqual(m.overflow, [], `${theme}: nothing overflows the panel (${m.overflow.join(', ')})`);
        // the closed verbs the card used: one read at open, nothing else on its own
        assert.deepEqual([...new Set(m.calls)], ['view'], `${theme}: the card reads once and sends nothing by itself (${m.calls})`);
        await page.locator('#settings').screenshot({ path: path.join(EVIDENCE, `ajustes-minikodas-${theme}.png`) });
        await page.screenshot({ path: path.join(EVIDENCE, `ajustes-minikodas-${theme}-full.png`) });

        // 2 · the login opens from the panel's own controls, step by step, and the daemon's state is what moves it
        await page.fill('#telegram-api-id', '20405128');
        await page.fill('#telegram-api-hash', HASH);
        await page.click('#telegram-pair .sbtn.primary');
        await page.waitForTimeout(150);
        await page.fill('#telegram-phone-input', '+5491155554321');
        await page.click('#telegram-phone-send');
        await page.waitForTimeout(300);
        const awaiting = await page.evaluate(measure);
        assert.equal(awaiting.steps.find(s => s.current).step, 'code', `${theme}: the daemon's awaiting_code moves the card to the code`);
        assert.match(awaiting.live, /código/i, `${theme}: and the card says a code is on its way (${awaiting.live})`);
        assert.ok(awaiting.calls.includes('telegram_login_start'), `${theme}: the login travelled`);
        await page.locator('#settings').screenshot({ path: path.join(EVIDENCE, `ajustes-minikodas-codigo-${theme}.png`) });
        await page.fill('#telegram-code-input', '48121');
        await page.click('#telegram-code-send');
        await page.waitForTimeout(300);
        const password = await page.evaluate(measure);
        assert.equal(password.steps.find(s => s.current).step, 'password', `${theme}: awaiting_password moves it to the 2FA step`);
        assert.equal(await page.evaluate(() => document.getElementById('telegram-code-input').value), '', `${theme}: the code leaves the page once it travelled`);
        await page.fill('#telegram-password-input', 'secreta');
        await page.click('#telegram-password-send');
        await page.waitForTimeout(350);
        const connected = await page.evaluate(measure);
        assert.equal(connected.connected.hidden, false, `${theme}: the connected row appears`);
        assert.match(connected.connected.text, /Álvaro · @alvaro/, `${theme}: with the account the daemon reported (${connected.connected.text})`);
        assert.ok(connected.disconnect && connected.disconnect.ok, `${theme}: «Desconectar» receives the click`);
        assert.equal(await page.evaluate(() => document.getElementById('telegram-password-input').value), '', `${theme}: the 2FA password leaves the page`);
        await page.locator('#settings').screenshot({ path: path.join(EVIDENCE, `ajustes-minikodas-conectado-${theme}.png`) });
      } finally {
        await browser.close();
      }
    }

    // 3 · the remote transcription option: account + model, and the local note when the daemon says the helper is missing
    {
      const { page, browser } = await openPanel(pw, base);
      try {
        await page.evaluate(() => {
          window.__state.transcription = { setting: { mode: 'remote', language: 'es', remote: { accountId: 'nan', model: 'whisper' } }, ffmpeg: 'available', local: 'unavailable' };
          window.__emit('agent:state', structuredClone(window.__state));
        });
        await page.waitForTimeout(300);
        const m = await page.evaluate(measure);
        assert.equal(m.radios.find(r => r.id === 'transcription-remote').checked, true, 'the stored remote choice is drawn');
        assert.equal(m.remoteFields, false, 'its fields are shown with it');
        assert.deepEqual(m.options, ['nan'], 'the configured OpenAI-compatible accounts are offered');
        assert.match(m.localNote, /no está disponible en esta instalación/, 'a missing local helper is said in words, never a fake download');
        await page.locator('#settings').screenshot({ path: path.join(EVIDENCE, 'ajustes-minikodas-remoto.png') });
        // choosing Parakeet writes the local setting (S16/S18) and sends exactly one verb
        await page.click('#transcription-local');
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => window.__calls.filter(c => c.cmd === 'agent_action').map(c => c.payload));
        const set = after.filter(p => p.action === 'transcription_set');
        assert.equal(set.length, 1, `one setting travelled (${JSON.stringify(after.map(p => p.action))})`);
        assert.deepEqual(set[0].setting, { mode: 'local-parakeet', language: 'es' }, 'Parakeet, with the stored language');
      } finally {
        await browser.close();
      }
    }

    // 4 · the side-by-side evidence against the approved artboard (SKIPPED loudly when the workspace design/ is not there)
    const art = await artboardShots(pw, EVIDENCE);
    if (!art) console.log('minikodas-settings-visual-check: artboard not found above this worktree — the side-by-side is NOT generated');
    else for (const theme of ['dark', 'light']) await sideBySide(pw, EVIDENCE, theme);
    console.log(`minikodas-settings-visual-check: ok — screenshots in ${EVIDENCE}`);
  } finally {
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
