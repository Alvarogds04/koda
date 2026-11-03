'use strict';
/* S4 (human plan, approved 3 Nov: K2-02 decision 3a): Koda now ships its own Node and Pi
   (T1/T2), so the «Instalar Pi» and «Instalar Node» controls are REMOVED from Ajustes and
   their code is gone. This check is the RED-first proof (written BEFORE the removal): it
   opens the REAL Ajustes (headless Chromium, the real settings.html + scripts, a fake host)
   on the Chat and Agents pages — with the engine reporting Pi missing and with it connected —
   and asserts that no install control renders and that the closed `pi_install_action`
   command no longer exists anywhere in the shipped frontend.
   Run: node test-node/no-install-buttons-check.cjs  (SKIPs loudly without playwright). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./settings-layout-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED no-install-buttons-check: playwright is not installed here (no real layout engine) — NOT a pass'); process.exit(0); }

const FORBIDDEN = ['Instalar Pi', 'Instalar Node'];

async function assertNoInstallControls(page, title) {
  assert.equal(await page.locator('#pi-install').count(), 0, `${title}: no «Instalar Pi» control (#pi-install) is rendered`);
  // The whole rendered document, so hidden nodes, aria-labels and titles count too.
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  for (const word of FORBIDDEN) assert.ok(!html.includes(word), `${title}: «${word}» appears nowhere on the page`);
}

async function assertStaticFrontendIsClean() {
  const frontend = path.join(__dirname, '..', 'frontend');
  const settingsApp = fs.readFileSync(path.join(frontend, 'settings-app.js'), 'utf8');
  assert.ok(!settingsApp.includes('pi_install_action'), 'settings-app.js: the closed pi_install_action command is gone from the allowed set and its schema');
  for (const f of ['accounts.js', 'agents.js']) {
    const src = fs.readFileSync(path.join(frontend, 'vendor/coucou/hub', f), 'utf8');
    assert.ok(!/piinstall|piInstallControl|pi_install_action/.test(src), `${f}: no install-control code left`);
  }
}

(async () => {
  await assertStaticFrontendIsClean();
  // Engine reports Pi missing: the pages where «Instalar Pi» used to live.
  let f = await H.open({ width: 960, height: 760, piMissing: true });
  try {
    await f.go('Chat'); await f.page.waitForTimeout(1000);
    await assertNoInstallControls(f.page, 'Chat (Pi missing)');
    await f.go('Agentes'); await f.page.waitForTimeout(1000);
    await assertNoInstallControls(f.page, 'Agentes (Pi missing)');
  } finally { await f.close(); }
  // Engine connected: neither page ever showed the control; now neither may exist at all.
  f = await H.open({ width: 960, height: 760 });
  try {
    await f.go('Chat'); await f.page.waitForTimeout(1000);
    await assertNoInstallControls(f.page, 'Chat (connected)');
    await f.go('Agentes'); await f.page.waitForTimeout(1000);
    await assertNoInstallControls(f.page, 'Agentes (connected)');
  } finally { await f.close(); }
  console.log('no-install-buttons-check: OK — no «Instalar Pi» / «Instalar Node» control on Chat or Agentes, and pi_install_action is gone from the frontend');
})().catch(error => { console.error(`no-install-buttons-check FAILED: ${error.message}`); process.exit(1); });
