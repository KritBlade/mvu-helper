// character-roster/roster-settings-core.js — the PURE half of the roster's per-card settings: the template every
// card profile starts from, and the repair its accessor runs (roster-settings.js getRosterProfile reads the live
// profile and hands it here). Pure, so a test runs the repair against the lobby's frozen copy.

// PER-CARD roster defaults — merged into profileDefaults by index.js.
export const rosterProfileDefaults = {
    roster: {
        // How new characters enter the DNA registry.
        //   'predefined' = the card author authors the entries (Route A)
        //   'harvest'    = the story describes each NEW character once, we store it (Route B)
        route: 'harvest',
        // stat_data roster-collection override ('' = auto-discover by presence-field shape;
        // a leading "stat_data." is tolerated). Consumed by roster-scan-core.
        charCollection: '',
        // per-member presence field name ('' = the 'Is_present' default); e.g. 'inHere' for a card
        // that renamed it — drives BOTH auto-discovery and the on-screen present-check.
        presenceField: '',
    },
};

// This card's roster block, its present-but-wrong-typed fields repaired (a profile created before the block
// existed has no `roster` key). On a valid block, the template included, it writes nothing: in the lobby the
// profile is frozen (sillytavern/settings-store-core.js profileRecordFor).
export function rosterProfileOf(p) {
    const d = rosterProfileDefaults.roster;
    if (!p.roster || typeof p.roster !== 'object') p.roster = structuredClone(d);
    const r = p.roster;
    if (r.route !== 'predefined' && r.route !== 'harvest') r.route = d.route;
    if (typeof r.charCollection !== 'string') r.charCollection = d.charCollection;
    if (typeof r.presenceField !== 'string') r.presenceField = d.presenceField;
    return r;
}
