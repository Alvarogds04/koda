'use strict';
// Offline build: never downloads a compiler or reads the external reference tree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../frontend/vendor/coucou');
// The pinned esbuild 0.28.2 binary: ESBUILD_BINARY_PATH, else the copy a local Pi install ships under $HOME (never downloaded here).
const compiler = process.env.ESBUILD_BINARY_PATH || path.join(require('node:os').homedir(), '.pi/agent/npm/node_modules/@esbuild/linux-x64/bin/esbuild');
const inputs = ['settings/colors', 'settings/parts', 'settings/toggle', 'core/pill-colors', 'views/dom', 'i18n/i18n', 'core/pills', 'core/shortcuts', 'core/providers', 'core/state', 'views/icons', 'core/anim', 'core/diff', 'views/ticker', 'hub/ui', 'hub/shell', 'hub/hero', 'hub/flow-shim', 'hub/bridge-shim', 'hub/i18n-es', 'hub/general', 'hub/runtime', 'hub/accounts', 'hub/personalization', 'hub/pages', 'hub/notch', 'hub/agents', 'hub/piinstall', 'hub/chat', 'hub/integrations', 'hub/shortcuts', 'hub/recap', 'core/plan', 'views/usage', 'core/github', 'views/github', 'recap/summary', 'views/recap', 'hub/dictation-pages', 'hub/data-pages', 'hub/keyaccounts', 'hub/voice-page'];
if (!fs.existsSync(compiler)) throw new Error('Falta esbuild local: indicar ESBUILD_BINARY_PATH; no se instalará nada.');
const version = execFileSync(compiler, ['--version'], { encoding: 'utf8' }).trim();
if (version !== '0.28.2') throw new Error(`esbuild ${version}: se requiere 0.28.2 para salida reproducible`);
// Scoped writer builds must not rewrite another workstream's generated files.
const selected = process.argv.includes('--hub-only') ? inputs.filter(file => file.startsWith('hub/')) : inputs;
for (const file of selected) {
  const source = fs.readFileSync(path.join(root, `${file}.ts`), 'utf8');
  const banner = source.split('\n')[0];
  const output = execFileSync(compiler, [`${file}.ts`, '--format=esm', '--target=es2021', '--charset=utf8', '--legal-comments=inline', `--banner:js=${banner}`, '--log-level=error'], { cwd: root });
  const destination = path.join(root, `${file}.js`);
  // Do not rewrite unchanged generated files owned by another scoped workstream.
  if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(output)) fs.writeFileSync(destination, output);
}
console.log(`Built ${selected.length} MIT/Abito modules with esbuild ${version} (offline)`);
