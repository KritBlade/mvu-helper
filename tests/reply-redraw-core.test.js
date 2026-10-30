// tests/reply-redraw-core.test.js — the reply redraw's decisions: which running turn an edit belongs to,
// what that turn's one write does, and the queue other extensions' edits join it through.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    createRedrawRecord, findRedrawRecord, noteRedrawOwed, redrawWriteOf, isRedrawTakeLive,
    noteAnnouncedEdit, announcedEditsRunning, grownDeadlineAt, isRedrawWriteDue, replyEditProblem, holdHandIn, takeHandIns,
    queueReplyEdits, orderReplyEdits, prepareWithinWindow, runApplyChain, replyEditorsLine, resolveReplyAddress, locateReservedReply,
} from '../src/features/reply-redraw/reply-redraw-core.js';

const reply = () => ({ mes: 'text', swipe_id: 0, swipes: ['text'] });

describe('findRedrawRecord — an edit joins the turn of ITS take, or is written on its own', () => {
    it('MUTATION TARGET — the same message, index and swipe find the open record', () => {
        const message = reply();
        const record = createRedrawRecord({ message, mid: 12, swipe: 0 });
        expect(findRedrawRecord([record], { message, mid: 12, swipe: 0 })).toBe(record);
    });

    it('MUTATION TARGET — a regenerate (another message object at the same index) is not the record\'s take', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        expect(findRedrawRecord([record], { message: reply(), mid: 12, swipe: 0 })).toBe(null);
    });

    it('MUTATION TARGET — a swipe (same object, another swipe) is not the record\'s take', () => {
        const message = reply();
        const record = createRedrawRecord({ message, mid: 12, swipe: 0 });
        expect(findRedrawRecord([record], { message, mid: 12, swipe: 1 })).toBe(null);
    });

    it('MUTATION TARGET — the same object at another index is not the record\'s take', () => {
        const message = reply();
        const record = createRedrawRecord({ message, mid: 12, swipe: 0 });
        expect(findRedrawRecord([record], { message, mid: 13, swipe: 0 })).toBe(null);
    });

    it('two takes in flight at once each find their own record', () => {
        const first = reply();
        const second = reply();
        const a = createRedrawRecord({ message: first, mid: 12, swipe: 0 });
        const b = createRedrawRecord({ message: second, mid: 12, swipe: 0 });
        expect(findRedrawRecord([a, b], { message: second, mid: 12, swipe: 0 })).toBe(b);
    });

    it('no message or no record list finds nothing', () => {
        expect(findRedrawRecord([], { message: reply(), mid: 1, swipe: 0 })).toBe(null);
        expect(findRedrawRecord(null, { message: reply(), mid: 1, swipe: 0 })).toBe(null);
        expect(findRedrawRecord([createRedrawRecord({ message: null, mid: 1, swipe: 0 })], { message: null, mid: 1, swipe: 0 })).toBe(null);
    });
});

describe('noteRedrawOwed + redrawWriteOf — what the turn\'s end writes', () => {
    it('MUTATION TARGET — a text edit owes the full write, and it carries every writer once', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        noteRedrawOwed(record, 'text', 'logic-engine RES reply text');
        noteRedrawOwed(record, 'save', 'imagegen draw pass');
        noteRedrawOwed(record, 'text', 'POST receipt');
        noteRedrawOwed(record, 'text', 'POST receipt');
        expect(redrawWriteOf(record)).toEqual({ kind: 'text', label: 'reply redraw (logic-engine RES reply text, imagegen draw pass, POST receipt)' });
    });

    it('MUTATION TARGET — an edit outside the text owes the save alone', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        noteRedrawOwed(record, 'save', 'imagegen draw pass');
        expect(redrawWriteOf(record)).toEqual({ kind: 'save', label: 'reply redraw (imagegen draw pass)' });
    });

    it('MUTATION TARGET — nothing handed over writes nothing', () => {
        expect(redrawWriteOf(createRedrawRecord({ message: reply(), mid: 12, swipe: 0 }))).toEqual({ kind: 'none', label: '' });
        expect(redrawWriteOf(null)).toEqual({ kind: 'none', label: '' });
    });

    it('an unlabelled writer is still named, and an unknown kind is a caller bug', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        noteRedrawOwed(record, 'text', '');
        expect(redrawWriteOf(record).label).toBe('reply redraw (unlabelled writer)');
        expect(() => noteRedrawOwed(record, 'render', 'x')).toThrow(/unknown kind/);
    });
});

describe('isRedrawTakeLive — the turn\'s write lands only on the take its edits sit in', () => {
    it('MUTATION TARGET — the same object on the same swipe is live', () => {
        const message = reply();
        const record = createRedrawRecord({ message, mid: 12, swipe: 0 });
        expect(isRedrawTakeLive(record, { liveMessage: message, liveSwipe: 0 })).toBe(true);
    });

    it('MUTATION TARGET — a regenerated or deleted reply is not', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        expect(isRedrawTakeLive(record, { liveMessage: reply(), liveSwipe: 0 })).toBe(false);
        expect(isRedrawTakeLive(record, { liveMessage: undefined, liveSwipe: 0 })).toBe(false);
    });

    it('MUTATION TARGET — a swiped-away take is not', () => {
        const message = reply();
        const record = createRedrawRecord({ message, mid: 12, swipe: 0 });
        expect(isRedrawTakeLive(record, { liveMessage: message, liveSwipe: 1 })).toBe(false);
    });

    it('no record is never live', () => {
        expect(isRedrawTakeLive(null, { liveMessage: reply(), liveSwipe: 0 })).toBe(false);
    });
});

describe('announced edits (W1) — the close waits for what is still being made', () => {
    it('MUTATION TARGET — an announced edit runs until it is settled, and a settled one is not waited for', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        const draw = noteAnnouncedEdit(record, 'imagegen draw pass');
        noteAnnouncedEdit(record, 'llm-task narrate capture (imagegen-charimg)');
        expect(announcedEditsRunning(record)).toEqual(['imagegen draw pass', 'llm-task narrate capture (imagegen-charimg)']);
        draw.isSettled = true;
        expect(announcedEditsRunning(record)).toEqual(['llm-task narrate capture (imagegen-charimg)']);
    });

    it('no record is running nothing', () => {
        expect(announcedEditsRunning(null)).toEqual([]);
    });

    it('MUTATION TARGET — the deadline only grows: a shorter allowance never pulls it in', () => {
        expect(grownDeadlineAt(0, 1000, 60_000)).toBe(61_000);
        expect(grownDeadlineAt(90_000, 1000, 60_000)).toBe(90_000);
        expect(grownDeadlineAt(30_000, 1000, 60_000)).toBe(61_000);
    });

    it('a missing or negative allowance asks for no time', () => {
        expect(grownDeadlineAt(0, 1000, undefined)).toBe(1000);
        expect(grownDeadlineAt(5000, 1000, -3)).toBe(5000);
    });
});

describe('isRedrawWriteDue — the write about to happen', () => {
    const ending = () => Object.assign(createRedrawRecord({ message: reply(), mid: 12, swipe: 0 }), { isEnding: true });

    it('a record opens with its phase still running', () => {
        expect(createRedrawRecord({ message: reply(), mid: 12, swipe: 0 }).isEnding).toBe(false);
    });
    it('MUTATION TARGET — while the phase runs the write is not due: its LLM calls take seconds', () => {
        expect(isRedrawWriteDue(createRedrawRecord({ message: reply(), mid: 12, swipe: 0 }))).toBe(false);
    });
    it('MUTATION TARGET — once the phase has reached its end, with nothing announced still running, it is due', () => {
        expect(isRedrawWriteDue(ending())).toBe(true);
    });
    it('MUTATION TARGET — an announced edit still being made keeps it from being due; once settled it is due', () => {
        const record = ending();
        const draw = noteAnnouncedEdit(record, 'imagegen draw pass');
        expect(isRedrawWriteDue(record)).toBe(false);
        draw.isSettled = true;
        expect(isRedrawWriteDue(record)).toBe(true);
    });
    it('MUTATION TARGET — a write running now is due, whatever its record says', () => {
        expect(isRedrawWriteDue(createRedrawRecord({ message: reply(), mid: 12, swipe: 0 }), { isWriting: true })).toBe(true);
    });
    it('no record has no write due', () => {
        expect(isRedrawWriteDue(null)).toBe(false);
        expect(isRedrawWriteDue(null, { isWriting: true })).toBe(false);
    });

    // The host halves cannot be opened by a test, so the guards read them.
    const host = readFileSync(new URL('../src/features/reply-redraw/reply-redraw.js', import.meta.url), 'utf8').replace(/\r/g, '');
    const bodyOf = (text, signature) => { const from = text.slice(text.indexOf(signature)); return from.slice(0, from.indexOf('\n}')); };
    it('MUTATION TARGET — whoever waits goes on when an edit is announced (the close now waits for it)', () => {
        expect(bodyOf(host, 'export function announceReplyEdit(')).toMatch(/const entry = noteAnnouncedEdit\(record, label\);[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*releaseDueWriteWaiters\(record\);/);
    });
    it('MUTATION TARGET — and when the write has ended, however it ended', () => {
        expect(bodyOf(host, 'function writeAndClose(')).toMatch(/writeHeld\(record, moment\)\.finally\(\(\) => \{\s*writesInFlight\.delete\(record\);\s*releaseDueWriteWaiters\(record\);\s*\}\)/);
    });
    it('the readers ask about the showing take, open or writing', () => {
        expect(bodyOf(host, 'export function isReplyWriteDue(')).toContain('isRedrawWriteDue(record, { isWriting: writesInFlight.has(record) })');
        expect(bodyOf(host, 'export function dueReplyWriteEnded(')).toContain('if (!isRedrawWriteDue(record, { isWriting: writesInFlight.has(record) })) return Promise.resolve();');
        expect(bodyOf(host, 'function recordOfShowingTake(')).toContain('findRedrawRecord(openRecords, take) || findRedrawRecord([...writesInFlight.keys()], take)');
    });

    // The post-reply phase marks its end wherever no LLM call is left before the write: a stopped reply,
    // a reply with no call to run, and once the calls have returned.
    const pass = readFileSync(new URL('../src/features/small-llm/extra-llm-calls.js', import.meta.url), 'utf8').replace(/\r/g, '');
    it('MUTATION TARGET — a stopped reply marks the end before it waits for the turn\'s own work', () => {
        expect(pass).toMatch(/if \(generationStopped\) \{[^}]*noteReplyRedrawEnding\(turnEnd\.redraw\);\s*await awaitTurnOwnWork\(/);
    });
    it('MUTATION TARGET — a reply with no call to run marks it before that finish', () => {
        expect(pass).toMatch(/const finishWithoutCalls = async \(\) => \{\s*noteReplyRedrawEnding\(turnEnd\.redraw\);\s*isTurnSettled = await finishWithoutPostCalls\(/);
    });
    it('MUTATION TARGET — a reply with calls marks it once they have returned', () => {
        expect(pass).toMatch(/const rawResults = await runCalls\([^\n]*\n\s*const results = enforcePostOutputChecks\(calls, rawResults\);\n\s*noteReplyRedrawEnding\(turnEnd\.redraw\);/);
    });
});

const goodEdit = (by, stage = 'content', apply = (t) => t) => ({ by, stage, apply });

describe('replyEditProblem — a malformed edit is refused, never guessed at (Q1, B3)', () => {
    it('MUTATION TARGET — a well-formed edit has no problem, with or without prepare', () => {
        expect(replyEditProblem(goodEdit('a-extension'))).toBe('');
        expect(replyEditProblem({ ...goodEdit('a-extension'), prepare: async () => {} })).toBe('');
    });

    it('MUTATION TARGET — every missing or wrong part is named', () => {
        expect(replyEditProblem(null)).toMatch(/not an object/);
        expect(replyEditProblem(goodEdit('  '))).toMatch(/`by`/);
        expect(replyEditProblem(goodEdit('a', 'layout'))).toMatch(/neither "content" nor "presentation"/);
        expect(replyEditProblem({ by: 'a', stage: 'content' })).toMatch(/apply/);
        expect(replyEditProblem({ ...goodEdit('a'), prepare: 'later' })).toMatch(/prepare/);
    });

    it('MUTATION TARGET — no default stage: a stage left out is refused', () => {
        expect(replyEditProblem({ by: 'a', apply: (t) => t })).toMatch(/stage "undefined"/);
    });

    it('a stage named like an Object prototype key is refused', () => {
        expect(replyEditProblem(goodEdit('a', 'toString'))).toMatch(/neither/);
        expect(replyEditProblem(goodEdit('a', '__proto__'))).toMatch(/neither/);
    });
});

describe('hand-ins held on a record', () => {
    it('MUTATION TARGET — a newer hand-in from the same extension replaces the older one', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        const second = goodEdit('tts');
        expect(holdHandIn(record, goodEdit('tts'))).toBe(false);
        expect(holdHandIn(record, goodEdit('translator'))).toBe(false);
        expect(holdHandIn(record, second)).toBe(true);
        expect(record.handIns.map((e) => e.by)).toEqual(['tts', 'translator']);
        expect(record.handIns[0]).toBe(second);
    });

    it('MUTATION TARGET — a write takes the hand-ins and leaves none, so no later write applies one twice', () => {
        const record = createRedrawRecord({ message: reply(), mid: 12, swipe: 0 });
        holdHandIn(record, goodEdit('tts'));
        expect(takeHandIns(record).map((e) => e.by)).toEqual(['tts']);
        expect(record.handIns).toEqual([]);
        expect(takeHandIns(record)).toEqual([]);
    });
});

describe('queueReplyEdits + orderReplyEdits — one queue, the same order on every install (Q1)', () => {
    it('MUTATION TARGET — one edit per extension per write: the second is refused, the hand-in kept', () => {
        const handIn = goodEdit('tts');
        const { queue, refused } = queueReplyEdits([handIn], [goodEdit('tts'), goodEdit('galgame-companion', 'presentation')]);
        expect(queue).toEqual([handIn, expect.objectContaining({ by: 'galgame-companion' })]);
        expect(queue[0]).toBe(handIn);
        expect(refused).toEqual([expect.objectContaining({ by: 'tts', outcome: 'refused', reason: expect.stringMatching(/second edit/) })]);
    });

    it('MUTATION TARGET — content runs before presentation whatever order they arrived in', () => {
        const ordered = orderReplyEdits([goodEdit('a-shaper', 'presentation'), goodEdit('z-translator', 'content')]);
        expect(ordered.map((e) => e.by)).toEqual(['z-translator', 'a-shaper']);
    });

    it('MUTATION TARGET — within a stage, by name in code-point order, not arrival or locale order', () => {
        const names = ['b-ext', 'B-ext', 'a-ext', 'é-ext', 'e-ext'];
        const ordered = orderReplyEdits(names.map((n) => goodEdit(n)));
        expect(ordered.map((e) => e.by)).toEqual(['B-ext', 'a-ext', 'b-ext', 'e-ext', 'é-ext']);
        const reversed = orderReplyEdits(names.slice().reverse().map((n) => goodEdit(n)));
        expect(reversed.map((e) => e.by)).toEqual(ordered.map((e) => e.by));
    });

    it('a name that is a prefix of another comes first', () => {
        expect(orderReplyEdits([goodEdit('tts-extra'), goodEdit('tts')]).map((e) => e.by)).toEqual(['tts', 'tts-extra']);
    });
});

describe('prepareWithinWindow — every prepare at once, each cut off at the window\'s end (Q3)', () => {
    it('MUTATION TARGET — a prepare still running when the window ends is cut off and its signal aborts; the others are ready', async () => {
        vi.useFakeTimers();
        try {
            let slowSignal = null;
            const started = [];
            const edits = [
                { ...goodEdit('a'), prepare: async () => { started.push('a'); } },
                { ...goodEdit('b'), prepare: (_text, { signal }) => { started.push('b'); slowSignal = signal; return new Promise(() => {}); } },
                { ...goodEdit('c'), prepare: async () => { started.push('c'); } },
            ];
            const done = prepareWithinWindow(edits, 'text0', 5000);
            await vi.advanceTimersByTimeAsync(4999);
            expect(slowSignal.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            const outcomes = await done;
            expect(started).toEqual(['a', 'b', 'c']);
            expect(outcomes.map((o) => o.outcome)).toEqual(['ready', 'cut-off', 'ready']);
            expect(slowSignal.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('MUTATION TARGET — a prepare that throws (sync or async) is dropped with its error', async () => {
        const boom = new Error('boom');
        const outcomes = await prepareWithinWindow([
            { ...goodEdit('a'), prepare: () => { throw boom; } },
            { ...goodEdit('b'), prepare: async () => { throw boom; } },
        ], 'text0', 5000);
        expect(outcomes).toEqual([{ outcome: 'threw', error: boom }, { outcome: 'threw', error: boom }]);
    });

    it('MUTATION TARGET — every prepare gets the same text, and an edit without one is ready at once', async () => {
        const seen = [];
        const outcomes = await prepareWithinWindow([
            goodEdit('plain'),
            { ...goodEdit('reader'), prepare: async (text) => { seen.push(text); } },
        ], 'text0', 5000);
        expect(outcomes.map((o) => o.outcome)).toEqual(['ready', 'ready']);
        expect(seen).toEqual(['text0']);
    });

    it('no prepare at all waits for nothing', async () => {
        await expect(prepareWithinWindow([goodEdit('a')], 't', 0)).resolves.toEqual([{ outcome: 'ready' }]);
    });
});

describe('runApplyChain — one copy, handed along the queue (B2, B3)', () => {
    it('MUTATION TARGET — each editor gets the text the one before it returned', () => {
        const chain = runApplyChain('text0', [
            goodEdit('a', 'content', (t) => `${t}+a`),
            goodEdit('b', 'content', (t) => `${t}+b`),
            goodEdit('g', 'presentation', (t) => `<p>${t}</p>`),
        ]);
        expect(chain.text).toBe('<p>text0+a+b</p>');
        expect(chain.results.map((r) => [r.by, r.outcome, r.delta])).toEqual([['a', 'changed', 2], ['b', 'changed', 2], ['g', 'changed', 7]]);
    });

    it('MUTATION TARGET — a Promise is refused, and the next editor gets the text it was given', () => {
        const pending = Promise.resolve('late');
        const chain = runApplyChain('text0', [goodEdit('async', 'content', () => pending), goodEdit('b', 'content', (t) => `${t}+b`)]);
        expect(chain.text).toBe('text0+b');
        expect(chain.results[0]).toEqual(expect.objectContaining({ by: 'async', outcome: 'refused', reason: expect.stringMatching(/Promise/), pending }));
    });

    it('MUTATION TARGET — a throw and a result that is not a string are refused', () => {
        const chain = runApplyChain('text0', [
            goodEdit('thrower', 'content', () => { throw new Error('x'); }),
            goodEdit('nothing', 'content', () => undefined),
            goodEdit('nil', 'content', () => null),
        ]);
        expect(chain.text).toBe('text0');
        expect(chain.results.map((r) => r.reason)).toEqual(['apply threw', 'apply returned undefined, not the text', 'apply returned null, not the text']);
    });

    it('an editor that returns the text as given is unchanged', () => {
        expect(runApplyChain('text0', [goodEdit('idle')]).results).toEqual([{ by: 'idle', stage: 'content', outcome: 'unchanged', delta: 0 }]);
    });
});

describe('replyEditorsLine — every editor in order with what became of it (M3)', () => {
    it('MUTATION TARGET — names each result in its own words', () => {
        expect(replyEditorsLine([
            { by: 'a', stage: 'content', outcome: 'changed', delta: 12 },
            { by: 'b', stage: 'content', outcome: 'changed', delta: -3 },
            { by: 'c', stage: 'content', outcome: 'unchanged', delta: 0 },
            { by: 'd', stage: 'content', outcome: 'cut-off' },
            { by: 'e', stage: 'content', outcome: 'threw' },
            { by: 'g', stage: 'presentation', outcome: 'refused', reason: 'apply threw' },
        ])).toBe('a (content) changed +12 · b (content) changed -3 · c (content) unchanged · d (content) cut off at the window\'s end · e (content) dropped: prepare threw · g (presentation) refused: apply threw');
    });
});

describe('resolveReplyAddress — the reply a request names (B4, Q5)', () => {
    const chatOf = () => [{ is_user: true, mes: 'hi' }, { mes: 'reply', swipe_id: 1, swipes: ['a', 'reply'] }];

    it('MUTATION TARGET — a request naming the showing take of a reply resolves to its message', () => {
        const chat = chatOf();
        expect(resolveReplyAddress({ chat_id: 'c1', message_id: 1, swipe_id: 1 }, { chatId: 'c1', chat })).toEqual({ message: chat[1], mid: 1, swipe: 1 });
    });

    it('MUTATION TARGET — another chat, no such message, a user message and a swipe not showing are refused', () => {
        const chat = chatOf();
        expect(resolveReplyAddress({ chat_id: 'c2', message_id: 1, swipe_id: 1 }, { chatId: 'c1', chat }).problem).toMatch(/chat "c2"/);
        expect(resolveReplyAddress({ chat_id: 'c1', message_id: 5, swipe_id: 0 }, { chatId: 'c1', chat }).problem).toMatch(/no message 5/);
        expect(resolveReplyAddress({ chat_id: 'c1', message_id: 0, swipe_id: 0 }, { chatId: 'c1', chat }).problem).toMatch(/the user's/);
        expect(resolveReplyAddress({ chat_id: 'c1', message_id: 1, swipe_id: 0 }, { chatId: 'c1', chat }).problem).toMatch(/swipe 1 is/);
    });

    it('a malformed request is refused, never guessed at', () => {
        const chat = chatOf();
        expect(resolveReplyAddress(null, { chatId: 'c1', chat }).problem).toMatch(/not an object/);
        expect(resolveReplyAddress({ chat_id: 'c1', message_id: '1', swipe_id: 1 }, { chatId: 'c1', chat }).problem).toMatch(/not a message index/);
        expect(resolveReplyAddress({ message_id: 1, swipe_id: 1 }, { chatId: 'c1', chat }).problem).toMatch(/names chat/);
    });
});

describe('locateReservedReply — the reserved reply is followed by its message object (Q5)', () => {
    it('MUTATION TARGET — a message deleted above it moves its index without losing it', () => {
        const message = reply();
        const chat = [{ mes: 'older' }, message];
        const reservation = { chatId: 'c1', message, swipe: 0 };
        chat.splice(0, 1);
        expect(locateReservedReply(reservation, { chatId: 'c1', chat })).toEqual({ mid: 0 });
    });

    it('MUTATION TARGET — a regenerate (a new object at the same index) is refused', () => {
        const reservation = { chatId: 'c1', message: reply(), swipe: 0 };
        expect(locateReservedReply(reservation, { chatId: 'c1', chat: [reply()] }).problem).toMatch(/gone/);
    });

    it('MUTATION TARGET — a swipe to another take is refused', () => {
        const message = reply();
        const reservation = { chatId: 'c1', message, swipe: 0 };
        message.swipe_id = 1;
        expect(locateReservedReply(reservation, { chatId: 'c1', chat: [message] }).problem).toMatch(/swipe 1/);
    });

    it('MUTATION TARGET — another chat is refused even if the object were still around', () => {
        const message = reply();
        expect(locateReservedReply({ chatId: 'c1', message, swipe: 0 }, { chatId: 'c2', chat: [message] }).problem).toMatch(/another chat/);
    });
});
