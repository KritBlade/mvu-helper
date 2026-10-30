// statusmenu-pack/statusmenu-engine-store.js — WHERE a card's StatusMenu Engine lives (§9.3).
//
// The exact analog of logic-engine-store.js, for the menu's code half: ONE self-contained JS text
// (formatters + actions, §9.5) in a SILENT worldbook entry [MVU_StatusMenuEngine] on the card's
// standalone book — enabled:false data carrier, never injected into a prompt. Storage only;
// evaluating the text into the shared Worker is the loader's job (G3.4), and installing it is
// statusmenu-pack-activation.js's.
//
// Two writers share this entry on purpose (§9.3): pack activation (engineOwned recorded in the
// registry) and the dev upload lane (edit in VS Code → upload → Worker reloads, no pack rebuild).
// Precedence is the standalone entry — a dev upload SHADOWS what the pack shipped, and re-activating
// the pack overwrites it back.

import { getStandaloneLorebookEntries, getEmbeddedCharBookEntries, upsertLorebookEntry, deleteLorebookEntriesByNeedle } from '../../sillytavern/lorebook.js';
import { createModuleLog } from '../../sillytavern/log.js';

const log = createModuleLog('statusmenu-pack');

export const MENU_ENGINE_ENTRY_COMMENT = '[MVU_StatusMenuEngine]';
export const MENU_ENGINE_ENTRY_MATCH = '[mvu_statusmenuengine]';   // comment substring, case-insensitive

// Read the card's menu-engine entry. Returns { text, found } — or null when the worldbook API/book is
// not ready yet (the tri-state the UI needs to tell "none installed" from "can't look yet").
export async function readMenuEngineCode() {
    const entries = await getStandaloneLorebookEntries();
    if (entries === null) return null;
    const entry = entries.find((e) => String(e.comment || '').toLowerCase().includes(MENU_ENGINE_ENTRY_MATCH));
    if (!entry) return { text: '', found: false };
    return { text: String(entry.content || ''), found: true };
}

// PROVISIONAL read from the card's EMBEDDED character_book — same load-order gap as the Logic
// Engine's (ST registers the standalone book AFTER CHAT_CHANGED), same staleness caveat: this is the
// import-time snapshot, and the standalone copy wins the moment it is readable.
export function readEmbeddedMenuEngineCode() {
    const entries = getEmbeddedCharBookEntries();
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const entry = entries.find((e) => String((e && e.comment) || '').toLowerCase().includes(MENU_ENGINE_ENTRY_MATCH));
    if (!entry) return { text: '', found: false };
    return { text: String(entry.content || ''), found: true };
}

// Install/replace the menu-engine entry (silent data carrier — upsertLorebookEntry writes
// enabled:false + keys:[], so the code text can never leak into a prompt).
export async function writeMenuEngineCode(text) {
    const res = await upsertLorebookEntry(MENU_ENGINE_ENTRY_MATCH, MENU_ENGINE_ENTRY_COMMENT, String(text || ''));
    if (!res) log.warn('could not write the StatusMenu Engine worldbook entry (book unavailable)');
    return res;
}

// Remove the menu-engine entry entirely. Returns the number of entries deleted.
export async function clearMenuEngineCode() {
    return deleteLorebookEntriesByNeedle(MENU_ENGINE_ENTRY_MATCH);
}
