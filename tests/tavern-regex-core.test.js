// tests/tavern-regex-core.test.js — the pure half of the regex install lane (GameLogic Pack plan §11).
//
// These decide what happens to a USER'S OWN regex list: which entries a pack may replace, which it must
// keep its hands off, and which of its own it removes on upgrade. Every one of those is unrecoverable from
// inside ST if it goes wrong (there is no undo in the regex editor), so each guard is written so that
// breaking it breaks a test — L6, mutation-verified in the same pass.

import { describe, it, expect } from 'vitest';
import {
    regexNames,
    findRegexByName,
    normalizeTavernRegex,
    upsertRegexInList,
    upsertRegexesInList,
    removeRegexesByName,
    syncRegexesInList,
    conflictingRegexNames,
    regexUninstallExactness,
    toSillyTavernRegex,
    mergeScopedScripts,
    scopedScriptUnchanged,
    unchangedScopedNames,
    scriptsEqual,
    missingScriptNames,
    presentScriptNames,
    VERIFY_INSTALL,
    VERIFY_REMOVAL,
} from '../src/sillytavern/tavern-regex-core.js';

// SillyTavern's own regex_placement enum (public/scripts/extensions/regex/engine.js:281). Passed in rather
// than hardcoded in the converter so the host owns its own numbers; mirrored here so the tests pin them.
const PLACEMENT = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };

const rx = (name, extra = {}) => ({
    id: 'id-' + name, script_name: name, enabled: true,
    find_regex: '/' + name + '/g', replace_string: '', trim_strings: [],
    source: { user_input: false, ai_output: true, slash_command: false, world_info: false, reasoning: false },
    destination: { display: true, prompt: false },
    run_on_edit: true, min_depth: null, max_depth: null, ...extra,
});

describe('reads', () => {
    it('names in apply order, duplicates preserved', () => {
        expect(regexNames([rx('A'), rx('B'), rx('A')])).toEqual(['A', 'B', 'A']);
    });

    it('a non-array yields nothing rather than throwing', () => {
        expect(regexNames(null)).toEqual([]);
        expect(regexNames(undefined)).toEqual([]);
        expect(findRegexByName(null, 'A')).toBe(null);
    });

    // Case-SENSITIVE by contract: ST treats 'HideChoices' and 'hidechoices' as two different regexes, so a
    // loose match would let one of them claim to be the one the pack manages.
    it('matches script_name case-sensitively', () => {
        expect(findRegexByName([rx('HideChoices')], 'HideChoices')).toBeTruthy();
        expect(findRegexByName([rx('HideChoices')], 'hidechoices')).toBe(null);
    });
});

describe('normalizeTavernRegex — a pack may write only what it means', () => {
    it('fills the full TavernRegex shape from a minimal declaration', () => {
        const out = normalizeTavernRegex({ script_name: 'A', find_regex: '/x/g' }, 'new-id');
        expect(out).toEqual({
            id: 'new-id', script_name: 'A', enabled: true, find_regex: '/x/g', replace_string: '',
            trim_strings: [],
            source: { user_input: false, ai_output: true, slash_command: false, world_info: false, reasoning: false },
            destination: { display: true, prompt: false },
            run_on_edit: true, min_depth: null, max_depth: null,
        });
    });

    // The one default that must never be inherited by accident: destination.prompt rewrites what the MODEL
    // reads. A pack naming only `display` must not silently switch `prompt` on, and vice versa.
    it('MERGES source/destination onto the defaults instead of replacing them', () => {
        const out = normalizeTavernRegex({ script_name: 'A', find_regex: '/x/g', destination: { prompt: true } });
        expect(out.destination).toEqual({ display: true, prompt: true });
        const off = normalizeTavernRegex({ script_name: 'A', find_regex: '/x/g', destination: { display: false } });
        expect(off.destination).toEqual({ display: false, prompt: false });
    });

    it('keeps an explicit false rather than treating it as absent', () => {
        expect(normalizeTavernRegex({ script_name: 'A', enabled: false }).enabled).toBe(false);
        expect(normalizeTavernRegex({ script_name: 'A', run_on_edit: false }).run_on_edit).toBe(false);
    });
});

describe('upsert — by name, never by id', () => {
    it('updates in place, keeping the EXISTING id and position', () => {
        const list = [rx('A'), rx('B'), rx('C')];
        const { list: out, created } = upsertRegexInList(list, { script_name: 'B', find_regex: '/new/g' }, 'ignored');
        expect(created).toBe(false);
        expect(regexNames(out)).toEqual(['A', 'B', 'C']);          // position held — order IS apply order
        expect(out[1].id).toBe('id-B');                            // id held — ST's editor references it
        expect(out[1].find_regex).toBe('/new/g');
    });

    // The pack file ships the ids it was exported with, so this is the live case: an incoming regex whose
    // id DISAGREES with the card's must not carry its own in. ST's editor holds references to the card's,
    // and a pack installed on two cards would otherwise force the same id onto both.
    it('an incoming id NEVER replaces the card\'s — identity belongs to the installation', () => {
        const { list: out } = upsertRegexInList([rx('B')], { id: 'from-the-pack-file', script_name: 'B', find_regex: '/n/g' }, 'unused');
        expect(out[0].id).toBe('id-B');
    });

    it('creates at the end with the supplied id', () => {
        const { list: out, created } = upsertRegexInList([rx('A')], { script_name: 'Z', find_regex: '/z/g' }, 'fresh');
        expect(created).toBe(true);
        expect(regexNames(out)).toEqual(['A', 'Z']);
        expect(out[1].id).toBe('fresh');
    });

    it('never mutates the input list — a failed write must not be half-applied', () => {
        const list = [rx('A')];
        upsertRegexInList(list, { script_name: 'A', find_regex: '/changed/g' }, 'x');
        expect(list[0].find_regex).toBe('/A/g');
    });

    it('a nameless regex is a no-op, not an anonymous append', () => {
        const { list: out, created } = upsertRegexInList([rx('A')], { find_regex: '/x/g' }, 'x');
        expect(created).toBe(false);
        expect(regexNames(out)).toEqual(['A']);
    });

    it('counts created vs updated across many', () => {
        const res = upsertRegexesInList([rx('A')], [{ script_name: 'A' }, { script_name: 'B' }, { script_name: 'C' }], (i) => 'n' + i);
        expect({ created: res.created, updated: res.updated }).toEqual({ created: 2, updated: 1 });
        expect(regexNames(res.list)).toEqual(['A', 'B', 'C']);
    });
});

describe('remove', () => {
    it('removes every listed name and counts them', () => {
        const { list, removed } = removeRegexesByName([rx('A'), rx('B'), rx('C')], ['A', 'C']);
        expect(removed).toBe(2);
        expect(regexNames(list)).toEqual(['B']);
    });

    it('a name that is already gone is simply not found', () => {
        const { list, removed } = removeRegexesByName([rx('A')], ['ghost']);
        expect(removed).toBe(0);
        expect(regexNames(list)).toEqual(['A']);
    });

    it('an empty name list touches nothing', () => {
        expect(removeRegexesByName([rx('A')], []).list).toHaveLength(1);
    });
});

describe('syncRegexesInList — one pass, because it must be one host write', () => {
    it('drops a stale name the new version no longer ships, and keeps the card\'s own', () => {
        const card = [rx('CardOwn'), rx('Old'), rx('Keep')];
        const res = syncRegexesInList(card, [{ script_name: 'Keep', find_regex: '/k/g' }, { script_name: 'New', find_regex: '/n/g' }], ['Old', 'Keep'], (i) => 'n' + i);
        expect(res.droppedNames).toEqual(['Old']);
        expect(res.removed).toBe(1);
        expect(regexNames(res.list)).toEqual(['CardOwn', 'Keep', 'New']);
    });

    // The guard that makes an upgrade non-destructive: a name in BOTH the record and the new pack is still
    // ours, so removing-then-adding it would discard the id ST's editor holds.
    it('does NOT remove-then-recreate a name the new version still ships', () => {
        const res = syncRegexesInList([rx('Keep')], [{ script_name: 'Keep', find_regex: '/k2/g' }], ['Keep'], () => 'fresh');
        expect(res.removed).toBe(0);
        expect(res.list[0].id).toBe('id-Keep');
        expect(res.list[0].find_regex).toBe('/k2/g');
    });
});

describe('§8 conflict — a pack never silently overwrites a regex the user owns', () => {
    // NAMES on every side. Passing regex OBJECTS here used to yield an empty comparison and wave every
    // collision through — the shape mismatch this test now pins.
    const card = ['HideChoices', 'UserOwn'];

    it('names every card regex the pack also ships when nothing is recorded as ours', () => {
        expect(conflictingRegexNames(card, ['HideChoices', 'Fresh'], [])).toEqual(['HideChoices']);
    });

    // Repair and upgrade meet the pack's OWN previous write. Treating that as a conflict would make a pack
    // installable exactly once.
    it('is NOT a conflict when the registry recorded the name as this pack\'s', () => {
        expect(conflictingRegexNames(card, ['HideChoices'], ['HideChoices'])).toEqual([]);
    });

    it('a name absent from the card is never a conflict', () => {
        expect(conflictingRegexNames(card, ['Fresh'], [])).toEqual([]);
    });

    it('reports every collision, not just the first — the fix is per-regex', () => {
        expect(conflictingRegexNames(card, ['HideChoices', 'UserOwn'], [])).toEqual(['HideChoices', 'UserOwn']);
    });
});

describe('uninstall exactness — the record is the whole handle', () => {
    it('agrees when every recorded name is still on the card', () => {
        expect(regexUninstallExactness(['A', 'B'], ['A', 'B', 'CardOwn']).agree).toBe(true);
    });

    it('names a recorded regex that is already gone instead of passing over it', () => {
        const res = regexUninstallExactness(['A', 'B'], ['A']);
        expect(res.agree).toBe(false);
        expect(res.onlyInRecord).toEqual(['B']);
    });
});

// ── writing the card the way SillyTavern writes it (2026-08-24) ──────────────────────────────────────
// Live failure that produced all of this: a pack install wrote 14 regexes, TavernHelper's own settings
// watcher wrote the whole card 26 ms earlier with the pre-install 2, its POST finished last, and the card
// lost 12 while memory kept all 14 — so every read-back said "installed" and so did the tab.
// The fix is to stop routing card writes through a full-card writer at all and use SillyTavern's own
// targeted save. That means converting the pack's TavernHelper-shaped entries into SillyTavern's shape,
// which is what these guard: the two shapes disagree on nearly every field name and on one boolean's SENSE.
describe('toSillyTavernRegex — the pack shape is not the card shape', () => {
    const pack = normalizeTavernRegex({
        id: 'abc', script_name: 'HideChoices', find_regex: '/<choices>.*?</choices>/g',
        replace_string: '', source: { ai_output: true, user_input: true }, destination: { display: true },
    });

    it('renames every field to what the card actually stores', () => {
        const st = toSillyTavernRegex(pack, PLACEMENT);
        expect(st.scriptName).toBe('HideChoices');
        expect(st.findRegex).toBe('/<choices>.*?</choices>/g');
        expect(st.replaceString).toBe('');
        expect(st.id).toBe('abc');
    });

    it('INVERTS enabled into disabled — the one field a careless copy gets backwards', () => {
        expect(toSillyTavernRegex({ ...pack, enabled: true }, PLACEMENT).disabled).toBe(false);
        expect(toSillyTavernRegex({ ...pack, enabled: false }, PLACEMENT).disabled).toBe(true);
    });

    it('turns the source flags into SillyTavern placement slots, in enum order', () => {
        const st = toSillyTavernRegex(pack, PLACEMENT);
        expect(st.placement).toEqual([PLACEMENT.USER_INPUT, PLACEMENT.AI_OUTPUT]);
    });

    it('a pack entry that names NO destination still defaults to display-only', () => {
        // The raw pack shape, NOT run through normalizeTavernRegex — a converter that read `=== true`
        // instead of `!== false` would silently turn every such entry into a prompt-side regex.
        const st = toSillyTavernRegex({ script_name: 'Bare', find_regex: '/x/' }, PLACEMENT);
        expect(st.markdownOnly).toBe(true);
        expect(st.promptOnly).toBe(false);
    });

    it('a display-only regex never claims the prompt — that decides what the MODEL reads', () => {
        const st = toSillyTavernRegex(pack, PLACEMENT);
        expect(st.markdownOnly).toBe(true);
        expect(st.promptOnly).toBe(false);
        const prompt = toSillyTavernRegex(normalizeTavernRegex({ ...pack, destination: { display: false, prompt: true } }), PLACEMENT);
        expect(prompt.markdownOnly).toBe(false);
        expect(prompt.promptOnly).toBe(true);
    });

    it('carries the depth window through, nulls included', () => {
        const st = toSillyTavernRegex(normalizeTavernRegex({ ...pack, min_depth: 1, max_depth: 4 }), PLACEMENT);
        expect(st.minDepth).toBe(1);
        expect(st.maxDepth).toBe(4);
        expect(toSillyTavernRegex(pack, PLACEMENT).minDepth).toBe(null);
    });

    it('emits no placement slot for a source the host has no enum for', () => {
        const st = toSillyTavernRegex(normalizeTavernRegex({ ...pack, source: { ai_output: true, reasoning: true } }), {});
        expect(st.placement).toEqual([]);
    });
});

describe('mergeScopedScripts — the card keeps what it owns', () => {
    const mine = (name) => ({ scriptName: name, findRegex: '/x/', disabled: false });
    const theirs = [{ scriptName: 'StatusMenu', findRegex: '/menu/', id: 'card-1' }];

    it('creates ours and never touches the card\'s own', () => {
        const r = mergeScopedScripts(theirs, [mine('HideChoices')], [], () => 'new-1');
        expect(r.list.map((x) => x.scriptName)).toEqual(['StatusMenu', 'HideChoices']);
        expect(r.created).toBe(1);
        expect(r.list[0]).toEqual(theirs[0]);
    });

    it('updates in PLACE — list order is apply order, so a moved regex changes what matches first', () => {
        const current = [mine('A'), { scriptName: 'B', findRegex: '/old/', id: 'keep-me' }, mine('C')];
        const r = mergeScopedScripts(current, [{ scriptName: 'B', findRegex: '/new/' }], [], () => 'x');
        expect(r.list.map((x) => x.scriptName)).toEqual(['A', 'B', 'C']);
        expect(r.list[1].findRegex).toBe('/new/');
        expect(r.list[1].id).toBe('keep-me');
        expect(r.updated).toBe(1);
    });

    it('drops what a previous version installed and this one no longer ships', () => {
        const current = [mine('StatusMenu'), mine('OldName')];
        const r = mergeScopedScripts(current, [mine('NewName')], ['OldName'], () => 'x');
        expect(r.list.map((x) => x.scriptName)).toEqual(['StatusMenu', 'NewName']);
        expect(r.removed).toBe(1);
    });

    it('a name that is BOTH stale and still shipped survives — a rename back is not a delete', () => {
        const r = mergeScopedScripts([mine('Kept')], [mine('Kept')], ['Kept'], () => 'x');
        expect(r.list.map((x) => x.scriptName)).toEqual(['Kept']);
        expect(r.removed).toBe(0);
        expect(r.updated).toBe(1);
    });

    it("returns a NEW array — the caller's list is never the one we hand back", () => {
        const current = [mine('StatusMenu')];
        const r = mergeScopedScripts(current, [mine('HideChoices')], [], () => 'x');
        expect(r.list).not.toBe(current);
        expect(current.map((x) => x.scriptName)).toEqual(['StatusMenu']);
    });
});

describe('missingScriptNames — the whole verification, made testable', () => {
    it('names what did not reach the card', () => {
        expect(missingScriptNames(['A', 'B', 'C'], ['A', 'C'])).toEqual(['B']);
    });
    it('a card that has everything reports nothing missing', () => {
        expect(missingScriptNames(['A', 'B'], ['B', 'A', 'StatusMenu'])).toEqual([]);
    });
    it('an EMPTY card reports every name — the live lost-write shape', () => {
        expect(missingScriptNames(['A', 'B'], [])).toEqual(['A', 'B']);
    });
    it('extra names on the card are the user\'s own and are not our business', () => {
        expect(missingScriptNames(['A'], ['A', 'TheirOwnRegex'])).toEqual([]);
    });
});

describe('presentScriptNames — the uninstall half of the same verification', () => {
    it('names what survived a removal', () => {
        expect(presentScriptNames(['A', 'B', 'C'], ['A', 'C', 'StatusMenu'])).toEqual(['A', 'C']);
    });
    it('a card that lost them all reports nothing surviving', () => {
        expect(presentScriptNames(['A', 'B'], ['StatusMenu'])).toEqual([]);
    });
    it('an unreachable-looking EMPTY card reports nothing — absence IS the goal here', () => {
        // The exact inverse of missingScriptNames, and the reason the two cannot share one function: an
        // empty card is a total FAILURE for an install and a total SUCCESS for an uninstall.
        expect(presentScriptNames(['A', 'B'], [])).toEqual([]);
        expect(missingScriptNames(['A', 'B'], [])).toEqual(['A', 'B']);
    });
    it("the card’s own regexes are never reported — we only asked about ours", () => {
        expect(presentScriptNames(['A'], ['TheirOwnRegex'])).toEqual([]);
    });
});

describe('mergeScopedScripts — a re-apply of the same version is NOT a write', () => {
    // The live cost this exists for: the dev loop re-applies every artifact on connect, and each one
    // shipping regexes paid a chat reload whether or not a byte had changed (3 reloads at boot, 2026-08-28).
    const onCard = (name, find) => ({ scriptName: name, findRegex: find, disabled: false, id: 'card-' + name, trimStrings: [], placement: [2] });
    const incoming = (name, find) => ({ scriptName: name, findRegex: find, disabled: false, id: '', trimStrings: [], placement: [2] });

    it('MUTATION TARGET — identical scripts count 0 updated and the card entry is kept as-is', () => {
        const current = [onCard('StatusMenu', '/menu/'), onCard('HideChoices', '/x/')];
        const r = mergeScopedScripts(current, [incoming('StatusMenu', '/menu/'), incoming('HideChoices', '/x/')], [], () => 'new');
        expect(r.updated).toBe(0);
        expect(r.created).toBe(0);
        expect(r.removed).toBe(0);
        expect(r.list[0]).toBe(current[0]);      // the very object — nothing was rebuilt
    });

    it('one differing field is one update, the rest stay untouched', () => {
        const current = [onCard('StatusMenu', '/menu/'), onCard('HideChoices', '/x/')];
        const r = mergeScopedScripts(current, [incoming('StatusMenu', '/menu-v2/'), incoming('HideChoices', '/x/')], [], () => 'new');
        expect(r.updated).toBe(1);
        expect(r.list[0].findRegex).toBe('/menu-v2/');
        expect(r.list[1]).toBe(current[1]);
    });

    it('scriptsEqual ignores key order and nothing else', () => {
        expect(scriptsEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
        expect(scriptsEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
        expect(scriptsEqual({ a: '1' }, { a: 1 })).toBe(false);
    });
});

describe('mergeScopedScripts with nothing incoming IS the uninstall', () => {
    const mine = (n) => ({ scriptName: n, id: 'id-' + n, findRegex: '/x/' });

    it("drops exactly the named scripts and keeps the card’s own", () => {
        const current = [mine('StatusMenu'), mine('HideChoices'), mine('HideTraitCheck')];
        const r = mergeScopedScripts(current, [], ['HideChoices', 'HideTraitCheck'], () => 'x');
        expect(r.list.map((x) => x.scriptName)).toEqual(['StatusMenu']);
        expect(r.removed).toBe(2);
        expect(r.created).toBe(0);
        expect(r.updated).toBe(0);
    });

    it('a name that is not on the card removes nothing and is not an error', () => {
        // The live shape after a hand-deletion: the pack still records a name the card no longer has.
        const current = [mine('StatusMenu')];
        const r = mergeScopedScripts(current, [], ['AlreadyGoneByHand'], () => 'x');
        expect(r.list.map((x) => x.scriptName)).toEqual(['StatusMenu']);
        expect(r.removed).toBe(0);
    });

    it('removed=0 is what lets the caller skip the card write entirely', () => {
        const r = mergeScopedScripts([], [], ['A', 'B'], () => 'x');
        expect(r.removed).toBe(0);
        expect(r.list).toEqual([]);
    });

    it('does not mutate the card list it was handed', () => {
        const current = [mine('StatusMenu'), mine('HideChoices')];
        const r = mergeScopedScripts(current, [], ['HideChoices'], () => 'x');
        expect(r.list).not.toBe(current);
        expect(current.map((x) => x.scriptName)).toEqual(['StatusMenu', 'HideChoices']);
    });
});

describe('the two verify directions are not interchangeable', () => {
    // Swapping these is the one mistake that turns a guard into its own opposite, and it is silent: the
    // uninstall would repair the card back to holding the regexes it was told to delete, then log success.
    it('an EMPTY card is total failure for an install and total success for a removal', () => {
        expect(VERIFY_INSTALL.offendersOn(['A', 'B'], [])).toEqual(['A', 'B']);
        expect(VERIFY_REMOVAL.offendersOn(['A', 'B'], [])).toEqual([]);
    });

    it('a card that still holds everything is the exact reverse', () => {
        expect(VERIFY_INSTALL.offendersOn(['A', 'B'], ['A', 'B'])).toEqual([]);
        expect(VERIFY_REMOVAL.offendersOn(['A', 'B'], ['A', 'B'])).toEqual(['A', 'B']);
    });

    it('each direction reports the offenders the OTHER one calls fine', () => {
        const onCard = ['A', 'StatusMenu'];
        expect(VERIFY_INSTALL.offendersOn(['A', 'B'], onCard)).toEqual(['B']);
        expect(VERIFY_REMOVAL.offendersOn(['A', 'B'], onCard)).toEqual(['A']);
    });

    it('the wording matches the predicate it travels with', () => {
        // A message describing the opposite of what its check tests is how a log sends you hunting the
        // wrong bug — worse than no log at all.
        expect(VERIFY_INSTALL.lost(3)).toMatch(/did NOT reach/);
        expect(VERIFY_INSTALL.fixed(3)).toMatch(/are on the card/);
        expect(VERIFY_REMOVAL.lost(3)).toMatch(/NOT removed/);
        expect(VERIFY_REMOVAL.fixed(3)).toMatch(/are off the card/);
        expect(VERIFY_INSTALL.lost(3)).not.toEqual(VERIFY_REMOVAL.lost(3));
    });
});

describe('§11 adoption — which scoped scripts the card already matches', () => {
    const card = (over = {}) => ({ id: 'card-id', scriptName: 'A', findRegex: '/a/g', replaceString: '', disabled: false, ...over });
    const incoming = (over = {}) => ({ id: '', scriptName: 'A', findRegex: '/a/g', replaceString: '', disabled: false, ...over });

    it('the card\'s id is what the write would keep, so it is not a difference', () => {
        expect(scopedScriptUnchanged(card(), incoming())).toBe(true);
    });

    it('any other field differing is a difference', () => {
        expect(scopedScriptUnchanged(card(), incoming({ findRegex: '/b/g' }))).toBe(false);
        expect(scopedScriptUnchanged(card(), incoming({ disabled: true }))).toBe(false);
    });

    it('a missing side never reads as unchanged', () => {
        expect(scopedScriptUnchanged(null, incoming())).toBe(false);
        expect(scopedScriptUnchanged(card(), null)).toBe(false);
    });

    // The rule mergeScopedScripts counts an update by IS this function — if the two ever diverge, an
    // adoption claims ownership of a regex the write would actually have changed.
    it('agrees with mergeScopedScripts: unchanged here means zero updates there', () => {
        expect(mergeScopedScripts([card()], [incoming()], [], () => 'x').updated).toBe(0);
        expect(mergeScopedScripts([card()], [incoming({ findRegex: '/b/g' })], [], () => 'x').updated).toBe(1);
    });

    it('names only what is on the card AND identical', () => {
        const current = [card({ scriptName: 'A' }), card({ id: 'other', scriptName: 'B', findRegex: '/CARD/g' })];
        const want = [incoming({ scriptName: 'A' }), incoming({ scriptName: 'B', findRegex: '/PACK/g' }), incoming({ scriptName: 'C' })];
        expect(unchangedScopedNames(current, want)).toEqual(['A']);
    });

    // MUTATION TARGET: return names absent from the card as "unchanged" (nothing there to differ from)
    // and a fresh install reports every regex as already-adopted before it has written one.
    it('a name the card does NOT have is not adoptable — there is nothing there to claim', () => {
        expect(unchangedScopedNames([], [incoming({ scriptName: 'A' })])).toEqual([]);
    });

    it('empty and malformed inputs answer empty, never throw', () => {
        expect(unchangedScopedNames(null, null)).toEqual([]);
        expect(unchangedScopedNames([card()], [{ scriptName: '' }])).toEqual([]);
    });
});

describe('W9 — declaredOrder: a pack may pin its OWN relative order, and only that (§2.8)', () => {
    const mine = (name) => ({ scriptName: name, findRegex: '/x/', disabled: false });
    // A realistic card list: a user regex first, then the pack's rows interleaved with another one.
    const card = [
        { scriptName: 'UserOwn', findRegex: '/u/', id: 'u-1' },
        { scriptName: 'StatusMenu', findRegex: '/x/', id: 's-1' },
        { scriptName: 'Foreign', findRegex: '/f/', id: 'f-1' },
        { scriptName: 'GameStartMenu', findRegex: '/x/', id: 'g-1' },
    ];

    it('reorders the pack\'s rows across THEIR slots; foreign rows never move', () => {
        const r = mergeScopedScripts(card, [mine('GameStartMenu'), mine('StatusMenu')], [], () => 'x',
            { declaredOrder: ['GameStartMenu', 'StatusMenu'] });
        expect(r.list.map((x) => x.scriptName)).toEqual(['UserOwn', 'GameStartMenu', 'Foreign', 'StatusMenu']);
        expect(r.reordered).toBe(2);
    });

    it('TERMINATES — the merge after a reorder counts zero, so no save and no reload ever re-fires', () => {
        const first = mergeScopedScripts(card, [mine('GameStartMenu'), mine('StatusMenu')], [], () => 'x',
            { declaredOrder: ['GameStartMenu', 'StatusMenu'] });
        const second = mergeScopedScripts(first.list, [mine('GameStartMenu'), mine('StatusMenu')], [], () => 'x',
            { declaredOrder: ['GameStartMenu', 'StatusMenu'] });
        expect(second.reordered).toBe(0);
        expect(second.created + second.updated + second.removed).toBe(0);
    });

    it('MUTATION target — no declaration means TODAY\'s stickiness, not a weaker ordering', () => {
        const r = mergeScopedScripts(card, [mine('GameStartMenu'), mine('StatusMenu')], [], () => 'x');
        expect(r.list.map((x) => x.scriptName)).toEqual(['UserOwn', 'StatusMenu', 'Foreign', 'GameStartMenu']);
        expect(r.reordered).toBe(0);
    });

    it('a fresh install lands already ordered — created rows join the placement', () => {
        const r = mergeScopedScripts([], [mine('B'), mine('A')], [], () => 'x', { declaredOrder: ['B', 'A'] });
        expect(r.list.map((x) => x.scriptName)).toEqual(['B', 'A']);
        expect(r.reordered).toBe(0);   // pushed in declared order — nothing left to move
    });

    it('a declared name with no row on the card is skipped, never a hole', () => {
        const r = mergeScopedScripts(card, [mine('StatusMenu')], [], () => 'x',
            { declaredOrder: ['Ghost', 'StatusMenu'] });
        expect(r.list.map((x) => x.scriptName)).toEqual(['UserOwn', 'StatusMenu', 'Foreign', 'GameStartMenu']);
        expect(r.list.every(Boolean)).toBe(true);
    });
});
