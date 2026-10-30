// card-config/card-config-whole-section.js — the handler for a card-config section the CARD owns whole.
//
// A whole section is one card-owned field (statBox, leadText): nothing in it describes the user's machine, so the
// card's normalized section replaces the profile's on install and on every re-import. The feature's own pure file
// supplies normalize, serialize and isConfigured; the ownership rules are derived here, once, so no two whole
// sections can disagree on them.
//   • install / merge  — a card that carries the section sets it; a card without it leaves the profile's as is.
//   • a card that DROPS it — its last import carried the section and this one does not — clears it to null
//     (card-config-core mergeCardConfigSections, through carriedCardOwnedFields and clearCardOwnedField).
export function wholeCardOwnedSection({ key, normalize, serialize, isConfigured }) {
    const kept = (current) => (current === undefined ? null : current);
    return {
        key,
        normalize,
        serialize,
        install: (current, incoming) => (isConfigured(incoming) ? incoming : kept(current)),
        merge(current, incoming) {
            if (!isConfigured(incoming)) return { merged: kept(current), summary: { refreshed: false } };
            return { merged: incoming, summary: { refreshed: JSON.stringify(current) !== JSON.stringify(incoming) } };
        },
        describe: (summary) => (summary && summary.refreshed ? `${key}: refreshed from the card` : ''),
        isConfigured,
        carriedCardOwnedFields: (incoming) => (isConfigured(incoming) ? [key] : []),
        clearCardOwnedField: () => null,
    };
}
