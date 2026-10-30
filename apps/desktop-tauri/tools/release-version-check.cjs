#!/usr/bin/env node
'use strict';
/* Rule 13 (human, 29-oct): «me sale en ajustes 0.1.2 creoque eso no cambia, es importanet que cambie» / «esto ponlo como
   requisito que siempre poner si se cambia de version». A release tag must be exactly what the app shows.
   Usage: node tools/release-version-check.cjs <tag>   e.g. v0.3.0-preview.4 (preview) or v0.3.0 (stable). Exit 0 only when
   Cargo.toml, tauri.conf.json, Cargo.lock and RELEASE_CHANNEL all agree with the tag. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function expected(dir = root) {
  const cargo = /^version = "([^"]+)"/m.exec(fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'))?.[1];
  const conf = JSON.parse(fs.readFileSync(path.join(dir, 'tauri.conf.json'), 'utf8')).version;
  const lock = /name = "abito-island"\nversion = "([^"]+)"/.exec(fs.readFileSync(path.join(dir, 'Cargo.lock'), 'utf8'))?.[1];
  const channel = fs.readFileSync(path.join(dir, 'RELEASE_CHANNEL'), 'utf8').trim();
  const problems = [];
  if (!cargo || cargo !== conf || cargo !== lock) problems.push(`versions disagree: Cargo.toml ${cargo}, tauri.conf.json ${conf}, Cargo.lock ${lock}`);
  if (channel && !/^preview\.[1-9][0-9]*$/.test(channel)) problems.push(`RELEASE_CHANNEL must be empty or preview.N: ${JSON.stringify(channel)}`);
  return { tag: `v${cargo}${channel ? '-' + channel : ''}`, shown: channel ? `${cargo} (preview ${channel.slice(8)})` : cargo, problems };
}
module.exports = { expected };
if (require.main === module) {
  const tag = process.argv[2];
  const e = expected();
  if (!tag) { console.error('usage: release-version-check.cjs <tag>'); process.exit(2); }
  if (e.problems.length || tag !== e.tag) {
    for (const p of e.problems) console.error(p);
    if (tag !== e.tag) console.error(`tag ${tag} does not match the app: it shows «${e.shown}», whose tag is ${e.tag}. Bump Cargo.toml/tauri.conf.json/Cargo.lock/RELEASE_CHANNEL first.`);
    process.exit(1);
  }
  console.log(`release ${tag}: Ajustes shows «${e.shown}»`);
}
