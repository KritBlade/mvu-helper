/**
 * MVU Helper — shared/string-hash.js
 *
 * hash36 names every card's settings profile (settings-store profileKey) and fingerprints the card
 * config a profile last imported (card-config). A changed output renames every stored profile, so the
 * function is pinned to known values.
 *
 * Run:  npm test
 */

import { describe, it, expect } from 'vitest';
import { hash36 } from '../src/shared/string-hash.js';

const NUL = String.fromCharCode(0);

describe('hash36 — FNV-1a 32-bit, in base 36', () => {
    it('MUTATION TARGET — known inputs give the values every stored profile key was built with', () => {
        expect(hash36('')).toBe('ztntfp');
        expect(hash36(`albert${NUL}Leila`)).toBe('dtevoy');
    });

    it('the NUL separator keeps "a b" + "c" apart from "a" + "b c"', () => {
        expect(hash36(`a b${NUL}c`)).toBe('x38qkv');
        expect(hash36(`a${NUL}b c`)).toBe('1wgyljj');
    });
});
