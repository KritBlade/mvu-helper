// character-roster/worn-outfit-edits.js — edits of the worn-outfit store (stat_data.$mvuhelper.worn_outfit: what each
// character wears now) made outside a reply's pictures (plans/reply-cast.md §11). The edit kinds and their application
// are dna-core.js's (applyWornOutfitEdits); this half writes them through MVU's save door and logs:
//   • clothes the harvest saved from the newest reply are held by the outfit's name (D37, nameKeptOutfitsInWornStore);
//   • the Roster editor's "Wearing now" line (D38, readWearingNow / setWearingNow).
//
// THE NEWEST REPLY'S JOURNAL. An edit made while a reply is the chat's newest joins that reply's journal (its message
// and swipe) and is written at once into the saved states it belongs in. wornOutfitEditJournalTask, an own-state task
// run right after the store's own write (src/index.js), applies the journal to every copy of the reply's state saved
// later — a continue, MVU's reprocess, a turn engine's staged copy — so the store worked out from the reply's pictures
// never undoes it. A regenerate or a new reply starts a new journal, and a chat change ends it. The journal lives in
// memory: after a reload a continue works the newest reply's store out from its text again.

import { createModuleLog } from '../../sillytavern/log.js';
import { chatMessages } from '../../sillytavern/chat-context.js';
import { rewriteOwnStatPart } from '../../sillytavern/mvu-bridge.js';
import { ownStatPart, setOwnStatPart, storedStatDataOf, stateBefore } from '../../sillytavern/mvu-bridge-core.js';
import { latestAiMessageId, swipeOf } from '../../shared/latest-reply.js';
import { tailMessagesCarryingVariables } from '../../shared/generation-floor.js';
import { createSerialQueue } from '../../shared/serial-queue.js';
import { isRegistryEditable } from './character-registry.js';
import { newJournal, isJournalOf } from './character-registry-core.js';
import {
    WORN_OUTFIT_PART, OUTFIT_NEW_CLOTHES, wornOutfitOn, applyWornOutfitEdits, wornOutfitSet, wornOutfitCleared, wornOutfitKeptByName,
    wornOutfitEditTargets, keptOutfitFinding,
} from './dna-core.js';

const log = createModuleLog('character-roster');

const SAVE_WRITER = 'worn-outfit edit';

let journal = null;   // the newest reply's edits: { message, swipe, changes }

// One write at a time: each reads a state and saves it back (shared/serial-queue.js).
const serialized = createSerialQueue();

function currentChat() {
    return chatMessages('character-roster');
}

const sameStore = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

// The store with `edits` applied, or the store itself when they change nothing, so a state that holds no store is not
// handed an empty one.
function editedStore(worn, edits) {
    const next = applyWornOutfitEdits(worn, edits);
    return sameStore(worn, next) ? worn : next;
}

// The journal of the chat's newest reply on the swipe it shows, started when it has none; null while the chat holds no
// reply.
function journalOfNewestReply(chat) {
    const mid = latestAiMessageId(chat);
    if (mid < 0) return null;
    const message = chat[mid];
    const swipe = swipeOf(chat, mid);
    if (!isJournalOf(journal, message, swipe)) journal = newJournal(message, swipe);
    return journal;
}

// The store in the newest saved state; undefined when no message holds a state.
function newestStore(chat) {
    const newest = stateBefore(chat, chat.length);
    return newest ? ownStatPart(newest.statData, WORN_OUTFIT_PART) : undefined;
}

// Write `edits` into each message of `targets` that holds a saved state, through the save door. True when every one
// holds them afterwards (saved, or holding them already). The chat can move on while a save is awaited: a state that
// is no longer this chat's is left alone.
async function writeEdits(chat, targets, edits) {
    let isWritten = true;
    for (const index of targets) {
        if (currentChat() !== chat) {
            log.child('worn-outfit').warn('the chat changed while what a character wears was being saved — the rest was not written');
            return false;
        }
        if (!storedStatDataOf(chat[index])) continue;
        try {
            if (!(await rewriteOwnStatPart(index, WORN_OUTFIT_PART, (worn) => editedStore(worn, edits), { writer: SAVE_WRITER }))) isWritten = false;
        } catch (e) {
            log.child('worn-outfit').error(`saving what a character wears into msg ${index}'s state failed:`, e);
            isWritten = false;
        }
    }
    return isWritten;
}

const describeWear = (value) => (!value ? 'nothing recorded' : value.outfit === OUTFIT_NEW_CLOTHES ? `one-off "${value.clothes}"` : value.outfit);

// ── "Wearing now" (D38) ───────────────────────────────────────────────────────
// What `key` wears now: her entry in the newest saved state's store, { outfit, clothes, lastPictureMessage }, or null
// when it holds nothing for her.
export function readWearingNow(key) {
    return wornOutfitOn(newestStore(currentChat()), key);
}

// Save "Wearing now": `value` is { outfit, clothes } or null (nothing recorded). Written into every saved state from her
// last picture's message to the newest and into every state a new generation can start from (wornOutfitEditTargets),
// and into the newest reply's journal. Refused while a reply is being generated: the reply in flight would overwrite
// it. Returns { ok, reason? }.
export async function setWearingNow(key, value) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return { ok: false, reason: 'empty key' };
    if (!isRegistryEditable()) {
        log.child('worn-outfit').warn(`a reply is being generated — what "${cleanKey}" wears was not saved; try again when the reply has finished`);
        return { ok: false, reason: 'a reply is being generated' };
    }
    return serialized(async () => {
        const chat = currentChat();
        const held = wornOutfitOn(newestStore(chat), cleanKey);
        const mid = latestAiMessageId(chat);
        const edit = value ? wornOutfitSet(cleanKey, value.outfit, value.clothes, mid >= 0 ? mid : null) : wornOutfitCleared(cleanKey);
        const stateIndices = chat.map((message, index) => (storedStatDataOf(message) ? index : -1)).filter((index) => index >= 0);
        const targets = wornOutfitEditTargets({ stateIndices, lastPictureMessage: held ? held.lastPictureMessage : null, generationFloors: tailMessagesCarryingVariables(chat, 2) });
        if (!targets.length) return { ok: false, reason: 'no message in this chat holds MVU state yet' };
        const own = journalOfNewestReply(chat);
        if (own) own.changes.push(edit);
        const isWritten = await writeEdits(chat, targets, [edit]);
        log.child('worn-outfit').lifecycle(`"${cleanKey}" wears ${describeWear(value)} now — written into msg ${targets.join(', ')}`);
        return isWritten ? { ok: true } : { ok: false, reason: 'not every saved state could be written (see console)' };
    });
}

// ── clothes the harvest saved, held by name (D37) ────────────────────────────
// One kept outfit against what she wears, for the log (dna-core keptOutfitFinding).
function describeKeptFinding(item, { finding, held }) {
    const label = `"${item.key}" [${item.outfit}]`;
    if (finding === 'held') return `${label} held by name`;
    if (finding === 'other-clothes') return `${label} not held: she wears a one-off with other clothes, "${held}"`;
    if (finding === 'outfit') return `${label} not held: she wears [${held}]`;
    return `${label} not held: nothing recorded for her`;
}

// `kept` is [{ key, names, outfit, clothes }]: clothes the harvest wrote into a record from the newest reply's records.
// Each becomes an edit of that reply's store — the one-off holding exactly those clothes is held by the outfit's name —
// in its journal and, when MVU has saved the reply's state, in that state at once; the log says, against that state,
// which each one holds. Never throws: a failure is logged, and the copies the journal reaches still take the edit.
export async function nameKeptOutfitsInWornStore(kept) {
    const items = (Array.isArray(kept) ? kept : []).filter((item) => item && String(item.outfit || '').trim() && String(item.clothes || '').trim());
    if (!items.length) return;
    try {
        await serialized(async () => {
            const chat = currentChat();
            const own = journalOfNewestReply(chat);
            if (!own) return;
            const mid = latestAiMessageId(chat);
            const edits = items.map((item) => wornOutfitKeptByName(item.names, item.outfit, item.clothes));
            own.changes.push(...edits);
            const saved = storedStatDataOf(chat[mid]);
            log.child('worn-outfit').domain('roster', 'verbose', saved
                ? `msg ${mid}: outfits saved from this reply, against what each wears — `
                    + items.map((item, index) => describeKeptFinding(item, keptOutfitFinding(ownStatPart(saved, WORN_OUTFIT_PART), edits[index]))).join('; ')
                : `msg ${mid}: outfits saved from this reply — ${items.map((item) => `"${item.key}" [${item.outfit}]`).join(', ')}; its state is not saved yet, `
                    + 'so what each wears takes them by name when it is, wherever it copied the same clothes');
            await writeEdits(chat, [mid], edits);
        });
    } catch (e) {
        log.child('worn-outfit').warn('could not hold the outfits the harvest saved by name in what each character wears — the store keeps its copy of their clothes:', e);
    }
}

// ── the journal into each saved copy ─────────────────────────────────────────
// An own-state task (own-state registerOwnStateTask, src/index.js), registered right after the store's own write: the
// newest reply's edits applied to the copy of its state being saved.
export const wornOutfitEditJournalTask = {
    name: 'worn-outfit edits',
    run(statData, { mid, copyLabel }) {
        const chat = currentChat();
        if (!isJournalOf(journal, chat[mid], swipeOf(chat, mid)) || !journal.changes.length) return;
        const before = ownStatPart(statData, WORN_OUTFIT_PART);
        const after = editedStore(before, journal.changes);
        if (after === before) return;
        setOwnStatPart(statData, WORN_OUTFIT_PART, after);
        log.domain('roster', 'verbose', `msg ${mid} (${copyLabel}): ${WORN_OUTFIT_PART}: ${journal.changes.length} edit(s) from this reply applied`);
    },
};

// A chat change ends the journal.
export function resetWornOutfitEditsForChat() {
    journal = null;
}
