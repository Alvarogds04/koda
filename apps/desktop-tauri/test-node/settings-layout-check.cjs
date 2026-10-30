'use strict';
/* Ajustes in a REAL layout engine (headless Chromium, the real settings.html + CSS + scripts, fake Tauri hosts shaped like the real
   ones). The DOM-fake design checks (settings-designs-*) passed while the human's screen validation found: a dropdown where the MD
   asks for segmented pills, a slider on the edge, a title broken «Wi-/Fi.», a column order that disagrees with its header, raw
   «Pulse <Shift><Control>n» in the key cell, a «Conectar» touching the card border, a missing sidebar entry. Only a layout can see
   those. Run: node test-node/settings-layout-check.cjs  (SKIPs loudly without playwright, never a silent pass). */
const assert = require('node:assert/strict');
const H = require('./settings-layout-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED settings-layout-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }
const tests = []; const test = (name, fn) => tests.push([name, fn]);
// 0.1.2 (human: «vale todo lo que este en pausa se puede ocultar?» → yes): paused pages are HIDDEN from the menu. The paused list comes
// from the single source of truth (hub/shell.js PAUSED_PAGES, pinned by paused-features-check); a page's own layout test runs again
// by itself the day its page is active again, and until then it checks that the page is not in the menu.
const PAGE_IDS = { Dictado: 'dictation', Notetaker: 'notes', 'Estadísticas': 'insights', Diccionario: 'dictionary', Fragmentos: 'snippets', Estilos: 'styles', Ajustes: 'flowsettings',
  General: 'general', Integraciones: 'integrations', Agentes: 'agents', Chat: 'chat', 'OK Koda': 'voice', 'Teléfono': 'phone', 'Teléfono Android': 'phone', Atajos: 'shortcuts', Privacidad: 'privacy' };
let PAUSED = null;
const isPaused = title => { assert(PAGE_IDS[title], title); return PAUSED.includes(PAGE_IDS[title]); };
const navTitles = page => page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item')].map(e => e.textContent.trim()));
const pageTest = (title, name, fn) => test(name, async r => {
  if (!isPaused(title)) return fn(r);
  const items = await navTitles(r.page);
  assert(!items.some(t => t === title || t.startsWith(title + ' ')), `paused «${title}» must not be in the menu: ${JSON.stringify(items)}`);
});

test('S18 General: «Tema» is three segmented pills Oscuro / Claro / Sistema, one selected, never a dropdown', async r => {
  await r.go('General');
  const pills = await r.page.evaluate(() => { const g = document.getElementById('hub-theme'); return g ? [...g.querySelectorAll('button')].map(b => [b.textContent, b.classList.contains('on'), b.getAttribute('aria-pressed')]) : null; });
  assert.deepEqual(pills, [['Oscuro', false, 'false'], ['Claro', false, 'false'], ['Sistema', true, 'true']]);
  assert.equal(await r.page.evaluate(() => !!document.querySelector('.abito-card select[aria-label="Tema"]')), false, 'no <select> for the theme');
  await r.page.locator('#hub-theme button', { hasText: 'Oscuro' }).click(); await r.page.waitForTimeout(300);
  assert((await r.calls()).some(([c, a]) => c === 'prefs_action' && a === 'set_theme'), 'the same closed set_theme command');
});

test('S18 General: every row of every card stays inside its card (the volume slider no longer overlaps the right edge)', async r => {
  await r.go('General');
  const bad = await r.page.evaluate(() => { const out = []; for (const card of document.querySelectorAll('.abito-card')) { const cb = card.getBoundingClientRect();
    for (const el of card.querySelectorAll('input, select, button, .row')) { const b = el.getBoundingClientRect(); if (!b.width) continue; if (b.right > cb.right - 8 || b.left < cb.left) out.push([el.id || el.className || el.tagName, Math.round(b.right - cb.right)]); } } return out; });
  assert.deepEqual(bad, [], `controls touching or past their card's edge: ${JSON.stringify(bad)}`);
});

test('S18 General: «Atajo del sistema» is not a loose label: it is a value row or it is not there', async r => {
  await r.go('General');
  const rows = await r.page.evaluate(() => [...document.querySelectorAll('.abito-card .row')].map(row => { const label = row.querySelector('label'); return { label: label ? label.textContent.trim() : '', controls: row.querySelectorAll('input,select,button,.switch,.keycap').length, text: row.textContent.trim().length }; }));
  const loose = rows.filter(x => x.label && x.controls === 0 && x.text <= x.label.length + 1);
  assert.deepEqual(loose, [], `a label with nothing to show: ${JSON.stringify(loose)}`);
});

test('S19 Pills: no card of the page is an empty box (the «Colores de identidad» section drew an empty field over the Abito row)', async r => {
  await r.go('Isla'); // HU-063 S2: «Colores de identidad» moved from General to the Isla page (0.2.1 had it in General)
  const empty = await r.page.evaluate(() => [...document.querySelectorAll('.hub-card')].filter(c => !c.children.length && !c.textContent.trim()).map(c => c.parentElement && c.parentElement.querySelector('.hub-label') ? c.parentElement.querySelector('.hub-label').textContent : c.className));
  assert.deepEqual(empty, [], `empty cards: ${JSON.stringify(empty)}`);
  const rows = await r.page.evaluate(() => { const sec = [...document.querySelectorAll('section')].find(s => /colores de identidad/i.test((s.querySelector('.hub-label') || {}).textContent || '')); const card = sec.querySelector('.hub-card'); return { rowInsideCard: !!card && !!card.querySelector('.hub-row'), rows: sec.querySelectorAll('.hub-row').length }; });
  assert(rows.rows > 0 && rows.rowInsideCard, `the Abito colour row must live INSIDE the card: ${JSON.stringify(rows)}`);
});

test('S20 Agentes: with every agent in `error` the table at rest repeats NO failure caption; only a failed action says so, once', async r => {
  await r.go('Agentes');
  const caption = 'No se pudo completar; no se tocó nada.';
  assert.equal((await r.text('.hub-page')).split(caption).length - 1, 0, 'standing captions under the rows');
  assert.equal((await r.page.evaluate(() => [...document.querySelectorAll('.agent-row .agent-state')].filter(e => /No se pudo/.test(e.textContent)).length)) > 0, true, 'the state column still reports the state');
});

test('S20 Agentes: a refused install shows ONE sentence in the status line, and nowhere else', async r => {
  await r.close();
  const f = await H.open({ width: 960, height: 680, agentsOk: true, failInstall: true });
  try {
    await f.go('Agentes');
    await f.page.locator('#agent-row-claude-code button', { hasText: 'Instalar' }).click(); await f.page.waitForTimeout(800); // one click: no second confirm
    const status = await f.text('#agent-action-status');
    assert.equal(status.trim(), 'No se pudo completar la acción en Claude Code; no se tocó nada.');
    assert.equal((await f.text('.hub-page')).split('no se tocó nada').length - 1, 1, 'exactly one copy on the page');
  } finally { await f.close(); }
});

// HU-044 (human: «quiero todos los apartados colapsados por defecto»): the Chat apartados open folded. The older checks below assert what a
// provider card shows once the human has opened it, so they open every folded apartado first and then assert exactly what they did before.
const openApartados = async page => { const folded = page.locator('.hub-page .card-fold[aria-expanded="false"]'); for (let i = 0; i < 20 && await folded.count(); i++) await folded.first().click(); await page.waitForTimeout(100); };

test('S21 Chat: «Probar» is VISIBLE on a card without a key, disabled, and its reason is on screen as text', async r => {
  await r.go('Chat'); await openApartados(r.page);
  const probes = await r.page.evaluate(() => [...document.querySelectorAll('.abito-card')].filter(c => c.querySelector('input[id^="chat-key-"]')).map(c => { const b = [...c.querySelectorAll('button')].find(x => x.textContent === 'Probar'); if (!b) return null; const rc = b.getBoundingClientRect(); const reason = c.querySelector('.test-reason');
    return { card: c.querySelector('h2').textContent.trim().slice(0, 12), visible: rc.width > 0 && rc.height > 0, disabled: b.disabled, reason: reason ? reason.textContent : null, reasonVisible: reason ? reason.getBoundingClientRect().height > 0 : false }; }));
  assert(probes.length >= 4 && probes.every(Boolean), `every provider card shows Probar: ${JSON.stringify(probes)}`);
  for (const p of probes) { assert(p.visible, `${p.card}: Probar not visible`); assert(p.disabled, `${p.card}: Probar must be disabled without a key`); assert.equal(p.reason, 'Guarda una clave para poder probarla.'); assert(p.reasonVisible, `${p.card}: the reason must be on screen`); }
});

test('S4 Chat: ONE list of AI providers: no second «Configuración de proveedores» / «Buscar proveedor» system, one key field per provider, each card has its model', async r => {
  await r.go('Chat');
  const page = await r.text('.hub-page');
  for (const dup of ['Configuración de proveedores', 'Buscar proveedor', 'Cuentas conectadas']) assert(!page.includes(dup), `duplicate system still on Chat: ${dup}`);
  const keys = await r.page.evaluate(() => [...document.querySelectorAll('input[id^="chat-key-"]')].map(i => i.id));
  assert.equal(new Set(keys).size, keys.length, `a key field twice: ${JSON.stringify(keys)}`);
  const cards = await r.page.evaluate(() => [...document.querySelectorAll('.abito-card')].filter(c => c.querySelector('input[id^="chat-key-"]')).map(c => [c.querySelector('h2').textContent.trim().split(/\s/)[0], !!c.querySelector('select[id^="chat-"][id$="-model"]')]));
  assert(cards.length >= 4 && cards.every(([, hasModel]) => hasModel), `every provider card owns its model: ${JSON.stringify(cards)}`);
  const names = cards.map(c => c[0]); assert.equal(new Set(names).size, names.length, `a provider twice: ${names}`);
  assert(await r.page.evaluate(() => !!document.getElementById('chat-window-context') && !!document.getElementById('chat-extras')), 'slots for the context toggle');
});

test('S2 Chat: subscription rows belong to Claude/OpenAI only and fit within their own cards', async r => {
  await r.go('Chat'); await openApartados(r.page);
  await r.page.waitForFunction(() => document.querySelector('#chat-subscription-anthropic')?.textContent.includes('sin sesión'));
  const rows = await r.page.evaluate(() => [...document.querySelectorAll('[id^="chat-subscription-"]')].map(row => {
    const card = row.closest('.abito-card'), cb = card.getBoundingClientRect();
    const bad = [...row.querySelectorAll('input,button,span')].filter(el => { const b = el.getBoundingClientRect(); return b.width && (b.left < cb.left || b.right > cb.right - 8); }).map(e => e.tagName);
    return { id:row.id, card:card.querySelector('h2').textContent.trim().split(/[\s▾▸]/)[0], text:row.textContent, bad };
  }));
  assert.deepEqual(rows.map(r => [r.id,r.card]), [['chat-subscription-anthropic','Claude'],['chat-subscription-openai','OpenAI']]);
  for (const row of rows) { assert(row.text.includes('✗ sin sesión')); assert(row.text.includes('Iniciar sesión con suscripción')); assert.deepEqual(row.bad,[]); }
  const claude = r.page.locator('#chat-subscription-anthropic'); await claude.getByText('Iniciar sesión con suscripción',{exact:true}).click();
  await claude.getByPlaceholder('Pega aquí el código').waitFor({state:'visible'});
  const overflow = await claude.evaluate(row => { const cb = row.closest('.abito-card').getBoundingClientRect(); return [...row.querySelectorAll('input,button')].some(el => { const b = el.getBoundingClientRect(); return b.width && b.right > cb.right - 8; }); });
  assert.equal(overflow,false); await claude.getByText('Cancelar',{exact:true}).click();
});

test('S1 Chat: no long paragraph on the provider cards (explanations are tooltips)', async r => {
  await r.go('Chat');
  const long = await r.page.evaluate(() => [...document.querySelectorAll('.abito-card .hint, #chat-local-models .hint')].filter(e => e.textContent.length > 90 && !e.closest('#chat-window-context')).map(e => e.textContent.slice(0, 50)));
  assert.deepEqual(long, [], `long text on the cards: ${JSON.stringify(long)}`);
});

pageTest('Integraciones', 'S23 Integraciones: state and actions form COLUMNS shared by every card (a row without «¿Dónde?» no longer shifts «Conectar»), off the card border', async r => {
  await r.go('Integraciones');
  const rows = await r.page.evaluate(() => [...document.querySelectorAll('.int-card')].map(c => { const cb = c.getBoundingClientRect();
    const vis = sel => [...c.querySelectorAll(sel)].filter(b => b.offsetParent);
    const connect = vis('.int-actions button').find(b => b.textContent === 'Conectar'), help = vis('.int-actions button').find(b => b.textContent.startsWith('¿Dónde'));
    const last = vis('.int-actions button').at(-1);
    return { id: c.id, badge: Math.round(c.querySelector('.card-state').getBoundingClientRect().left), connect: connect ? Math.round(connect.getBoundingClientRect().left) : null,
      help: help ? Math.round(help.getBoundingClientRect().left) : null, borderGap: last ? Math.round(cb.right - last.getBoundingClientRect().right) : null }; }));
  const tight = rows.filter(x => x.borderGap !== null && x.borderGap < 8); assert.deepEqual(tight, [], `actions touching the card border: ${JSON.stringify(tight)}`);
  const col = key => [...new Set(rows.filter(x => x[key] !== null).map(x => x[key]))];
  assert.equal(col('badge').length, 1, `state badges are not in one column: ${JSON.stringify(rows.map(x => [x.id, x.badge]))}`);
  assert.equal(col('connect').length, 1, `«Conectar» is not in one column: ${JSON.stringify(rows.filter(x => x.connect !== null).map(x => [x.id, x.connect]))}`);
  assert.equal(col('help').length, 1, `«¿Dónde?» is not in one column: ${JSON.stringify(rows.filter(x => x.help !== null).map(x => [x.id, x.help]))}`);
});

pageTest('Teléfono', 'S24 Teléfono: no line of the hero ends in a hyphen that splits a word («Wi-/Fi.»)', async r => {
  await r.go('Teléfono');
  const breaks = await r.page.evaluate(() => { const out = [];
    for (const el of document.querySelectorAll('.hub-hero h1, .hub-hero p')) { const node = el.firstChild; if (!node || node.nodeType !== 3) continue; const text = node.textContent; let lastTop = null;
      for (let i = 0; i < text.length; i++) { const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1); const rect = range.getClientRects()[0]; if (!rect) continue;
        const top = Math.round(rect.top); if (lastTop !== null && top > lastTop + 4) { const before = text.slice(0, i).trimEnd().slice(-1); const after = text[i]; if (/[-\u2010]/.test(before) && /\p{L}/u.test(after)) out.push(text.slice(Math.max(0, i - 6), i + 4)); } lastTop = top; } }
    return out; });
  assert.deepEqual(breaks, [], `a word split at its hyphen: ${JSON.stringify(breaks)}`);
});

test('S25 Atajos: visual order is Acción | Tecla | Estado, a header over every column, the switch lives INSIDE the action cell', async r => {
  await r.go('Atajos');
  const grid = await r.page.evaluate(() => { const head = [...document.querySelectorAll('.shortcut-head [role=columnheader]')].map(e => [e.textContent, Math.round(e.getBoundingClientRect().left)]);
    const row = document.querySelector('#global-shortcuts .shortcut'); const sw = row.querySelector('.switch').getBoundingClientRect(), name = row.querySelector('.shortcut-name').getBoundingClientRect(), key = row.querySelector('.keycap').getBoundingClientRect(), st = row.querySelector('.shortcut-state').getBoundingClientRect();
    return { head, sw: Math.round(sw.left), name: Math.round(name.left), key: Math.round(key.left), st: Math.round(st.left) }; });
  assert.deepEqual(grid.head.map(h => h[0]), ['Acción', 'Tecla', 'Estado']);
  assert(grid.sw >= grid.head[0][1] - 2 && grid.sw < grid.name, `the switch must sit in the Acción column (header at ${grid.head[0][1]}, switch at ${grid.sw}, name at ${grid.name})`);
  assert(Math.abs(grid.key - grid.head[1][1]) <= 6, `Tecla column misaligned: header ${grid.head[1][1]} vs key ${grid.key}`);
  assert(Math.abs(grid.st - grid.head[2][1]) <= 6, `Estado column misaligned: header ${grid.head[2][1]} vs state ${grid.st}`);
  assert(grid.name < grid.key && grid.key < grid.st, 'Acción, then Tecla, then Estado');
});

test('S25 Atajos: an assigned key reads «Ctrl+Shift+N» (the page\'s canonical modifier order), never the raw portal text «Pulse <Shift><Control>n»; «Pulse…» only while capturing', async r => {
  await r.go('Atajos');
  const keys = await r.page.evaluate(() => [...document.querySelectorAll('#global-shortcuts .keycap')].map(k => k.textContent.trim()));
  assert(keys.length > 0); for (const k of keys) { assert(!/Pulse|<|>/.test(k), `raw instruction in a key cell: ${k}`); assert(/\+|[A-Z]/.test(k), `not a key name: ${k}`); }
  assert(keys.includes('Ctrl+Shift+N'), `expected «Ctrl+Shift+N» in ${JSON.stringify(keys)}`);
  assert.equal(new Set(keys).size, keys.length, 'every action shows its OWN key');
  // same modifier order as every other row of the page (Ctrl, Alt, Shift): one convention, not two
  for (const k of keys) { const mods = k.split('+').slice(0, -1); const order = ['Ctrl', 'Alt', 'Shift', 'Win']; assert.deepEqual(mods, [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b)), `modifier order in ${k}`); }
  await r.page.locator('#global-shortcuts .keycap').first().click(); await r.page.waitForTimeout(300);
  assert.match(await r.page.locator('#global-shortcuts .keycap').first().textContent(), /Pulsa/, 'while capturing, the cell asks for the keys');
});

test('Ajustes opens without waiting for the dictation status: the sidebar is there at once even when that host answer takes 3 s', async r => {
  await r.close();
  const slow = await H.open({ width: 960, height: 680, statusDelayMs: 3000 });
  try {
    const ms = await slow.shellAfter();
    assert(ms < 1500, `the sidebar waited ${ms} ms for dictation_action{status} (device enumeration + keychain happen before it answers)`);
    // the page that needs the status still gets it when it arrives
    await slow.page.waitForTimeout(3300);
    assert.match(await slow.text('.hub-status'), /Listo|Dictado|modelo|micr/i, 'the status line is filled in once the real answer lands');
    assert.equal(await slow.page.locator('.hub-status').isVisible(), false, '0.1.2: dictation is paused, its status line is not shown');
  } finally { await slow.close(); }
});

test('S25 Atajos: while ONE row is capturing, the other rows keep their key and their state; only the capturing row changes', async r => {
  await r.go('Atajos');
  const read = () => r.page.evaluate(() => [...document.querySelectorAll('#global-shortcuts .shortcut')].map(row => [row.id, row.querySelector('.keycap').textContent.trim(), row.querySelector('.shortcut-state').textContent.replace(/\s+/g, ' ').trim()]));
  const before = await read(); assert(before.length >= 3, 'several rows');
  for (const [, , state] of before) assert.match(state, /activo/, 'idle rows are active');
  await r.page.locator('#global-shortcuts .shortcut').nth(1).locator('.keycap').click(); await r.page.waitForTimeout(500);
  const during = await read();
  assert.match(during[1][1], /Pulsa/, 'the capturing row asks for the keys');
  for (let i = 0; i < during.length; i++) { if (i === 1) continue; assert.deepEqual(during[i], before[i], `row ${during[i][0]} changed while another row was capturing: ${JSON.stringify([before[i], during[i]])}`); }
  assert.match(during[1][2], /activo|apagado|grabando/i, 'the capturing row keeps a truthful state');
  await r.page.keyboard.press('Escape'); await r.page.waitForTimeout(500);
  assert.deepEqual(await read(), before, 'Esc restores every row exactly');
});

test('S25 Atajos: after a capture that SAW the host\'s pause pushes, the rows are read again and show the real state (no stale «No disponible»)', async r => {
  await r.go('Atajos');
  const read = () => r.page.evaluate(() => [...document.querySelectorAll('#global-shortcuts .shortcut')].map(row => [row.querySelector('.keycap').textContent.trim(), row.querySelector('.shortcut-state').textContent.replace(/\s+/g, ' ').trim()]));
  const before = await read();
  await r.page.locator('#global-shortcuts .shortcut').nth(2).locator('.keycap').click(); await r.page.waitForTimeout(400);
  await r.page.keyboard.press('Escape'); await r.page.waitForTimeout(700);
  assert.deepEqual(await read(), before, 'every row reads exactly as before the capture');
  const calls = (await r.calls()).filter(([c]) => c === 'hotkey_action').map(([, a]) => a);
  assert(calls.includes('suspend') && calls.includes('resume'), 'the capture really suspended and resumed the host');
  assert(calls.lastIndexOf('view') > calls.lastIndexOf('resume'), 'the state was read AGAIN after resume (the pushes during the pause were not trusted)');
});

pageTest('Ajustes', 'S27 Ajustes (dictado): the microphone meter moves with the host\'s levels and reads «sin señal» when none arrive', async r => {
  await r.go('Ajustes'); await r.page.waitForTimeout(300);
  const read = () => r.page.evaluate(() => { const m = document.querySelector('#dictation-mic-meter'); return m && { state: m.dataset.state, now: m.getAttribute('aria-valuenow'), lit: m.querySelectorAll('.mic-seg.on').length, text: m.textContent.replace(/\s+/g, ' ').trim(), box: m.getBoundingClientRect().width };});
  const idle = await read(); assert(idle, 'the meter exists on the page'); assert(idle.box > 60, 'it is drawn');
  assert.equal(idle.state, 'none'); assert.equal(idle.lit, 0); assert.match(idle.text, /sin señal/, 'no event yet: «sin señal»');
  const emit = v => r.page.evaluate(v => window.__emit('dictation:level', { level: v }), v);
  await emit(0.2); const low = await read(); await emit(1); const high = await read();
  assert.equal(low.state, 'live'); assert(low.lit >= 1 && low.lit < high.lit, `louder lights more segments (${low.lit} → ${high.lit})`);
  assert.equal(high.lit, 5); assert.doesNotMatch(high.text, /sin señal/);
  await emit(0); assert.equal((await read()).lit, 0, 'level 0 lights nothing');
  await emit(7); assert.equal((await read()).lit, 5, 'an out-of-range level is clamped'); await emit('loud'); assert.equal((await read()).lit, 5, 'garbage is ignored, not drawn');
  await r.page.waitForTimeout(1500);
  const quiet = await read(); assert.equal(quiet.state, 'none'); assert.equal(quiet.lit, 0); assert.match(quiet.text, /sin señal/, 'events stop: back to «sin señal»');
  const calls = (await r.calls()).map(([c]) => c); assert(!calls.some(c => /mic|record|level/i.test(c)), 'the page only listens: no command was sent for the meter');
});

test('HU-045: the sidebar shows the real package version (tauri.conf.json), never a hardcoded one', async r => {
  let want;
  try { want = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../tauri.conf.json'), 'utf8')).version; }
  catch (error) { assert.fail(`cannot read the package version from tauri.conf.json: ${error.message}`); }
  assert.equal(typeof want, 'string', 'tauri.conf.json has a version');
  assert.equal((await r.page.locator('.hub-version').textContent()).trim(), `Koda ${want}`);
});

// HU-046 (human, verbatim option chosen: «Botón «Instalar Pi» (recomendado)»): when the chat engine has no Pi, the Chat page AND the Pi row of
// Agentes offer «Instalar Pi». Nothing is installed here: the host command is a stub that counts calls.
test('HU-046 Chat: with Pi missing the page explains why and offers «Instalar Pi»; a first click only shows the plan, the second runs it once', async r => {
  await r.close();
  const f = await H.open({ width: 960, height: 760, piMissing: true });
  try {
    await f.go('Chat'); await f.page.waitForTimeout(1200);
    const box = f.page.locator('#pi-install');
    assert.equal(await box.isVisible(), true, 'the control is on the Chat page');
    assert.match(await box.textContent(), /funciona con Pi/); assert.match(await box.textContent(), /npm install -g @earendil-works\/pi-coding-agent/);
    await box.getByRole('button', { name: 'Instalar Pi' }).click(); await f.page.waitForTimeout(200);
    assert.equal(await f.page.evaluate(() => window.__piRuns || 0), 0, 'the first click only shows what will run');
    assert.match(await f.page.locator('#pi-install-plan').textContent(), /Se va a ejecutar: npm install -g @earendil-works\/pi-coding-agent/);
    if (process.env.ABITO_SHOT_DIR) await f.page.screenshot({ path: require('node:path').join(process.env.ABITO_SHOT_DIR, 'pi-install-chat.png') });
    await box.getByRole('button', { name: 'Instalar ahora' }).click(); await f.page.waitForTimeout(300);
    assert.equal(await f.page.evaluate(() => window.__piRuns), 1, 'the second click runs it exactly once');
    assert.match(await box.textContent(), /Instalando Pi/); assert.equal(await box.getByRole('button').count(), 0, 'no second install while one runs');
    await f.page.evaluate(() => window.__emit('pi-install:state', { action: 'status', phase: 'failed', reason: 'install_failed', say: 'No se pudo instalar Pi. Si Node.js está en una carpeta del sistema, instalalo desde una terminal con permisos o configurá una carpeta propia para npm.' }));
    await f.page.waitForTimeout(200);
    assert.match(await box.textContent(), /No se pudo instalar Pi/); assert.equal(await box.getByRole('button', { name: 'Reintentar' }).count(), 1, 'a failure can be retried and Pi is not shown as installed');
    assert.doesNotMatch(await box.textContent(), /quedó instalado/);
  } finally { await f.close(); }
});

test('HU-046 Agentes: the Pi row offers «Instalar Pi» when Pi is missing; Claude Code and Codex rows never do and the page never says «Falta Pi»', async r => {
  await r.close();
  const f = await H.open({ width: 960, height: 760, piMissing: true });
  try {
    await f.go('Agentes'); await f.page.waitForTimeout(1200);
    const pi = f.page.locator('#agent-row-pi');
    assert.equal(await pi.locator('#pi-install').isVisible(), true, 'the Pi row carries the control');
    assert.equal(await pi.getByRole('button', { name: 'Instalar Pi' }).count(), 1);
    for (const id of ['claude-code', 'codex']) assert.equal(await f.page.locator(`#agent-row-${id} #pi-install`).count(), 0, `${id}: no Pi install control`);
    assert.equal(await f.page.locator('#pi-install').count(), 1, 'exactly one control on the page');
    assert.doesNotMatch(await f.page.locator('.hub-page').textContent(), /Falta Pi/, 'Agentes never shows the general «Falta Pi»');
    if (process.env.ABITO_SHOT_DIR) await f.page.screenshot({ path: require('node:path').join(process.env.ABITO_SHOT_DIR, 'pi-install-agentes.png') });
  } finally { await f.close(); }
});

test('HU-046: with Pi present (engine connected) neither page shows the control', async r => {
  for (const title of ['Chat', 'Agentes']) { await r.go(title); await r.page.waitForTimeout(800); assert.equal(await r.page.locator('#pi-install').isVisible().catch(() => false), false, title); }
});

test('0.1.2 paused pages are hidden: the sidebar lists exactly the active pages, no grey «En pausa» row (visual check: hub-side screenshot)', async r => {
  const items = await navTitles(r.page);
  const want = Object.keys(PAGE_IDS).filter(t => !['Teléfono', 'Ajustes'].includes(t) && !isPaused(t)).concat('Isla'); // HU-063 S2: the new additive «Isla» page
  assert.deepEqual([...items].sort(), [...want].sort(), JSON.stringify(items));
  assert.equal(await r.page.locator('.hub-side .hub-paused, .hub-side .hub-item.paused, .hub-side [disabled]').count(), 0, 'nothing greyed out');
  if (process.env.ABITO_SHOT_DIR) await r.page.locator('.hub-side').screenshot({ path: require('node:path').join(process.env.ABITO_SHOT_DIR, 'hub-side.png') });
});

test('0.2.1 S1 (option B): «Integraciones» and «Agentes» are two sidebar entries; «Pestañas activas» and the combined entry are gone', async r => {
  const items = await navTitles(r.page);
  assert.equal(items.filter(t => t === 'Integraciones').length, isPaused('Integraciones') ? 0 : 1, JSON.stringify(items));
  assert.equal(items.filter(t => t === 'Agentes').length, 1, JSON.stringify(items));
  for (const gone of ['Pestañas activas', 'Integraciones y agentes']) assert(!items.includes(gone), `«${gone}» is not a sidebar entry any more: ${JSON.stringify(items)}`);
});

test('S32 gate: every Ajustes page that reads the host at load stays under the host\'s 30-calls-per-second limiter (no «No se pudo completar» on load)', async r => {
  await r.close();
  for (const title of ['Integraciones', 'Agentes', 'Chat', 'General', 'Atajos'].filter(t => !isPaused(t))) {
    const f = await H.open({ width: 960, height: 680 });
    try {
      await f.go(title); await f.page.waitForTimeout(1500);
      const out = await f.page.evaluate(() => ({ refused: window.__rateRefused || 0, text: (document.querySelector('.hub-page') || document.body).textContent.replace(/\s+/g, ' ') }));
      assert.equal(out.refused, 0, `${title}: the host refused ${out.refused} call(s) with rate-exceeded while the page loaded`);
      assert.doesNotMatch(out.text, /No se pudo completar|Rate exceeded|rate-exceeded/, `${title}: a failure notice shows at load`);
    } finally { await f.close(); }
  }
});

test('S32 gate: «Integraciones» and «Agentes» load with NO error notice when the OS keychain is unreachable (validator env) or has no keys', async r => {
  await r.close();
  for (const [label, scenario] of [['no keys stored', {}], ['keychain unreachable', { keychainDown: true }], ['keychain unreachable and agents not reported', { keychainDown: true, agentsOk: false }]]) {
    const f = await H.open({ width: 960, height: 680, ...scenario });
    try {
      for (const title of ['Integraciones', 'Agentes'].filter(t => !isPaused(t))) {
        await f.go(title); await f.page.waitForTimeout(900);
        const page = await f.page.evaluate(() => document.querySelector('.hub-page').textContent.replace(/\s+/g, ' '));
        assert.doesNotMatch(page, /No se pudo completar/, `${label}: ${title} shows a failure notice at load`);
        if (title === 'Integraciones') assert.match(page, /sin clave|No disponible todavía/, `${label}: a missing key is a state, not an error`);
      }
    } finally { await f.close(); }
  }
});

test('0.2.4 Agentes: unavailable main tool, CLI table and island switches; no AI-for-chat group, no creation buttons, no limit text', async r => {
  await r.go('Agentes');
  const page = await r.page.evaluate(() => { const root = document.querySelector('.hub-page'); return { text: root.textContent.replace(/\s+/g, ' '),
    heads: [...root.querySelectorAll('.hub-label, h2, h3, .hub-row .title')].map(e => e.textContent.trim()),
    agentRows: root.querySelectorAll('.agent-row:not(.agent-head)').length, serviceCards: root.querySelectorAll('.int-card').length,
    mainOptions: [...(root.querySelector('select[aria-label="Herramienta principal"]') || { options: [] }).options].map(o => o.textContent),
    buttons: [...root.querySelectorAll('button')].map(b => b.textContent.trim()), instructions: !!root.querySelector('#abito-instructions') }; });
  assert(!page.instructions, 'Abito instructions moved to General');
  assert.deepEqual(page.mainOptions, [], 'the main tool selector is unreachable');
  assert.doesNotMatch(page.text, /Herramienta principal/, 'HU-076: the unavailable main tool is hidden');
  assert.equal(page.agentRows, 6, `HU-076: Pi + Claude Code + Codex + Gemini CLI + Copilot CLI + OpenCode (${page.agentRows})`);
  assert.equal(page.serviceCards, 0, 'services live on Integraciones');
  for (const gone of ['Nuevo agente', 'Convertir en agente', 'Editar', 'Eliminar', 'Subir', 'Bajar']) assert(!page.buttons.includes(gone), `${gone} is gone`);
  const order = ['Agentes', 'Uso del plan', 'Especialistas'].map(h => page.heads.findIndex(x => x.toLowerCase().includes(h.toLowerCase())));
  assert(order.every(i => i >= 0), `sections present: ${JSON.stringify(page.heads)}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `sections in order: ${JSON.stringify(order)}`);
  assert.doesNotMatch(page.text, /IA para el chat|\d\/4|hasta 4|Pestañas activas|Vista previa|Codex · uso del plan/);
  assert.match(page.text, /Claude Code · uso del plan/);
  assert.doesNotMatch(page.text, /No disponible en esta versión/, 'HU-076: no greyed rows');
  assert.doesNotMatch(await r.page.evaluate(() => document.querySelector('.hub-page').innerText), /Koda agrega un relay/, 'HU-076: long explanations stay in the ⓘ, not visible at rest');
});

pageTest('Integraciones', '0.2.1 Integraciones: the services only, with the keychain explanation in an ⓘ', async r => {
  await r.go('Integraciones');
  const page = await r.page.evaluate(() => { const root = document.querySelector('.hub-page'); return { cards: root.querySelectorAll('.int-card').length, agentRows: root.querySelectorAll('.agent-row').length, tips: root.querySelectorAll('.hub-info').length, text: root.textContent }; });
  assert(page.cards >= 6, `services (${page.cards})`); assert.equal(page.agentRows, 0); assert(page.tips >= 1, 'the ⓘ is there');
});

test('0.2.1 ⓘ tip: hidden at rest, shown on hover AND on keyboard focus, hidden again on leave; Escape dismisses it', async r => {
  await r.go('Agentes');
  const tip = r.page.locator('.hub-info').first(), box = r.page.locator('.hub-info-wrap').first().locator('.hub-tip');
  assert.equal(await box.isVisible(), false);
  await tip.hover(); assert.equal(await box.isVisible(), true, 'hover shows it');
  await r.page.mouse.move(2, 2); assert.equal(await box.isVisible(), false, 'leaving hides it');
  await tip.focus(); assert.equal(await box.isVisible(), true, 'keyboard focus shows it');
  await r.page.keyboard.press('Escape'); assert.equal(await box.isVisible(), false, 'Escape dismisses it');
  assert.equal(await tip.getAttribute('aria-describedby'), await box.getAttribute('id'));
});

test('0.2.1 General (L2 A, S6) + HU-063 S2: General keeps Instrucciones + manual-open; recap on/off + clear, Colores and the «Ir a Atajos» link live in Isla; no plan switch here', async r => {
  const read = () => r.page.evaluate(() => { const root = document.querySelector('.hub-page'); return { text: root.textContent.replace(/\s+/g, ' '), ids: ['hub-recap', 'hub-recap-clear', 'abito-instructions', 'hub-open-at-launch'].map(id => !!root.querySelector('#' + id)),
    colors: root.querySelectorAll('[id^="identity-"]').length, editor: [...root.querySelectorAll('button')].some(b => b.textContent === 'Cambiar' || b.textContent === 'Original'), link: [...root.querySelectorAll('button')].some(b => b.textContent === 'Ir a Atajos') }; });
  await r.go('General');
  const general = await read();
  assert.deepEqual(general.ids, [false, false, true, true], 'General: Instrucciones + manual-open stay; recap moved to Isla');
  assert.equal(general.colors, 0, 'General: identity colours moved to Isla'); assert(!general.link, 'General: the shortcut link moved to Isla');
  await r.go('Isla');
  const page = await read();
  assert.deepEqual(page.ids.slice(0, 2), [true, true], 'Isla: recap on/off + clear');
  assert(page.colors > 0, 'Isla: identity colours'); assert(!page.editor && page.link, 'Isla: shortcut is only a value and a link');
  assert.doesNotMatch(page.text, /Mostrar plan|uso del plan|Modelo principal/);
});

test('0.2.1 Atajos: no weekly recap rows (they live in General)', async r => {
  await r.go('Atajos');
  assert.equal(await r.page.evaluate(() => document.querySelectorAll('#hub-recap, #hub-recap-clear').length), 0);
});

// HU-044 (human: «quiero todos los apartados colapsados por defecto» in Ajustes → Chat; supersedes the old open-by-default fold of
// 0.2.1 L2 A). Every apartado opens folded to its title row; a click opens it and it works as before. The engine banner is a status
// line, not an apartado, and stays visible. The open/closed state is a view state that survives the page repainting its cards.
const CHAT_APARTADOS = ['Claude', 'Google AI', 'OpenAI', 'OpenRouter', 'NaN', 'OpenCode Go', 'Pi', 'Otros endpoints', 'Modelos locales', 'Contexto de la ventana activa'];
const apartados = (page, titles) => page.evaluate(titles => titles.map(title => {
  const head = [...document.querySelectorAll('.hub-page h2, .hub-page .hub-label')].find(e => e.textContent.replace(/[▾▸]/g, '').trim().startsWith(title));
  const sec = head && head.closest('section');
  const fold = sec && sec.querySelector(':scope > :first-child .card-fold');
  const body = sec ? [...sec.children].slice(1).filter(c => !c.classList.contains('card-state')) : [];
  const shown = el => { if (!el) return false; const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.height > 0 && b.width > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  return { title, found: !!sec, fold: fold ? fold.getAttribute('aria-expanded') : null, bodyShown: body.some(shown), bodyCount: body.length, headShown: shown(head) };
}), titles);

test('HU-044 Chat opens with every apartado collapsed to its title row; the engine banner stays visible', async r => {
  await r.go('Chat'); await r.page.waitForTimeout(800);
  for (const a of await apartados(r.page, CHAT_APARTADOS)) {
    assert.equal(a.found, true, `${a.title}: apartado present`); assert.equal(a.headShown, true, `${a.title}: title row visible`);
    assert.equal(a.fold, 'false', `${a.title}: collapsed by default`); assert.equal(a.bodyShown, false, `${a.title}: nothing of its body is shown`);
  }
  assert.equal(await r.page.locator('#engine-status').isVisible(), true, 'the engine banner is a status line and stays visible');
});

test('HU-044 a click opens an apartado and it works as before; the state survives the page repainting (an agent state push)', async r => {
  await r.go('Chat'); await r.page.waitForTimeout(800);
  const google = r.page.locator('section.abito-card', { hasText: 'Google AI' }).first(), field = google.locator('input[id^="chat-key-"]');
  assert.equal(await field.isVisible(), false);
  await google.locator('.card-fold').click(); assert.equal(await field.isVisible(), true, 'opened: the key field is there');
  await field.fill('x'); assert.equal(await field.inputValue(), 'x', 'and usable');
  // the title row itself opens it too, not only the chevron
  const others = r.page.locator('section.abito-card', { hasText: 'Otros endpoints' }).first();
  await others.locator('h2').click(); assert.equal(await others.getByRole('button', { name: 'Configurar proveedor' }).isVisible(), true);
  const pi = r.page.locator('#provider-pi'); await pi.locator('h2').click(); assert.equal(await pi.getByRole('button', { name: /Conectar/ }).isVisible(), true);
  await r.page.evaluate(() => window.__emit('agent:state', { connection: 'connected' })); await r.page.waitForTimeout(600);
  const after = Object.fromEntries((await apartados(r.page, CHAT_APARTADOS)).map(a => [a.title, a.fold]));
  assert.equal(after['Otros endpoints'], 'true', 'Otros endpoints is still open after a repaint'); assert.equal(after.Pi, 'true', 'Pi is still open after a repaint');
  assert.equal(after['Google AI'], 'true'); assert.equal(after.Claude, 'false', 'the others stay as the human left them');
  await others.locator('.card-fold').click(); assert.equal(await others.getByRole('button', { name: 'Configurar proveedor' }).isVisible(), false, 'and it folds again');
});

test('0.2.1 Chat (L2 A) → HU-044: provider cards fold from their title row; they now START folded and the key field is there once opened', async r => {
  await r.go('Chat');
  const card = r.page.locator('section.abito-card', { hasText: 'Google AI' }).first(), fold = card.locator('.card-fold');
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  const field = card.locator('input[id^="chat-key-"]');
  assert.equal(await field.isVisible(), false);
  await fold.click(); assert.equal(await field.isVisible(), true, 'opened'); assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  await fold.click(); assert.equal(await field.isVisible(), false);
});

pageTest('OK Koda', '0.2.1 OK Koda (L2 A): the shared model, language and training are inside the Avanzado fold', async r => {
  await r.go('OK Koda');
  const adv = r.page.locator('#voice-advanced'); assert.equal(await adv.count(), 1);
  assert.equal(await adv.evaluate(d => d.open), false, 'closed by default');
  assert.equal(await r.page.evaluate(() => [...document.querySelectorAll('.hub-page .hub-label')].map(e => e.textContent).slice(0, 2).join('|')), 'Activación|Respuestas');
});

test('S5 Chat replaces Conexiones: engine first, provider rows inside the matching chat cards, extras before the reserved toggle slot', async r => {
  const titles = await r.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item')].map(e => e.textContent.trim()));
  assert(!titles.includes('Conexiones'), `FAIL S5: obsolete «Conexiones» entry in ${JSON.stringify(titles)}`);
  await r.go('Chat');
  assert.equal((await r.text('.hub-hero h1')).trim(), 'Chat');
  assert.equal(await r.page.locator('#chat-engine-slot-anthropic #provider-claude').count(), 1);
  assert.equal(await r.page.locator('#chat-engine-others #provider-pi').count(), 1);
  assert(await r.page.evaluate(() => !!(document.getElementById('chat-engine-others').compareDocumentPosition(document.getElementById('chat-extras')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  assert.equal(await r.page.locator('#engine-status button', { hasText: 'Reiniciar' }).count(), 1);
  assert.equal(await r.page.locator('#settings-filter').count(), 0);
  assert.doesNotMatch(await r.text('.hub-page'), /Configuración de proveedores|Conectores|Buscar proveedor/);
  // the first thing a person sees: the topmost visible element with an id inside the page
  const first = await r.page.evaluate(() => { const ids = [...document.querySelectorAll('#settings-root [id]')].filter(e => e.getBoundingClientRect().height > 0).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top); return ids[0] ? ids[0].id : null; });
  assert.equal(first, 'engine-status', 'the engine state comes first');
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('[id^="provider-"]')].map(e => e.id).sort()), ['provider-claude', 'provider-pi']);
});

test('S5 legacy accounts deep link lands on Chat, not on Dictado', async r => {
  await r.close();
  const f = await H.open({ width: 960, height: 680, page: 'accounts' });
  try {
    await f.shellAfter(); await f.page.waitForTimeout(700);
    const on = await f.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim()));
    assert.deepEqual(on, ['Chat'], `landed on ${JSON.stringify(on)}`);
    assert.equal((await f.text('.hub-hero h1')).trim(), 'Chat');
  } finally { await f.close(); }
});

test('S26 deep link on an ALREADY OPEN window: Rust sends abito:hub-select and the page changes; a foreign id is ignored', async r => {
  await r.go('General');
  await r.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:hub-select', { detail: 'accounts' }))); await r.page.waitForTimeout(500);
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim())), ['Chat']);
  for (const bad of ['../x', 'Accounts', '', 7, null, { detail: 'general' }, ['general']]) { await r.page.evaluate(b => document.dispatchEvent(new CustomEvent('abito:hub-select', { detail: b })), bad); await r.page.waitForTimeout(150); }
  assert.deepEqual(await r.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim())), ['Chat'], 'a foreign id never moves the window');
});

test('S26 deep link: an unknown or hostile page name falls back to the default page (the closed list decides)', async r => {
  await r.close();
  for (const bad of ['../x', 'accounts ', '<img>', 'constructor', '__proto__', '']) {
    const f = await H.open({ width: 960, height: 680, page: bad });
    try { await f.shellAfter(); await f.page.waitForTimeout(500);
      const on = await f.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item.on')].map(e => e.textContent.trim()));
      assert.deepEqual(on, ['General'], `${JSON.stringify(bad)} -> ${JSON.stringify(on)}`); }
    finally { await f.close(); }
  }
});

// Every Ajustes page, as the sidebar lists them. A card or input-looking box with nothing in it is a defect wherever it appears: the
// human found it three times (Pills, Integraciones, Conexiones), each time by eye, each time the same pattern (a card created before
// its children exist, then left empty by the state).
const PAGES = ['Dictado', 'Notetaker', 'Estadísticas', 'Diccionario', 'Fragmentos', 'Estilos', 'Ajustes', 'General', 'Integraciones', 'Agentes', 'Chat', 'OK Koda', 'Teléfono Android', 'Atajos'];
const EMPTY_BOXES = () => [...document.querySelectorAll('.hub-page .hub-card, .hub-page section, .hub-page .abito-card, .hub-page .hub-row, .hub-page .row')].filter(el => {
  const b = el.getBoundingClientRect(); if (b.width < 40 || b.height < 8) return false;               // not drawn
  if (el.querySelector('input, select, textarea, button, a, svg, canvas, img, .switch, .keycap, .swatch, .hub-segmented')) return false;
  const text = (el.textContent || '').replace(/\s+/g, '');                                            // text OR a control OR a graphic: otherwise it is just a box
  return text.length === 0;
}).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} in «${(el.closest('section') && el.closest('section').querySelector('.hub-label, h2') || { textContent: '(page)' }).textContent.trim().slice(0, 30)}» ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);

for (const [label, scenario] of [['a normal host', {}], ['a fresh install (no accounts, no agents reported, nothing connected)', { noAccounts: true, agentsOk: false }]]) {
  test(`no empty card or input-looking box anywhere in Ajustes (${label})`, async r => {
    await r.close();
    const f = await H.open({ width: 960, height: 680, ...scenario });
    try {
      const bad = [];
      for (const title of PAGES.filter(t => !isPaused(t))) { await f.go(title); await f.page.waitForTimeout(250); const found = await f.page.evaluate(EMPTY_BOXES); for (const x of found) bad.push(`[${title}] ${x}`); }
      assert.deepEqual(bad, [], `empty boxes: ${JSON.stringify(bad, null, 1)}`);
    } finally { await f.close(); }
  });
}

(async () => {
  PAUSED = [...(await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '../frontend/vendor/coucou/hub/shell.js')))).PAUSED_PAGES];
  let failed = 0;
  for (const [name, fn] of tests) {
    const r = await H.open({ width: 960, height: 680 });
    try { await fn(r); console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`not ok - ${name}\n  ${String(e.message).split('\n')[0]}`); }
    finally { await r.close(); }
  }
  if (failed) process.exitCode = 1; else console.log(`PASS settings-layout: ${tests.length} real-layout checks`);
})();
