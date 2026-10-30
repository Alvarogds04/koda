'use strict';
// The gate's load warning (#503): a timeout that happens on a busy machine says «posible carga», without changing the verdict.
// Everything here is pure: /proc/loadavg text, the core count and the process names are injected.
const assert = require('node:assert/strict');
const { parseLoadavg, snapshot, isTimeoutReason, annotateFailure } = require('../packaging/validate/load.cjs');
const { buildReport, exitCode, spanishSummary } = require('../packaging/validate/report.cjs');

// /proc/loadavg: «1min 5min 15min running/total lastpid»
assert.deepEqual(parseLoadavg('13.55 7.99 5.03 4/1200 12345\n'), { load1: 13.55, load5: 7.99, load15: 5.03 });
for (const bad of ['', 'x y z', '1 2', null, undefined, '13,55 7 5 1/2 3']) assert.equal(parseLoadavg(bad), null, `unreadable loadavg: ${JSON.stringify(bad)}`);

// «posible carga» = load1 strictly above cores/4, OR two or more cargo/rustc processes running (parent decision, after the first rule
// of cores/2 would not have flagged the 13.55 run on this 32-core machine)
const busy = snapshot({ loadavgText: '13.55 7.99 5.03 4/1200 1', cores: 16, processNames: ['cargo', 'rustc', 'rustc', 'node', 'cargo-clippy', 'zsh'] });
assert.deepEqual(busy, { available: true, load1: 13.55, load5: 7.99, load15: 5.03, cores: 16, threshold: 4, loadHigh: true, builders: 3, builderHigh: true, high: true },
  'cargo and rustc count; cargo-clippy and the rest do not');
// THE REAL FAILING CASE: 13.55 load, 32 cores, 2 cargo. cores/4 = 8, so both conditions hold.
const real = snapshot({ loadavgText: '13.55 7.99 5.03 4/1200 1', cores: 32, processNames: ['cargo', 'cargo', 'zsh'] });
assert.equal(real.threshold, 8); assert.equal(real.loadHigh, true, '13.55 > 32/4'); assert.equal(real.builderHigh, true, '2 cargo'); assert.equal(real.high, true, 'this is the run that must be marked');
// each condition on its own is enough
const loadOnly = snapshot({ loadavgText: '9.00 1 1 1/1 1', cores: 32, processNames: ['cargo'] });
assert.deepEqual([loadOnly.loadHigh, loadOnly.builderHigh, loadOnly.high], [true, false, true], 'high load with a single cargo');
const buildersOnly = snapshot({ loadavgText: '0.50 1 1 1/1 1', cores: 32, processNames: ['cargo', 'rustc'] });
assert.deepEqual([buildersOnly.loadHigh, buildersOnly.builderHigh, buildersOnly.high], [false, true, true], 'two builders on an idle machine');
// neither: a quiet machine with at most one builder
const quietish = snapshot({ loadavgText: '2.00 1 1 1/1 1', cores: 32, processNames: ['cargo', 'zsh', 'node'] });
assert.deepEqual([quietish.loadHigh, quietish.builderHigh, quietish.high], [false, false, false]);
// both comparisons are strict
assert.equal(snapshot({ loadavgText: '8.00 1 1 1/1 1', cores: 32, processNames: [] }).high, false, 'exactly cores/4 is not above it');
assert.equal(snapshot({ loadavgText: '8.01 1 1 1/1 1', cores: 32, processNames: [] }).high, true);
assert.equal(snapshot({ loadavgText: '0.10 1 1 1/1 1', cores: 32, processNames: ['cargo'] }).builderHigh, false, 'one builder is not two');
assert.deepEqual(snapshot({ loadavgText: 'garbage', cores: 8, processNames: [] }), { available: false }, 'an unreadable loadavg is recorded as unavailable, never as zero load');
assert.deepEqual(snapshot({ loadavgText: '1 1 1 1/1 1', cores: 0, processNames: [] }), { available: false }, 'no core count: unavailable');

assert.equal(isTimeoutReason('tiempo agotado: app GNOME guardada'), true);
assert.equal(isTimeoutReason('contenido y controles; tiempo agotado: página flowsettings'), true);
for (const other of ['falta evidencia de comportamiento', 'una fila de agente mostró un error de instalación', '', undefined]) assert.equal(isTimeoutReason(other), false);

const timeout = { name: 'ajustes-styles', verdict: 'fail', reason: 'tiempo agotado: app GNOME guardada' };
const loaded = snapshot({ loadavgText: '13.55 7.99 5.03 4/1 1', cores: 32, processNames: ['cargo', 'rustc'] });
const quiet = snapshot({ loadavgText: '1.00 1.00 1.00 1/1 1', cores: 32, processNames: [] });

// a timeout on a loaded machine is marked, and ONLY the line changes
const marked = annotateFailure(timeout, loaded);
assert.equal(marked.verdict, 'fail', 'the verdict never changes');
assert.equal(marked.possibleLoad, true);
assert.match(marked.reason, /^tiempo agotado: app GNOME guardada — posible carga \(load 13\.55 > 8, 2 cargo\/rustc\)$/, 'the line names the load, the threshold and the builders');
const onlyBuilders = annotateFailure(timeout, buildersOnly);
assert.equal(onlyBuilders.possibleLoad, true, 'two builders alone mark a timeout');
assert.match(onlyBuilders.reason, /posible carga \(load 0\.5 <= 8, 2 cargo\/rustc\)$/, 'and the line says why: the load is low, the builders are not');
assert.deepEqual(marked.load, loaded, 'the snapshot is kept with the failure');
// not a timeout, or a quiet machine: not marked, but the snapshot is still recorded
for (const [scene, load] of [[timeout, quiet], [{ ...timeout, reason: 'falta evidencia de comportamiento' }, loaded]]) {
  const out = annotateFailure(scene, load);
  assert.equal(out.possibleLoad, false); assert.equal(out.reason, scene.reason); assert.equal(out.verdict, 'fail'); assert.deepEqual(out.load, load);
}
// no snapshot available: untouched, and it says so instead of inventing a load
const blind = annotateFailure(timeout, { available: false });
assert.equal(blind.possibleLoad, false); assert.equal(blind.reason, timeout.reason);
// only failures are annotated
const pass = { name: 'a', verdict: 'pass' }, unknown = { name: 'b', verdict: 'unverifiable', reason: 'sin audio' };
assert.deepEqual(annotateFailure(pass, loaded), pass); assert.deepEqual(annotateFailure(unknown, loaded), unknown);
// the input is not mutated
assert.deepEqual(timeout, { name: 'ajustes-styles', verdict: 'fail', reason: 'tiempo agotado: app GNOME guardada' });

// through the real report: same counts and exit code with or without the warning, the line carries it, the report records the start load
const plain = buildReport([pass, unknown, timeout], { head: 'abc' });
const warned = buildReport([pass, unknown, marked], { head: 'abc', load: loaded });
assert.deepEqual(warned.counts, plain.counts); assert.equal(exitCode(warned), exitCode(plain)); assert.equal(exitCode(warned), 1, 'still a failing gate');
assert.match(spanishSummary(warned), /ajustes-styles: falla \(tiempo agotado: app GNOME guardada — posible carga \(load 13\.55 > 8, 2 cargo\/rustc\)\)/);
assert.deepEqual(warned.load, loaded);
// the real reader, with a fake /proc: loadavg, the running process names, and a failed read reading as «unavailable»
const { readSnapshot } = require('../packaging/validate/load.cjs');
const fakeFs = (files, dirs) => ({ readFileSync: p => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; }, readdirSync: p => { if (!(p in dirs)) throw new Error('ENOENT'); return dirs[p]; } });
const fakeOs = cores => ({ cpus: () => Array.from({ length: cores }, () => ({})) });
const seen = readSnapshot(fakeFs({ '/proc/loadavg': '20.0 9.0 5.0 2/9 7\n', '/proc/10/comm': 'cargo\n', '/proc/11/comm': 'rustc\n', '/proc/12/comm': 'node\n' }, { '/proc': ['10', '11', '12', '13', 'self', 'cpuinfo'] }), fakeOs(16));
assert.deepEqual(seen, { available: true, load1: 20, load5: 9, load15: 5, cores: 16, threshold: 4, loadHigh: true, builders: 2, builderHigh: true, high: true }, 'pid 13 ended (no comm), non-numeric entries ignored');
assert.deepEqual(readSnapshot(fakeFs({}, {}), fakeOs(16)), { available: false }, 'no /proc at all: unavailable, never a made-up zero');

// the gate really uses it: the start snapshot is in the report, each failure is annotated, the verdict path is not touched
const gate = require('node:fs').readFileSync(require('node:path').join(__dirname, '../packaging/validate.cjs'), 'utf8');
assert.match(gate, /require\('\.\/validate\/load\.cjs'\)/);
assert.match(gate, /buildReport\(scenes, \{ \.\.\.provenance, load: startLoad,/, 'the report records the load at the start');
assert.match(gate, /loadAtFailure\.set\(row\.name, readSnapshot\(\)\)/, 'a snapshot is taken when a scene fails');
assert.match(gate, /annotateFailure\(scene, loadAtFailure\.get\(scene\.name\) \|\| endLoad\)/);
assert.doesNotMatch(gate, /classify\([^)]*load|verdict *= *['"]pass['"].*load/i, 'the load never feeds classify');
const browser = require('node:fs').readFileSync(require('node:path').join(__dirname, '../packaging/validate/browser.js'), 'utf8');
assert.match(browser, /async function wait\(check, description, ms = 6500\)/, 'the 6.5 s step timeout is unchanged (raising it would hide real slowness)');
console.log('PASS validate-load: loadavg parsing, load1 > cores/4 OR 2+ cargo/rustc (alone and together, the 13.55/32-core/2-cargo case), timeout-only marking, verdict unchanged');
