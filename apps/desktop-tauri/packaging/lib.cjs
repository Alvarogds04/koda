'use strict';
/* M4 format A (user-local, no root, no download, system WebKitGTK): pure
   checks shared by build.cjs and verify.cjs. Contract:
   docs/desktop-packaging-plan.md §2/§4/§5. Nothing here installs anything or
   launches the app. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const R6_PREFIX = '40625d7f';
const IDENTIFIER = 'com.abitog.AbitoTauri';
const RESERVED = ['com.abitog.Abito', 'com.abitog.Abito.Preview', 'abito-desktop', 'abito-desktop-preview'];
const FRONTEND_FILES = ['DESIGN.md', 'avatar-colors.js', 'character-desktop-logic.js', 'character-minibots.js', 'character-motion.js', 'chat-cards.js', 'chat-markdown.css', 'chat-markdown.js', 'chat-view.js', 'chat.js', 'clay-engine.js', 'desktop-character.css', 'desktop-character.html', 'desktop-character.js', 'desktop.js', 'icons.js', 'index.html', 'integrations-calendar.js', 'integrations-deployments.js', 'integrations-email.js', 'integrations-finance.js', 'integrations-github.js', 'integrations-mail.js', 'integrations-n8n.js',
  'integrations-notion.js', 'integrations-payments.js', 'integrations-view.js', 'island-idle.js', 'island-integrations.js', 'island-integrations.css', 'island-header.js', 'island-github.js', 'island-desktop.js', 'island-dictation.js', 'island-voice.js', 'island-voice.css', 'island-plan.js', 'island-recap.js', 'island-interaction.js', 'island.js', 'models.js', 'notify-view.js', 'notify.js', 'overview-view.js', 'pill-catalog.js', 'pill-settings.js', 'pills-view.js', 'paused.js', 'spotify-view.js', 'pills.js', 'sessions-ticker.js', 'settings-view.js', 'settings.js', 'sound-engine.js', 'sound-wiring.js', 'specialists-view.js', 'specialists.js', 'style.css', 'theme.js'];
FRONTEND_FILES.push('koda-catalog.js', 'koda-logic.js', 'koda-skin.js', 'koda-skin.css', 'koda/koda-chibi-24.png', 'koda/koda-chibi-32.png');
FRONTEND_FILES.push('desktop-highlight.html', 'desktop-highlight.css', 'question-toast.css', 'question-toast.js', 'island-layout.js', 'island-nusa.js', 'island-nusa-bodies.js', 'island-nusa-mount.js', 'island-nusa.css', 'settings-nusa.css', 'settings-nusa.js', 'settings-nusa-mount.js', 'settings-isla.js', 'settings-isla-mount.js');
// Every embedded vendor source, generated module and license is a closed input.
FRONTEND_FILES.push(
  'vendor/coucou/LICENSE', 'vendor/coucou/bridge-abito.js', 'vendor/coucou/package.json',
  'vendor/coucou/core/pill-colors.js', 'vendor/coucou/core/pill-colors.ts',
  'vendor/coucou/core/pills.js', 'vendor/coucou/core/pills.ts',
  'vendor/coucou/core/shortcuts.js', 'vendor/coucou/core/shortcuts.ts',
  'vendor/coucou/core/providers.js', 'vendor/coucou/core/providers.ts',
  'vendor/coucou/core/state.js', 'vendor/coucou/core/state.ts',
  'vendor/coucou/i18n/i18n.js', 'vendor/coucou/i18n/i18n.ts',
  'vendor/coucou/settings/colors.js', 'vendor/coucou/settings/colors.ts',
  'vendor/coucou/settings/parts.js', 'vendor/coucou/settings/parts.ts',
  'vendor/coucou/settings/settings.css',
  'vendor/coucou/island/island.css',
  'vendor/coucou/settings/toggle.js', 'vendor/coucou/settings/toggle.ts',
  'vendor/coucou/views/dom.js', 'vendor/coucou/views/dom.ts',
  'vendor/coucou/views/icons.js', 'vendor/coucou/views/icons.ts',
  'vendor/coucou/views/ticker.js', 'vendor/coucou/views/ticker.ts',
  'vendor/coucou/core/anim.js', 'vendor/coucou/core/anim.ts',
  'vendor/coucou/core/diff.js', 'vendor/coucou/core/diff.ts',
  'vendor/coucou/core/github.js', 'vendor/coucou/core/github.ts',
  'vendor/coucou/views/github.js', 'vendor/coucou/views/github.ts',
  'vendor/coucou/recap/summary.js', 'vendor/coucou/recap/summary.ts',
  'vendor/coucou/views/recap.js', 'vendor/coucou/views/recap.ts',
  'vendor/coucou/core/plan.js', 'vendor/coucou/core/plan.ts',
  'vendor/coucou/views/usage.js', 'vendor/coucou/views/usage.ts',
  'settings.html', 'settings-app.js',
  'vendor/coucou/hub/hub.css', 'vendor/coucou/hub/abito.css',
  'vendor/coucou/hub/ui.ts', 'vendor/coucou/hub/ui.js',
  'vendor/coucou/hub/shell.ts', 'vendor/coucou/hub/shell.js',
  'vendor/coucou/hub/hero.ts', 'vendor/coucou/hub/hero.js',
  'vendor/coucou/hub/flow-shim.ts', 'vendor/coucou/hub/flow-shim.js',
  'vendor/coucou/hub/bridge-shim.ts', 'vendor/coucou/hub/bridge-shim.js',
  'vendor/coucou/hub/i18n-es.ts', 'vendor/coucou/hub/i18n-es.js',
  'vendor/coucou/hub/general.ts', 'vendor/coucou/hub/general.js',
  'vendor/coucou/hub/runtime.ts', 'vendor/coucou/hub/runtime.js',
  'vendor/coucou/hub/accounts.ts', 'vendor/coucou/hub/accounts.js',
  'vendor/coucou/hub/personalization.ts', 'vendor/coucou/hub/personalization.js',
  'vendor/coucou/hub/pages.ts', 'vendor/coucou/hub/pages.js',
  'vendor/coucou/hub/dictation-pages.ts', 'vendor/coucou/hub/dictation-pages.js',
  'vendor/coucou/hub/data-pages.ts', 'vendor/coucou/hub/data-pages.js', 'vendor/coucou/hub/keyaccounts.ts', 'vendor/coucou/hub/keyaccounts.js', 'vendor/coucou/hub/voice-page.ts', 'vendor/coucou/hub/voice-page.js', 'vendor/coucou/hub/privacy-page.js',
  'vendor/coucou/hub/notch.ts', 'vendor/coucou/hub/notch.js',
  'vendor/coucou/hub/agents.ts', 'vendor/coucou/hub/agents.js',
  'vendor/coucou/hub/chat.ts', 'vendor/coucou/hub/chat.js',
  'vendor/coucou/hub/piinstall.ts', 'vendor/coucou/hub/piinstall.js', // HU-046: imported by accounts.js and agents.js
  'vendor/coucou/hub/integrations.ts', 'vendor/coucou/hub/integrations.js',
  'vendor/coucou/hub/shortcuts.ts', 'vendor/coucou/hub/shortcuts.js',
  'vendor/coucou/hub/recap.ts', 'vendor/coucou/hub/recap.js',
);
const EXPECTED_WINDOWS = ['main', 'settings'];
const EXPECTED_PERMISSIONS = ['core:event:allow-listen', 'core:event:allow-unlisten'];
// Inverted logic: EVERY ABITO_* variable is refused except the one the
// installed app is meant to receive (ABITO_PROJECT_ROOT); plus the whole LD_*
// loader family and the GTK/GDK/WebKit debug + inspector variables.
const FORBIDDEN_ENV_PATTERN = '^(LD_[A-Za-z0-9_]*|GDK_(DEBUG|SYNCHRONIZE|RENDERING)|GTK_(DEBUG|MODULES|PATH|EXE_PREFIX|DATA_PREFIX)|WEBKIT_INSPECTOR_[A-Za-z_]*|ABITO_[A-Za-z0-9_]*)=';
const ALLOWED_ABITO = 'ABITO_PROJECT_ROOT';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = file => sha256(fs.readFileSync(file));

// ---- source checks (before building) ------------------------------------
function checkR6(crate) {
  const hash = sha256File(path.join(crate, 'frontend', 'clay-engine.js'));
  if (!hash.startsWith(R6_PREFIX)) throw new Error(`R6 pin failed: clay-engine.js is ${hash.slice(0, 8)}, expected ${R6_PREFIX}`);
  return hash;
}
function checkFrontend(crate) {
  const root = path.join(crate, 'frontend');
  const walk = (prefix = '') => fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) return walk(rel + '/');
    if (!entry.isFile()) throw new Error(`frontend/${rel} is not a regular file or directory`);
    return [rel];
  });
  const found = walk().sort();
  const extra = found.filter(f => !FRONTEND_FILES.includes(f));
  const missing = FRONTEND_FILES.filter(f => !found.includes(f));
  if (extra.length || missing.length) throw new Error(`frontend/ differs from the curated list: extra=[${extra}] missing=[${missing}]`);
  return found;
}
// The gate's contract is to FAIL on drift, but a bare SyntaxError does not say
// WHICH file drifted, and these fixtures are copied around by the tests. Read,
// name the file, rethrow: fail-fast stays, the message becomes actionable.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
}

function checkConfig(crate) {
  const conf = readJson(path.join(crate, 'tauri.conf.json'));
  if (conf.identifier !== IDENTIFIER) throw new Error(`identifier must be ${IDENTIFIER}`);
  if (RESERVED.includes(conf.identifier)) throw new Error('identifier collides with an installed app');
  const csp = (conf.app && conf.app.security && conf.app.security.csp) || '';
  if (!/default-src 'self'/.test(csp)) throw new Error("CSP must start from default-src 'self'");
  if (/unsafe-(eval|inline)|https?:\/\/(?!ipc\.localhost)|\*/.test(csp)) throw new Error('CSP allows unsafe or remote sources');
  const connect = (/connect-src ([^;]*)/.exec(csp) || [])[1];
  if (connect !== "'self' ipc: http://ipc.localhost") throw new Error(`connect-src must be exactly 'self' ipc: http://ipc.localhost, got: ${connect}`);
  if (!/(^|;)\s*object-src 'none'/.test(csp) || !/frame-src 'none'/.test(csp) || !/base-uri 'none'/.test(csp)) throw new Error('CSP must keep object-src/frame-src/base-uri none');
  if (conf.app.withGlobalTauri !== true) throw new Error('withGlobalTauri expected (the page uses window.__TAURI__)');
  const cap = readJson(path.join(crate, 'capabilities', 'main.json'));
  const perms = [...cap.permissions].sort();
  if (JSON.stringify(perms) !== JSON.stringify([...EXPECTED_PERMISSIONS].sort())) throw new Error(`capabilities drifted: ${perms}`);
  if (JSON.stringify([...(cap.windows || [])].sort()) !== JSON.stringify([...EXPECTED_WINDOWS].sort())) throw new Error(`capability windows drifted: ${cap.windows}`);
  const cargo = fs.readFileSync(path.join(crate, 'Cargo.toml'), 'utf8');
  const tauriLine = /^tauri = \{[^}]*\}/m.exec(cargo);
  if (!tauriLine) throw new Error('tauri dependency line not found');
  if (/devtools/.test(tauriLine[0]) || /devtools/.test(cargo)) throw new Error('the devtools feature must stay off');
  if (/shell|process|fs|http/.test(tauriLine[0])) throw new Error('no extra tauri features/plugins in the packaged app');
  if (/tauri-plugin-(shell|fs|http|process|opener)/.test(cargo)) throw new Error('forbidden plugin dependency');
  // law: no synthetic input (XTest) in production. It may live ONLY in a
  // dev-dependencies table. Since the Windows port (U1a) the Unix-only crates
  // sit in target-specific tables, so the section name can be either
  // `[dev-dependencies]` or `[target.'cfg(unix)'.dev-dependencies]`: walk the
  // file by table and drop every dev table wherever it appears, keeping all
  // production tables (plain `[dependencies]` AND `[target.'...'.dependencies]`)
  // in `prod` so a target-specific smuggling of xtest still trips the law.
  const DEV_TABLE = /^(?:target\.'[^']*'\.)?dev-dependencies$/;
  const prodLines = [];
  let table = '';
  for (const line of cargo.split('\n')) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) table = head[1].trim();
    if (DEV_TABLE.test(table)) continue;
    if (line.trim().startsWith('#')) continue;
    prodLines.push(line);
  }
  const prod = prodLines.join('\n');
  if (/xtest/i.test(prod)) throw new Error('xtest (synthetic input) must not be a production dependency: keep it in [dev-dependencies]');
  return { version: conf.version, identifier: conf.identifier, csp };
}

// ---- launcher / desktop entry (content is closed and hashed) -------------
function launcherText() {
  return `#!/bin/sh
# Abito (Tauri) launcher — M4 format A. Accepts no arguments, refuses the
# whole LD_* family, GTK/GDK/WebKit debug and inspector variables and every
# ABITO_* test/probe/override knob (only ABITO_PROJECT_ROOT passes), forces
# X11/XWayland (absolute positioning and always-on-top). Never touches the
# Preview's roots.
set -eu
[ "$#" -eq 0 ] || { echo "abito: no arguments accepted" >&2; exit 64; }
# The GNOME session itself exports GTK_MODULES=gail:atk-bridge (accessibility bridge): only that exact value is dropped (not
# loaded), so the menu entry opens Abito; any other GTK_MODULES value is still refused below.
if [ "\${GTK_MODULES:-}" = "gail:atk-bridge" ]; then unset GTK_MODULES; fi
bad="$(env | grep -E '${FORBIDDEN_ENV_PATTERN}' | grep -v '^${ALLOWED_ABITO}=' | cut -d= -f1 | head -n 1 || true)"
[ -z "$bad" ] || { echo "abito: refusing $bad" >&2; exit 64; }
here="$(cd "$(dirname "$0")" && pwd)"
export GDK_BACKEND=x11
exec "$here/abito-island"
`;
}
function desktopText() {
  return `[Desktop Entry]
Type=Application
Name=Koda
Comment=Koda
Exec="@INSTALL_DIR@/abito-island-launcher"
Icon=@INSTALL_DIR@/abito-island.png
Terminal=false
Categories=Utility;
StartupWMClass=Abito-island
`;
}

// ---- receipt verification (no launch) -------------------------------------
const DAEMON_FILES = ['package.json', 'identity.md', 'THIRD-PARTY-NOTICES.md',
  'src/agent-hooks.cjs', 'src/agents-direct.cjs', 'src/agents.cjs', 'src/auth.cjs', 'src/cli.cjs', 'src/config.cjs',
  'src/connectors.cjs', 'src/connector-host.cjs', 'src/connector-host-client.cjs', 'src/custom-provider.cjs', 'src/custom-provider-extension.cjs',
  'src/daemon.cjs', 'src/interrupt.cjs', 'src/isolation.cjs', 'src/mcp-import.cjs', 'src/profiles.cjs',
  'src/protocol.cjs', 'src/rotation.cjs', 'src/runtime.cjs', 'src/sdk-helper.mjs', 'src/server.cjs',
  'src/sessions.cjs', 'src/procinfo.cjs', 'src/spaces.cjs', 'src/win-fs.cjs'];
// L42 F1: the hook installer (apps/desktop-harness) ships NEXT TO the daemon: the daemon derives
// <package>/desktop-harness/bin/abito-hook.cjs from its own location (src/cli.cjs packagedInstallerBin), so Ajustes can
// install the Claude/Codex/recap/status-line hooks. Closed under require(): packaging-check pins that.
const HARNESS_FILES = ['bin/abito-hook.cjs', 'bin/abito-recap-hook.cjs', 'bin/abito-statusline.cjs', 'package.json',
  'src/claude-ask.cjs', 'src/claude-suggestions.cjs', 'src/claude.cjs', 'src/client.cjs', 'src/codex.cjs', 'src/config.cjs', 'src/copilot.cjs', 'src/deadline.cjs', 'src/file-permission.cjs', 'src/hook-common.cjs', 'src/identity.cjs',
  'src/install-claude.cjs', 'src/install-codex.cjs', 'src/install-copilot.cjs', 'src/install-opencode.cjs', 'src/install-pi.cjs', 'src/install-pi-win.cjs', 'src/win-fs.cjs', 'src/install-recap.cjs', 'src/install-statusline.cjs', 'src/install-ui.cjs', 'src/installer-platform.cjs',
  'src/opencode.cjs', 'src/projection.cjs', 'src/recap-hook.cjs', 'src/redact.cjs', 'src/security.cjs', 'src/statusline.cjs', 'src/title-cache.cjs', 'src/windows-transport.cjs'];
// Host modules come from Pi; no npm payload or dependency installation.
const PI_FILES = ['pi-extension.ts', 'adapter.cjs', 'ask-tool.cjs', 'config.cjs', 'native-ask.cjs', 'questions.cjs', 'security.cjs', 'windows-transport.cjs'];
const STAGED = ['abito-island', 'abito-island-launcher', 'abito-island.png', `${IDENTIFIER}.desktop`,
  ...DAEMON_FILES.map(f => `desktop-daemon/${f}`), ...HARNESS_FILES.map(f => `desktop-harness/${f}`), ...PI_FILES.map(f => `desktop-pi/${f}`)];
const STAGED_DIRS = ['desktop-pi', 'desktop-daemon', 'desktop-daemon/src', 'desktop-harness', 'desktop-harness/bin', 'desktop-harness/src'];
// Enumerate the complete tree without following links, including empty directories.
function stageEntries(dir, problems, prefix = '') {
  const files = [], dirs = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = prefix + name;
    const stat = fs.lstatSync(path.join(dir, name));
    if (stat.isSymbolicLink()) { problems.push(`${rel} is a symlink`); continue; }
    if (stat.mode & 0o022) problems.push(`${rel} is group/world writable`);
    if (stat.isDirectory()) {
      dirs.push(rel);
      const nested = stageEntries(path.join(dir, name), problems, rel + '/');
      files.push(...nested.files); dirs.push(...nested.dirs);
    } else if (stat.isFile()) files.push(rel);
    else problems.push(`${rel} is not a regular file or directory`);
  }
  return { files: files.sort(), dirs: dirs.sort() };
}
function checkInstalledLayout(dir) {
  const problems = [];
  // Do not write through a symlink anywhere in the destination's ancestor chain.
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    if (fs.existsSync(p) || (() => { try { fs.lstatSync(p); return true; } catch { return false; } })()) {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) problems.push(`${p} is a symlink`);
      else if (!stat.isDirectory()) problems.push(`${p} is not a directory`);
    }
    if (path.dirname(p) === p) break;
  }
  if (problems.length || !fs.existsSync(dir)) return problems;
  const audit = path.join(dir, USER_AUDIT_DIR);
  let keepAudit = false;
  try { keepAudit = isUserAuditDir(audit); } catch { keepAudit = false; }
  const entries = stageEntries(dir, problems);
  const ours = file => keepAudit && (file === USER_AUDIT_DIR || file.startsWith(USER_AUDIT_DIR + '/'));
  for (const file of entries.files) if (![...STAGED, 'receipt.json'].includes(file) && !ours(file)) problems.push(`unexpected installed file: ${file}`);
  for (const sub of entries.dirs) if (!STAGED_DIRS.includes(sub) && !ours(sub)) problems.push(`unexpected installed directory: ${sub}`);
  return problems;
}
// Abito 0.1.2 wrote its hook-install audit log into the install prefix (`<prefix>/audit/*.jsonl`). An upgrade keeps those
// records instead of refusing to install: tolerated ONLY as a private folder (0700, ours, not a link) of private regular
// files (0600, ours, single link, no subfolders). Anything else there is still an unsafe layout.
const USER_AUDIT_DIR = 'audit';
function isUserAuditDir(dir) {
  const me = process.getuid ? process.getuid() : null;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (me !== null && st.uid !== me)) return false;
  for (const name of fs.readdirSync(dir)) {
    const f = fs.lstatSync(path.join(dir, name));
    if (!f.isFile() || f.isSymbolicLink() || f.nlink !== 1 || (f.mode & 0o077) || (me !== null && f.uid !== me)) return false;
  }
  return true;
}
function verifyStage(dir, { sourceCrate } = {}) {
  const problems = [];
  const receiptPath = path.join(dir, 'receipt.json');
  if (!fs.existsSync(receiptPath)) return ['receipt.json missing'];
  if (fs.lstatSync(receiptPath).isSymbolicLink()) return ['receipt.json is a symlink'];
  let receipt;
  try { receipt = readJson(receiptPath); } catch (e) { return [e.message]; }
  if (receipt.identifier !== IDENTIFIER) problems.push('receipt identifier mismatch');
  if (!String(receipt.r6_sha256 || '').startsWith(R6_PREFIX)) problems.push('receipt R6 pin mismatch');
  const prov = receipt.provenance || {};
  if (!/^[0-9a-f]{40}$/.test(prov.head || '')) problems.push('receipt has no git HEAD');
  if (prov.clean !== true) problems.push('receipt does not attest a clean tree');
  const entries = stageEntries(dir, problems);
  if (JSON.stringify(entries.files.filter(f => f !== 'receipt.json')) !== JSON.stringify([...STAGED].sort()) ||
      JSON.stringify(entries.dirs) !== JSON.stringify([...STAGED_DIRS].sort())) problems.push(`unexpected stage entries: ${entries.files}; directories: ${entries.dirs}`);
  if (JSON.stringify(Object.keys(receipt.files || {}).sort()) !== JSON.stringify([...STAGED].sort())) problems.push('receipt lists a different set of files');
  if (problems.some(p => /symlink/.test(p))) return problems; // never read through a linked ancestor
  for (const name of STAGED) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { problems.push(`${name} missing`); continue; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) problems.push(`${name} is not a regular file`);
    if (stat.mode & 0o022) problems.push(`${name} is group/world writable`);
    if (sha256File(file) !== (receipt.files || {})[name]) problems.push(`${name} hash differs from the receipt`);
  }
  if (fs.existsSync(path.join(dir, 'abito-island-launcher')) && fs.readFileSync(path.join(dir, 'abito-island-launcher'), 'utf8') !== launcherText()) problems.push('launcher differs from the closed template');
  const desk = path.join(dir, `${IDENTIFIER}.desktop`);
  if (fs.existsSync(desk) && fs.readFileSync(desk, 'utf8') !== desktopText()) problems.push('desktop entry differs from the closed template');
  const bin = path.join(dir, 'abito-island');
  if (fs.existsSync(bin)) {
    const bytes = fs.readFileSync(bin);
    if (sourceCrate && bytes.includes(Buffer.from(sourceCrate))) problems.push('binary embeds the source-tree path');
    for (const marker of ['--remote-debugging', 'devtools://', 'Prueba M3: propuesta servida por el backend falso', 'ABITO_PROBE', 'XTEST', 'abito-validator-fake-terminal-launcher']) if (bytes.includes(Buffer.from(marker))) problems.push(`binary contains «${marker}» (devtools/probe/fake)`);
    for (const prefix of [process.env.HOME && `${process.env.HOME}/.cargo`, process.env.HOME && `${process.env.HOME}/Apps`].filter(Boolean)) if (bytes.includes(Buffer.from(prefix))) problems.push(`binary embeds the build machine path ${prefix}…`);
    if (!(fs.statSync(bin).mode & 0o100)) problems.push('binary is not executable');
  }
  return problems;
}

// ---- provenance ------------------------------------------------------------
const cp = require('node:child_process');
function git(crate, args) {
  const r = cp.spawnSync('git', args, { cwd: crate, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
/** The build must come from committed bytes: any tracked change OR untracked
 *  (non-ignored) file under the crate fails the gate. */
function provenance(crate) {
  const dirty = git(crate, ['status', '--porcelain', '--untracked-files=all', '--', '.']).split('\n').filter(Boolean);
  return { head: git(crate, ['rev-parse', 'HEAD']).trim(), clean: dirty.length === 0, dirty };
}
function requireClean(crate) {
  const p = provenance(crate);
  if (!p.clean) throw new Error(`working tree is not clean under the product paths (${p.dirty.length} entries); build from a clean checkout:\n  ${p.dirty.slice(0, 8).join('\n  ')}`);
  return p;
}

module.exports = { provenance, requireClean, FORBIDDEN_ENV_PATTERN, ALLOWED_ABITO, R6_PREFIX, IDENTIFIER, FRONTEND_FILES, EXPECTED_PERMISSIONS, DAEMON_FILES, HARNESS_FILES, PI_FILES, STAGED, STAGED_DIRS, checkInstalledLayout, sha256, sha256File,
  checkR6, checkFrontend, checkConfig, launcherText, desktopText, verifyStage };
