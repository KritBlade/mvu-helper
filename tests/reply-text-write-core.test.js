// tests/reply-text-write-core.test.js — the finished-reply write: what each failure MEANS, and the
// repo-wide invariant that there is exactly one place it can happen, reached only through the reply redraw.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { replyWriteFailureLine, replyWriteTraceLine, summarizeReplyWrite, REPLY_WRITE_STEPS } from '../src/sillytavern/reply-text-write-core.js';

describe('replyWriteFailureLine — WHICH writer and WHICH step, or the funnel is worse than the calls it replaced', () => {
    it('MUTATION TARGET — the caller\'s own label is in the line', () => {
        const line = replyWriteFailureLine('render', 'POST receipt', 8);
        expect(line).toContain('POST receipt');
        expect(line).toContain('render');
        expect(line).toContain('msg 8');
    });

    it('MUTATION TARGET — each step names its OWN consequence, and they differ', () => {
        const seen = REPLY_WRITE_STEPS.map((s) => replyWriteFailureLine(s, 'x', 1));
        expect(new Set(seen).size).toBe(REPLY_WRITE_STEPS.length);
        expect(replyWriteFailureLine('swipe', 'x', 1)).toContain('swiping away and back');
        expect(replyWriteFailureLine('render', 'x', 1)).toContain('still shows the pre-edit text');
        expect(replyWriteFailureLine('announce', 'x', 1)).toContain('mounted inside this message');
        expect(replyWriteFailureLine('save', 'x', 1)).toContain('memory only');
    });

    it('an unlabelled writer and an unknown step still produce a usable line', () => {
        expect(replyWriteFailureLine('render', '', 3)).toContain('unlabelled writer');
        expect(replyWriteFailureLine('nonsense', 'x', 3)).toContain('unrecognised step');
    });
});

describe('summarizeReplyWrite — a skipped step is not a failure', () => {
    it('MUTATION TARGET — ok is false only when something THREW', () => {
        expect(summarizeReplyWrite({ swipe: true, render: true, announce: true, save: true }).ok).toBe(true);
        expect(summarizeReplyWrite({ swipe: true, render: true, announce: true }).ok).toBe(true);   // save deferred
        expect(summarizeReplyWrite({ swipe: true, render: false, announce: true, save: true }).ok).toBe(false);
    });

    it('sorts the steps into what ran, what threw and what was never attempted', () => {
        const r = summarizeReplyWrite({ swipe: true, render: false });
        expect(r.done).toEqual(['swipe']);
        expect(r.failed).toEqual(['render']);
        expect(r.skipped).toEqual(['announce', 'save']);
    });

    it('nothing attempted is not an error — a message with no text never reaches a step', () => {
        expect(summarizeReplyWrite({})).toEqual({ ok: true, done: [], failed: [], skipped: [...REPLY_WRITE_STEPS] });
        expect(summarizeReplyWrite(null).ok).toBe(true);
    });
});

describe('replyWriteTraceLine — a clean run must not look like a write that never happened', () => {
    it('MUTATION TARGET — names the caller, the message and every step that RAN', () => {
        const line = replyWriteTraceLine('POST receipt', 10,
            { ok: true, done: ['swipe', 'render', 'announce', 'save'], failed: [], skipped: [] });
        expect(line).toBe('POST receipt -> msg 10: swipe render announce save');
    });

    it('MUTATION TARGET — a failed step is called out, not folded into the happy list', () => {
        const line = replyWriteTraceLine('imagegen draw pass', 4,
            { ok: false, done: ['swipe', 'render'], failed: ['announce'], skipped: ['save'] });
        expect(line).toContain('swipe render');
        expect(line).toContain('FAILED: announce');
        expect(line).toContain('not attempted: save');
    });

    it('a deferred save reads as not attempted, never as done', () => {
        const line = replyWriteTraceLine('imagegen draw pass', 4,
            { ok: true, done: ['swipe', 'render', 'announce'], failed: [], skipped: ['save'] });
        expect(line).not.toContain('FAILED');
        expect(line).toContain('not attempted: save');
    });

    it('nothing ran says so out loud rather than trailing off', () => {
        expect(replyWriteTraceLine('x', 1, { done: [], failed: [], skipped: [] })).toContain('(nothing ran)');
        expect(replyWriteTraceLine('', 1, null)).toContain('unlabelled writer');
    });
});

describe('SOURCE GATE — one place writes a finished reply, and everyone goes through it', () => {
    // One function writes a finished reply, and only the reply redraw calls it. A writer that wrote on
    // its own could skip the swipe mirror or the announcement, and would re-render the reply once more
    // per turn.
    const OWNER = 'src/sillytavern/reply-text-write.js';
    const REDRAW = 'src/features/reply-redraw/reply-redraw.js';
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
    });
    const files = walk(path.join(process.cwd(), 'src'))
        .map((p) => path.relative(process.cwd(), p).split(path.sep).join('/'));

    // `line` must be code, not the prose in a header comment explaining the rule.
    const codeLines = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

    const soleCaller = (label, re, allow = [OWNER]) => {
        const offenders = files.filter((f) => !allow.includes(f) && codeLines(readFileSync(f, 'utf8')).some((l) => re.test(l)));
        expect(offenders, `${label} may only be called from ${allow.join(', ')}`).toEqual([]);
    };

    it('MUTATION TARGET — updateMessageBlock has exactly one caller', () => {
        soleCaller('updateMessageBlock', /\bupdateMessageBlock\s*\(/);
    });

    it('MUTATION TARGET — MESSAGE_UPDATED is announced from exactly one place', () => {
        soleCaller('emit(MESSAGE_UPDATED)', /emit\s*\(\s*event_types\.MESSAGE_UPDATED/);
    });

    it('MUTATION TARGET — no writer emits MESSAGE_EDITED', () => {
        // MESSAGE_EDITED is the event for a user's own edit. SillyTavern answers it with a whole-prompt
        // rebuild (the Prompt Manager's token count, ~0.6 s on a large card), and every listener the
        // write needs also hears the MESSAGE_UPDATED above.
        const offenders = files.filter((f) => codeLines(readFileSync(f, 'utf8')).some((l) => /emit\s*\(\s*event_types\.MESSAGE_EDITED/.test(l)));
        expect(offenders, 'emit(MESSAGE_EDITED) is never ours to send').toEqual([]);
    });

    it('MUTATION TARGET — saveChat is called from exactly one place', () => {
        soleCaller('saveChat()', /\.saveChat\s*\(\s*\)/);
    });

    it('the swipe mirror is called only by the funnel (its own module aside)', () => {
        soleCaller('syncActiveSwipeText', /\bsyncActiveSwipeText\s*\(/, [OWNER, 'src/shared/active-swipe-text.js']);
    });

    it('MUTATION TARGET — only the reply redraw calls the funnel', () => {
        soleCaller('commitReplyTextEdit', /\bcommitReplyTextEdit\s*\(/, [OWNER, REDRAW]);
        soleCaller('saveReplyChat', /\bsaveReplyChat\s*\(/, [OWNER, REDRAW]);
    });

    it('every feature that edits a reply hands the edit to the reply redraw', () => {
        for (const f of ['src/features/imagegen/image-gen.js',
                         'src/features/small-llm/extra-llm-calls.js',
                         'src/features/logic-engine/turn-runner.js']) {
            expect(readFileSync(f, 'utf8')).toContain('redrawReply(');
        }
    });
});
