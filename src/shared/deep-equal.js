// shared/deep-equal.js — ownerless primitive: structural equality over plain JSON data.
//
// ONE implementation, because there were two. The turn runner grew a copy to decide whether a state
// field actually moved, and json-patch-ops grew another to decide whether a sent op landed as stored
// — the same walk, written twice, differing only in which null guard each reached for. A third was
// about to be written for the event-pack merge check. (Same lesson as shared/object-path.js and
// shared/json-patch-ops.js: an ownerless primitive gets its own home, or every feature that needs it
// grows a private answer and they drift apart silently.)
//
// PLAIN DATA ONLY, which is all any caller here holds: values that survived JSON. No Date, Map, Set,
// RegExp, class instance or cycle — those compare as bare objects and a cycle overflows the stack.
// Key ORDER is not part of equality; key COUNT is, so `{a:1}` and `{a:1,b:undefined}` differ.
export function deepEqual(a, b) {
    if (a === b) return true;                                  // covers every primitive, including both undefined
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;   // an array and a plain object are never equal
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}
