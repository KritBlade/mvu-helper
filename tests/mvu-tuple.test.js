// shared/mvu-tuple.js — MVU's [value, "Label"] tuple read as its value, shared by the roster scan,
// the side panel and the stat box.
import { describe, it, expect } from 'vitest';
import { unwrapTupleValue } from '../src/shared/mvu-tuple.js';

describe('unwrapTupleValue', () => {
    it('unwraps ONLY the exact [value,"Label"] shape', () => {
        expect(unwrapTupleValue([5000, 'Money'])).toBe(5000);
        expect(unwrapTupleValue([true, ''])).toBe(true);          // an empty label is still a label
        expect(unwrapTupleValue([1, 2])).toEqual([1, 2]);
        expect(unwrapTupleValue(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });
    it('passes bare values through', () => {
        expect(unwrapTupleValue('plain')).toBe('plain');
        expect(unwrapTupleValue(false)).toBe(false);
        expect(unwrapTupleValue(undefined)).toBe(undefined);
    });
});
