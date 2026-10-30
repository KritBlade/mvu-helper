// tests/live-resolve-gate.test.js — the PRE-time-apply suppression gate (live-resolve-gate.js).
//
// The property under test is the WINDOW: suppressed exactly while the wrapped callback runs —
// including across awaits, throws, and nesting — and never wedged shut afterwards. The live bug
// this guards (2026-08-10): Mvu.parseMessage's VARIABLE_UPDATE_ENDED echo triggered a mid-turn
// LIVE resolve that consumed a PRE-written /Intent/check before narrate rendered it.

import { describe, it, expect } from 'vitest';
import { isLiveResolveSuppressed, withLiveResolveSuppressed } from '../src/features/logic-engine/live-resolve-gate.js';

describe('withLiveResolveSuppressed', () => {
    it('is suppressed inside the callback and released after', async () => {
        expect(isLiveResolveSuppressed()).toBe(false);
        const seenInside = await withLiveResolveSuppressed(async () => isLiveResolveSuppressed());
        expect(seenInside).toBe(true);
        expect(isLiveResolveSuppressed()).toBe(false);
    });

    it('stays suppressed across an await inside the callback (the parseMessage round-trip)', async () => {
        const observations = [];
        await withLiveResolveSuppressed(async () => {
            observations.push(isLiveResolveSuppressed());
            await new Promise((resolve) => setTimeout(resolve, 0));
            observations.push(isLiveResolveSuppressed());
        });
        expect(observations).toEqual([true, true]);
    });

    it('returns the callback result', async () => {
        const result = await withLiveResolveSuppressed(async () => 'parsed');
        expect(result).toBe('parsed');
    });

    it('releases on a throwing callback (a parse failure must not wedge the gate shut)', async () => {
        await expect(withLiveResolveSuppressed(async () => { throw new Error('parse failed'); }))
            .rejects.toThrow('parse failed');
        expect(isLiveResolveSuppressed()).toBe(false);
    });

    it('composes when nested (user floor + A2 cache floor applies overlapping)', async () => {
        await withLiveResolveSuppressed(async () => {
            expect(isLiveResolveSuppressed()).toBe(true);
            await withLiveResolveSuppressed(async () => {
                expect(isLiveResolveSuppressed()).toBe(true);
            });
            // the inner release must NOT open the gate while the outer apply is still running
            expect(isLiveResolveSuppressed()).toBe(true);
        });
        expect(isLiveResolveSuppressed()).toBe(false);
    });
});
