// The capability block's reporter LOCK — its own file because a lock is one-way: once locked, this
// module instance never accepts another reporter, which the main block suite (a new reporter per test)
// could not survive. Vitest gives each test file its own module instance.
//
// Why the lock exists: the engine frame's policy refuses every import() that needs a request, but the
// Worker's own modules are already in its module cache, so engine code can still import the block and
// call registerCapabilityBlockReporter — measured live 2026-10-02, the cached module came back with no
// request. Replacing the reporter would silence every BLOCKED line the engine causes after it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    registerCapabilityBlockReporter, lockCapabilityBlockReporter, getEngineCapabilityBlockReport,
} from '../src/features/logic-engine/engine-capability-block.js';

describe('the reporter lock', () => {
    it('after the lock, a new reporter is refused, the Worker\'s keeps receiving, and the refusal is said once', () => {
        const workerLines = [];
        const engineLines = [];
        registerCapabilityBlockReporter((message) => workerLines.push(message));
        lockCapabilityBlockReporter();

        registerCapabilityBlockReporter((message) => engineLines.push(message));
        registerCapabilityBlockReporter(null);

        expect(engineLines).toEqual([]);
        expect(workerLines).toHaveLength(1);
        expect(workerLines[0]).toMatch(/engine code tried to replace the capability block's reporter/);
        expect(getEngineCapabilityBlockReport().attempts.registerCapabilityBlockReporter).toBe(2);
    });
    it('the lock is one-way — locking again changes nothing, and nothing unlocks it', () => {
        lockCapabilityBlockReporter();
        const source = readFileSync(new URL('../src/features/logic-engine/engine-capability-block.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/reporterLocked = false;\s*\}/);
        expect((source.match(/reporterLocked = /g) || []).length).toBe(2);   // the declaration and the lock
    });
    it('the permanent raise — the Worker\'s, which a Node suite cannot run — locks it', () => {
        const source = readFileSync(new URL('../src/features/logic-engine/engine-capability-block.js', import.meta.url), 'utf8');
        expect(source).toMatch(/export function raiseEngineCapabilityBlockPermanently\(\) \{[^}]*raise\(\);\s*depth = 1;\s*lockCapabilityBlockReporter\(\);\s*\}/);
    });
});
