#!/usr/bin/env node
'use strict';
// Isolated smoke-feature validator, never an installed app/launcher. Nothing is
// installed. The packaging build's clean-tree and shipped-binary gates are NOT
// relaxed: candidate validation records HEAD + dirty entries separately.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { buildReport, exitCode, spanishSummary } = require('./validate/report.cjs');
const { readSnapshot, annotateFailure } = require('./validate/load.cjs');
const L = require('./lib.cjs');
const { extraScenes, classify } = require('./validate/scenes.cjs');
const { producerFailures } = require('./validate/producer.cjs');
const { drained } = require('./validate/drain.cjs');
const crate = path.resolve(__dirname, '..');
const sceneNames = ['isla-compacta', 'isla-siempre-encima', 'isla-expandir', 'isla-colapsar', 'isla-minimizar', 'isla-atajo-sobre-rival', ...extraScenes];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms, description) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await pause(50); }
  throw new Error(`tiempo agotado: ${description}`);
}
// Fingerprint all compiled inputs. A same-HEAD stale executable is not reusable
// when an uncommitted Rust/frontend edit has changed the candidate.
function inputs() {
  const hash = crypto.createHash('sha256');
  function visit(file) {
    const st = fs.statSync(file);
    if (st.isDirectory()) for (const entry of fs.readdirSync(file).sort()) visit(path.join(file, entry));
    else hash.update(path.relative(crate, file)).update(fs.readFileSync(file));
  }
  for (const name of ['src', 'frontend', 'packaging/validate', 'packaging/validate.cjs', 'packaging/preview.cjs', 'capabilities', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json']) visit(path.join(crate, name));
  for (const [dir, files] of [['desktop-daemon', L.DAEMON_FILES], ['desktop-harness', L.HARNESS_FILES], ['desktop-pi', L.PI_FILES]]) for (const file of files) visit(path.join(crate, '..', dir, file));
  return hash.digest('hex');
}
async function main(args = process.argv.slice(2)) {
  if (args.some(a => !['--skip-build', '--fail-producer'].includes(a))) throw new Error('uso: node packaging/validate.cjs [--skip-build] [--fail-producer]');
  process.umask(0o077);
  const started = Date.now();
  // The machine's load when the gate starts, and again when each scene fails (see validate/load.cjs): a timeout on a busy machine says
  // «posible carga». Reporting only: no verdict, exit code or timeout changes.
  const startLoad = readSnapshot(), loadAtFailure = new Map();
  const out = fs.mkdtempSync('/tmp/abito-validate-');
  const children = [];
  let piRuntime, github, integrationFake;
  let interrupted = false;
  // Each direct child owns a fresh process group, so a timed-out app cannot
  // leave its ffmpeg (or any activated helper) attached to the private display.
  function stopGroup(child, signal) {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const signal = () => { interrupted = true; for (const child of children) stopGroup(child, 'SIGTERM'); };
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  const rows = [], visuals = new Map();
  let provenance, failure;
  function launch(command, argv, env, log) {
    const fd = fs.openSync(path.join(out, log), 'a', 0o600);
    let child;
    try { child = cp.spawn(command, argv, { cwd: crate, env, detached: true, stdio: ['ignore', 'pipe', fd] }); }
    finally { fs.closeSync(fd); }
    children.push(child);
    child.on('error', error => { child.launchError = error; });
    return child;
  }
  function exited(child) { return child.exitCode !== null || child.signalCode !== null || child.launchError; }
  const checked = (command, argv, options = {}) => {
    const r = cp.spawnSync(command, argv, { cwd: crate, encoding: 'utf8', ...options });
    if (r.error || r.status !== 0) throw new Error(`${command}: ${r.error?.message || r.stderr || `salida ${r.status}`}`);
    return r.stdout?.trim() || '';
  };
  try {
    provenance = L.provenance(crate);
    L.checkConfig(crate); L.checkR6(crate); L.checkFrontend(crate);
    const target = path.join(crate, 'target-smoke');
    const binary = path.join(target, 'release', 'abito-island');
    const manifestPath = path.join(target, 'validate-build.json');
    const fingerprint = inputs();
    if (!args.includes('--skip-build')) {
      // Exactly the feature combination of build.cjs --smoke-variant, deliberately
      // NOT its staged/shipped binary. Keep offline, never mutate dependencies.
      checked('cargo', ['build', '--release', '--locked', '--offline', '--features', 'tauri/custom-protocol,probe', '--target-dir', target], { stdio: 'inherit', timeout: 1800000 });
      if (inputs() !== fingerprint) throw new Error('fuentes cambiaron durante la compilación');
      fs.writeFileSync(manifestPath, JSON.stringify({ head: provenance.head, inputs: fingerprint, sha256: L.sha256File(binary), features: 'tauri/custom-protocol,probe' }));
    }
    const built = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (built.head !== provenance.head || built.inputs !== fingerprint || built.sha256 !== L.sha256File(binary) || built.features !== 'tauri/custom-protocol,probe') throw new Error('smoke-variant obsoleto: ejecute sin --skip-build');
    // Fresh allowlisted environment: no host credentials/config/session bus,
    // PulseAudio, Wayland socket or user-supplied ABITO overrides are inherited.
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', GDK_BACKEND: 'x11', NO_AT_BRIDGE: '1', LIBGL_ALWAYS_SOFTWARE: '1' };
    for (const [key, sub] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', XDG_RUNTIME_DIR: 'runtime', ABITO_SOCKET_DIR: 'sockets' })) {
      env[key] = path.join(out, sub); fs.mkdirSync(env[key], { mode: 0o700 });
    }
    // Exercise a real read-only Claude installer preview, not just the missing-tool path.
    // No user configuration or installed hooks are copied into this private HOME.
    fs.mkdirSync(path.join(env.HOME, '.claude'), {mode:0o700});
    const piParent = '/run/user/1000/abito-validator-pi';
    fs.mkdirSync(piParent, { mode: 0o700, recursive: true });
    const parentStat = fs.lstatSync(piParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid() || (parentStat.mode & 0o777) !== 0o700) throw new Error('runtime Pi padre inseguro');
    piRuntime = fs.mkdtempSync(path.join(piParent, 'run-'));
    env.ABITO_SOCKET_DIR = piRuntime;
    env.ABITO_MODELS_CONFIG_DIR = env.XDG_CONFIG_HOME;
    // Replace only the private validator's Pi executable with a deterministic
    // RPC fixture. Never start a real provider or change installed hooks.
    const fixturePi = path.join(out, 'pi');
    fs.copyFileSync(path.join(__dirname, 'validate/internal-pi.cjs'), fixturePi);
    fs.chmodSync(fixturePi, 0o700);
    env.PATH = `${out}:${env.PATH}`;
    // The app still calls its production clipboard helper; this owner serves
    // the selection on this private Xvfb, never the user's Wayland session.
    const clipboard = path.join(out, 'wl-copy');
    fs.copyFileSync(path.join(__dirname, 'validate/clipboard.py'), clipboard);
    fs.chmodSync(clipboard, 0o700);
    const secondProject = path.join(out, 'proyecto-beta');
    fs.mkdirSync(secondProject, { mode: 0o700 });
    const fixtureCodex = path.join(out, 'codex');
    fs.copyFileSync(fixturePi, fixtureCodex); fs.chmodSync(fixtureCodex, 0o700);
    launch('node', [fixtureCodex, '--discovery-project', secondProject], env, 'discovery-project.log');
    env.ABITO_PROJECT_ROOT = path.resolve(crate, '../..');
    // The island lists live agent sessions from /proc. A validation run must see only ITS OWN fixtures (children of
    // this process), never the human's real Pi/Claude/Codex sessions: they fill the four pill slots and hide the
    // integration pill the GitHub scenes wait for.
    env.ABITO_SESSIONS_SCOPE_PID = String(process.pid);
    // Xvfb atomically chooses a free display; never guess, and never touch :0.
    const xvfb = launch('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-noreset'], env, 'xvfb.log');
    let display = '';
    xvfb.stdout.on('data', data => { display += data; });
    await until(() => { if (exited(xvfb)) throw new Error('Xvfb terminó'); return /^\d+\s*$/.test(display); }, 10000, 'Xvfb');
    if (Number(display.trim()) === 0) throw new Error('Xvfb eligió :0; se rechaza');
    env.DISPLAY = `:${display.trim()}`;
    const dbus = launch('dbus-daemon', ['--session', '--nofork', '--print-address=1'], env, 'dbus.log');
    let address = '';
    dbus.stdout.on('data', data => { address += data; });
    await until(() => { if (exited(dbus)) throw new Error('D-Bus terminó'); return address.includes('\n'); }, 10000, 'D-Bus');
    env.DBUS_SESSION_BUS_ADDRESS = address.trim();
    const wm = launch('openbox', ['--sm-disable'], env, 'openbox.log');
    await until(() => {
      if (exited(wm)) throw new Error('openbox terminó');
      const r = cp.spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env, encoding: 'utf8', timeout: 1000 });
      return r.status === 0 && /window id # 0x[1-9a-f]/i.test(r.stdout);
    }, 10000, 'gestor de ventanas');
    Object.assign(env, { ABITO_PROBE: '1', ABITO_PROBE_VALIDATE: 'island', ABITO_PROBE_VISUAL: '1', ABITO_PROBE_VISUAL_DIR: out, ABITO_BRIDGE_BASE: 'http://127.0.0.1:1' });
    if (args.includes('--fail-producer')) env.ABITO_PROBE_VALIDATE_PRODUCER_FAILURE = '1';
    // Recreate the packaged sibling layout in the private output directory.
    // The release binary's normal host startup resolves desktop-daemon beside
    // current_exe; never let it see an installed daemon or the user's HOME.
    const candidate = path.join(out, 'abito-island');
    fs.copyFileSync(binary, candidate); fs.chmodSync(candidate, 0o700);
    for (const [dir, files] of [['desktop-daemon', L.DAEMON_FILES], ['desktop-harness', L.HARNESS_FILES], ['desktop-pi', L.PI_FILES]]) {
      for (const file of files) {
        const dest = path.join(out, dir, file);
        require('./validate/layout.cjs').copyRuntimeFile(path.join(crate, '..', dir, file), dest);
      }
    }
    // Original 1px PNG fixture, private output only, no external artwork request.
    const zlib = require('node:zlib');
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
      for (const b of body) { crc ^= b; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
      const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
      return Buffer.concat([head,body,tail]);
    };
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
    fs.writeFileSync(path.join(out,'spotify-cover.png'),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.from([0,29,185,84]))),chunk('IEND',Buffer.alloc(0))]));
    integrationFake = await require('./validate/integrations.cjs').start(out, env);
    github = await require('./validate/github.cjs').start(out, env);
    const app = launch(candidate, ['--probe'], env, 'app.stderr.log');
    const jsonl = fs.openSync(path.join(out, 'probe.jsonl'), 'a', 0o600);
    let buffer = '';
    const consume = line => {
      fs.writeSync(jsonl, line + '\n');
      try {
        const row = JSON.parse(line);
        if (row.step === 'validation_input') {
          const key = row.kind === 'key' && ['Down', 'Up', 'Right', 'Home', 'Return', 'Escape', 'BackSpace', 'Ctrl+F8', 'Ctrl+Alt+A', 'Ctrl+Alt+space', 'Ctrl+Alt+s', 'Ctrl+Alt+t', 'Ctrl+Alt+Shift+a'].includes(row.key);
          const click = ['click', 'move'].includes(row.kind) && Number.isInteger(row.x) && Number.isInteger(row.y) && row.x >= 0 && row.y >= 0 && row.x < 1280 && row.y < 900;
          if (!key && !click) { failure = 'entrada inválida'; return; }
          const argv = key ? ['key', row.key] : [String(row.x), String(row.y), ...(row.kind === 'move' ? ['move'] : [])];
          const r = cp.spawnSync('python3', [path.join(__dirname, 'validate', 'input.py'), ...argv], { env, encoding: 'utf8', timeout: 3000 });
          if (r.status !== 0) failure = `XTest: ${r.stderr || r.error?.message}`;
        }
        if (row.step === 'validation_producer_error') rows.push(...producerFailures(row.reason, rows));
        if (row.step === 'visual') visuals.set(row.name, row);
        if (row.step === 'validation_scene') rows.push(row);
        if (row.step === 'validation_observation') {
          if (row.name === 'integracion-github' && github.requests.length === 0) row.observation = {ok:false,reason:'gh no llegó al HTTP falso'};
          const classified = { name: row.name, ...classify(row.observation) };
          if (classified.verdict === 'fail') loadAtFailure.set(row.name, readSnapshot());
          rows.push(classified);
        }
      } catch { /* native diagnostics may be non-JSON */ }
    };
    const onData = data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    };
    app.stdout.on('data', onData);
    try {
      await until(() => {
        if (interrupted) throw new Error('interrumpido');
        if (app.launchError) throw app.launchError;
        return exited(app);
      }, 420000, 'escenas T1–T5 (420 s)');
      if (app.exitCode !== 0) throw new Error(`Abito terminó con ${app.exitCode ?? app.signalCode}`);
      // exit may precede the final pipe data; close means all evidence is drained.
      await drained(app);
      // Reopen the same private persisted configuration, not a simulated startup handler.
      for (const mode of ['manual', 'login']) {
        const args = mode === 'login' ? ['--probe', '--autostart'] : ['--probe'];
        const startup = launch(candidate, args, {...env, ABITO_PROBE_VALIDATE:`startup-${mode}`}, `startup-${mode}.stderr.log`);
        startup.stdout.on('data', onData);
        try {
          await until(() => {if(startup.launchError) throw startup.launchError; return exited(startup);}, 30000, `arranque ${mode}`);
          if(startup.exitCode !== 0) throw new Error(`arranque ${mode}: ${startup.exitCode}`);
          await drained(startup);
        } finally {startup.stdout.off('data',onData);startup.stdout.resume(); stopGroup(startup, 'SIGTERM');}
      }
    } finally {
      // On timeout the app can still emit while teardown is in progress.
      // Detach before closing the log, otherwise EBADF could abort cleanup.
      app.stdout.off('data', onData); app.stdout.resume();
      fs.closeSync(jsonl);
    }
  } catch (error) { failure = error.message; }
  finally {
    for (const child of [...children].reverse()) {
      stopGroup(child, 'SIGTERM');
      const end = Date.now() + 2000;
      while (!exited(child) && Date.now() < end) await pause(25);
      stopGroup(child, 'SIGKILL');
      if (!exited(child)) await until(() => exited(child), 3000, 'terminar proceso propio').catch(() => {});
    }
    if (github) await github.close();
    if (integrationFake) await integrationFake.close();
    if (piRuntime) fs.rmSync(piRuntime, { recursive: true, force: true });
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
  }
  const built = sceneNames.map(name => {
    const matches = rows.filter(row => row.name === name);
    const row = matches[0];
    const visual = visuals.get(name);
    if (matches.length !== 1) return { name, verdict: 'fail', reason: failure || `${matches.length} veredictos recibidos` };
    if (!visual?.ok || !visual.path || !fs.existsSync(visual.path) || fs.statSync(visual.path).size === 0) return { ...row, verdict: 'fail', reason: [row.reason, visual?.error || 'falta captura PNG'].filter(Boolean).join('; ') };
    return { ...row, png: visual.path };
  });
  if (failure && built.every(s => s.verdict !== 'fail')) built.push({ name: 'harness', verdict: 'fail', reason: failure });
  const endLoad = readSnapshot();
  const scenes = built.map(scene => annotateFailure(scene, loadAtFailure.get(scene.name) || endLoad));
  const report = buildReport(scenes, { ...provenance, load: startLoad, durationMs: Date.now() - started, outputDir: out, scope: 'T1–T5 S1 S3 S4 S5; T6 S2 mediante packaging/preview.cjs', input: 'shared shortcut/action handlers + validator-owned XTest header click' });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(spanishSummary(report)); console.log(`Informe: ${out}/report.json`);
  return exitCode(report);
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, sceneNames, inputs };
