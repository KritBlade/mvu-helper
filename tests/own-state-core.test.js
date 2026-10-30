/**
 * MVU Helper — mvu-helper's end-of-reply pass (own-state/own-state-core.js, plans/executed/streetcleaner.md §2).
 *
 * The tasks change one copy of a reply's state in the order they were registered, each awaited before the next, so
 * the streetcleaner always sweeps what the worn-outfit store's write just wrote. The order is code, never the order
 * SillyTavern added listeners in — hence the source gate: one listener on MVU's save, the pass's.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runOwnStateTasks, stagedCopyToRun, droppedOwnParts } from '../src/features/own-state/own-state-core.js';

const reply = { mid: 7, isEngineCopy: false, copyLabel: "MVU's save" };

describe('runOwnStateTasks — the end-of-reply tasks, in order, on one copy', () => {
    it('MUTATION TARGET — runs every task in registration order, each awaited before the next', async () => {
        const seen = [];
        const slow = { name: 'write', run: async (state) => { await new Promise((resolve) => setTimeout(resolve, 5)); state.written = true; seen.push('write'); } };
        const sweep = { name: 'sweep', run: (state) => { seen.push(state.written ? 'sweep after write' : 'sweep before write'); } };
        await runOwnStateTasks([slow, sweep], {}, reply, () => {});
        expect(seen).toEqual(['write', 'sweep after write']);
    });

    it('hands every task the same copy and the reply', async () => {
        const state = {};
        const handed = [];
        await runOwnStateTasks([{ name: 'a', run: (s, r) => handed.push([s, r]) }, { name: 'b', run: (s, r) => handed.push([s, r]) }], state, reply, () => {});
        expect(handed).toEqual([[state, reply], [state, reply]]);
    });

    it('MUTATION TARGET — a task that throws is handed to onError, and the next one still runs', async () => {
        const errors = [];
        const ran = [];
        const broken = { name: 'broken', run: async () => { throw new Error('boom'); } };
        const after = { name: 'after', run: () => { ran.push('after'); } };
        await runOwnStateTasks([broken, after], {}, reply, (task, e) => errors.push([task.name, e.message]));
        expect(errors).toEqual([['broken', 'boom']]);
        expect(ran).toEqual(['after']);
    });

    it('no tasks ⇒ nothing runs', async () => {
        await expect(runOwnStateTasks([], {}, reply, () => {})).resolves.toBeUndefined();
        await expect(runOwnStateTasks(null, {}, reply, () => {})).resolves.toBeUndefined();
    });
});

// The engine stages every resolve, and saves only some: the idle resolve of the user's own message at the start of a
// turn saves nothing, so a pass there would change — and log — a copy that is dropped.
describe('stagedCopyToRun — the engine\'s copy, only when the engine saves it', () => {
    const parse = { swipe: 0, mvuData: { stat_data: { a: 1 } } };

    it('MUTATION TARGET — a resolve the engine does not save gets no pass', () => {
        expect(stagedCopyToRun({ mid: 4, swipe: 0, willSave: false }, parse)).toBeNull();
        expect(stagedCopyToRun({ mid: 4, swipe: 0 }, parse)).toBeNull();
    });

    it('a resolve the engine saves runs on the reply\'s captured parse', () => {
        expect(stagedCopyToRun({ mid: 4, swipe: 0, willSave: true }, parse)).toBe(parse.mvuData.stat_data);
    });

    it('MUTATION TARGET — never the parse of another swipe, and never without one', () => {
        expect(stagedCopyToRun({ mid: 4, swipe: 1, willSave: true }, parse)).toBeNull();
        expect(stagedCopyToRun({ mid: 4, swipe: 0, willSave: true }, null)).toBeNull();
        expect(stagedCopyToRun({ mid: 4, swipe: 0, willSave: true }, { swipe: 0, mvuData: {} })).toBeNull();
        expect(stagedCopyToRun({ mid: 4, swipe: 0, willSave: true }, { swipe: 0, mvuData: { stat_data: 'broken' } })).toBeNull();
        expect(stagedCopyToRun(null, parse)).toBeNull();
    });
});

// MVU saves the reply's state when its mag_before_message_update listeners return; a second mvu-helper listener there
// would run in the order SillyTavern added it, and a write after the sweep would put back what it dropped.
describe('SOURCE GATE — mvu-helper writes its root on MVU\'s save in one place', () => {
    const files = [];
    (function walk(dir) {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith('.js')) files.push(full);
        }
    })(path.join(process.cwd(), 'src'));

    it('MUTATION TARGET — only own-state.js listens to MVU_BEFORE_MESSAGE_UPDATE', () => {
        const listeners = files.filter((file) => /eventSource\.on\(\s*MVU_BEFORE_MESSAGE_UPDATE\b/.test(readFileSync(file, 'utf8')));
        expect(listeners.map((file) => path.relative(process.cwd(), file).split(path.sep).join('/'))).toEqual(['src/features/own-state/own-state.js']);
    });

    // The pass learns whether the engine saves from the staged signal itself; a signal that stopped saying so
    // would leave every engine copy without mvu-helper's root. MUTATION TARGET: drop willSave from the payload.
    it('MUTATION TARGET — the engine\'s staged signal says whether it saves, worked out before it is sent', () => {
        const runner = readFileSync(path.join(process.cwd(), 'src/features/logic-engine/turn-runner.js'), 'utf8');
        const plan = runner.indexOf('const save = turnSavePlan(');
        const emit = runner.search(/eventSource\.emit\(RES_STAGED_EVENT, \{[^}]*willSave: save\.shouldSave \}\)/);
        expect(plan).toBeGreaterThan(-1);
        expect(emit).toBeGreaterThan(plan);
    });

    it('the pass registers the worn-outfit store\'s write before the streetcleaner', () => {
        const index = readFileSync(path.join(process.cwd(), 'src/index.js'), 'utf8');
        const write = index.indexOf('registerOwnStateTask(wornOutfitWriteTask);');
        const sweep = index.indexOf('registerOwnStateTask(streetcleanerTask);');
        expect(write).toBeGreaterThan(-1);
        expect(sweep).toBeGreaterThan(write);
    });
});

// One warning covers every part of mvu-helper's root: a part an earlier state held and the state a reply starts from
// lacks was dropped — by the card's Zod schema, or by MVU rebuilding the state from the card's initial variables.
describe('droppedOwnParts — what the state a reply starts from lost', () => {
    const state = (root) => (root === undefined ? { World: {} } : { World: {}, $mvuhelper: root });

    it('MUTATION TARGET — names each part the earlier state held and the starting state lacks', () => {
        expect(droppedOwnParts(state({ worn_outfit: {} }), state({ worn_outfit: {}, character_registry: {} }))).toEqual(['character_registry']);
        expect(droppedOwnParts(state(undefined), state({ worn_outfit: {}, character_registry: {} }))).toEqual(['worn_outfit', 'character_registry']);
    });

    it('nothing lost, or nothing held before, is no drop', () => {
        expect(droppedOwnParts(state({ worn_outfit: { a: 1 } }), state({ worn_outfit: {} }))).toEqual([]);
        expect(droppedOwnParts(state({ worn_outfit: {} }), state(undefined))).toEqual([]);
        expect(droppedOwnParts(null, null)).toEqual([]);
    });
});
