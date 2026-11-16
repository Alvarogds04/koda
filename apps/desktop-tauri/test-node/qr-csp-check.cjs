'use strict';
/* The pairing QR is drawn as an <img> whose src is a data: URL (pages.ts phonePage). The node page tests use a fake DOM that never applies the app's
   Content-Security-Policy, so for two releases the QR was blocked in the real window and showed as a blank white box. This test applies the REAL policy
   from tauri.conf.json in a real browser: the image must load, and the policy must stay closed everywhere else. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./island-geometry-harness.cjs');
const csp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tauri.conf.json'), 'utf8')).app.security.csp;
const dir = name => ((new RegExp(`(?:^|;)\\s*${name} ([^;]*)`).exec(csp) || [])[1] || '').trim();
// the policy stays closed: scripts only from us, no remote or wildcard source, and the image directive is exactly «'self' data:» (nothing wider)
assert.equal(dir('script-src'), "'self'", 'scripts stay «self» only');
assert.equal(dir('img-src'), "'self' data:", 'images: self and data: URLs only (the QR), never http(s) or *');
assert.ok(!/unsafe-|https?:|\*/.test(csp.replace('http://ipc.localhost', '')), 'no unsafe, remote or wildcard source');
for (const d of ['object-src', 'frame-src', 'base-uri']) assert.equal(dir(d), "'none'", d + ' stays none');
if (!H.findPlaywright()) { console.log('SKIPPED qr-csp-check browser part: no playwright — NOT a pass'); process.exit(0); }
(async () => {
  const br = await H.findPlaywright().chromium.launch({ args: ['--no-sandbox'] });
  try {
    // the markup the host hands out is UTF-8 SVG; pages.ts encodes it exactly like this
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#fff"/><rect width="3" height="3" fill="#000"/><desc>código</desc></svg>';
    const src = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    const page = await br.newPage();
    await page.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}"><img id="qr" style="width:168px;height:168px" src="${src}" alt="Código QR para emparejar">`);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => { const i = document.getElementById('qr'); return { complete: i.complete, w: i.naturalWidth }; });
    assert.ok(r.complete && r.w > 0, 'the QR image loads under the real CSP of the app (naturalWidth ' + r.w + '); blocked = a blank white box');
    // and the policy still refuses a script from a data: URL
    const ran = await page.evaluate(() => new Promise(res => { window.__x = false; const s = document.createElement('script'); s.src = 'data:text/javascript,window.__x=true'; s.onload = s.onerror = () => setTimeout(() => res(window.__x), 100); document.head.append(s); }));
    assert.equal(ran, false, 'a data: script does not run');
    await page.close();
  } finally { await br.close(); }
  console.log('qr-csp-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
