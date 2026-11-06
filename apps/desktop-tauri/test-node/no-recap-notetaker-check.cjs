'use strict';
// K2-03 S1: «Dado que abro Koda, cuando recorro la isla y todas las pantallas de Ajustes, entonces no aparece Recap ni
// Notetaker en ningún lado.» Recap (weekly summary) and the Notetaker placeholder are removed, not paused: no page, no row,
// no card, no string, no host verb, no installable integration. Same files on Linux, macOS and Windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const app = path.resolve(__dirname, '..');
const frontend = path.join(app, 'frontend');
const FORBIDDEN = /recap|notetaker|resumen semanal/i;
// Allowlist, exact line only: «Resumen semanal» here is the NAME of a sample n8n workflow shown on the paused n8n
// integration page (fixture data). It is unrelated to the removed Recap feature; any other match still fails.
const NOT_RECAP = new Set(["frontend/integrations-n8n.js:['ej-3', 'Resumen semanal', 'running', 30000, 12000, ''],"]);
let passed = 0;
const test = async (_n, fn) => { await fn(); passed += 1; };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

(async () => {
  await test('every shipped island and Ajustes file (html, js, css, ts) is free of Recap and Notetaker', () => {
    const hits = walk(frontend).filter(f => /\.(html|js|css|ts|json)$/.test(f))
      .flatMap(f => fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l, i) => [f, i + 1, l]))
      .filter(([f, , l]) => FORBIDDEN.test(l) && !NOT_RECAP.has(`${path.relative(app, f).split(path.sep).join('/')}:${l.trim()}`))
      .map(([f, i, l]) => `${path.relative(app, f)}:${i}: ${l.trim().slice(0, 120)}`);
    assert.deepEqual(hits, [], 'Recap/Notetaker still reachable in the frontend');
  });
  await test('Ajustes has no Notetaker page: the hub page list has no «notes»', async () => {
    global.document = { createElement: () => ({}), documentElement: { lang: 'es' } };
    const shell = await import(pathToFileURL(path.join(frontend, 'vendor', 'coucou', 'hub', 'shell.js')));
    const ids = [...shell.FLOW_PAGES, ...shell.NOTCH_PAGES].map(p => p.id);
    assert.ok(!ids.includes('notes'), `hub pages: ${ids.join(',')}`);
  });
  await test('Ajustes cannot install a recap integration and never calls a recap verb', () => {
    const S = require(path.join(frontend, 'settings-view.js'));
    assert.ok(!S.AGENT_IDS.includes('recap'), `AGENT_IDS: ${S.AGENT_IDS.join(',')}`);
    const entry = fs.readFileSync(path.join(frontend, 'settings-app.js'), 'utf8');
    assert.doesNotMatch(entry.match(/const allowed = new Set\(([^;]+)\);/)[1], /recap/);
  });
  await test('the island host has no recap command, store or agent id', () => {
    const src = path.join(app, 'src');
    // The ONE exception is deliberate (K2-03 S2/S4): legacy_recap.rs deletes the removed feature's data on upgrade. It is
    // not Recap; it only removes recap.json, its corrupt copies and the spool. Anything else named recap fails.
    const LEGACY = ['legacy_recap.rs', 'legacy_recap_tests.rs'];
    assert.deepEqual(fs.readdirSync(src).filter(f => /recap/i.test(f) && !LEGACY.includes(f)), [], 'no recap*.rs module');
    for (const f of ['main.rs', 'lib.rs', 'settingswindow.rs', 'agentclient.rs']) {
      const text = fs.readFileSync(path.join(src, f), 'utf8').replace(/legacy_recap/g, '').replace(/K2-03 T3 \(S2, S4\): delete the removed weekly Recap's data[^\n]*/g, '');
      assert.doesNotMatch(text, /recap/i, f);
    }
  });
  console.log(`no-recap-notetaker-check: ${passed} checks ok`);
})().catch(e => { console.error(e); process.exit(1); });
