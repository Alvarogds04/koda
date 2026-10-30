#!/usr/bin/env node
// Visual comparator: Coucou (reference tree, Vite) vs Abito (this frontend, static), same fixtures, same viewport.
// Usage: node run.mjs [--eval <coucou windows dir>] [--out /tmp/visual-compare/report] [--only id,id] [--port 9222]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { connect, sleep } from './cdp.mjs';
import { decode, encode, diff, sideBySide, contentBox, crop } from './png.mjs';
import { buildStates } from './states.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const evalDir = arg('eval', join(os.homedir(), 'Apps/abito-next/eval/windows'));
const out = arg('out', '/tmp/visual-compare/report');
const only = arg('only', '') ? arg('only', '').split(',') : null;
const frontend = resolve(here, '../../frontend');
const fix = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));
const BG = [128, 128, 128];
// Ports and the harness page name are per run, so several runs (other worktrees) can coexist.
const VITE_PORT = Number(arg('vite-port', 14421)), ABITO_PORT = Number(arg('abito-port', 14422));
const HARNESS = `compare-${process.pid}`;

const mockCore = readFileSync(join(here, 'mock-core.js'), 'utf8');
const mockCoucou = readFileSync(join(here, 'mock-coucou.js'), 'utf8');
const mockAbito = readFileSync(join(here, 'mock-abito.js'), 'utf8');
const pre = (side, label, extra) => `window.__VC_FIX=${JSON.stringify(fix)};window.__VC_LABEL=${JSON.stringify(label)};${extra || ''}\n${mockCore}\n${side === 'coucou' ? mockCoucou : mockAbito}`;
const flatBg = 'document.addEventListener("DOMContentLoaded",()=>{const s=document.createElement("style");s.textContent="html,body{background:#808080 !important}";document.head.append(s)});';

// ── servers ──
function staticServer(root, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
  const s = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const f = join(root, p);
    if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(f));
  });
  return new Promise((r) => s.listen(port, '127.0.0.1', () => r(s)));
}
async function startVite() {
  mkdirSync(join(evalDir, 'dev'), { recursive: true });
  copyFileSync(join(here, 'coucou-dev/compare.html'), join(evalDir, `dev/${HARNESS}.html`));
  copyFileSync(join(here, 'coucou-dev/compare.ts.tmpl'), join(evalDir, `dev/${HARNESS}.ts`));
  writeFileSync(join(evalDir, `dev/${HARNESS}.html`), readFileSync(join(evalDir, `dev/${HARNESS}.html`), 'utf8').replace('./compare.ts', `./${HARNESS}.ts`));
  const proc = spawn(join(evalDir, 'node_modules/.bin/vite'), ['--port', String(VITE_PORT), '--host', '127.0.0.1', '--strictPort'], { cwd: evalDir, stdio: 'pipe' });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${VITE_PORT}/dev/${HARNESS}.html`); return proc; } catch { await sleep(500); } }
  proc.kill(); throw new Error('vite did not start');
}

async function shot(browser, st, side) {
  const spec = st[side]; if (!spec) return null;
  const page = await browser.openPage({ width: st.w, height: st.h });
  try {
    const settings = spec.settings ? `window.__VC_SETTINGS=${JSON.stringify(spec.settings)};` : '';
    if (side === 'coucou') {
      await page.addInitScript(pre('coucou', spec.page === 'settings' ? 'settings' : 'main', settings));
      if (spec.page === 'island' || spec.page === 'pill') await page.addInitScript(flatBg);
      await page.goto(`http://127.0.0.1:${VITE_PORT}/${spec.page === 'settings' ? 'settings.html' : spec.page === 'pill' ? 'pill.html' : `dev/${HARNESS}.html`}`);
      if (spec.page === 'island') for (let i = 0; i < 40 && !(await page.eval('!!window.__vcReady')); i++) await sleep(250);
      else await sleep(1500);
    } else {
      await page.addInitScript(pre('abito', spec.label, settings));
      if (spec.label === 'main') await page.addInitScript(flatBg);
      await page.goto(`http://127.0.0.1:${ABITO_PORT}/${spec.url || 'index.html'}`);
      await sleep(1200);
    }
    await page.eval(spec.run);
    if (spec.click) { await sleep(800); await page.click(spec.click); }
    await sleep(spec.settle || (side === 'coucou' ? 1800 : 1500));
    const png = await page.screenshot();
    const probe = spec.probe ? await page.eval(spec.probe).catch((e) => String(e)) : null;
    const unmocked = await page.eval('JSON.stringify(window.__vcUnmocked||[])').catch(() => '[]');
    return { probe, png, logs: page.logs.slice(0, 8), unmocked: JSON.parse(unmocked) };
  } finally { await page.close().catch(() => {}); }
}

mkdirSync(out, { recursive: true });
const states = buildStates(fix).filter((s) => !only || only.includes(s.id));
const vite = await startVite();
const abitoSrv = await staticServer(frontend, ABITO_PORT);
const browser = await connect(Number(arg('port', 9222)));
const rows = [];
try {
  for (const st of states) {
    const dir = join(out, st.id); mkdirSync(dir, { recursive: true });
    const c = await shot(browser, st, 'coucou').catch((e) => ({ error: String(e) }));
    const a = await shot(browser, st, 'abito').catch((e) => ({ error: String(e) }));
    const row = { id: st.id, title: st.title, w: st.w, h: st.h, expected: st.expected || '', notes: [] };
    if (c?.png) writeFileSync(join(dir, 'coucou.png'), c.png);
    if (a?.png) writeFileSync(join(dir, 'abito.png'), a.png);
    for (const [k, v] of [['coucou', c], ['abito', a]]) { if (v?.probe) row.notes.push(`${k} probe: ${v.probe}`); if (v?.error) row.notes.push(`${k}: ${v.error}`); if (v?.logs?.length) row.notes.push(`${k} logs: ${v.logs.join(' | ')}`); if (v?.unmocked?.length) row.notes.push(`${k} unmocked: ${[...new Set(v.unmocked)].slice(0, 6).join('; ')}`); }
    if (c?.png && a?.png) {
      const ci = decode(c.png), ai = decode(a.png);
      const d = diff(ci, ai);
      writeFileSync(join(dir, 'diff.png'), encode(d.img));
      writeFileSync(join(dir, 'side-by-side.png'), encode(sideBySide(ci, ai)));
      row.mismatch = d.mismatch * 100;
      if (st.coucou.page === 'island') {
        row.coucouBox = contentBox(ci, BG); row.abitoBox = contentBox(ai, BG);
        // Island-only mode: each capture cropped to its island's bounding box, so a different window
        // offset (e.g. y=8 vs y=0) does not count; a different island SIZE still does (the smaller one is padded as missing).
        if (row.coucouBox && row.abitoBox) {
          const ca = crop(ci, row.coucouBox), cb = crop(ai, row.abitoBox);
          const d2 = diff(ca, cb);
          writeFileSync(join(dir, 'island-diff.png'), encode(d2.img));
          writeFileSync(join(dir, 'island-side-by-side.png'), encode(sideBySide(ca, cb)));
          row.islandMismatch = d2.mismatch * 100;
        }
      }
    } else {
      row.mismatch = 100; row.missing = !c?.png ? 'coucou' : 'abito';
      if (!st.abito) row.notes.push('Abito has no counterpart page for this Coucou page (missing feature).');
      if (!st.coucou) row.notes.push('Coucou has no such page.');
    }
    rows.push(row);
    console.log(`${st.id.padEnd(22)} ${row.mismatch.toFixed(2)}%${row.islandMismatch !== undefined ? ' island-only ' + row.islandMismatch.toFixed(2) + '%' : ''}${row.missing ? ' (missing ' + row.missing + ')' : ''}`);
  }
} finally {
  browser.close(); abitoSrv.close(); vite.kill();
  rmSync(join(evalDir, `dev/${HARNESS}.html`), { force: true }); rmSync(join(evalDir, `dev/${HARNESS}.ts`), { force: true });
}
rows.sort((x, y) => y.mismatch - x.mismatch);
writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 1));
const box = (b) => (b ? `${b.x},${b.y} ${b.w}×${b.h}` : '—');
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset=utf-8><title>Coucou vs Abito</title>
<style>body{font:14px system-ui;background:#16181d;color:#e8e9ec;margin:24px}table{border-collapse:collapse}td,th{padding:6px 10px;border-bottom:1px solid #333;text-align:left;vertical-align:top}
img{max-width:100%;border:1px solid #444}.pct{font-weight:700}h2{margin-top:36px}small{color:#9aa}</style>
<h1>Coucou vs Abito — visual comparison</h1><p>Sorted by mismatch (worst first). Pixel counts as different when a channel moves &gt; 24/255.</p>
<table><tr><th>State</th><th>Full capture</th><th>Island only</th><th>Island box Coucou</th><th>Island box Abito</th><th>Notes</th></tr>
${rows.map((r) => `<tr><td><a href="#${r.id}">${r.title}</a></td><td class=pct>${r.mismatch.toFixed(2)}%</td><td class=pct>${r.islandMismatch !== undefined ? r.islandMismatch.toFixed(2) + '%' : '—'}</td><td>${box(r.coucouBox)}</td><td>${box(r.abitoBox)}</td><td><small>${[r.expected, ...r.notes].filter(Boolean).join('<br>')}</small></td></tr>`).join('')}</table>
${rows.map((r) => `<h2 id="${r.id}">${r.title} — ${r.mismatch.toFixed(2)}% <small>${r.w}×${r.h}</small></h2>${r.missing ? `<p>Missing on the ${r.missing} side.</p>` : ''}
${['side-by-side', 'diff', 'island-side-by-side', 'island-diff'].map((n) => existsSync(join(out, r.id, n + '.png')) ? `<p>${n}</p><img src="${r.id}/${n}.png">` : '').join('')}
${r.missing ? ['coucou', 'abito'].map((n) => existsSync(join(out, r.id, n + '.png')) ? `<p>${n}</p><img src="${r.id}/${n}.png">` : '').join('') : ''}`).join('')}`);
console.log(`\nreport: ${join(out, 'index.html')}`);
