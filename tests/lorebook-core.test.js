/**
 * MVU Helper — sillytavern/lorebook-core.js pure tests.
 *
 * normalizeCharBookEntries is the load-bearing bit of the race-free embedded-lorebook fallback:
 * when ST hasn't registered the standalone worldbook yet on chat load, getPrimaryLorebookEntries
 * reads the card's EMBEDDED character_book instead — but that raw shape carries `insertion_order`,
 * while consumers (selectLorebookEntries sort) read `.order`. This proves the mapping.
 */
import { describe, it, expect } from 'vitest';
import { normalizeCharBookEntries, preserveCommentLeadIn } from '../src/sillytavern/lorebook-core.js';

describe('normalizeCharBookEntries (embedded character_book → TavernHelper shape)', () => {
    it('maps insertion_order → order (load-bearing for selectLorebookEntries sort) and id → uid', () => {
        const out = normalizeCharBookEntries([{ comment: '[PRE] A', content: 'x', insertion_order: 780, id: 3, keys: [] }]);
        expect(out[0].order).toBe(780);
        expect(out[0].uid).toBe(3);
        expect(out[0].comment).toBe('[PRE] A');
        expect(out[0].content).toBe('x');
    });

    it('prefers an already-present order/uid over insertion_order/id', () => {
        const out = normalizeCharBookEntries([{ order: 5, uid: 99, insertion_order: 780, id: 3 }]);
        expect(out[0].order).toBe(5);
        expect(out[0].uid).toBe(99);
    });

    it('preserves every original field (keys/enabled/constant/content)', () => {
        const e = { comment: 'c', content: 'body', keys: ['k'], enabled: true, constant: false, insertion_order: 1 };
        const out = normalizeCharBookEntries([e]);
        expect(out[0]).toMatchObject({ comment: 'c', content: 'body', keys: ['k'], enabled: true, constant: false, order: 1 });
    });

    it('the normalized array sorts by .order exactly like TavernHelper entries do', () => {
        const out = normalizeCharBookEntries([
            { comment: 'contract', insertion_order: 990 },
            { comment: 'roster', insertion_order: 760 },
            { comment: 'rules', insertion_order: 780 },
        ]).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
        expect(out.map((e) => e.comment)).toEqual(['roster', 'rules', 'contract']);
    });

    it('non-array / junk input → [] (no character_book, not-ready, or bad shape)', () => {
        expect(normalizeCharBookEntries(undefined)).toEqual([]);
        expect(normalizeCharBookEntries(null)).toEqual([]);
        expect(normalizeCharBookEntries({})).toEqual([]);
        expect(normalizeCharBookEntries('nope')).toEqual([]);
    });

    it('tolerates null/non-object elements without throwing', () => {
        const out = normalizeCharBookEntries([null, 5, { insertion_order: 7 }]);
        expect(out[0]).toBe(null);
        expect(out[1]).toBe(5);
        expect(out[2].order).toBe(7);
    });
});

describe('preserveCommentLeadIn (an installer marker survives a routine rewrite)', () => {
    const needle = '[initmvuhelper]';

    it('re-attaches whatever sat in FRONT of the needle', () => {
        const out = preserveCommentLeadIn(
            '[GameLogicPack:school-v4] [Initmvuhelper] mvu-helper card config', needle,
            { comment: '[Initmvuhelper] mvu-helper card config' });
        expect(out).toEqual({ comment: '[GameLogicPack:school-v4] [Initmvuhelper] mvu-helper card config' });
    });

    it('carries the lead-in through a RENAME, where the caller changes the tail', () => {
        const out = preserveCommentLeadIn(
            '[GameLogicPack:school-v4] [Initmvuhelper] mvu-helper card config', needle,
            { comment: '[Initmvuhelper] card config, renamed' });
        expect(out.comment).toBe('[GameLogicPack:school-v4] [Initmvuhelper] card config, renamed');
    });

    it('does nothing when the needle is already at the front — an unpacked card is untouched', () => {
        expect(preserveCommentLeadIn('[Initmvuhelper] mvu-helper card config', needle,
            { comment: '[Initmvuhelper] mvu-helper card config' })).toEqual({});
    });

    it('does nothing when the caller passes no comment — the field merge keeps the stored one', () => {
        expect(preserveCommentLeadIn('[GameLogicPack:x] [Initmvuhelper] mvu-helper card config', needle, { content: 'x' })).toEqual({});
    });

    it('never double-prefixes a caller that already read the stored comment', () => {
        expect(preserveCommentLeadIn('[GameLogicPack:x] [Initmvuhelper] mvu-helper card config', needle,
            { comment: '[GameLogicPack:x] [Initmvuhelper] mvu-helper card config' })).toEqual({});
    });

    it('does nothing when the needle is absent (a create, or a mismatched needle)', () => {
        expect(preserveCommentLeadIn('[Something Else] x', needle, { comment: 'new' })).toEqual({});
        expect(preserveCommentLeadIn('', needle, { comment: 'new' })).toEqual({});
    });
});
