/**
 * MVU Helper — llm-task-router/llm-task-router-core.js pure tests.
 *
 * The generic LLM-task router's routing math: how a (task, target) maps to a lorebook
 * entry (comment prefix that extraLlmCalls routes on, enabled/constant flags per phase, the
 * <tag> body), and how the target list is built + validated from the live call list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    TASK_NEEDLE_PREFIX, NARRATE_TARGET, taskNeedle, taskEntryComment, taskEntryBody,
    buildTaskEntryFields, taskInstructionToken, resolveTargetPhase, listTaskTargets, isTargetAvailable, runTargetOf,
    createKeyedQueue, isTaskRoutingEntryName,
} from '../src/features/llm-task-router/llm-task-router-core.js';
import { substituteInputMacros } from '../src/features/small-llm/call-input-macros-core.js';

const CALLS = [
    { name: 'POST1', phase: 'post' },
    { name: 'POST2', phase: 'post' },
    { name: 'PRE1', phase: 'pre' },
];

describe('taskNeedle / taskEntryComment', () => {
    it('embeds the findable needle in the comment', () => {
        expect(taskNeedle('imagegen-charimg')).toBe('mvu-llm-task:imagegen-charimg');
        expect(taskEntryComment('imagegen-charimg', 'POST1')).toContain(TASK_NEEDLE_PREFIX);
    });

    it('a CALL target comment starts with [callName] so extraLlmCalls routes it', () => {
        expect(taskEntryComment('t1', 'POST2')).toBe('[POST2] mvu-llm-task:t1');
    });

    it('a narrate or empty target has no routing entry, so it has no comment either', () => {
        expect(() => taskEntryComment('t1', NARRATE_TARGET)).toThrow(/narrate target has no routing entry/);
        expect(() => taskEntryComment('t1', '')).toThrow(/narrate target has no routing entry/);
    });
});

describe('isTaskRoutingEntryName — is a routed entry a task\'s routing entry', () => {
    it('MUTATION TARGET — every routing comment taskEntryComment writes is one, in any case', () => {
        expect(isTaskRoutingEntryName(taskEntryComment('imagegen-charimg', 'POST'))).toBe(true);
        expect(isTaskRoutingEntryName('[POST] MVU-LLM-Task:imagegen-pictures')).toBe(true);
    });

    it('MUTATION TARGET — a card\'s own entry is not, even one routed to the same call', () => {
        expect(isTaskRoutingEntryName('[GameLogicPack:school-v4] [POST] Record_Rules')).toBe(false);
        expect(isTaskRoutingEntryName('[POST] llm-task notes')).toBe(false);
    });

    it('never throws on garbage', () => {
        expect(isTaskRoutingEntryName(undefined)).toBe(false);
        expect(isTaskRoutingEntryName('')).toBe(false);
    });
});

describe('taskEntryBody', () => {
    it('wraps the instruction in the feature-supplied tag', () => {
        expect(taskEntryBody('myTag', 'do the thing')).toBe('<myTag>\ndo the thing\n</myTag>');
    });
    it('trims the instruction inside the wrapper', () => {
        expect(taskEntryBody('t', '  x  ')).toBe('<t>\nx\n</t>');
    });
    it('blank tag → bare instruction (feature opted out of a wrapper)', () => {
        expect(taskEntryBody('', 'x')).toBe('x');
    });
});

describe('buildTaskEntryFields', () => {
    it('MUTATION TARGET — a narrate target has no routing entry: asking for one throws', () => {
        expect(() => buildTaskEntryFields({ taskId: 't', target: 'narrate', tag: 'myTag', instruction: 'go' })).toThrow(/narrate target has no routing entry/);
        expect(() => buildTaskEntryFields({ taskId: 't', target: '', tag: 'myTag', instruction: 'go' })).toThrow(/narrate target has no routing entry/);
    });

    it('a POST call → disabled selective data-carrier (extraLlmCalls reads it out-of-band, ST never injects)', () => {
        const f = buildTaskEntryFields({ taskId: 't', target: 'POST1', tag: 'myTag', instruction: 'go' });
        expect(f.enabled).toBe(false);
        expect(f.type).toBe('selective');
        expect(f.keys).toEqual([]);
        expect(f.content).toBe('<myTag>\ngo\n</myTag>');
        expect(f.comment).toBe('[POST1] mvu-llm-task:t');
    });
});

describe('resolveTargetPhase', () => {
    it('narrate resolves to narrate', () => {
        expect(resolveTargetPhase('narrate', CALLS)).toBe('narrate');
    });
    it('a call resolves to its phase', () => {
        expect(resolveTargetPhase('POST1', CALLS)).toBe('post');
        expect(resolveTargetPhase('PRE1', CALLS)).toBe('pre');
    });
    it('an unknown/deleted call → null', () => {
        expect(resolveTargetPhase('POST9', CALLS)).toBe(null);
    });
    it('blank (Off) → null', () => {
        expect(resolveTargetPhase('', CALLS)).toBe(null);
    });
});

describe('listTaskTargets', () => {
    it('Off is first', () => {
        expect(listTaskTargets(['narrate', 'post'], CALLS)[0]).toEqual({ value: '', label: 'Off', phase: null });
        expect(listTaskTargets(['narrate', 'post'], CALLS, { offersOff: true })[0].value).toBe('');
    });

    // "Pictures written by" is never off: Insert Type = Disable is its off switch (plans/executed/picture-writer-route.md D1).
    it('MUTATION TARGET — a task that offers no Off lists the narrator and the calls only', () => {
        expect(listTaskTargets(['narrate', 'post'], CALLS, { offersOff: false }).map((o) => o.value)).toEqual(['narrate', 'POST1', 'POST2']);
    });

    // The glue is host-coupled, so the two lines that carry a task's choice to its picker are gated as SOURCE.
    it('MUTATION TARGET — a task\'s offersOff reaches its picker (Off by default)', () => {
        const src = readFileSync(new URL('../src/features/llm-task-router/llm-task-router.js', import.meta.url), 'utf8');
        expect(src).toContain('offersOff: spec.offersOff !== false,');
        expect(src).toContain('const opts = listTaskTargets(task.allow, activeEnabledCalls(), { offersOff: task.offersOff })');
    });

    // A feature's rule about which of its settings go together (spec offers) hides an option in the picker, never the
    // stored value, and never touches routing (plans/executed/picture-writer-route.md R1).
    it('MUTATION TARGET — a task\'s offers rule filters its picker, and its stored value stays listed', () => {
        const src = readFileSync(new URL('../src/features/llm-task-router/llm-task-router.js', import.meta.url), 'utf8');
        expect(src).toContain('.filter((o) => o.value === current || isOfferedByTask(task, o.value));');
        expect(src).toContain('offers: typeof spec.offers === \'function\' ? spec.offers : () => true,');
        const routing = src.slice(src.indexOf('async function syncRoutingEntry('), src.indexOf('// ── capture'));
        expect(routing).not.toContain('offers');
    });

    it('includes narrate only when allowed', () => {
        const withN = listTaskTargets(['narrate', 'post'], CALLS).map((o) => o.value);
        const noN = listTaskTargets(['post'], CALLS).map((o) => o.value);
        expect(withN).toContain('narrate');
        expect(noN).not.toContain('narrate');
    });

    it('includes only calls whose phase is allowed (image-harvest excludes PRE)', () => {
        const vals = listTaskTargets(['narrate', 'post'], CALLS).map((o) => o.value);
        expect(vals).toEqual(['', 'narrate', 'POST1', 'POST2']);   // PRE1 filtered out
    });

    it('a PRE-allowing task sees PRE calls', () => {
        const vals = listTaskTargets(['pre'], CALLS).map((o) => o.value);
        expect(vals).toEqual(['', 'PRE1']);
    });

    it('skips unnamed calls', () => {
        const vals = listTaskTargets(['post'], [{ name: '  ', phase: 'post' }, { name: 'POST1', phase: 'post' }]).map((o) => o.value);
        expect(vals).toEqual(['', 'POST1']);
    });
});

describe('isTargetAvailable', () => {
    it('Off is always available', () => {
        expect(isTargetAvailable('', ['narrate'], CALLS)).toBe(true);
    });
    it('a live allowed target is available', () => {
        expect(isTargetAvailable('POST1', ['post'], CALLS)).toBe(true);
    });
    it('a target whose phase is not allowed is unavailable', () => {
        expect(isTargetAvailable('PRE1', ['post'], CALLS)).toBe(false);
    });
    it('a deleted call is unavailable (UI can flag the stale selection)', () => {
        expect(isTargetAvailable('POST9', ['post'], CALLS)).toBe(false);
    });
});

describe('taskInstructionToken — a call target entry carries a token, never the text', () => {
    // The entry is written once, at routing time; a copy of the text there would be frozen, and a task
    // that words its instruction per turn (the registration, from the reply's cast) could not.
    it('is a call-input macro the PRE/POST pass resolves', () => {
        const token = taskInstructionToken('imagegen-charimg');
        expect(token).toBe('{{mvuhelper::task::imagegen-charimg}}');
        const { text, resolved, warns } = substituteInputMacros(token, { stage: 'post', taskInstructions: { 'imagegen-charimg': 'this turn' } });
        expect(resolved).toEqual([{ token: 'task', arg: 'imagegen-charimg', length: 'this turn'.length }]);
        expect(text).toBe('this turn');
        expect(warns).toEqual([]);
    });

    it('rides inside the task wrapper like any instruction', () => {
        const f = buildTaskEntryFields({ taskId: 't', target: 'POST1', tag: 'myTag', instruction: taskInstructionToken('t') });
        expect(f.content).toBe('<myTag>\n{{mvuhelper::task::t}}\n</myTag>');
    });
});

// A task may run somewhere the user did not pick: the image look task runs on the narrator while pictures
// need looks and nothing is stored, whatever the Harvest via picker shows. MUTATION TARGET: read the
// stored preference only and that task never runs with harvest Off.
describe('runTargetOf — where a task runs this turn', () => {
    it('an active target wins over the stored preference, Off included', () => {
        expect(runTargetOf({ stored: '', active: 'narrate' })).toBe('narrate');
        expect(runTargetOf({ stored: 'POST2', active: '' })).toBe('');
        expect(runTargetOf({ stored: 'POST2', active: ' POST2 ' })).toBe('POST2');
    });

    it('a task with no active target runs on its stored preference', () => {
        expect(runTargetOf({ stored: 'POST2' })).toBe('POST2');
        expect(runTargetOf({ stored: '' })).toBe('');
        expect(runTargetOf()).toBe('');
    });
});

// A routing run reads the target when it starts and then awaits a lorebook write; two overlapping runs for one
// task finish in either order, so the one that read the older setting can write last. MUTATION TARGETS: start a
// run without waiting for the previous one, share one tail across keys, or let a rejected run hold its key.
describe('createKeyedQueue — routing writes for one task never overlap', () => {
    const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('a second run for one key starts only after the first has settled, and each caller gets its own result', async () => {
        const enqueue = createKeyedQueue();
        const first = deferred();
        const started = [];
        const a = enqueue('task', () => { started.push('a'); return first.promise; });
        const b = enqueue('task', () => { started.push('b'); return 'second'; });
        await settle();
        expect(started).toEqual(['a']);
        first.resolve('first');
        expect(await a).toBe('first');
        expect(await b).toBe('second');
        expect(started).toEqual(['a', 'b']);
    });

    it('runs for different keys do not wait for each other', async () => {
        const enqueue = createKeyedQueue();
        const held = deferred();
        const started = [];
        enqueue('one', () => { started.push('one'); return held.promise; });
        const other = enqueue('two', () => { started.push('two'); return 'two done'; });
        expect(await other).toBe('two done');
        expect(started).toEqual(['one', 'two']);
        held.resolve();
    });

    it('a run that throws frees its key, and only its own caller sees the error', async () => {
        const enqueue = createKeyedQueue();
        const failing = enqueue('task', () => { throw new Error('write failed'); });
        const next = enqueue('task', () => 'next ran');
        await expect(failing).rejects.toThrow('write failed');
        expect(await next).toBe('next ran');
    });
});
