// gamelogic-plugin/plugin-relay-core.js — PURE decisions for the plugin relay lane. No host imports;
// every branch is reachable from a test (L6).
//
// A plugin's engine returns JSON Patch ops and they ride THE SAME RAIL AS THE CARD'S OWN POST
// BOOKKEEPER: an `<UpdateVariable><JSONPatch>` block, through the same `Mvu.parseMessage`, judged by the
// same Zod. Nothing about the origin of an op changes what an op is. So every op-shape decision lives in
// shared/json-patch-ops.js, with the PRE sim lane; this file holds only what is true of THIS lane: where
// its ops come from (a Worker), and the wrapper MVU needs around them.

import { salvagePatchOps } from '../../shared/json-patch-ops.js';

// The single export name the host looks for in a plugin's engine scope.
export const RELAY_EXPORT_NAME = 'resolveRelay';

// The one hazard the PRE lane cannot have, and the whole reason this lane adds a check at all:
// relay ops cross a Worker boundary by STRUCTURED CLONE, which preserves cycles, Maps and Dates.
// PRE's ops come out of `JSON.parse`, so they are serialisable by construction. Checked per op, so
// one unserialisable value is dropped BY NAME instead of throwing inside buildRelayBlock's
// JSON.stringify and taking every sibling op with it.
function unserialisableValueProblem(op, index) {
    if (op.op === 'remove') return '';
    try { JSON.stringify(op.value); }
    catch (e) { void e; return `op #${index} value is not JSON-serialisable`; }
    return '';
}

/**
 * Shape-check a resolver's patches and split them into forwardable ops + dropped ones.
 * @returns {{ ops: object[], dropped: {index:number, reason:string}[] }}
 */
export function planRelayPatch(patches) {
    if (patches === undefined || patches === null) return { ops: [], dropped: [] };
    if (!Array.isArray(patches)) {
        return { ops: [], dropped: [{ index: -1, reason: '"patches" must be an ARRAY of JSON Patch ops — got ' + typeof patches }] };
    }
    const { ops, dropped } = salvagePatchOps(patches, unserialisableValueProblem);
    // Carry op/path/value and nothing else: a resolver's bookkeeping fields (`reason`, `from`, …)
    // are for its own log, not for MVU's input.
    return {
        ops: ops.map((o) => (o.op === 'remove' ? { op: o.op, path: o.path } : { op: o.op, path: o.path, value: o.value })),
        dropped,
    };
}

// The block text MVU parses — the same `<UpdateVariable><JSONPatch>` shape the card's own POST bookkeeper
// emits, so the two lanes hand MVU identical input.
export function buildRelayBlock(ops) {
    return '<UpdateVariable>\n<JSONPatch>\n' + JSON.stringify(ops) + '\n</JSONPatch>\n</UpdateVariable>';
}

// A plugin's own root as a JSON Pointer, handed to the resolver beside the dotted `ownRoot` so the
// commonest path build is not a string-manipulation exercise every author repeats (and gets wrong).
export function ownRootPointer(ownRoot) {
    return '/' + String(ownRoot || '').split('.').filter(Boolean).join('/');
}
