// reply-redraw/reply-redraw-core.js — PURE half of the reply redraw (no ST imports): which running turn an
// edit of a reply belongs to, what that turn's one write has to do, and the queue of other extensions'
// edits that join every write (devdoc/reply-redraw-api.md). Tested in tests/reply-redraw-core.test.js; the
// host half is reply-redraw.js.

// One record per reply whose post-reply phase is running: the message object, its index, the swipe the
// phase fenced, what the stages that edited it are owed, the edits still being made that its write waits
// for, the extensions' edits handed in for it, and whether its owner's phase has reached its end.
export function createRedrawRecord({ message, mid, swipe }) {
    return { message, mid, swipe, owesText: false, owesSave: false, labels: [], announced: [], handIns: [], isEnding: false };
}

// The open record an edit of `message` belongs to, or null. A record covers ONE take of one reply: the same
// message object, at the same index, showing the same swipe. A swipe (same object, another swipe_id) or a
// regenerate (another object at the same index) is a different take, and its edit is written on its own.
export function findRedrawRecord(records, { message, mid, swipe }) {
    if (!message || !Array.isArray(records)) return null;
    return records.find((r) => r.message === message && r.mid === mid && r.swipe === swipe) || null;
}

// What an edit leaves owed. 'text': the reply's text changed, so the turn's end renders, announces and saves.
// 'save': only something outside the text changed (an image attached as media), so only the save is owed.
// The label is the writer's own name; the turn's write lists every writer it carries, once each.
export function noteRedrawOwed(record, kind, label) {
    if (kind === 'text') record.owesText = true;
    else if (kind === 'save') record.owesSave = true;
    else throw new Error(`noteRedrawOwed: unknown kind "${kind}" (expected 'text' or 'save')`);
    const name = String(label || 'unlabelled writer');
    if (!record.labels.includes(name)) record.labels.push(name);
    return record;
}

// What the turn's end writes for a record: 'text' (the full write, which saves too), 'save' (the save
// alone) or 'none'. `label` names every writer the write carries.
export function redrawWriteOf(record) {
    const kind = !record ? 'none' : (record.owesText ? 'text' : (record.owesSave ? 'save' : 'none'));
    return { kind, label: kind === 'none' ? '' : `reply redraw (${record.labels.join(', ')})` };
}

// Is the take the record covers still the one showing? Checked right before the turn's write: the edits sit
// in the record's take, and writing them while another take shows would render and save that take instead.
export function isRedrawTakeLive(record, { liveMessage, liveSwipe }) {
    return !!record && liveMessage === record.message && liveSwipe === record.swipe;
}

// ── edits still being made (W1) ───────────────────────────────────────────────
// A stage that will hand an edit over later announces it first, and the record's close waits for it. The
// entry is settled once the stage's work has ended, whether or not it handed an edit over.
export function noteAnnouncedEdit(record, label) {
    const entry = { label: String(label || 'unlabelled writer'), isSettled: false };
    record.announced.push(entry);
    return entry;
}

// The labels of the announced edits the record's close still waits for.
export function announcedEditsRunning(record) {
    return record ? record.announced.filter((e) => !e.isSettled).map((e) => e.label) : [];
}

// The record's deadline once an edit that may take `allowanceMs` is announced at `nowMs`: it only ever grows,
// so the longest announced allowance bounds the wait. 0 = no deadline yet.
export function grownDeadlineAt(deadlineAt, nowMs, allowanceMs) {
    const wanted = nowMs + Math.max(0, Number(allowanceMs) || 0);
    return Math.max(Number(deadlineAt) || 0, wanted);
}

// ── the write that is due ─────────────────────────────────────────────────────
// Is the record's write about to happen? It is running now, or the owner's phase has reached its end and no
// announced edit is still being made, so only the owner's last steps stand before it. A write waiting on an
// announced edit is not due: that edit (a picture still drawing) may take minutes.
export function isRedrawWriteDue(record, { isWriting = false } = {}) {
    if (!record) return false;
    return isWriting === true || (record.isEnding === true && announcedEditsRunning(record).length === 0);
}

// ── other extensions' edits (devdoc/reply-redraw-api.md) ────────────────────────
// content runs first (it changes what the reply says), presentation last (it reshapes the text for one display
// and has to see every word).
const STAGE_RANK = { content: 0, presentation: 1 };

// Why an edit is refused, or '' when it is well formed. Checked on every hand-in and every last-call offer.
export function replyEditProblem(edit) {
    if (!edit || typeof edit !== 'object') return 'the edit is not an object';
    if (typeof edit.by !== 'string' || !edit.by.trim()) return 'it has no `by` name';
    if (!Object.hasOwn(STAGE_RANK, edit.stage)) return `its stage "${String(edit.stage)}" is neither "content" nor "presentation"`;
    if (typeof edit.apply !== 'function') return 'it has no apply(text) function';
    if (edit.prepare != null && typeof edit.prepare !== 'function') return 'its prepare is not a function';
    return '';
}

// A hand-in held on the record: one per extension, a newer one from the same `by` replacing the older.
// Returns true when it replaced one.
export function holdHandIn(record, edit) {
    const at = record.handIns.findIndex((e) => e.by === edit.by);
    if (at === -1) record.handIns.push(edit);
    else record.handIns[at] = edit;
    return at !== -1;
}

// The record's held hand-ins, taken for one write: the record keeps none, so no write applies one twice.
export function takeHandIns(record) {
    return record.handIns.splice(0, record.handIns.length);
}

// One write's queue: the hand-ins it took, then what was offered at its last call. One edit per extension
// per write: a second one from the same `by` is refused.
export function queueReplyEdits(handIns, offered) {
    const queue = [];
    const refused = [];
    for (const edit of [...handIns, ...offered]) {
        if (queue.some((e) => e.by === edit.by)) refused.push({ by: edit.by, stage: edit.stage, outcome: 'refused', reason: 'it is the second edit from this extension in one write (combine them into one)' });
        else queue.push(edit);
    }
    return { queue, refused };
}

// Code-point order, so every install orders the same names the same way whatever its locale.
function compareCodePoints(a, b) {
    const x = [...a];
    const y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = x[i].codePointAt(0) - y[i].codePointAt(0);
        if (d) return d;
    }
    return x.length - y.length;
}

// The order the apply chain runs in: content before presentation, and within a stage by `by` name.
// Listener order is never used: it follows extension load order, which differs between installs.
export function orderReplyEdits(edits) {
    return edits.slice().sort((a, b) => (STAGE_RANK[a.stage] - STAGE_RANK[b.stage]) || compareCodePoints(a.by, b.by));
}

// Every editor's prepare at once, each on the same text, until all have settled or `msLeft` runs out. An
// editor without one is ready at once. Resolves to one entry per editor, in order: 'ready', 'cut-off' (still
// running when the window ended; its signal is aborted) or 'threw' (with the error).
export async function prepareWithinWindow(edits, text, msLeft) {
    const outcomes = edits.map((edit) => ({ outcome: typeof edit.prepare === 'function' ? 'running' : 'ready' }));
    const controllers = edits.map(() => new AbortController());
    const runs = edits.map((edit, i) => {
        if (outcomes[i].outcome !== 'running') return null;
        return Promise.resolve()
            .then(() => edit.prepare(text, { signal: controllers[i].signal }))
            .then(() => { if (outcomes[i].outcome === 'running') outcomes[i] = { outcome: 'ready' }; },
                (error) => { if (outcomes[i].outcome === 'running') outcomes[i] = { outcome: 'threw', error }; });
    }).filter(Boolean);
    if (runs.length) {
        let timer = null;
        const windowEnds = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, msLeft)); });
        await Promise.race([Promise.all(runs), windowEnds]);
        clearTimeout(timer);
    }
    outcomes.forEach((o, i) => {
        if (o.outcome !== 'running') return;
        outcomes[i] = { outcome: 'cut-off' };
        controllers[i].abort();
    });
    return outcomes;
}

// The apply chain: each editor gets the text the one before it returned. apply is synchronous, so nothing else
// can change the text between two editors. A throw, a Promise or anything that is not a string refuses that
// editor, and the next one gets the text it was given. Returns the final text and one result per editor.
export function runApplyChain(text, edits) {
    let current = String(text == null ? '' : text);
    const results = [];
    for (const edit of edits) {
        const named = { by: edit.by, stage: edit.stage };
        let out;
        try { out = edit.apply(current); }
        catch (error) {
            results.push({ ...named, outcome: 'refused', reason: 'apply threw', error });
            continue;
        }
        if (out != null && typeof out.then === 'function') {
            results.push({ ...named, outcome: 'refused', reason: 'apply returned a Promise (apply must be synchronous: put slow work in prepare)', pending: out });
            continue;
        }
        if (typeof out !== 'string') {
            results.push({ ...named, outcome: 'refused', reason: `apply returned ${out === null ? 'null' : typeof out}, not the text` });
            continue;
        }
        results.push({ ...named, outcome: out === current ? 'unchanged' : 'changed', delta: out.length - current.length });
        current = out;
    }
    return { text: current, results };
}

// One line for a write: every editor in order with what became of it.
export function replyEditorsLine(results) {
    return results.map((r) => {
        const who = `${r.by} (${r.stage})`;
        if (r.outcome === 'changed') return `${who} changed ${r.delta >= 0 ? '+' : ''}${r.delta}`;
        if (r.outcome === 'cut-off') return `${who} cut off at the window's end`;
        if (r.outcome === 'threw') return `${who} dropped: prepare threw`;
        if (r.outcome === 'refused') return `${who} refused: ${r.reason}`;
        return `${who} ${r.outcome}`;
    }).join(' · ');
}

// ── naming the reply (B4, Q5) ─────────────────────────────────────────────────
// The reply an extension's request names, or why it names none. Checked once, when the extension reserves the
// reply; from then on mvu-helper follows the message itself (locateReservedReply).
export function resolveReplyAddress(request, { chatId, chat }) {
    if (!request || typeof request !== 'object') return { problem: 'the request is not an object' };
    const { chat_id: requestChat, message_id: mid, swipe_id: swipe } = request;
    if (requestChat == null || String(requestChat) !== String(chatId)) return { problem: `it names chat "${requestChat}", but chat "${chatId}" is open` };
    if (!Number.isInteger(mid) || mid < 0) return { problem: `message_id ${mid} is not a message index` };
    const message = Array.isArray(chat) ? chat[mid] : null;
    if (!message) return { problem: `there is no message ${mid}` };
    if (message.is_user) return { problem: `message ${mid} is the user's, not a reply` };
    const showing = message.swipe_id != null ? message.swipe_id : 0;
    if (!Number.isInteger(swipe) || swipe !== showing) return { problem: `swipe ${swipe} of message ${mid} is not the one showing (swipe ${showing} is)` };
    return { message, mid, swipe };
}

// Where a reserved reply is now, or why it can no longer be edited. Found by the message object, so a message
// deleted above it moves its index without losing it, and a regenerate (a new object), a swipe or a chat switch
// is told apart exactly.
export function locateReservedReply(reservation, { chatId, chat }) {
    if (String(chatId) !== String(reservation.chatId)) return { problem: 'another chat is open now' };
    const mid = Array.isArray(chat) ? chat.indexOf(reservation.message) : -1;
    if (mid === -1) return { problem: 'the reply is gone (regenerated or deleted)' };
    const showing = reservation.message.swipe_id != null ? reservation.message.swipe_id : 0;
    if (showing !== reservation.swipe) return { problem: `another swipe of it is showing (swipe ${showing}; the edit was for swipe ${reservation.swipe})` };
    return { mid };
}
