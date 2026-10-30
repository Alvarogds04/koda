'use strict';
// 0.2.1 Ajustes T1 (S7, L1 «ícono de información… hover… desaparece»): the shared ⓘ tip.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, all } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { infoTip, withTip, notchTipRow } = await import(pathToFileURL(path.join(base, 'notch.js')));
  const wrap = infoTip('Explicación larga.', 'Más información: algo');
  const [btn, tip] = wrap.children;
  assert.equal(btn.tagName, 'button'); assert.equal(btn.attrs.type, 'button');
  assert.equal(btn.attrs['aria-label'], 'Más información: algo');
  assert.equal(tip.attrs.role, 'tooltip'); assert.equal(tip.textContent, 'Explicación larga.');
  assert.equal(btn.attrs['aria-describedby'], tip.attrs.id, 'the button is described by its tip (keyboard + screen readers)');
  assert.notEqual(infoTip('x').children[1].attrs.id, tip.attrs.id, 'ids are unique per tip');
  // Escape dismisses while focused; leaving or blurring re-arms it
  btn.fire('keydown', true, { key: 'Enter', stopPropagation() {} }); assert(!wrap.classList.contains('dismissed'));
  btn.fire('keydown', true, { key: 'Escape', stopPropagation() {} }); assert(wrap.classList.contains('dismissed'));
  btn.fire('blur'); assert(!wrap.classList.contains('dismissed'));
  btn.fire('keydown', true, { key: 'Escape', stopPropagation() {} }); wrap.fire('mouseleave'); assert(!wrap.classList.contains('dismissed'));
  // the explanation is NOT standing copy: the visible row text is only the short title
  const row = notchTipRow('Tema', 'Oscuro, claro o el del sistema.');
  assert.equal(row.children[0].textContent, 'Tema');
  assert.equal(all(row).filter(e => e.className === 'hint').length, 0);
  assert.equal(all(row).filter(e => e.attrs.role === 'tooltip').length, 1);
  assert.equal(all(notchTipRow('Tema', null)).filter(e => e.attrs.role === 'tooltip').length, 0);
  assert.equal(withTip('Título', 'ayuda').children.length, 2);
  // CSS: shown on hover and keyboard focus, hidden otherwise
  const css = fs.readFileSync(path.join(base, 'abito.css'), 'utf8');
  assert(/\.hub-tip\s*\{[^}]*display:\s*none/.test(css));
  assert(/\.hub-info-wrap:hover\s*>\s*\.hub-tip/.test(css) && /\.hub-info-wrap:focus-within\s*>\s*\.hub-tip/.test(css));
  assert(/\.hub-info:focus-visible/.test(css));
  console.log('hub-tip-check OK');
})().catch(e => { console.error(e); process.exit(1); });
