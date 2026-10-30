// logic-engine/logic-engine-store.js — WHERE a card's LogicEngine lives (LOGIC_ENGINE_PLAN R0).
//
// The LogicEngine is a card-authored resolver (e.g. School v4's globalLogic.cjs, wired together
// with its i18n/eventpack preludes into ONE self-contained JS text) that mvu-helper hosts on the
// MAIN page — replacing the card-baked stat-menu-iframe resolver. This module owns storage only;
// executing the code is logic-engine-loader.js.
//
// Two halves, two scopes (§10 storage decision, 2026-07-27):
//   • FLAGS — the settings PROFILE (per card, tiny): just `enabled`. Cheap to read every turn,
//     harmless in settings.json.
//   • CODE — the uploaded engine text (~150 KB for School v4) lives in a SILENT worldbook entry
//     [MVU_LogicEngine] on the card's primary lorebook (enabled:false data carrier, like
//     [InitVar]/[Initmvuhelper] — ST never injects it into a prompt), NOT in the settings blob:
//     ST round-trips settings.json on every debounced save, and a 150 KB blob per card would ride
//     every one of them. The worldbook entry is per-card by construction, survives across chats,
//     and a card can even SHIP its engine pre-installed (the event-pack precedent).

import { getProfile } from '../../sillytavern/settings-store.js';
import { getStandaloneLorebookEntries, getEmbeddedCharBookEntries, upsertLorebookEntry, deleteLorebookEntriesByNeedle } from '../../sillytavern/lorebook.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { logicEngineProfileOf } from './logic-engine-core.js';
import { storyEnvelopeOf } from './turn-runner-core.js';

const log = createModuleLog('logic-engine');

export const ENGINE_ENTRY_COMMENT = '[MVU_LogicEngine]';
export const ENGINE_ENTRY_MATCH = '[mvu_logicengine]';   // comment substring, case-insensitive (event-pack convention)

// This card's LogicEngine flags; the template and the repair are logic-engine-core.js.
export function getLogicEngineProfile() {
    return logicEngineProfileOf(getProfile());
}

// The opening tags of this card's story block ([Initmvuhelper] leadText), null while it names none: where the
// engine's lead text goes (turn-runner-core storyEnvelopeOf).
export function getStoryEnvelope() {
    return storyEnvelopeOf(getProfile());
}

// Read the card's engine entry. Returns { text, found } — or null when the worldbook API/book
// is not ready yet (same tri-state as getStandaloneLorebookEntries, so the UI can tell
// "no engine installed" from "can't look yet").
export async function readEngineCode() {
    const entries = await getStandaloneLorebookEntries();
    if (entries === null) return null;
    const entry = entries.find((e) => String(e.comment || '').toLowerCase().includes(ENGINE_ENTRY_MATCH));
    if (!entry) return { text: '', found: false };
    return { text: String(entry.content || ''), found: true };
}

// PROVISIONAL read from the card's EMBEDDED character_book — available the instant the character is
// selected, which is what makes it the only source that can answer during CHAT_CHANGED.
//
// WHY IT EXISTS: readEngineCode above is standalone-only by design, and ST registers the standalone
// worldbook AFTER CHAT_CHANGED. The card's [PRE] <Initiative_Menu> / <Event_Candidates> entries render
// inside that gap, so a standalone-only loader leaves them with no engine on every chat load — the
// live symptom on 2026-07-29.
//
// IT IS THE IMPORT-TIME SNAPSHOT and can be STALE: installing a newer engine through the LogicEngine
// tab writes to the STANDALONE book only, leaving the card's baked copy behind. So this is never the
// final answer — the loader marks anything from here source:'embedded' and re-checks the standalone
// copy at the next opportunity, swapping if the text differs. Returns the same { text, found } shape
// as readEngineCode, or null when there is no embedded book at all.
export function readEmbeddedEngineCode() {
    const entries = getEmbeddedCharBookEntries();
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const entry = entries.find((e) => String((e && e.comment) || '').toLowerCase().includes(ENGINE_ENTRY_MATCH));
    if (!entry) return { text: '', found: false };
    return { text: String(entry.content || ''), found: true };
}

// Install/replace the engine entry (silent data carrier — upsertLorebookEntry writes
// enabled:false + keys:[], so the code text can never leak into a prompt).
export async function writeEngineCode(text) {
    const res = await upsertLorebookEntry(ENGINE_ENTRY_MATCH, ENGINE_ENTRY_COMMENT, String(text || ''));
    if (!res) log.warn('could not write the engine worldbook entry (book unavailable)');
    return res;
}

// Remove the engine entry entirely. Returns the number of entries deleted.
export async function clearEngineCode() {
    return deleteLorebookEntriesByNeedle(ENGINE_ENTRY_MATCH);
}
