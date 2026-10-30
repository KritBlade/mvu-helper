// sillytavern/reply-text-write.js — the ONE way this extension writes an edit into a finished reply.
//
// The four steps of the write live here, and their only caller is the reply redraw
// (features/reply-redraw), which every stage that edits a finished reply goes through: no writer can
// skip the swipe mirror or the announcement, or lose a step to another step throwing.
// See devdoc/editing-a-finished-reply.md.
//
// THE STEPS ARE INDEPENDENT AND ALL FOUR ARE ATTEMPTED. `updateMessageBlock` throwing must not cost
// the save, and MESSAGE_UPDATED runs OTHER extensions' listeners — one of them throwing is not a
// reason to drop this message on the floor. Every failure gets its own console line naming the
// CALLER, the step and what that step's absence costs (reply-text-write-core.js); nothing is
// swallowed, and nothing unrelated is aborted. The result says what ran, for a caller that cares.

import { eventSource, event_types, updateMessageBlock } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';   // extensions.js lives in public/scripts/, one level shallower than script.js
import { createModuleLog } from './log.js';
import { syncActiveSwipeText } from '../shared/active-swipe-text.js';
import { replyWriteFailureLine, replyWriteTraceLine, summarizeReplyWrite } from './reply-text-write-core.js';

const log = createModuleLog('reply-text-write');

async function runStep(outcomes, step, label, mid, run) {
    try {
        await run();
        outcomes[step] = true;
    } catch (e) {
        outcomes[step] = false;
        log.warn(replyWriteFailureLine(step, label, mid), e);
    }
}

async function saveChatNow() {
    const ctx = getContext();
    if (!ctx || typeof ctx.saveChat !== 'function') throw new Error('saveChat is unavailable on the ST context');
    await ctx.saveChat();
}

/**
 * Commit an edit already made to `message.mes`: mirror it into the active swipe, re-render the
 * message, announce the rebuild, and persist. Never throws.
 *
 * @param {object} message the chat message object, with `mes` ALREADY set to the new text
 * @param {number} mid its index in `getContext().chat`
 * @param {string} label the caller's own name for itself — it lands in every failure line
 * @param {{render?: boolean, save?: boolean}} [opts] render:false skips the re-render and its
 *   announcement, and save:false the save: the reply redraw mirrors an edit at once and leaves the
 *   rest to the turn's end.
 * @returns {Promise<{ok: boolean, done: string[], failed: string[], skipped: string[]}>}
 */
export async function commitReplyTextEdit(message, mid, label, { render = true, save = true } = {}) {
    const outcomes = {};
    if (!message || typeof message.mes !== 'string') {
        log.warn(`${label || 'unlabelled writer'}: asked to commit msg ${mid}, which has no text — nothing written.`);
        return summarizeReplyWrite(outcomes);
    }
    await runStep(outcomes, 'swipe', label, mid, () => { syncActiveSwipeText(message); });
    if (render) {
        await runStep(outcomes, 'render', label, mid, () => { updateMessageBlock(mid, message); });
        await runStep(outcomes, 'announce', label, mid, () => eventSource.emit(event_types.MESSAGE_UPDATED, mid));
    }
    if (save) await runStep(outcomes, 'save', label, mid, saveChatNow);
    const summary = summarizeReplyWrite(outcomes);
    log.domain('pipeline', 'trace', replyWriteTraceLine(label, mid, summary));
    return summary;
}

// The save on its own: an edit outside the text (an image attached as media) changes nothing to render,
// but still has to persist.
export async function saveReplyChat(label, mid = -1) {
    const outcomes = {};
    await runStep(outcomes, 'save', label, mid, saveChatNow);
    const summary = summarizeReplyWrite(outcomes);
    log.domain('pipeline', 'trace', replyWriteTraceLine(label, mid, summary));
    return summary;
}

