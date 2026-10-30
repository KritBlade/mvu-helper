// mvu-helper · turn-phase-signal — announce when a PRE or POST pass is in flight. v0.1
//
// WHAT IT PUBLISHES, AND WHY ANYTHING NEEDS IT. The extra-call passes run through
// ConnectionManagerRequestService.sendRequest, which is NOT a SillyTavern generation: it fires no
// GENERATION_STARTED/ENDED and never sets `is_send_press`. So from outside this extension, the ~2s
// PRE pass and the whole POST pass are indistinguishable from an idle tab. Anything that asks "is
// this turn still working?" — a host UI's busy indicator, a consumer waiting for the turn to settle —
// gets the wrong answer for both windows, and has no way to derive the right one.
//
// This is mvu-helper describing its OWN pipeline and nothing else: the event carries the phase name
// already used in every log line, no listener is required, and nothing downstream is named or
// assumed. Same shape as the turn-runner's RES_STAGED_EVENT — a signal on ST's eventSource, emitted
// when the state actually changes rather than left for someone to poll.
//
// The counting (any number of calls, two phases per turn, one edge each way) is
// turn-phase-signal-core.js — pure, and tested there. This file is only the host wiring.
//
// THE ONE THING A LISTENER MUST NOT ASSUME: that `busy:false` always arrives. Both emit sites close
// their phase in a `finally`, so a throw, an early return and an aborted turn all close it — but a
// promise that never settles at all (a dead socket beneath a bound this file does not own) would
// leave a phase open. A listener that latches UI on this signal needs its own liveness cap, and
// should say WHY it fired rather than quietly healing: an unclosed phase is a defect HERE, and
// hiding it there would make it permanent.

import { eventSource } from '../../../../../../../script.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { createPhaseLedger, openPhase, closePhase, phasesOpen } from './turn-phase-signal-core.js';

const log = createModuleLog('small-llm');

export const TURN_PHASE_EVENT = 'mvu_helper_turn_phase';

const ledger = createPhaseLedger();

function announce(busy, phase) {
    // Fire-and-forget: eventSource.emit AWAITS every listener in turn, and PRE runs inside the
    // interceptor that GATES the reply — blocking the turn on someone else's handler is the same
    // deadlock shape runPostPass's own fire-and-forget comment warns about.
    try {
        void Promise.resolve(eventSource.emit(TURN_PHASE_EVENT, { busy, phase, open: phasesOpen(ledger) }))
            .catch((e) => log.warn(`turn-phase signal (${phase} ${busy ? 'begin' : 'end'}) — a listener threw:`, e));
    } catch (e) {
        log.warn(`turn-phase signal (${phase} ${busy ? 'begin' : 'end'}) could not be emitted:`, e);
    }
}

/** Open a phase. Emits `busy:true` only when it is the FIRST phase open. */
export function beginTurnPhase(phase) {
    const decision = openPhase(ledger, phase);
    if (decision.announce) announce(true, decision.phase);
}

/** Close a phase. Emits `busy:false` only when the LAST open phase closes. */
export function endTurnPhase(phase) {
    const decision = closePhase(ledger, phase);
    if (decision.unbalanced) {
        log.child('turn-phase-signal').warn(`"${decision.phase}" was closed but never opened — ignoring (a begin/end pair is unbalanced).`);
        return;
    }
    if (decision.announce) announce(false, decision.phase);
}
