// features/logic-engine/live-resolve-gate.js — the PRE-time-apply suppression gate (pure, no host imports).
//
// WHY THIS EXISTS (live-caught 2026-08-10, PRE_Call_Revisit Phase 3 gate): a PRE-time sim apply
// persists its patch through Mvu.parseMessage, and parseMessage emits VARIABLE_UPDATE_ENDED — the
// very event the turn runner treats as "a turn finished, resolve it". With a PRE patch on an
// /Intent channel (/Intent/check) the runner saw the freshly-written intent, resolved it MID-TURN against
// the LAST AI floor, applied the stat swing, and CLEARED the intent before narrate ever rendered —
// so the narrator's panel read "(none)" and the reply floor double-applied the beat.
//
// The event itself is load-bearing elsewhere (POST deliberately uses parseMessage → RES2), so the
// fix is a SCOPED suppression: the sim apply wraps its own parse in withLiveResolveSuppressed(),
// and the turn runner drops VARIABLE_UPDATE_ENDED events that arrive inside that window. Nothing
// else legitimately fires in it — the window only spans our own parse of the PRE patch, pre-turn.
//
// Depth-counted (not boolean) so nested/concurrent applies (user floor + A2 cache floor, or two
// sim calls in one turn) compose; the finally guarantees a throw never wedges the gate shut.

let suppressionDepth = 0;

export function isLiveResolveSuppressed() {
    return suppressionDepth > 0;
}

export async function withLiveResolveSuppressed(callback) {
    suppressionDepth++;
    try {
        return await callback();
    } finally {
        suppressionDepth = Math.max(0, suppressionDepth - 1);
    }
}
