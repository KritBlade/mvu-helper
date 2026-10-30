/**
 * A CONSUMER THAT IS NOT SCHOOL V4 — the negative test's card
 * (plans/platform-genre-blindness.md §5, acceptance item 3).
 *
 * WHY THIS EXISTS: acceptance items 1 and 2 (the grep gate, and School v4 behaving identically) can
 * both pass while the platform is still quietly built around one genre. A grep only catches the
 * vocabulary somebody thought to list, and School passing proves nothing about a card that is not
 * School. Item 3 is the only check that can fail while the other two are green, and it needs a second
 * consumer to exist. Here is one.
 *
 * THE DESIGN RULE: it shares NOTHING with School v4 except the contracts a platform is entitled to
 * own. Deliberately absent — `World_Calc`, `Classmate`, `Mainchar`, `Is_present`, `check`/`mundane`/
 * `sceneAdvance`, and every other School channel. Deliberately PRESENT — an `Intent` root (the
 * event-pack format fixes the commit channel as `/Intent/<FIRE_INTENT>`, so a card wanting packs must
 * expose one) and an `EventPack-Paths:` header (the engine's own declaration channel).
 *
 * A salvage-hauler game: crew, contracts, a ledger. If a platform change ever needs THIS file edited
 * to keep passing, that edit is the finding — the platform learned something about a consumer again.
 */

// stat_data as this card seeds it. MVU #tuple shape [value, "Label"] throughout, same as any card.
export const STUB_STAT_DATA = {
    Ledger: {
        Credits: [1200, 'Credits'],
        Contracts: {},                          // the world log, this card's name for it
    },
    Crew: {                                     // the character collection — NOT "Classmate"
        Vasquez: { Name: ['Vasquez', 'Name'], Morale: [50, 'Morale'], onDeck: [true, 'On deck'] },
        Okonkwo: { Name: ['Okonkwo', 'Name'], Morale: [70, 'Morale'], onDeck: [false, 'On deck'] },
    },
    Flags: {
        Docked: [false, 'Docked'],              // this card's H-block latch equivalent
        JobArmed: ['', 'Armed job'],
    },
    Salvage: { jobs: {} },                      // its event-trigger table
    Intent: {                                   // TWO channels of its own, plus the pack format's
        salvage: ['', 'Salvage intent'],
        dock: ['', 'Dock intent'],
        eventFire: ['', 'Event fire'],
    },
};

// Its [Initmvuhelper] card config — the declaration channel that replaced mvu-helper's School defaults.
export const STUB_CARD_CONFIG = {
    version: 1,
    imagegen: {
        intimacyLatchPath: 'Flags.Docked',
        maincharRegistryKey: 'Vasquez',
    },
};

// Its engine bundle's stamped header — the same declaration shape School v4 uses, different paths.
// What this card's engine DECLARES about events — its own roots, in its own vocabulary. Shaped as
// the loader's per-scope `declared` record, which is what every event-pack site reads.
export const STUB_ENGINE_DECLARED = {
    version: 'v3.1', name: 'Salvage', type: 'Salvage',
    eventPack: {
        triggerRoot: 'Salvage.jobs',
        armedPath: 'Flags.JobArmed',
        writes: [{ path: 'Salvage.manifest' }],
        rewards: [{ name: 'scrap', path: 'Hold', fields: ['Scrap'] }],
        scopes: ['once', 'always'],
        format: '1.2',
    },
};

// The per-member presence field this card uses instead of the default `Is_present`.
export const STUB_PRESENCE_FIELD = 'onDeck';

// Everything School v4 calls its own. Nothing the platform produces for this card may contain any of
// it — asserted rather than eyeballed, because the failure mode is a plausible-looking wrong answer.
export const SCHOOL_VOCABULARY = [
    'World_Calc', 'Classmate', 'Mainchar', 'heroine', 'classmate',
    'EventArmed', 'IntimacyActive', 'ForceImageType', 'DataSyncVer',
    'sceneAdvance', 'newClassmate', 'armClassmate', 'daySwing', 'recordNPC',
];
