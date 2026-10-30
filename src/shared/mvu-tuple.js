// shared/mvu-tuple.js — MVU's ValueWithDescription tuple, `[value, "Label"]`, read as its value.
//
// Ownerless primitive (P3): the roster scan, the side panel and the stat box all read stat_data
// fields that may be stored either bare or as this tuple, and none of them owns the shape — MVU does.

// Only the exact two-slot shape with a string label unwraps: a plain list is data, not a wrapper.
export function unwrapTupleValue(v) {
    return (Array.isArray(v) && v.length === 2 && typeof v[1] === 'string') ? v[0] : v;
}
