#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'abito-checkout-'));
const samples = [];
function git(...args) {
  const r = spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return r;
}
try {
  git('init', '-q'); git('config', 'core.autocrlf', 'true');
  for (const app of ['desktop-tauri', 'desktop-daemon', 'desktop-harness']) {
    const dir = `apps/${app}`;
    fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    fs.copyFileSync(path.join(repo, dir, '.gitattributes'), path.join(scratch, dir, '.gitattributes'));
    for (const ext of ['js', 'cjs', 'ts', 'json', 'md', 'mjs']) {
      const file = `${dir}/fixture.${ext}`;
      fs.writeFileSync(path.join(scratch, file), 'first\nsecond\n'); samples.push(file);
    }
  }
  const clay = 'apps/desktop-tauri/frontend/clay-engine.js';
  fs.mkdirSync(path.dirname(path.join(scratch, clay)), { recursive: true });
  const expected = fs.readFileSync(path.join(repo, clay));
  fs.writeFileSync(path.join(scratch, clay), expected);
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  for (const file of [...samples, clay]) fs.unlinkSync(path.join(scratch, file));
  git('checkout', '--', '.');
  for (const file of samples) assert.equal(fs.readFileSync(path.join(scratch, file), 'utf8'), 'first\nsecond\n', file);
  assert.deepEqual(fs.readFileSync(path.join(scratch, clay)), expected);
  const workflow = fs.readFileSync(path.join(repo, 'apps/desktop-tauri/ci/public/preview-windows.yml'), 'utf8');
  const beforeCheckout = workflow.split('      - uses: actions/checkout@v4')[0];
  assert.match(beforeCheckout, /git config --global core.autocrlf false/);
  assert.match(beforeCheckout, /git config --global core.eol lf/);
  console.log('PASS: actual git autocrlf checkout preserves package bytes and pinned engine; CI config precedes checkout');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
