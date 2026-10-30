'use strict';
function buildReport(scenes, metadata = {}) {
  const counts = { pass: 0, fail: 0, unverifiable: 0 };
  const names = new Set();
  for (const scene of scenes) {
    if (!Object.hasOwn(counts, scene.verdict)) throw new Error(`invalid verdict: ${scene.verdict}`);
    if (names.has(scene.name)) throw new Error(`duplicate scene: ${scene.name}`);
    if (scene.verdict !== 'pass' && !scene.reason) throw new Error(`reason required: ${scene.name}`);
    names.add(scene.name); counts[scene.verdict]++;
  }
  return { ...metadata, schemaVersion: 1, scenes, counts };
}
function exitCode(report) { return report.counts.fail || !report.scenes.length ? 1 : 0; }
function spanishSummary(report) {
  return report.scenes.map(s => `${s.name}: ${s.verdict === 'pass' ? 'anda' : s.verdict === 'fail' ? `falla (${s.reason})` : `no verificable aquí (${s.reason})`}${s.png ? ` — ${s.png}` : ''}`)
    .concat(`${report.counts.pass} anda · ${report.counts.fail} falla · ${report.counts.unverifiable} no verificable`).join('\n');
}
module.exports = { buildReport, exitCode, spanishSummary };
