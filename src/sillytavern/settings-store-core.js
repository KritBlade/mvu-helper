// sillytavern/settings-store-core.js — the PURE half of settings-store.js (L6: the decision lives
// where a test can reach it; the host-coupled file next door does the reading and writing). Two
// decisions live here: WHICH record getProfile() hands back (profileRecordFor), and how a stored
// record gains the keys added since it was made (fillMissingDefaults).
//
// THE BACKFILL. `loadSettings` deep-merges GLOBAL defaults into an existing settings record, so a
// new global knob reaches everybody. PROFILE defaults never got that: they are stashed and cloned for
// records that do not exist yet, so an EXISTING per-card profile never gains a new key. Every feature
// that added a profile sub-object worked around it by hand — `getImagegenProfile`, `getRosterProfile`,
// `getLogicEngineProfile` and `getProfile` itself each open with a block of
// `if (typeof x.y !== '<type>') x.y = default`, and one of them names the practice outright ("the
// imagegen idiom"). Four copies of one job is the duplication the repo's own rule warns about, and the
// next feature would have written a fifth.
//
// SCOPE — this closes the FILL half only, and that split is the point:
//   • fill a MISSING key            → fully generic, this file
//   • repair a WRONG-TYPED value    → stays hand-written: nothing here can know that `insertType` must
//                                     be one of INSERT_TYPE, or `route` one of two strings
//   • a one-off RENAME migration    → stays hand-written (imagegen's stripTagAfterGenerate)
// So a NEW field needs no defensive code at all unless it carries an enum.

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    try { return structuredClone(value); } catch (e) { void e; return JSON.parse(JSON.stringify(value)); }
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

/**
 * The record getProfile() hands back. A profile belongs to a CARD, so with a card open it is that
 * card's stored record, created from `defaults` on first use.
 *
 * With NO card open it is a FROZEN copy of `defaults` that is never stored. That is SillyTavern's
 * lobby, where the panels still paint and read a profile: at boot `name2` is "SillyTavern System",
 * after a chat closes it is "Assistant", and between the two it can be empty. Storing a record for
 * those names saves a profile no card ever reads, and it collects every later default without ever
 * being re-imported. The copy is frozen because a write to it is saved nowhere: the settings panel's
 * card gate keeps every per-card control out of reach in the lobby, so a write that still arrives is a
 * missed gate, and it throws (strict mode) where the console names it instead of vanishing. Reading is
 * unaffected, and every repair getProfile and the feature accessors run is a no-op on the template.
 *
 * @returns {object} the stored record (card open) or a fresh frozen copy (no card)
 */
export function profileRecordFor(profiles, key, defaults, { isCardOpen }) {
    if (!isCardOpen) return deepFreeze(clone(defaults));
    if (!profiles[key]) profiles[key] = clone(defaults);
    return profiles[key];
}

/**
 * Recursively add keys that `defaults` has and `target` lacks. NEVER changes a value that is already
 * present — including a falsy one, which is the whole discipline here: `false`, `0` and `''` are
 * answers a user chose, and a backfill that "corrects" them is a settings reset wearing a helpful face.
 * `undefined` is the only thing treated as absent.
 *
 * Arrays are LEAVES: a missing one is cloned whole, a present one is left exactly as it is. Merging
 * element-wise would resurrect list entries the user deleted.
 *
 * Where `defaults` holds an object but `target` holds a scalar, the scalar is LEFT ALONE — that is a
 * wrong-typed value, which is a validator's job, not this one's. Silently replacing it here would hide
 * the corruption the hand-written checks exist to catch.
 *
 * @returns {number} how many keys were filled — so the caller can say so once instead of guessing.
 */
export function fillMissingDefaults(target, defaults) {
    if (!isPlainObject(target) || !isPlainObject(defaults)) return 0;
    let filled = 0;
    for (const key of Object.keys(defaults)) {
        const def = defaults[key];
        if (target[key] === undefined) {
            target[key] = clone(def);
            filled += 1;
        } else if (isPlainObject(def) && isPlainObject(target[key])) {
            filled += fillMissingDefaults(target[key], def);
        }
    }
    return filled;
}
