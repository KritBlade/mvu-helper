// rendered-region-placement-core — is one of OUR regions still where we emitted it? v0.1
import { describe, it, expect } from 'vitest';
import {
    enclosingLabels, placementVerdict, restoreAllowed, MAX_RESTORES_PER_RENDER_CYCLE,
} from '../src/sillytavern/rendered-region-placement-core.js';

describe('placementVerdict — the gate that keeps the healthy case free', () => {
    it('MUTATION TARGET — a region with nothing between it and its owner is left alone', () => {
        const v = placementVerdict({ hasOwner: true, betweenLabels: [] });
        expect(v.restore).toBe(false);
        expect(v.reason).toMatch(/already a direct child/);
    });

    it('MUTATION TARGET — a region with a foreign parent is restored, and the reason names it', () => {
        const v = placementVerdict({ hasOwner: true, betweenLabels: ['details'] });
        expect(v.restore).toBe(true);
        expect(v.reason).toBe('enclosed by 1 foreign element: details');
    });

    it('names the whole chain innermost-first, so the log says what adopted us', () => {
        const v = placementVerdict({ hasOwner: true, betweenLabels: ['blockquote', 'details'] });
        expect(v.reason).toBe('enclosed by 2 foreign elements: blockquote < details');
    });

    // A body-level region (the side panel) has no message container, and a region mid-render can be
    // detached. Neither is a placement fault, and neither may be moved: there is nowhere correct to
    // put it, and inventing an owner is the expectation that rots.
    it('MUTATION TARGET — a region with NO owner is never moved, however deeply nested', () => {
        const v = placementVerdict({ hasOwner: false, betweenLabels: ['div', 'section', 'body'] });
        expect(v.restore).toBe(false);
        expect(v.reason).toMatch(/no owner container/);
    });

    it('junk in, no move out — a missing argument is not evidence of a fault', () => {
        expect(placementVerdict().restore).toBe(false);
        expect(placementVerdict({}).restore).toBe(false);
        expect(placementVerdict({ hasOwner: true }).restore).toBe(false);
        expect(placementVerdict({ hasOwner: true, betweenLabels: 'details' }).restore).toBe(false);
    });
});

describe('enclosingLabels — only real labels count', () => {
    it('drops blanks and non-strings rather than reporting a phantom ancestor', () => {
        expect(enclosingLabels(['details', '', null, 0, 'div'])).toEqual(['details', 'div']);
        expect(enclosingLabels(null)).toEqual([]);
    });

    it('an all-junk list reads as NOT enclosed, so nothing is moved on noise', () => {
        expect(placementVerdict({ hasOwner: true, betweenLabels: [null, ''] }).restore).toBe(false);
    });
});

describe('restoreAllowed — one move per render is expected, a loop is not', () => {
    // The next render rebuilds the message from the same text and encloses the region again, so
    // repeated moves across renders are correct. What this bounds is many moves inside ONE render,
    // which would mean the move itself re-triggered the handler — a loop in a render handler.
    it('MUTATION TARGET — allows up to the cap, then stops', () => {
        expect(restoreAllowed(0)).toBe(true);
        expect(restoreAllowed(MAX_RESTORES_PER_RENDER_CYCLE - 1)).toBe(true);
        expect(restoreAllowed(MAX_RESTORES_PER_RENDER_CYCLE)).toBe(false);
        expect(restoreAllowed(MAX_RESTORES_PER_RENDER_CYCLE + 10)).toBe(false);
    });

    it('a missing count reads as zero, never as "already over"', () => {
        expect(restoreAllowed(undefined)).toBe(true);
        expect(restoreAllowed(null)).toBe(true);
    });
});
