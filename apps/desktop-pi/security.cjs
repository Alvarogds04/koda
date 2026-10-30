'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { endpointShape } = require('./config.cjs');

// Read-only port of legacy transport.cjs checks. Never mkdir, chmod or unlink.
function privateDirectory(target, owner) {
  let current = '/';
  for (const part of target.split('/').filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, owner].includes(stat.uid) || (stat.mode & 0o002)) {
      throw new Error('Unsafe directory chain');
    }
  }
  const stat = fs.lstatSync(target);
  if (stat.uid !== owner || (stat.mode & 0o7777) !== 0o700) throw new Error('Private directory required');
}
function verifyEndpoint(endpoint, runtime, options = {}) {
  if ((options.platform ?? process.platform) === 'win32') {
    // Shape only: the native relay verifies private metadata and the actual
    // server PID/SID before forwarding any protocol bytes.
    const { windowsEndpointShape } = require('./config.cjs');
    if (!windowsEndpointShape(endpoint) || path.win32.dirname(endpoint) !== runtime) {
      throw new Error('Unexpected endpoint');
    }
    return { dev: 0, ino: 0 };
  }
  if ((process.platform !== 'linux' && process.platform !== 'darwin') || !endpointShape(endpoint, runtime)) throw new Error('Unexpected endpoint');
  const owner = process.getuid();
  privateDirectory(runtime, owner);
  privateDirectory(path.dirname(endpoint), owner);
  const stat = fs.lstatSync(endpoint);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== owner || (stat.mode & 0o7777) !== 0o600) {
    throw new Error('Unsafe socket');
  }
  return { dev: stat.dev, ino: stat.ino };
}
module.exports = { verifyEndpoint };
