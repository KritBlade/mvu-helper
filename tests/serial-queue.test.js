// tests/serial-queue.test.js — the one-at-a-time guard the card sync and the character registry's store share
// (shared/serial-queue.js). Work that awaits between reading a state and writing it back must not overlap itself:
// the card sync's three page-load hooks once merged the same rows three times and toasted five times on one reload.

import { describe, it, expect } from 'vitest';
import { createSerialQueue } from '../src/shared/serial-queue.js';

describe('createSerialQueue — one task at a time, in call order', () => {
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

    it('never lets two tasks overlap, however many are enqueued at once', async () => {
        const enqueue = createSerialQueue();
        let running = 0;
        let peak = 0;
        const task = async () => {
            peak = Math.max(peak, ++running);
            await tick(5);            // the await window a real sync has between its read and its write
            running--;
        };
        await Promise.all([enqueue(task), enqueue(task), enqueue(task), enqueue(task), enqueue(task)]);
        expect(peak).toBe(1);
        expect(running).toBe(0);
    });

    it('runs them in CALL order and returns each caller its own result', async () => {
        const enqueue = createSerialQueue();
        const order = [];
        const results = await Promise.all([1, 2, 3].map((n) => enqueue(async () => {
            await tick(n === 1 ? 6 : 0);   // the first is the slowest — order must still hold
            order.push(n);
            return n * 10;
        })));
        expect(order).toEqual([1, 2, 3]);
        expect(results).toEqual([10, 20, 30]);
    });

    it('the SECOND task sees what the first one wrote — this is what makes a repeat sync a no-op', async () => {
        const enqueue = createSerialQueue();
        const save = { installed: false };
        const seen = [];
        const syncLike = async () => {
            const before = save.installed;      // read
            seen.push(before);
            await tick(5);                      // the window a racer slips through
            if (!before) save.installed = true; // write
        };
        await Promise.all([enqueue(syncLike), enqueue(syncLike), enqueue(syncLike)]);
        expect(seen).toEqual([false, true, true]);   // only the FIRST does the work
    });

    it('a rejecting task does not wedge the queue, and its caller still sees the rejection', async () => {
        const enqueue = createSerialQueue();
        const boom = enqueue(async () => { throw new Error('sync threw'); });
        await expect(boom).rejects.toThrow('sync threw');
        await expect(enqueue(async () => 'still working')).resolves.toBe('still working');
    });
});
