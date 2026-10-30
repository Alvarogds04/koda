'use strict';
const MIN_MARGIN_MS = 1000;
const MIN_MS = 30000, MAX_MS = 900000;
const whole = v => Number.isSafeInteger(v) && v >= 0;
const integer = v => Number.isSafeInteger(v);
// timeout = min(cliTimeoutMs - margin, maxMs). QP/1 only allows 30 s..15 min, so less => notice-only.
function computeDeadline(input) {
  try {
    const { cliTimeoutMs, maxMs = 300000, marginMs = 5000 } = input ?? {};
    if (!whole(cliTimeoutMs) || !whole(maxMs) || !integer(marginMs)) return { mode: 'notice-only' };
    const margin = Math.max(marginMs, MIN_MARGIN_MS); // never trust a caller to shrink the safety margin
    const timeoutMs = Math.min(cliTimeoutMs - margin, maxMs, MAX_MS);
    return timeoutMs >= MIN_MS ? { mode: 'ask', timeoutMs } : { mode: 'notice-only' };
  } catch { return { mode: 'notice-only' }; }
}
module.exports = { computeDeadline };
