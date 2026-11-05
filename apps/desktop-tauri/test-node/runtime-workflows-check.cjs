'use strict';
/* K2-02 T2 (S1): every workflow that builds a macOS bundle first builds Koda's own Node + Pi with the pinned builder
   (--self-check), hands that folder to macos-config.cjs --runtime, and proves on the built .app that the bundled Node
   is a signed Mach-O inside the seal and that the bundled Node and Pi run with no other Node on PATH.
   Reads the workflow files only. Run: node apps/desktop-tauri/test-node/runtime-workflows-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const crate = path.resolve(__dirname, '..');
const repo = path.resolve(crate, '..', '..');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};
const read = (p) => fs.readFileSync(p, 'utf8');

/* Each macOS bundle build: the workflow file, and the line that runs tauri build with macos-config. */
const MAC_WORKFLOWS = ['.github/workflows/release-macos.yml', '.github/workflows/ci.yml'];

test('release-macos.yml stays byte-identical to its public mirror', () => {
  assert.equal(read(path.join(repo, '.github/workflows/release-macos.yml')), read(path.join(crate, 'ci/public/release-macos.yml')));
});

for (const rel of MAC_WORKFLOWS) {
  const text = read(path.join(repo, rel));
  test(`${rel}: builds the darwin-arm64 runtime with --self-check BEFORE the bundle, and bundles exactly that folder`, () => {
    const build = text.indexOf('node packaging/runtime/build-runtime.cjs --target darwin-arm64');
    const bundle = text.indexOf('node packaging/macos-config.cjs');
    assert.ok(build >= 0, 'runs build-runtime.cjs --target darwin-arm64');
    assert.ok(bundle > build, 'the runtime is built before tauri build reads macos-config');
    const step = text.slice(build, text.indexOf('\n      - ', build));
    assert.match(step, /--out "\$RUNNER_TEMP\/koda-runtime"/);
    assert.match(step, /--self-check/);
    assert.ok(text.includes('node packaging/macos-config.cjs --runtime "$RUNNER_TEMP/koda-runtime"'), 'macos-config gets that folder');
    assert.ok(!/node packaging\/macos-config\.cjs\)"/.test(text), 'no macos-config call without --runtime');
  });
  test(`${rel}: on the built .app, the seal verifies, the bundled node is signed, and node + pi run with a bare PATH`, () => {
    const seal = text.indexOf('codesign --verify --deep --strict');
    assert.ok(seal >= 0);
    const after = text.slice(seal);
    assert.ok(after.includes('rt="$app/Contents/Resources/runtime"'));
    assert.ok(after.includes('codesign -dv "$rt/node"'), 'signature of the nested node Mach-O is inspected');
    assert.match(after, /test "\$\(env -i PATH=\/usr\/bin:\/bin "\$rt\/node" --version\)" = "\$want_node"/);
    assert.match(after, /want_node="v\$\(sed -n .*darwin-arm64.* packaging\/runtime\/node\.sha256\)"/, 'expected version comes from the pin');
    assert.match(after, /env -i PATH=\/usr\/bin:\/bin HOME="\$h" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 "\$rt\/pi" --version\)" = 1\.4\.0/);
  });
}
console.log(`runtime-workflows-check: ${passed} passed`);
