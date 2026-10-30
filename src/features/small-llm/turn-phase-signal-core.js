// mvu-helper · turn-phase-signal-core — PURE bookkeeping for "is a turn phase in flight". v0.1
//
// A turn is not one call, and it is not one phase. A PRE pass runs any number of calls; a POST pass
// runs any number of its own; and the two are separated in time by the main generation. A listener
// wants one answer — "something is working" — so the counting has to collapse all of that to the two
// edges that matter (first open, last close) and nothing else.
//
// THIS IS THE HALF WORTH TESTING, so it is the half that lives here. The wrapper around it reaches
// ST's eventSource and the logger and no test can open it; this file is where "five PRE calls do not
// emit five events" and "a stray close cannot cancel a live phase" are actually decided. Getting the
// second one wrong is the nastier bug: the count would drop to zero while a pass is still running,
// the listener would take its indicator down mid-turn, and that is precisely the failure the signal
// exists to end.

/** A fresh ledger. Plain object so a caller (or a test) can inspect it. */
export function createPhaseLedger() {
  return { open: new Map() };
}

/** How many phase-opens are outstanding across every phase. */
export function phasesOpen(ledger) {
  let total = 0;
  const open = ledger && ledger.open;
  if (open && typeof open.forEach === 'function') open.forEach((count) => { total += count; });
  return total;
}

/**
 * Record a phase opening.
 * @returns {{announce: boolean, phase: string}} announce is true ONLY on the idle→busy edge.
 */
export function openPhase(ledger, phase) {
  const name = String(phase || 'unknown');
  const wasIdle = phasesOpen(ledger) === 0;
  ledger.open.set(name, (ledger.open.get(name) || 0) + 1);
  return { announce: wasIdle, phase: name };
}

/**
 * Record a phase closing.
 *
 * `unbalanced` is the close of a phase that was never opened. It is REFUSED rather than counted:
 * letting the total go negative would mean a later, real open never reaches 1, so the busy edge would
 * never fire again for the rest of the session. The caller says so out loud instead.
 *
 * @returns {{announce: boolean, unbalanced: boolean, phase: string}}
 */
export function closePhase(ledger, phase) {
  const name = String(phase || 'unknown');
  const count = ledger.open.get(name) || 0;
  if (count <= 0) return { announce: false, unbalanced: true, phase: name };
  if (count === 1) ledger.open.delete(name); else ledger.open.set(name, count - 1);
  return { announce: phasesOpen(ledger) === 0, unbalanced: false, phase: name };
}
