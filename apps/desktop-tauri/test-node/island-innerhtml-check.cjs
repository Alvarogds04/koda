'use strict';
/* #411 — public check for frontend/island.js: zero markup sinks, and the nine
   former innerHTML/outerHTML sites render DOM nodes built from the CLOSED own
   registry (S2 of frontend/settings.js: “Plain text only (textContent). No
   innerHTML anywhere: icons are DOM nodes built from the closed own registry
   (DOMParser), so no data can ever become markup.”). Source + registry checks
   only: no DOM, no network, no browser.
   Run: node apps/desktop-tauri/test-node/island-innerhtml-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const I = require(path.join(frontend, 'icons.js'));
const raw = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
// Comments are not code: the sink must be absent from what actually ships.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const lines = src.split('\n');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };

// ---- S4: zero markup sinks -----------------------------------------------
test('S4: island.js performs no innerHTML/outerHTML assignment (no markup sink at all)', () => {
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no markup sink in island.js');
});

// ---- the nine former sites (S3) ------------------------------------------
// The nine innerHTML/outerHTML writes the #338 worker counted: the static
// [data-icon] bootstrap plus these eight hosts.
const HOSTS = ['notice-ring', 'connection-icon', 'bridge-icon', 'card-bridge-icon',
  'card-conn-icon', 'hotkey-icon', 'compact-flag-icon', 'card-status-icon'];

test('S3: the nine former innerHTML sites paint DOM nodes through putIcon (replaceChildren)', () => {
  assert.doesNotMatch(raw, /\.innerHTML|\.outerHTML/, 'the nine writes are gone'); // fails today, on purpose
  for (const host of HOSTS) {
    // the host must be PAINTED with a node through putIcon somewhere; other
    // mentions (e.g. #437 re-parents the static ring into the rebuilt band)
    // must still keep no markup sink
    const paint = lines.find(l => l.includes(`$('${host}')`) && /putIcon\(/.test(l));
    assert.ok(paint, `#${host} is painted with a node, never with markup`);
    for (const line of lines.filter(l => l.includes(`$('${host}')`))) {
      assert.doesNotMatch(line, /innerHTML|outerHTML/, `#${host} keeps no markup sink`);
    }
  }
  const boot = lines.find(l => l.includes("[data-icon]"));
  assert.ok(boot, 'the static [data-icon] bootstrap exists');
  assert.match(boot, /putIcon\(/, 'the static icons are nodes too');
  assert.doesNotMatch(boot, /innerHTML|outerHTML/, 'the bootstrap keeps no markup sink');
  // every paint goes through the one node writer
  assert.match(src, /const putIcon = /);
  assert.match(src, /replaceChildren/);
});

// ---- S2: the parser only ever sees closed-registry markup ----------------
test('S2: icons are parsed from the closed registry through DOMParser, never from data', () => {
  assert.match(src, /new DOMParser\(\)/, 'the island parses markup itself');
  assert.match(src, /parseFromString\(markup, 'image\/svg\+xml'\)/, 'parsed as SVG, not as HTML, and only ever the registry markup');
  assert.equal((src.match(/parseFromString\(/g) || []).length, 1, 'one single parse entry point');
  assert.match(src, /importNode\(doc\.documentElement, true\)/, 'the node is imported from the parsed document');
  // the ONLY icon source: window.AbitoIcons.svg (closed registry), like chat.js/settings.js
  assert.match(src, /const icon = name => \(ICONS \? ICONS\.svg\(name\) : ''\)/);
  // every parse feeds registry markup: icon(<literal|path>) or ICONS.ring(<fraction>)
  const calls = lines.filter(l => /iconNode\(/.test(l) && !/function iconNode/.test(l));
  assert.ok(calls.length >= 9, `nine parse sites (S3), got ${calls.length}`);
  const REGISTRY_ARG = /iconNode\((icon\((['"][\w-]+['"]|[A-Za-z_$][\w.]*)\)|ICONS\.ring\([A-Za-z_$][\w.]*\))\)/;
  for (const line of calls) assert.match(line, REGISTRY_ARG, `parse site only from the registry: ${line.trim()}`);
  assert.doesNotMatch(src, /iconNode\([^)]*\$\{/, 'no interpolation ever reaches the parser');
});

// ---- the two literal dots became elements --------------------------------
test('the waiting/status dot is a created element, never a raw <span> string', () => {
  assert.doesNotMatch(raw, /<span class="dot">/, 'no raw span markup left in island.js');
  assert.match(src, /createElement\('span'\)/);
  assert.match(src, /className = 'dot'/);
});

// ---- rendering equivalence the browser cannot be asked to prove ----------
test('an empty/unknown registry entry clears the host exactly like the old empty string did', () => {
  assert.match(src, /if \(!markup\) return null/, 'an empty registry string never reaches the parser');
  assert.match(src, /node \? \[node\] : \[\]/, 'no node = no children, the same empty host');
  assert.equal(I.svg('nope'), '', 'the registry still answers the empty string for unknown names');
  assert.equal(I.svg(undefined), '');
  // the ring the island paints is registry markup with a single balanced root
  for (const f of [0, 0.5, 1]) {
    const ring = I.ring(f);
    assert.match(ring, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.doesNotMatch(ring, /<script|href=|url\(|style=|\son\w+=|<image|<use/i);
    assert.equal((ring.match(/</g) || []).length, (ring.match(/>/g) || []).length);
  }
});

console.log(`island-innerhtml-check: ${passed} passed`);
