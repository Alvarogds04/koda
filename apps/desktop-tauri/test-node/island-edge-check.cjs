'use strict';
/* isla-cualquier-lado S2 (human: «solo el círculo con koda pero sin que esté oculto, más simple podemos quitar solo el temporizador»):
   the folded island never hides at the screen edge any more. This check used to drive the edge-hide controller (G16 / L40: 10 s
   default, 5–300 s, 1 s when muted); it now pins that the controller is retired and that the fold timer it never touched is intact.
   Run: node test-node/island-edge-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../frontend/island-interaction.js');
const frontend = path.join(__dirname, '..', 'frontend');

assert.equal(I.createEdgeController, undefined, 'no edge-hide controller');
assert.equal(I.EDGE_ABSENCE, undefined, 'no edge-hide delay range');
assert.equal(I.EDGE_BLOCKERS, undefined, 'no edge-hide blockers');
// the fold («Plegar tras (s)») is a different timer and stays exactly as it was
assert.deepEqual(I.DEFAULTS, { autoCloseSeconds: 15, openOnHover: false });
assert.equal(typeof I.createController, 'function');
assert.equal(I.validPreferences({ autoCloseSeconds: 0, openOnHover: false }), true, '«Nunca» still accepted');
assert.equal(I.validPreferences({ autoCloseSeconds: 120, openOnHover: true }), true);
assert.equal(I.validPreferences({ autoCloseSeconds: 4, openOnHover: true }), false);
// nothing on the page drives a hidden state any more
const island = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
assert.doesNotMatch(island, /createEdgeController|setConcealed|__islandConceal|edgeHidden|edgeWhy/);
assert.doesNotMatch(fs.readFileSync(path.join(frontend, 'koda-skin.js'), 'utf8'), /edgeHidden/, 'Koda is never told the island is hidden');
assert.doesNotMatch(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), /id="edge-strip"/);
console.log('PASS island-edge: the edge-hide controller is retired; the fold timer is untouched');
