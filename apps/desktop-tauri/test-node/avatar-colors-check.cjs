'use strict';
/* #384 — the Dot's avatar-colour contract.

   Human decision, verbatim: «colores en ajustes por si alguien lo quiere cambiar, pero fijo el
   verde y los sub abitos especializados de difrentes colores».
   Parent's clarification, same decision: the principal is GREEN BY DEFAULT and stable against
   activity, but the human may change it in Ajustes — an explicit human preference is not the
   same as an identity or an active agent, so rejecting the principal's override would be
   inventing a prohibition nobody asked for.

   What this checks, and nothing else:
   - the principal Abito (the compact Dot that holds the R6 character) is green by default and
     NO pose, host condition, agent or notice changes that; only an explicit override does;
   - a real set of sub-Abitos is differentiated by identity over blue/mint/orange/purple, and the
     palette's capacity LIMIT is measured, not promised away;
   - the Ajustes overrides are a validated closed schema: invalid or hostile input is dropped,
     never applied and never thrown;
   - provider/CLI identities (pi, claude-code, codex, opencode) are not sub-Abitos;
   - no specialist list is invented: with no real specialist there are no specialist rows.

   The module is pure (no DOM, no IPC, no engine mutation): the default green still lives in the
   frozen R6 engine, whose bytes and geometry this feature does not touch.
   Run: node apps/desktop-tauri/test-node/avatar-colors-check.cjs
   (also by cargo test, apps/desktop-tauri/tests/frontend_avatar_colors.rs). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const A = require(path.join(frontend, 'avatar-colors.js'));
const S = require(path.join(frontend, 'settings-view.js'));
const engine = fs.readFileSync(path.join(frontend, 'clay-engine.js'), 'utf8');
const modulePath = path.join(frontend, 'avatar-colors.js');
let passed = 0;
const test = (name, fn) => { try { fn(); } catch (e) { e.message = `${name}: ${e.message}`; throw e; } passed += 1; };
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/* A reload of a persisted preferences file: what the host would read back from disk. */
function reload(value) {
  const text = JSON.stringify(value);
  try { return JSON.parse(text); } catch { throw new Error(`test fixture is not JSON: ${text}`); }
}

// The seven frozen R6 poses, re-read from the engine below so a copy cannot drift.
const R6_ORDER = ['idle', 'listen', 'think', 'speak', 'reject', 'confirm', 'error', 'working', 'searching', 'approval', 'question', 'finished', 'ratelimit', 'sleeping', 'dizzy'];
// Every visible condition the island can be in while the Dot is on screen.
const HOST_CONDITIONS = ['compact', 'expanded', 'card-pending', 'question-pending', 'notice',
  'connected', 'no-pi', 'channel-down', 'bridge-down', 'chat', 'reduced-motion'];
// Two real-looking sub-Abito identities whose hash lands in the SAME bucket (measured below):
// they are the frozen witness of the palette's limit.
const COLLIDE_A = 'sub-abito-1';
const COLLIDE_B = 'sub-abito-5';

test('chosen hex foundation: migration, closed palette, canonicalization and JSON round-trip', () => {
  const palette = ['#F5F6F8', '#F4505E', '#F29B38', '#FACC15', '#4ADE80',
    '#2DD4BF', '#38BDF8', '#818CF8', '#C084FC', '#E879F9'];
  const legacy = { green: '#4ADE80', blue: '#38BDF8', mint: '#2DD4BF', orange: '#F29B38', purple: '#C084FC' };
  for (const [name, hex] of Object.entries(legacy)) assert.equal(A.normalizeChosenColor(name), hex, name);
  assert.deepEqual(A.HEX_PALETTE, palette);
  const vendor = fs.readFileSync(path.join(frontend, 'vendor/coucou/core/pill-colors.ts'), 'utf8');
  assert.deepEqual(vendor.match(/"#[0-9A-F]{6}"/g).map(s => s.slice(1, -1)), palette, 'MIT palette cannot drift');
  assert.ok(Object.isFrozen(A.HEX_PALETTE));
  for (const hex of palette) {
    for (const raw of [hex, hex.toLowerCase(), hex.slice(1).toLowerCase()]) {
      const canonical = A.normalizeChosenColor(raw);
      assert.equal(canonical, hex);
      assert.equal(A.normalizeChosenColor(canonical), canonical, 'idempotent');
      assert.equal(A.normalizeChosenColor(reload(canonical)), hex, 'JSON round-trip');
    }
  }
  for (const bad of [null, undefined, true, 42, [], {}, Object('#4ADE80'), '', '#FFFFFF',
    '#000000', '#abc', '##4ADE80', '#4ADE8000', 'GGGGGG', ' green', 'green ', 'GREEN',
    ' #4ADE80', '#4ADE80\n', '__proto__', 'constructor', 'rgb(74,222,128)', '#４ＡＤＥ８０']) {
    assert.equal(A.normalizeChosenColor(bad), null, String(bad));
  }
});

test('chosen gradient foundation: exact HSL stops, bounded lightness, pure and deterministic', () => {
  assert.deepEqual(A.gradientStops('#4ade80'), ['hsl(141.89 69.16% 70.04%)', '#4ADE80', 'hsl(141.89 69.16% 46.04%)']);
  assert.deepEqual(A.gradientStops('#F5F6F8'), ['hsl(220 17.65% 100%)', '#F5F6F8', 'hsl(220 17.65% 84.67%)']);
  assert.equal(A.gradientStops('green'), null, 'only explicit hex gets a new paint; defaults stay CSS');
  assert.equal(A.gradientStops('#FFFFFF'), null, 'off-palette never painted');
  for (const hex of A.HEX_PALETTE) {
    const stops = A.gradientStops(hex);
    assert.equal(stops.length, 3); assert.equal(stops[1], hex);
    assert.deepEqual(A.gradientStops(hex.slice(1).toLowerCase()), stops);
    const light = Number(stops[0].match(/ ([\d.]+)%\)$/)[1]);
    const dark = Number(stops[2].match(/ ([\d.]+)%\)$/)[1]);
    assert.ok(light <= 100 && dark >= 0 && light > dark, hex);
    stops[0] = 'mutated';
    assert.notEqual(A.gradientStops(hex)[0], 'mutated', 'fresh result, no shared mutable state');
  }
});

test('canonical backend hex reaches the principal and pill consumers without changing defaults', () => {
  assert.equal(A.resolveColor('abito', { abito: '#2dd4bf' }), '#2DD4BF');
  assert.equal(A.resolveColor('abito', {}), 'green');
  assert.equal(A.label('#2DD4BF'), 'Menta');
  const P = require(path.join(frontend, 'pills.js'));
  const state = P.normalize({ pillColors: { integration_claude: '#2dd4bf', constructor: '#2DD4BF', unknown: '#2DD4BF' },
    customBlobs: [{ name: 'Correo', color: '#f4505e' }] });
  assert.deepEqual(state.pillColors, { integration_claude: '#2DD4BF' });
  assert.equal(state.blobs[0].color, '#F4505E');
  assert.deepEqual(A.sanitizeOverrides({ abito: '#FFFFFF', constructor: '#2DD4BF' }), {});
});

test('hex consumers apply and clear all three stops without changing the engine/default tokens', () => {
  for (const file of ['island.js', 'specialists.js', 'pills-view.js', 'settings.js', 'pill-settings.js']) {
    const source = fs.readFileSync(path.join(frontend, file), 'utf8');
    const helper = source.match(/function paintChosenColor\(node, color\) \{[\s\S]*?\n  \}/)[0];
    const paint = require('node:vm').runInNewContext('(' + helper + ')', { A, AVATAR: A });
    const vars = {}; const node = { style: { setProperty: (key, value) => { vars[key] = value; } } };
    paint(node, '#2DD4BF');
    assert.deepEqual([1, 2, 3].map(i => vars['--chosen-' + i]), A.gradientStops('#2DD4BF'), file);
    paint(node, 'green');
    assert.deepEqual(Object.values(vars), ['', '', '', ''], file + ' clears chosen paint for defaults');
  }
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  for (const i of [1, 2, 3]) assert.ok(css.includes('stop-color: var(--chosen-' + i + ')'), 'chosen stop ' + i);
});

// ---- the principal: green by default, never a function of activity ----------------------
test('the pose list used here is the engine\'s own ORDER (a copy would drift)', () => {
  const m = /const ORDER = (\[[^\]]*\])/.exec(engine);
  assert.ok(m, 'clay-engine.js still declares ORDER');
  assert.deepEqual(m[1].match(/'[^']+'/g).map(s => s.slice(1, -1)), R6_ORDER);
});

test('principal: green by default, and no pose, host condition, agent or notice changes it', () => {
  assert.equal(A.PRINCIPAL_COLOR, 'green');
  assert.equal(A.PRINCIPAL_ID, 'abito');
  for (const pose of R6_ORDER) {
    for (const host of HOST_CONDITIONS) {
      // the contract functions take (identity, overrides) only: extra arguments are ignored
      assert.equal(A.resolveColor('abito', {}, pose, host), 'green', `${pose}/${host}`);
      assert.equal(A.defaultColor('abito'), 'green', `${pose}/${host}`);
    }
  }
  for (const id of ['Abito', 'ABITO', '', '   ', null, undefined, 42, {}, []]) {
    assert.equal(A.defaultColor(id), 'green', `principal for ${JSON.stringify(id)}`);
  }
});

test('principal: an explicit human override IS honoured (S7 clarification, not a prohibition)', () => {
  assert.equal(A.resolveColor('abito', { abito: 'purple' }), 'purple');
  assert.deepEqual(A.sanitizeOverrides({ abito: 'mint' }), { abito: 'mint' });
  assert.deepEqual(A.principalFrom({ abito: 'purple' }), { id: 'abito', color: 'purple', label: 'Púrpura' });
  assert.deepEqual(A.principalFrom(), { id: 'abito', color: 'green', label: 'Verde' });
  // ...but only an explicit, valid human choice: nothing else reaches the principal
  assert.equal(A.resolveColor('abito', { abito: 'chartreuse' }), 'green');
  assert.equal(A.resolveColor('Abito', { abito: 'purple' }), 'green', 'only the principal identity itself');
  assert.deepEqual(A.principalFrom({ abito: 'chartreuse' }), { id: 'abito', color: 'green', label: 'Verde' });
});

test('the palette: green for the principal, blue/mint/orange/purple for a specialist default', () => {
  assert.deepEqual([...A.SPECIALIST_COLORS], ['blue', 'mint', 'orange', 'purple']);
  assert.deepEqual([...A.PALETTE], ['green', 'blue', 'mint', 'orange', 'purple']);
  assert.ok(!A.SPECIALIST_COLORS.includes('green'), 'green is not a specialist DEFAULT');
  for (const id of ['sub-abito-uno', 'sub-abito-dos', 'sub-abito-tres', 'sub-abito-cuatro', 'sub-abito-5']) {
    assert.ok(A.SPECIALIST_COLORS.includes(A.defaultColor(id)), `${id}: ${A.defaultColor(id)}`);
  }
});

test('the default green still lives in the frozen engine; this module paints nothing', () => {
  for (const stop of ['#acdd96', '#8fcb78', '#78b562']) assert.ok(engine.includes(stop), stop);
  const src = code(fs.readFileSync(modulePath, 'utf8'));
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\.\w|setAttribute|classList|\.style\b|createElement/,
    'pure: the colour contract never touches the DOM or the engine');
});

test('the colour rule is a function of identity and overrides only (no activity input)', () => {
  assert.equal(A.resolveColor.length, 2, 'resolveColor(identity, overrides)');
  assert.equal(A.defaultColor.length, 1, 'defaultColor(identity)');
});

// ---- specialist colours: stable, distinct over a real set -------------------------------
test('stability: one identity, one default colour — whatever else is present and across a reload', () => {
  const first = A.defaultColor('sub-abito-uno');
  assert.equal(A.defaultColor('sub-abito-uno'), first);
  assert.equal(A.resolveColor('sub-abito-uno', null), first);
  delete require.cache[require.resolve(modulePath)];
  const fresh = require(modulePath);
  assert.equal(fresh.defaultColor('sub-abito-uno'), first, 'a page/prefs reload keeps the colour');
});

test('membership changes never repaint defaults, even colliding identities', () => {
  assert.equal(A.defaultColor(COLLIDE_A), A.defaultColor(COLLIDE_B));
  const sets = [[COLLIDE_B], [COLLIDE_A, COLLIDE_B], [COLLIDE_B, COLLIDE_A],
    Array.from({ length: 12 }, (_, i) => `sub-abito-${i + 1}`)];
  for (const ids of sets) for (const row of A.settingsRows(ids, {})) {
    assert.equal(row.color, A.defaultColor(row.id), `${row.id} in ${ids}`);
    assert.equal(Object.hasOwn(row, 'duplicate'), false, 'repeated colors are valid, not warnings');
  }
});

test('repeated defaults and overrides stay valid; orphan preferences retained but not rendered', () => {
  const overrides = { abito: 'mint', [COLLIDE_A]: 'mint', [COLLIDE_B]: 'mint', orphan: 'purple' };
  assert.deepEqual(A.sanitizeOverrides(overrides), overrides);
  const before = JSON.stringify(overrides);
  for (const ids of [['abito', COLLIDE_B], ['abito', COLLIDE_A, COLLIDE_B]]) {
    const rows = A.settingsRows(ids, overrides);
    assert.deepEqual(rows.map(r => r.color), ids.map(() => 'mint'));
    assert.deepEqual(rows.map(r => r.id), ids);
    assert.ok(rows.every(r => !Object.hasOwn(r, 'duplicate')));
  }
  assert.equal(JSON.stringify(overrides), before);
});

// ---- Ajustes overrides: validated, reload-safe, never a way in for junk -----------------
test('overrides: a valid map survives a JSON reload and resolves for principal and specialist', () => {
  const good = { abito: 'purple', 'sub-abito-uno': 'orange' };
  const clean = A.sanitizeOverrides(reload(good));
  assert.deepEqual(clean, good);
  assert.equal(A.resolveColor('abito', clean), 'purple');
  assert.equal(A.resolveColor('sub-abito-uno', clean), 'orange');
  assert.equal(A.resolveColor('sub-abito-dos', clean), A.defaultColor('sub-abito-dos'), 'unset keeps its default');
});

test('overrides: invalid shapes and values are dropped, never thrown', () => {
  for (const bad of [null, undefined, 42, 'x', true, [], [['abito', 'purple']],
    { abito: 'chartreuse' }, { abito: 'PURPLE' }, { abito: '' }, { abito: 3 }, { abito: null },
    { abito: { color: 'purple' } }, { Abito: 'purple' }, { ' abito': 'purple' },
    { 'sub-abito-uno': 'green ' }, { ['a'.repeat(40)]: 'blue' }]) {
    assert.deepEqual(A.sanitizeOverrides(bad), {}, JSON.stringify(bad));
  }
  // green IS valid for a human choice (the clarification), for the principal and for a sub-Abito
  assert.deepEqual(A.sanitizeOverrides({ abito: 'green' }), { abito: 'green' });
  assert.deepEqual(A.sanitizeOverrides({ 'sub-abito-uno': 'green' }), { 'sub-abito-uno': 'green' });
});

test('overrides: hostile keys and provider identities are not assignable', () => {
  for (const key of ['__proto__', 'prototype', 'constructor', '', ' ', 'pi', 'claude-code', 'codex', 'opencode']) {
    assert.deepEqual(A.sanitizeOverrides({ [key]: 'blue' }), {}, key);
    assert.equal(A.resolveColor(key, { [key]: 'blue' }), 'green', key);
  }
  const polluted = A.sanitizeOverrides(reload({ ['__proto__']: { polluted: true }, constructor: 'blue' }));
  assert.deepEqual(polluted, {});
  assert.equal({}.polluted, undefined, 'no prototype pollution');
});

// ---- identities: specialists are not providers/CLI --------------------------------------
test('provider/CLI identities are not sub-Abitos and never get a specialist colour', () => {
  const notify = fs.readFileSync(path.join(frontend, 'notify-view.js'), 'utf8');
  assert.match(notify, /KNOWN_AGENTS = \{ pi: 'Pi'/, 'the repo still names Pi as the default agent identity');
  // recap/statusline are installable integrations (L32e), not chat identities: they are not in the guard list.
  const known = S.AGENT_IDS.filter(id => id !== 'recap' && id !== 'statusline');
  assert.deepEqual([...A.PROVIDERS].sort(), known.slice().sort(),
    'the guard list is exactly the connectors/providers the repo already names, not a second list');
  for (const id of A.PROVIDERS) {
    assert.equal(A.isSpecialist(id), false, id);
    assert.equal(A.isCustomizable(id), false, id);
    assert.equal(A.defaultColor(id), 'green', id);
    assert.deepEqual(A.sanitizeOverrides({ [id]: 'blue' }), {}, id);
  }
  for (const id of ['abito', 'Abito', '', undefined, '__proto__', 'Sub-Abito-Uno', 'a b']) {
    assert.equal(A.isSpecialist(id), false, String(id));
  }
  assert.equal(A.isCustomizable('abito'), true, 'the principal is customizable by the human');
  for (const id of ['sub-abito-uno', 'sub-abito.dos', 'sub_abito_tres', 's']) {
    assert.equal(A.isSpecialist(id), true, id);
    assert.equal(A.isCustomizable(id), true, id);
  }
});

// ---- Ajustes rows: a real consumer model, no invented list ------------------------------
test('settings rows: the principal is always there, specialists only when they exist', () => {
  assert.deepEqual(A.settingsRows([], {}), []);
  assert.deepEqual(A.settingsRows(null, null), []);
  assert.deepEqual(A.settingsRows(undefined, 'nope'), []);
  assert.deepEqual(A.settingsRows(['pi', 'claude-code', 'codex', 'opencode'], { pi: 'blue' }), [],
    'connectors are not specialist rows');
  const principal = A.settingsRows(['abito'], {});
  assert.deepEqual(principal.map(r => [r.id, r.color, r.override, r.label]), [['abito', 'green', false, 'Verde']]);
  assert.match(principal[0].aria, /Verde/);
  const chosen = A.settingsRows(['abito'], { abito: 'orange' });
  assert.deepEqual([chosen[0].color, chosen[0].override, chosen[0].label], ['orange', true, 'Naranja']);
  const rows = A.settingsRows(['abito', 'sub-abito-uno', 'sub-abito-dos'], { 'sub-abito-dos': 'purple' });
  assert.deepEqual(rows.map(r => r.id), ['abito', 'sub-abito-uno', 'sub-abito-dos']);
  assert.deepEqual(rows.map(r => r.color), ['green', A.defaultColor('sub-abito-uno'), 'purple']);
  assert.deepEqual(rows.map(r => r.override), [false, false, true]);
  assert.equal(new Set(rows.map(r => r.color)).size, 3, 'the panel shows three different colours');
  for (const r of rows) {
    assert.equal(r.label, A.label(r.color));
    assert.match(r.aria, new RegExp(r.label));
    assert.equal(Object.hasOwn(r, 'duplicate'), false);
    assert.doesNotMatch(JSON.stringify(r), /secret|token|password|key/i);
  }
});

test('labels are the closed Spanish words; unknown colours and prototype keys are empty', () => {
  assert.deepEqual(['green', 'blue', 'mint', 'orange', 'purple'].map(A.label), ['Verde', 'Azul', 'Menta', 'Naranja', 'Púrpura']);
  assert.equal(A.label('chartreuse'), '');
  assert.equal(A.label(undefined), '');
  assert.equal(A.label('constructor'), '', 'a prototype key is never a colour word');
  assert.equal(A.label('__proto__'), '');
});

// ---- wiring: the panel and the Dot must honour the contract -------------------------------
test('wiring: the island takes the Dot colour from the preferences only, never from activity', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(src, /AbitoAvatarColors/, 'the island uses the one colour contract');
  assert.match(src, /principalFrom\(/, 'the Dot wears the principal colour');
  assert.match(src, /prefs:state/, 'a change in Ajustes reaches the Dot');
  assert.match(src, /action: 'view'/, 'the island reads the stored choice at boot');
  const lines = src.split('\n').filter(l => l.includes('dotColor'));
  assert.ok(lines.length > 0, 'the island sets the Dot colour attribute');
  for (const l of lines) assert.doesNotMatch(l, /chatPose|hostPose|applyPose|Poses|pose\b/, l);
});

test('wiring: the default green keeps the engine untouched; the four choices tint the same stops', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.doesNotMatch(css, /data-dot-color="green"/, 'green stays the engine\'s own paint, byte for byte');
  for (const c of ['blue', 'mint', 'orange', 'purple']) {
    assert.match(css, new RegExp(`#island\\[data-dot-color="${c}"\\][^{]*stop`), c);
  }
  assert.match(css, /stop-color:/);
  // the tint is CSS over the engine's own gradient: every tint rule sets stop colours and
  // nothing else — no transform, size, position or opacity of its own
  const tintLines = css.split('\n').filter(l => l.includes('data-dot-color="') && l.includes('{'));
  assert.ok(tintLines.length >= 12, `expected the four tints, got ${tintLines.length} lines`);
  for (const l of tintLines) {
    assert.match(l, /stop-color:/, l);
    assert.doesNotMatch(l, /\btransform\b|\bwidth\b|\bheight\b|\bleft\b|\btop\b|\bopacity\b|fill:/, l);
  }
});

// Human request after preview 11 («no pon unos verdes neon»): the greens read washed-out. The two green
// families (the default green and mint) are neon: very saturated and bright, so they stay vivid on the black island.
function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s: sat, l };
}
// Human request («toda la interfaz con colores neones»): the other three identity families and the four STATUS
// colours (go / sun / red / live) are neon too. Status colours are read as text and rings on the black island, so
// besides saturation they must stay bright enough to read (WCAG contrast against #000 >= 7:1).
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
test('neon palette: blue / orange / purple identity tokens and go / sun / red / live status tokens are vivid', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  const tok = name => { const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)); assert.ok(m, name); return m[1]; };
  for (const fam of ['blue', 'orange', 'purple']) {
    for (const n of [1, 2, 3]) {
      const h = hsl(tok(`dot-${fam}-${n}`));
      assert.ok(h.s >= 0.85, `--dot-${fam}-${n} saturation ${h.s.toFixed(2)} must be neon (>= 0.85)`);
    }
    const body = hsl(tok(`dot-${fam}-2`));
    assert.ok(body.l >= 0.4 && body.l <= 0.75, `--dot-${fam}-2 (the body tone) lightness ${body.l.toFixed(2)} stays vivid, not pastel`);
  }
  for (const [name, minL] of [['go', 0.45], ['sun', 0.45], ['red-11', 0.4], ['island-live', 0.4]]) {
    const hex = tok(name), h = hsl(hex);
    assert.ok(h.s >= 0.85, `--${name} saturation ${h.s.toFixed(2)} must be neon (>= 0.85)`);
    assert.ok(h.l >= minL, `--${name} lightness ${h.l.toFixed(2)}`);
    assert.ok((luminance(hex) + 0.05) / 0.05 >= 7, `--${name} keeps WCAG contrast >= 7:1 on the black island`);
  }
});

test('neon greens: the green and mint tokens are vivid, and the default green is painted by CSS over the engine', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  const tok = name => { const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)); assert.ok(m, name); return m[1]; };
  for (const fam of ['green', 'mint']) {
    for (const n of [1, 2, 3]) {
      const h = hsl(tok(`dot-${fam}-${n}`));
      assert.ok(h.s >= 0.85, `--dot-${fam}-${n} saturation ${h.s.toFixed(2)} must be neon (>= 0.85)`);
      if (n === 2) assert.ok(h.l >= 0.4 && h.l <= 0.75, `--dot-${fam}-2 (the body tone) lightness ${h.l.toFixed(2)} stays vivid, not pastel`);
    }
  }
  // the default green has no data-dot-color attribute, so it needs its own base rule (lower specificity than the
  // four attribute tints, so those still win): the engine file is not touched
  for (const n of [1, 2, 3]) {
    assert.match(css, new RegExp(`#island #clay radialGradient\\[id\\$="skin"\\] stop:nth-child\\(${n}\\) \\{ stop-color: var\\(--dot-green-${n}\\); \\}`), `default green stop ${n}`);
  }
  assert.ok(fs.readFileSync(path.join(frontend, 'clay-engine.js'), 'utf8').includes('#acdd96'), 'the engine itself is untouched');
});

test('wiring: the panel offers the palette and writes through the existing preferences command', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const view = fs.readFileSync(path.join(frontend, 'settings-view.js'), 'utf8');
  assert.match(src, /V\.colorRows\(/, 'the panel renders the colour model');
  assert.match(src, /set_avatar_color/);
  assert.match(src, /id: AVATAR\.PRINCIPAL_ID, name: 'Abito'[^\n]*\.\.\.identities\.identities/, 'identities come from the contract plus the real owner projection');
  assert.match(src, /AbitoSpecialistsPanel\?\.identityView\(\)/, 'no invented specialist identity');
  assert.doesNotMatch(src, /call\('specialists_action'/, 'Settings never loads a second role cache');
  assert.match(view, /avatarColors/, 'the view-model reads the stored map');
  assert.match(src, /No se pudo guardar el color/, 'a failed save is said out loud');
  assert.doesNotMatch(src, /claude-code|opencode|codex/, 'the panel never turns a connector into a sub-Abito');
});

// #436 T6.5 (D8): the specialist card offers the SAME palette. Source-level wiring only:
// specialists.js has no DOM harness (no jsdom anywhere in this suite), so the colour side
// of the card is proven structurally and honestly stated as such.
test('wiring: the specialist card offers the same palette through the same command, with no second colour store', () => {
  const src = fs.readFileSync(path.join(frontend, 'specialists.js'), 'utf8');
  assert.match(src, /set_avatar_color/, 'the card writes through the existing preferences command');
  assert.match(src, /AVATAR\.PALETTE/, 'the choices come from the one palette contract');
  assert.match(src, /AVATAR\.resolveColor\(/, 'the shown colour resolves through the contract for the SAME id');
  assert.match(src, /No se pudo guardar el color/, 'a failed save keeps the previous colour and says so');
  assert.doesNotMatch(src, /dot-green|#[0-9a-fA-F]{6}/, 'no colour values of its own');
  assert.match(src, /aria-pressed/, 'the selected choice never rides on colour alone');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  const block = css.slice(0, css.indexOf('/* ---- #410:'));
  assert.match(block, /\.srole-colors\s*\{/, 'the card swatches have their own compact rules, append-only before the #410 slice');
  assert.match(block, /\.srole-colors \[data-color="green"\]|\.srole-colors .*sdot-swatch/, 'the swatch paints through the existing colour stops');
  assert.doesNotMatch(block, /#436[^\n]*\n[^\n]*transform/, 'no layout surprises');
});

console.log(`avatar-colors-check: ${passed} passed`);
