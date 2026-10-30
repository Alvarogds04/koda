'use strict';
// Koda 0.1 T2 (human: «Todo se llama Koda, repo nuevo desde 0.1», «Solo lo visible»): the product name shown in Ajustes is «Koda».
// Real settings.html in headless Chromium, every sidebar page, dark AND light: no visible text/attribute may match /abito/i
// except a tiny allow-list of strings that are never product copy (gateway model id, fixture names, real paths, env var names).
const assert = require('node:assert/strict');
const { open } = require('./settings-layout-harness.cjs');

const ALLOW = [/^Abito-gpt$/, /^abito-(web|docs)$/, /abito-island/, /%LOCALAPPDATA%\\Abito/, /\bABITO_[A-Z_]+\b/];
const walk = () => {
  const hits = [];
  const vis = el => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden') return false; } return true; };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
    if (/abito/i.test(n.nodeValue)) hits.push(['text', n.nodeValue.trim().slice(0, 120), p.className || p.tagName]);
  }
  for (const el of document.querySelectorAll('*')) for (const a of ['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'data-tip', 'data-title'])
    { const v = el.getAttribute(a); if (v && /abito/i.test(v)) hits.push([a, v.slice(0, 120), el.className || el.tagName]); }
  for (const el of document.querySelectorAll('input,textarea')) if (/abito/i.test(el.value || '') && el.type !== 'hidden') hits.push(['value', el.value.slice(0, 120), el.className]);
  if (/abito/i.test(document.title)) hits.push(['document.title', document.title, '']);
  return hits;
};

(async () => {
  const H = await open({ agentsOk: true });
  if (!H) { console.log('SKIPPED: playwright is not installed (dev tool)'); process.exit(0); }
  const shots = process.env.KODA_SHOTS === '1';
  const all = [];
  try {
    await H.shellAfter();
    const titles = await H.page.evaluate(() => [...document.querySelectorAll('.hub-side .hub-item')].map(e => (e.textContent || '').trim()));
    assert.ok(titles.length >= 6, `sidebar lists the pages (got ${JSON.stringify(titles)})`);
    assert.ok(!/abito/i.test(await H.page.title()), 'document.title has no Abito (the native window title is set by Rust)');
    for (const theme of ['dark', 'light']) {
      await H.page.emulateMedia({ colorScheme: theme });
      for (const title of titles) {
        await H.go(title); await H.page.waitForTimeout(150);
        const hits = (await H.page.evaluate(walk)).filter(h => !ALLOW.some(r => r.test(h[1])));
        for (const h of hits) all.push(`[${theme}/${title}] ${h[0]}: «${h[1]}» (${h[2]})`);
        if (shots && /^(General|Agentes|Chat|Atajos|Privacidad|Isla)/.test(title)) await H.screenshot(`/tmp/koda-rename/ajustes-${title.replace(/\W+/g, '_')}-${theme}.png`);
      }
    }
    const footer = await H.page.evaluate(() => { const f = document.querySelector('.hub-side .hub-foot, .hub-side .hub-version, .hub-side footer'); return f ? f.textContent.trim() : (document.querySelector('.hub-side').innerText.trim().split('\n').pop()); });
    if (!/^Koda\b/.test(footer)) all.push(`sidebar footer must start with Koda (got «${footer}»)`);
    await H.go('General');
    const sub = await H.page.evaluate(() => (document.querySelector('#hub .hub-hero')?.textContent || ''));
    if (!/Koda/.test(sub)) all.push(`General subtitle must name Koda (got «${sub.slice(0, 120)}»)`);
    if (all.length) { console.error(`visible «Abito» hits (${all.length}):\n${[...new Set(all)].join('\n')}`); process.exit(1); }
    console.log('settings-visible-name-check: ok');
  } finally { await H.close(); }
})().catch(e => { console.error(e); process.exit(1); });
