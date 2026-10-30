'use strict';
/* #327 — pure checks for frontend/specialists-view.js (the specialists section's view-model).
   No DOM, no IPC, no network, no colour. Contracts:
   - id is opaque, lowercase ASCII, ^[a-z0-9][a-z0-9._-]{0,31}$ and never one of the reserved
     identities (the principal `abito`, the engine CLIs), so a rename can never move it;
   - the identity shape is the one the avatar panel (#384) consumes by the SAME id: this module
     carries NO colour logic at all (avatar_colors owns assignment and overrides);
   - name 1..40 and instructions 1..2000, multiline allowed, dangerous control characters not;
   - invalid input never mutates and is never rendered as a trusted row.
   Run: node apps/desktop-tauri/test-node/specialists-view-check.cjs (also under cargo test). */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const frontend = path.join(__dirname, '..', 'frontend');
const S = require(path.join(frontend, 'specialists-view.js'));
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

// ---- identity: opaque, stable, format-compatible with avatar-colors (#384) -------------------------
test('an id is opaque lowercase ASCII, never derived from the visible name, and compatible with the avatar contract', () => {
  const id = S.newId(Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]));
  assert.equal(id, 'esp-0011223344556677');
  assert.match(id, S.ID_RE);
  assert.ok(S.validId(id));
  // the same bytes always give the same id (no name, no clock, no counter in it)
  assert.equal(S.newId(Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])), id);
  const other = S.newId(Uint8Array.from([0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89]));
  assert.notEqual(other, id);
  assert.match(other, S.ID_RE);
  assert.equal(id.length <= 32, true, 'the avatar contract caps the id at 32 characters');
});

test('the reserved identities of the avatar contract are refused: the principal and the engine CLIs', () => {
  // Koda 0.1 T2: the principal is now named «Koda» on screen, so `koda` is reserved too (`abito` stays: the internal identity).
  for (const bad of ['abito', 'koda', 'pi', 'claude-code', 'codex', 'opencode', '__proto__', 'prototype', 'constructor']) {
    assert.equal(S.validId(bad), false, `${bad} must never be a specialist id`);
  }
  for (const bad of ['', 'A', 'Esp-x', 'esp x', '-esp', '.esp', '_esp', 'esp.'.repeat(9), 42, null, undefined, {}, 'esp-0011223344556677 '.repeat(1) + 'x'.repeat(20)]) {
    assert.equal(S.validId(bad), false, `${JSON.stringify(bad)} must not be a valid id`);
  }
  assert.equal(S.validId('esp-0011223344556677'), true);
  assert.equal(S.validId('a'), true, 'one character is allowed by the contract');
  assert.equal(S.validId('a'.repeat(32)), true);
  assert.equal(S.validId('a'.repeat(33)), false, '33 characters break the avatar contract');
});

test('this module carries no colour logic: avatar_colors (#384) owns assignment and overrides', () => {
  for (const forbidden of ['COLORS', 'colorFor', 'defaultColor', 'colorOf', 'avatarColor', 'defaultsFor']) {
    assert.equal(S[forbidden], undefined, `${forbidden} must live in #384, not here`);
  }
  assert.equal(/green|mint|orange|purple|fnv/i.test(require('node:fs').readFileSync(path.join(frontend, 'specialists-view.js'), 'utf8')), false,
    'no colour name and no colour algorithm may appear in this module');
});

// ---- the create/edit draft ----------------------------------------------------------------------
const model = 'local-abito-gpt';
const draft = extra => Object.assign({ name: 'Investigador', instructions: 'Buscá fuentes y citá.', model }, extra);

// ---- #375: declarative Space name and closed, read-only-by-default permission set ------------------
test('#375: the permission vocabulary is closed and read-only is the default', () => {
  assert.deepEqual(S.PERMISSIONS, ['read', 'write', 'network', 'execute']);
  assert.deepEqual(S.READ_ONLY, ['read']);
  assert.equal(Object.isFrozen(S.PERMISSIONS), true, 'the closed set must not be extendable');
  assert.equal(Object.isFrozen(S.READ_ONLY), true);
});

test('#375: a Space name is optional bounded plain text, like the display name', () => {
  assert.equal(S.validateDraft(draft({ space: 'Investigación' }), [model]).ok, true);
  assert.equal(S.validateDraft(draft({ space: null }), [model]).ok, true, 'absent = the old behaviour');
  assert.equal(S.validateDraft(draft({ space: '' }), [model]).ok, true, 'empty clears the Space');
  assert.equal(S.validateDraft(draft({ space: '   ' }), [model]).ok, true, 'whitespace-only clears the Space');
  assert.equal(S.validateDraft(draft({ space: 'x'.repeat(S.MAX_SPACE) }), [model]).ok, true);
  const over = S.validateDraft(draft({ space: 'x'.repeat(S.MAX_SPACE + 1) }), [model]);
  assert.equal(over.ok, false);
  assert.equal(over.field, 'space');
  for (const bad of [7, 'nulo\u0000', 'salto\n', 'tab\t', 'del\u007f', 'escape\u001b']) {
    assert.equal(S.validateDraft(draft({ space: bad }), [model]).ok, false, JSON.stringify(bad));
  }
});

test('#375: permissions accept only the closed vocabulary, without duplicates', () => {
  assert.equal(S.validateDraft(draft({ permissions: ['read'] }), [model]).ok, true);
  assert.equal(S.validateDraft(draft({ permissions: ['network', 'read'] }), [model]).ok, true);
  assert.equal(S.validateDraft(draft({ permissions: [] }), [model]).ok, true, 'empty = the read-only default');
  const bad = S.validateDraft(draft({ permissions: 'read' }), [model]);
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'permissions');
  for (const bad of [['root'], ['read', 'read'], ['read', 7], [null], ['READ']]) {
    assert.equal(S.validateDraft(draft({ permissions: bad }), [model]).ok, false, JSON.stringify(bad));
  }
});

test('#375: stored records sanitize: hostile Space is dropped, hostile permissions degrade to read-only, absent keeps the old shape', () => {
  const v = S.storeView({ v: 1, active: null, persisted: true, specialists: [
    { id: 'esp-0011223344556677', name: 'Viejo', instructions: 'x', model: null },
    { id: 'esp-8899aabbccddeeff', name: 'Hostil', instructions: 'x', model: null, space: 'x\u0000', permissions: ['read', 'root'] },
    { id: 'esp-ffeeddccbbaa9988', name: 'Rico', instructions: 'x', model: null, space: '  Mi espacio  ', permissions: ['execute', 'network', 'execute'] },
  ] }, null);
  assert.deepEqual(v.rows.map(r => r.space), [null, null, 'Mi espacio'], 'a hostile stored Space value is dropped, never shown as data');
  assert.deepEqual(v.rows.map(r => r.permissions), [['read'], ['read'], ['network', 'execute']], 'every hostile, empty or absent set degrades to read-only; stored duplicates collapse');
  assert.deepEqual(v.rows.map(r => r.permissionWords), [['Lectura'], ['Lectura'], ['Red', 'Ejecución']]);
});

test('#375: the form carries space and permissions like every other field', () => {
  const f = S.makeForm();
  f.openNew();
  assert.equal(f.state.draft.space, '');
  assert.deepEqual(f.state.draft.permissions, ['read'], 'a new specialist starts read-only');
  f.input('space', 'Investigación');
  f.input('permissions', ['network', 'read']);
  f.input('name', 'Investigador');
  f.input('instructions', 'Buscá.');
  const sent = f.submit([model]);
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.draft, { name: 'Investigador', instructions: 'Buscá.', model: null, space: 'Investigación', permissions: ['read', 'network'] }, 'canonical order wins over input order');
  f.settle(true, '');
  f.openEdit({ id: 'esp-0011223344556677', name: 'Editor', instructions: 'x', model: null, space: 'Mi espacio', permissions: ['read', 'write'] });
  assert.equal(f.state.draft.space, 'Mi espacio');
  assert.deepEqual(f.state.draft.permissions, ['read', 'write']);
  f.input('space', '  ');
  assert.equal(f.submit([model]).draft.space, null, 'whitespace-only clears the Space name');
  f.settle(false, 'x');
  f.input('space', 'x\u0000');
  assert.equal(f.submit([model]).ok, false, 'a hostile draft is never sent');
});

test('a valid draft passes; name and instructions are required, trimmed and bounded', () => {
  assert.deepEqual(S.validateDraft(draft(), [model]), { ok: true, word: '' });
  assert.equal(S.validateDraft(draft({ name: '   ' }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ name: 'x'.repeat(S.MAX_NAME + 1) }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ name: '  ' + 'x'.repeat(S.MAX_NAME) + '  ' }), [model]).ok, true, 'the limit is on the trimmed name');
  assert.equal(S.validateDraft(draft({ instructions: '' }), [model]).ok, false, 'a specialist without a specialty is nothing');
  assert.equal(S.validateDraft(draft({ instructions: '   ' }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ instructions: 'x'.repeat(S.MAX_INSTRUCTIONS + 1) }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ instructions: 'x'.repeat(S.MAX_INSTRUCTIONS) }), [model]).ok, true);
  assert.equal(S.validateDraft(draft({ name: 42 }), [model]).ok, false);
  assert.equal(S.validateDraft(draft({ instructions: null }), [model]).ok, false);
  assert.deepEqual(S.validateDraft(null, [model]).ok, false);
  const bad = S.validateDraft(draft({ name: '' }), [model]);
  assert.equal(bad.field, 'name', 'the failing field is named so the page can point at it');
  assert.ok(bad.word.length > 0);
});

test('multiline instructions are fine; dangerous control characters are not', () => {
  assert.equal(S.validateDraft(draft({ instructions: 'Primero leé.\nDespués resumí.\n\tCon sangría.' }), [model]).ok, true);
  for (const bad of ['nulo\u0000', 'campana\u0007', 'escape\u001b', 'vertical\u000b', 'del\u007f', 'c1\u009f', 'cr\u000d']) {
    assert.equal(S.validateDraft(draft({ instructions: bad }), [model]).ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(S.validateDraft(draft({ name: bad }), [model]).ok, false, `${JSON.stringify(bad)} must be refused in the name too`);
  }
});

test('the model must be null (the picker decides) or one of the verified local profiles', () => {
  assert.equal(S.validateDraft(draft({ model: null }), [model]).ok, true);
  assert.equal(S.validateDraft(draft({ model: '' }), [model]).ok, true, 'empty = the same as null');
  assert.equal(S.validateDraft(draft({ model: 'nube-gpt' }), [model]).ok, false, 'no invented model');
  assert.equal(S.validateDraft(draft({ model: 'nube-gpt' }), [model]).field, 'model');
  assert.equal(S.validateDraft(draft({ model: 7 }), [model]).ok, false);
});

// ---- the section view ---------------------------------------------------------------------------
const state = extra => Object.assign({
  v: 1, active: null, persisted: true,
  specialists: [
    { id: 'esp-0011223344556677', name: 'Investigador', instructions: 'Buscá fuentes y citá.', model: 'local-abito-gpt' },
    { id: 'esp-8899aabbccddeeff', name: 'Editor', instructions: 'Corregí sin cambiar el sentido.', model: null },
  ],
}, extra || {});
const listing = {
  selected: 'local-abito-gpt',
  profiles: [
    { profile_id: 'local-abito-gpt', alias: 'Abito-gpt', selectable: true, gate: { state: 'ready' } },
    { profile_id: null, alias: 'otro-alias', selectable: false, gate: { state: 'unavailable' } },
  ],
};

test('no state yet is a wait, never an empty store', () => {
  assert.equal(S.storeView(null, listing).kind, 'loading');
  assert.equal(S.storeView(undefined, listing).kind, 'loading');
  assert.equal(S.storeView(null, listing).rows.length, 0);
});

test('with no active specialist the section says the principal is in charge', () => {
  const v = S.storeView(state(), listing);
  assert.equal(v.kind, 'ready');
  assert.equal(v.active, null);
  assert.equal(v.principal, true);
  assert.equal(v.countWord, '2 especialistas');
  assert.deepEqual(v.rows.map(r => r.name), ['Investigador', 'Editor']);
  assert.deepEqual(v.rows.map(r => r.active), [false, false]);
  assert.equal(S.roleChip(state()), null, 'the principal shows no role chip');
  assert.match(S.storeView(state(), listing).principalNote, /Koda/i); // Koda 0.1 T2
});

test('the active specialist is marked, named by its id, and shown in the chat chip', () => {
  const v = S.storeView(state({ active: 'esp-8899aabbccddeeff' }), listing);
  assert.equal(v.active.id, 'esp-8899aabbccddeeff');
  assert.deepEqual(v.rows.map(r => r.active), [false, true]);
  assert.equal(v.principal, false);
  const chip = S.roleChip(state({ active: 'esp-8899aabbccddeeff' }));
  assert.equal(chip.word, 'Editor');
  assert.match(chip.aria, /Editor/);
  assert.equal(S.roleChip({ v: 1, active: 'esp-0000000000000000', specialists: [] }), null, 'an active id with no record is no role');
});

test('each row says which model it uses, and an unverified model is never called ready', () => {
  const v = S.storeView(state(), listing);
  assert.equal(v.rows[0].modelLabel, 'Abito-gpt');
  assert.equal(v.rows[1].modelLabel, 'El modelo elegido en «Modelo»', 'a null model follows the picker');
  const gone = S.storeView(state({ specialists: [{ id: 'esp-0011223344556677', name: 'Viejo', instructions: 'x', model: 'ya-no-existe' }] }), listing);
  assert.match(gone.rows[0].modelLabel, /no está|no disponible/i);
  assert.equal(gone.rows[0].modelReady, false);
});

test('invalid records are dropped from the view and never shown as a trusted row', () => {
  const dirty = state({ active: 'abito', specialists: [
    { id: 'abito', name: 'Principal falso', instructions: 'x', model: null },
    { id: 'ESP-MAYUS', name: 'Mayúsculas', instructions: 'x', model: null },
    { id: 'esp-0011223344556677', name: '  ', instructions: 'x', model: null },
    { id: 'esp-8899aabbccddeeff', name: 'Editor', instructions: 'x'.repeat(5000), model: null },
    { id: 'esp-ffeeddccbbaa9988', name: 'Válido', instructions: 'ok', model: null },
    { id: 'esp-ffeeddccbbaa9988', name: 'Duplicado', instructions: 'ok', model: null },
  ] });
  const v = S.storeView(dirty, listing);
  assert.deepEqual(v.rows.map(r => r.name), ['Válido'], 'duplicates and invalid records are filtered');
  assert.equal(v.active, null, 'a reserved or unknown active id is not a role');
  assert.equal(v.countWord, '1 especialista');
});

test('the real local-model limitation is stated, never hidden, and no model is invented', () => {
  const opts = S.modelOptions(listing, 'local-abito-gpt');
  assert.deepEqual(opts.map(o => o.id), [null, 'local-abito-gpt'], 'only the verified selectable profile, plus «the picker decides»');
  assert.equal(opts[1].label, 'Abito-gpt');
  assert.equal(opts[1].selected, true);
  assert.equal(opts[0].selected, false);
  const one = S.modelOptions(listing, null);
  assert.equal(one[0].selected, true);
  assert.match(S.catalogNote(listing), /un solo modelo/i);
  const none = S.catalogNote({ selected: null, profiles: [{ profile_id: null, alias: 'x', selectable: false }] });
  assert.match(none, /ningún modelo/i);
  assert.match(S.catalogNote(listing), /local/i, 'the note says the models are local');
});

test('the count word is singular, plural and honest about zero', () => {
  assert.equal(S.storeView(state({ specialists: [] }), listing).countWord, 'Sin especialistas');
  assert.equal(S.storeView(state({ specialists: [state().specialists[0]] }), listing).countWord, '1 especialista');
  assert.equal(S.storeView(state(), listing).countWord, '2 especialistas');
});

test('a store saved in memory only says so: the panel never claims persistence it does not have', () => {
  assert.equal(S.storeView(state({ persisted: false }), listing).persistenceNote.length > 0, true);
  assert.match(S.storeView(state({ persisted: false }), listing).persistenceNote, /no se guard/i);
  assert.equal(S.storeView(state({ persisted: true }), listing).persistenceNote, '');
});


// ---- the create/edit form state machine (#327 frontend fix) ----------------------------------------
test('Crear starts disabled and is revalidated on EVERY input, without waiting for a re-render', () => {
  const f = S.makeForm();
  f.openNew();
  assert.equal(f.status([model]).canSave, false, 'an empty form cannot be saved');
  f.input('name', 'Investigador');
  assert.equal(f.status([model]).canSave, false, 'a name alone is not a specialist');
  f.input('instructions', 'Buscá fuentes y citá.');
  assert.equal(f.status([model]).canSave, true, 'typing the specialty enables Crear at once');
  f.input('name', '   ');
  const s = f.status([model]);
  assert.equal(s.canSave, false);
  assert.equal(s.field, 'name', 'the failing field is named');
  assert.ok(s.word.length > 0);
});

test('a problem is only shown once the human has typed something (no scolding an empty form)', () => {
  const f = S.makeForm();
  f.openNew();
  assert.equal(f.status([model]).showProblem, false);
  f.input('name', 'x');
  assert.equal(f.status([model]).showProblem, true);
});

test('saving keeps the form and the draft until the backend CONFIRMS; a failure keeps the edit', () => {
  const f = S.makeForm();
  f.openNew();
  f.input('name', 'Investigador');
  f.input('instructions', 'Buscá fuentes\ny citá.');
  const sent = f.submit([model]);
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.draft, { name: 'Investigador', instructions: 'Buscá fuentes\ny citá.', model: null, space: null, permissions: ['read'] }, 'absent #375 fields travel as null space and the read-only default');
  assert.equal(f.state.open, true, 'the form does not close when the click is sent');
  assert.equal(f.state.pending, true);
  assert.equal(f.submit([model]).ok, false, 'a second click while pending sends nothing');
  f.settle(false, 'No se pudo guardar el especialista; no se cambió nada.');
  assert.equal(f.state.open, true, 'a failed save leaves the form open');
  assert.equal(f.state.pending, false, 'and lets the human retry');
  assert.equal(f.state.draft.name, 'Investigador', 'the name survives the failure');
  assert.equal(f.state.draft.instructions, 'Buscá fuentes\ny citá.', 'the specialty survives the failure');
  assert.match(f.state.error, /no se cambió nada/);
  assert.equal(f.status([model]).canSave, true, 'retry is possible');
  f.submit([model]);
  f.settle(true, '');
  assert.equal(f.state.open, false, 'only a confirmed save closes the form');
  assert.equal(f.state.draft.name, '', 'and only then is the draft cleared');
  assert.equal(f.state.error, '');
});

test('editing carries the id; cancel discards; an invalid draft is never sent', () => {
  const f = S.makeForm();
  f.openEdit({ id: 'esp-0011223344556677', name: 'Editor', instructions: 'Corregí.', model: null });
  assert.equal(f.state.editing, 'esp-0011223344556677');
  assert.equal(f.submit([model]).editing, 'esp-0011223344556677', 'an edit never mints a new id');
  f.settle(false, 'x');
  f.input('instructions', '');
  assert.equal(f.submit([model]).ok, false, 'an invalid draft is not sent');
  assert.equal(f.state.pending, false);
  f.cancel();
  assert.equal(f.state.open, false);
  assert.equal(f.state.editing, null);
  assert.equal(f.state.draft.name, '');
});

// ---- explicit selection: a radiogroup with the principal first ---------------------------------------
test('the role choice is a radiogroup: Koda (principal) first, exactly one checked, active:null = principal', () => {
  const none = S.roleChoices(S.storeView(state(), listing));
  assert.deepEqual(none.map(r => r.id), [null, 'esp-0011223344556677', 'esp-8899aabbccddeeff']);
  assert.deepEqual(none.map(r => r.checked), [true, false, false]);
  assert.equal(none[0].label, 'Koda');
  assert.equal(none[0].principal, true);
  const second = S.roleChoices(S.storeView(state({ active: 'esp-8899aabbccddeeff' }), listing));
  assert.deepEqual(second.map(r => r.checked), [false, false, true]);
  assert.equal(second.filter(r => r.checked).length, 1);
  assert.match(second[2].aria, /Editor/);
  const empty = S.roleChoices(S.storeView(state({ specialists: [] }), listing));
  assert.deepEqual(empty.map(r => r.id), [null], 'with no specialists only the principal is offered');
});

test('load_error is unavailable, never healthy empty or principal success', () => {
  for (const specialists of [[], state().specialists]) {
    const failed = state({ load_error: true, persisted: false, specialists });
    const view = S.storeView(failed, listing);
    assert.equal(view.kind, 'unavailable');
    assert.equal(view.principal, false);
    assert.equal(view.countWord, '');
    assert.deepEqual(view.rows, []);
    assert.deepEqual(S.roleChoices(view), []);
    assert.match(view.persistenceNote, /No se pudieron cargar/);
    assert.equal(S.roleChip(failed), null);
  }
});

test('keyboard target supports arrows, wrapping, Home and End without synthetic clicks', () => {
  const choices = S.roleChoices(S.storeView(state(), listing));
  for (const [at, key, expected] of [[0,'ArrowDown',1],[1,'ArrowRight',2],[0,'ArrowUp',2],
    [2,'ArrowLeft',1],[2,'ArrowDown',0],[2,'Home',0],[0,'End',2]]) {
    assert.equal(S.roleKeyIndex(key, at, choices.length), expected);
  }
  assert.equal(S.roleKeyIndex('x', 0, 3), -1);
  assert.equal(S.roleKeyIndex('Home', 0, 0), -1);
});

// ---- #436 T6.5 (D8/D11): the section copy follows the design. Source-level wiring only:
// specialists.js has no DOM harness (no jsdom in this suite); stated as structural proof.
test('wiring: the section shows ONE declarativo chip and drops the repeated declarativo wording', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'specialists.js'), 'utf8');
  assert.equal((src.match(/Declarativo: todavía no se aplica/g) || []).length, 1, 'exactly one chip, in the section header');
  assert.doesNotMatch(src, /declarativos, todavía no se aplican/);
  assert.doesNotMatch(src, /opcional y declarativo/);
  assert.doesNotMatch(src, /Permisos \(declarativos\)/);
  assert.match(src, /specialists-declarativo/, 'the chip carries the stable id the checks can find');
});


// ---- #442 T7.4: agents = specialist records + colour + island order (max 3) ------------------------------
const A = require(path.join(frontend, 'avatar-colors.js'));
const rec = (id, name, extra = {}) => ({ id, name, instructions: extra.instructions || `Hace ${name}.`, model: null, space: null, spaces: [], permissions: ['read'] });
const store = (...ids) => ({ v: 1, active: null, specialists: ids.map(i => rec(i, i.toUpperCase())), persisted: true, load_error: false });

test('agentsView: island order is the stored one, else the first three stored; deleted ids drop; extra specialists stay stored', () => {
  const st = store('esp-a', 'esp-b', 'esp-c', 'esp-d');
  let v = S.agentsView(st, { islandAgents: null, avatarColors: {} }, A);
  assert.deepEqual(v.agents.map(a => a.id), ['esp-a', 'esp-b', 'esp-c'], 'absent = first three');
  assert.deepEqual(v.stored.map(a => a.id), ['esp-d'], 'the fourth is kept, not shown as a tile');
  assert.equal(v.count, 3); assert.equal(v.full, true);
  v = S.agentsView(st, { islandAgents: ['esp-d', 'esp-gone', 'esp-a'], avatarColors: {} }, A);
  assert.deepEqual(v.agents.map(a => a.id), ['esp-d', 'esp-a'], 'order respected, unknown ids dropped');
  assert.deepEqual(v.stored.map(a => a.id), ['esp-b', 'esp-c']);
  assert.equal(v.full, false);
  v = S.agentsView(st, { islandAgents: [], avatarColors: {} }, A);
  assert.deepEqual(v.agents, [], 'an explicit empty order is «nobody on the island»');
  assert.equal(S.agentsView(null, {}).kind, 'loading');
  assert.equal(S.agentsView({ load_error: true }, {}).kind, 'unavailable');
});

test('agentsView: colour comes from avatarColors for the SAME id (green default), state chip is En reposo; short role is one line', () => {
  const st = { ...store('esp-a'), specialists: [rec('esp-a', 'Notas', { instructions: 'Ordena tus notas y resume lo pendiente de la semana entera.\nSegunda línea.' })] };
  const a = S.agentsView(st, { islandAgents: null, avatarColors: { 'esp-a': 'mint' } }, A).agents[0];
  assert.equal(a.color, 'mint'); assert.equal(a.state, 'rest'); assert.equal(a.stateWord, 'En reposo');
  assert.ok(a.role.length <= 28 && !a.role.includes('\n'), a.role);
  assert.equal(S.agentsView(st, { avatarColors: {} }, A).agents[0].color, A.resolveColor('esp-a', {}), 'the default is the #384 contract\'s, not ours');
  assert.equal(S.agentsView(st, { avatarColors: { 'esp-a': 'red' } }, A).agents[0].color, A.resolveColor('esp-a', {}), 'off-palette reads as the default');
  assert.equal(S.agentsView(st, { avatarColors: Object.create({ 'esp-a': 'blue' }) }, A).agents[0].color, A.resolveColor('esp-a', {}), 'inherited keys never answer');
});

test('islandOrderAfter: toggle active (cap 3) and move; refusals return null', () => {
  const all = ['esp-a', 'esp-b', 'esp-c', 'esp-d'];
  assert.deepEqual(S.islandOrderAfter(['esp-a'], all, { toggle: 'esp-b' }), ['esp-a', 'esp-b']);
  assert.deepEqual(S.islandOrderAfter(['esp-a', 'esp-b'], all, { toggle: 'esp-a' }), ['esp-b']);
  assert.equal(S.islandOrderAfter(['esp-a', 'esp-b', 'esp-c'], all, { toggle: 'esp-d' }), null, 'a fourth is refused');
  assert.equal(S.islandOrderAfter(['esp-a'], all, { toggle: 'esp-zzz' }), null);
  assert.deepEqual(S.islandOrderAfter(['esp-a', 'esp-b', 'esp-c'], all, { move: 'esp-c', by: -1 }), ['esp-a', 'esp-c', 'esp-b']);
  assert.equal(S.islandOrderAfter(['esp-a', 'esp-b'], all, { move: 'esp-a', by: -1 }), null, 'moving past the edge is refused');
  assert.equal(S.islandOrderAfter(['esp-a'], all, {}), null);
});

test('savedBefore: custom blobs and declared catalog pills with no matching specialist, by name', () => {
  const C = require(path.join(frontend, 'pill-catalog.js'));
  const st = { ...store('esp-a'), specialists: [rec('esp-a', 'GitHub')] };
  const rows = S.savedBefore(st, { customBlobs: [{ name: 'Notas', color: 'mint' }, { name: 'github', color: '' }],
    declaredPills: ['integration_github', 'integration_n8n'], pillColors: { integration_n8n: 'purple' } }, C, A);
  assert.deepEqual(rows.map(r => [r.kind, r.name, r.color]), [['blob', 'Notas', 'mint'], ['pill', 'n8n', 'purple']],
    'a stored entry whose name already is a specialist is not offered again');
  assert.ok(rows.every(r => r.instructions.length > 0 && r.instructions.length <= 2000 && r.key));
  assert.deepEqual(S.savedBefore(st, {}, C, A), []);
});

test('catalogPrefill: name, colour and «Qué hace» from the offered catalog definition', () => {
  const C = require(path.join(frontend, 'pill-catalog.js'));
  const p = S.catalogPrefill(C, 'integration_github', { pillColors: { integration_github: 'blue' } }, A);
  assert.equal(p.name, 'GitHub'); assert.equal(p.color, 'blue'); assert.ok(p.instructions.includes('GitHub'));
  assert.ok(A.PALETTE.includes(S.catalogPrefill(C, 'integration_github', {}, A).color), 'an unset colour falls to the contract default');
  assert.equal(S.catalogPrefill(C, 'nope', {}, A), null);
});

console.log(`specialists-view-check: ${passed} passed`);
