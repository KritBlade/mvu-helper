/**
 * The ranked rows that end SillyTavern's wand menu (src/sillytavern/wand-menu-core.js): lowest rank first, whichever
 * extension added its row first, and rows of one rank in the order they came. MVU Helper ranks 90 and VectFox 91.
 */
import { describe, expect, it } from 'vitest';
import { wandMenuRankOrder } from '../src/sillytavern/wand-menu-core.js';

const rankOf = row => row.rank;

describe('wandMenuRankOrder', () => {
    it("puts MVU Helper's row above VectFox's, whichever was added first", () => {
        const mvuHelper = { id: 'mvuh_wand_button', rank: 90 };
        const vectFox = { id: 'VectFox_wand', rank: 91 };
        expect(wandMenuRankOrder([vectFox, mvuHelper], rankOf)).toEqual([mvuHelper, vectFox]);
        expect(wandMenuRankOrder([mvuHelper, vectFox], rankOf)).toEqual([mvuHelper, vectFox]);
    });

    it('keeps rows of one rank in the order they came, and leaves the rows it was given as they were', () => {
        const rows = [{ id: 'higher', rank: 95 }, { id: 'first', rank: 90 }, { id: 'second', rank: 90 }];
        expect(wandMenuRankOrder(rows, rankOf).map(row => row.id)).toEqual(['first', 'second', 'higher']);
        expect(rows.map(row => row.id)).toEqual(['higher', 'first', 'second']);
    });
});
