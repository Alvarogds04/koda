'use strict';
// island-free-drag T7/T8 (S7: «Quitar la gota y dejar solo koda»): the desktop pet window draws ONLY the Koda cat — the same
// spritesheet the island uses — and never the clay blob.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = f => fs.readFileSync(path.join(__dirname, '../frontend', f), 'utf8');

function el(tag) {
  return { tagName: tag.toUpperCase(), style: {}, dataset: {}, className: '', hidden: false, children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, setPointerCapture() {}, classList: { add() {}, remove() {} } };
}

function runPage({ reduced = false } = {}) {
  const hit = el('svg'); hit.id = 'clay';
  const body = el('body');
  const frames = [];
  const clayCreated = [];
  const ctx = {
    console, setTimeout, clearTimeout, performance: { now: () => 1000 },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: reduced, addEventListener() {} }),
    addEventListener() {},
    document: { getElementById: id => (id === 'clay' ? hit : null), createElement: el, body, documentElement: { dataset: {} } },
    __TAURI__: { core: { invoke: () => Promise.resolve(null) }, event: { listen: () => Promise.resolve(() => {}) } },
    __clay: clayCreated,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // the scripts desktop-character.html loads, in its order
  const html = read('desktop-character.html');
  const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(m => m[1]);
  for (const s of scripts) {
    if (s === 'clay-engine.js') vm.runInContext('const AbitoClay = { create: (svg, o) => { __clay.push(svg.id); return { S: {}, setState() {}, triggerEmote() {}, destroy() {} }; } };', ctx);
    else vm.runInContext(read(s), ctx, { filename: s });
  }
  for (const f of frames.splice(0)) f(1000);
  return { scripts, body, hit, clayCreated, ctx };
}

test('S7: the pet page loads the Koda sheet catalog and logic, never the clay engine', () => {
  const { scripts } = runPage();
  assert.ok(scripts.includes('koda-catalog.js') && scripts.includes('koda-logic.js'), JSON.stringify(scripts));
  assert.ok(!scripts.includes('clay-engine.js'), 'no clay engine: the green blob can never be drawn');
  assert.ok(scripts.indexOf('koda-logic.js') < scripts.indexOf('desktop-character.js'));
});

test('S7: the pet window draws one Koda sprite from the 32 px sheet, crisp and centred in the 120 px window', () => {
  const { body, clayCreated } = runPage();
  assert.deepEqual(clayCreated.length, 0, 'the clay character is never created');
  const sprites = body.children.filter(c => c.className === 'koda-sprite');
  assert.equal(sprites.length, 1, 'exactly one Koda sprite');
  const st = sprites[0].style;
  assert.match(st.backgroundImage, /koda\/koda-chibi-32\.png/);
  assert.equal(st.width, '96px'); assert.equal(st.height, '96px'); // 32 px cell x3
  assert.equal(st.left, '12px'); assert.equal(st.top, '12px');
  assert.match(st.backgroundPosition, /^-?\d+px -?\d+px$/);
  assert.equal(sprites[0].dataset.anim, 'respirar', 'idle Koda breathes, awake (as koda-skin.js draws an idle Koda)');
  assert.equal(sprites[0].attrs['aria-hidden'], 'true');
});

test('S7: the island state picks the Koda animation (same pose map as the island)', () => {
  const src = read('desktop-character.js');
  assert.match(src, /POSE_TO_ANIM/, 'states map through KodaLogic.POSE_TO_ANIM');
  assert.match(src, /REACTION_TO_ANIM/, 'emotes map through KodaLogic.REACTION_TO_ANIM');
});

test('no page reads the clay engine through window.AbitoClay (it is a lexical global)', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '../frontend')).filter(f => f.endsWith('.js'))) {
    assert.doesNotMatch(read(f), /window\.AbitoClay\b/, f);
  }
});
