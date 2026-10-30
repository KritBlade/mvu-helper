import { describe, it, expect } from 'vitest';
import { bustPlaceholderFor, planBustPlaceholderSeed, seededBustPlaceholderIndexes } from '../src/features/imagegen/comfy-placeholder-core.js';

const SEEDED = { find: 'bust_strength', replace: '{{getvar::bust_strength}}' };

describe('bustPlaceholderFor — the entry the bust multiplier needs', () => {
    it('MUTATION TARGET — find is the variable, replace reads it with getvar', () => {
        expect(bustPlaceholderFor('bust_strength')).toEqual(SEEDED);
    });
    it('trims the name, as the variable is written', () => {
        expect(bustPlaceholderFor('  bust  ')).toEqual({ find: 'bust', replace: '{{getvar::bust}}' });
    });
    it('a blank name has no entry', () => {
        expect(bustPlaceholderFor('')).toBeNull();
        expect(bustPlaceholderFor('   ')).toBeNull();
        expect(bustPlaceholderFor(undefined)).toBeNull();
    });
});

describe('planBustPlaceholderSeed — add, keep, or leave the user\'s own', () => {
    it('MUTATION TARGET — no list at all: add (SillyTavern creates it on its first "+")', () => {
        expect(planBustPlaceholderSeed(undefined, 'bust_strength')).toEqual({ action: 'add', entry: SEEDED, existing: null });
    });
    it('a list without the find: add', () => {
        const list = [{ find: 'style', replace: 'anime' }];
        expect(planBustPlaceholderSeed(list, 'bust_strength').action).toBe('add');
    });
    it('the exact entry already there: present, nothing to do', () => {
        const list = [{ find: 'style', replace: 'anime' }, { ...SEEDED }];
        expect(planBustPlaceholderSeed(list, 'bust_strength').action).toBe('present');
    });
    it('MUTATION TARGET — the find with another replace is the user\'s own: differs, never overwritten', () => {
        const mine = { find: 'bust_strength', replace: '1.2' };
        const plan = planBustPlaceholderSeed([mine], 'bust_strength');
        expect(plan.action).toBe('differs');
        expect(plan.existing).toBe(mine);
    });
    it('find matches exactly and case-sensitively, as SillyTavern replaces "%find%"', () => {
        expect(planBustPlaceholderSeed([{ find: 'Bust_Strength', replace: '{{getvar::bust_strength}}' }], 'bust_strength').action).toBe('add');
    });
    it('a blank variable name: skip', () => {
        expect(planBustPlaceholderSeed([], '').action).toBe('skip');
    });
    it('junk rows in the list are ignored, not thrown on', () => {
        expect(planBustPlaceholderSeed([null, 'x', 7, { ...SEEDED }], 'bust_strength').action).toBe('present');
    });
});

describe('seededBustPlaceholderIndexes — what unticking removes', () => {
    it('MUTATION TARGET — finds the exact seeded entry', () => {
        expect(seededBustPlaceholderIndexes([{ find: 'style', replace: 'anime' }, { ...SEEDED }], 'bust_strength')).toEqual([1]);
    });
    it('never the user\'s own entry under the same find', () => {
        expect(seededBustPlaceholderIndexes([{ find: 'bust_strength', replace: '1.2' }], 'bust_strength')).toEqual([]);
    });
    it('every copy, highest index first, so splicing in order removes the right ones', () => {
        const list = [{ ...SEEDED }, { find: 'style', replace: 'anime' }, { ...SEEDED }];
        const indexes = seededBustPlaceholderIndexes(list, 'bust_strength');
        expect(indexes).toEqual([2, 0]);
        for (const i of indexes) list.splice(i, 1);
        expect(list).toEqual([{ find: 'style', replace: 'anime' }]);
    });
    it('no list, or a blank name: nothing', () => {
        expect(seededBustPlaceholderIndexes(undefined, 'bust_strength')).toEqual([]);
        expect(seededBustPlaceholderIndexes([{ ...SEEDED }], '')).toEqual([]);
    });
});
