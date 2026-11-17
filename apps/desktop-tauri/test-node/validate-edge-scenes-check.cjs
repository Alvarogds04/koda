'use strict';
/* The screen validator's edge scenes must follow the product decision isla-cualquier-lado S2: the folded island is Koda's disc and
   it NEVER hides at the screen edge (no «Ocultar tras» delay, no hidden thread). Source-level contract on the scene driver: the
   scenes themselves drive the shared desktop and are run by the parent, never here. Run: node test-node/validate-edge-scenes-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8');
const between = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `${from} .. ${to}`); return src.slice(a, b); };
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

test('no scene uses a retired edge-hide command or reads the retired delay', () => {
  assert.doesNotMatch(src, /set_absence_(minutes|seconds)/);
  assert.doesNotMatch(src, /absence(Minutes|Seconds)/);
});
test('S2 geometry: no scene waits for the island to slide into the edge; «shown» is the full 32px disc on screen', () => {
  assert.doesNotMatch(src, /bottom<=(4|8)\.1/, 'no hidden 4px/8px slice is awaited any more');
  assert.doesNotMatch(src, /edgeHidden==='true'/, 'no scene waits for the hidden state');
  assert.match(src, /const discShown=\(\)=>byId\('capsule'\)\.dataset\.edgeHidden!=='true' && [^\n]*\.top>=-0\.1 && [^\n]*\.bottom>=31\.9;/);
  const through = between('async function edgeWake()', 'async function islandHoverPin()');
  assert.match(through, /o\.y\+\(r\.bottom\+12\)\*o\.scale/, 'the pass-through probe sits 12px below the disc: input there reaches the window underneath');
  assert.match(through, /ok:through && shown/);
  const isl = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.doesNotMatch(isl, /conceal/, 'the page never slides the island up');
});
test('S31: no validator scene holds an expanded island untouched for 30 s or more (the island now folds after 30 s idle)', () => {
  const hold = between('async function islandHoverPin()', 'return {mutedDiscShown');
  const waits = [...hold.matchAll(/delay\((\d+)\)/g)].map(m => +m[1]);
  assert.ok(waits.length > 0 && Math.max(...waits) < 30000, `the pinned-hold waits stay under 30 s: ${waits}`);
  assert.doesNotMatch(src, /delay\((?:[3-9]\d{4}|\d{6,})\)|setTimeout\(resolve,(?:[3-9]\d{4}|\d{6,})\)/, 'no scene sleeps 30 s or more');
});
test('edgeIdle folds the island and samples the disc past the retired 10 s default, inside the probe\'s 80 s budget; edgeWake restores the sound', () => {
  const idle = between('async function edgeIdle()', 'async function edgeWake()');
  assert.match(idle, /performance\.now\(\)-began<12000/, 'sampled for 12 s: past the old 10 s default and the 1 s muted hide');
  assert.match(idle, /shown=shown && discShown\(\)/, 'every sample must show the disc');
  assert.match(idle, /ok:native\.state==='compact' && shown && discShown\(\)/);
  const wake = between('async function edgeWake()', 'async function islandHoverPin()');
  assert.match(wake, /action:edgeIdlePrefs\.sound \? 'sound_on':'sound_off'/);
});
test('the muted hover scene asserts the NEW rule: muted, the folded disc stays on screen', () => {
  const hold = between('async function islandHoverPin()', 'return {mutedDiscShown');
  assert.match(hold, /const mutedDiscShown=discShown\(\);/);
});
test('the retained-notices scene asserts the NEW rule: with retained notices the folded disc stays on screen', () => {
  const cycle = between('async function noticeCycle()', 'let noticeEdgeSound');
  assert.doesNotMatch(cycle, /retainedDoesNotBlockEdge|retainedBlocksEdge/);
  assert.match(cycle, /const foldedDiscShown=discShown\(\);/);
  assert.match(cycle, /historical && foldedDiscShown/);
});
test('the real-notice scene folds to a visible disc first, then the notice opens the island', () => {
  const prep = between('async function prepareNoticeEdge()', 'async function notice()');
  assert.match(prep, /dataset\.phase==='compact' && discShown\(\)/);
  const notice = between('async function notice()', 'async function shortcutDispatch()');
  assert.match(notice, /dataset\.phase==='expanded'/);
});
test('the pending-question scene still asserts a pending question is never concealed', () => {
  const alert = between('async function shortcutAlert()', 'async function ');
  assert.match(alert, /neverConcealed=byId\('capsule'\)\.dataset\.edgeHidden!=='true'/);
});
test('the answer scene still finds the vertical rows: <button class="q-option"> inside #question-options whose text names the option', () => {
  assert.match(src, /querySelectorAll\('#question-options \.q-option'\)\]\.find\(b=>visible\(b\) && b\.textContent\.includes\('Validar'\)\)/);
  const notify = fs.readFileSync(path.join(__dirname, '../frontend/notify.js'), 'utf8');
  assert.match(notify, /el\('button', r\.kind === 'other' \? 'q-option q-other' : 'q-option'\)/, 'rows keep the q-option class');
  assert.match(notify, /el\('span', 'q-label', r\.label\)/, 'and carry the label text the scene matches');
});
test('terminal shortcut scenes accept the value the product writes: «focused-session» when a session is focused (fc7f679), «focused-class» only with none', () => {
  const isl = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(isl, /focusedSessionKey \? 'focused-session' : 'focused-class'/, 'the product distinguishes the two');
  const a = between('async function shortcutDispatch()', 'async function shortcutTerminalAbsent()');
  assert.doesNotMatch(a, /shortcutTerminal==='focused-class'/, 'the dispatch scene runs with the overview sessions focused: it must not wait for the class-only value');
  assert.match(a, /\['focused-session','focused-class'\]\.includes\(byId\('capsule'\)\.dataset\.shortcutTerminal\)/, 'either confirmation is a success; «unavailable»/«pending» is not');
  const b = between('async function shortcutTerminalAbsent()', 'async function shortcutAlert()');
  assert.match(b, /\['focused-session','focused-class'\]\.includes\(byId\('capsule'\)\.dataset\.shortcutTerminal\)/);
});
test('the focus scene encodes the A+E rules: every session is a blob row (no 2x2 cap, the focused one stays), the centre names the SAME session the jump targets', () => {
  const f = between('async function sessionsFocus()', 'async function restoreSessionFocus()');
  assert.doesNotMatch(f, /grid\.length<=4/, 'no 2x2 cap of four');
  assert.doesNotMatch(f, /!grid\.includes\(beta\.id\)/, 'the focused session stays a row');
  assert.match(f, /grid\.includes\(beta\.id\)/);
  assert.match(f, /centreName\(\)===/, 'the centre column is read, not the old who-row');
  assert.match(f, /\.centre-name/);
  assert.doesNotMatch(f, /querySelector\('\.who \.name'\)/, 'the who-row text is gone: the centre column says the session name');
});
test('the terminal shortcut scene REPORTS which mode the product wrote, so the native readback is judged against the right expectation (stale class-only assumption after fc7f679)', () => {
  const a = between('async function shortcutDispatch()', 'async function shortcutTerminalAbsent()');
  assert.match(a, /terminal_mode:mode/);
  assert.match(a, /class_only:mode==='focused-class'/);
  const probe = fs.readFileSync(path.join(__dirname, '../src/probe.rs'), 'utf8');
  const focusAt = probe.indexOf('AbitoValidate.sessionsFocus()'), shortcutAt = probe.indexOf('AbitoValidate.shortcutDispatch()');
  assert.ok(focusAt > 0 && shortcutAt > focusAt, 'the focus scene runs BEFORE the shortcut scene and leaves a session focused: the order is the cause');
});
test('the terminal shortcut scene STARTS with no focused session: it publishes focusId null right before Ctrl+Alt+T, so the class fixture stays the expected window', () => {
  const a = between('async function shortcutDispatch()', 'async function shortcutTerminalAbsent()');
  const press = a.indexOf("await key('Ctrl+Alt+t')");
  const clear = a.indexOf("new CustomEvent('abito:sessions-view',{detail:{view:null,focusId:null}})");
  assert.ok(press > 0, 'the scene presses the terminal shortcut');
  assert.ok(clear > 0 && clear < press, 'the focus is cleared BEFORE the press (the session key is read at press time)');
  assert.ok(a.slice(clear, press).length < 400, 'and right before it, so the 2 s ticker poll cannot restore the focus in between');
  const isl = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  assert.match(isl, /abito:sessions-view[\s\S]{0,200}focusedSessionKey = typeof id === 'string'/, 'island.js derives the key from that same event: null in, plain class verb out');
});
console.log(`validate-edge-scenes: ${passed} checks ok`);
