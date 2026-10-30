// tests/card-artifact-store.test.js — the machinery every card-level artifact shares: needles, registry
// text, the LED, the identity record, and the one rule every lane's card row, install toast and adopt
// question follow.

import { describe, it, expect } from 'vitest';
import {
    LIBRARY_BOOK_NAME, ARTIFACT_TYPES,
    libraryEntryComment, libraryEntryMatch, parseLibraryComment,
    findEntryByNeedle, commentsMatchingNeedle,
    parseRegistryJson, buildRegistryText,
    installedSweepNeedle, commentMatchesNeedle, sectionEntryComment, preDeleteNeedles, uninstallExactness, registryRemovalOutcome, deriveArtifactLed, slotFingerprint, ARTIFACT_ROLES,
    entryFieldsDiffer, plannedEntriesChanged, artifactIdentityRecord,
    installActionDone, cardRowInstallButtons, adoptQuestion, downgradeQuestion, libraryRemoveQuestion, pluginFlavorSummary, pluginFlavorLine, artifactRowStatus, decideCardRow, PLUGIN_FLAVOR_GAME_BOUND, PLUGIN_FLAVOR_STANDALONE, cardGroupStop } from '../src/shared/card-artifact-store.js';
import { isVersionString, compareVersions } from '../src/shared/version-compare.js';

describe('artifactIdentityRecord — W7, one shape for the write and the read', () => {
    it('always emits name/description/format; optionals only when the source declares them', () => {
        const full = artifactIdentityRecord({ name: 'N', description: 'D', format: '1.0', builtWith: 'B', targetsPackId: 'rpg' });
        expect(full).toEqual({ name: 'N', description: 'D', format: '1.0', builtWith: 'B', targetsPackId: 'rpg' });
        const bare = artifactIdentityRecord({ name: 'N' });
        expect(bare).toEqual({ name: 'N', description: '', format: '' });
        expect('builtWith' in bare).toBe(false);
        expect('targetsPackId' in bare).toBe(false);
    });
    it('junk in, empty identity out — a pre-W7 registry object is not an error', () => {
        expect(artifactIdentityRecord(null)).toEqual({ name: '', description: '', format: '' });
        expect(artifactIdentityRecord(42)).toEqual({ name: '', description: '', format: '' });
    });
});

describe('library naming — four artifact types share ONE root-level book', () => {
    it('names the book and every type prefix', () => {
        expect(LIBRARY_BOOK_NAME).toBe('MVU_GameLogic_Library');
        expect(ARTIFACT_TYPES).toEqual(['gamelogic', 'statusmenu', 'plugin', 'eventpack']);
        expect(libraryEntryComment('eventpack', 'paulk.beacharc')).toBe('[EventPack:paulk.beacharc]');
        expect(libraryEntryMatch('eventpack', 'PaulK.BeachArc')).toBe('[eventpack:paulk.beacharc]');
    });

    it('every type round-trips comment → parse', () => {
        for (const t of ARTIFACT_TYPES) {
            expect(parseLibraryComment(libraryEntryComment(t, 'some-id'))).toEqual({ packType: t, id: 'some-id' });
        }
    });

    it('a card-book bookkeeping entry is NOT an artifact — [*:Registry] would list a phantom pack', () => {
        for (const t of ARTIFACT_TYPES) expect(parseLibraryComment(libraryEntryComment(t, 'Registry'))).toBeNull();
    });

    it('refuses comments that are not library entries at all', () => {
        expect(parseLibraryComment('Worldview')).toBeNull();
        expect(parseLibraryComment('[MVU_LogicEngine]')).toBeNull();          // not a TYPE prefix
        expect(parseLibraryComment('[MVU_Event_Pack] paulk.arc')).toBeNull(); // an INSTALLED entry, not a library one
        expect(parseLibraryComment('[GameLogicPack:no-close')).toBeNull();
        expect(parseLibraryComment('[GameLogicPlugin:rpg:Engine]')).toBeNull();   // a SECTION entry, not an artifact with id "rpg:Engine"
    });
});

describe('findEntryByNeedle — the 2026-08-14 outage: match ANYWHERE, not at the head', () => {
    const entries = [
        { comment: '[GameLogicPack:school-v4] [PRE1] roll gate', content: 'a' },
        { comment: '[MVU_Event_Pack] paulk.arc', content: 'b' },
        { comment: 'plain user note', content: 'c' },
    ];

    it('finds an entry whose needle sits AFTER an installer prefix', () => {
        // This is the live failure: installing a pack prefixed every comment, and every reader that
        // matched the head went silently dead (call routing) or dead-but-masked (roster DNA).
        expect(findEntryByNeedle(entries, '[pre1]').content).toBe('a');
    });

    it('is case-insensitive and takes the FIRST match', () => {
        expect(findEntryByNeedle(entries, '[MVU_Event_Pack]'.toLowerCase()).content).toBe('b');
        expect(findEntryByNeedle(entries, '[').content).toBe('a');
    });

    it('null for no match, a null/empty needle, or a non-array', () => {
        expect(findEntryByNeedle(entries, '[nope]')).toBeNull();
        expect(findEntryByNeedle(entries, '')).toBeNull();       // an empty needle matching everything is a landmine
        expect(findEntryByNeedle(null, '[pre1]')).toBeNull();
    });

    it('survives entries with no comment at all', () => {
        expect(findEntryByNeedle([{ content: 'x' }, { comment: null }, ...entries], '[pre1]').content).toBe('a');
    });
});

describe('commentsMatchingNeedle — the sweep READ agrees with the sweep DELETE', () => {
    const entries = [
        { comment: '[GameLogicPack:school-v4] [PRE1]' },
        { comment: 'MY NOTE — [GameLogicPack:school-v4] [PRE2]' },   // hand-edited: prefix mid-string
        { comment: '[GameLogicPack:school-v40] [PRE3]' },            // a DIFFERENT pack
    ];

    it('catches the hand-edited comment the old startsWith read missed', () => {
        const swept = commentsMatchingNeedle(entries, installedSweepNeedle('gamelogic', 'school-v4'));
        expect(swept).toEqual([
            '[GameLogicPack:school-v4] [PRE1]',
            'MY NOTE — [GameLogicPack:school-v4] [PRE2]',
        ]);
        // deleteLorebookEntriesByNeedle removes BOTH. Counting only the first is how the V3 exactness
        // report came to certify "counts agree" while quietly deleting an unrecorded entry.
        expect(swept.length).toBe(2);
    });

    it('returns comments VERBATIM — the exactness compare is against the registry\'s own strings', () => {
        expect(commentsMatchingNeedle([{ comment: '[GameLogicPack:RPG] X' }], '[gamelogicpack:rpg] '))
            .toEqual(['[GameLogicPack:RPG] X']);
    });

    it('[] for an empty needle or a non-array', () => {
        expect(commentsMatchingNeedle(entries, '')).toEqual([]);
        expect(commentsMatchingNeedle(undefined, '[x]')).toEqual([]);
    });
});

describe('registry text — one format, two different empties', () => {
    it('strips # header lines and parses the JSON below them', () => {
        expect(parseRegistryJson('# a header\n# another\n{"x":{"ver":"1.0"}}')).toEqual({ x: { ver: '1.0' } });
    });

    it('whenEmpty is the CALLER\'s decision — a map empties to {}, a single record to null', () => {
        expect(parseRegistryJson('# only a header\n', { whenEmpty: '{}' })).toEqual({});
        expect(parseRegistryJson('# only a header\n', { whenEmpty: 'null' })).toBeNull();
        expect(parseRegistryJson('')).toEqual({});   // the default is the map shape
    });

    it('THROWS on malformed JSON — a broken registry must never read as "nothing installed"', () => {
        expect(() => parseRegistryJson('{ "x": ')).toThrow();
        expect(() => parseRegistryJson('# hdr\nnot json')).toThrow();
    });

    it('buildRegistryText round-trips, and names the tab a hand-editor must go to', () => {
        const text = buildRegistryText('[MVU_Event_Pack_Registry]', 'EventPack', { a: { ver: '1.0' } });
        expect(text.split('\n')[0]).toBe('# [MVU_Event_Pack_Registry] — tab-owned pack registry. Do not hand-edit; use the EventPack tab.');
        expect(parseRegistryJson(text)).toEqual({ a: { ver: '1.0' } });
        expect(parseRegistryJson(buildRegistryText('[GameLogicPack:Registry]', 'GameLogic Packs', null), { whenEmpty: 'null' })).toEqual({});
    });
});

describe('uninstall needles', () => {
    const sweep = (id) => installedSweepNeedle('gamelogic', id);
    const hits = (comment, id) => commentMatchesNeedle(comment, sweep(id));

    it('commentMatchesNeedle: a string needle is a lowercase substring; empty matches nothing', () => {
        expect(commentMatchesNeedle('[GameLogicPack:rpg] X', '[gamelogicpack:rpg] x')).toBe(true);
        expect(commentMatchesNeedle('[GameLogicPack:rpg] X', 'RPG]')).toBe(true);
        expect(commentMatchesNeedle('[GameLogicPack:rpg] X', '')).toBe(false);
        expect(commentMatchesNeedle(undefined, '[x]')).toBe(false);
    });

    it('the sweep is bounded by "]" OR ":" after the id, so a short id cannot sweep a longer one', () => {
        expect(hits('[GameLogicPack:rpg] Worldview', 'rpg')).toBe(true);          // a prompt entry
        expect(hits('[GameLogicPack:rpg:Panel]', 'rpg')).toBe(true);              // a section entry
        expect(hits('[GameLogicPack:rpg-artific] Worldview', 'rpg')).toBe(false);
        expect(hits('[GameLogicPack:rpg-artific:Panel]', 'rpg')).toBe(false);
        expect(hits('[GameLogicPack:rpg-artific] Worldview', 'rpg-artific')).toBe(true);
        expect(hits('[GameLogicPack:rpg-artific:Panel]', 'rpg-artific')).toBe(true);
    });

    it('is case-insensitive and matches anywhere — the hand-edited lead-in case', () => {
        expect(hits('[GAMELOGICPACK:RPG] X', 'rpg')).toBe(true);
        expect(hits('my note [GameLogicPack:rpg] X', 'rpg')).toBe(true);
    });

    it('escapes the id — an event pack id carries dots, and "." must not read as "any character"', () => {
        expect(commentMatchesNeedle('[EventPack:paulk.arc] x', installedSweepNeedle('eventpack', 'paulk.arc'))).toBe(true);
        expect(commentMatchesNeedle('[EventPack:paulkXarc] x', installedSweepNeedle('eventpack', 'paulk.arc'))).toBe(false);
    });

    it('is stateless across calls — no g flag, so .test never remembers a lastIndex', () => {
        const m = sweep('rpg');
        for (let i = 0; i < 3; i += 1) expect(commentMatchesNeedle('[GameLogicPack:rpg] a', m)).toBe(true);
    });

    it('the section entry every lane writes is INSIDE the sweep and OUTSIDE the library parser', () => {
        for (const t of ['gamelogic', 'statusmenu', 'plugin']) {
            const comment = sectionEntryComment(t, 'rpg', 'Engine');
            expect(comment).toBe(libraryEntryComment(t, 'rpg').slice(0, -1) + ':Engine]');
            expect(commentMatchesNeedle(comment, installedSweepNeedle(t, 'rpg'))).toBe(true);
            expect(commentMatchesNeedle(comment, installedSweepNeedle(t, 'rp'))).toBe(false);
            expect(parseLibraryComment(comment)).toBeNull();
        }
    });

    it('preDeleteNeedles pairs the RECORDED comments (lowercased) with the sweep matcher', () => {
        const n = preDeleteNeedles({ installedComments: ['[GameLogicPack:School-V4] [PRE1]'] }, 'gamelogic', 'school-v4');
        expect(n.recorded).toEqual(['[gamelogicpack:school-v4] [pre1]']);
        expect(n.sweep).toBeInstanceOf(RegExp);
        expect(n.sweep).toEqual(sweep('school-v4'));
    });

    it('no registry at all still yields the sweep — the belt-and-braces half stands alone', () => {
        expect(preDeleteNeedles(null, 'eventpack', 'paulk.arc')).toEqual({ recorded: [], sweep: installedSweepNeedle('eventpack', 'paulk.arc') });
    });

    it('exactness names BOTH directions of disagreement', () => {
        expect(uninstallExactness(['a', 'b'], ['b', 'a']).agree).toBe(true);
        expect(uninstallExactness(['a', 'b'], ['a'])).toEqual({ agree: false, onlyInRecord: ['b'], onlyInSweep: [] });
        expect(uninstallExactness(['a'], ['a', 'stray'])).toEqual({ agree: false, onlyInRecord: [], onlyInSweep: ['stray'] });
    });
});

describe('deriveArtifactLed — order IS the decision', () => {
    const led = (o) => deriveArtifactLed(o).state;

    it('grey when not installed on this card', () => {
        expect(led({ inLibrary: true, isActive: false, recordedComments: [], presentComments: [] })).toBe('grey');
    });

    it('green when installed, enabled, intact and in the library', () => {
        expect(led({ inLibrary: true, isActive: true, recordedComments: ['a'], presentComments: ['a', 'other'] })).toBe('green');
    });

    it('red when a recorded piece is gone — and it names which', () => {
        const r = deriveArtifactLed({ inLibrary: true, isActive: true, recordedComments: ['a', 'b'], presentComments: ['a'] });
        expect(r).toEqual({ state: 'red', missing: ['b'], missingRegexes: [], drifted: [] });
    });

    it('MISSING beats DISABLED — a pack with pieces gone cannot run even if re-enabled', () => {
        expect(led({ inLibrary: true, isActive: true, isEnabled: false, recordedComments: ['a'], presentComments: [] })).toBe('red');
    });

    it('DISABLED beats the library question — a switched-off pack\'s missing source is not the news', () => {
        expect(led({ inLibrary: false, isActive: true, isEnabled: false, recordedComments: ['a'], presentComments: ['a'] })).toBe('grey');
    });

    it('amber = running fine, library copy gone (still uninstallable from the UI)', () => {
        expect(led({ inLibrary: false, isActive: true, recordedComments: ['a'], presentComments: ['a'] })).toBe('amber');
    });

    it('isEnabled defaults TRUE so the pack lane\'s three-fact call is unchanged by the move', () => {
        expect(led({ inLibrary: true, isActive: true, recordedComments: [], presentComments: [] })).toBe('green');
    });
});

describe('deriveArtifactLed — the REGEX dimension (§11a)', () => {
    const base = { inLibrary: true, isActive: true, recordedComments: ['a'], presentComments: ['a'] };

    // THE GAP THIS CLOSES. A pack installs regexes as well as entries; one deleted by hand in ST's
    // regex editor left the LED green while the game silently stopped hiding a block — the exact
    // failure the regex exists to prevent, made invisible.
    it('red when a recorded REGEX is gone, even though every entry is present', () => {
        const r = deriveArtifactLed({ ...base, recordedRegexNames: ['HideChoices', 'HideFirstFloor'], presentRegexNames: ['HideFirstFloor'] });
        expect(r.state).toBe('red');
        expect(r.missingRegexes).toEqual(['HideChoices']);
        expect(r.missing).toEqual([]);           // the ENTRIES are fine — do not blame them
    });

    it('green when every entry AND every regex is present', () => {
        const r = deriveArtifactLed({ ...base, recordedRegexNames: ['HideChoices'], presentRegexNames: ['HideChoices', 'SomeoneElses'] });
        expect(r.state).toBe('green');
        expect(r.missingRegexes).toEqual([]);
    });

    // Two lists out, never one: they are fixed in different places (the book vs ST's regex editor), so
    // folding them together would make the UI name a "missing entry" that was never an entry.
    it('keeps the two kinds of missing piece in SEPARATE lists', () => {
        const r = deriveArtifactLed({
            inLibrary: true, isActive: true,
            recordedComments: ['a', 'b'], presentComments: ['a'],
            recordedRegexNames: ['X'], presentRegexNames: [],
        });
        expect(r.missing).toEqual(['b']);
        expect(r.missingRegexes).toEqual(['X']);
    });

    // "COULD NOT LOOK" ≠ "NOT THERE". TavernHelper's regex API attaches after mvu-helper loads, so an
    // unreadable surface reports an EMPTY present-list — which against a full record would turn every
    // LED red on every reload. The regex half is SKIPPED, not failed.
    it('SKIPS the regex half when the API is unreadable, instead of reporting everything missing', () => {
        const r = deriveArtifactLed({ ...base, recordedRegexNames: ['HideChoices'], presentRegexNames: [], regexReadable: false });
        expect(r.state).toBe('green');
        expect(r.missingRegexes).toEqual([]);
    });

    it('but a readable-and-empty surface DOES report them missing — that is a real deletion', () => {
        const r = deriveArtifactLed({ ...base, recordedRegexNames: ['HideChoices'], presentRegexNames: [], regexReadable: true });
        expect(r.state).toBe('red');
    });

    // Order still holds: a pack with pieces gone cannot run even if re-enabled, and that stays true
    // whichever surface the missing piece is on.
    it('a missing REGEX beats DISABLED, exactly as a missing entry does', () => {
        const r = deriveArtifactLed({ ...base, isEnabled: false, recordedRegexNames: ['X'], presentRegexNames: [] });
        expect(r.state).toBe('red');
    });

    // The three artifact types that ship no regexes pass none of these arguments and must be untouched.
    it('an artifact that records no regexes is unaffected', () => {
        expect(deriveArtifactLed(base)).toEqual({ state: 'green', missing: [], missingRegexes: [], drifted: [] });
    });

    it('not installed is still grey, regexes or not', () => {
        expect(deriveArtifactLed({ isActive: false, recordedRegexNames: ['X'], presentRegexNames: [] }).state).toBe('grey');
    });
});

// The engine and schema slots: one named piece each, filled by the install and by other writers (the Development tab's
// uploads, Remove engine, a plugin's schema, a hand edit). Gone is a missing piece; another writer's copy is drift.
describe('deriveArtifactLed — the OWNED SLOT dimension', () => {
    const base = { inLibrary: true, isActive: true, recordedComments: ['a'], presentComments: ['a'] };
    const engine = (extra) => ({ name: '[Engine]', isOwned: true, recordedFingerprint: slotFingerprint('engine v1'), text: 'engine v1', ...extra });

    it('slotFingerprint: one text gives one fingerprint, another text another', () => {
        expect(slotFingerprint('engine v1')).toBe(slotFingerprint('engine v1'));
        expect(slotFingerprint('engine v1')).not.toBe(slotFingerprint('engine v2'));
    });

    it('the copy the install recorded is green, with nothing drifted', () => {
        expect(deriveArtifactLed({ ...base, ownedSlots: [engine()] })).toEqual({ state: 'green', missing: [], missingRegexes: [], drifted: [] });
    });

    it('MUTATION TARGET — an owned slot that is EMPTY is a missing piece: red, and named', () => {
        const r = deriveArtifactLed({ ...base, ownedSlots: [engine({ text: null })] });
        expect(r.state).toBe('red');
        expect(r.missing).toEqual(['[Engine]']);
    });

    it("MUTATION TARGET — another writer's copy has DRIFTED: named, and the state does not change", () => {
        const r = deriveArtifactLed({ ...base, ownedSlots: [engine({ text: 'engine from the dev upload' })] });
        expect(r.state).toBe('green');
        expect(r.drifted).toEqual(['[Engine]']);
        expect(r.missing).toEqual([]);
    });

    it('MUTATION TARGET — could not look (undefined) is skipped, never missing and never drifted', () => {
        expect(deriveArtifactLed({ ...base, ownedSlots: [engine({ text: undefined })] })).toEqual({ state: 'green', missing: [], missingRegexes: [], drifted: [] });
    });

    it('a slot the install does not own is not its to judge, empty or replaced', () => {
        expect(deriveArtifactLed({ ...base, ownedSlots: [engine({ isOwned: false, text: null }), engine({ isOwned: false, text: 'x' })] }).state).toBe('green');
    });

    it('a record with no fingerprint matches no text, so its slot reads as drifted until an install records one', () => {
        expect(deriveArtifactLed({ ...base, ownedSlots: [engine({ recordedFingerprint: '' })] }).drifted).toEqual(['[Engine]']);
        expect(deriveArtifactLed({ ...base, ownedSlots: [engine({ recordedFingerprint: undefined })] }).drifted).toEqual(['[Engine]']);
    });

    it('drift rides beside the other states: red with a missing entry, amber without a library copy', () => {
        const red = deriveArtifactLed({ ...base, presentComments: [], ownedSlots: [engine({ text: 'other' })] });
        expect(red).toEqual({ state: 'red', missing: ['a'], missingRegexes: [], drifted: ['[Engine]'] });
        const amber = deriveArtifactLed({ ...base, inLibrary: false, ownedSlots: [engine({ text: 'other' })] });
        expect(amber).toEqual({ state: 'amber', missing: [], missingRegexes: [], drifted: ['[Engine]'] });
    });

    it('not installed is grey with nothing to report, slots or not', () => {
        expect(deriveArtifactLed({ isActive: false, ownedSlots: [engine({ text: null })] })).toEqual({ state: 'grey', missing: [], missingRegexes: [], drifted: [] });
    });
});

describe('ARTIFACT_ROLES - the one definition of what the four artifacts ARE', () => {
    // There was no such definition, and the gap showed: every consumer that had to tell these apart
    // spelled its own answer, so the StatusMenu Engine got reported as a plugin engine simply because
    // the loader hosted plugins first and the word stuck. A fifth artifact must not be able to join
    // without saying what it is and how many may run.
    it('covers EVERY artifact type, with no type left undescribed', () => {
        expect(Object.keys(ARTIFACT_ROLES).sort()).toEqual([...ARTIFACT_TYPES].sort());
        for (const [type, role] of Object.entries(ARTIFACT_ROLES)) {
            expect(role.label, type).toBeTruthy();
            expect(role.role, type).toBeTruthy();
            expect([1, 'many'], type).toContain(role.activeAtOnce);
        }
    });

    it('pins which artifacts are SINGLE-active: the brain and its display half', () => {
        const single = Object.keys(ARTIFACT_ROLES).filter((t) => ARTIFACT_ROLES[t].activeAtOnce === 1);
        expect(single.sort()).toEqual(['gamelogic', 'statusmenu']);
        const many = Object.keys(ARTIFACT_ROLES).filter((t) => ARTIFACT_ROLES[t].activeAtOnce === 'many');
        expect(many.sort()).toEqual(['eventpack', 'plugin']);
    });

    it('gives the display engine its OWN reload-line word, never the plugin one', () => {
        expect(ARTIFACT_ROLES.statusmenu.engineLabel).toBe('display engine');
        expect(ARTIFACT_ROLES.plugin.engineLabel).toBe('plugins');
        expect(ARTIFACT_ROLES.statusmenu.engineLabel).not.toBe(ARTIFACT_ROLES.plugin.engineLabel);
    });

    it('marks the event pack as hosting NO engine scope - it is data the game engine runs', () => {
        expect(ARTIFACT_ROLES.eventpack.engineLabel).toBeNull();
        // Everything that DOES host a scope must carry a distinct word, or the reload line merges
        // two kinds into one clause again.
        const words = Object.values(ARTIFACT_ROLES).map((r) => r.engineLabel).filter(Boolean);
        expect(new Set(words).size).toBe(words.length);
    });
});

describe('entryFieldsDiffer — "written" is not "changed"', () => {
    it('MUTATION TARGET — identical fields are NOT a change, so a re-apply costs no chat reload', () => {
        const existing = { uid: 7, comment: '[X] menu', content: 'abc', enabled: false, keys: [] };
        expect(entryFieldsDiffer(existing, { comment: '[X] menu', content: 'abc', enabled: false, keys: [] })).toBe(false);
    });

    it('a differing value in ANY written field is a change', () => {
        const existing = { comment: '[X] menu', content: 'abc', enabled: false };
        expect(entryFieldsDiffer(existing, { comment: '[X] menu', content: 'abd' })).toBe(true);
        expect(entryFieldsDiffer(existing, { comment: '[X] MENU', content: 'abc' })).toBe(true);
        expect(entryFieldsDiffer(existing, { comment: '[X] menu', content: 'abc', enabled: true })).toBe(true);
    });

    it('a create is always a change — there was no entry to match', () => {
        expect(entryFieldsDiffer(null, { content: 'abc' })).toBe(true);
        expect(entryFieldsDiffer(undefined, {})).toBe(true);
    });

    it('host bookkeeping this write never sets cannot make it a change', () => {
        const existing = { content: 'abc', uid: 12, order: 100, position: 0, probability: 100 };
        expect(entryFieldsDiffer(existing, { content: 'abc' })).toBe(false);
    });

    it('key order is not a change; element order is', () => {
        expect(entryFieldsDiffer({ extra: { a: 1, b: 2 } }, { extra: { b: 2, a: 1 } })).toBe(false);
        expect(entryFieldsDiffer({ keys: ['a', 'b'] }, { keys: ['b', 'a'] })).toBe(true);
    });

    it('a field the entry does not carry yet is a change, and undefined is not a way to hide one', () => {
        expect(entryFieldsDiffer({ content: 'abc' }, { content: 'abc', type: 'constant' })).toBe(true);
        expect(entryFieldsDiffer({ content: 'abc' }, { content: undefined })).toBe(true);
    });
});


describe('plannedEntriesChanged — asked BEFORE the sweep, because after it every write is a create', () => {
    const layout = (content) => ({ comment: '[StatusMenuPack:koi] (Layout)', content, enabled: false, type: 'constant', key: [], keys: [] });

    it('MUTATION TARGET — a re-apply of the SAME entries is not a change, even though every one is rewritten', () => {
        const card = [{ ...layout('{"tabs":[]}'), uid: 80, order: 100, position: 'before_char' }];
        expect(plannedEntriesChanged(card, [layout('{"tabs":[]}')], ['[StatusMenuPack:koi] (Layout)'])).toBe(false);
    });

    it('an edited layout IS a change', () => {
        const card = [{ ...layout('{"tabs":[]}'), uid: 80 }];
        expect(plannedEntriesChanged(card, [layout('{"tabs":[1]}')], ['[StatusMenuPack:koi] (Layout)'])).toBe(true);
    });

    it('MUTATION TARGET — an entry the card has and the plan drops is a change: it is about to vanish', () => {
        const card = [{ ...layout('{}'), uid: 80 }, { comment: '[StatusMenuPack:koi] Extra', content: 'x', uid: 81 }];
        expect(plannedEntriesChanged(card, [layout('{}')], ['[StatusMenuPack:koi] (Layout)', '[StatusMenuPack:koi] Extra'])).toBe(true);
    });

    it('a first install — the card has nothing — is a change', () => {
        expect(plannedEntriesChanged([], [layout('{}')], [])).toBe(true);
        expect(plannedEntriesChanged(null, [layout('{}')], [])).toBe(true);
    });

    it('an install writing NOTHING against a card holding nothing changes nothing', () => {
        expect(plannedEntriesChanged([], [], [])).toBe(false);
    });
});

// The registry's own removal is a SECOND delete, outside the artifact's needle sweep, and all three
// lanes threw its result away: the plugin lane printed a count that could not be reconciled with the
// book (4 reported, 5 gone — live 2026-08-30), and the pack lane asserted "registry removed" without
// having looked. A registry that outlives its last artifact is read by the next install.
describe('registryRemovalOutcome — did the bookkeeping entry actually go', () => {
    it('present and deleted is a removal, and the caller may say so', () => {
        expect(registryRemovalOutcome({ wasPresent: true, removedCount: 1 })).toBe('removed');
    });

    it('MUTATION TARGET — present but nothing deleted is a FAILURE, never silence', () => {
        expect(registryRemovalOutcome({ wasPresent: true, removedCount: 0 })).toBe('failed');
    });

    it('MUTATION TARGET — absent is not a failure: warning on the benign case is how a warning stops being read', () => {
        expect(registryRemovalOutcome({ wasPresent: false, removedCount: 0 })).toBe('absent');
        expect(registryRemovalOutcome({ wasPresent: false, removedCount: 3 })).toBe('absent');
    });

    it('a count is a count, whatever shape it arrives in', () => {
        expect(registryRemovalOutcome({ wasPresent: true, removedCount: '2' })).toBe('removed');
        expect(registryRemovalOutcome({ wasPresent: true, removedCount: null })).toBe('failed');
        expect(registryRemovalOutcome({ wasPresent: true, removedCount: undefined })).toBe('failed');
        expect(registryRemovalOutcome({ wasPresent: true, removedCount: NaN })).toBe('failed');
    });

    it('survives being called with nothing at all', () => {
        expect(registryRemovalOutcome()).toBe('absent');
        expect(registryRemovalOutcome({})).toBe('absent');
    });
});

// One spelling for every lane's success toast.
describe('installActionDone — the past tense every lane\'s toast uses', () => {
    it('MUTATION TARGET — every install action reads as a word, including the irregular ones', () => {
        expect(installActionDone('install')).toBe('installed');
        expect(installActionDone('activate')).toBe('installed');
        expect(installActionDone('repair')).toBe('repaired');
        expect(installActionDone('upgrade')).toBe('upgraded');
        expect(installActionDone('downgrade')).toBe('downgraded');
        expect(installActionDone('reinstall')).toBe('reinstalled');
        expect(installActionDone('switch')).toBe('switched');
    });

    it('an unknown action is printed as given, never invented', () => {
        expect(installActionDone('adopt')).toBe('adopt');
        expect(installActionDone()).toBe('');
    });
});

// The library row hides Install for an artifact already on the card, so the card row's two buttons are
// the only way to run the install again — every edge where one is needed must show one.
describe('cardRowInstallButtons — Repair and Upgrade, one rule for every lane', () => {
    const row = (extra) => cardRowInstallButtons({ ledState: 'green', hasLibraryCopy: true, libraryVersion: '1.0', installedVersion: '1.0', ...extra });

    it('MUTATION TARGET — a NEWER library copy offers Upgrade, compared as numbers', () => {
        expect(row({ libraryVersion: '1.1' })).toEqual({ repair: false, upgrade: true });
        expect(row({ libraryVersion: '1.10', installedVersion: '1.9' }).upgrade).toBe(true);
        expect(row({ libraryVersion: '2.0', installedVersion: '1.9.9' }).upgrade).toBe(true);
    });

    it('MUTATION TARGET — an OLDER or equal library copy offers no Upgrade (text that differs is not newer)', () => {
        expect(row({ libraryVersion: '0.9' }).upgrade).toBe(false);
        expect(row({ libraryVersion: '1.0.0' }).upgrade).toBe(false);
        expect(row({ libraryVersion: '1.0' }).upgrade).toBe(false);
    });

    it('an install that recorded no version reads as 0, so any library version upgrades it', () => {
        expect(row({ installedVersion: '', libraryVersion: '0.1' }).upgrade).toBe(true);
    });

    it('MUTATION TARGET — missing pieces (red) offer Repair, which runs the install and lets it decide the version', () => {
        expect(row({ ledState: 'red' })).toEqual({ repair: true, upgrade: false });
        expect(row({ ledState: 'red', libraryVersion: '2.0' })).toEqual({ repair: true, upgrade: false });
    });

    it('MUTATION TARGET — a lane that knows the install must run again (a plugin on a card that lost its schema) offers Repair', () => {
        expect(row({ needsReinstall: true })).toEqual({ repair: true, upgrade: false });
        expect(row({ needsReinstall: true, hasLibraryCopy: false })).toEqual({ repair: false, upgrade: false });
    });

    it("MUTATION TARGET — an owned slot holding another writer's copy offers Repair, which writes the pack's copy back", () => {
        expect(row({ drifted: ['[MVU_LogicEngine]'] })).toEqual({ repair: true, upgrade: false });
        expect(row({ drifted: ['[MVU_LogicEngine]'], hasLibraryCopy: false })).toEqual({ repair: false, upgrade: false });
    });

    it('no library copy offers neither — there is nothing to install from', () => {
        expect(row({ hasLibraryCopy: false, ledState: 'red' })).toEqual({ repair: false, upgrade: false });
        expect(row({ hasLibraryCopy: false, libraryVersion: '9.0' })).toEqual({ repair: false, upgrade: false });
    });
});

describe('the lanes\' shared questions — dialog lines: a question, what it touches, one line per answer', () => {
    it('adoptQuestion: the question, the artifact, the surfaces one per line, then the answers', () => {
        const surface = { text: 'The "Scheme" script, card → pack:', name: '3 B → 5 B' };
        const replace = { text: 'Replace: the pack owns them from then on.' };
        const cancel = { text: 'Cancel: nothing changes.' };
        expect(adoptQuestion({ artifactName: 'Weather', version: '1.2', surfaces: [surface], answers: [replace, cancel] })).toEqual([
            { text: 'Replace this card\'s own copies?' },
            { name: 'Weather v1.2' },
            surface,
            replace,
            cancel,
        ]);
    });

    it('downgradeQuestion names the artifact and both versions as values', () => {
        expect(downgradeQuestion({ artifactName: 'school-v4', installedVersion: '5.2', libraryVersion: '5.1' })).toEqual([
            { text: 'Install the older version?' },
            { name: 'school-v4' },
            { text: 'Installed:', name: 'v5.2' },
            { text: 'Library copy:', name: 'v5.1' },
        ]);
    });

    it('libraryRemoveQuestion says installed cards keep working and a rebuild cannot get it back', () => {
        expect(libraryRemoveQuestion('weather')).toEqual([
            { text: 'Remove this pack from the library?' },
            { name: 'weather' },
            { text: 'Cards that have it installed keep working.' },
            { text: 'A rebuilt card can no longer get it back from here.' },
        ]);
    });
});

// Every validator checks a version's shape here, so a version that validates is a version that compares.
describe('isVersionString — the one version shape', () => {
    it('accepts M.m and M.m.r, numbers only', () => {
        for (const v of ['1.0', '0.14', '5.116.3', '10.0.0']) expect(isVersionString(v)).toBe(true);
    });

    it('MUTATION TARGET — refuses anything compareVersions would order wrong', () => {
        for (const v of ['v1.2', '1.2-beta', '1', '1.2.3.4', ' 1.2', '1.2 ', '', null, undefined, 1.2]) {
            expect(isVersionString(v)).toBe(false);
        }
    });

    it('and what it accepts compares segment by segment', () => {
        expect(compareVersions('1.10', '1.9')).toBe(1);
        expect(compareVersions('1.2', '1.2.0')).toBe(0);
        expect(compareVersions('0.9', '1.0')).toBe(-1);
    });
});

// A plugin's flavor is its `requires` and nothing else.
describe('pluginFlavorSummary / pluginFlavorLine — game-bound or standalone', () => {
    it('MUTATION TARGET — one required interface makes it game-bound, and names what it needs', () => {
        expect(pluginFlavorSummary({ requires: ['cast@1', 'player@1'] })).toEqual({ flavor: PLUGIN_FLAVOR_GAME_BOUND, needs: ['cast@1', 'player@1'] });
    });
    it('MUTATION TARGET — no requires is standalone, whatever optionalUses says', () => {
        expect(pluginFlavorSummary({ optionalUses: ['cast@1'] })).toEqual({ flavor: PLUGIN_FLAVOR_STANDALONE, needs: [] });
        expect(pluginFlavorSummary({ requires: [] }).flavor).toBe(PLUGIN_FLAVOR_STANDALONE);
        expect(pluginFlavorSummary(null).flavor).toBe(PLUGIN_FLAVOR_STANDALONE);
    });
    it('the row line: each word fixed, each required interface a code chip', () => {
        expect(pluginFlavorLine({})).toEqual({ parts: [{ text: 'standalone' }] });
        expect(pluginFlavorLine({ requires: ['cast@1', 'player@1'] })).toEqual({
            parts: [{ text: 'game-bound' }, { name: ' — ' }, { text: 'needs' }, { name: ' ' }, { code: 'cast@1' }, { name: ', ' }, { code: 'player@1' }],
        });
    });
});

// What an installed artifact's card row says — the pack, plugin and menu rows read it alike.
describe("artifactRowStatus — the card row's pill and what to do", () => {
    it('complete: Installed, nothing to do', () => {
        const installed = { text: 'Installed', status: 'success' };
        expect(artifactRowStatus({ led: 'green', hasLibraryCopy: true })).toEqual({ pill: installed, pills: [installed], sub: [] });
    });
    it('no library copy: a warning, and how to keep a copy', () => {
        const status = artifactRowStatus({ led: 'amber' });
        expect(status.pill).toEqual({ text: 'No library copy', status: 'warning' });
        expect(status.sub).toEqual([{ text: 'Not in the library: import it again to keep a copy a card rebuild cannot lose.' }]);
    });
    // MUTATION TARGET: the regexes are counted among the pieces AND named, because they are fixed in another place.
    it('pieces missing: the count, the regexes among them, and Repair', () => {
        const status = artifactRowStatus({ led: 'red', missing: ['[a]', '[b]'], missingRegexes: ['hide'], hasLibraryCopy: true });
        expect(status.pill).toEqual({ text: 'Pieces missing', status: 'danger' });
        expect(status.sub).toEqual([
            { parts: [{ name: '3 ' }, { text: 'pieces missing' }, { name: ' (1 ' }, { text: 'regex' }, { name: ')' }] },
            { text: 'Repair puts them back from the library.' },
        ]);
    });
    it('pieces missing and no library copy: nothing to repair from, and it says so', () => {
        const status = artifactRowStatus({ led: 'red', missing: ['[a]'], hasLibraryCopy: false });
        expect(status.sub).toEqual([
            { parts: [{ name: '1 ' }, { text: 'pieces missing' }] },
            { text: 'The library has no copy to repair from: import it again, or uninstall it.' },
        ]);
    });
    it('an unknown state reads as red, never as installed', () => {
        expect(artifactRowStatus({ led: 'purple' }).pill.status).toBe('danger');
    });

    const drift = { text: 'Drift', status: 'warning' };
    // MUTATION TARGET: Drift replaces Installed, and the page header names it.
    it('a drifted slot: Drift replaces Installed, the slots named as chips, then what Repair does', () => {
        const status = artifactRowStatus({ led: 'green', drifted: ['[MVU_LogicEngine]', 'Scheme'], hasLibraryCopy: true });
        expect(status.pills).toEqual([drift]);
        expect(status.pill).toEqual(drift);
        expect(status.sub).toEqual([
            { parts: [{ text: 'Not what this install recorded:' }, { name: ' ' }, { code: '[MVU_LogicEngine]' }, { name: ', ' }, { code: 'Scheme' }] },
            { text: 'Repair puts the library copy back.' },
        ]);
    });
    it('MUTATION TARGET — Drift never masks another state: missing pieces stay beside it, and their line already says Repair', () => {
        const status = artifactRowStatus({ led: 'red', missing: ['[a]'], drifted: ['[MVU_LogicEngine]'], hasLibraryCopy: true });
        expect(status.pills).toEqual([{ text: 'Pieces missing', status: 'danger' }, drift]);
        expect(status.pill.status).toBe('danger');
        expect(status.sub).toEqual([
            { parts: [{ name: '1 ' }, { text: 'pieces missing' }] },
            { text: 'Repair puts them back from the library.' },
            { parts: [{ text: 'Not what this install recorded:' }, { name: ' ' }, { code: '[MVU_LogicEngine]' }] },
        ]);
    });
    it('a drifted slot and no library copy: nothing to repair from, and it says so', () => {
        const status = artifactRowStatus({ led: 'amber', drifted: ['[MVU_StatusMenuEngine]'] });
        expect(status.pills).toEqual([{ text: 'No library copy', status: 'warning' }, drift]);
        expect(status.sub.at(-1)).toEqual({ text: 'The library has no copy to repair from: import it again, or uninstall it.' });
    });
    it("a lane's own drift lines follow the state's lines as given, under the same pill rule", () => {
        const line = { name: 'PRE call "x" is gone' };
        const status = artifactRowStatus({ led: 'green', hasLibraryCopy: true, drift: [line] });
        expect(status.pills).toEqual([drift]);
        expect(status.sub).toEqual([line]);
    });
});

// The pack and menu rows decide their state and their buttons in one call, from the LED and the library copy.
describe('decideCardRow — the row state and its buttons, together', () => {
    const led = (extra) => ({ state: 'green', missing: [], missingRegexes: [], drifted: [], ...extra });
    it('MUTATION TARGET — a drifted slot shows Drift AND offers the Repair that fixes it', () => {
        const row = decideCardRow({ led: led({ drifted: ['[MVU_LogicEngine]'] }), libraryCopy: { version: '1.0' }, installedVersion: '1.0' });
        expect(row.status.pills).toEqual([{ text: 'Drift', status: 'warning' }]);
        expect(row.offer).toEqual({ repair: true, upgrade: false });
    });
    it('reads the library copy for both halves: a newer one offers Upgrade, none offers nothing and says why', () => {
        expect(decideCardRow({ led: led(), libraryCopy: { version: '1.1' }, installedVersion: '1.0' }).offer).toEqual({ repair: false, upgrade: true });
        const orphan = decideCardRow({ led: led({ state: 'amber' }), libraryCopy: null, installedVersion: '1.0' });
        expect(orphan.offer).toEqual({ repair: false, upgrade: false });
        expect(orphan.status.pill).toEqual({ text: 'No library copy', status: 'warning' });
    });
});

// The pack, plugin and menu groups stop before their rows by one rule: a card that cannot be written leaves the group
// empty (the page's notices say why), a registry that will not parse shows its error.
describe("cardGroupStop — where a lane's card group stops before its rows", () => {
    it('MUTATION TARGET — a card that cannot be written stops the group with nothing in it, registry error or not', () => {
        expect(cardGroupStop({ canOperateOnCard: false })).toEqual({ notice: null });
        expect(cardGroupStop({ canOperateOnCard: false, registryError: 'malformed' })).toEqual({ notice: null });
    });
    it('MUTATION TARGET — a registry that will not parse stops it with a danger notice carrying the error', () => {
        expect(cardGroupStop({ canOperateOnCard: true, registryError: 'the entry is malformed' }))
            .toEqual({ notice: { text: 'Registry unreadable', status: 'danger', name: 'the entry is malformed' } });
    });
    it('a writable card with a readable registry draws its rows', () => {
        expect(cardGroupStop({ canOperateOnCard: true, registryError: '' })).toBe(null);
        expect(cardGroupStop({ canOperateOnCard: true })).toBe(null);
    });
});
