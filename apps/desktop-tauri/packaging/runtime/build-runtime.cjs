#!/usr/bin/env node
'use strict';
/* K2-02 T1 (S1, S2): build the runtime folder Koda ships inside every installer: its own pinned Node and its own pinned Pi,
   so Koda never needs (nor touches) a Node or a Pi installed on the machine.

   Usage: node packaging/runtime/build-runtime.cjs --target <linux-x64|darwin-arm64|win-x64> --out <dir>
            [--node-archive <file>] [--ffmpeg-archive <file>] [--cache <dir>] [--self-check] [--archive <file.tar.gz>]

   Inputs, all pinned in this directory:
   - node.sha256: one official Node archive per target with its sha256 (the lines of the release's signed SHASUMS256.txt).
     The archive comes from --node-archive (offline) or from https://nodejs.org/dist/; a sha256 mismatch fails closed.
   - package.json + package-lock.json: Pi, pinned exactly; npm ci installs every package against its lockfile sha512.
   - ffmpeg.sha256 (K2-13 S9): one BtbN/FFmpeg-Builds LGPL archive for linux-x64 and for win-x64 (none for darwin-arm64:
     no LGPL macOS build exists yet), from --ffmpeg-archive (offline) or its GitHub release; a sha256 mismatch fails
     closed. Only bin/ffmpeg[.exe] and LICENSE.txt leave the archive (no ffprobe, ffplay, docs). The build refuses a
     binary whose embedded configure string has --enable-gpl or --enable-nonfree (or has no configure string at all)
     and a LICENSE.txt that is not the LGPL text.

   Output (<out>, created only when every step succeeds; a failed build leaves <out> untouched):
     node | node.exe       the pinned Node binary only: no npm, npx or corepack
     LICENSE.node          Node's licence (MIT plus its bundled components)
     THIRD-PARTY-NOTICES.md  Node and every shipped package with its licence (texts from licenses/ for packages
                           that ship no licence file; a licence with no text there fails the build)
     node_modules/...      Pi and its dependencies, install scripts not run, no .bin symlinks, no symlink at all
     pi                    (Linux, macOS) launcher that runs Pi with THIS Node; Windows needs none: the daemon starts
                           node.exe with Pi's own CLI JS resolved next to it (desktop-daemon runtime.cjs)
     ffmpeg | ffmpeg.exe   (linux-x64, win-x64) the pinned LGPL ffmpeg the daemon spawns for Minikoda transcriptions
     LICENSE.ffmpeg.txt    its LGPL v3 text (from the archive); THIRD-PARTY-NOTICES.md says where its source is
     koda-runtime.json     {target, node, pi, piCli, ffmpeg?}
   --archive also packs <out> into ONE tar.gz (members relative to the runtime folder's root, no links) and prints its
   sha256: the single file the Linux and Windows installers ship and verify before extracting. macOS ships the folder.
   --self-check runs the built Pi (`pi --version`) with an empty private HOME, offline; only when the target is this OS. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const HERE = __dirname;
const PI = '@earendil-works/pi-coding-agent';
const TARGETS = {
  'linux-x64': { platform: 'linux', arch: 'x64', ext: '.tar.gz', exe: 'node' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', ext: '.tar.gz', exe: 'node' },
  'win-x64': { platform: 'win32', arch: 'x64', ext: '.zip', exe: 'node.exe' },
};

/* K2-13 (S9): the BtbN asset flavour per target; darwin-arm64 ships no ffmpeg (pending for the Mac session). */
const FFMPEG_TARGETS = { 'linux-x64': { flavour: 'linux64', ext: '.tar.xz', exe: 'ffmpeg' }, 'win-x64': { flavour: 'win64', ext: '.zip', exe: 'ffmpeg.exe' } };
const FFMPEG_RELEASES = 'https://github.com/BtbN/FFmpeg-Builds/releases/download';

class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

function parseArgs(argv) {
  const opts = { selfCheck: false };
  const takes = { '--target': 'target', '--out': 'out', '--node-archive': 'nodeArchive', '--ffmpeg-archive': 'ffmpegArchive', '--cache': 'cache', '--archive': 'archive' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-check') { opts.selfCheck = true; continue; }
    if (!takes[a] || i + 1 >= argv.length) throw new Fail(`usage: build-runtime.cjs --target <${Object.keys(TARGETS).join('|')}> --out <dir> [--node-archive <file>] [--ffmpeg-archive <file>] [--cache <dir>] [--self-check] [--archive <file.tar.gz>] (bad argument: ${a})`, 2);
    opts[takes[a]] = argv[(i += 1)];
  }
  if (!opts.target || !opts.out) throw new Fail('usage: build-runtime.cjs --target <target> --out <dir> (both are required)', 2);
  if (!TARGETS[opts.target]) throw new Fail(`unknown target ${opts.target}; known: ${Object.keys(TARGETS).join(', ')}`, 2);
  if (opts.ffmpegArchive && !FFMPEG_TARGETS[opts.target]) throw new Fail(`--ffmpeg-archive: ${opts.target} ships no ffmpeg (no LGPL build for it yet)`, 2);
  return opts;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Fail(`cannot read JSON ${file}: ${e.message}`); }
}

function nodePin(target) {
  const t = TARGETS[target];
  const suffix = `-${target}${t.ext}`;
  const lines = fs.readFileSync(path.join(HERE, 'node.sha256'), 'utf8').trim().split(/\r?\n/);
  const pins = lines.map((l) => l.trim().split(/\s+/)).filter(([, name]) => name && name.endsWith(suffix));
  if (pins.length !== 1) throw new Fail(`node.sha256 must pin exactly one archive for ${target}, found ${pins.length}`);
  const [sha, name] = pins[0];
  const m = /^node-v(\d+\.\d+\.\d+)-/.exec(name);
  if (!/^[0-9a-f]{64}$/.test(sha) || !m) throw new Fail(`malformed node.sha256 line for ${target}`);
  return { sha, name, version: m[1], dir: name.slice(0, -t.ext.length) };
}

/* The ffmpeg pin for a target, or null (darwin-arm64). Exactly one BtbN LGPL asset per shipped target. */
function ffmpegPin(target) {
  const f = FFMPEG_TARGETS[target];
  if (!f) return null;
  const lines = fs.readFileSync(path.join(HERE, 'ffmpeg.sha256'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const shape = new RegExp(`^(autobuild-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2})/(ffmpeg-(n\\d+(?:\\.\\d+)*-\\d+-g[0-9a-f]+)-${f.flavour}-lgpl-\\d+(?:\\.\\d+)*)${f.ext.replace(/\./g, '\\.')}$`);
  const pins = lines.map((l) => l.split(/\s+/)).map(([sha, rel]) => ({ sha, m: shape.exec(rel || '') })).filter((p) => p.m && /^[0-9a-f]{64}$/.test(p.sha));
  const flavoured = lines.filter((l) => l.includes(`-${f.flavour}-`));
  if (pins.length !== 1 || flavoured.length !== 1) throw new Fail(`ffmpeg.sha256 must pin exactly one BtbN LGPL archive for ${target} (<sha256>  autobuild-<date>/ffmpeg-<rev>-${f.flavour}-lgpl-<ver>${f.ext})`);
  const { sha, m } = pins[0];
  return { sha, tag: m[1], dir: m[2], name: `${m[2]}${f.ext}`, version: m[3], exe: f.exe, ext: f.ext };
}

async function ffmpegArchive(pin, opts, cache) {
  let file = opts.ffmpegArchive ? path.resolve(opts.ffmpegArchive) : path.join(cache, pin.name);
  if (!opts.ffmpegArchive && !fs.existsSync(file)) {
    const partial = `${file}.partial-${process.pid}`;
    await download(`${FFMPEG_RELEASES}/${pin.tag}/${pin.name}`, partial);
    fs.renameSync(partial, file);
  }
  if (!fs.existsSync(file)) throw new Fail(`ffmpeg archive not found: ${file}`);
  if (path.basename(file) !== pin.name) throw new Fail(`ffmpeg archive must be ${pin.name}, got ${path.basename(file)}`);
  const got = sha256File(file);
  if (got !== pin.sha) {
    if (!opts.ffmpegArchive) fs.rmSync(file, { force: true });
    throw new Fail(`ffmpeg archive SHA256 mismatch for ${pin.name}: expected ${pin.sha}, got ${got}`);
  }
  return file;
}

/* Only bin/ffmpeg[.exe] and LICENSE.txt leave the archive; then the LGPL proof: the binary's embedded configure string
   (FFmpeg compiles it in; `ffmpeg -version` prints it) must exist and carry neither --enable-gpl nor --enable-nonfree,
   and the licence must be the LGPL. Byte checks, so a cross-target build proves it without running the binary. */
function extractFfmpeg(archive, pin, dest) {
  const scratch = fs.mkdtempSync(path.join(path.dirname(dest), '.ffmpeg-extract-'));
  try {
    const members = [`${pin.dir}/bin/${pin.exe}`, `${pin.dir}/LICENSE.txt`];
    if (process.platform === 'win32') {
      run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', scratch, ...members], {}, 'tar (ffmpeg)');
    } else if (pin.ext === '.zip') {
      run('unzip', ['-q', archive, ...members, '-d', scratch], {}, 'unzip (ffmpeg)');
    } else {
      run('tar', ['-xf', archive, '-C', scratch, ...members], {}, 'tar (ffmpeg)'); // compression detected from the bytes
    }
    for (const m of members) {
      const st = fs.lstatSync(path.join(scratch, m), { throwIfNoEntry: false });
      if (!st || !st.isFile()) throw new Fail(`ffmpeg archive ${pin.name} lacks a regular file ${m}`);
    }
    const bin = fs.readFileSync(path.join(scratch, members[0]));
    if (!bin.includes(Buffer.from('--prefix='))) throw new Fail(`ffmpeg ${pin.name} carries no configure string: cannot prove it is an LGPL build`);
    for (const flag of ['--enable-gpl', '--enable-nonfree']) {
      if (bin.includes(Buffer.from(flag))) throw new Fail(`ffmpeg ${pin.name} was configured with ${flag}: only LGPL builds ship`);
    }
    const licence = fs.readFileSync(path.join(scratch, members[1]), 'utf8');
    if (licence.trimStart().split(/\r?\n/)[0].trim() !== 'GNU LESSER GENERAL PUBLIC LICENSE') throw new Fail(`ffmpeg archive ${pin.name}: LICENSE.txt is not the GNU LESSER GENERAL PUBLIC LICENSE`);
    fs.copyFileSync(path.join(scratch, members[0]), path.join(dest, pin.exe));
    fs.chmodSync(path.join(dest, pin.exe), 0o755);
    fs.copyFileSync(path.join(scratch, members[1]), path.join(dest, 'LICENSE.ffmpeg.txt'));
    fs.chmodSync(path.join(dest, 'LICENSE.ffmpeg.txt'), 0o644);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* The FFmpeg section of the runtime notices: the licence, the exact binary it came from and where its source is. */
function ffmpegNotice(pin) {
  const rev = /-g([0-9a-f]+)$/.exec(pin.version)[1];
  return [`## FFmpeg ${pin.version} (\`${pin.exe}\`)`, '',
    'License: LGPL-3.0-or-later. Full text: `LICENSE.ffmpeg.txt` in this folder.',
    `The \`${pin.exe}\` in this folder is FFmpeg (https://ffmpeg.org), built by BtbN/FFmpeg-Builds as an LGPL build:`,
    'configured with --enable-version3 and built without --enable-gpl and without --enable-nonfree. Koda runs it as a separate',
    'program, unmodified, only to extract and split the audio of videos for transcription.',
    `- Binary: ${FFMPEG_RELEASES}/${pin.tag}/${pin.name} (sha256 ${pin.sha})`,
    `- Corresponding Source: the FFmpeg source at revision ${rev}, https://github.com/FFmpeg/FFmpeg/tree/${rev}`,
    `  (${pin.version}), and the scripts that built it, https://github.com/BtbN/FFmpeg-Builds (release ${pin.tag}),`,
    '  which also list the libraries linked into it and their licences.',
    '- Source offer: on request Koda provides the Corresponding Source of this exact binary — the FFmpeg source at the',
    '  revision above plus the BtbN/FFmpeg-Builds scripts and the exact library versions linked into it — for at least',
    '  three years after the release that shipped it, for no more than the cost of making and sending the copy. Ask',
    '  through the issue tracker of the repository Koda is published from.',
    '- Before a public release Koda must MIRROR that Corresponding Source itself (LGPL-3.0 section 6: recipients have to',
    '  be able to obtain it from a network server, not only to ask us). That mirror does not exist yet, and the licence',
    '  review of FFmpeg and its patent situation has NOT been done. This is an engineering record, not legal advice.',
    'You may replace this file with your own build of FFmpeg; Koda calls it by this path with command-line arguments only.', ''];
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Fail(`download failed: ${url} (HTTP ${res.status})`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function nodeArchive(pin, opts, cache) {
  let file = opts.nodeArchive ? path.resolve(opts.nodeArchive) : path.join(cache, pin.name);
  if (!opts.nodeArchive && !fs.existsSync(file)) {
    const partial = `${file}.partial-${process.pid}`;
    await download(`https://nodejs.org/dist/v${pin.version}/${pin.name}`, partial);
    fs.renameSync(partial, file);
  }
  if (!fs.existsSync(file)) throw new Fail(`Node archive not found: ${file}`);
  if (path.basename(file) !== pin.name) throw new Fail(`Node archive must be ${pin.name}, got ${path.basename(file)}`);
  const got = sha256File(file);
  if (got !== pin.sha) {
    if (!opts.nodeArchive) fs.rmSync(file, { force: true }); // never keep a bad download in the cache
    throw new Fail(`Node archive SHA256 mismatch for ${pin.name}: expected ${pin.sha}, got ${got}`);
  }
  return file;
}

function run(cmd, args, options = {}, label = `${path.basename(cmd)} ${args[0]}`) {
  const r = cp.spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : `exit ${r.status}\n${(r.stderr || '').trim().split(/\r?\n/).slice(-20).join('\n')}`;
    throw new Fail(`${label} failed: ${detail}`);
  }
  return r;
}

/* Only the Node binary and its licence leave the archive: npm, npx, corepack, headers and docs never do. */
function extractNode(archive, pin, target, dest) {
  const t = TARGETS[target];
  const scratch = fs.mkdtempSync(path.join(path.dirname(dest), '.node-extract-'));
  try {
    const members = t.ext === '.zip' ? [`${pin.dir}/${t.exe}`, `${pin.dir}/LICENSE`] : [`${pin.dir}/bin/${t.exe}`, `${pin.dir}/LICENSE`];
    if (process.platform === 'win32') {
      // System32 tar (bsdtar) reads both formats; a Git-for-Windows GNU tar earlier on PATH would read C: as a host name.
      run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', scratch, ...members]);
    } else if (t.ext === '.zip' && process.platform === 'linux') {
      run('unzip', ['-q', archive, ...members, '-d', scratch]); // GNU tar does not read zip
    } else {
      run('tar', ['-xf', archive, '-C', scratch, ...members]);
    }
    for (const m of members) {
      const st = fs.lstatSync(path.join(scratch, m), { throwIfNoEntry: false });
      if (!st || !st.isFile()) throw new Fail(`Node archive ${pin.name} lacks a regular file ${m}`);
    }
    fs.copyFileSync(path.join(scratch, members[0]), path.join(dest, t.exe));
    fs.chmodSync(path.join(dest, t.exe), 0o755);
    fs.copyFileSync(path.join(scratch, members[1]), path.join(dest, 'LICENSE.node'));
    fs.chmodSync(path.join(dest, 'LICENSE.node'), 0o644);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* npm is a BUILD tool here, never shipped. It runs as `node npm-cli.js` (no .cmd shim) from the Node running this script. */
function npmCli() {
  const exec = process.execPath;
  const candidates = [];
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
  candidates.push(path.join(path.dirname(exec), 'node_modules', 'npm', 'bin', 'npm-cli.js')); // Windows layout
  candidates.push(path.join(path.dirname(exec), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')); // Unix layout
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['npm', 'npm.cmd']) {
      const shim = path.join(dir, name);
      if (!fs.existsSync(shim)) continue;
      let real = shim;
      try { real = fs.realpathSync(shim); } catch { /* keep the shim path */ }
      if (/npm-cli\.js$/.test(real)) candidates.push(real); // distro layout: npm is a symlink to npm-cli.js
      candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Fail('npm (npm-cli.js) not found next to this Node or on PATH: the build needs npm, the runtime does not');
  return found;
}

function installPi(dest, cache) {
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(HERE, f), path.join(dest, f));
  // Private, empty npm configurations: no user or global .npmrc may redirect the registry or change what is installed.
  // Two files: npm refuses to load one file as both the user and the global config.
  const userrc = path.join(cache, 'user.npmrc');
  const globalrc = path.join(cache, 'global.npmrc');
  fs.writeFileSync(userrc, '');
  fs.writeFileSync(globalrc, '');
  const env = {
    ...process.env,
    npm_config_userconfig: userrc, npm_config_globalconfig: globalrc, npm_config_cache: path.join(cache, 'npm'),
    npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
  };
  run(process.execPath, [npmCli(), 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: dest, env }, 'npm ci');
  for (const f of ['package.json', 'package-lock.json']) fs.rmSync(path.join(dest, f));
  // npm-only bookkeeping and the .bin symlinks; Koda starts Pi through its own launcher (or the daemon on Windows).
  fs.rmSync(path.join(dest, 'node_modules', '.bin'), { recursive: true, force: true });
  fs.rmSync(path.join(dest, 'node_modules', '.package-lock.json'), { force: true });
  const pkgDir = path.join(dest, 'node_modules', ...PI.split('/'));
  const manifest = readJson(path.join(pkgDir, 'package.json'));
  const bin = manifest && manifest.bin && manifest.bin.pi;
  if (typeof bin !== 'string' || !bin || path.isAbsolute(bin)) throw new Fail(`${PI} declares no relative "pi" bin`);
  const cli = path.resolve(pkgDir, bin);
  const rel = path.relative(pkgDir, cli);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.lstatSync(cli, { throwIfNoEntry: false })?.isFile()) throw new Fail(`${PI} bin ${bin} is not a file inside the package`);
  return { version: manifest.version, cli: path.relative(dest, cli).split(path.sep).join('/') };
}

/* Every package under node_modules (nested ones too), sorted by name then version. */
function packagesIn(root) {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name.startsWith('@')) { walk(p); continue; }
      const manifest = path.join(p, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      found.push({ dir: p, manifest: readJson(manifest) });
      if (fs.existsSync(path.join(p, 'node_modules'))) walk(path.join(p, 'node_modules'));
    }
  };
  walk(root);
  return found.sort((a, b) => `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`));
}

function licenseId(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((l) => l && l.type).filter(Boolean).join(' OR ');
  return 'UNKNOWN';
}

const author = (manifest) => (typeof manifest.author === 'string' ? manifest.author : manifest.author && manifest.author.name) || 'not declared';
const repository = (manifest) => (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository && manifest.repository.url) || 'not declared';

/* THIRD-PARTY-NOTICES.md for the runtime folder: Node first, then every package with its declared licence and the
   path of the licence file it ships. A package that ships no licence file gets its author and repository from its
   package.json and the canonical text from licenses/<id>.txt, reproduced once; with no such text the build fails. */
function writeNotices(dest, nodeVersion, ffPin) {
  const lines = ['# Third-party notices: Koda\'s bundled runtime', '',
    'Koda ships its own Node.js and Pi in this folder (K2-02). Their licences and those of every package they include follow.', '',
    `## Node.js ${nodeVersion}`, '', 'License: MIT (with bundled components). Full text: `LICENSE.node` in this folder.', '',
    ...(ffPin ? ffmpegNotice(ffPin) : [])];
  const texts = new Map();
  for (const { dir, manifest } of packagesIn(path.join(dest, 'node_modules'))) {
    const id = licenseId(manifest);
    const file = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.|-|$)/i.test(n) && fs.lstatSync(path.join(dir, n)).isFile());
    lines.push(`## ${manifest.name} ${manifest.version}`, '', `License: ${id}`);
    if (file) {
      lines.push(`Licence file: \`${path.relative(dest, path.join(dir, file)).split(path.sep).join('/')}\``);
    } else {
      const canonical = path.join(HERE, 'licenses', `${id}.txt`);
      if (!/^[A-Za-z0-9.-]+$/.test(id) || !fs.existsSync(canonical)) {
        throw new Fail(`${manifest.name}@${manifest.version} is ${id}, ships no licence file, and packaging/runtime/licenses/ has no ${id} text: refusing to ship it without its licence`);
      }
      const text = fs.readFileSync(canonical, 'utf8');
      lines.push(`Author (from package.json): ${author(manifest)}`, `Repository: ${repository(manifest)}`);
      if (id === 'MIT') {
        // MIT keeps «the above copyright notice»: the SPDX template's placeholder line is filled with the holder this
        // package declares, so the text shipped for it is that package's own notice (RDD advisory 2).
        const holder = author(manifest);
        lines.push('The package ships no licence file; the MIT License text follows, with the copyright holder its package.json declares:', '',
          '```text', text.replace('Copyright (c) <year> <copyright holders>', `Copyright (c) ${holder}`).trimEnd(), '```');
      } else {
        texts.set(id, text);
        lines.push(`The package ships no licence file; the ${id} License text is reproduced under «License texts» below.`);
      }
    }
    lines.push('');
  }
  if (texts.size) {
    lines.push('## License texts', '');
    for (const [id, text] of [...texts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`### ${id}`, '', '```text', text.trimEnd(), '```', '');
  }
  fs.writeFileSync(path.join(dest, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'), { mode: 0o644 });
}

function noSymlinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Fail(`runtime contains a symlink: ${path.relative(dir, p)}`);
    if (e.isDirectory()) noSymlinks(p);
  }
}

function piLauncher(cli) {
  return [
    '#!/bin/sh',
    '# Koda\'s own Pi (K2-02): always run by the Node in this folder, never by a Node or a Pi from PATH.',
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1',
    `exec "$here/node" "$here/${cli}" "$@"`,
    '',
  ].join('\n');
}

function selfCheck(dest, target, piVersion) {
  const t = TARGETS[target];
  if (t.platform !== process.platform || t.arch !== process.arch) throw new Fail(`--self-check runs only on ${target}; this is ${process.platform}-${process.arch}`, 2);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'koda-runtime-home-'));
  try {
    const env = {
      PATH: t.platform === 'win32' ? (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '') : '/usr/bin:/bin',
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
      PI_CODING_AGENT_DIR: path.join(home, 'pi'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const r = t.platform === 'win32'
      ? run(path.join(dest, t.exe), [path.join(dest, readJson(path.join(dest, 'koda-runtime.json')).piCli), '--version'], { env, cwd: home })
      : run(path.join(dest, 'pi'), ['--version'], { env, cwd: home });
    const out = `${r.stdout}${r.stderr}`.trim();
    if (out !== piVersion) throw new Fail(`self-check: built Pi printed ${JSON.stringify(out)}, expected ${piVersion}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* System tar on every OS (Windows: System32 bsdtar, never a Git-for-Windows GNU tar). Members are `./...`: the runtime
   folder's root, so an installer extracts into an empty directory of its choice. */
function packArchive(dir, archive) {
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const partial = `${archive}.partial-${process.pid}`;
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const owner = process.platform === 'linux' ? ['--owner=0', '--group=0', '--numeric-owner', '--sort=name'] : [];
  try {
    run(tar, ['-czf', partial, ...owner, '-C', dir, '.'], {}, 'tar (pack runtime)');
    fs.renameSync(partial, archive);
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return { sha: sha256File(archive), bytes: fs.statSync(archive).size };
}

function sizeOf(dir) {
  let bytes = 0; let files = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = sizeOf(p); bytes += s.bytes; files += s.files; } else { bytes += fs.statSync(p).size; files += 1; }
  }
  return { bytes, files };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t = TARGETS[opts.target];
  const out = path.resolve(opts.out);
  const pin = nodePin(opts.target);
  const ffPin = ffmpegPin(opts.target);
  const tmpCache = !opts.cache;
  const cache = opts.cache ? path.resolve(opts.cache) : fs.mkdtempSync(path.join(os.tmpdir(), 'koda-runtime-cache-'));
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const partial = `${out}.partial-${process.pid}`;
  fs.rmSync(partial, { recursive: true, force: true });
  try {
    const archive = await nodeArchive(pin, opts, cache);
    fs.mkdirSync(partial, { mode: 0o755 });
    extractNode(archive, pin, opts.target, partial);
    if (ffPin) extractFfmpeg(await ffmpegArchive(ffPin, opts, cache), ffPin, partial);
    const pi = installPi(partial, cache);
    writeNotices(partial, pin.version, ffPin);
    if (t.platform !== 'win32') fs.writeFileSync(path.join(partial, 'pi'), piLauncher(pi.cli), { mode: 0o755 });
    fs.writeFileSync(path.join(partial, 'koda-runtime.json'), `${JSON.stringify({ target: opts.target, node: pin.version, pi: pi.version, piCli: pi.cli, ...(ffPin ? { ffmpeg: ffPin.version } : {}) }, null, 2)}\n`, { mode: 0o644 });
    noSymlinks(partial);
    if (opts.selfCheck) selfCheck(partial, opts.target, pi.version);
    fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(partial, out);
    const s = sizeOf(out);
    console.log(`runtime ${opts.target}: Node ${pin.version} + Pi ${pi.version}${ffPin ? ` + ffmpeg ${ffPin.version}` : ''} -> ${out} (${s.files} files, ${(s.bytes / 1048576).toFixed(1)} MiB)${opts.selfCheck ? ', self-check ok' : ''}`);
    if (opts.archive) {
      const archive = path.resolve(opts.archive);
      const a = packArchive(out, archive);
      console.log(`archive ${archive} sha256 ${a.sha} (${a.bytes} bytes)`);
    }
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
    if (tmpCache) fs.rmSync(cache, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`build-runtime: ${e.message}`);
  process.exit(e instanceof Fail ? e.code : 1);
});
