// shared/json-patch-ops.js — ownerless primitive: what a JSON Patch op IS, for every writer that
// hands a block to `Mvu.parseMessage`. No host, no feature — sibling primitives only.
//
// ONE implementation, so every lane that hands MVU ops agrees on which ops are legal: the PRE and POST
// calls (small-llm), the engine's pre-assembly rail, and the §23 plugin relay (gamelogic-plugin).
//
// The DIVISION OF LABOUR this file draws, and nothing more: mvu-helper owns SHAPE — is it an object,
// is the verb one MVU takes, is the path a pointer that walks no prototype key, is there a value.
// `Mvu.parseMessage` owns every SEMANTIC refusal (does the path exist, is the container extensible,
// does the card's Zod keep the value), per op, loudly.

import { deepEqual } from './deep-equal.js';
import { isPrototypeKey } from './object-path.js';

// The only JSON-Patch verbs a writer may emit. No move/copy/test: these lanes REWRITE state
// snapshots, they do not shuffle them, and every extra verb is more surface for a small model — or
// a plugin author — to get wrong.
export const PATCH_VERBS = ['add', 'remove', 'replace'];

// Read a value out of a nested object by JSON-Pointer-ish path ("/PendingState/AddClassmate/0").
// Returns undefined if any segment is missing or a prototype key (shared/object-path.js says why). Used
// to log a patched path's actual before/after value (MVU stores #tuple fields as [value,"Label"], so the
// op path ends in /0), and to detect the paths an apply silently dropped.
//
// "Pointer-ISH", deliberately: the two RFC 6901 escapes (~1 = '/', ~0 = '~') are NOT decoded, so a
// key containing a literal slash is unaddressable here. No card state uses one, and decoding them
// would change what every live PRE path already resolves to — a real behaviour change on the lane
// the turn's dice resolution rides. Stated, not silently inherited.
export function getAtPointer(obj, pointer) {
    const segs = String(pointer == null ? '' : pointer).split('/').filter((x) => x !== '');
    let cur = obj;
    for (const seg of segs) {
        if (cur == null || isPrototypeKey(seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

// What makes ONE op unusable, or '' when it is fine. SHAPE ONLY — well-formed enough to APPLY and
// to RENDER; the PRE lane prints prose FROM these ops, so an op nothing could ever apply must not
// reach the narrator as a fact.
//
// No path-scope check: any path is legal HERE — the card's Zod is the containment, and MVU's strict-strip
// plus the caller's per-op after-apply check own the hallucinated-path case. The one path refused is one
// through a prototype key, which is no stat_data key at all: MVU reads an op's parent with lodash `_.get`,
// which answers Object.prototype for `__proto__` (or `constructor/prototype`), and then assigns into it, so
// the write would land on every object in the page. These ops come from model output and from the engine
// Worker (the pre-assembly rail, a plugin's relay), so this check is the sandbox's edge.
export function patchOpShapeProblem(op, index) {
    if (!op || typeof op !== 'object') return `op #${index} is not an object`;
    if (!PATCH_VERBS.includes(op.op)) return `op #${index} verb "${op.op}" not in {${PATCH_VERBS.join(', ')}}`;
    if (typeof op.path !== 'string' || !op.path.startsWith('/')) return `op #${index} has no JSON-Pointer path`;
    const prototypeKey = op.path.split('/').find(isPrototypeKey);
    if (prototypeKey) return `op #${index} path "${op.path}" walks the prototype key "${prototypeKey}", which is never a stat_data key`;
    if (op.op !== 'remove' && !('value' in op)) return `op #${index} (${op.op}) has no value`;
    return '';
}

/**
 * Split an array of candidate ops into the ones that survive shape-checking and the ones that do
 * not, keeping each drop's ORIGINAL index so the caller can name it.
 *
 * ▲ PER-OP SALVAGE, not all-or-nothing (user, 2026-08-16). A PRE call's block is the concatenation
 * of every lorebook entry routed to it, so rejecting the array over one bad element let ANY entry
 * void every OTHER entry's state — on School's PRE that means a stray op costs `/Intent/check/0`,
 * and the turn's dice resolution dies with it. Salvage is also the WEAKER claim: the survivors go on
 * to `Mvu.parseMessage`, which gates each one itself, so keeping a good op never bypasses a check —
 * it just stops one neighbour from being the reason it was never offered.
 *
 * @param {any[]} parsed  candidate ops (caller has already established this is an array)
 * @param {(op: object, index: number) => string} [extraProblem]  an additional per-op check for a
 *        hazard only ONE lane's op SOURCE has — see the relay's serialisability check, which exists
 *        because Worker ops arrive by structured clone (cycles survive it; JSON.parse cannot make
 *        one). Runs only on ops that already passed the shape check.
 * @returns {{ ops: object[], dropped: {index:number, reason:string}[] }}
 */
export function salvagePatchOps(parsed, extraProblem) {
    const ops = [];
    const dropped = [];
    for (let i = 0; i < parsed.length; i++) {
        const problem = patchOpShapeProblem(parsed[i], i)
            || (extraProblem ? extraProblem(parsed[i], i) : '');
        if (problem) dropped.push({ index: i, reason: problem });
        else ops.push(parsed[i]);
    }
    return { ops, dropped };
}

// Which applied ops did NOT land, BY PATH PRESENCE ONLY — the §9a.2 strip probe.
//
// ⚠ THIS ANSWERS THE WEAKER QUESTION, and only ONE lane may still ask it: POST. A path that is
// present can still hold a value the write never produced, so "present" is not "landed" — see
// opsOutcomeAfterApply below, which every other lane uses. POST keeps this one because the RES2
// relay its own parse fires REWRITES paths afterwards, so the clone POST reads back is post-relay:
// a value comparison there would flag the game's own bookkeeper as a refusal. Presence survives that
// rewrite; value does not.
//
// `remove` is skipped here — for it, absent IS the success case, and this check cannot see the
// opposite (a remove the card refused leaves the path present, which reads as fine).
export function opsMissingAfterApply(statData, ops) {
    return (Array.isArray(ops) ? ops : [])
        .filter((o) => o && o.op !== 'remove' && getAtPointer(statData, o.path) === undefined)
        .map((o) => o.path);
}


// The first key at which two objects disagree, or '' — so an object mismatch names WHERE rather than
// printing two blobs and leaving the reader to diff them. Exists because the nested-strip case is
// exactly an object that looks right at a glance: the root schema is `looseObject`, but a nested
// `z.object` STRIPS, so an editListItem write comes back one key lighter and nothing else changes.
export function firstDifferingKey(sent, stored) {
    if (!sent || !stored || typeof sent !== 'object' || typeof stored !== 'object') return '';
    if (Array.isArray(sent) || Array.isArray(stored)) return '';
    const keys = [...new Set([...Object.keys(sent), ...Object.keys(stored)])];
    for (const k of keys) {
        const inSent = Object.prototype.hasOwnProperty.call(sent, k);
        const inStored = Object.prototype.hasOwnProperty.call(stored, k);
        if (!inSent || !inStored || !deepEqual(sent[k], stored[k])) return k;
    }
    return '';
}

// THE TWO COERCIONS MVU ITSELF PERFORMS, and the only reason a stored value may differ from a sent
// one without that being a refusal. Both are `set` branches in MagVarUpdate's update_variables.ts,
// reproduced here as its own arithmetic rather than approximated with a loose `==`:
//
//   1. ValueWithDescription<T> — a scalar written over `[value,"Label"]` lands in SLOT 0. MVU's own
//      conditions, all of them: not strictSet, the old value is a 2-array, its [1] is a STRING, and
//      its [0] is not itself an array. Number() is applied inside slot 0 only when the old slot 0
//      was a number and the new value is not null.
//   2. A string written over a number becomes Number(new).
//
// Both live on MVU's OWN set path, so both are reachable only on a card with NO Zod schema running.
// A Zod card never gets here: mvu_zod applies each command to a klona clone, safeParses the whole
// object, and on success writes Zod's PARSED output — which is the `changed` state, not this one.
// Takes the BEFORE value because that is what MVU branches on; guessing from the stored shape would
// call a genuinely refused write a coercion.
//
// Returns the coercion's NAME, or '' when the stored value is not one of them.
export function mvuCoercionNote(beforeValue, sent, stored) {
    if (Array.isArray(beforeValue) && beforeValue.length === 2
        && typeof beforeValue[1] === 'string' && !Array.isArray(beforeValue[0])) {
        const expected = (typeof beforeValue[0] === 'number' && sent !== null) ? Number(sent) : sent;
        if (Array.isArray(stored) && stored.length === 2
            && deepEqual(stored[0], expected) && deepEqual(stored[1], beforeValue[1])) {
            return 'landed in tuple slot 0 (ValueWithDescription)';
        }
    }
    if (typeof beforeValue === 'number' && sent !== null && typeof sent === 'string'
        && deepEqual(stored, Number(sent))) {
        return 'string coerced by Number()';
    }
    return '';
}

/**
 * WHAT THE CARD ACTUALLY DID WITH EACH OP — the probe that replaces "is the path there".
 *
 * WHY PRESENCE WAS NOT ENOUGH (live 2026-08-28, ArtificKoi, builder B5 step 1): a StatusMenu action
 * set a BARE number over a labelled tuple. The line read `wrote 1/1 op(s) -> add /Mainchar/Money=5001`
 * and the persisted value stayed `[5000,"Money"]`. The path was present, so the old probe called it
 * a success — a log that lies in the one direction a writer cannot recover from.
 *
 * THE RAIL, both card kinds, because the platform must be right on either (L4):
 *   • Zod card — mvu_zod intercepts `mag_command_parsed_for_zod`, applies each command to a klona
 *     CLONE, safeParses the WHOLE object, and on success merges Zod's PARSED output. On failure the
 *     op is dropped, nothing is written, and the only signal is a toast that fires ONLY when
 *     `#mvu_notification_error` is checked. `mag_command_parsed_ended_for_zod` then empties the
 *     command list, so MVU's own apply never runs at all.
 *   • Non-Zod card — MVU's own `set` runs, with the two coercions above.
 * So `coerced` is reachable only without Zod, and `refused` only with it. Both states are real.
 *
 * `before` is FREE at every call site: `Mvu.parseMessage` klona-clones its argument and returns the
 * clone, so the caller's own stat_data is still the pre-apply state after the call.
 *
 * JUDGES NOTHING — it reports `sent` and `stored` and names the state; the caller prints both.
 *
 * @param {object} before  stat_data as it was BEFORE the apply (the caller's own, untouched)
 * @param {object} after   stat_data as MVU handed it back
 * @param {object[]} ops   the ops that were SENT (not a diff — a refused op is what a diff cannot hold)
 * @returns {{path:string, op:string, state:string, sent:any, stored:any, note:string}[]}
 *   state is one of:
 *     'landed'  — stored deep-equals what was sent
 *     'coerced' — stored is what one of MVU's two documented coercions makes of what was sent
 *     'changed' — stored differs from BOTH sent and before: a Zod default or transform landed
 *     'refused' — stored deep-equals BEFORE, i.e. the op was dropped and nothing was written
 *                 (for `remove`: the path is still THERE, which is that op's refusal)
 *     'absent'  — the path does not exist after the apply, and there was nothing there before either
 */
export function opsOutcomeAfterApply(before, after, ops) {
    return (Array.isArray(ops) ? ops : []).filter(Boolean).map((op) => {
        const path = op.path;
        const storedBefore = getAtPointer(before, path);
        const stored = getAtPointer(after, path);
        const row = { path, op: op.op, state: '', sent: op.op === 'remove' ? undefined : op.value, stored, note: '' };
        // `remove` inverts every test: gone is success, still there is the refusal. Included rather
        // than skipped, because a Zod card refusing to delete a REQUIRED key leaves the path present
        // and a probe that skips removes reports that as fine.
        if (op.op === 'remove') {
            row.state = stored === undefined ? 'landed' : 'refused';
            if (row.state === 'refused') row.note = 'the path is still present';
            return row;
        }
        if (stored === undefined) {
            row.state = 'absent';
            row.note = storedBefore === undefined ? 'nothing there before either' : 'the previous value is gone too';
            return row;
        }
        if (deepEqual(stored, op.value)) { row.state = 'landed'; return row; }
        // BEFORE decides `refused`, not "it did not reconcile". Without this the state collapses into
        // `changed` and a dropped op reads as a schema transform — the two facts a caller most needs
        // apart, since one is the author's bug and the other is the schema working.
        if (deepEqual(stored, storedBefore)) {
            row.state = 'refused';
            row.note = 'unchanged from before the apply';
            return row;
        }
        const coercion = mvuCoercionNote(storedBefore, op.value, stored);
        if (coercion) { row.state = 'coerced'; row.note = coercion; return row; }
        row.state = 'changed';
        const key = firstDifferingKey(op.value, stored);
        row.note = key ? 'first differing key: "' + key + '"' : 'a schema default or transform landed';
        return row;
    });
}

// The one-line rendering of an outcome row, shared so three lanes print the same shape. `landed` is
// the word, never `wrote`: a write that was refused was still "written" in the sense the old label
// meant, which is exactly how the count came to lie.
export function renderOpOutcome(row) {
    const sent = row.op === 'remove' ? '' : '=' + JSON.stringify(row.sent);
    const stored = row.state === 'landed' ? '' : ' -> stored ' + JSON.stringify(row.stored);
    return row.op + ' ' + row.path + sent + ' [' + row.state + (row.note ? ': ' + row.note : '') + ']' + stored;
}
