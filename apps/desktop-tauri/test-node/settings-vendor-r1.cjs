'use strict';
// R1 (Koda 0.1 T2, restored by K2-03): the vendored Coucou code (frontend/vendor/) and the settings view stay untouched,
// except (a) a pure Abito -> Koda rename, and (b) the exact files K2-03 changes to remove Recap and the Notetaker,
// each listed below with its reason. Any other change fails. Compared against HEAD in a real git checkout; without
// one the check FAILS with a clear message (it never passes blind). Shared by settings-isla-check and settings-nusa-check.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const V = 'apps/desktop-tauri/frontend/vendor/coucou/';
// K2-03 (S1): Recap and the Notetaker page are removed. Exactly these vendored files change, and why:
const K2_03 = Object.freeze({
  [`${V}hub/recap.ts`]: 'deleted: Ajustes recap rows (Recap removed)',
  [`${V}hub/recap.js`]: 'deleted: generated from hub/recap.ts',
  [`${V}recap/summary.ts`]: 'deleted: weekly summary maths (Recap removed)',
  [`${V}recap/summary.js`]: 'deleted: generated from recap/summary.ts',
  [`${V}views/recap.ts`]: 'deleted: island recap card view (Recap removed)',
  [`${V}views/recap.js`]: 'deleted: generated from views/recap.ts',
  [`${V}hub/general.ts`]: 'recap rows and their teardown removed from General',
  [`${V}hub/general.js`]: 'generated from hub/general.ts',
  [`${V}hub/agents.ts`]: 'recap integration block removed from Agentes',
  [`${V}hub/agents.js`]: 'generated from hub/agents.ts',
  [`${V}hub/shell.ts`]: 'Notetaker «notes» page removed from PageId and FLOW_PAGES',
  [`${V}hub/shell.js`]: 'generated from hub/shell.ts',
  [`${V}hub/pages.ts`]: 'notesPage (Notetaker placeholder) removed',
  [`${V}hub/pages.js`]: 'generated from hub/pages.ts',
  [`${V}hub/hero.ts`]: '«notes» page colour removed',
  [`${V}hub/hero.js`]: 'generated from hub/hero.ts',
  [`${V}hub/i18n-es.ts`]: 'Notetaker and weekly recap strings removed',
  [`${V}hub/i18n-es.js`]: 'generated from hub/i18n-es.ts',
  [`${V}i18n/i18n.ts`]: 'weekly recap strings removed',
  [`${V}i18n/i18n.js`]: 'generated from i18n/i18n.ts',
  [`${V}hub/hub.css`]: 'Notetaker page styles removed',
  [`${V}hub/dictation-pages.ts`]: 'comment no longer names the Notetaker',
  [`${V}hub/personalization.ts`]: 'comment no longer names the Notetaker',
  [`${V}island/island.css`]: 'recap card styles removed',
  'apps/desktop-tauri/frontend/settings-view.js': 'recap agent id, rows and plan summary removed',
});

/** Repository-relative paths changed against HEAD under `root` (throws a clear error outside a git checkout). */
function changedSinceHead(root) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error('R1 needs a git checkout with a HEAD commit to compare vendor/ against; none found under ' + root + ' (this check never passes blind)');
  }
  return execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** True when the diff of `p` against HEAD only renames Abito <-> Koda in text. */
function onlyRenamed(root, p) {
  const d = execFileSync('git', ['diff', '-U0', 'HEAD', '--', path.join(root, '..', '..', p)], { cwd: root, encoding: 'utf8' }).split('\n');
  const minus = d.filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1).replace(/Abito|Koda/g, 'N'));
  const plus = d.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1).replace(/Abito|Koda/g, 'N'));
  return JSON.stringify(minus) === JSON.stringify(plus);
}

/** The changed files in scope that are neither a pure rename nor a listed K2-03 change. Pure: `renamed` is injectable. */
function violations(changed, inScope, renamed) {
  return changed.filter(inScope).filter(p => !Object.prototype.hasOwnProperty.call(K2_03, p) && !renamed(p));
}

function check(root, inScope) {
  return violations(changedSinceHead(root), inScope, p => onlyRenamed(root, p));
}

module.exports = { K2_03, changedSinceHead, onlyRenamed, violations, check };
