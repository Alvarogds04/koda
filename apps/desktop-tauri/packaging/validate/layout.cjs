'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Match the shipped runtime's data-file modes, not the checkout's umask.
// In particular the daemon refuses group/world-writable installer scripts.
function copyRuntimeFile(source, dest) {
  fs.mkdirSync(path.dirname(dest), {recursive:true, mode:0o700});
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o644);
}
module.exports = {copyRuntimeFile};
