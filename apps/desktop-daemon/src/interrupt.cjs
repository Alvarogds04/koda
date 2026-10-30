"use strict";

/**
 * #378 live interruption policy: when the user's permissions for the running
 * agent change (revoked account access) or the global pause (#379) turns on,
 * the in-flight agent turn is interrupted at the next safe point.
 *
 * The engine owns the interruption mechanics (AgentEngine.interruptTurn,
 * runtime.cjs: cancellation, recycle, session reopen, no replay). This module
 * owns the observable policy: the fixed sanitized closed-event copy (no engine
 * text ever reaches a client) and the bounded wait for the safe point at which
 * a permission change may be applied. Failure to reach the safe point leaves
 * the caller's data untouched (the server answers `busy`).
 */

/**
 * Closed-event copy per cancellation reason, keyed by the reason the engine
 * carries on `turn_cancelled`. The four base reasons keep their existing
 * English copy; the two daemon-level reasons introduced by #378 are the user
 * -facing Spanish copy of this card.
 */
const CLOSED_TOAST_MESSAGES = {
	cancelled: "Agent turn cancelled.",
	time_limit: "Agent turn time limit reached.",
	iteration_limit: "Agent turn iteration limit reached.",
	paused: "La pausa interrumpió el turno del agente.",
	access_revoked: "Se revocó el acceso: se interrumpió el turno del agente.",
};

const DEFAULT_CLOSED_TOAST_MESSAGE = "Agent turn interrupted.";

/** The sanitized warning toast that closes an interrupted turn for every client. */
function closedToast(reason) {
	return { type: "toast", level: "warning", message: CLOSED_TOAST_MESSAGES[reason] ?? DEFAULT_CLOSED_TOAST_MESSAGE };
}

const SAFE_POINT_POLL_MS = 25;

/**
 * Resolves once `isBusy()` turns false, or after `timeoutMs` with false.
 * The busy predicate is the caller's canonical admission guard (the server's
 * `state().busy`), so the safe point is exactly "nothing new would be refused
 * as busy anymore".
 */
async function awaitSafePoint(isBusy, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (isBusy() === true) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, SAFE_POINT_POLL_MS));
	}
	return true;
}

module.exports = { CLOSED_TOAST_MESSAGES, awaitSafePoint, closedToast };
