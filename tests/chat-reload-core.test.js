// tests/chat-reload-core.test.js — the coalescer that makes an operation pay for ONE chat reload.
//
// Why the whole mechanism exists is recorded in the file under test: SillyTavern applies nothing to
// messages already rendered, so every writer of rendered content (regexes, a StatusMenu layout, its
// engine text) has to reload — and an operation that changes several of them must still reload once.

import { describe, it, expect } from 'vitest';
import { createReloadCoalescer } from '../src/sillytavern/chat-reload-core.js';

describe('createReloadCoalescer — one chat reload per bulk operation', () => {
    it('outside a scope, a request reloads NOW', () => {
        const c = createReloadCoalescer();
        expect(c.request()).toBe(true);
        expect(c.isOpen()).toBe(false);
    });

    it('MUTATION TARGET — inside a scope, requests defer and the close reloads ONCE, counting them', () => {
        const c = createReloadCoalescer();
        c.begin();
        expect(c.request()).toBe(false);
        expect(c.request()).toBe(false);
        expect(c.request()).toBe(false);
        expect(c.end()).toEqual({ reload: true, coalesced: 3 });
    });

    it('a scope nobody asked to reload closes without one', () => {
        const c = createReloadCoalescer();
        c.begin();
        expect(c.end()).toEqual({ reload: false, coalesced: 0 });
    });

    it('nested scopes reload at the OUTERMOST close only', () => {
        const c = createReloadCoalescer();
        c.begin(); c.begin();
        c.request();
        expect(c.end()).toEqual({ reload: false, coalesced: 0 });
        expect(c.isOpen()).toBe(true);
        expect(c.end()).toEqual({ reload: true, coalesced: 1 });
    });

    it('after a close, the next request reloads now again — nothing leaks between operations', () => {
        const c = createReloadCoalescer();
        c.begin(); c.request(); c.end();
        expect(c.request()).toBe(true);
    });
});
