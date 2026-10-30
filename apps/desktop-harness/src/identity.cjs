'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const sha = value => createHash('sha256').update(value).digest('hex');
// QP/1 informational project id: sha256 hex of the real path, not an island-folder access filter.
// Replies stay bound to this connection's project/session. Throws if the directory cannot be resolved.
const projectId = cwd => sha(fs.realpathSync(cwd));
const RULE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
// Normalizes a harness session id to the QP/1 token rule (<=128). Never log the input or output.
function sessionToken(raw) {
  const input = typeof raw === 'string' ? raw : '';
  const cleaned = input.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '');
  if (cleaned.length > 0 && cleaned.length <= 128 && RULE.test(cleaned)) return cleaned;
  return 'h-' + sha(input).slice(0, 32);
}
// S10 (L25): the OPTIONAL display fields of a `settled` frame. `displayName` is the basename of the real cwd reduced to the
// wire's `[A-Za-z0-9._ -]{1,64}` (anything else becomes `_`); null when nothing displayable remains. `agentSlug` is the
// closed `[a-z0-9][a-z0-9._-]{0,31}`; a bad slug is null. Both or neither travel: see `displayFields`.
const path = require('node:path');
function displayName(cwd) {
  try {
    const base = path.basename(fs.realpathSync(cwd)).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 64).trim();
    return base.length > 0 ? base : null;
  } catch { return null; }
}
const agentSlug = value => (typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(value) ? value : null);
const WIRE_NAME = /^[A-Za-z0-9._ -]{1,64}$/;
// `nameOverride` (a cached session title) wins over the basename, but only when it already fits the wire alphabet.
function displayFields(cwd, agent, nameOverride) {
  const projectName = (typeof nameOverride === 'string' && WIRE_NAME.test(nameOverride) && nameOverride.trim() === nameOverride ? nameOverride : null) || displayName(cwd), slug = agentSlug(agent);
  return projectName && slug ? { projectName, agent: slug } : {};
}
module.exports = { projectId, sessionToken, displayName, agentSlug, displayFields };
