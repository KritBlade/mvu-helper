// sillytavern/reply-text-write-core.js — PURE half of the finished-reply write (no ST imports).
//
// Writing an edit into a reply that is already on screen is four steps, and they are INDEPENDENT:
// each one failing costs something different, and none of them being skipped is any of the others'
// business. This file owns what each failure MEANS, so the host half only has to run the steps and
// hand the outcomes back. Rules for the write itself: devdoc/editing-a-finished-reply.md.

export const REPLY_WRITE_STEPS = ['swipe', 'render', 'announce', 'save'];

// Traced to the incident each one came from — a warn that only says "failed" sends the reader
// hunting, and every one of these has already been hunted once.
const CONSEQUENCE = {
    swipe: 'the stored copy of this swipe still holds the PRE-edit text, so swiping away and back restores it',
    render: 'the chat still shows the pre-edit text until something else re-renders this message',
    announce: 'the DOM was rebuilt without telling anyone, so whatever another extension had mounted inside this message (a TavernHelper status-menu iframe) is gone until the chat is reloaded',
    save: 'the edit is in memory only — it is lost on reload, and the next context build sends the un-edited text',
};

// WHICH writer and WHICH step, in one line. The label is the writer's own name for itself: every
// writer's edit funnels through one function, so an error that named only the function would say
// nothing about whose edit failed.
export function replyWriteFailureLine(step, label, mid) {
    const what = CONSEQUENCE[step] || 'an unrecognised step of the reply write failed';
    return `${label || 'unlabelled writer'}: ${step} threw on msg ${mid} — ${what}.`;
}

// What actually happened, for the `pipeline` domain trace. A funnel that only speaks up on FAILURE
// makes "did my write go through it?" unanswerable — a clean run and a write that never happened read
// the same from the console (live question, 2026-08-29). Off unless the domain toggle is on.
export function replyWriteTraceLine(label, mid, summary) {
    const s = summary || { done: [], failed: [], skipped: [] };
    const parts = [`${label || 'unlabelled writer'} -> msg ${mid}: ${s.done.join(' ') || '(nothing ran)'}`];
    if (s.failed && s.failed.length) parts.push(`FAILED: ${s.failed.join(' ')}`);
    if (s.skipped && s.skipped.length) parts.push(`not attempted: ${s.skipped.join(' ')}`);
    return parts.join(' · ');
}

// `outcomes[step]` is true (ran), false (threw) or absent (not attempted — e.g. save was deferred to
// the caller). `ok` means nothing THREW; a skipped step is not a failure.
export function summarizeReplyWrite(outcomes) {
    const done = [];
    const failed = [];
    const skipped = [];
    for (const step of REPLY_WRITE_STEPS) {
        const v = outcomes ? outcomes[step] : undefined;
        if (v === true) done.push(step);
        else if (v === false) failed.push(step);
        else skipped.push(step);
    }
    return { ok: failed.length === 0, done, failed, skipped };
}
