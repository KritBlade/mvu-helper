// tests/gamelogic-pack-activation-core.test.js — G2's pure decisions (GameLogic Pack plan §5–§8).
//
// These are the guards standing between a pack activation and a user's RUNNING GAME: the conflict
// rule that refuses to overwrite a card's own engine/schema, the create-only init merge that must
// never touch live state, and the uninstall-exactness check. Each is written so breaking the guard
// breaks a test (L6 — verified by mutation in the same pass).

import { describe, it, expect } from 'vitest';
import {
    packRegistryComment, packRegistryMatch, parsePackRegistry, buildPackRegistryContent,
    decideActivation, planInstallEntries, validatePack, unownedSurfaceVerdict, packOwnedSlots,
} from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import {
    installedSweepNeedle, uninstallExactness, deriveArtifactLed, parseLibraryComment, preDeleteNeedles, commentMatchesNeedle,
} from '../src/shared/card-artifact-store.js';
import { mergeInitSubtree } from '../src/shared/create-only-merge.js';
import { dialogLineText } from '../src/sillytavern/popup-core.js';

const pack = (extra = {}) => ({
    format: '1.0', packType: 'gamelogic', id: 'rpg-artific', name: 'RPG', description: 'd', version: '1.0', ...extra,
});
const registry = (extra = {}) => ({
    activePackId: 'rpg-artific', ver: '1.0', installedComments: [], engineOwned: false, schemaOwned: false,
    engineFingerprint: '', schemaFingerprint: '', installedRegexNames: [], exposes: {}, stateVersion: '', forceFromInitVar: [], installedAt: '',
    // W7 identity — parse always emits the three; builtWith/targetsPackId only when recorded.
    name: '', description: '', format: '', ...extra,
});

describe('§5 registry — parse and round-trip', () => {
    it('round-trips through build → parse, with the # header stripped', () => {
        const reg = registry({ installedComments: ['[GameLogicPack:rpg-artific] A'], engineOwned: true, engineFingerprint: 'k3x9z1', schemaOwned: true, schemaFingerprint: '1q2w3e', stateVersion: '4.3.0', force: { 'World.Weather': ['Clear', 'x'] }, forceFromInitVar: ['EventPack.triggers'], exposes: { 'cast@1': 'CastRoot' } });
        const parsed = parsePackRegistry(buildPackRegistryContent('gamelogic', reg));
        expect(parsed).toEqual(reg);
    });

    it('a registry that records no fingerprints reads them as empty, which matches no slot text', () => {
        const parsed = parsePackRegistry('{"activePackId":"rpg-artific","ver":"1.0","engineOwned":true,"schemaOwned":true}');
        expect(parsed.engineFingerprint).toBe('');
        expect(parsed.schemaFingerprint).toBe('');
    });

    // A card activated before packRoots was dropped carries the field in its registry entry. Parsing
    // must IGNORE it, not carry it forward — nothing reads it, and a ghost field in the parsed shape
    // would make the round-trip test above pass while the uninstall path pretends it still matters.
    // W7 — identity beside ownership: the export reads the registry after the library file is
    // gone, so name/description/format/builtWith must survive the build → parse round trip.
    it('W7: identity fields round-trip; absent builtWith stays ABSENT, not empty', () => {
        const rich = registry({ name: 'ArtificKoi — School v4', description: 'the game', format: '1.0', builtWith: 'MvuGameMaker 5.58', force: {} });
        expect(parsePackRegistry(buildPackRegistryContent('gamelogic', rich))).toEqual(rich);
        const bare = parsePackRegistry(buildPackRegistryContent('gamelogic', registry()));
        expect(bare.name).toBe('');
        expect('builtWith' in bare).toBe(false);
    });

    it('a registry an older install wrote, with no forceFromInitVar, reads as an empty list', () => {
        expect(parsePackRegistry('{"activePackId":"rpg-artific","ver":"1.0"}').forceFromInitVar).toEqual([]);
    });

    it('drops a legacy packRoots field from an older card registry', () => {
        const parsed = parsePackRegistry('{"activePackId":"rpg-artific","ver":"1.0","packRoots":["World"]}');
        expect(parsed.packRoots).toBeUndefined();
        expect(parsed.activePackId).toBe('rpg-artific');
    });

    it('THROWS on malformed content — a broken registry must never read as "no pack active"', () => {
        expect(() => parsePackRegistry('# header\n{ not json')).toThrow();
        expect(() => parsePackRegistry('{"ver":"1.0"}')).toThrow(/activePackId/);
        expect(() => parsePackRegistry('[]')).toThrow();
    });

    it('registry comments per type, and parseLibraryComment refuses to read them as artifacts', () => {
        expect(packRegistryComment('gamelogic')).toBe('[GameLogicPack:Registry]');
        expect(packRegistryMatch('gamelogic')).toBe('[gamelogicpack:registry]');
        expect(parseLibraryComment('[GameLogicPack:Registry]')).toBeNull();   // a phantom pack otherwise
    });

    it('the id "registry" is refused by the validator — it would collide with the registry entry', () => {
        const res = validatePack(pack({ id: 'registry' }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.includes('reserved'))).toBe(true);
    });
});

describe('§6/§8 decideActivation', () => {
    it('no chat refuses first, whatever else is true (V8)', () => {
        const d = decideActivation({ isCardOpen: false, isChatStarted: false, areEntriesReadable: true, pack: pack({ engine: 'x' }), registry: null, hasEngineEntry: true, hasSchemeScript: true });
        expect(d.action).toBe('no-chat');
    });

    // A chat IS open and the book did not answer: the live symptom this pair exists to keep apart. The
    // old single `hasChat` made these two states indistinguishable, and the UI said "open a chat
    // first" to someone whose chat was open and whose pack was installed and running.
    it('an unreadable book is its OWN refusal, never "no chat" (a chat is open)', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: false, pack: pack({ engine: 'x' }), registry: null, hasEngineEntry: false, hasSchemeScript: false });
        expect(d.action).toBe('card-unreadable');
        expect(d.reasons[0]).toContain('could not be read yet');
        expect(d.reasons.join(' ')).not.toContain('open a chat');
    });

    // THE LOBBY, and the case that caught a regression in this very split live: ST's lobby carries a
    // 2-message placeholder chat AND no readable book, so a message-count test says "chat open" while
    // the book says "unreadable" — and the tab told a user standing in the lobby that a worldbook was
    // still loading and to retry, which no amount of waiting would ever satisfy. The lobby's refusal
    // must win, because "open a chat first" is the only instruction that changes anything there.
    it('the LOBBY refuses as no-chat, never as a book still loading (no card = nothing to wait for)', () => {
        const d = decideActivation({ isCardOpen: false, isChatStarted: true, areEntriesReadable: false, pack: pack(), registry: null });
        expect(d.action).toBe('no-chat');
        expect(d.reasons.join(' ')).not.toContain('could not be read yet');
    });

    // A card IS open, its book reads, but the chat has no messages — the §6/V8 guard as it has always
    // behaved. Pinned so a display fix cannot quietly widen a write guard.
    it('a card open on an unstarted chat still refuses, with the words it always used', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: false, areEntriesReadable: true, pack: pack(), registry: null });
        expect(d.action).toBe('no-chat');
    });

    // The hazard the split could have introduced: reading a silent book as an EMPTY one, which would
    // let an activation decide "nothing installed here" and write over pieces it never saw.
    it('an unreadable book never reaches the install decision, registry or not', () => {
        for (const reg of [null, registry()]) {
            expect(decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: false, pack: pack(), registry: reg }).action).toBe('card-unreadable');
        }
    });

    it('a card-owned engine blocks a pack that ships one (§8) — and names the LogicEngine tab', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack({ engine: 'e' }), registry: null, cardEngineText: 'CARD OWN ENGINE', cardSchemeText: null });
        expect(d.action).toBe('needs-adopt');
        expect(dialogLineText(d.adoptable[0])).toContain('[MVU_LogicEngine]');
    });

    it('a card-owned Scheme blocks a pack that ships a schema (§13/V24)', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack({ schema: 's' }), registry: null, cardEngineText: null, cardSchemeText: 'CARD OWN SCHEME' });
        expect(d.action).toBe('needs-adopt');
        expect(dialogLineText(d.adoptable[0])).toContain('Scheme');
    });

    it('BOTH conflicts report together — one refusal, two named reasons', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack({ engine: 'e', schema: 's' }), registry: null, cardEngineText: 'CARD ENGINE', cardSchemeText: 'CARD SCHEME' });
        expect(d.action).toBe('needs-adopt');
        expect(d.adoptable).toHaveLength(2);
    });

    it('pack-owned pieces do NOT conflict — that is what ownership flags exist for', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack({ engine: 'e', schema: 's' }),
            registry: registry({ engineOwned: true, schemaOwned: true }),
            cardEngineText: 'e', cardSchemeText: 's',
        });
        expect(d.action).toBe('repair');
    });

    it('a pack shipping NO engine activates fine over a card-owned engine (nothing to overwrite)', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack(), registry: null, cardEngineText: 'CARD ENGINE', cardSchemeText: null });
        expect(d.action).toBe('activate');
    });

    it('a DIFFERENT active pack yields switch-needed, never a silent replace (§6)', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack({ id: 'other-pack' }), registry: registry(), cardEngineText: null, cardSchemeText: null });
        expect(d.action).toBe('switch-needed');
        expect(d.reasons[0]).toContain('rpg-artific');
        expect(d.active).toEqual({ id: 'rpg-artific', version: '1.0' });
    });

    it('same id: newer=upgrade · same=repair · older=downgrade, naming both versions', () => {
        const base = { isCardOpen: true, isChatStarted: true, areEntriesReadable: true, registry: registry(), cardEngineText: null, cardSchemeText: null };
        expect(decideActivation({ ...base, pack: pack({ version: '1.1' }) }).action).toBe('upgrade');
        expect(decideActivation({ ...base, pack: pack({ version: '1.0' }) }).action).toBe('repair');
        const down = decideActivation({ ...base, pack: pack({ version: '0.9' }) });
        expect(down.action).toBe('downgrade');
        expect(down.reasons[0]).toBe('library v0.9 is older than the installed v1.0');
        expect(down).toMatchObject({ installedVersion: '1.0', libraryVersion: '0.9' });
    });
});

describe('§6 planInstallEntries — the write plan (V27 fidelity)', () => {
    it('prefixes every comment and records it as the uninstall list', () => {
        const plan = planInstallEntries(pack({ entries: [{ comment: 'Worldview', content: 'w' }, { comment: '[PRE] Menu', content: 'm' }] }));
        expect(plan.entries.map((e) => e.comment)).toEqual([
            '[GameLogicPack:rpg-artific] Worldview',
            '[GameLogicPack:rpg-artific] [PRE] Menu',
        ]);
        expect(plan.installedComments).toEqual(plan.entries.map((e) => e.comment));
    });

    it('passes every other field through VERBATIM — position/depth/keys are load-bearing for [PRE] entries', () => {
        const entry = { comment: 'P', content: 'c', enabled: true, type: 'selective', keys: ['k1'], position: 4, depth: 2, order: 99, probability: 100, extra_unknown: 'kept' };
        const plan = planInstallEntries(pack({ entries: [entry] }));
        const { comment, ...rest } = plan.entries[0];
        const { comment: _c, ...expected } = entry;
        expect(rest).toEqual(expected);
    });

    it('STRIPS uid — the source book\'s identity must not collide with the destination\'s', () => {
        const plan = planInstallEntries(pack({ entries: [{ uid: 42, comment: 'X', content: '' }] }));
        expect('uid' in plan.entries[0]).toBe(false);
    });

    it('the sweep is bounded after the id — id "rpg" must not sweep "rpg-artific"', () => {
        const comment = '[GameLogicPack:rpg-artific] Worldview';
        expect(commentMatchesNeedle(comment, installedSweepNeedle('gamelogic', 'rpg'))).toBe(false);
        expect(commentMatchesNeedle(comment, installedSweepNeedle('gamelogic', 'rpg-artific'))).toBe(true);
    });
});

describe('V3 uninstallExactness — counts must agree, both directions named', () => {
    it('agrees when record and sweep match', () => {
        const r = uninstallExactness(['a', 'b'], ['b', 'a']);
        expect(r.agree).toBe(true);
    });
    it('names a hand-deleted entry (recorded, not found)', () => {
        const r = uninstallExactness(['a', 'b'], ['a']);
        expect(r.agree).toBe(false);
        expect(r.onlyInRecord).toEqual(['b']);
    });
    it('names an unrecorded entry (found, not recorded — a crashed install)', () => {
        const r = uninstallExactness(['a'], ['a', 'stray']);
        expect(r.agree).toBe(false);
        expect(r.onlyInSweep).toEqual(['stray']);
    });
});

describe('§7 mergeInitSubtree — create-only at every depth', () => {
    it('writes absent roots and reports each path', () => {
        const sd = {};
        const res = mergeInitSubtree(sd, { World: { Day: 1 }, Flags: { a: true } });
        expect(sd).toEqual({ World: { Day: 1 }, Flags: { a: true } });
        expect(res.changed).toBe(true);
        expect(res.written.sort()).toEqual(['Flags', 'World']);
    });

    it('V7: a chat that already has everything sees ZERO writes, and the roots report as skipped', () => {
        const sd = { World: { Day: 5, Weather: 'rain' } };
        const before = JSON.stringify(sd);
        const res = mergeInitSubtree(sd, { World: { Day: 1, Weather: 'sun' } });
        expect(JSON.stringify(sd)).toBe(before);
        expect(res.changed).toBe(false);
        expect(res.written).toEqual([]);
        expect(res.skippedRoots).toEqual(['World']);
    });

    it('an existing key is NEVER overwritten, but a missing sibling seeds in (the upgrade case)', () => {
        const sd = { World: { Day: 5 } };
        const res = mergeInitSubtree(sd, { World: { Day: 1, Weather: 'sun' } });
        expect(sd.World.Day).toBe(5);           // live state survives
        expect(sd.World.Weather).toBe('sun');   // new key seeds
        expect(res.written).toEqual(['World.Weather']);
    });

    it('labelled tuples are VALUES: cloned whole when absent, never merged into when present (V1 lesson)', () => {
        const sd = { Mainchar: { Money: [5000, '金錢'] } };
        const res = mergeInitSubtree(sd, { Mainchar: { Money: [0, '金錢'], HP: [100, '生命'] } });
        expect(sd.Mainchar.Money).toEqual([5000, '金錢']);   // present array untouched
        expect(sd.Mainchar.HP).toEqual([100, '生命']);       // absent array cloned whole
        expect(res.written).toEqual(['Mainchar.HP']);
    });

    it('a present non-object where init expects an object is left alone (never destroyed)', () => {
        const sd = { World: 'a string someone wrote' };
        mergeInitSubtree(sd, { World: { Day: 1 } });
        expect(sd.World).toBe('a string someone wrote');
    });

    it('init clones are INDEPENDENT — mutating stat_data later must not reach back into the registry init', () => {
        const init = { World: { Nested: { list: [1] } } };
        const sd = {};
        mergeInitSubtree(sd, init);
        sd.World.Nested.list.push(2);
        expect(init.World.Nested.list).toEqual([1]);
    });
});

describe('§6 deriveArtifactLed', () => {
    it('grey when not active, whatever the library says', () => {
        expect(deriveArtifactLed({ inLibrary: true, isActive: false, recordedComments: [], presentComments: [] }).state).toBe('grey');
    });
    it('green when active and every recorded piece is present', () => {
        expect(deriveArtifactLed({ inLibrary: true, isActive: true, recordedComments: ['a', 'b'], presentComments: ['a', 'b', 'other'] }).state).toBe('green');
    });
    it('red names the missing pieces — red must WIN over amber (missing pieces are the graver fact)', () => {
        const led = deriveArtifactLed({ inLibrary: false, isActive: true, recordedComments: ['a', 'b'], presentComments: ['a'] });
        expect(led.state).toBe('red');
        expect(led.missing).toEqual(['b']);
    });
    it('amber when active and intact but gone from the library', () => {
        expect(deriveArtifactLed({ inLibrary: false, isActive: true, recordedComments: ['a'], presentComments: ['a'] }).state).toBe('amber');
    });
});

// The pack's two owned slots, read from what readCardPackState hands the row.
describe('§6 packOwnedSlots — the engine entry and the Scheme script', () => {
    const reg = registry({ engineOwned: true, engineFingerprint: 'e1', schemaOwned: true, schemaFingerprint: 's1' });
    it('names both slots with their ownership, recorded fingerprints and the card text', () => {
        expect(packOwnedSlots(reg, { cardEngineText: 'engine', cardSchemeText: 'schema', scriptApiUp: true })).toEqual([
            { name: '[MVU_LogicEngine]', isOwned: true, recordedFingerprint: 'e1', text: 'engine' },
            { name: 'Scheme', isOwned: true, recordedFingerprint: 's1', text: 'schema' },
        ]);
    });
    it('MUTATION TARGET — while the script API is detached the schema could not be looked at: undefined, never empty', () => {
        expect(packOwnedSlots(reg, { cardEngineText: 'engine', cardSchemeText: null, scriptApiUp: false })[1].text).toBeUndefined();
        expect(packOwnedSlots(reg, { cardEngineText: 'engine', cardSchemeText: null, scriptApiUp: true })[1].text).toBe(null);
    });
    it('an engine entry the card does not have is empty', () => {
        expect(packOwnedSlots(reg, { cardEngineText: null, scriptApiUp: true })[0].text).toBe(null);
    });
    it('what the pack does not own is marked so', () => {
        expect(packOwnedSlots(registry(), {}).map((slot) => slot.isOwned)).toEqual([false, false]);
    });
});

// §6a — an Upgrade must remove everything an uninstall would have removed. Before this, the pre-delete
// trusted the recorded list ONLY, so an entry whose comment had been hand-edited fell out of that list
// and survived the upgrade while uninstall's needle sweep still caught it. That gap was the only thing
// that made "uninstall, then install" genuinely safer than the Upgrade button.
describe('§6a preDeleteNeedles — upgrade deletes the same set uninstall would', () => {
    it('returns every recorded comment AND the prefix sweep', () => {
        const reg = registry({ installedComments: ['[GameLogicPack:school-v4] [PRE] A', '[GameLogicPack:school-v4] B'] });
        const n = preDeleteNeedles(reg, 'gamelogic', 'school-v4');
        expect(n.recorded).toEqual(['[gamelogicpack:school-v4] [pre] a', '[gamelogicpack:school-v4] b']);
        expect(n.sweep).toEqual(installedSweepNeedle('gamelogic', 'school-v4'));
    });

    it('ALWAYS carries the sweep, even when the registry recorded nothing', () => {
        expect(preDeleteNeedles(registry({ installedComments: [] }), 'gamelogic', 'school-v4').sweep)
            .toEqual(installedSweepNeedle('gamelogic', 'school-v4'));
        expect(preDeleteNeedles(null, 'gamelogic', 'school-v4').sweep).toEqual(installedSweepNeedle('gamelogic', 'school-v4'));
    });

    // Both deletes go through commentMatchesNeedle — a substring for each recorded string, the bounded
    // matcher for the sweep — so only a rename that breaks the recorded string escapes the record;
    // appending to a comment does not (it still contains the original). This models the delete the way
    // the host performs it; an earlier version asserted startsWith and passed for the wrong reason.
    it('the sweep catches a RENAMED comment the recorded list can no longer match', () => {
        const reg = registry({ installedComments: ['[GameLogicPack:school-v4] [PRE] Check_DC_Dice'] });
        const n = preDeleteNeedles(reg, 'gamelogic', 'school-v4');
        const renamedByHand = '[GameLogicPack:school-v4] [PRE] Dice_Check';
        expect(n.recorded.some((c) => commentMatchesNeedle(renamedByHand, c))).toBe(false);   // the record misses it
        expect(commentMatchesNeedle(renamedByHand, n.sweep)).toBe(true);                      // the sweep does not
    });

    it('a comment merely APPENDED to is still matched by the record — no sweep needed', () => {
        const reg = registry({ installedComments: ['[GameLogicPack:school-v4] [PRE] Check_DC_Dice'] });
        const n = preDeleteNeedles(reg, 'gamelogic', 'school-v4');
        expect(commentMatchesNeedle('[GameLogicPack:school-v4] [PRE] Check_DC_Dice (my note)', n.recorded[0])).toBe(true);
    });

    it('the sweep cannot reach another pack whose id merely starts the same (the boundary after the id)', () => {
        const n = preDeleteNeedles(registry(), 'gamelogic', 'rpg');
        expect(commentMatchesNeedle('[GameLogicPack:rpg-artific] entry', n.sweep)).toBe(false);
        expect(commentMatchesNeedle('[GameLogicPack:rpg-artific:Panel]', n.sweep)).toBe(false);
    });
});

describe('§11/§8 decideActivation — the regex conflict', () => {
    const withRegex = (names) => pack({ regex: names.map((n) => ({ script_name: n, find_regex: '/' + n + '/g' })) });

    it('refuses when the card already owns a regex the pack ships, naming every collision', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: withRegex(['HideChoices', 'MinimizeRESVar']),
            registry: null, cardRegexNames: ['HideChoices', 'MinimizeRESVar', 'UserOwn'],
        });
        expect(d.action).toBe('needs-adopt');
        expect(d.adoptable.map(dialogLineText).join()).toMatch(/"HideChoices", "MinimizeRESVar"/);
    });

    // Repair/upgrade meets the pack's own previous write. Without this, a pack with regexes installs once
    // and then refuses forever.
    it('allows a repair of the pack\'s OWN recorded regexes', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: withRegex(['HideChoices']),
            registry: registry({ installedRegexNames: ['HideChoices'] }),
            cardRegexNames: ['HideChoices'],
        });
        expect(d.action).toBe('repair');
    });

    it('a pack shipping no regexes is never blocked by the card\'s', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack(), registry: null, cardRegexNames: ['HideChoices'] });
        expect(d.action).toBe('activate');
    });

    it('a fresh card with no regexes activates', () => {
        const d = decideActivation({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: withRegex(['HideChoices']), registry: null, cardRegexNames: [] });
        expect(d.action).toBe('activate');
    });

    // The engine/schema conflicts and this one are reported TOGETHER — a user fixing one at a time would
    // otherwise walk the same refusal three times.
    it('reports the regex conflict alongside an engine conflict', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true, pack: pack({ engine: '// v1.0', regex: [{ script_name: 'A', find_regex: '/a/g' }] }),
            registry: null, cardEngineText: 'CARD ENGINE', cardRegexNames: ['A'],
        });
        expect(d.action).toBe('needs-adopt');
        expect(d.adoptable).toHaveLength(2);
    });

    it('no-chat still wins over every conflict', () => {
        const d = decideActivation({ isCardOpen: false, isChatStarted: false, areEntriesReadable: true, pack: withRegex(['A']), registry: null, cardRegexNames: ['A'] });
        expect(d.action).toBe('no-chat');
    });
});

describe('§8/§13/§11 adoption — unownedSurfaceVerdict', () => {
    it('a pack that ships nothing here is clear whatever the card holds', () => {
        expect(unownedSurfaceVerdict({ cardText: 'anything', packText: undefined, owned: false })).toBe('clear');
        expect(unownedSurfaceVerdict({ cardText: 'anything', packText: null, owned: false })).toBe('clear');
    });

    it('a surface the registry already records as ours is clear even when the bytes differ', () => {
        expect(unownedSurfaceVerdict({ cardText: 'old', packText: 'new', owned: true })).toBe('clear');
    });

    it('nothing on the card is clear — there is nothing to overwrite', () => {
        expect(unownedSurfaceVerdict({ cardText: null, packText: 'x', owned: false })).toBe('clear');
        expect(unownedSurfaceVerdict({ cardText: undefined, packText: 'x', owned: false })).toBe('clear');
    });

    // The live case: ArtificKoi's Scheme and school-v4's schema were byte-identical (14713 B each), and
    // the old presence-only test refused anyway — permanently, for every card built from the pack source.
    it('identical bytes CLAIM — an identical write overwrites nothing', () => {
        expect(unownedSurfaceVerdict({ cardText: 'same', packText: 'same', owned: false })).toBe('claim');
    });

    it('different bytes are the only case that conflicts', () => {
        expect(unownedSurfaceVerdict({ cardText: 'a', packText: 'b', owned: false })).toBe('conflict');
    });

    // MUTATION TARGET: make the empty string read as absent (`if (!cardText) return 'clear'`) and a card
    // whose Scheme was emptied by hand is silently overwritten instead of asked about.
    it('an EMPTY card surface is still a surface — empty vs non-empty conflicts', () => {
        expect(unownedSurfaceVerdict({ cardText: '', packText: 'x', owned: false })).toBe('conflict');
        expect(unownedSurfaceVerdict({ cardText: '', packText: '', owned: false })).toBe('claim');
    });
});

describe('§8/§13/§11 adoption — decideActivation', () => {
    it('an identical unowned Scheme is CLAIMED, not refused, and the claim is reported', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ schema: 'IDENTICAL' }), registry: null,
            cardEngineText: null, cardSchemeText: 'IDENTICAL',
        });
        expect(d.action).toBe('activate');
        expect(d.claimed.join()).toContain('Scheme');
        expect(d.adoptable).toHaveLength(0);
    });

    it('an identical unowned engine entry is CLAIMED too — the same rule, the same shape', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ engine: 'ENGINE' }), registry: null,
            cardEngineText: 'ENGINE', cardSchemeText: null,
        });
        expect(d.action).toBe('activate');
        expect(d.claimed.join()).toContain('[MVU_LogicEngine]');
    });

    it('one identical and one differing surface: the identical one is claimed, only the other asks', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ engine: 'ENGINE', schema: 'PACK SCHEMA' }), registry: null,
            cardEngineText: 'ENGINE', cardSchemeText: 'CARD SCHEMA',
        });
        expect(d.action).toBe('needs-adopt');
        expect(d.claimed.join()).toContain('[MVU_LogicEngine]');
        expect(d.adoptable).toHaveLength(1);
        expect(dialogLineText(d.adoptable[0])).toContain('Scheme');
    });

    it('the conflict line carries BOTH sizes — a name alone is nothing to decide with', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ schema: '12345' }), registry: null,
            cardEngineText: null, cardSchemeText: '123',
        });
        expect(d.adoptable[0]).toEqual({ text: 'The "Scheme" script, card → pack:', name: '3 B → 5 B' });
    });

    it('allowAdopt lets the differing surface through, and still reports what it replaces', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ schema: 'PACK' }), registry: null,
            cardEngineText: null, cardSchemeText: 'CARD', allowAdopt: true,
        });
        expect(d.action).toBe('activate');
        expect(d.adoptable).toHaveLength(1);
    });

    it('a regex the card already matches byte for byte is claimed; the rest still ask', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ regex: [{ script_name: 'A' }, { script_name: 'B' }] }), registry: null,
            cardRegexNames: ['A', 'B'], unchangedRegexNames: ['A'],
        });
        expect(d.action).toBe('needs-adopt');
        expect(d.claimed.join()).toContain('"A"');
        expect(d.adoptable.map(dialogLineText).join()).toContain('"B"');
        expect(d.adoptable.map(dialogLineText).join()).not.toContain('"A"');
    });

    it('every clashing regex identical means nothing to ask', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ regex: [{ script_name: 'A' }] }), registry: null,
            cardRegexNames: ['A'], unchangedRegexNames: ['A'],
        });
        expect(d.action).toBe('activate');
    });

    // MUTATION TARGET: default unchangedRegexNames to "everything matches" instead of null and an
    // unreadable card silently adopts every regex the user wrote.
    it('an UNREADABLE card (null) counts every clash as differing — could-not-look never claims', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ regex: [{ script_name: 'A' }] }), registry: null,
            cardRegexNames: ['A'], unchangedRegexNames: null,
        });
        expect(d.action).toBe('needs-adopt');
        expect(d.claimed).toHaveLength(0);
    });

    // MUTATION TARGET: move the adoptable gate below the registry ladder and a card owning a differing
    // Scheme reports 'repair' — the overwrite then happens with nothing asked.
    it('needs-adopt outranks repair — an installed pack still may not overwrite what it does not own', () => {
        const d = decideActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: true,
            pack: pack({ schema: 'PACK' }), registry: registry(),
            cardEngineText: null, cardSchemeText: 'CARD',
        });
        expect(d.action).toBe('needs-adopt');
    });

    it('no-chat still wins over an adoption question', () => {
        const d = decideActivation({
            isCardOpen: false, isChatStarted: false, areEntriesReadable: true,
            pack: pack({ schema: 'PACK' }), registry: null, cardSchemeText: 'CARD',
        });
        expect(d.action).toBe('no-chat');
    });
});
