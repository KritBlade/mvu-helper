// shared/object-path.js — ownerless primitive: dotted-path read/create on plain objects, plus a
// JSON deep clone. No imports, no host, no feature. Plain objects only — stat_data is JSON-shaped.
//
// ONE implementation, so every feature that walks a stat_data path agrees on what "A.B.C" means.

// A segment that names an object's prototype plumbing is never a stat_data key. Walking one does not
// reach save data: `obj.__proto__` IS Object.prototype, so a create on `__proto__.x` writes `x` onto
// every object in the realm. These paths come from card-supplied text (an engine's declared roots, a
// pack's `state.force` and `state.forceFromInitVar`), so the walkers below refuse them instead of trusting
// every caller to.
// isPrototypeKey is the page's one spelling of the rule: the op check before MVU (json-patch-ops.js),
// menu patches, plugin state names and the other path readers all use it. The engine Worker keeps its
// own copy (logic-engine-core.js), because the Worker's module list is pinned.
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype'];
export const isPrototypeKey = (k) => PROTOTYPE_KEYS.includes(k);

// Read a dotted path. Returns undefined if any segment is missing, non-traversable, or a prototype key.
export function getPath(obj, dotted) {
    let cur = obj;
    for (const k of String(dotted).split('.')) {
        if (!cur || typeof cur !== 'object' || isPrototypeKey(k)) return undefined;
        cur = cur[k];
    }
    return cur;
}

// Read-or-create a dotted path, returning the container object.
// Returns null when a primitive or array blocks the way (never destroys what is there), or when a
// segment is a prototype key — checked for the WHOLE path before anything is created.
export function ensurePath(obj, dotted) {
    const segments = String(dotted).split('.');
    if (segments.some(isPrototypeKey)) return null;
    let cur = obj;
    for (const k of segments) {
        if (cur[k] === undefined) cur[k] = {};
        if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) return null;   // primitive/array in the way
        cur = cur[k];
    }
    return cur;
}

// JSON deep clone; primitives pass through untouched. An own "__proto__" key is DROPPED: JSON.parse
// keeps it as inert data, but a copy that assigns (Object.assign, a for…in loop) turns it back into a
// prototype swap. `constructor`/`prototype` are inert as own data keys, so they survive.
const dropProtoKey = (k, val) => (k === '__proto__' ? undefined : val);
export const deepClone = (v) => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v), dropProtoKey) : v;
