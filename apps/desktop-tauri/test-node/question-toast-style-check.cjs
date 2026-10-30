'use strict';
/* HU-063 S3 (direction B): the question toast's accent is the ASKER's colour; amber = permission / waiting for a yes, red = error
   outcome, neutral = finished. Pure helper + the stylesheet contract. Run: node test-node/question-toast-style-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const T = require(path.join(frontend, 'question-toast.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
const ID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const NOW = 1_000_000;
const pending = (over = {}) => ({ id: ID, kind: 'question', text: '¿Café o té?', agent: 'pi', allow_free_text: false,
  options: [{ index: 0, label: 'Café', description: '' }, { index: 1, label: 'Té', description: '' }], expires_at: NOW + 60000, ...over });
const snap = (over = {}) => ({ available: true, pending: pending(), queued: [], queued_count: 0, notice: null, ...over });
const HEX = /^#[0-9a-f]{6}$/;

test('agentAccent maps the agent colours; unknown / hostile / non-string slugs fall back to the default blue', () => {
  assert.equal(T.agentAccent('pi'), '#2dffac');
  assert.equal(T.agentAccent('claude-code'), '#b04dff');
  assert.equal(T.agentAccent('codex'), '#f472b6');
  assert.equal(T.agentAccent('gemini'), '#4d9fff');
  for (const bad of ['', 'PI', 'pi; background:red', 'x'.repeat(40), '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 7, {}, ['pi']]) {
    assert.equal(T.agentAccent(bad), '#4d9fff', `fallback for ${JSON.stringify(bad)}`);
  }
});

test('toastView carries the asker slug and its accent; a permission is amber, whoever asks', () => {
  const q = T.toastView(snap({ pending: pending({ agent: 'claude-code' }) }), { now: NOW });
  assert.deepEqual([q.agent, q.role, q.accent], ['claude-code', 'agent', '#b04dff']);
  const pi = T.toastView(snap(), { now: NOW });
  assert.deepEqual([pi.agent, pi.role, pi.accent], ['pi', 'agent', '#2dffac']);
  const p = T.toastView(snap({ pending: pending({ kind: 'approval', agent: 'codex' }) }), { now: NOW });
  assert.deepEqual([p.agent, p.role, p.accent, p.tone], ['codex', 'sun', '#ffe100', 'warning']);
  assert.match(q.accent, HEX);
});

test('role colours: finished neutral, attention amber, disconnected red, busy amber, other outcomes neutral', () => {
  const fin = T.finishedToast({ id: 'n1', title: 'Listo', agent: 'codex', projectName: 'api', kind: 'settled' });
  assert.deepEqual([fin.role, fin.accent], ['neutral', T.ROLE_ACCENT.neutral]);
  const att = T.attentionToast({ id: 'n2', kind: 'attention', title: 'Codex te pide permiso' });
  assert.deepEqual([att.role, att.accent], ['sun', '#ffe100']);
  const o = (outcome, agent) => T.outcomeToast({ outcome, agent }, 1);
  assert.deepEqual([o('disconnected', 'pi').role, o('disconnected', 'pi').accent], ['red', '#ff5c75']);
  assert.equal(o('busy', 'pi').role, 'sun');
  assert.equal(o('expired', 'pi').role, 'neutral');
  assert.equal(o('cancelled', 'pi').role, 'neutral');
  for (const v of [fin, att, o('expired', 'pi')]) assert.match(v.accent, HEX);
});

test('stylesheet: black body in both themes, Abito scale 13/12/11, accent drives dot / progress, size contract untouched', () => {
  const css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.match(css, /\.q-toast-neck, \.q-toast-pill, \.q-toast-bodyrect \{ fill: #000; \}/, 'the shape is pure black, not the themed --island');
  assert.match(css, /\.q-toast-title \{[^}]*font-size: 13px/);
  assert.match(css, /\.q-toast-body \{[^}]*font-size: 12px/);
  assert.match(css, /\.q-toast-queue \{[^}]*font-size: 11px/);
  assert.match(css, /\.q-toast-progress \{[^}]*background: var\(--q-accent/);
  assert.match(css, /\.q-toast-dot\b[^}]*background: var\(--q-accent/);
  assert.match(css, /width:\s*350px/); assert.match(css, /height:\s*96px/);
  assert.doesNotMatch(css, /rgba?\(0, 0, 0, 0?\.\d+\)\s*;?\s*\}\s*\.q-toast-bodyrect/);
});

test('TOAST numbers are the reported input-area contract', () => {
  assert.deepEqual([T.TOAST.w, T.TOAST.h, T.TOAST.hMax], [350, 40, 96]);
});

// ---- real layout (Playwright; SKIPPED loudly when absent): island concealed, the toast alone on screen -----------------------------
const H = require('./island-geometry-harness.cjs');
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const parse = c => { const q = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c); if (q) return { rgb: [+q[1] * 255, +q[2] * 255, +q[3] * 255], a: q[4] === undefined ? 1 : +q[4] }; const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c); return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null; };
const over = (fg, bg) => fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a)); // composite on the opaque body fill
async function layout() {
  if (!H.findPlaywright()) { console.log('SKIPPED question-toast-style-check (real layout): no playwright — NOT a pass'); return 0; }
  let n = 0;
  const cases = [['plain', 'pi', '#2dffac'], ['multi', 'pi', '#2dffac'], ['form', 'pi', '#2dffac'], ['approvalPi', 'pi', '#ffe100'], ['codex', 'codex', '#f472b6']];
  for (const theme of ['dark', 'light']) for (const [q, agent, accent] of cases) {
    const r = await H.open({ question: q === 'codex' ? 'plain' : q, theme, quick: true });
    try {
      await r.page.evaluate(() => window.__islandSetState('compact')); await r.page.waitForTimeout(700);
      if (q === 'codex') await r.page.evaluate(({ id }) => window.__emit('question:state', { available: true, queued: [], queued_count: 0, deliveries: [], notice: null,
        pending: { id, kind: 'question', agent: 'codex', agent_label: 'Codex', project_name: 'api', text: '¿Qué editor preferís?', allow_free_text: false, options: [{ index: 0, label: 'vim', description: '' }, { index: 1, label: 'emacs', description: '' }], expires_at: Date.now() + 600000, free_text_max: 2000 } }), { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b' });
      await r.page.evaluate(() => { document.getElementById('capsule').dataset.edgeHidden = 'true'; }); await r.page.waitForTimeout(2200);
      const m = await r.page.evaluate(() => {
        const t = document.getElementById('question-toast'), tb = t.getBoundingClientRect(), cs = e => getComputedStyle(e);
        const texts = [...t.querySelectorAll('.q-toast-title, .q-toast-body, .q-toast-queue')].filter(e => !e.hidden && e.textContent.trim()).map(e => ({ cls: e.className, color: cs(e).color, size: cs(e).fontSize, box: e.getBoundingClientRect().toJSON() }));
        const acts = [...document.querySelectorAll('#question-toast-actions button')].filter(e => !e.hidden).map(e => ({ cls: e.className, text: e.textContent, color: cs(e).color, bg: cs(e).backgroundColor, box: e.getBoundingClientRect().toJSON() }));
        return { hidden: t.hidden, role: t.dataset.role, box: tb.toJSON(), accent: t.style.getPropertyValue('--q-accent').trim(), dotBg: cs(t.querySelector('.q-toast-dot')).backgroundColor, progress: cs(t.querySelector('.q-toast-progress')).backgroundColor,
          fills: ['neck', 'pill', 'bodyrect'].map(k => cs(t.querySelector('.q-toast-' + k)).fill), texts, acts, expanded: t.dataset.expanded, bodyOpacity: cs(t.querySelector('.q-toast-content')).opacity };
      });
      const tag = `${theme}/${q}`;
      assert.equal(m.hidden, false, `${tag}: the toast is shown (island concealed)`);
      assert.equal(m.expanded, 'true', `${tag}: expanded`); assert.equal(+m.bodyOpacity, 1, `${tag}: body text visible`);
      for (const f of m.fills) assert.equal(f, 'rgb(0, 0, 0)', `${tag}: toast shape fill is black`);
      assert.equal(m.accent, accent, `${tag}: --q-accent = ${agent === 'pi' && q === 'approvalPi' ? 'amber (permission)' : agent + ' colour'}`);
      const hex = h => `rgb(${[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
      assert.equal(m.dotBg, hex(accent), `${tag}: dot takes the accent`); assert.equal(m.progress, hex(accent), `${tag}: progress bar takes the accent`);
      assert.ok(m.box.width === 350 && m.box.height <= 96 && m.box.height >= 40, `${tag}: toast box ${m.box.width}x${m.box.height} stays in 350x96`);
      const inside = b => b.left >= m.box.left - 0.5 && b.right <= m.box.right + 0.5 && b.top >= m.box.top - 0.5 && b.bottom <= m.box.bottom + 0.5;
      const sizes = Object.fromEntries(m.texts.map(t => [t.cls.replace('q-toast-', ''), t.size]));
      assert.equal(sizes.title, '13px', `${tag}: title 13`); assert.equal(sizes.body, '12px', `${tag}: body 12`);
      assert.ok(m.texts.some(t => /title/.test(t.cls)) && m.texts.some(t => /body/.test(t.cls)), `${tag}: title and body present`);
      for (const t of m.texts) {
        const c = parse(t.color); assert.ok(c, `unparsed ${t.color}`); const cr = ratio(over(c, [0, 0, 0]), [0, 0, 0]);
        assert.ok(cr >= 4.5, `${tag}: ${t.cls} contrast ${cr.toFixed(2)} >= 4.5`);
        assert.ok(inside(t.box), `${tag}: ${t.cls} inside the 350x96 box ${JSON.stringify(t.box)}`);
      }
      for (const a of m.acts) assert.ok(inside(a.box), `${tag}: ${a.text} inside the box`);
      for (const a of m.acts.filter(x => /viewall/.test(x.cls))) { const bg = over(parse(a.bg), [0, 0, 0]), cr = ratio(over(parse(a.color), bg), bg); assert.ok(cr >= 4.5, `${tag}: Ver todo contrast ${cr.toFixed(2)}`); }
      if (agent === 'pi' && ['plain', 'approvalPi'].includes(q) || q === 'form' || q === 'multi') await r.screenshot(`/tmp/toast-style-${q === 'approvalPi' ? 'permission' : q}-${theme}.png`);
      n += 1;
    } finally { await r.close(); }
  }
  return n;
}
layout().then(n => { console.log(`question-toast-style-check: ${passed} ok + ${n} layout`); }).catch(e => { console.error('FAIL', e.message); process.exit(1); });
