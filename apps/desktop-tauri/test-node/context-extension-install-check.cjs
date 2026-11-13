'use strict';
// K2-06 B1-R1: gnome-extension/install.sh copies EVERY module extension.js imports. A module left behind
// (token.js was) makes the GNOME Shell refuse to load the extension at all, and with it window context.
// Runs the real script into a temporary XDG_DATA_HOME; it never touches the user's own extensions folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {spawnSync} = require('child_process');
const root = path.join(__dirname, '..', 'gnome-extension');
const uuid = 'abito-context@abito';
const source = path.join(root, uuid);

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-ext-install-'));
try {
  const home = path.join(data, 'home'); // HOME is private too: an unset XDG_DATA_HOME must not leak out of it
  fs.mkdirSync(home);
  const run = spawnSync('sh', [path.join(root, 'install.sh')], {
    env: {PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(data, 'share')}, encoding: 'utf8',
  });
  assert.strictEqual(run.status, 0, `install.sh failed: ${run.stderr}`);
  const dest = path.join(data, 'share', 'gnome-shell', 'extensions', uuid);
  assert.ok(fs.existsSync(dest), 'the extension folder is created under XDG_DATA_HOME');

  // Every module extension.js (and token.js) imports from the extension's own folder must be installed.
  const imports = (file) => [...fs.readFileSync(path.join(source, file), 'utf8').matchAll(/^import .* from '(\.\/[^']+)';$/gm)].map((m) => m[1].slice(2));
  const needed = new Set(['metadata.json', 'extension.js']);
  const queue = ['extension.js'];
  while (queue.length) {
    for (const mod of imports(queue.pop())) {
      if (!needed.has(mod)) { needed.add(mod); queue.push(mod); }
    }
  }
  assert.ok(needed.has('token.js'), 'extension.js imports token.js (the check is looking at the right thing)');
  for (const file of needed) {
    assert.ok(fs.existsSync(path.join(dest, file)), `${file} was installed`);
    assert.strictEqual(fs.readFileSync(path.join(dest, file), 'utf8'), fs.readFileSync(path.join(source, file), 'utf8'), `${file} is the shipped one`);
  }
  // And everything else the extension ships is there too: no file is left behind.
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), fs.readdirSync(source).sort());
  // The user's real home got nothing.
  assert.ok(!fs.existsSync(path.join(home, '.local')), 'XDG_DATA_HOME was honoured');
  // Installing again over an existing copy is fine (an update).
  assert.strictEqual(spawnSync('sh', [path.join(root, 'install.sh')], {env: {PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(data, 'share')}}).status, 0);
  console.log(`context-extension-install-check ok (${needed.size} required files, ${fs.readdirSync(dest).length} installed)`);
} finally {
  fs.rmSync(data, {recursive: true, force: true});
}
