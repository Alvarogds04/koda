'use strict';
// K2-08 T4 (S1, S7; decisions L20 1a, 2a, 3a): a Codex `apply_patch` permission shows the path and a preview of the change,
// under the same R9 rules as Claude's Write/Edit cards. Only a single-file patch shown in full offers «Aprobar una vez»;
// several files (1a), a path outside the session folder (3a), a sensitive/redirected path, a hidden secret, anything
// «recortado» and anything outside the strict patch grammar get only «Rechazar» / «Decidir en la terminal».
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describePatchPermission, secret } = require('../src/file-permission.cjs');
const { handleCodexHook: raw_handleCodexHook, codexToolDescription, ALLOW, DENY } = require('../src/codex.cjs');
const { fakeReceiver, viaPipe } = require('./fake-receiver.cjs');
const { tmpBase } = require('./platform-env.cjs');
const handleCodexHook = viaPipe(raw_handleCodexHook);

const win = process.platform === 'win32';
// A short canonical session folder: macOS `/tmp` is a symlink to `/private/tmp` (a non-canonical folder fails closed) and its
// per-user tmpdir is long enough to look like a hidden token to the redactor; Windows uses the canonical user temp folder.
const dir = fs.mkdtempSync(path.join(win ? tmpBase() : fs.realpathSync('/tmp'), 'kap-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const abs = (...p) => path.join(dir, ...p);
const q = s => JSON.stringify(s);
const P = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const card = (lines, cwd = dir) => describePatchPermission({ command: typeof lines === 'string' ? lines : P(...lines) }, cwd);
const BASE = { filePreview: true, text: 'apply_patch', lossy: true, reason: 'solicitud no representable' };

test('precondition: the test session folder itself is not secret-looking', () => {
  assert.equal(secret(abs('uno.txt')), false, abs('uno.txt'));
});

test('Add of one file inside the session folder is approvable with the exact card text', () => {
  assert.deepEqual(card(['*** Add File: uno.txt', '+hola', '+mundo']),
    { filePreview: true, text: `apply_patch: ${q(abs('uno.txt'))}; añadir: ${q('hola\nmundo')}`, lossy: false });
  assert.deepEqual(card(['*** Add File: sub/dos.txt', '+']),
    { filePreview: true, text: `apply_patch: ${q(abs('sub', 'dos.txt'))}; añadir: ""`, lossy: false }, 'an empty added line is still a line');
  assert.deepEqual(card(['*** Add File: ' + abs('tres.txt'), '+x']).lossy, false, 'an absolute path inside the folder');
});

test('L22 D2b: Add File on a path that already exists says it replaces the content (still approvable)', t => {
  fs.writeFileSync(abs('existe.txt'), 'viejo\n');
  t.after(() => fs.rmSync(abs('existe.txt'), { force: true }));
  assert.deepEqual(card(['*** Add File: existe.txt', '+nuevo']),
    { filePreview: true, text: `apply_patch: ${q(abs('existe.txt'))}; reemplazar el contenido por: ${q('nuevo')}`, lossy: false });
  assert.match(card(['*** Add File: no-existe.txt', '+x']).text, /; añadir: /, 'a new file keeps «añadir»');
});

test('Update shows each hunk old → new (changed span), its anchor and end-of-file placement', () => {
  const pre = `apply_patch: ${q(abs('uno.txt'))}; modificar: `;
  assert.deepEqual(card(['*** Update File: uno.txt', '@@', ' a', '-b', '+c', ' d']),
    { filePreview: true, text: pre + `${q('b')} → ${q('c')}`, lossy: false });
  // the first hunk may omit «@@»; context lines BETWEEN changes are part of what is shown
  assert.equal(card(['*** Update File: uno.txt', '-b', ' c', '+d']).text, pre + `${q('b\nc')} → ${q('c\nd')}`);
  assert.equal(card(['*** Update File: uno.txt', '@@ def f():', '-b', '+c']).text, pre + `en ${q('def f():')}: ${q('b')} → ${q('c')}`);
  assert.equal(card(['*** Update File: uno.txt', '@@', '-z', '+y', '*** End of File']).text, pre + `${q('z')} → ${q('y')} (al final del archivo)`);
  assert.equal(card(['*** Update File: uno.txt', '@@', '-a', '+b', '@@', '-c', '+d']).text,
    pre + `1. ${q('a')} → ${q('b')}; 2. ${q('c')} → ${q('d')}`);
  assert.equal(card(['*** Update File: uno.txt', '@@', '-a', '@@', '-c', '+d', '@@ x', '-e']).lossy, false, 'three hunks fit');
});

test('a hunk without «-» lines shows its context so the human sees where it lands; with no context it is lossy', () => {
  const r = card(['*** Update File: uno.txt', '@@', ' a', '+x', ' b']);
  assert.deepEqual(r, { filePreview: true, text: `apply_patch: ${q(abs('uno.txt'))}; modificar: ${q('a\nb')} → ${q('a\nx\nb')}`, lossy: false });
  const blind = card(['*** Update File: uno.txt', '@@', '+x']);
  assert.equal(blind.lossy, true);
  assert.equal(blind.text, `apply_patch: ${q(abs('uno.txt'))}`);
  assert.equal(blind.reason, 'ubicación del cambio no visible');
  assert.equal(card(['*** Update File: uno.txt', '@@ class A', '+x']).lossy, true, 'an anchor alone does not say where');
  const long = card(['*** Update File: uno.txt', '@@', ...Array(8).fill(' ctx'), '+x']);
  assert.equal(long.lossy, true, 'context that cannot be shown in full is lossy');
  assert.match(long.reason, /recortado/);
});

test('Delete (2a) is approvable when the path passes R9: «borrar» clearly shown', () => {
  assert.deepEqual(card(['*** Delete File: uno.txt']), { filePreview: true, text: `apply_patch: borrar ${q(abs('uno.txt'))}`, lossy: false });
  const r = card(['*** Delete File: .git/config']);
  assert.equal(r.lossy, true); assert.equal(r.text, `apply_patch: borrar ${q(abs('.git', 'config'))}`);
  assert.equal(r.reason, 'ruta sensible o redirigida');
});

test('Move (2a) shows «mover a → b» and its hunks; approvable only if both paths pass R9 and the hunks are shown in full', () => {
  const mv = `apply_patch: mover ${q(abs('uno.txt'))} → ${q(abs('dos.txt'))}`;
  assert.deepEqual(card(['*** Update File: uno.txt', '*** Move to: dos.txt', '@@', '-a', '+b']),
    { filePreview: true, text: `${mv}; modificar: ${q('a')} → ${q('b')}`, lossy: false });
  assert.deepEqual(card(['*** Update File: uno.txt', '*** Move to: dos.txt']), { filePreview: true, text: mv, lossy: false }, 'a pure rename');
  for (const [to, reason] of [['.git/x', 'ruta sensible o redirigida'], ['.codex/config.toml', 'ruta sensible o redirigida'], ['../fuera.txt', 'fuera de la carpeta de sesión']]) {
    const r = card(['*** Update File: uno.txt', '*** Move to: ' + to, '@@', '-a', '+b']);
    assert.equal(r.lossy, true, to); assert.equal(r.reason, reason, to);
    assert.equal(r.text, `apply_patch: mover ${q(abs('uno.txt'))} → ${q(path.resolve(dir, to))}`, 'both paths shown, the change is not');
  }
  const src = card(['*** Update File: .ssh/k', '*** Move to: dos.txt']);
  assert.equal(src.lossy, true); assert.equal(src.reason, 'ruta sensible o redirigida');
  assert.equal(card(['*** Update File: uno.txt', '*** Move to: dos.txt', '@@', '-a', '@@', '-b', '@@', '-c', '@@', '-d']).lossy, true);
});

test('several files (1a) are never approvable: the card lists up to 3 paths, reason «varios archivos»', () => {
  const two = card(['*** Add File: uno.txt', '+a', '*** Delete File: dos.txt']);
  assert.deepEqual(two, { filePreview: true, text: `apply_patch: varios archivos: ${q(abs('uno.txt'))}, ${q(abs('dos.txt'))}`, lossy: true, reason: 'varios archivos' });
  const five = card(['a', 'b', 'c', 'd', 'e'].flatMap(f => [`*** Add File: ${f}.txt`, '+x']));
  assert.equal(five.text, `apply_patch: varios archivos: ${['a', 'b', 'c'].map(f => q(abs(f + '.txt'))).join(', ')} y 2 más`);
  assert.equal(five.lossy, true);
  const mv = card(['*** Update File: uno.txt', '*** Move to: dos.txt', '*** Delete File: tres.txt']);
  assert.equal(mv.text, `apply_patch: varios archivos: ${q(abs('uno.txt'))} → ${q(abs('dos.txt'))}, ${q(abs('tres.txt'))}`);
  const hidden = card(['*** Add File: uno.txt', '+a', '*** Add File: x\u202e.txt', '+b']);
  assert.equal(hidden.lossy, true);
  assert.doesNotMatch(hidden.text, /\u202e|x.\.txt/u, 'a path that cannot be shown is never listed');
});

test('outside the session folder (3a): the path is shown, the change is not, no «Aprobar»', () => {
  for (const file of ['../fuera.txt', 'a/../../fuera.txt', path.join(path.dirname(dir), 'otro', 'x.txt')]) {
    const r = card(['*** Add File: ' + file, '+NOTSHOWN']);
    assert.deepEqual(r, { filePreview: true, text: `apply_patch: ${q(path.resolve(dir, file))}`, lossy: true, reason: 'fuera de la carpeta de sesión' }, file);
  }
  assert.equal(card(['*** Add File: a/../uno.txt', '+x']).lossy, false, 'a traversal that stays inside normalizes and is approvable');
});

test('sensitive and redirected paths are shown but lossy', () => {
  for (const file of ['.ssh/id_rsa', '.git/config', '.codex/config.toml', '.claude/settings.json', '.env']) {
    const r = card(['*** Update File: ' + file, '@@', '-a', '+b']);
    assert.equal(r.lossy, true, file); assert.doesNotMatch(r.text, /modificar/, file);
  }
  for (const file of ['/etc/passwd']) assert.equal(card(['*** Delete File: ' + file]).lossy, true, file);
});

test('a symlinked path is not verifiable: lossy', { skip: win && 'symlinks need privileges on Windows' }, () => {
  fs.mkdirSync(abs('real'), { recursive: true });
  fs.symlinkSync(abs('real'), abs('enlace'));
  const r = card(['*** Add File: enlace/x.txt', '+hola']);
  assert.equal(r.lossy, true); assert.equal(r.reason, 'ruta no verificable');
  assert.equal(r.text, `apply_patch: ${q(abs('enlace', 'x.txt'))}`);
  assert.equal(card(['*** Update File: uno.txt', '*** Move to: enlace/y.txt']).lossy, true, 'a Move into a symlink');
});

test('secrets anywhere in the body (+, -, context, @@ anchor) are scanned before any trimming: [REDACTED], no «Aprobar»', () => {
  const pre = `apply_patch: ${q(abs('uno.txt'))}`;
  for (const body of [['*** Add File: uno.txt', '+API_KEY=super-private'],
    ['*** Update File: uno.txt', '@@', ' ctx', '-API_KEY=super-private', '+API_KEY=x'],
    ['*** Update File: uno.txt', '@@', ' token = "super-private"', ' a', ' b', '-c', '+d'],
    ['*** Update File: uno.txt', '@@ password: super-private', '-a', '+b'],
    ['*** Update File: uno.txt', '@@', ...Array(12).fill(' ok'), ' -----BEGIN PRIVATE KEY-----', '-a', '+b']]) {
    const r = card(body);
    assert.deepEqual(r, { filePreview: true, text: `${pre}; contenido: [REDACTED] (secretos ocultos)`, lossy: true, reason: 'contenido oculto' }, body.join('|'));
  }
});

test('caps: more than 3 hunks, 8 lines, 160 bytes or 4096 bytes are «recortado» and never approvable', () => {
  const four = card(['*** Update File: uno.txt', '@@', '-a', '@@', '-b', '@@', '-c', '@@', '-d']);
  assert.equal(four.lossy, true); assert.equal(four.reason, 'cambios recortados (máximo 3)');
  const lines = card(['*** Add File: uno.txt', ...Array(9).fill('+l')]);
  assert.equal(lines.lossy, true); assert.match(lines.reason, /recortado/); assert.match(lines.text, /añadir: "l\\nl/);
  const bytes = card(['*** Add File: uno.txt', '+' + 'hola '.repeat(40)]);
  assert.equal(bytes.lossy, true); assert.match(bytes.reason, /recortado/); assert.match(bytes.text, /añadir: "hola /);
  const huge = card(['*** Add File: uno.txt', ...Array(900).fill('+abcd')]);
  assert.deepEqual(huge, { ...BASE, reason: 'parche recortado (máximo 4096 bytes); vista previa omitida' });
});

test('CR, NUL, bidi, zero-width and control characters anywhere: lossy and nothing of the path shown', () => {
  for (const bad of ['\r', '\0', '\u202e', '\u200b', '\x1b[31m', '\u2028']) {
    for (const body of [['*** Add File: uno' + bad + '.txt', '+a'], ['*** Add File: uno.txt', '+a' + bad]]) {
      assert.deepEqual(card(body), { ...BASE, reason: 'contenido no seguro o binario; vista previa omitida' }, JSON.stringify(body));
    }
  }
  assert.deepEqual(card(P('*** Add File: uno.txt', '+a').replace(/\n/g, '\r\n')).text, 'apply_patch', 'CRLF patches are not representable');
});

test('anything outside the strict grammar is «solicitud no representable», nothing shown', () => {
  const malformed = [
    '', '*** Begin Patch', P(), '*** Add File: uno.txt\n+a', '*** Begin Patch\n*** Add File: uno.txt\n+a',
    'x\n' + P('*** Add File: uno.txt', '+a'), P('*** Add File: uno.txt', '+a') + '\nx', P('*** Add File: uno.txt', '+a') + '\n\n',
    P('*** Copy File: uno.txt', '+a'), P('*** Add File: uno.txt', '-a'), P('*** Add File: uno.txt', ' a'), P('*** Add File: uno.txt'),
    P('*** Add File: uno.txt', '+a', '*** Delete File: uno.txt'), P('*** Add File: uno.txt', '+a', '*** Add File: ./uno.txt', '+b'),
    P('*** Move to: dos.txt'), P('*** Add File: uno.txt', '*** Move to: dos.txt', '+a'), P('*** Delete File: uno.txt', '*** Move to: dos.txt'),
    P('*** Update File: uno.txt', '*** Move to: dos.txt', '*** Move to: tres.txt'), P('*** Update File: uno.txt', '*** Move to: uno.txt'),
    P('*** Update File: uno.txt'), P('*** Update File: uno.txt', '@@'), P('*** Update File: uno.txt', '@@', '@@', '-a'),
    P('*** Update File: uno.txt', '@@', ' a'), P('*** Update File: uno.txt', '@@', '-a', ''), P('*** Update File: uno.txt', '@@x', '-a'),
    P('*** Update File: uno.txt', '-a', '*** End of File', '-b'), P('*** Update File: uno.txt', '*** End of File'),
    P('*** Delete File: uno.txt', '-a'), P('*** Add File: ', '+a'), P('*** Add File:  uno.txt', '+a'), P('*** Add File: uno.txt ', '+a'),
    P('*** Begin Patch', '*** Add File: uno.txt', '+a'), P('*** Add File: uno.txt', '+a', '*** End Patch'),
  ];
  for (const command of malformed) assert.deepEqual(card(command), BASE, JSON.stringify(command));
  assert.equal(card(P('*** Add File: uno.txt', '+a') + '\n').lossy, false, 'one trailing newline after End Patch is fine');
  for (const input of [null, 'x', [], {}, { command: 1 }, { command: P('*** Add File: uno.txt', '+a'), description: 'x' }, { patch: 'x' }]) {
    assert.deepEqual(describePatchPermission(input, dir), BASE, JSON.stringify(input));
  }
});

test('codexToolDescription takes the request cwd and returns the patch card', () => {
  assert.deepEqual(codexToolDescription('apply_patch', { command: P('*** Delete File: uno.txt') }, dir),
    { filePreview: true, text: `apply_patch: borrar ${q(abs('uno.txt'))}`, lossy: false });
});

// Through the Codex hook's public interface: stdin JSON → the island question → stdout.
const APPROVE = ['allow', 'deny'], LOSSY = ['deny', 'terminal'];
async function hook(t, command, value, cwd = dir) {
  const rcv = await fakeReceiver(t, { questions: true });
  const answered = rcv.next('question').then(qq => rcv.send({ v: 1, type: 'answer', questionVersion: 1, project: qq.project,
    sessionId: qq.sessionId, at: Date.now(), id: qq.id, source: 'human', answer: { type: 'option', value } }));
  const r = await handleCodexHook({ event: 'permission-request', argv: [], env: { KODA_DESKTOP_SOCKET: rcv.endpoint, KODA_SOCKET_DIR: rcv.runtime },
    input: JSON.stringify({ session_id: 's', cwd, hook_event_name: 'PermissionRequest', turn_id: 't', tool_name: 'apply_patch', tool_input: { command } }) });
  await answered;
  return { r, q: rcv.frames.find(f => f.type === 'question'), wire: rcv.rawFrames.join('') };
}

test('hook: a single Add / Update / Delete / Move card shown in full is approvable; «Aprobar una vez» prints the allow line', async t => {
  const cases = [
    [P('*** Add File: uno.txt', '+hola'), `apply_patch: ${q(abs('uno.txt'))}; añadir: ${q('hola')}`],
    [P('*** Update File: uno.txt', '@@', '-a', '+b'), `apply_patch: ${q(abs('uno.txt'))}; modificar: ${q('a')} → ${q('b')}`],
    [P('*** Delete File: uno.txt'), `apply_patch: borrar ${q(abs('uno.txt'))}`],
    [P('*** Update File: uno.txt', '*** Move to: dos.txt'), `apply_patch: mover ${q(abs('uno.txt'))} → ${q(abs('dos.txt'))}`],
  ];
  for (const [command, text] of cases) {
    const { r, q: card } = await hook(t, command, 'allow');
    assert.equal(card.text, `Codex pide permiso para ${text}`);
    assert.deepEqual(card.options.map(o => o.value), APPROVE);
    assert.equal(r.stdout, ALLOW); assert.equal(r.exitCode, 0); assert.equal(r.stderr, '');
    const d = await hook(t, command, 'deny');
    assert.equal(d.r.stdout, DENY);
  }
});

test('hook: a forged allow on any lossy card prints nothing; deny still denies; hidden content never travels', async t => {
  const lossyPatches = [
    P('*** Add File: uno.txt', '+a', '*** Add File: dos.txt', '+b'),
    P('*** Add File: ../fuera.txt', '+NOTSHOWN'),
    P('*** Update File: .git/config', '@@', '-NOTSHOWN', '+b'),
    P('*** Update File: uno.txt', '@@', ' NOTSHOWN_TOKEN=abc', '-a', '+b'),
    P('*** Add File: uno.txt', ...Array(9).fill('+l')),
    P('*** Add File: uno.txt', '+a\u202eNOTSHOWN'),
    P('*** Add File: uno.txt', '-NOTSHOWN'),
    '*** Add File: uno.txt\n+NOTSHOWN',
  ];
  for (const command of lossyPatches) {
    for (const value of ['allow', 'terminal', 'deny']) {
      const { r, q: card, wire } = await hook(t, command, value);
      assert.deepEqual(card.options.map(o => o.value), LOSSY, command);
      assert.match(card.text, /^Codex pide permiso para apply_patch.*detalles solo en la terminal; decidir en la terminal\)$/, command);
      assert.equal(r.stdout, value === 'deny' ? DENY : '', command);
      assert.doesNotMatch(wire, /NOTSHOWN|\u202e/, command);
    }
  }
});

test('L27 R1-001: Move onto a destination that already exists says it replaces it (still approvable); a new destination is unchanged', t => {
  fs.writeFileSync(abs('ocupado.txt'), 'viejo\n');
  t.after(() => fs.rmSync(abs('ocupado.txt'), { force: true }));
  const mv = `apply_patch: mover ${q(abs('uno.txt'))} → ${q(abs('ocupado.txt'))} (reemplaza el archivo que ya existe)`;
  assert.deepEqual(card(['*** Update File: uno.txt', '*** Move to: ocupado.txt']), { filePreview: true, text: mv, lossy: false }, 'a pure rename');
  assert.deepEqual(card(['*** Update File: uno.txt', '*** Move to: ocupado.txt', '@@', '-a', '+b']),
    { filePreview: true, text: `${mv}; modificar: ${q('a')} → ${q('b')}`, lossy: false }, 'a rename with a hunk');
  assert.deepEqual(card(['*** Update File: uno.txt', '*** Move to: libre.txt']),
    { filePreview: true, text: `apply_patch: mover ${q(abs('uno.txt'))} → ${q(abs('libre.txt'))}`, lossy: false }, 'a missing destination keeps «mover a → b»');
});

test('L27 R3-002: cards that are never approvable stay inside the card bound even with long paths', () => {
  const long = n => `mi carpeta "${n}"/`.repeat(9) + 'nota.txt'; // 152 bytes: under the 160-byte path cap, JSON quoting grows it
  const several = card(['*** Add File: ' + long('a'), '+a', '*** Add File: ' + long('b'), '+b', '*** Update File: ' + long('c'), '*** Move to: ' + long('d'), '@@', '-x', '+y']);
  assert.equal(several.lossy, true); assert.equal(several.reason, 'varios archivos');
  assert.ok([...several.text].length <= 390 && Buffer.byteLength(several.text) <= 1200, several.text);
  assert.match(several.text, /^apply_patch: varios archivos/); assert.doesNotMatch(several.text, /ruta oculta/, 'the paths are readable, only long');
  const out = card(['*** Update File: ' + long('e'), '*** Move to: ../' + long('f'), '@@', '-a', '+b']);
  assert.equal(out.lossy, true); assert.equal(out.reason, 'fuera de la carpeta de sesión');
  assert.ok([...out.text].length <= 390 && Buffer.byteLength(out.text) <= 1200, out.text);
});

test('a secret-looking or over-long path stays hidden like Claude\'s (nothing of it shown), also inside a several-files list', () => {
  const tok = 'SECRETDIRabcdefghijklmnopqrstuvwxyzABCDEFGH0123456789/a.txt';
  assert.deepEqual(card(['*** Add File: ' + tok, '+x']), { ...BASE, reason: 'ruta no segura (secretos ocultos)' });
  assert.deepEqual(card(['*** Add File: ' + 'x'.repeat(200), '+x']), { ...BASE, reason: 'ruta recortada' });
  assert.deepEqual(card(['*** Update File: uno.txt', '*** Move to: ' + tok]), { ...BASE, reason: 'ruta no segura (secretos ocultos)' }, 'a hidden Move destination hides the card');
  const many = card(['*** Add File: uno.txt', '+a', '*** Add File: ' + tok, '+b']);
  assert.equal(many.text, `apply_patch: varios archivos: ${q(abs('uno.txt'))}, [ruta oculta]`);
  assert.doesNotMatch(many.text, /SECRETDIR/);
});
