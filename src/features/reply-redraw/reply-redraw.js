// reply-redraw/reply-redraw.js — the reply redraw: one write per finished reply per turn.
//
// After the narrator finishes a reply, the turn's later stages edit it: the engine after RES1 and RES2, the
// image pass, the stray </cast> removal, the POST receipt, the stat box. A write re-renders the reply (its
// status-menu frame and any TavernHelper frame are rebuilt), fires MESSAGE_UPDATED and saves the whole chat,
// so writing each edit on its own would flash the reply once per edit. Every stage hands its edit over here:
//   - while the reply's post-reply phase runs (small-llm opens a record in the first MESSAGE_RECEIVED listener
//     and the POST pass closes it when it ends — the last mvu-helper step of every generated reply), the swipe
//     mirror happens now and the render, the announcement and the save are owed; the phase's end writes once
//     for all of them;
//   - otherwise (no phase running for that take: a picture regenerate, an edit after the turn's write) the
//     edit is written on its own, now.
// A stage whose edit is still being made when the phase ends announces it first (announceReplyEdit): the close
// waits for it, and the record's deadline grows to the longest allowance announced. The owner may give its
// record a deadline, the longest its phase can legitimately run. A record still open then belongs to a stuck
// phase or a stuck edit: the owner reports it (onDeadline), what the record holds is written at once, and later
// edits on that reply write on their own. The phase itself stays open until it really ends.
// The owner marks the record when its phase reaches its end (noteReplyRedrawEnding: no LLM call is left, only
// its last steps). From then on, while no announced edit is still being made, the write is DUE: it comes within
// the owner's last steps. A reader that would redraw something inside the reply asks isReplyWriteDue and waits
// with dueReplyWriteEnded, since the write rebuilds the reply's DOM (the status menu's state push).
// Each stage changes `mes` in memory the moment it edits, so every reader of the text (POST, MVU,
// galgame-companion, harvest) reads the edit at once; only the render, the announcement and the save wait
// for the turn's end.
//
// Other extensions edit a finished reply through the same write (devdoc/reply-redraw-api.md): they hand an edit
// in (mvu_helper_reply_edit), or offer one at the last call that comes before every text write
// (mvu_helper_reply_last_call). Their edits run as one chain on the latest text, and the reply is written once.
// The four-step write is sillytavern/reply-text-write.js, and this file is its only caller
// (tests/reply-text-write-core.test.js). Rules for an edit: devdoc/editing-a-finished-reply.md. Decisions:
// reply-redraw-core.js.

import { eventSource } from '../../../../../../../script.js';
import { commitReplyTextEdit, saveReplyChat } from '../../sillytavern/reply-text-write.js';
import { chatContext } from '../../sillytavern/chat-context.js';
import { createModuleLog } from '../../sillytavern/log.js';
import {
    createRedrawRecord, findRedrawRecord, noteRedrawOwed, redrawWriteOf, isRedrawTakeLive,
    noteAnnouncedEdit, announcedEditsRunning, grownDeadlineAt, isRedrawWriteDue,
    replyEditProblem, holdHandIn, takeHandIns, queueReplyEdits, orderReplyEdits, prepareWithinWindow,
    runApplyChain, replyEditorsLine, resolveReplyAddress, locateReservedReply,
} from './reply-redraw-core.js';

const log = createModuleLog('reply-redraw');

// The two ways other extensions edit a finished reply (devdoc/reply-redraw-api.md). Public names: renaming one
// breaks every extension that uses it.
const EDIT_REQUEST_EVENT = 'mvu_helper_reply_edit';
const LAST_CALL_EVENT = 'mvu_helper_reply_last_call';
// The hard limit on a last call: listeners offering edits and every editor's prepare share it, so a reply never
// waits longer than this past the moment its write starts, however many extensions are installed.
const LAST_CALL_WINDOW_MS = 5000;

const openRecords = [];   // one per reply whose post-reply phase is running
const deadlines = new Map();   // record → { at, timer, onDeadline }, cleared when the record closes
const closeWaiters = new Map();   // record → the check its close is waiting on (announced edits)
const writesInFlight = new Map();   // record → its one write while it runs
const dueWriteWaiters = new Map();   // record → the readers waiting for its due write to end (dueReplyWriteEnded)

const swipeOfMessage = (message) => (message && message.swipe_id != null ? message.swipe_id : 0);

function liveChat() {
    const ctx = chatContext('reply-redraw');
    return { chatId: String((ctx && ctx.chatId) || ''), chat: ctx && Array.isArray(ctx.chat) ? ctx.chat : null };
}

function isTakeShowing(message, mid, swipe) {
    const { chat } = liveChat();
    const liveMessage = chat ? chat[mid] : null;
    return isRedrawTakeLive({ message, swipe }, { liveMessage, liveSwipe: swipeOfMessage(liveMessage) });
}

/**
 * Open the turn's record for one take of a reply. The caller closes it (closeReplyRedraw) when its phase
 * ends, on every exit: an edit owed to a record nobody closes is written only at its deadline.
 * @param {{deadlineMs?: number, onDeadline?: (report: {held: string[], running: string[], waitedMs: number}) => void}} [opts]
 *   the longest the phase can legitimately run; past it (or past the longest allowance an announced edit asked
 *   for), onDeadline is told which writers' edits are held and which announced edits are still running, and
 *   the held ones are written.
 */
export function openReplyRedraw(message, mid, swipe, { deadlineMs = 0, onDeadline = null } = {}) {
    const record = createRedrawRecord({ message, mid, swipe });
    record.openedAt = Date.now();
    openRecords.push(record);
    deadlines.set(record, { at: 0, timer: null, onDeadline });
    if (deadlineMs > 0) moveDeadline(record, grownDeadlineAt(0, record.openedAt, deadlineMs));
    return record;
}

function moveDeadline(record, at) {
    const deadline = deadlines.get(record);
    if (!deadline || at <= deadline.at) return;
    clearTimeout(deadline.timer);
    deadline.at = at;
    deadline.timer = setTimeout(() => { void writeAtDeadline(record); }, Math.max(0, at - Date.now()));
}

/**
 * Hand over an edit already made to `message.mes`. Written at the turn's end when a phase is running for
 * this take, otherwise now.
 * @param {string} label the writer's own name for itself; it lands in the turn's write and its failure lines
 */
export async function redrawReply(message, mid, label) {
    const record = findRedrawRecord(openRecords, { message, mid, swipe: swipeOfMessage(message) });
    if (!record) {
        log.domain('pipeline', 'lifecycle', `msg ${mid}: ${label} is written on its own (no turn is holding edits for this take)`);
        await writeReplyText(message, mid, label, [], { isOwed: true, moment: 'on its own' });
        return;
    }
    noteRedrawOwed(record, 'text', label);
    log.domain('pipeline', 'verbose', `msg ${mid}: ${label} is written at the turn's end`);
    // The stored swipe moves with `mes` now: a swipe away and back before the turn's end would otherwise
    // bring back the text from before the edit.
    await commitReplyTextEdit(message, mid, label, { render: false, save: false });
}

/** Hand over an edit outside the text (an image attached as media): only a save is owed. */
export async function saveRedrawnReply(message, mid, label) {
    const record = findRedrawRecord(openRecords, { message, mid, swipe: swipeOfMessage(message) });
    if (!record) {
        await saveReplyChat(label, mid);
        return;
    }
    noteRedrawOwed(record, 'save', label);
    log.domain('pipeline', 'verbose', `msg ${mid}: ${label} is saved at the turn's end`);
}

/**
 * Announce an edit still being made: `work` settles when the stage is done, whether or not it handed an edit
 * over. While a turn holds this take, its write waits for the work (up to `allowanceMs` from now, which grows
 * the record's deadline), and the edit, handed over with redrawReply before the work settles, joins the one
 * write. With no turn holding the take nothing waits, and the edit is written on its own when it comes.
 * Call it in the listener's synchronous part, before its first await: the turn can end at any await.
 * @returns {boolean} whether a turn's write now waits for it
 */
export function announceReplyEdit(message, mid, { label, work, allowanceMs }) {
    const record = findRedrawRecord(openRecords, { message, mid, swipe: swipeOfMessage(message) });
    if (!record) {
        log.domain('pipeline', 'verbose', `msg ${mid}: ${label} is not waited for (no turn is holding edits for this take); it is written on its own when it lands`);
        return false;
    }
    const entry = noteAnnouncedEdit(record, label);
    // The close now waits for this edit, so a write that was due no longer is: whoever waited for it goes on.
    releaseDueWriteWaiters(record);
    moveDeadline(record, grownDeadlineAt(deadlines.get(record)?.at, Date.now(), allowanceMs));
    log.domain('pipeline', 'verbose', `msg ${mid}: the turn's write waits for ${label} (up to ${Math.round((Number(allowanceMs) || 0) / 1000)}s)`);
    Promise.resolve(work)
        .catch((e) => log.warn(`msg ${mid}: ${label} (an edit the turn's write was waiting for) failed — the write no longer waits for it:`, e))
        .finally(() => {
            entry.isSettled = true;
            const check = closeWaiters.get(record);
            if (check) check();
        });
    return true;
}

/** Is the take the record covers still the one showing? The turn's write checks this right before it lands. */
export function isReplyRedrawLive(record) {
    return !!record && isTakeShowing(record.message, record.mid, record.swipe);
}

/**
 * The owner's phase has reached its end: no LLM call is left, only its last steps (its apply, the stat box)
 * and the edits already announced. From here the write is due whenever no announced edit is still being made.
 */
export function noteReplyRedrawEnding(record) {
    if (record) record.isEnding = true;
}

// The record of the showing take of message `mid`, open or writing now, or null.
function recordOfShowingTake(mid) {
    const { chat } = liveChat();
    const message = chat ? chat[mid] : null;
    const take = { message, mid, swipe: swipeOfMessage(message) };
    return findRedrawRecord(openRecords, take) || findRedrawRecord([...writesInFlight.keys()], take);
}

/** Is the turn's write about to re-render the showing take of message `mid` (isRedrawWriteDue)? */
export function isReplyWriteDue(mid) {
    const record = recordOfShowingTake(mid);
    return isRedrawWriteDue(record, { isWriting: writesInFlight.has(record) });
}

/**
 * Settles once the write due for message `mid` has ended, or once it is no longer due (an edit announced since
 * makes the close wait for it); at once when no write is due.
 */
export function dueReplyWriteEnded(mid) {
    const record = recordOfShowingTake(mid);
    if (!isRedrawWriteDue(record, { isWriting: writesInFlight.has(record) })) return Promise.resolve();
    return new Promise((resolve) => {
        if (!dueWriteWaiters.has(record)) dueWriteWaiters.set(record, []);
        dueWriteWaiters.get(record).push(resolve);
    });
}

// The write the readers waited for has ended, or is no longer due: each of them goes on.
function releaseDueWriteWaiters(record) {
    const waiting = dueWriteWaiters.get(record);
    if (!waiting) return;
    dueWriteWaiters.delete(record);
    for (const resolve of waiting) resolve();
}

/**
 * The turn's end: once every announced edit has landed (or the deadline passed), write once for every edit
 * handed over since the record opened. Never throws.
 */
export async function closeReplyRedraw(record) {
    await announcedEditsLanded(record);
    await writeAndClose(record, "at the turn's end");
}

// Resolves once no announced edit is running, or the record is gone (its deadline wrote it).
function announcedEditsLanded(record) {
    return new Promise((resolve) => {
        const check = () => {
            if (openRecords.includes(record) && announcedEditsRunning(record).length) return;
            closeWaiters.delete(record);
            resolve();
        };
        closeWaiters.set(record, check);
        check();
    });
}

// The deadline passed with the record still open: the owner's phase is stuck, or an edit it waits for is. Each
// says so (the owner knows what its own bound was made of), then what the record holds is written.
async function writeAtDeadline(record) {
    if (!openRecords.includes(record)) return;
    const running = announcedEditsRunning(record);
    const waitedMs = Date.now() - record.openedAt;
    if (running.length) {
        log.warn(`msg ${record.mid}: the turn's write waited ${Math.round(waitedMs / 1000)}s, the longest allowance announced, for ${running.join(', ')} — it is written now with what it holds (${record.labels.join(', ') || 'nothing yet'}), and ${running.join(', ')} is written on its own when it lands.`);
    }
    const { onDeadline } = deadlines.get(record) || {};
    if (onDeadline) {
        try { onDeadline({ held: record.labels.slice(), running, waitedMs }); }
        catch (e) { log.warn(`msg ${record.mid}: the deadline report threw (the held edits are still written):`, e); }
    }
    await writeAndClose(record, 'at its deadline');
}

// One write for everything the record holds, then the record is gone: an edit handed over after this —
// even while the write itself runs — is written on its own. `moment` names when, for the log line. A write
// already running for the record (its deadline's) is the one returned, so the turn's end waits for it.
function writeAndClose(record, moment) {
    if (writesInFlight.has(record)) return writesInFlight.get(record);
    const at = openRecords.indexOf(record);
    if (at === -1) return Promise.resolve();
    openRecords.splice(at, 1);
    const deadline = deadlines.get(record);
    if (deadline) clearTimeout(deadline.timer);
    deadlines.delete(record);
    const write = writeHeld(record, moment).finally(() => {
        writesInFlight.delete(record);
        releaseDueWriteWaiters(record);
    });
    writesInFlight.set(record, write);
    const waiting = closeWaiters.get(record);
    if (waiting) waiting();
    return write;
}

async function writeHeld(record, moment) {
    const handIns = takeHandIns(record);
    const write = redrawWriteOf(record);
    if (write.kind === 'none') {
        log.domain('pipeline', 'verbose', `msg ${record.mid}: nothing to write ${moment}`);
        return;
    }
    if (!isReplyRedrawLive(record)) {
        log.warn(`msg ${record.mid}: ${write.label} was NOT written ${moment} — this take is no longer showing (swiped away, regenerated or deleted). A swiped-away take keeps the edits in its stored text, and the next chat save keeps them.`);
        return;
    }
    if (write.kind === 'text') await writeReplyText(record.message, record.mid, write.label, handIns, { isOwed: true, moment });
    else await saveReplyChat(write.label, record.mid);
    log.domain('pipeline', 'lifecycle', `msg ${record.mid}: one ${write.kind === 'text' ? 'write' : 'save'} ${moment} for ${record.labels.join(', ')}`);
}

// ── every text write: the last call, the extensions' chain, then the four-step write ──
// `handIns` are the extensions' edits this write took. `isOwed`: mvu-helper's own edit is already in `mes`, so
// the write happens even when no extension changes anything.
async function writeReplyText(message, mid, label, handIns, { isOwed, moment }) {
    const swipe = swipeOfMessage(message);
    const { ordered, prepared, refused } = await collectReplyEdits(message, mid, swipe, handIns);
    if (!isTakeShowing(message, mid, swipe)) {
        log.warn(`msg ${mid}: ${label} was NOT written ${moment} — the take changed during the last call (swiped away, regenerated or deleted).`);
        return;
    }
    const ready = ordered.filter((_edit, i) => prepared[i].outcome === 'ready');
    const chain = runApplyChain(message.mes, ready);
    for (const r of chain.results) {
        if (r.outcome !== 'refused') continue;
        if (r.pending) Promise.resolve(r.pending).catch((e) => log.warn(`msg ${mid}: the Promise ${r.by}'s apply returned was rejected:`, e));
        log.warn(`msg ${mid}: ${r.by}'s edit was refused — ${r.reason}.`, ...(r.error ? [r.error] : []));
    }
    const isChanged = chain.text !== message.mes;
    if (isChanged) message.mes = chain.text;
    const applied = new Map(ready.map((edit, i) => [edit, chain.results[i]]));
    const results = [
        ...ordered.map((edit, i) => applied.get(edit) || { by: edit.by, stage: edit.stage, outcome: prepared[i].outcome }),
        ...refused,
    ];
    if (results.length) log.domain('pipeline', 'lifecycle', `msg ${mid}: extension edits ${moment} — ${replyEditorsLine(results)}`);
    if (isOwed || isChanged) await commitReplyTextEdit(message, mid, label);
}

// The last call and the window it opens: every listener may offer an edit until it returns or the window
// ends; then every queued editor's prepare runs at once inside what is left of the window. Resolves to the
// queue in apply order, each editor's prepare outcome, and the edits refused on the way in.
async function collectReplyEdits(message, mid, swipe, handIns) {
    const startedAt = Date.now();
    const offered = [];
    let isCollecting = true;
    const payload = {
        chat_id: liveChat().chatId,
        message_id: mid,
        swipe_id: swipe,
        edit: (edit) => {
            const problem = isCollecting ? replyEditProblem(edit) : 'the last call had already ended';
            if (problem) {
                log.warn(`msg ${mid}: an edit offered at the last call${edit && typeof edit.by === 'string' ? ` by ${edit.by}` : ''} was refused — ${problem}.`);
                return 'refused';
            }
            offered.push(edit);
            return 'queued';
        },
    };
    let timer = null;
    const windowEnds = new Promise((resolve) => { timer = setTimeout(resolve, LAST_CALL_WINDOW_MS); });
    try { await Promise.race([eventSource.emit(LAST_CALL_EVENT, payload), windowEnds]); }
    catch (e) { log.warn(`msg ${mid}: the last call's emit failed (the extensions' hand-ins still run):`, e); }
    clearTimeout(timer);
    isCollecting = false;
    const { queue, refused } = queueReplyEdits(handIns, offered);
    for (const r of refused) log.warn(`msg ${mid}: ${r.by}'s edit was refused — ${r.reason}.`);
    const ordered = orderReplyEdits(queue);
    const prepared = await prepareWithinWindow(ordered, message.mes, startedAt + LAST_CALL_WINDOW_MS - Date.now());
    ordered.forEach((edit, i) => {
        const { outcome, error } = prepared[i];
        if (outcome === 'cut-off') log.warn(`msg ${mid}: ${edit.by}'s prepare was still running ${LAST_CALL_WINDOW_MS / 1000}s after the last call began — cut off (its signal aborted); its edit is not in this write.`);
        else if (outcome === 'threw') log.warn(`msg ${mid}: ${edit.by}'s prepare threw — its edit is not in this write:`, error);
    });
    return { ordered, prepared, refused };
}

// ── the hand-in (mvu_helper_reply_edit) ──────────────────────────────────────
// An extension reserves a reply by naming it ({ chat_id, message_id, swipe_id }) and gets `handIn` on the same
// object; it calls handIn(edit) when its own work for the reply is done.
function onEditRequest(request) {
    if (!request || typeof request !== 'object') {
        log.warn(`${EDIT_REQUEST_EVENT} was emitted without a request object — nothing reserved.`);
        return;
    }
    const { chatId, chat } = liveChat();
    const found = resolveReplyAddress(request, { chatId, chat });
    if (found.problem) {
        log.warn(`an extension asked to edit a reply, and was refused — ${found.problem}. Every edit it hands in for that request is refused too.`);
        request.handIn = () => 'refused';
        return;
    }
    const reservation = { chatId, message: found.message, swipe: found.swipe };
    request.handIn = (edit) => handInEdit(reservation, edit);
}

// 'held' (a turn holds the take: the edit joins its write), 'written' (no turn holds it: written now, after a
// last call) or 'refused' (the warning says why).
function handInEdit(reservation, edit) {
    const problem = replyEditProblem(edit);
    if (problem) {
        log.warn(`a hand-in${edit && typeof edit.by === 'string' ? ` from ${edit.by}` : ''} was refused — ${problem}.`);
        return 'refused';
    }
    const where = locateReservedReply(reservation, liveChat());
    if (where.problem) {
        log.warn(`${edit.by}'s hand-in was refused — ${where.problem}.`);
        return 'refused';
    }
    const record = findRedrawRecord(openRecords, { message: reservation.message, mid: where.mid, swipe: reservation.swipe });
    if (record) {
        const replaced = holdHandIn(record, edit);
        noteRedrawOwed(record, 'text', `hand-in from ${edit.by}`);
        log.domain('pipeline', 'verbose', `msg ${where.mid}: ${edit.by}'s hand-in is written at the turn's end${replaced ? ' (it replaces the one handed in before)' : ''}`);
        return 'held';
    }
    log.domain('pipeline', 'lifecycle', `msg ${where.mid}: ${edit.by}'s hand-in is written on its own (no turn is holding edits for this take)`);
    writeReplyText(reservation.message, where.mid, `hand-in from ${edit.by}`, [edit], { isOwed: false, moment: 'on its own' })
        .catch((e) => log.warn(`msg ${where.mid}: writing ${edit.by}'s hand-in failed:`, e));
    return 'written';
}

if (eventSource) eventSource.on(EDIT_REQUEST_EVENT, onEditRequest);
