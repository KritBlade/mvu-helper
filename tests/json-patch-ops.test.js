// tests/json-patch-ops.test.js — the ONE definition of what a JSON Patch op is, for every writer
// that hands a block to Mvu.parseMessage (the PRE sim lane and the §23 plugin relay).
//
// ▲ These assertions used to exist TWICE — once in tests/extra-llm-calls-core.test.js against
// validateSimPatchOutput, once in tests/plugin-relay-core.test.js against a private copy of the same
// four checks. Two suites agreeing by luck is not one contract, so the checks moved here and both
// suites now test only what is theirs: how their lane FEEDS these decisions, and what it does with
// the answer.

import { describe, it, expect } from 'vitest';
import {
    PATCH_VERBS, getAtPointer, patchOpShapeProblem, salvagePatchOps, opsMissingAfterApply,
    opsOutcomeAfterApply, renderOpOutcome, firstDifferingKey,
} from '../src/shared/json-patch-ops.js';

describe('PATCH_VERBS', () => {
    it('is add/remove/replace and nothing else — no move/copy/test, ever', () => {
        expect(PATCH_VERBS).toEqual(['add', 'remove', 'replace']);
    });
});

describe('patchOpShapeProblem — SHAPE only, never semantics', () => {
    it('passes a well-formed op of each verb', () => {
        expect(patchOpShapeProblem({ op: 'replace', path: '/A/x', value: 1 }, 0)).toBe('');
        expect(patchOpShapeProblem({ op: 'add', path: '/A/x', value: 1 }, 0)).toBe('');
        expect(patchOpShapeProblem({ op: 'remove', path: '/A/x' }, 0)).toBe('');
    });

    it('names the index and the offending verb', () => {
        expect(patchOpShapeProblem({ op: 'seT', path: '/A/x', value: 1 }, 3)).toContain('op #3');
        expect(patchOpShapeProblem({ op: 'seT', path: '/A/x', value: 1 }, 3)).toContain('seT');
        expect(patchOpShapeProblem({ op: 'move', from: '/A', path: '/B' }, 0)).toContain('not in');
    });

    it('refuses a non-object, a dotted path, and a missing value', () => {
        expect(patchOpShapeProblem(null, 0)).toContain('not an object');
        expect(patchOpShapeProblem('nope', 0)).toContain('not an object');
        expect(patchOpShapeProblem({ op: 'replace', path: 'A.B.C', value: 1 }, 0)).toContain('JSON-Pointer');
        expect(patchOpShapeProblem({ op: 'replace', path: '/A/x' }, 0)).toContain('no value');
        expect(patchOpShapeProblem({ op: 'add', path: '/A/x' }, 0)).toContain('no value');
    });

    // The containment argument, pinned: a path outside the writer's own subtree is NOT a shape
    // problem. The card's Zod refuses it, per op, and that refusal is the design.
    it('does NOT scope-check the path — any pointer is legal here', () => {
        expect(patchOpShapeProblem({ op: 'add', path: '/World/Weather/0', value: 'Storm' }, 0)).toBe('');
    });

    it('an explicit undefined value still counts as PRESENT ("value" in op)', () => {
        expect(patchOpShapeProblem({ op: 'replace', path: '/A/x', value: undefined }, 0)).toBe('');
    });
});

describe('salvagePatchOps — one bad op must never cost its siblings', () => {
    it('keeps the good ops in order and reports each drop by original index', () => {
        const { ops, dropped } = salvagePatchOps([
            { op: 'replace', path: '/A/good', value: 1 },
            { op: 'seT', path: '/A/bad', value: 2 },
            { op: 'replace', path: '/A/alsoGood', value: 3 },
        ]);
        expect(ops.map((o) => o.path)).toEqual(['/A/good', '/A/alsoGood']);
        expect(dropped).toHaveLength(1);
        expect(dropped[0].index).toBe(1);
        expect(dropped[0].reason).toContain('seT');
    });

    it('an empty array is a quiet turn, not a failure', () => {
        expect(salvagePatchOps([])).toEqual({ ops: [], dropped: [] });
    });

    it('every op bad is ops:[] with a NON-empty dropped — the caller must not read that as "no changes"', () => {
        const { ops, dropped } = salvagePatchOps([null, { op: 'move', path: '/A' }]);
        expect(ops).toEqual([]);
        expect(dropped).toHaveLength(2);
    });

    it('passes surviving ops through by reference — no rewriting behind the caller', () => {
        const op = { op: 'replace', path: '/A/x', value: 1 };
        expect(salvagePatchOps([op]).ops[0]).toBe(op);
    });

    it('runs a lane-specific extraProblem only on ops that already passed the shape check', () => {
        const seen = [];
        const { ops, dropped } = salvagePatchOps(
            [{ op: 'replace', path: '/A/x', value: 1 }, { op: 'seT', path: '/A/y', value: 2 }],
            (o, i) => { seen.push(i); return o.path === '/A/x' ? `op #${i} lane says no` : ''; },
        );
        expect(seen).toEqual([0]);                      // the malformed op #1 never reached it
        expect(ops).toEqual([]);
        expect(dropped[0].reason).toContain('lane says no');
    });
});

describe('getAtPointer', () => {
    it('walks a pointer and returns undefined for any missing hop', () => {
        const data = { A: { B: { C: 1 } }, list: ['x', 'y'] };
        expect(getAtPointer(data, '/A/B/C')).toBe(1);
        expect(getAtPointer(data, '/list/1')).toBe('y');
        expect(getAtPointer(data, '/A/nope/C')).toBeUndefined();
        expect(getAtPointer(null, '/A')).toBeUndefined();
    });

    it('an empty pointer addresses the whole object', () => {
        expect(getAtPointer({ a: 1 }, '')).toEqual({ a: 1 });
    });

    // Pinned as a KNOWN LIMIT, not an aspiration: decoding ~0/~1 would change what every live PRE
    // path resolves to, on the lane the turn's dice resolution rides.
    it('does NOT decode the RFC 6901 escapes — a literal "~1" is a literal segment', () => {
        expect(getAtPointer({ 'a/b': 1 }, '/a~1b')).toBeUndefined();
        expect(getAtPointer({ 'a~1b': 1 }, '/a~1b')).toBe(1);
    });
});

describe('opsMissingAfterApply — detection of what the card refused, never repair', () => {
    const after = { World: { Weather: ['Storm', 'x'] }, GameLogicPlugin: { LaneProbe: { RelayTurn: 3 } } };

    it('reports the refused paths, and only those', () => {
        expect(opsMissingAfterApply(after, [
            { op: 'replace', path: '/GameLogicPlugin/LaneProbe/RelayTurn', value: 3 },   // landed
            { op: 'add', path: '/World/RelayMustRefuse', value: 'x' },                   // refused
        ])).toEqual(['/World/RelayMustRefuse']);
    });

    it('a landed op at a tuple index is not reported missing', () => {
        expect(opsMissingAfterApply(after, [{ op: 'replace', path: '/World/Weather/0', value: 'Storm' }])).toEqual([]);
    });

    it('`remove` is never "missing" — absent IS its success case', () => {
        expect(opsMissingAfterApply(after, [{ op: 'remove', path: '/World/Gone' }])).toEqual([]);
    });

    it('a value written as null/false/0/"" counts as LANDED, not refused', () => {
        const statData = { A: { nulled: null, off: false, zero: 0, empty: '' } };
        expect(opsMissingAfterApply(statData, [
            { op: 'replace', path: '/A/nulled', value: null },
            { op: 'replace', path: '/A/off', value: false },
            { op: 'replace', path: '/A/zero', value: 0 },
            { op: 'replace', path: '/A/empty', value: '' },
        ])).toEqual([]);
    });

    it('tolerates a non-array ops argument instead of throwing mid-warn', () => {
        expect(opsMissingAfterApply(after, undefined)).toEqual([]);
        expect(opsMissingAfterApply(after, null)).toEqual([]);
    });
});

describe('opsOutcomeAfterApply — what the card DID with each op, not whether the path exists', () => {
    const run = (before, after, ops) => opsOutcomeAfterApply(before, after, ops);
    const one = (before, after, op) => run(before, after, [op])[0];

    it('stored equals sent ⇒ landed', () => {
        const r = one({ World: { Time: '09:00' } }, { World: { Time: '10:00' } }, { op: 'replace', path: '/World/Time', value: '10:00' });
        expect(r.state).toBe('landed');
        expect(r.sent).toBe('10:00');
        expect(r.stored).toBe('10:00');
    });

    // THE 2026-08-28 CASE, ArtificKoi builder B5 step 1. A bare number over a labelled tuple: the
    // path is present, so the old presence probe printed `wrote 1/1 op(s)` while the card kept
    // [5000,"Money"]. That log is the reason this function exists.
    it('stored equals BEFORE ⇒ refused, even though the path is present', () => {
        const before = { Mainchar: { Money: [5000, 'Money'] } };
        const after = { Mainchar: { Money: [5000, 'Money'] } };
        const r = one(before, after, { op: 'add', path: '/Mainchar/Money', value: 5001 });
        expect(r.state).toBe('refused');
        expect(r.stored).toEqual([5000, 'Money']);
    });

    // MUTATION TARGET (drop `before`): without it, refused and changed merge — a dropped op reads as
    // a schema transform, which is the author's bug reported as the schema working.
    it('refused and changed are distinguished ONLY by before', () => {
        const sent = { op: 'replace', path: '/A/x', value: 5 };
        expect(one({ A: { x: 1 } }, { A: { x: 1 } }, sent).state).toBe('refused');   // unchanged from before
        expect(one({ A: { x: 1 } }, { A: { x: 9 } }, sent).state).toBe('changed');   // moved, but not to 5
    });

    it('stored differs from BOTH sent and before ⇒ changed: a Zod default or transform landed', () => {
        const r = one({ A: { x: 1 } }, { A: { x: 7 } }, { op: 'replace', path: '/A/x', value: 5 });
        expect(r.state).toBe('changed');
        expect(r.sent).toBe(5);
        expect(r.stored).toBe(7);
    });

    it('a path absent after the apply is absent, and says whether anything was there before', () => {
        expect(one({}, {}, { op: 'add', path: '/New/Key', value: 1 }).state).toBe('absent');
        expect(one({}, {}, { op: 'add', path: '/New/Key', value: 1 }).note).toMatch(/nothing there before/);
        expect(one({ Old: { Key: 3 } }, {}, { op: 'replace', path: '/Old/Key', value: 1 }).note).toMatch(/previous value is gone/);
    });

    // MUTATION TARGET (skip remove): a Zod card refusing to delete a required key leaves the path
    // present. The old probe skipped removes entirely, so that refusal was invisible.
    it('remove inverts every test — gone is landed, still there is refused', () => {
        expect(one({ A: { x: 1 } }, {}, { op: 'remove', path: '/A/x' }).state).toBe('landed');
        const kept = one({ A: { x: 1 } }, { A: { x: 1 } }, { op: 'remove', path: '/A/x' });
        expect(kept.state).toBe('refused');
        expect(kept.note).toMatch(/still present/);
    });

    describe("MVU's two coercions — reachable only on a card with NO Zod schema", () => {
        it('a scalar over [value,"Label"] lands in slot 0', () => {
            const r = one({ M: { Money: [5000, 'Money'] } }, { M: { Money: [5001, 'Money'] } },
                { op: 'replace', path: '/M/Money', value: 5001 });
            expect(r.state).toBe('coerced');
            expect(r.note).toMatch(/slot 0/);
        });

        it('a string over a number becomes Number()', () => {
            const r = one({ M: { n: 1 } }, { M: { n: 5001 } }, { op: 'replace', path: '/M/n', value: '5001' });
            expect(r.state).toBe('coerced');
            expect(r.note).toMatch(/Number\(\)/);
        });

        // MVU's own branch requires the label to be a STRING and slot 0 not to be an array. A tuple
        // that fails those conditions never takes the slot-0 path, so calling the result a coercion
        // would excuse a write MVU did not make.
        it('MVU\'s own conditions gate it — a non-string label is not this coercion', () => {
            const r = one({ M: { t: [1, 2] } }, { M: { t: [5, 2] } }, { op: 'replace', path: '/M/t', value: 5 });
            expect(r.state).toBe('changed');
        });

        it('a null over a numeric slot 0 is stored as null, not Number(null)', () => {
            const r = one({ M: { a: [3, 'L'] } }, { M: { a: [null, 'L'] } }, { op: 'replace', path: '/M/a', value: null });
            expect(r.state).toBe('coerced');
        });
    });

    describe('objects compare DEEP — the nested-strip case', () => {
        // The root schema is looseObject but a nested z.object STRIPS, so an editListItem write comes
        // back one key lighter with everything else intact.
        // MUTATION TARGET (shallow equal): the strip reads as landed.
        it('a nested key the schema stripped is NOT landed, and the first differing key is named', () => {
            const sent = { name: 'Sword', dmg: 5, rarity: 'rare' };
            const stored = { name: 'Sword', dmg: 5 };
            const r = one({ Inv: { i0: {} } }, { Inv: { i0: stored } }, { op: 'add', path: '/Inv/i0', value: sent });
            expect(r.state).toBe('changed');
            expect(r.note).toContain('rarity');
        });

        it('a deep-equal object IS landed, key order aside', () => {
            const r = one({ Inv: {} }, { Inv: { i0: { b: 2, a: 1 } } }, { op: 'add', path: '/Inv/i0', value: { a: 1, b: 2 } });
            expect(r.state).toBe('landed');
        });

        it('firstDifferingKey names a key present on one side only', () => {
            expect(firstDifferingKey({ a: 1, b: 2 }, { a: 1 })).toBe('b');
            expect(firstDifferingKey({ a: 1 }, { a: 1 })).toBe('');
            expect(firstDifferingKey([1], [2])).toBe('');       // arrays are not key-diffed
        });
    });

    it('reports every op in order, and answers empty for no ops', () => {
        const rows = run({ A: { x: 1 } }, { A: { x: 2, y: 9 } }, [
            { op: 'replace', path: '/A/x', value: 2 },
            { op: 'add', path: '/A/y', value: 9 },
        ]);
        expect(rows.map((r) => r.state)).toEqual(['landed', 'landed']);
        expect(run({}, {}, [])).toEqual([]);
        expect(run({}, {}, null)).toEqual([]);
    });

    it('renderOpOutcome names the state, and shows the stored value only when it is not what was sent', () => {
        const landed = renderOpOutcome({ op: 'add', path: '/A/x', state: 'landed', sent: 1, stored: 1, note: '' });
        expect(landed).toBe('add /A/x=1 [landed]');
        const refused = renderOpOutcome({ op: 'add', path: '/M/Money', state: 'refused', sent: 5001, stored: [5000, 'Money'], note: 'unchanged from before the apply' });
        expect(refused).toContain('[refused: unchanged from before the apply]');
        expect(refused).toContain('stored [5000,"Money"]');
    });
});
