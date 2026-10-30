// card-config/card-config-flat-section.js — the GENERIC handler for a flat card-config section.
//
// A "flat section" is a per-card settings object whose payload is plain scalar fields (imagegen,
// roster, logicEngine). Every such section needs the same four operations — normalize, serialize,
// install, merge — and getting any of them subtly different per section is how the ownership rules
// drift apart. So the fields are declared ONCE, and all four operations are derived from that
// declaration. See plans/executed/card-config-sections-plan.md §3.
//
// THE THREE CATEGORIES (§1) — every field must be in exactly one:
//   cardOwned    the card determines it; REFRESHED from the card on every re-import (the button, or the
//                card's config changing). The user may edit it in between; the next re-import replaces it.
//   cardSeeded   a user preference. Seeded from the card on a first install, then PRESERVED — re-importing
//                must not silently re-enable something the user turned off. Refreshing shape is helpful;
//                refreshing behaviour is not.
//   neverTravels its meaning lives on the USER's machine (a connection UUID, a preset id, a path, a
//                debug switch). Stripped on import AND on export. The export half matters most: an
//                author who exports their working setup would otherwise ship THEIR machine's ids
//                inside the card, and a card that is out in the world cannot be recalled.
// A field mvu-helper no longer honours is declared in `retired` with the reason, so a card that still
// carries it is told to remove it, rather than being told it made a typo, and every re-import deletes it
// from the profile.
//
// Sections whose payload is ARRAYS MERGED BY IDENTITY (extraLlmCalls: calls by name, groups by tag)
// cannot be expressed as a flat field list — those keep a bespoke handler. §7.2.

// Coerce a raw JSON value to the declared type. Returns { ok, value } — a value that cannot be
// coerced is DROPPED and reported rather than written as-is: a card carrying "two" where a number
// belongs would otherwise land a string in the profile and break the feature far from here.
function coerce(value, type) {
    if (value === undefined || value === null) return { ok: false, why: 'no value' };
    if (type === 'boolean') {
        if (typeof value === 'boolean') return { ok: true, value };
        return { ok: false, why: 'expected true or false' };
    }
    if (type === 'number') {
        const n = Number(value);
        if (value === '' || !Number.isFinite(n)) return { ok: false, why: 'expected a number' };
        return { ok: true, value: n };
    }
    if (type === 'string') {
        if (typeof value === 'object') return { ok: false, why: 'expected a string' };
        return { ok: true, value: String(value) };
    }
    return { ok: false, why: `unsupported declared type "${type}"` };
}

// Build a section descriptor (the shape CARD_CONFIG_SECTIONS holds) from a field declaration.
//   key           the section name — identical to the per-card PROFILE key, so one vocabulary spans
//                 card JSON, settings and GUI (§6.1 #4).
//   cardOwned     { field: 'string'|'number'|'boolean' }
//   cardSeeded    { field: type }
//   neverTravels  ['field', …]  — declared (so it is not reported as unrecognised) but never carried.
//   retired       { field: 'why it is ignored' } — never imported; a card carrying it lands in report.retired,
//                 and a re-import deletes it from the profile.
export function flatSection({ key, cardOwned = {}, cardSeeded = {}, neverTravels = [], retired = {} }) {
    const ownedNames = Object.keys(cardOwned);
    const seededNames = Object.keys(cardSeeded);
    const retiredNames = Object.keys(retired);
    const types = { ...cardOwned, ...cardSeeded };
    const known = [...ownedNames, ...seededNames, ...neverTravels, ...retiredNames];

    return {
        key,
        cardOwned: ownedNames,
        cardSeeded: seededNames,
        neverTravels,
        known,

        // raw section from the card → only the fields we accept, coerced. Anything understood but not
        // imported goes to report.blocked WITH A REASON; anything unrecognised is left for the
        // caller's own unknown-key sweep (it owns the key list).
        normalize(raw, report) {
            const src = (raw && typeof raw === 'object') ? raw : {};
            const out = {};
            for (const field of [...ownedNames, ...seededNames]) {
                if (!(field in src)) continue;                      // absent ⇒ default (§6.1 #5) — never write one
                const r = coerce(src[field], types[field]);
                if (r.ok) out[field] = r.value;
                else report.blocked.push({ path: `${key}.${field}`, why: `${r.why} — the value was ignored` });
            }
            for (const field of neverTravels) {
                if (field in src) {
                    report.blocked.push({ path: `${key}.${field}`, why: 'this setting points at something on the local machine, so it cannot travel in a card — set it in the extension' });
                }
            }
            for (const field of retiredNames) {
                if (field in src) report.retired.push({ path: `${key}.${field}`, why: retired[field] });
            }
            return out;
        },

        // profile section → what the card may carry. neverTravels is absent BY CONSTRUCTION here, which
        // is the point: the leak is impossible to reintroduce by forgetting a filter at the call site.
        serialize(current) {
            const src = (current && typeof current === 'object') ? current : {};
            const out = {};
            for (const field of [...ownedNames, ...seededNames]) {
                if (src[field] === undefined) continue;
                const r = coerce(src[field], types[field]);
                if (r.ok) out[field] = r.value;
            }
            return out;
        },

        // INSTALL (a fresh profile) — the card seeds everything it carries, switches included. Fields it
        // does not carry keep whatever the feature's own defaults put there.
        install(current, incoming) {
            return { ...(current && typeof current === 'object' ? current : {}), ...(incoming || {}) };
        },

        // RE-IMPORT — refresh shape, preserve switches, never touch the machine-local fields, and delete the
        // retired names a profile saved before mvu-helper stopped reading them.
        // NOTE a cardSeeded field is preserved even on a profile this card has never seeded: there is
        // no way to tell "never seeded" from "seeded then changed", and defaulting to preserve can only
        // ever leave the user's own value alone. Seeding is the install path's job.
        merge(current, incoming) {
            const cur = (current && typeof current === 'object') ? current : {};
            const inc = (incoming && typeof incoming === 'object') ? incoming : {};
            const merged = { ...cur };
            const refreshed = [];
            for (const field of ownedNames) {
                if (!(field in inc)) continue;
                if (merged[field] === inc[field]) continue;
                merged[field] = inc[field];
                refreshed.push(field);
            }
            const deleted = retiredNames.filter((field) => field in merged);
            for (const field of deleted) delete merged[field];
            return { merged, summary: { refreshed, deleted } };
        },

        // Did a re-import of this section change anything worth telling the user about?
        describe(summary) {
            const parts = [];
            if (summary && summary.refreshed.length) parts.push(`refreshed ${summary.refreshed.join(', ')}`);
            if (summary && summary.deleted && summary.deleted.length) parts.push(`deleted ${summary.deleted.join(', ')} (no longer used)`);
            return parts.length ? `${key}: ${parts.join('; ')}` : '';
        },

        // "This section holds something the card would own" — half of the fresh-profile question
        // (card-config-core isFreshProfile). Only CARD-OWNED fields count: the feature defaults fill every
        // card-seeded field, so a seeded field holds a value on every profile and could never say "set up".
        // A blank string is "not set" — that is exactly the shipped default for every path field here.
        isConfigured(current) {
            const src = (current && typeof current === 'object') ? current : {};
            return ownedNames.some((f) => src[f] !== undefined && src[f] !== null && src[f] !== '');
        },

        // The card-owned fields this config carries, as profile paths ('imagegen.promptTemplate'). A profile
        // keeps the list of its last import, so the next one can tell which of them the card has dropped.
        carriedCardOwnedFields(incoming) {
            const inc = (incoming && typeof incoming === 'object') ? incoming : {};
            return ownedNames.filter((field) => field in inc).map((field) => `${key}.${field}`);
        },

        // A card-owned field the card dropped goes back to its built-in default: the field is removed here,
        // and the feature's profile defaults fill it back in on the next read (settings-store getProfile).
        clearCardOwnedField(current, path) {
            const merged = { ...((current && typeof current === 'object') ? current : {}) };
            delete merged[String(path).slice(key.length + 1)];
            return merged;
        },
    };
}
