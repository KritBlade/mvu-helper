// tests/active-swipe-text.test.js — the second copy of a reply's text (shared/active-swipe-text.js).
//
// A write that moves only `mes` looks correct until the player swipes away and back: ST restores
// `mes` from the swipes array, and the edit is gone. Three features learned this from three separate
// bug reports (the reverted picture, the vanished POST receipt, the raw <DateAndTime/>), which is why
// the rule lives in one place now.

import { describe, it, expect } from 'vitest';
import { syncActiveSwipeText } from '../src/shared/active-swipe-text.js';

describe('syncActiveSwipeText — both copies move together', () => {
    it('MUTATION TARGET — the active swipe takes the new text', () => {
        const m = { mes: 'edited', swipe_id: 1, swipes: ['old0', 'old1', 'old2'] };
        expect(syncActiveSwipeText(m)).toBe(true);
        expect(m.swipes).toEqual(['old0', 'edited', 'old2']);   // ONLY the active one
    });

    it('MUTATION TARGET — a missing swipe_id means swipe 0, not "skip it"', () => {
        const m = { mes: 'edited', swipes: ['old0'] };
        expect(syncActiveSwipeText(m)).toBe(true);
        expect(m.swipes).toEqual(['edited']);
    });

    it('a message with no swipes array is left alone — never invent a swipe ST did not create', () => {
        const m = { mes: 'edited' };
        expect(syncActiveSwipeText(m)).toBe(false);
        expect(m.swipes).toBeUndefined();
    });

    it('an out-of-range or non-string slot is left alone', () => {
        const a = { mes: 'edited', swipe_id: 5, swipes: ['old0'] };
        expect(syncActiveSwipeText(a)).toBe(false);
        expect(a.swipes).toEqual(['old0']);
        const b = { mes: 'edited', swipe_id: 0, swipes: [null] };
        expect(syncActiveSwipeText(b)).toBe(false);
        expect(b.swipes).toEqual([null]);
    });

    it('junk in, no throw', () => {
        expect(syncActiveSwipeText(null)).toBe(false);
        expect(syncActiveSwipeText({})).toBe(false);
        expect(syncActiveSwipeText({ mes: 7, swipes: ['x'] })).toBe(false);
    });
});
