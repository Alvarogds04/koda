'use strict';
/* welcome-home (human, 16-nov: «eso solo tiene que salir si entro en conversaciones»): the engine/account notice is NOT drawn in the island any more; it lives inside
   the chat. With no account the chat shows «Sin cuenta» and a «Configurar» button that opens the account settings; with a healthy engine it shows nothing.
   Real DOM, real layout. The button is clicked FOR REAL (a script's click is not trusted). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED chat-engine-note-check: no playwright — NOT a pass'); process.exit(0); }
const read = r => r.page.evaluate(() => { const n = document.getElementById('chat-engine-note'); if (!n) return null; const b = n.querySelector('button'), s = getComputedStyle(n);
  return { hidden: n.hidden, display: s.display, text: n.textContent.replace(/\s+/g, ' ').trim(), btn: b ? b.textContent.trim() : null, aria: b ? b.getAttribute('aria-label') : null }; });
(async () => {
  for (const [engine, label, btn] of [['account', 'Sin cuenta', 'Configurar'], ['down', 'Sin motor', 'Revisar']]) {
    const r = await H.open({ engine });
    try {
      await r.page.waitForTimeout(1200);
      const n = await read(r);
      assert.ok(n, `${engine}: the chat has an engine note`);
      assert.equal(n.hidden, false, `${engine}: the note is shown: ${JSON.stringify(n)}`);
      assert.ok(n.text.includes(label), `${engine}: it says «${label}»: ${JSON.stringify(n)}`);
      assert.equal(n.btn, btn, `${engine}: its button is «${btn}»`);
      assert.ok(n.aria && n.aria.length > 3, `${engine}: the button has an accessible name`);
      if (engine === 'account') { // the button works: a real click asks Ajustes → Proveedores, with no spy and no preventDefault
        await r.page.evaluate(() => { window.__sel = []; document.addEventListener('abito:settings-select', e => window.__sel.push(e.detail)); const n = document.getElementById('chat-engine-note'); document.body.appendChild(n); Object.assign(n.style, { position: 'fixed', left: '20px', top: '20px', zIndex: '99999' }); }); // the chat panel is closed in this harness: lift the note itself, listeners stay on its button
        await r.page.click('#chat-engine-note button'); await r.page.waitForTimeout(300);
        assert.deepEqual(await r.page.evaluate(() => window.__sel), ['accounts:proveedores'], 'the button asks for the providers settings');
      }
    } finally { await r.close(); }
  }
  // human, 16-nov, on his real Koda: «si le escribo no me sale eso». His storage still held the old island band's «Omitir» (abito.engineOmit = account) and the chat
  // honoured it, so the notice never showed. That Omitir belonged to the island band, which is gone; the chat note is the one place the notice lives now, so it
  // must show whatever that legacy key says.
  const om = await H.open({ engine: 'account' });
  try {
    await om.page.evaluate(() => localStorage.setItem('abito.engineOmit', 'account'));
    await om.page.waitForTimeout(300);
    await om.page.evaluate(() => document.dispatchEvent(new CustomEvent('abito:pi-state', { detail: { connection: 'connected', accounts: [] } })));
    await om.page.waitForTimeout(800);
    const n = await read(om);
    assert.equal(n.hidden, false, 'a legacy island «Omitir» does not hide the chat notice: ' + JSON.stringify(n));
    assert.ok(n.text.includes('Sin cuenta'), 'and it still says «Sin cuenta»: ' + JSON.stringify(n));
  } finally { await om.close(); }
  const ok = await H.open({ engine: 'ok' });
  try { await ok.page.waitForTimeout(1200); const n = await read(ok); assert.ok(n && (n.hidden || n.display === 'none'), 'a healthy engine: the chat shows no note: ' + JSON.stringify(n)); } finally { await ok.close(); }
  console.log('chat-engine-note-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
