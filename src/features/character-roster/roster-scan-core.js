// character-roster/roster-scan-core.js — PURE stat_data roster discovery (no ST imports).
// Tested by tests/roster-scan-core.test.js.
//
// The cast collection is named per-genre (School "Classmate", Love "Partner", RPG "Familiar", a
// Chinese card "关系列表", …), so this file never hardcodes one. It detects the collection by SHAPE —
// "the top-level stat_data object whose children are presence-bearing records" — and a
// caller-supplied override wins outright.
//
// TWO caller overrides (both optional):
//   • overrideKey    — the collection key. A leading "stat_data." is tolerated, so
//                      "Partner" and "stat_data.Partner" both resolve to the bare key.
//   • presenceField  — the per-member boolean field name. Drives BOTH auto-discovery (which
//                      children count as records) and the present-check.
//
// ── WHY "Is_present" IS A DEFAULT AND NOT A GENRE-BLINDNESS VIOLATION ────────────────────────
// It looks like one: School v4 uses that exact field name, and platform code must never encode a
// consumer's vocabulary (plans/platform-genre-blindness.md). The distinction is WHO DECLARES IT.
// "Is_present" is a name MVU-HELPER PUBLISHES — the presence-field convention a card MAY adopt to
// get auto-discovery for free — in the same posture as the `Intent` namespace: the platform states
// the contract, consumers opt in, and a consumer that names it otherwise says so (the Present flag
// box, or a card-config roster block once card-config-sections.js:75 is built). School v4 is a card
// that adopted the convention, not the card this default was copied from.
//
// A NAME CANNOT BE DROPPED HERE, only declared. Shape alone is not enough to find the cast: a
// quest log, an inventory and a news feed are all records-of-records too (live: the Chinese card's
// 任务列表 sits beside 关系列表 and is structurally identical). The presence field IS the
// discriminator, so auto-discovery needs SOME field name — a published one is the honest form.
//
// WHAT THE DEFAULT MUST NOT DO is silently shrink the cast on a card that renamed the field. It
// used to: `allCharKeys` filtered through the same presence probe, so "all characters" came back
// EMPTY whenever the field was blank or named differently — even with the collection set
// explicitly — which silently killed the char= typo warnings in image-gen.js. An explicitly
// declared collection is now ENUMERATED (Object.keys), per the shared CLAUDE.md L2 rule
// "consumers declare configuration; platforms read/enumerate it dynamically". Presence gates
// presentCharKeys ONLY, which is the one answer that genuinely requires the field.

import { unwrapTupleValue } from '../../shared/mvu-tuple.js';

// MVU stores every field as a #tuple `[value, "Label"]`; shared/mvu-tuple.js reads its value.
//
// The published presence-field name. Callers pass '' to mean "use the convention".
export const DEFAULT_PRESENCE_FIELD = 'Is_present';

// A "character record": an object (not array) with the presence field present.
function isCharRecord(v, presenceField) {
    return v && typeof v === 'object' && !Array.isArray(v)
        && Object.prototype.hasOwnProperty.call(v, presenceField);
}

// Normalize a collection override: trim + strip a leading "stat_data." so "Partner",
// "stat_data.Partner", and " stat_data.Classmate " all resolve to the bare top-level key.
function normalizeCollectionKey(overrideKey) {
    return String(overrideKey == null ? '' : overrideKey).trim().replace(/^stat_data\./i, '');
}

// Is this collection key EXPLICITLY declared (as opposed to auto-discovered)? An explicit key is a
// statement by the user/card that this object is the cast — so its members are members, whether or
// not they carry the presence field.
function resolveExplicitCollection(statData, overrideKey) {
    const ov = normalizeCollectionKey(overrideKey);
    if (!ov) return null;
    const v = statData && statData[ov];
    return (v && typeof v === 'object' && !Array.isArray(v)) ? ov : null;
}

// The collection KEY in stat_data, or null. `overrideKey` wins if it names a real object
// (a leading "stat_data." is tolerated). `presenceField` ('' → the published default) is the record
// shape used for auto-discovery. Ties broken by first-seen (Object.entries = insertion order).
export function findCharacterCollection(statData, overrideKey, presenceField) {
    const sd = statData && typeof statData === 'object' ? statData : {};
    const field = presenceField || DEFAULT_PRESENCE_FIELD;
    const explicit = resolveExplicitCollection(sd, overrideKey);
    if (explicit) return explicit;
    let best = null;
    let bestCount = 0;
    for (const [k, v] of Object.entries(sd)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        let count = 0;
        for (const child of Object.values(v)) if (isCharRecord(child, field)) count++;
        if (count > bestCount) { bestCount = count; best = k; }
    }
    return best;
}

// All character keys in the collection.
//
// EXPLICIT COLLECTION ⇒ ENUMERATE IT (CLAUDE.md L2). The presence field is a DISCOVERY probe, not a
// membership test: once the user has named the collection, filtering its members by a field they may
// have renamed — or that their card simply does not have — answers "who is in the cast?" with an
// empty list and no complaint. That is what silently killed the char= typo warnings in image-gen.js
// on every card with a blank Present flag.
// AUTO-DISCOVERED COLLECTION ⇒ still filter. The probe is the only reason we believe that object is
// the cast at all, so its non-record children (a `$meta`, a settings blob) are not members.
export function allCharKeys(statData, overrideKey, presenceField) {
    const field = presenceField || DEFAULT_PRESENCE_FIELD;
    const col = findCharacterCollection(statData, overrideKey, field);
    if (!col) return [];
    const coll = statData[col] || {};
    const keys = Object.keys(coll).filter((k) => coll[k] && typeof coll[k] === 'object' && !Array.isArray(coll[k]));
    if (resolveExplicitCollection(statData, overrideKey)) return keys;
    return keys.filter((k) => isCharRecord(coll[k], field));
}

// Character keys whose presence field unwraps to true. THE ONE ANSWER THAT GENUINELY NEEDS THE
// FIELD — a card that does not carry it has no presence to report, and [] is the honest answer
// (image-gen logs the empty-anchor case rather than pretending nobody is on screen).
export function presentCharKeys(statData, overrideKey, presenceField) {
    const field = presenceField || DEFAULT_PRESENCE_FIELD;
    const col = findCharacterCollection(statData, overrideKey, field);
    if (!col) return [];
    const coll = statData[col] || {};
    return Object.keys(coll).filter((k) => isCharRecord(coll[k], field) && unwrapTupleValue(coll[k][field]) === true);
}
