#!/usr/bin/env node
'use strict';
/* K2-02 T1 (S1, S2) + K2-05 T1 (S1): build the runtime folder Koda ships inside every installer: its own pinned Node,
   its own pinned Pi and its own pinned gentle-pi (Gentle Shell), so Koda never needs (nor touches) a Node or a Pi
   installed on the machine.

   K2-13 (L41): the same folder carries the daemon's own runtime dependencies (@mtcute/node, the Telegram client library),
   because this is the one npm tree every installer already verifies, extracts and writes licence notices for. They add no
   native addon: mtcute's crypto is WASM and better-sqlite3 — its one hard native dependency — is replaced by the empty
   stub in stubs/better-sqlite3 (the daemon always passes mtcute's MemoryStorage, so the SqliteStorage that would load the
   addon is never constructed; the stub throws if it ever is). assertNoNativeAddons() fails the build otherwise.

   Usage: node packaging/runtime/build-runtime.cjs --target <linux-x64|darwin-arm64|win-x64> --out <dir>
            [--node-archive <file>] [--engram-archive <file>] [--ffmpeg-archive <file>] [--ytdlp-dir <dir>] [--cache <dir>] [--self-check] [--archive <file.tar.gz>]

   Inputs, all pinned in this directory:
   - node.sha256: one official Node archive per target with its sha256 (the lines of the release's signed SHASUMS256.txt).
     The archive comes from --node-archive (offline) or from https://nodejs.org/dist/; a sha256 mismatch fails closed.
   - package.json + package-lock.json: Pi, gentle-pi and every peer gentle-pi declares, plus the daemon's runtime
     dependencies, all pinned exactly; npm ci installs every package against its lockfile sha512. The only non-registry
     entry is Koda's own better-sqlite3 stub (stubs/).
   - ytdlp.sha256 (K2-13 T2c-8, S19): the standalone yt-dlp executable for linux-x64 and for win-x64 (none for
     darwin-arm64), by release tag + sha256, plus the sha256 of the two licence texts it ships with (yt-dlp's
     Unlicense and the release's THIRD_PARTY_LICENSES.txt, in packaging/runtime/ytdlp/). The binary comes from
     --ytdlp-dir (offline) or from github.com/yt-dlp/yt-dlp/releases; a sha256 mismatch fails closed, and so does a
     file that carries no PyInstaller archive (i.e. is not an official standalone build). yt-dlp breaks whenever
     YouTube changes, so this pin has to be refreshed often: see the header of ytdlp.sha256.
   - ffmpeg.sha256 (K2-13 S9): one BtbN/FFmpeg-Builds LGPL archive for linux-x64 and for win-x64 (none for darwin-arm64:
     no LGPL macOS build exists yet), from --ffmpeg-archive (offline) or its GitHub release; a sha256 mismatch fails
     closed. Only bin/ffmpeg[.exe] and LICENSE.txt leave the archive (no ffprobe, ffplay, docs). The build refuses a
     binary whose embedded configure string has --enable-gpl or --enable-nonfree (or has no configure string at all)
     and a LICENSE.txt that is not the LGPL text.
   - engram.sha256 (K2-05 T1b, S5): one PREBUILT release asset of the Gentleman-Programming/engram binary per target
     (linux-x64 -> linux_amd64.tar.gz, darwin-arm64 -> darwin_arm64.tar.gz, win-x64 -> windows_amd64.zip; the release
     lists exactly one supported Windows archive, the same rule Gentle Dot applies), never built from Go. The archive
     comes from --engram-archive (offline) or from the GitHub release; a sha256 mismatch fails closed. Only the single
     engram/engram.exe member is extracted to <out>/bin/ (mode 0755); the release's extra members (tools/…) never ship.
   A CROSS-TARGET BUILD (--target other than the build host) is audited after npm ci: every installed package that
   declares os/cpu/libc must run on the --target, because npm installs native optionals for the host alone and such a
   build would silently ship the host's native files; the mismatch names the package and the target and fails the
   build closed (no output). Pure-JS trees cross-build freely.

   Output (<out>, created only when every step succeeds; a failed build leaves <out> untouched):
     node | node.exe       the pinned Node binary only: no npm, npx or corepack
     LICENSE.node          Node's licence (MIT plus its bundled components)
     THIRD-PARTY-NOTICES.md  Node and every shipped package with its licence (texts from licenses/ for packages
                           that ship no licence file; a licence with no text there fails the build)
     node_modules/...      Pi, gentle-pi, the daemon's runtime dependencies and their dependencies, install scripts not
                           run, no .bin symlinks, no symlink at all, and no native addon of Koda's own
     pi                    (Linux, macOS) launcher that runs Pi with THIS Node; Windows needs none: the daemon starts
                           node.exe with Pi's own CLI JS resolved next to it (desktop-daemon runtime.cjs)
     gentle-shell          (Linux, macOS) launcher of the same shape that runs gentle-pi's bin/gentle-shell.mjs with THIS
                           Node; Windows gets none (T2 resolves node.exe + the script in the daemon)
     bin/engram | bin\\engram.exe  the pinned Engram binary (K2-05 T1b)
     ffmpeg | ffmpeg.exe   (linux-x64, win-x64) the pinned LGPL ffmpeg the daemon spawns for Minikoda transcriptions
     LICENSE.ffmpeg.txt    its LGPL v3 text (from the archive); THIRD-PARTY-NOTICES.md says where its source is
     yt-dlp | yt-dlp.exe   (linux-x64, win-x64) the pinned standalone yt-dlp the daemon spawns to read YouTube links
     LICENSE.yt-dlp.txt    yt-dlp's Unlicense text
     THIRD-PARTY-NOTICES.yt-dlp.txt  its release's THIRD_PARTY_LICENSES.txt (Python, GNU Readline, mutagen, …)
     koda-runtime.json     {target, node, pi, piCli, gentlePi, gentleShell, engram, engramBin, ffmpeg?, ytdlp?}
   --archive also packs <out> into ONE tar.gz (members relative to the runtime folder's root, no links) and prints its
   sha256: the single file the Linux and Windows installers ship and verify before extracting. macOS ships the folder.
   --self-check runs the built Pi (`pi --version`), the built Engram (`bin/engram version`, offline, requires the pinned
   version) and the built gentle-shell offline (an RPC get_state answered with success:true over stdin, no auto-setup,
   PI_CODING_AGENT_DIR unset) with an empty private HOME; only on this OS.
   KODA_RUNTIME_SELF_CHECK_TIMEOUT_MS (TESTS ONLY — never set it on a real build) overrides both gentle-shell
   self-check bounds: the wait for the get_state answer and the wait for gentle-shell's exit after it answers;
   any other value than a positive integer fails the build. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const HERE = __dirname;
const PI = '@earendil-works/pi-coding-agent';
const GENTLE = 'gentle-pi';
const TARGETS = {
  'linux-x64': { platform: 'linux', arch: 'x64', ext: '.tar.gz', exe: 'node', engramAsset: 'linux_amd64.tar.gz', engramExe: 'engram' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', ext: '.tar.gz', exe: 'node', engramAsset: 'darwin_arm64.tar.gz', engramExe: 'engram' },
  'win-x64': { platform: 'win32', arch: 'x64', ext: '.zip', exe: 'node.exe', engramAsset: 'windows_amd64.zip', engramExe: 'engram.exe' },
};
const ENGRAM_RELEASE = 'https://github.com/Gentleman-Programming/engram/releases';
// K2-05 T1b: the prebuilt binary ships no licence file; these facts come from the repository's LICENSE at tag v3.4.0
// (https://raw.githubusercontent.com/Gentleman-Programming/engram/v3.4.0/LICENSE), not from the release archive.
const ENGRAM_LICENCE = { id: 'MIT', holder: '2026 Alan Buscaglia', repository: 'https://github.com/Gentleman-Programming/engram' };

/* K2-13 (S9): the BtbN asset flavour per target; darwin-arm64 ships no ffmpeg (pending for the Mac session). */
const FFMPEG_TARGETS = { 'linux-x64': { flavour: 'linux64', ext: '.tar.xz', exe: 'ffmpeg' }, 'win-x64': { flavour: 'win64', ext: '.zip', exe: 'ffmpeg.exe' } };
const FFMPEG_RELEASES = 'https://github.com/BtbN/FFmpeg-Builds/releases/download';

/* K2-13 T2c-8 (S19): the standalone yt-dlp the daemon spawns to read the YouTube links of a post; darwin-arm64 ships
   none (pending for the Mac session, decision L12), where the daemon answers youtube_unavailable. The two licence
   texts of the release travel beside the binary: yt-dlp is Unlicense, and its official standalone executables are
   PyInstaller bundles that also carry copyleft components (GNU Readline GPL-3.0-or-later, mutagen GPL-2.0-or-later),
   named in the release's THIRD_PARTY_LICENSES.txt. */
const YTDLP_TARGETS = { 'linux-x64': { asset: 'yt-dlp_linux', exe: 'yt-dlp' }, 'win-x64': { asset: 'yt-dlp.exe', exe: 'yt-dlp.exe' } };
const YTDLP_RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/download';
/** [file in packaging/runtime/, name it gets in the runtime folder] — both pinned in ytdlp.sha256. */
const YTDLP_LICENCES = [
  ['ytdlp/unlicense.txt', 'LICENSE.yt-dlp.txt'],
  ['ytdlp/third-party-licenses.txt', 'THIRD-PARTY-NOTICES.yt-dlp.txt'],
];
/** Present in every official PyInstaller standalone build; a file without it is not one. */
const YTDLP_PYINSTALLER_MARK = 'pyimod01_archive';

class Fail extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

function parseArgs(argv) {
  const opts = { selfCheck: false };
  const takes = { '--target': 'target', '--out': 'out', '--node-archive': 'nodeArchive', '--engram-archive': 'engramArchive', '--ffmpeg-archive': 'ffmpegArchive', '--ytdlp-dir': 'ytdlpDir', '--cache': 'cache', '--archive': 'archive' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-check') { opts.selfCheck = true; continue; }
    if (!takes[a] || i + 1 >= argv.length) throw new Fail(`usage: build-runtime.cjs --target <${Object.keys(TARGETS).join('|')}> --out <dir> [--node-archive <file>] [--engram-archive <file>] [--ffmpeg-archive <file>] [--ytdlp-dir <dir>] [--cache <dir>] [--self-check] [--archive <file.tar.gz>] (bad argument: ${a})`, 2);
    opts[takes[a]] = argv[(i += 1)];
  }
  if (!opts.target || !opts.out) throw new Fail('usage: build-runtime.cjs --target <target> --out <dir> (both are required)', 2);
  if (!TARGETS[opts.target]) throw new Fail(`unknown target ${opts.target}; known: ${Object.keys(TARGETS).join(', ')}`, 2);
  if (opts.ffmpegArchive && !FFMPEG_TARGETS[opts.target]) throw new Fail(`--ffmpeg-archive: ${opts.target} ships no ffmpeg (no LGPL build for it yet)`, 2);
  if (opts.ytdlpDir && !YTDLP_TARGETS[opts.target]) throw new Fail(`--ytdlp-dir: ${opts.target} ships no yt-dlp`, 2);
  return opts;
}

/* Windows-only, bounded rename retry (CI 43352802736, installer smoke windows): Defender and the search indexer keep a
   handle on a folder that was just written, and the rename of it fails with a TRANSIENT EPERM/EBUSY/EACCES. Only those
   three codes, only on win32, at most RENAME_ATTEMPTS attempts: every guarantee stays (the partial is still what is
   renamed, the swap is still one rename, and a rename that still fails surfaces exactly the error it failed with). */
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 50;
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/* Synchronous pause: this is a script with no event loop to yield to between attempts. */
function pauseSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function renameRetries(error, platform) { return platform === 'win32' && TRANSIENT_RENAME.has(error && error.code); }

/* `deps` is the seam runtime-build-check.cjs uses to prove both directions without Windows; production passes nothing. */
function renameWithRetry(from, to, deps = {}) {
  const rename = deps.rename || fs.renameSync;
  const platform = deps.platform || process.platform;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return rename(from, to);
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !renameRetries(error, platform)) throw error;
      pauseSync(RENAME_BACKOFF_MS * attempt);
    }
  }
}

/* Test seam (runtime-build-check.cjs), inert unless a check sets it: the first N commit renames fail with the code
   Windows raises, as if this build ran there. A build that reads no environment variable behaves exactly as before. */
function commitDeps() {
  const faults = Number(process.env.KODA_RUNTIME_TEST_RENAME_EPERM || 0);
  if (!Number.isInteger(faults) || faults <= 0) return {};
  let left = faults;
  return {
    platform: 'win32',
    rename: (from, to) => {
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return fs.renameSync(from, to);
    },
  };
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

/* The full commit id behind the abbreviated `-g<rev>` FFmpeg's own version string carries (a describe label, not the
   identity). An unknown revision is stated as the abbreviation alone: the notices never invent a hash. */
const FFMPEG_FULL_REV = { c179411bbb: 'c179411bbb2864cc71323d3055acda25d5c2aace' };

/* The FFmpeg section of the runtime notices: the licence, the exact binary it came from and where its source is. */
function ffmpegNotice(pin) {
  const rev = /-g([0-9a-f]+)$/.exec(pin.version)[1];
  const full = FFMPEG_FULL_REV[rev];
  const revision = full ? `${full} (the commit ${pin.version} labels \`${rev}\`)` : rev;
  const tree = `https://github.com/FFmpeg/FFmpeg/tree/${full ?? rev}`;
  return [`## FFmpeg ${pin.version} (\`${pin.exe}\`)`, '',
    'License: LGPL-3.0-or-later. Full text: `LICENSE.ffmpeg.txt` in this folder.',
    `The \`${pin.exe}\` in this folder is FFmpeg (https://ffmpeg.org), built by BtbN/FFmpeg-Builds as an LGPL build:`,
    'configured with --enable-version3 and built without --enable-gpl and without --enable-nonfree. Koda runs it as a separate',
    'program, unmodified, only to extract and split the audio of videos for transcription.',
    `- Binary: ${FFMPEG_RELEASES}/${pin.tag}/${pin.name} (sha256 ${pin.sha})`,
    `- Corresponding Source: the FFmpeg source at revision ${revision}, ${tree}`,
    `  and the scripts that built it, https://github.com/BtbN/FFmpeg-Builds (release ${pin.tag}), which also list the`,
    '  libraries linked into it and their licences. The version string is a label, never the identity of the source:',
    '  the revision hash above is.',
    '- Source access (GPL-3.0 §6(d), incorporated by LGPL-3.0 — the clause that applies to a downloadable installer):',
    '  whoever downloads this binary has to be able to obtain the Corresponding Source above from a designated place (a',
    '  network server or an equivalent), in the same way they obtained the binary, with clear directions next to the',
    '  download. A written offer to send the source on request (GPL-3.0 §6(b), the clause for a copy handed over in a',
    '  physical product) on its own, is NOT sufficient for a download.',
    '- NOT DONE YET, before a public release: Koda does not mirror that Corresponding Source itself, so no designated',
    '  place exists yet and the obligation above is unmet. The mirror must exist and be linked from this notice and from',
    '  the download page before the first public release, and it also has to make the BtbN/FFmpeg-Builds scripts and the',
    '  library versions they name available. As an additional measure Koda offers a copy on request (GPL-3.0 §6(b)): for',
    '  at least three years after the release that shipped it, anyone who received this binary can ask, through the',
    '  issue tracker of the repository Koda is published from, for no more than the cost of making and sending the copy.',
    '  The licence review of FFmpeg (LGPL-3.0 obligations and the AAC/H.264 patent question) has NOT been done. This is',
    '  an engineering record, not legal advice.',
    'You may replace this file with your own build of FFmpeg; Koda calls it by this path with command-line arguments only.', ''];
}

/* The pin lines of a sha256 file: [sha, path], comments and blanks dropped. */
function pinLines(name) {
  return fs.readFileSync(path.join(HERE, name), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
}

/* The yt-dlp pin for a target, or null (darwin-arm64). Exactly one official asset per shipped target. */
function ytdlpPin(target) {
  const t = YTDLP_TARGETS[target];
  if (!t) return null;
  const pins = pinLines('ytdlp.sha256');
  const mine = pins.filter(([, rel]) => rel && rel.endsWith(`/${t.asset}`));
  if (mine.length !== 1) throw new Fail(`ytdlp.sha256 must pin exactly one ${t.asset} for ${target}, found ${mine.length}`);
  const [sha, rel] = mine[0];
  const m = new RegExp(`^(\\d{4}\\.\\d{2}\\.\\d{2})/(${t.asset.replace(/[.]/g, '\\.')})$`).exec(rel);
  if (!/^[0-9a-f]{64}$/.test(sha) || !m) throw new Fail(`malformed ytdlp.sha256 line for ${target} (<sha256>  <yyyy.mm.dd>/${t.asset})`);
  return { sha, tag: m[1], asset: t.asset, exe: t.exe, name: rel };
}

/* The two licence texts, each verified against its own pin: the file that ships is the pinned one, byte for byte. */
function ytdlpLicences() {
  const pins = pinLines('ytdlp.sha256').filter(([, rel]) => rel && rel.startsWith('ytdlp/'));
  if (pins.length !== YTDLP_LICENCES.length) throw new Fail(`ytdlp.sha256 must pin the ${YTDLP_LICENCES.length} yt-dlp licence texts, found ${pins.length}`);
  for (const [source] of YTDLP_LICENCES) {
    const pin = pins.find(([, rel]) => rel === source);
    if (!pin) throw new Fail(`ytdlp.sha256 does not pin ${source}`);
    const file = path.join(HERE, source);
    if (!fs.existsSync(file)) throw new Fail(`missing yt-dlp licence text ${source}`);
    const got = sha256File(file);
    if (got !== pin[0]) throw new Fail(`${source} does not match its pinned sha256: expected ${pin[0]}, got ${got}`);
  }
  return YTDLP_LICENCES.map(([source, output]) => ({ source: path.join(HERE, source), output }));
}

async function ytdlpBinary(pin, opts, cache) {
  let file = opts.ytdlpDir ? path.join(path.resolve(opts.ytdlpDir), pin.asset) : path.join(cache, pin.asset);
  if (!opts.ytdlpDir && !fs.existsSync(file)) {
    const partial = `${file}.partial-${process.pid}`;
    await download(`${YTDLP_RELEASES}/${pin.tag}/${pin.asset}`, partial);
    fs.renameSync(partial, file);
  }
  if (!fs.existsSync(file)) throw new Fail(`yt-dlp binary not found: ${file}`);
  if (path.basename(file) !== pin.asset) throw new Fail(`yt-dlp binary must be ${pin.asset}, got ${path.basename(file)}`);
  const got = sha256File(file);
  if (got !== pin.sha) {
    if (!opts.ytdlpDir) fs.rmSync(file, { force: true });
    throw new Fail(`yt-dlp SHA256 mismatch for ${pin.asset}: expected ${pin.sha}, got ${got}`);
  }
  return file;
}

/* The PyInstaller marker proves the file is an official standalone build and not an arbitrary executable that happens
   to have the right hash for our own pin. It is copied byte for byte and made executable; its licence texts follow. */
function stageYtdlp(file, pin, dest, licences) {
  const bytes = fs.readFileSync(file);
  if (!bytes.includes(Buffer.from(YTDLP_PYINSTALLER_MARK))) throw new Fail(`yt-dlp ${pin.asset} carries no PyInstaller archive: it is not the official standalone build`);
  fs.copyFileSync(file, path.join(dest, pin.exe));
  fs.chmodSync(path.join(dest, pin.exe), 0o755);
  for (const { source, output } of licences) {
    fs.copyFileSync(source, path.join(dest, output));
    fs.chmodSync(path.join(dest, output), 0o644);
  }
}

/* The yt-dlp section of the runtime notices: what ships, its licence, the copyleft components inside the official
   executable, and the source-access record (the same shape as the FFmpeg one). */
function ytdlpNotice(pin) {
  return [`## yt-dlp ${pin.tag} (\`${pin.exe}\`)`, '',
    'License: Unlicense (public domain). Full text: `LICENSE.yt-dlp.txt` in this folder.', '',
    `The \`${pin.exe}\` in this folder is yt-dlp (https://github.com/yt-dlp/yt-dlp), the official standalone build of release`,
    `${pin.tag}, unmodified. Koda runs it as a separate, unmodified program with command-line arguments only — the daemon spawns it to read`,
    'the subtitles or the audio of a YouTube video link that a Minikoda found in a post. Its own code is not linked with it.',
    `- Binary: ${YTDLP_RELEASES}/${pin.tag}/${pin.asset} (sha256 ${pin.sha})`,
    '- The official standalone executables are PyInstaller bundles: they also carry Python (PSF-2.0) and third-party',
    '  components, including copyleft ones — GNU Readline (GPL-3.0-or-later, bundled as its own shared object) and mutagen',
    '  (GPL-2.0-or-later) — plus libidn2, libunistring and libintl (LGPL-3.0-or-later / LGPL-2.1-or-later), libstdc++ and',
    '  libgcc (GPL-3.0-with-GCC-exception) and BoringSSL, curl, nghttp2, Tornado and others under permissive licences.',
    '  Their texts travel in this folder, verbatim from the release: `THIRD-PARTY-NOTICES.yt-dlp.txt`.',
    '- Corresponding Source: the yt-dlp source at tag ' + pin.tag + `, https://github.com/yt-dlp/yt-dlp/tree/${pin.tag}, and`,
    '  the source of each bundled component from its original project; yt-dlp states that the maintainers provide it on',
    '  request (maintainers@yt-dlp.org) as the licences require.',
    '- Source access (GPL-3.0 §6(d) through the GPL-3.0-or-later components; the clause that applies to a downloadable',
    '  installer): a recipient has to be able to obtain that Corresponding Source from a designated place (a network',
    '  server or an equivalent) in the same way they obtained the binary, with clear directions next to the download.',
    '- NOT DONE YET, before a public release: Koda does not mirror that Corresponding Source itself, so no designated',
    '  place exists yet and the obligation above is unmet. The mirror must exist and be linked from this notice and from',
    '  the download page before the first public release. As an additional measure Koda offers a copy on request',
    '  (GPL-3.0 §6(b)) for at least three years after the release that shipped it. The licence review of yt-dlp and of',
    '  the copyleft components inside its standalone builds has NOT been done. This is an engineering record, not legal',
    "  advice. (YouTube's own terms do not allow downloading outside its apps; the product decision to read links",
    '  through subtitles or a downloaded audio track was taken knowingly — decision L33.)',
    '- YouTube breaks yt-dlp regularly: this pin has to be refreshed often (tag, both sha256 values from the release',
    '  SHA2-256SUMS and the two licence texts) instead of shipping a binary that no longer extracts a video.', ''];
}

/* K2-05 T1b (S5): the Engram pin, the same shape as nodePin: one prebuilt release asset per target, whose sha256 is
   the line of the release's own checksums.txt (cross-checked at pin time against gentle-pi 4.3.0's
   installer-downloads.mjs). The Windows release lists exactly one supported archive (zip, no tar.gz) — the same
   ambiguity rule Gentle Dot's packager applies. Engram is never built from Go. */
function engramPin(target) {
  const t = TARGETS[target];
  let lines;
  try { lines = fs.readFileSync(path.join(HERE, 'engram.sha256'), 'utf8').trim().split(/\r?\n/); }
  catch (e) { throw new Fail(`cannot read engram.sha256 next to this script (${e.code})`); }
  const suffix = `_${t.engramAsset}`;
  const pins = lines.map((l) => l.trim().split(/\s+/)).filter(([, name]) => name && name.endsWith(suffix));
  if (pins.length !== 1) throw new Fail(`engram.sha256 must pin exactly one archive for ${target}, found ${pins.length}`);
  const [sha, name] = pins[0];
  const m = /^engram_(\d+\.\d+\.\d+)_/.exec(name);
  if (!/^[0-9a-f]{64}$/.test(sha) || !m) throw new Fail(`malformed engram.sha256 line for ${target}`);
  return { sha, name, version: m[1] };
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
    renameWithRetry(partial, file);
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

/* The Engram release asset: the same acquisition rules as Node's (offline --engram-archive, else the GitHub release;
   sha256 fail-closed, a bad download never stays in the cache). */
async function engramArchive(pin, opts, cache) {
  let file = opts.engramArchive ? path.resolve(opts.engramArchive) : path.join(cache, pin.name);
  if (!opts.engramArchive && !fs.existsSync(file)) {
    const partial = `${file}.partial-${process.pid}`;
    await download(`${ENGRAM_RELEASE}/download/v${pin.version}/${pin.name}`, partial);
    fs.renameSync(partial, file);
  }
  if (!fs.existsSync(file)) throw new Fail(`Engram archive not found: ${file}`);
  if (path.basename(file) !== pin.name) throw new Fail(`Engram archive must be ${pin.name}, got ${path.basename(file)}`);
  const got = sha256File(file);
  if (got !== pin.sha) {
    if (!opts.engramArchive) fs.rmSync(file, { force: true }); // never keep a bad download in the cache
    throw new Fail(`Engram archive SHA256 mismatch for ${pin.name}: expected ${pin.sha}, got ${got}`);
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

/* K2-05 T1b (S5): only the SINGLE engram / engram.exe member leaves the release archive (the release also carries
   tools/cloud-sync-projects.* and could carry anything); it lands at <out>/bin/<engram.exe>, mode 0755, and a
   symlink member is never extracted (lstat must say regular file). */
function extractEngram(archive, pin, target, dest) {
  const t = TARGETS[target];
  const scratch = fs.mkdtempSync(path.join(path.dirname(dest), '.engram-extract-'));
  try {
    const member = t.engramExe;
    const extract = (label, cmd, args) => {
      // A release archive that lacks the member fails closed with the controlled message (tar itself would die with
      // its own "member not found" exit; the fail-closed contract names the archive and the member instead).
      try { run(cmd, args); } catch (e) {
        // Bounded detail only (the first line): tar's own stderr is localized, so the fail-closed message stays stable.
        throw new Fail(`Engram archive ${pin.name} lacks a regular file ${member} (extraction: ${e.message.split('\n')[0]})`);
      }
    };
    if (process.platform === 'win32') {
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      extract('tar', tar, ['-xf', archive, '-C', scratch, member]);
    } else if (t.ext === '.zip' && process.platform === 'linux') {
      extract('unzip', 'unzip', ['-q', archive, member, '-d', scratch]); // GNU tar does not read zip
    } else {
      extract('tar', 'tar', ['-xf', archive, '-C', scratch, member]);
    }
    const st = fs.lstatSync(path.join(scratch, member), { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new Fail(`Engram archive ${pin.name} lacks a regular file ${member}`);
    fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(scratch, member), path.join(dest, 'bin', member));
    fs.chmodSync(path.join(dest, 'bin', member), 0o755);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
/* Tests only: shortens BOTH gentle-shell self-check bounds (the wait for the get_state answer and the wait for the
   exit after the answer) so a self-check regression fails in seconds, not in two minutes. A number, nothing else. */
function selfCheckTimeoutMs() {
  const raw = process.env.KODA_RUNTIME_SELF_CHECK_TIMEOUT_MS;
  if (raw === undefined) return 120_000;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Fail(`KODA_RUNTIME_SELF_CHECK_TIMEOUT_MS must be a positive integer (tests only), got ${JSON.stringify(raw)}`, 2);
  }
  return Number(raw);
}

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

function installPi(dest, cache, target, t) {
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(HERE, f), path.join(dest, f));
  // K2-13: a `file:` dependency (Koda's better-sqlite3 stub) resolves from the build directory, so the stub folder travels
  // with the pins and is removed again after the install: the output holds the installed copy, never the source folder.
  const stubs = path.join(HERE, 'stubs');
  const hasStubs = fs.lstatSync(stubs, { throwIfNoEntry: false })?.isDirectory() === true;
  if (hasStubs) fs.cpSync(stubs, path.join(dest, 'stubs'), { recursive: true });
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
  auditTargetPlatforms(dest, target, t);
  for (const f of ['package.json', 'package-lock.json']) fs.rmSync(path.join(dest, f));
  if (hasStubs) fs.rmSync(path.join(dest, 'stubs'), { recursive: true, force: true });
  // npm-only bookkeeping and the .bin symlinks; Koda starts Pi through its own launcher (or the daemon on Windows).
  fs.rmSync(path.join(dest, 'node_modules', '.bin'), { recursive: true, force: true });
  fs.rmSync(path.join(dest, 'node_modules', '.package-lock.json'), { force: true });
  const pkgDir = path.join(dest, 'node_modules', ...PI.split('/'));
  const piManifest = readJson(path.join(pkgDir, 'package.json'));
  const gentleDir = path.join(dest, 'node_modules', GENTLE);
  const gentleManifest = readJson(path.join(gentleDir, 'package.json'));
  return {
    pi: { version: piManifest.version, ...binInPackage(dest, pkgDir, 'pi', `${PI} declares no relative "pi" bin`) },
    gentle: { version: gentleManifest.version, ...binInPackage(dest, gentleDir, 'gentle-shell', `${GENTLE} declares no relative "gentle-shell" bin`) },
  };
}

/* K2-05 T1 finding 3 (option C): npm installs a package's native optional dependencies for the BUILD HOST only.
   A cross-target build would therefore silently bundle the host's native files (e.g. Linux binaries in a
   win-x64 runtime). After npm ci, every installed package that declares os/cpu — or libc, which only npm on
   Linux ever honours — must be able to run on the --target; anything else fails the build closed, naming the
   package and the target, and leaves no output. Pure-JS trees (no os/cpu/libc declared) cross-build freely. */
function listMatchesTarget(list, wanted) {
  // npm's os/cpu semantics, small and strict: 'any' matches, a negation vetoes, and when any positive entry is
  // declared at least one positive entry must match.
  if (!Array.isArray(list)) list = [list];
  let hasPositive = false;
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    if (entry === 'any') return true;
    if (entry.startsWith('!')) { if (entry.slice(1) === wanted) return false; continue; }
    hasPositive = true;
    if (entry === wanted) return true;
  }
  return !hasPositive; // only negations, and the target matches none of them
}
function auditTargetPlatforms(dest, target, t) {
  for (const { manifest } of packagesIn(path.join(dest, 'node_modules'))) {
    const problems = [];
    if (manifest.os !== undefined && !listMatchesTarget(manifest.os, t.platform)) problems.push(`os ${JSON.stringify(manifest.os)}`);
    if (manifest.cpu !== undefined && !listMatchesTarget(manifest.cpu, t.arch)) problems.push(`cpu ${JSON.stringify(manifest.cpu)}`);
    if (manifest.libc !== undefined && t.platform !== 'linux') problems.push(`libc ${JSON.stringify(manifest.libc)}`);
    if (problems.length) {
      throw new Fail(`${manifest.name}@${manifest.version} runs on ${problems.join(', ')} — not on --target ${target} (${t.platform}-${t.arch}): cross-target builds ship only packages that run on the target`);
    }
  }
}

/* A package's bin entry for `name`: relative, inside the package, a real regular file — anything else fails closed.
   Returns the file's path relative to the runtime folder's root (forward slashes, for koda-runtime.json). */
function binInPackage(dest, pkgDir, name, missingMessage) {
  const manifest = readJson(path.join(pkgDir, 'package.json'));
  const bin = manifest && manifest.bin && manifest.bin[name];
  if (typeof bin !== 'string' || !bin || path.isAbsolute(bin)) throw new Fail(missingMessage);
  const cli = path.resolve(pkgDir, bin);
  const rel = path.relative(pkgDir, cli);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.lstatSync(cli, { throwIfNoEntry: false })?.isFile()) {
    throw new Fail(`${path.basename(pkgDir)} bin ${bin} is not a file inside the package`);
  }
  return { cli: path.relative(dest, cli).split(path.sep).join('/') };
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
function writeNotices(dest, nodeVersion, engram, ffPin, ytPin) {
  const lines = ['# Third-party notices: Koda\'s bundled runtime', '',
    'Koda ships Node.js, Pi, Gentle Shell (gentle-pi) and Engram in this folder (K2-02, K2-05), plus the daemon\'s own',
    'runtime dependencies (K2-13: @mtcute/node, the Telegram client library, with the empty better-sqlite3 stub this',
    'folder ships in place of its native addon). Their licences and those of every package they include follow.', '',
    `## Node.js ${nodeVersion}`, '', 'License: MIT (with bundled components). Full text: `LICENSE.node` in this folder.', '',
    ...(ffPin ? ffmpegNotice(ffPin) : []),
    ...(ytPin ? ytdlpNotice(ytPin) : [])];
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
  engramNotice(lines, engram, texts); // K2-05 T1b: the shipped engram binary gets its own notice, like every package
  if (texts.size) {
    lines.push('## License texts', '');
    for (const [id, text] of [...texts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`### ${id}`, '', '```text', text.trimEnd(), '```', '');
  }
  fs.writeFileSync(path.join(dest, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'), { mode: 0o644 });
}
/* K2-05 T1b (S5): Engram ships as the prebuilt release binary, which carries no licence file, so its licence text
   comes from packaging/runtime/licenses/ (the canonical text of its repository LICENSE, pinned to v3.4.0) under its
   own copyright holder — exactly the treatment a node_modules package with no licence file gets. */
function engramNotice(lines, engram, texts) {
  const id = ENGRAM_LICENCE.id;
  lines.push(`## Engram ${engram.version}`, '', `License: ${id}`, `Repository: ${ENGRAM_LICENCE.repository}`);
  const canonical = path.join(HERE, 'licenses', `${id}.txt`);
  if (!/^[A-Za-z0-9.-]+$/.test(id) || !fs.existsSync(canonical)) {
    throw new Fail(`Engram is ${id}, ships no licence file, and packaging/runtime/licenses/ has no ${id} text: refusing to ship it without its licence`);
  }
  const text = fs.readFileSync(canonical, 'utf8');
  if (id === 'MIT') {
    const holder = ENGRAM_LICENCE.holder;
    lines.push('The prebuilt engram binary ships no licence file; the MIT License text follows, with the copyright holder the repository\'s LICENSE ' +
      `(tag ${engram.version}) declares:`, '', '```text', text.replace('Copyright (c) <year> <copyright holders>', `Copyright (c) ${holder}`).trimEnd(), '```');
  } else {
    texts.set(`${id} (Engram)`, text);
    lines.push(`The prebuilt engram binary ships no licence file; the ${id} License text is reproduced under «License texts» below.`);
  }
  lines.push('');
}

function noSymlinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Fail(`runtime contains a symlink: ${path.relative(dir, p)}`);
    if (e.isDirectory()) noSymlinks(p);
  }
}

/* K2-13: nothing the daemon's dependencies bring in may be a native addon. Scoped to what K2-13 adds (@mtcute, @fuman and
   the better-sqlite3 slot) so a Pi release with its own platform prebuild never breaks this build: Pi's prebuilds under
   @earendil-works/pi-tui/native/ shipped before K2-13 and are not ours to police here. */
const NO_ADDON_SCOPE = ['@mtcute', '@fuman', 'better-sqlite3'];
function assertNoNativeAddons(dest) {
  const modules = path.join(dest, 'node_modules');
  const st = fs.lstatSync(modules, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return;
  const addons = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // noSymlinks() reports every link; this walk never follows one
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.node')) addons.push(path.relative(modules, p).split(path.sep).join('/'));
    }
  };
  for (const scope of NO_ADDON_SCOPE) {
    const dir = path.join(modules, ...scope.split('/'));
    const own = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (own && own.isDirectory()) walk(dir);
  }
  if (addons.length) {
    throw new Fail(`Koda's runtime dependencies ship a native addon: ${addons.sort().join(', ')}. mtcute's crypto is WASM and better-sqlite3 must stay the empty stub: refusing to build a runtime that needs a compiled module.`);
  }
  let sqlite;
  try { sqlite = JSON.parse(fs.readFileSync(path.join(modules, 'better-sqlite3', 'package.json'), 'utf8')); } catch { sqlite = undefined; }
  if (sqlite && sqlite.kodaStub !== 'better-sqlite3') {
    throw new Fail('node_modules/better-sqlite3 is the real package, not Koda\'s empty stub: the native addon must never ship (see stubs/better-sqlite3)');
  }
}

function piLauncher(cli, why) {
  return [
    '#!/bin/sh',
    `# Koda's own ${why}: always run by the Node in this folder, never by a Node or a Pi from PATH.`,
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1',
    `exec "$here/node" "$here/${cli}" "$@"`,
    '',
  ].join('\n');
}

async function selfCheck(dest, target, piVersion) {
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
    const manifest = readJson(path.join(dest, 'koda-runtime.json'));
    const r = t.platform === 'win32'
      ? run(path.join(dest, t.exe), [path.join(dest, manifest.piCli), '--version'], { env, cwd: home })
      : run(path.join(dest, 'pi'), ['--version'], { env, cwd: home });
    const out = `${r.stdout}${r.stderr}`.trim();
    if (out !== piVersion) throw new Fail(`self-check: built Pi printed ${JSON.stringify(out)}, expected ${piVersion}`);
    engramSelfCheck(dest, t, home, env); // K2-05 T1b: offline, read-only, only on this OS
    await gentleSelfCheck(dest, t, home, env);
  } finally {
    // Best effort only: a failed cleanup here must never mask the primary error (an EBUSY from a briefly held
    // home used to replace the real self-check failure). With the whole-tree kill above this is belt and braces.
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* the primary error is what matters */ }
  }
}

/* K2-05 T1b (S5): the built Engram answers `version` offline with its own empty private HOME: a read-only run that
   must report the pinned version. Only reached on the build host (selfCheck refuses others) — `version` touches no
   network, and the PI_OFFLINE switches stay set like for Pi and Gentle Shell. */
function engramSelfCheck(dest, t, home, baseEnv) {
  const manifest = readJson(path.join(dest, 'koda-runtime.json'));
  const env = { ...baseEnv };
  delete env.PI_CODING_AGENT_DIR; // engram is not Pi; it must not see Pi's home switch
  const r = run(path.join(dest, manifest.engramBin), ['version'], { env, cwd: home });
  const out = `${r.stdout}${r.stderr}`.trim();
  const want = manifest.engram;
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`).test(out)) {
    throw new Fail(`self-check: built engram printed ${JSON.stringify(out)}, expected version ${want}`);
  }
}

/* K2-05 T1 (S1): the built Gentle Shell answers an RPC get_state offline — the L6 experiment, as a build gate.
   No auto-setup (no Engram companion, no gentle-ai binary), PI_CODING_AGENT_DIR unset: gentle-shell resolves its
   own --home, and Koda's daemon (T2) passes its own. Every wait is bounded: the answer must arrive within the
   timeout, and after it does, the child must still exit within the same bound. On any failure the child's WHOLE
   process tree is killed (gentle-shell spawns Pi as its own child and forwards signals only to it — see
   gentle-pi's bin/gentle-shell.mjs), and the self-check home is removed best effort so the cleanup can never
   mask the primary failure. */
function gentleSelfCheck(dest, t, home, baseEnv) {
  const manifest = readJson(path.join(dest, 'koda-runtime.json'));
  const script = path.join(dest, manifest.gentleShell);
  // The pi self-check's env sets PI_CODING_AGENT_DIR: gentle-shell must NOT see it (it resolves --home itself).
  const env = { ...baseEnv };
  delete env.PI_CODING_AGENT_DIR;
  env.GENTLE_SHELL_NO_AUTO_SETUP = '1';
  env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL = '1';
  const args = ['--home', path.join(home, 'agent'), '--mode', 'rpc', '--session-dir', path.join(home, 'sessions')];
  const cmd = t.platform === 'win32' ? path.join(dest, t.exe) : path.join(dest, 'gentle-shell');
  // POSIX: gentle-shell runs detached, in its own process group, so the failure paths below can SIGKILL the whole
  // group — gentle-shell itself, and the Pi process it spawns.
  const child = cp.spawn(cmd, t.platform === 'win32' ? [script, ...args] : args, { env, cwd: home, windowsHide: true, detached: t.platform !== 'win32' });
  const TIMEOUT_MS = selfCheckTimeoutMs();
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let settled = false;
    let answered = false;
    let bound = null;
    function killTree() {
      try {
        if (typeof child.pid !== 'number') return;
        if (t.platform === 'win32') {
          // Windows has no process groups here: taskkill /T /F walks the whole tree.
          cp.spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
        } else {
          process.kill(-child.pid, 'SIGKILL'); // negative pid: the detached process group
        }
      } catch { /* the tree may already be gone */ }
    }
    function settle(fn) { if (settled) return; settled = true; if (bound) clearTimeout(bound); fn(); }
    function fail(message) { settle(() => { killTree(); reject(new Fail(message)); }); }
    bound = setTimeout(() => {
      fail(`self-check: built gentle-shell did not answer get_state within ${TIMEOUT_MS / 1000}s (stdout so far: ${JSON.stringify(out.slice(-2000))}, stderr: ${JSON.stringify(err.slice(-2000))})`);
    }, TIMEOUT_MS);
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdout.on('data', (chunk) => {
      out += chunk;
      for (const line of out.split('\n')) {
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed && parsed.type === 'response' && parsed.command === 'get_state' && parsed.success === true) {
          if (settled || answered) return;
          answered = true;
          clearTimeout(bound);
          child.stdin.end(); // answered: only now is stdin closed (the experiment's order)
          const EXIT_MS = TIMEOUT_MS; // bounded, too: the child must leave after it answered
          bound = setTimeout(() => {
            fail(`self-check: built gentle-shell did not exit within ${EXIT_MS / 1000}s after answering get_state (stdout so far: ${JSON.stringify(out.slice(-2000))}, stderr: ${JSON.stringify(err.slice(-2000))})`);
          }, EXIT_MS);
        }
      }
    });
    child.on('error', (e) => fail(`self-check: cannot run built gentle-shell: ${e.message}`));
    child.on('exit', (code) => {
      if (!answered) fail(`self-check: built gentle-shell exited ${code} before answering get_state (stdout: ${JSON.stringify(out.slice(-2000))}, stderr: ${JSON.stringify(err.slice(-2000))})`);
      else if (code === 0) settle(() => resolve());
      else fail(`self-check: built gentle-shell exited ${code} after answering get_state (stderr: ${JSON.stringify(err.slice(-2000))})`);
    });
    child.stdin.write(`${JSON.stringify({ type: 'get_state', id: '1' })}\n`);
  });
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
    renameWithRetry(partial, archive);
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

/**
 * Whether the runtime archive is asked for INSIDE the folder it packs (82c27cf). Such an archive would be packed into
 * itself: GNU tar reads a file that is still growing and fails with «file changed as we read it» (a small tree only ever
 * passed by luck).
 *
 * Three cases are NOT inside: the folder itself, anything that starts with `..` (a sibling or an ancestor) and any
 * ABSOLUTE result — on Windows `path.relative` returns `D:\…` for a path on another drive, and treating that as inside
 * would pack beside the folder and then try to move the archive onto another drive.
 */
function archiveInsideOut(out, archive, relative = path.relative) {
  const rel = relative(out, archive);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return false;
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t = TARGETS[opts.target];
  const out = path.resolve(opts.out);
  const pin = nodePin(opts.target);
  const ffPin = ffmpegPin(opts.target);
  const ytPin = ytdlpPin(opts.target);
  const ytLicences = ytPin ? ytdlpLicences() : [];
  const tmpCache = !opts.cache;
  const cache = opts.cache ? path.resolve(opts.cache) : fs.mkdtempSync(path.join(os.tmpdir(), 'koda-runtime-cache-'));
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const partial = `${out}.partial-${process.pid}`;
  fs.rmSync(partial, { recursive: true, force: true });
  try {
    const engram = engramPin(opts.target); // before any download: a bad pin file refuses without touching the network
    const archive = await nodeArchive(pin, opts, cache);
    const engramFile = await engramArchive(engram, opts, cache);
    fs.mkdirSync(partial, { mode: 0o755 });
    extractNode(archive, pin, opts.target, partial);
    extractEngram(engramFile, engram, opts.target, partial);
    if (ffPin) extractFfmpeg(await ffmpegArchive(ffPin, opts, cache), ffPin, partial);
    if (ytPin) stageYtdlp(await ytdlpBinary(ytPin, opts, cache), ytPin, partial, ytLicences);
    const pi = installPi(partial, cache, opts.target, t);
    assertNoNativeAddons(partial);
    writeNotices(partial, pin.version, engram, ffPin, ytPin);
    if (t.platform !== 'win32') {
      fs.writeFileSync(path.join(partial, 'pi'), piLauncher(pi.pi.cli, 'Pi (K2-02)'), { mode: 0o755 });
      fs.writeFileSync(path.join(partial, 'gentle-shell'), piLauncher(pi.gentle.cli, 'Gentle Shell (K2-05)'), { mode: 0o755 });
    }
    fs.writeFileSync(path.join(partial, 'koda-runtime.json'), `${JSON.stringify({ target: opts.target, node: pin.version, pi: pi.pi.version, piCli: pi.pi.cli, gentlePi: pi.gentle.version, gentleShell: pi.gentle.cli, engram: engram.version, engramBin: `bin/${t.engramExe}`, ...(ffPin ? { ffmpeg: ffPin.version } : {}), ...(ytPin ? { ytdlp: ytPin.tag } : {}) }, null, 2)}\n`, { mode: 0o644 });
    noSymlinks(partial);
    if (opts.selfCheck) await selfCheck(partial, opts.target, pi.pi.version);
    fs.rmSync(out, { recursive: true, force: true });
    renameWithRetry(partial, out, commitDeps());
    const s = sizeOf(out);
    console.log(`runtime ${opts.target}: Node ${pin.version} + Pi ${pi.pi.version} + gentle-pi ${pi.gentle.version} + engram ${engram.version}${ffPin ? ` + ffmpeg ${ffPin.version}` : ''}${ytPin ? ` + yt-dlp ${ytPin.tag}` : ''} -> ${out} (${s.files} files, ${(s.bytes / 1048576).toFixed(1)} MiB)${opts.selfCheck ? ', self-check ok' : ''}`);
    if (opts.archive) {
      const archive = path.resolve(opts.archive);
      const inside = archiveInsideOut(out, archive);
      // The temporary MUST live outside the folder being packed: a file created inside it is read while it grows
      // («tar: file changed as we read it»), which is the whole bug.
      const target = inside ? path.join(path.dirname(out), `.${path.basename(archive)}.pack-${process.pid}`) : archive;
      const a = packArchive(out, target); // packArchive removes its own partial on failure
      if (inside) fs.renameSync(target, archive);
      console.log(`archive ${archive} sha256 ${a.sha} (${a.bytes} bytes)`);
    }
  } finally {
    fs.rmSync(partial, { recursive: true, force: true });
    if (tmpCache) fs.rmSync(cache, { recursive: true, force: true });
  }
}

/* The guard and the archive-path test are exported so test-node/ can hold them to fixtures (K2-13); RENAME_ATTEMPTS and
   renameWithRetry are exported too, because runtime-build-check.cjs tests the retry itself (K2-05 Windows flakies).
   Running this file as a script is unchanged below. */
module.exports = { RENAME_ATTEMPTS, archiveInsideOut, assertNoNativeAddons, renameWithRetry };
if (require.main === module) {
  main().catch((e) => {
    console.error(`build-runtime: ${e.message}`);
    process.exit(e instanceof Fail ? e.code : 1);
  });
}
