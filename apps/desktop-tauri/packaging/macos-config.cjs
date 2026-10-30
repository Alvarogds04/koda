'use strict';
// JSON passed to tauri build --config. Paths are relative to the Tauri crate,
// not this script's cwd. Reuse the Linux packager's closed, tested source lists.
const { DAEMON_FILES, HARNESS_FILES, PI_FILES } = require('./lib.cjs');
process.stdout.write(JSON.stringify({
  bundle: {
    active: true,
    icon: ['icons/icon.icns'],
    category: 'Productivity',
    // signingIdentity '-' = ad-hoc seal of the whole .app (free, no Apple account): Gatekeeper then shows
    // «unidentified developer» instead of «damaged». Hardened runtime adds nothing without a team identity.
    macOS: { minimumSystemVersion: '12.0', signingIdentity: '-', hardenedRuntime: false },
    resources: Object.fromEntries([
      ...DAEMON_FILES.map(file => [`../desktop-daemon/${file}`, `desktop-daemon/${file}`]),
      ...HARNESS_FILES.map(file => [`../desktop-harness/${file}`, `desktop-harness/${file}`]),
      ...PI_FILES.map(file => [`../desktop-pi/${file}`, `desktop-pi/${file}`]),
    ]),
  },
}) + '\n');
