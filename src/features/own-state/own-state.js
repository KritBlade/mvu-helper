// own-state/own-state.js — mvu-helper's own part of the card's state (stat_data.$mvuhelper, sillytavern/mvu-bridge-core
// MVUHELPER_STAT_ROOT), written at the end of every reply in ONE pass per copy of the reply's state that is saved.
// The pass runs every registered task on that copy in the order they were registered (own-state-core
// runOwnStateTasks): the worn-outfit store's write (imagegen), then the streetcleaner, which sweeps what the writes
// left (plans/executed/streetcleaner.md §2).
//
// TWO COPIES ARE SAVED. MVU saves the reply's state as soon as its mag_before_message_update listeners return, so the
// pass runs there, on every card. A turn engine resolves on its own copy of the whole state, taken when MVU's parse
// ended — before that pass — and saves that copy over MVU's; so on a card with an engine the pass runs again on the
// engine's copy when the engine announces it is staged (RES_STAGED_EVENT), which it waits on before it saves — only
// when the signal says the engine saves this resolve (own-state-core stagedCopyToRun). The engine's code and its
// resolve are untouched: only mvu-helper's own root changes (plans/reply-cast.md D23), so a reply resolves exactly as
// it did.
//
// The engine's copy is MVU's parse of the reply, captured here as it fires: the engine resolves on that same object
// and saves it. A resolve of a parse this pass did not capture (POST's, when narrate's went unresolved) started from
// the stored state, which MVU's save already passed through.
//
// A STAGE THAT CHANGES THE REPLY AFTER BOTH COPIES ARE SAVED runs the pass again on the reply's saved state
// (runOwnStateOnSavedReply): a POST call that writes the reply's pictures places them after MVU's save and the
// engine's staged copy were passed through, so the worn-outfit store in them knows nothing of those pictures. It runs
// inside the post-reply phase, before POST's own block is applied, so POST's parse and the relay it fires start from
// the state it saved.

import { eventSource, event_types } from '../../../../../../../script.js';
import { getContext } from '../../../../../../extensions.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { rewriteOwnState } from '../../sillytavern/mvu-bridge.js';
import { MVU_VARIABLE_UPDATE_ENDED, MVU_BEFORE_MESSAGE_UPDATE, MVUHELPER_STAT_ROOT, currentWriter, WRITER_MESSAGE, stateBefore } from '../../sillytavern/mvu-bridge-core.js';
import { endedEventDisposition } from '../../shared/mvu-parse-disposition.js';
import { latestAiMessageId, swipeOf } from '../../shared/latest-reply.js';
import { RES_STAGED_EVENT, awaitTurnWork } from '../logic-engine/index.js';
import { runOwnStateTasks, stagedCopyToRun, droppedOwnParts } from './own-state-core.js';

const log = createModuleLog('own-state');
const tasks = [];
const SAVED_REPLY_WRITER = 'end-of-reply pass';

/**
 * Add a task to the end-of-reply pass: `{ name, run(statData, reply) }`, where `reply` is `{ mid, isEngineCopy,
 * copyLabel }` — the reply's message index, whether the copy is the engine's staged one, and a label for log lines.
 * Tasks run in the order they are registered, so they are registered in one place (src/index.js).
 */
export function registerOwnStateTask(task) {
    if (!task || typeof task.run !== 'function' || !String(task.name || '').trim()) {
        log.warn('an end-of-reply task needs a name and a run function — ignored');
        return;
    }
    tasks.push(task);
}

function runTasksOn(statData, reply) {
    return runOwnStateTasks(tasks, statData, reply, (task, e) => {
        log.warn(`msg ${reply.mid} (${reply.copyLabel}): the ${task.name} task failed — this copy of the state keeps what that task would have changed:`, e);
    });
}

let replyParses = new WeakMap();   // reply message → { swipe, mvuData }: MVU's parse of that reply, that swipe
const droppedWarnedChats = new Set();

// The state reply `mid` starts from lacks parts of mvu-helper's root that the stored state before it holds: something
// between them dropped them. Named once per chat; the parts then start over (L7: surfaced, never written around).
function warnIfOwnPartsDropped(chat, mid) {
    const start = stateBefore(chat, mid);
    const earlier = start ? stateBefore(chat, start.index) : null;
    if (!earlier) return;
    const dropped = droppedOwnParts(start.statData, earlier.statData);
    if (!dropped.length) return;
    const chatId = String(getContext().chatId || '');
    if (droppedWarnedChats.has(chatId)) return;
    droppedWarnedChats.add(chatId);
    log.warn(`msg ${earlier.index}'s state holds ${dropped.map((part) => `${MVUHELPER_STAT_ROOT}.${part}`).join(', ')} and msg ${start.index}'s does not, `
        + "so mvu-helper's own state starts over from there (what each character wears, the character registry). Either the card's "
        + `Zod schema strips it — declare ${MVUHELPER_STAT_ROOT} open: z.record(z.string(), z.any()) (devdoc/dev-helper.md) — or the `
        + "state was rebuilt from the card's initial variables.");
}

eventSource.on(MVU_VARIABLE_UPDATE_ENDED, (mvuData, variablesBefore) => {
    try {
        // Read before anything else: a parse mvu-helper runs itself (a PRE sim, POST, a relay) labels its frame
        // only while this synchronous part runs, and only an unlabeled parse is the reply's own.
        if (currentWriter() !== WRITER_MESSAGE) return;
        if (!mvuData || !mvuData.stat_data || typeof mvuData.stat_data !== 'object') return;
        const chat = getContext().chat;
        // MVU's floor replay re-parses old messages; a parse that did not start from the newest stored states is
        // not this reply's (shared/mvu-parse-disposition).
        if (endedEventDisposition(variablesBefore && variablesBefore.stat_data, chat).disposition !== 'turn') return;
        const mid = latestAiMessageId(chat);
        if (mid < 0) return;
        replyParses.set(chat[mid], { swipe: swipeOf(chat, mid), mvuData });
    } catch (e) {
        log.warn("could not record this reply's parse — on a card with a turn engine, the engine's copy of its state keeps mvu-helper's root as it started:", e);
    }
});
eventSource.on(event_types.GENERATION_STARTED, (_type, _options, dryRun) => {
    if (dryRun) return;
    replyParses = new WeakMap();
});

eventSource.on(MVU_BEFORE_MESSAGE_UPDATE, async (context) => {
    try {
        const statData = context && context.variables && context.variables.stat_data;
        if (!statData || typeof statData !== 'object') return;
        // The event names no message: MVU fires it for the chat's last message, never the user's.
        const chat = getContext().chat;
        const mid = latestAiMessageId(chat);
        if (mid < 0) return;
        warnIfOwnPartsDropped(chat, mid);
        await runTasksOn(statData, { mid, isEngineCopy: false, copyLabel: "MVU's save" });
    } catch (e) {
        log.warn("the end-of-reply pass could not run on MVU's save — this reply's state keeps mvu-helper's root as it started:", e);
    }
});

/**
 * Run the end-of-reply pass again on reply `mid`'s saved state and save it, for a stage that changed the reply after
 * both copies of its state were saved; `reason` names that stage in the log. It waits for the turn's own work first
 * (RES1's run, its save included), so this save is the newer one. Nothing is saved when the reply was swiped,
 * regenerated or deleted meanwhile. Returns true when the saved state holds the pass's result; never throws.
 */
export async function runOwnStateOnSavedReply(mid, reason) {
    const chat = getContext().chat;
    const message = Array.isArray(chat) ? chat[mid] : null;
    if (!message) return false;
    const swipe = swipeOf(chat, mid);
    const isStillThisReply = () => getContext().chat === chat && chat[mid] === message && swipeOf(chat, mid) === swipe;
    try {
        await awaitTurnWork(mid, swipe);
        let isReplyGone = false;
        const isWritten = await rewriteOwnState(mid, async (statData) => {
            if (isStillThisReply()) await runTasksOn(statData, { mid, isEngineCopy: false, copyLabel: `its saved state, ${reason}` });
            isReplyGone = !isStillThisReply();
            return !isReplyGone;
        }, { writer: SAVED_REPLY_WRITER });
        if (isReplyGone) log.lifecycle(`msg ${mid}: swiped, regenerated or deleted before the end-of-reply pass ran again on its saved state (${reason}) — nothing written`);
        return isWritten;
    } catch (e) {
        log.warn(`msg ${mid}: the end-of-reply pass could not run again on its saved state (${reason}) — that state keeps mvu-helper's root as it was saved:`, e);
        return false;
    }
}

eventSource.on(RES_STAGED_EVENT, async (staged) => {
    try {
        if (!staged) return;
        const message = getContext().chat[staged.mid];
        const statData = stagedCopyToRun(staged, message ? replyParses.get(message) : null);
        if (!statData) return;
        await runTasksOn(statData, { mid: staged.mid, isEngineCopy: true, copyLabel: "the engine's staged state" });
    } catch (e) {
        log.warn("the end-of-reply pass could not run on the engine's staged state — the engine saves mvu-helper's root as it started:", e);
    }
});
