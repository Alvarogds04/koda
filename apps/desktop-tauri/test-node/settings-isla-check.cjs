'use strict';
// HU-063 T2 (S2, S5): the additive «Isla» page. Pure size preview + an INVENTORY check: every control of General's «Isla» card and of
// «Colores de identidad» exists on the Isla page (same ids, labels and commands) and is gone from General; nothing else left General.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { all, text, dom, Element } = require('./settings-accounts-check.cjs');
const root = path.resolve(__dirname, '..');

// Koda 0.1 T2: the visible rename legitimately edits vendor/ and settings-view.js. "Untouched" now means: the only change is Abito -> Koda in text
// (every removed line equals its added line once «Abito» becomes «Koda»); anything else still fails.
function onlyRenamed(files) {
  const out = [];
  for (const p of files) {
    const d = execFileSync('git', ['diff', '-U0', 'HEAD', '--', require('node:path').join(root, '..', '..', p)], { cwd: root, encoding: 'utf8' }).split('\n');
    const minus = d.filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1).replace(/Abito|Koda/g, 'N'));
    const plus = d.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1).replace(/Abito|Koda/g, 'N'));
    if (JSON.stringify(minus) !== JSON.stringify(plus)) out.push(p);
  }
  return out;
}
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const I = require('../frontend/settings-isla.js');
const N = require('../frontend/island-nusa.js');

// ---- pure model: the preview reuses the island's own scale ----
for (const [size, w, k] of [['s', 1920, 0.85], ['m', 1920, 1], ['l', 1920, 1.25], ['auto', 1920, 1.1], ['auto', 2560, 1.25], ['auto', 1400, 1], ['l', 900, 1.2]]) {
  const p = I.preview(size, w);
  assert.equal(p.k, Math.round(N.sizeScale(size, w, 0) * 100) / 100, `${size}@${w} equals AbitoNusa.sizeScale`);
  assert.equal(p.k, k, `${size}@${w}`);
  assert.equal(p.width, Math.round(I.PREVIEW_BASE * p.k));
}
assert.equal(I.preview('s', 1920).caption, 'S · ×0.85');
assert.equal(I.preview('auto', 2560).caption, 'Auto · ×1.25 en esta pantalla');
for (const bad of ['', 'xl', null, undefined, 3, '__proto__', {}]) assert.equal(I.preview(bad, 1920).id, 'auto', `foreign ${String(bad)} reads as Auto`);
assert.ok(I.preview('s', 1920).width < I.preview('m', 1920).width && I.preview('m', 1920).width < I.preview('l', 1920).width);
assert.deepEqual([...I.IDS], N.SIZES.map(s => s.id), 'same closed set as the island and prefs.rs');

(async () => {
  dom();
  Element.prototype.insertBefore = function (n, ref) { this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, n); return n; };
  Element.prototype.querySelector = function () { return null; };
  global.window = { innerWidth: 1100, addEventListener() {}, removeEventListener() {} };
  document.removeEventListener = () => {};
  const base = path.join(root, 'frontend/vendor/coucou/hub');
  const { renderGeneral } = await import(pathToFileURL(path.join(base, 'general.js')));
  const { renderPills } = await import(pathToFileURL(path.join(base, 'personalization.js')));
  const V = require('../frontend/settings-view.js'), S = require('../frontend/specialists-view.js'), A = require('../frontend/avatar-colors.js');
  const P = require('../frontend/pills.js'), C = require('../frontend/pill-catalog.js');
  const M = require('../frontend/settings-isla-mount.js');

  let prefs = { sound: true, gain: .12, autoCloseSeconds: 15, openOnHover: false, declaredPills: [], pillColors: {}, avatarColors: {}, mainPill: 'integration_claude', theme: 'system', displayName: '', monitor: null, absenceSeconds: 10, islandSize: 'm', islandAgents: [], abitoInstructions: '' };
  const calls = []; let failSize = false;
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'prefs_action' && p.action === 'autostart_view') return { enabled: false };
    if (cmd === 'recap_action') return p.action === 'prefs' ? { enabled: true } : { ok: true };
    if (cmd === 'monitor_action') return { monitors: [{ key: 'DP-1' }] };
    if (cmd === 'sound_action') return p.action === 'list' ? { names: [] } : { ok: true };
    if (cmd === 'hotkey_action') return { combo: 'Ctrl+Space', enabled: true, status: 'active', backend: 'portal' };
    if (cmd === 'specialists_action') return { specialists: [], active: null };
    if (cmd === 'models_action') return { profiles: [] };
    if (p.action === 'set_island_size') { if (failSize) throw new Error('x'); prefs.islandSize = p.island_size; }
    if (p.action === 'set_avatar_color') prefs.avatarColors[p.identity] = p.color;
    if (p.action === 'set_absence_seconds') prefs.absenceSeconds = p.seconds;
    if (p.action === 'set_island_interaction') { prefs.autoCloseSeconds = p.auto_close_seconds; prefs.openOnHover = p.open_on_hover; }
    return structuredClone(prefs);
  };
  const events = {};
  const personal = { invoke, V, S, A, P, C, listen: async (n, f) => { events[n] = f; return () => { delete events[n]; }; } };
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const sig = node => ({ // what a human can identify: ids, visible labels, accessible names, button words
    ids: all(node).map(e => e.attrs.id).filter(i => i && !/^hub-tip-\d+$/.test(i)).sort(), // ⓘ tooltips are numbered per render
    names: all(node).map(e => e.attrs['aria-label']).filter(Boolean).sort(),
    labels: all(node).filter(e => e.tagName === 'label').map(e => e.textContent).sort(),
    buttons: all(node).filter(e => e.tagName === 'button' && e.textContent && e.textContent !== 'ⓘ').map(e => e.textContent).sort(),
  });
  const isla = n => all(n).find(e => e.tagName === 'section' && e.attrs['aria-label'] === 'Isla');
  const colours = n => all(n).find(e => e.tagName === 'section' && e.children[0] && e.children[0].className === 'hub-label' && e.children[0].textContent === 'Colores de identidad');

  // ---- BEFORE: the unfiltered vendor output is the inventory to preserve ----
  const rawGeneral = await renderGeneral({ invoke, V }); await rawGeneral.settled();
  const rawPills = await renderPills({ ...personal, part: 'abito' }); await rawPills.settled();
  const moved = { isla: sig(isla(rawGeneral)), colours: sig(colours(rawPills)) };
  assert.ok(moved.isla.ids.includes('hub-hover') && moved.isla.ids.includes('hub-absence') && moved.isla.ids.includes('hub-screen') && moved.isla.ids.includes('hub-recap') && moved.isla.ids.includes('hub-recap-clear'), 'inventory sanity: the Isla card has hover, plegar, ocultar, pantalla, resumen, borrar');
  for (const l of ['Abrir al pasar el cursor', 'Plegar tras (s)', 'Ocultar plegada tras (s)', 'La isla vive en', 'Atajo global', 'Resumen semanal']) assert.ok(moved.isla.labels.includes(l), l);
  assert.ok(moved.isla.buttons.includes('Ir a Atajos') && moved.isla.buttons.includes('Borrar historial'), moved.isla.buttons.join('|'));
  assert.ok(moved.colours.ids.some(i => i.startsWith('identity-abito-')), 'inventory sanity: the colour swatches');
  const stay = { // General keeps these
    general: ['hub-sound', 'hub-volume', 'hub-theme', 'hub-language', 'hub-autostart', 'hub-open-at-launch', 'hub-sounds-folder', 'hub-sounds-reload'],
    instructions: 'abito-instructions',
  };
  rawGeneral.dispose(); rawPills.dispose();

  // ---- AFTER (1): General no longer holds them, and loses nothing else ----
  const gen = await renderGeneral({ invoke, V }); await gen.settled();
  const pil = await renderPills({ ...personal, part: 'abito' }); await pil.settled();
  const stops = [I.confine(gen, I.KEEP.general, null), I.confine(pil, I.KEEP.abitoGeneral, null)];
  for (const id of [...moved.isla.ids, ...moved.colours.ids]) assert.ok(!all(gen).concat(all(pil)).some(e => e.attrs.id === id), `General no longer has #${id}`);
  for (const l of moved.isla.labels) assert.ok(!all(gen).some(e => e.tagName === 'label' && e.textContent === l), `General no longer has «${l}»`);
  assert.ok(!isla(gen) && !colours(pil));
  for (const id of stay.general) assert.ok(all(gen).some(e => e.attrs.id === id), `General keeps #${id}`);
  assert.ok(all(pil).some(e => e.attrs.id === stay.instructions), 'General keeps Instrucciones');
  assert.ok(text(pil).includes('Guardar instrucciones'));
  assert.deepEqual(all(gen).filter(e => e.tagName === 'section').map(e => e.attrs['aria-label']), ['Apariencia', 'Sonido']);
  // a vendor repaint (clear + append) is filtered again when an Observer exists
  const obs = []; class FakeObs { constructor(cb) { this.cb = cb; obs.push(this); } observe() {} disconnect() { this.off = true; } }
  const g2 = new Element('div'); const keepMe = new Element('section'); keepMe.setAttribute('aria-label', 'Sonido'); const gone = new Element('section'); gone.setAttribute('aria-label', 'Isla');
  g2.append(keepMe, gone); const stop2 = I.confine(g2, I.KEEP.general, FakeObs);
  assert.deepEqual(g2.children, [keepMe]); g2.append(gone); obs[0].cb(); assert.deepEqual(g2.children, [keepMe], 'repaint filtered again'); stop2(); assert.ok(obs[0].off);
  for (const s of stops) s(); gen.dispose(); pil.dispose();

  // ---- AFTER (2): the rail item + the Isla page ----
  const hub = new Element('div'), side = new Element('nav'), scroll = new Element('div'); side.className = 'hub-side'; scroll.className = 'hub-scroll';
  const mk = (id, title, on) => { const b = new Element('button'); b.className = on ? 'hub-item on' : 'hub-item'; b.setAttribute('data-page', id); b.append(new Element('svg'), Object.assign(new Element('span'), { textContent: title })); return b; };
  const vendor = [mk('general', 'General', true), mk('agents', 'Agentes'), mk('chat', 'Chat'), mk('shortcuts', 'Atajos'), mk('privacy', 'Privacidad')];
  const spacer = new Element('div'); spacer.className = 'spacer';
  side.append(...vendor, spacer); const vendorPage = new Element('div'); scroll.append(vendorPage); hub.append(side, scroll);
  const navs = []; const vendorHero = new Element('div');
  const doc = { createElement: t => new Element(t), createElementNS: (_, t) => new Element(t), querySelector: s => (s === '#hub .hub-side' ? side : s === '#hub .hub-scroll' ? scroll : null), getElementById: id => (id === 'hub' ? hub : null), dispatchEvent: e => navs.push(e.detail) };
  global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  const heroes = [];
  const ctl = M.mount({ doc, invoke, renderGeneral, renderPills, personal, V, hero: (...a) => { heroes.push(a); return vendorHero; }, Observer: FakeObs, areaW: () => 1920 });
  const rail = obs.at(-1); // the hub observer
  const item = ctl.item;
  assert.deepEqual(side.children.map(e => e.attrs['data-page'] || e.className), ['general', 'agents', 'chat', 'shortcuts', 'privacy', 'isla', 'spacer'], 'Isla is the last page of the rail, before the spacer');
  assert.equal(item.attrs['data-page'], 'isla'); assert.equal(item.className, 'hub-item'); assert.equal(item.children[1].textContent, 'Isla'); assert.equal(item.children[0].tagName, 'svg');
  assert.ok(item.className.split(' ').includes('hub-item') && vendor.every(v => v.className.includes('hub-item')), 'same markup class as the vendor items');
  assert.equal(vendor.filter(v => v.className.includes(' on')).length, 1);
  calls.length = 0; item.fire('click', true); await ctl.idle(); await tick();
  assert.ok(item.className.split(' ').includes('on'), 'Isla shows .on when selected');
  assert.ok(vendor.every(v => !v.className.split(' ').includes('on')), 'and the vendor item loses it (one selected item)');
  assert.deepEqual(heroes, [['isla', 'Isla', heroes[0][2]]]); assert.equal(scroll.children.length, 1); assert.notEqual(scroll.children[0], vendorPage, 'the hub panel content is replaced');
  const page = scroll.children[0];
  for (const o of obs) if (!o.off) o.cb(); // the fake DOM has no mutation events: deliver the repaint notifications a browser would
  const after = { isla: sig(isla(page)), colours: sig(colours(page)) };
  assert.deepEqual(after.isla, moved.isla, 'every control of the Isla card (ids, labels, names, buttons) is on the Isla page, nothing added');
  assert.deepEqual(after.colours, moved.colours, 'every colour control is on the Isla page');
  assert.deepEqual(all(page).filter(e => e.tagName === 'section').map(e => e.attrs['aria-label'] || (e.children[0] && e.children[0].textContent)), ['Tamaño de la isla', 'Colores de identidad', 'Isla'], 'size, colours, then the Isla card; no Apariencia/Sonido/Instrucciones here');
  assert.ok(!text(page).includes('Guardar instrucciones') && !all(page).some(e => e.attrs.id === 'hub-sound'));
  // the actions still work from the new place (same closed commands)
  const by = id => all(page).find(e => e.attrs.id === id);
  calls.length = 0;
  by('hub-hover').fire('click', false); await tick(); assert.deepEqual(calls, [], 'synthetic gestures stay inert');
  by('hub-hover').fire('click'); await tick(); assert.equal(calls.length > 0, true); assert.ok(calls.some(([c, p]) => c === 'prefs_action' || c === 'settings_window_action' || p.action), JSON.stringify(calls));
  calls.length = 0; by('hub-recap-clear').fire('click'); await tick(); assert.ok(calls.some(([c, p]) => c === 'recap_action' && p.action === 'clear'), JSON.stringify(calls));
  const swatch = all(page).find(e => (e.attrs.id || '').startsWith('identity-abito-')); calls.length = 0; swatch.fire('click'); await tick();
  assert.deepEqual(calls.find(([, p]) => p.action === 'set_avatar_color'), ['prefs_action', { action: 'set_avatar_color', identity: 'abito', color: swatch.attrs.id.replace('identity-abito-', '') }]);
  assert.ok(all(page).some(e => e.tagName === 'button' && e.textContent === 'Ir a Atajos')); all(page).find(e => e.textContent === 'Ir a Atajos').fire('click'); assert.deepEqual(navs, ['shortcuts'], '«Ir a Atajos» asks the vendor hub to navigate');

  // size S/M/L/Auto: closed set, trusted only, no call when unchanged, failure leaves it unchanged
  const seg = id => by(`island-size-${id}`);
  assert.deepEqual(all(page).filter(e => e.attrs.role === 'radio').map(e => e.attrs.id), ['island-size-s', 'island-size-m', 'island-size-l', 'island-size-auto']);
  const checked = () => all(page).filter(e => e.attrs.role === 'radio' && e.attrs['aria-checked'] === 'true').map(e => e.attrs.id);
  assert.deepEqual(checked(), ['island-size-m'], 'reads the stored size'); assert.equal(by('isla-preview-caption').textContent, 'M · ×1');
  calls.length = 0; seg('l').fire('click', false); await tick(); assert.deepEqual(calls, [], 'a synthetic click never changes the size');
  seg('m').fire('click'); await tick(); assert.deepEqual(calls, [], 'the same size sends nothing');
  seg('l').fire('click'); await tick(); assert.deepEqual(calls, [['prefs_action', { action: 'set_island_size', island_size: 'l' }]]);
  assert.deepEqual(checked(), ['island-size-l']); assert.equal(by('isla-preview-caption').textContent, 'L · ×1.25'); assert.ok(text(page).includes('Tamaño de la isla guardado.'));
  failSize = true; calls.length = 0; seg('s').fire('click'); await tick(); failSize = false;
  assert.deepEqual(checked(), ['island-size-l'], 'a failed save keeps the previous size'); assert.ok(text(page).includes('No se pudo guardar. El tamaño sigue sin cambios'));
  seg('auto').fire('click'); await tick(); assert.equal(by('isla-preview-caption').textContent, 'Auto · ×1.1 en esta pantalla');

  // the rail follows the vendor: another page selected -> ours drops .on and the page is disposed
  vendor[1].className = 'hub-item on'; rail.cb();
  assert.ok(!item.className.split(' ').includes('on') && !ctl.isActive(), 'choosing another page clears Isla');
  // re-open, then the vendor replaces the panel content without a class change
  item.fire('click', true); await ctl.idle(); await tick(); assert.ok(ctl.isActive() && item.className.includes('on'));
  assert.ok(vendor.every(v => !v.className.split(' ').includes('on')));
  scroll.replaceChildren(new Element('div')); rail.cb(); assert.ok(!ctl.isActive() && !item.className.split(' ').includes('on'), 'the vendor painting a page elsewhere releases Isla');
  // a vendor navigation while Isla is still loading wins: nothing is painted over it
  vendor[0].className = 'hub-item'; vendor[2].className = 'hub-item';
  const before = scroll.children[0]; item.fire('click', true); vendor[2].className = 'hub-item on'; rail.cb(); await ctl.idle(); await tick();
  assert.equal(scroll.children[0], before, 'a late Isla never overwrites the page the vendor chose'); assert.ok(!item.className.split(' ').includes('on'));
  // a failing renderer shows the same quiet message as the other pages
  const bad = M.mount({ doc: { ...doc, createElement: doc.createElement }, invoke, renderGeneral: async () => { throw new Error('x'); }, renderPills, personal, V, Observer: null, areaW: () => 1920 });
  assert.ok(bad, 'a second mount is possible in isolation');

  // ---- source / wiring ----
  const app = read('frontend/settings-app.js');
  const order = ['./island-nusa.js', './settings-isla.js', './settings-isla-mount.js'].map(f => app.indexOf(`import '${f}';`));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), 'settings-app.js imports the Isla layer in order');
  assert.ok(app.indexOf("import './settings-nusa-mount.js';") < order[0]);
  assert.ok(/AbitoSettingsIsla\?\.confine\(general/.test(app) && /KEEP\.abitoGeneral/.test(app) && /AbitoSettingsIslaMount\?\.mount\(/.test(app), 'General is filtered and the page is mounted through optional calls');
  assert.ok(app.indexOf('AbitoSettingsIslaMount?.mount(') < app.indexOf('startHub(root, {'));
  for (const f of ['settings-isla.js', 'settings-isla-mount.js']) { const src = read(`frontend/${f}`); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\('style'/.test(src), `${f}: no HTML injection`); }
  assert.ok(/setProperty\('--k'/.test(read('frontend/settings-isla-mount.js')));
  assert.ok(/isla-notch/.test(read('frontend/settings-nusa.css')) && !/url\(\s*['"]?https?:/.test(read('frontend/settings-nusa.css')));
  assert.equal(require('../frontend/settings-nusa.js').pageVoice('isla').phrase, require('../frontend/settings-nusa.js').pageVoice('island').phrase, 'the Isla rail id has its own Koda phrase');
  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(onlyRenamed(changed.filter(p => /\/vendor\//.test(p) || /settings-view\.js$|\/settings\.js$/.test(p))), [], 'R1: vendor, settings-view.js and settings.js untouched except Abito -> Koda (Koda 0.1 T2)');
  const lib = read('packaging/lib.cjs');
  for (const f of ['settings-isla.js', 'settings-isla-mount.js']) assert.ok(lib.includes(`'${f}'`), `packaging lists ${f}`);
  console.log('settings-isla-check ok');
})().catch(e => { console.error(e); process.exit(1); });
