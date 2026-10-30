// shared/unknown-keys.js — "which keys of this object did I not understand?"
//
// Ownerless primitive (P3): both the card-config importer and the small-llm section handler need it,
// and neither owns it. It exists because a setting dropped in SILENCE is the worst import failure —
// the card author sets a value, nothing happens, and there is nothing to search for. Naming the key
// is what gives them a thread to pull.

// Keys of `obj` that are not in `known`, as [{ path, key }]. `path` is the caller's label for the
// object being inspected ('' ⇒ top level), so the report reads like a location. `skip` lists keys
// already reported by a MORE SPECIFIC channel (e.g. a retired field, which gets its own message) —
// being told the same key is both "no longer honoured" and "unrecognised" reads as two problems.
export function unknownKeysOf(obj, known, path, skip = []) {
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj)
        .filter((k) => !known.includes(k) && !skip.includes(k))
        .map((k) => ({ path: path ? `${path}.${k}` : k, key: k }));
}
