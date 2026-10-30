// sillytavern/lorebook-core.js — PURE lorebook helpers (zero imports, zero globals), so they load under vitest.
// The I/O glue that reads ST/TavernHelper lives in sillytavern/lorebook.js and delegates the testable bits here
// (mirrors the small-llm/extra-llm-calls-core.js ↔ extra-llm-calls.js split).

// Normalize an EMBEDDED character_book entry array (card JSON shape) to the shape TavernHelper's
// getLorebookEntries returns, WITHOUT dropping any original field. The load-bearing mapping is
// `insertion_order → order`: selectLorebookEntries sorts routed PRE/POST blocks by `.order`, and the raw
// card entry only carries `.insertion_order`. Also aliases `id → uid`. Used by the race-free embedded
// fallback in getPrimaryLorebookEntries (when ST hasn't registered the standalone worldbook yet on chat load).
// A non-array input → [] (safe for "no character_book" / not-ready cases).
export function normalizeCharBookEntries(rawEntries) {
    if (!Array.isArray(rawEntries)) return [];
    return rawEntries.map((e) => {
        if (!e || typeof e !== 'object') return e;
        return {
            ...e,
            order: (e.order != null) ? e.order : e.insertion_order,
            uid: (e.uid != null) ? e.uid : e.id,
        };
    });
}

// WHATEVER WAS WRITTEN IN FRONT OF OUR NEEDLE STAYS IN FRONT.
//
// Callers rebuild a comment out of their own vocabulary — `[Initmvuhelper] mvu-helper card config`,
// `[POST2] mvu-llm-task:imagegen-charimg` — and that string is the whole comment they know about. A
// GameLogic Pack installs entries with an ownership marker ahead of it, so on a packed card the stored
// comment is `[GameLogicPack:school-v4] [Initmvuhelper] mvu-helper card config`. Writing the caller's bare
// comment back would silently strip the marker: the entry stops being pack-owned, survives an uninstall
// that reports itself EXACT, and comes back as a duplicate on the next activation — all from a routine
// card-config export that never mentioned packs.
//
// So on UPDATE (never on create), any text preceding the needle in the STORED comment is re-attached
// ahead of the caller's new one. One host rule, so no feature has to learn pack vocabulary to avoid
// destroying a marker it never wrote — the layer that added the marker is the layer that keeps it.
//
// Returns a partial field set to merge over the caller's ({} = leave the caller's comment alone):
//   • the caller passed no `comment`  — nothing to protect, the field merge keeps the stored one
//   • the needle sits at index 0      — there is no lead-in
//   • the caller already carried it   — a caller that DID read the stored comment is not double-prefixed
export function preserveCommentLeadIn(storedComment, needleLowercase, fields) {
    if (!fields || typeof fields.comment !== 'string') return {};
    const stored = String(storedComment || '');
    const at = stored.toLowerCase().indexOf(String(needleLowercase || ''));
    if (at <= 0) return {};
    const leadIn = stored.slice(0, at);
    const next = String(fields.comment);
    if (next.toLowerCase().startsWith(leadIn.toLowerCase())) return {};
    return { comment: leadIn + next };
}

