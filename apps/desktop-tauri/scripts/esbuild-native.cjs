'use strict';
// K2-01b: the pinned esbuild's NATIVE binary for this OS inside a global npm root, for ESBUILD_BINARY_PATH. Never the
// bin/esbuild JS shim: Windows cannot execute it directly (spawnSync … ENOENT). Nothing is downloaded or installed:
// it only looks at what `npm i -g esbuild@0.28.2` already placed (the platform package nested under esbuild, or hoisted).
// Usage: node esbuild-native.cjs <npm root -g>   → prints the path; exit 1 when no native binary is installed.
const fs = require('node:fs');
const path = require('node:path');

function nativeEsbuild(npmRoot, { platform = process.platform, arch = process.arch, exists = fs.existsSync } = {}) {
  const pkg = path.join('@esbuild', `${platform}-${arch}`);
  const file = platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild');
  for (const base of [path.join(npmRoot, 'esbuild', 'node_modules'), npmRoot]) {
    const candidate = path.join(base, pkg, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

if (require.main === module) {
  const found = typeof process.argv[2] === 'string' ? nativeEsbuild(process.argv[2]) : null;
  if (!found) process.exit(1);
  process.stdout.write(`${found}\n`);
}

module.exports = { nativeEsbuild };
