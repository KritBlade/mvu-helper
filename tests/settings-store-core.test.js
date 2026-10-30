import { describe, it, expect } from 'vitest';
import { fillMissingDefaults, profileRecordFor } from '../src/sillytavern/settings-store-core.js';

// A profile belongs to a card. SillyTavern's lobby paints every panel, and each paint reads a profile:
// storing one there saved records keyed "SillyTavern System", "Assistant" and "chat" that no card reads
// and no re-import ever cleans.
describe('profileRecordFor - which record getProfile hands back', () => {
    const defaults = { extraLlmCalls: { enabled: true, calls: [] }, logicEngine: { enabled: true } };

    it('with NO card open, returns a copy of the defaults and stores nothing', () => {
        const profiles = {};
        const record = profileRecordFor(profiles, 'goten_sillytavern_system_xg9mp8', defaults, { isCardOpen: false });
        expect(record).toEqual(defaults);
        expect(profiles).toEqual({});
    });

    // A write in the lobby is saved nowhere, so it must not look like it worked: the card gate keeps every
    // per-card control out of reach there, and a write that still arrives is a missed gate the console names.
    it('MUTATION TARGET — with NO card open, the copy is frozen to its leaves, so a write throws', () => {
        const profiles = {};
        const record = profileRecordFor(profiles, 'goten_assistant_1ypkwuq', defaults, { isCardOpen: false });
        expect(() => { record.extraLlmCalls.enabled = false; }).toThrow(TypeError);
        expect(() => { record.extraLlmCalls.calls.push({ id: 'pre' }); }).toThrow(TypeError);
        expect(() => { record.roster = {}; }).toThrow(TypeError);
        expect(profiles).toEqual({});
        expect(defaults.extraLlmCalls.enabled).toBe(true);
        expect(Object.isFrozen(defaults)).toBe(false);
    });

    it('with a card open, the record is never frozen', () => {
        const record = profileRecordFor({}, 'goten_artifickoi_1a8spvt', defaults, { isCardOpen: true });
        record.extraLlmCalls.calls.push({ id: 'pre' });
        expect(record.extraLlmCalls.calls).toEqual([{ id: 'pre' }]);
    });

    it('with a card open, creates its record from the defaults on first use', () => {
        const profiles = {};
        const record = profileRecordFor(profiles, 'goten_artifickoi_1a8spvt', defaults, { isCardOpen: true });
        expect(profiles.goten_artifickoi_1a8spvt).toBe(record);
        expect(record).toEqual(defaults);
        expect(record).not.toBe(defaults);
    });

    it('with a card open, returns the STORED record, so a write is kept', () => {
        const stored = { extraLlmCalls: { enabled: false, calls: [{ id: 'pre' }] } };
        const profiles = { goten_artifickoi_1a8spvt: stored };
        const record = profileRecordFor(profiles, 'goten_artifickoi_1a8spvt', defaults, { isCardOpen: true });
        expect(record).toBe(stored);
    });
});

// The gap this closes: loadSettings deep-merges GLOBAL defaults into an existing record, but PROFILE
// defaults are only cloned into records that do not exist yet — so a field added to any
// *ProfileDefaults never reached a card whose profile already existed. Four features hand-wrote a
// defensive accessor to work around it.
describe('fillMissingDefaults - the profile backfill profiles never had', () => {
    it('fills a missing TOP-LEVEL key', () => {
        const target = { imagegen: { hBlockAlwaysOn: true } };
        const filled = fillMissingDefaults(target, { imagegen: { hBlockAlwaysOn: false }, roster: { route: 'harvest' } });
        expect(target.roster).toEqual({ route: 'harvest' });
        expect(filled).toBe(1);
    });

    it('fills a missing NESTED key - the case a one-level merge misses', () => {
        // This is exactly the shape that forced the hand-written accessors: the sub-object EXISTS, so a
        // one-level merge sees the key present and stops, and the new field never lands.
        const target = { imagegen: { hBlockAlwaysOn: true } };
        const filled = fillMissingDefaults(target, { imagegen: { hBlockAlwaysOn: false, newField: 'x' } });
        expect(target.imagegen.newField).toBe('x');
        expect(filled).toBe(1);
    });

    it('NEVER clobbers a value that is present, including a falsy one', () => {
        // A backfill that "corrects" false/0/'' is a settings reset wearing a helpful face.
        const target = { a: { enabled: false, count: 0, name: '', nothing: null } };
        const filled = fillMissingDefaults(target, { a: { enabled: true, count: 99, name: 'default', nothing: 'x' } });
        expect(target.a).toEqual({ enabled: false, count: 0, name: '', nothing: null });
        expect(filled).toBe(0);
    });

    it('treats arrays as LEAVES - a present list is never merged element-wise', () => {
        // Merging would resurrect entries the user deleted.
        const target = { a: { calls: [] } };
        const filled = fillMissingDefaults(target, { a: { calls: [{ id: 'seed' }], groups: [] } });
        expect(target.a.calls).toEqual([]);
        expect(target.a.groups).toEqual([]);
        expect(filled).toBe(1);
    });

    it('clones what it fills, so two profiles never share one object', () => {
        const defaults = { a: { list: [1, 2], deep: { k: 'v' } } };
        const one = {}; const two = {};
        fillMissingDefaults(one, defaults);
        fillMissingDefaults(two, defaults);
        one.a.list.push(3);
        one.a.deep.k = 'changed';
        expect(two.a.list).toEqual([1, 2]);
        expect(two.a.deep.k).toBe('v');
        expect(defaults.a.deep.k).toBe('v');
    });

    it('leaves a wrong-TYPED value alone - that is a validator job, not a backfill job', () => {
        // Replacing it here would hide the corruption the hand-written type checks exist to catch.
        const target = { a: 'not-an-object' };
        const filled = fillMissingDefaults(target, { a: { enabled: true } });
        expect(target.a).toBe('not-an-object');
        expect(filled).toBe(0);
    });

    it('is inert on junk input rather than throwing into a settings read', () => {
        expect(fillMissingDefaults(null, { a: 1 })).toBe(0);
        expect(fillMissingDefaults({}, null)).toBe(0);
        expect(fillMissingDefaults([], { a: 1 })).toBe(0);
        expect(fillMissingDefaults({}, [])).toBe(0);
    });

    it('reports the COUNT it filled, so the caller can say so instead of guessing', () => {
        const target = { a: { one: 1 } };
        expect(fillMissingDefaults(target, { a: { one: 9, two: 2, three: 3 }, b: {}, c: 4 })).toBe(4);
    });
});
