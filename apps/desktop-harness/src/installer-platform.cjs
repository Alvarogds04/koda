'use strict';
// HU-015: platform identity probes. Linux's existing /proc guard remains in install-ui.cjs.
// These probes establish peer identity only; they never grant filesystem ownership or repair ACLs.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runPsExecutable } = require('../../desktop-daemon/src/procinfo.cjs');
const SID = /^S-1-(?:\d+-)*\d+$/;
function parentIdentityMatches({ platform, expected, executable, current, parent }) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || typeof expected !== 'string' || !expected || executable !== expected) return false;
  if (platform === 'win32') return typeof current === 'string' && SID.test(current) && current === parent;
  return Number.isSafeInteger(current) && current >= 0 && current === parent;
}
function darwinParentExecutable(pid, { uid = process.getuid?.(), exec = execFileSync } = {}) {
  const facts = runPsExecutable(pid, exec);
  if (!facts || !parentIdentityMatches({platform:'darwin', expected:facts.executable, executable:facts.executable, current:uid, parent:facts.uid})) return undefined;
  return facts.executable;
}
function sessionHelper() {
  // The same single resolver as the daemon: installed sibling whose sha256 matches abito-install.json (HU-047 M2).
  return require('./win-fs.cjs').resolveHelper();
}
function windowsParentExecutable(pid, { helper = sessionHelper(), exec = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0xffffffff || !helper) return undefined;
  try {
    const raw = exec(helper, ['--parent-check', String(pid)], {encoding:'utf8', timeout:2000, maxBuffer:8192, stdio:['ignore','pipe','ignore'], windowsHide:true});
    const facts = JSON.parse(raw);
    if (!facts || Object.keys(facts).sort().join(',') !== 'currentSid,executable,parentSid,pid,schema' || facts.schema !== 'abito-parent/1' || facts.pid !== pid) return undefined;
    if (typeof facts.executable !== 'string' || !/^[A-Za-z]:[\\/]/.test(facts.executable) || /[\x00-\x1f\x7f]/.test(facts.executable)) return undefined;
    return parentIdentityMatches({platform:'win32', expected:facts.executable, executable:facts.executable, current:facts.currentSid, parent:facts.parentSid}) ? facts.executable : undefined;
  } catch { return undefined; }
}
module.exports = { parentIdentityMatches, darwinParentExecutable, windowsParentExecutable };
