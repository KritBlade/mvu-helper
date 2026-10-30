// render-visibility-core — who is hiding a rendered frontend block. v0.1
import { describe, it, expect } from 'vitest';
import {
    parseMessageIdFromIframeName, hidingReason, nodeLabel, findHiddenAncestor,
} from '../src/sillytavern/render-visibility-core.js';

describe('parseMessageIdFromIframeName — only message renders pass', () => {
    it('MUTATION TARGET — a plain message iframe name yields its message id', () => {
        expect(parseMessageIdFromIframeName('TH-message--2--0')).toBe(2);
        expect(parseMessageIdFromIframeName('TH-message--17--3')).toBe(17);
    });

    it('the streaming suffix TavernHelper appends still parses', () => {
        expect(parseMessageIdFromIframeName('TH-message--2--1_3')).toBe(2);
    });

    it('script frames and junk are NOT message renders', () => {
        expect(parseMessageIdFromIframeName('TH-script--abc--0')).toBe(null);
        expect(parseMessageIdFromIframeName('TH-message--x--0')).toBe(null);
        expect(parseMessageIdFromIframeName('')).toBe(null);
        expect(parseMessageIdFromIframeName(null)).toBe(null);
    });
});

describe('hidingReason — the two ways an ancestor kills a descendant', () => {
    it('MUTATION TARGET — display:none hides', () => {
        expect(hidingReason({ display: 'none', visibility: 'visible' })).toBe('display:none');
    });

    it('visibility hidden and collapse hide', () => {
        expect(hidingReason({ display: 'block', visibility: 'hidden' })).toBe('visibility:hidden');
        expect(hidingReason({ display: 'block', visibility: 'collapse' })).toBe('visibility:collapse');
    });

    it('a visible element is no reason, and junk is no reason', () => {
        expect(hidingReason({ display: 'block', visibility: 'visible' })).toBe(null);
        expect(hidingReason({})).toBe(null);
        expect(hidingReason(null)).toBe(null);
    });
});

describe('findHiddenAncestor — nearest culprit wins', () => {
    const visible = { tag: 'DIV', className: 'TH-render', display: 'block', visibility: 'visible' };

    it('MUTATION TARGET — the live 2026-09-02 shape: a hidden details two levels up', () => {
        const hit = findHiddenAncestor([
            visible,
            { tag: 'P', className: '', display: 'block', visibility: 'visible' },
            { tag: 'DETAILS', className: 'custom-meg-blocks-src', display: 'none', visibility: 'visible' },
        ]);
        expect(hit).toEqual({ index: 2, label: 'details.custom-meg-blocks-src', reason: 'display:none' });
    });

    it('the FIRST hiding entry is named even when several hide', () => {
        const hit = findHiddenAncestor([
            { tag: 'DIV', className: 'inner', display: 'none', visibility: 'visible' },
            { tag: 'DIV', className: 'outer', display: 'none', visibility: 'visible' },
        ]);
        expect(hit.label).toBe('div.inner');
        expect(hit.index).toBe(0);
    });

    it('a fully visible chain is null — no news is the normal case', () => {
        expect(findHiddenAncestor([visible, visible, visible])).toBe(null);
    });

    it('junk in, null out — an unreadable chain is not evidence of hiding', () => {
        expect(findHiddenAncestor(null)).toBe(null);
        expect(findHiddenAncestor([])).toBe(null);
        expect(findHiddenAncestor([null, undefined, 42])).toBe(null);
    });
});

describe('nodeLabel — greppable, capped', () => {
    it('tag lowercased with up to three classes', () => {
        expect(nodeLabel({ tag: 'DETAILS', className: 'a b c d e' })).toBe('details.a.b.c');
        expect(nodeLabel({ tag: 'P', className: '' })).toBe('p');
        expect(nodeLabel(null)).toBe('?');
    });
});
