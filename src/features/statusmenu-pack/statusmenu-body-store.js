// statusmenu-pack/statusmenu-body-store.js — WHERE a card's lifted menu documents live
// (plans/executed/statusmenu-containment.md M2, D8).
//
// The analog of statusmenu-engine-store.js for the menu's DISPLAY half, one entry PER LIFTED ROW:
// the shipped regex row's `replace_string` VERBATIM — container, markers, and the one fenced
// document — in a SILENT worldbook entry `[MVU_StatusMenuBody:<row script_name>]` on the card's
// standalone book (enabled:false data carrier, never injected into a prompt). A pack may ship several
// wrapped rows (School ships a game-start form beside the menu); each is its own entry, and each
// mounts on its own. The row written to the card is the marker form with no fence, so TavernHelper has
// nothing to render; the contained frame unwraps the fence out of THIS text at mount, and the release
// export puts this text back into the row byte for byte.
//
// Verbatim rather than the bare document, on purpose: the export contract is "card bytes only", and a
// stored fragment would have to be re-wrapped by code that must then match the builder's spelling
// forever. The text that came in is the text that goes out.
//
// ONE writer: pack activation (liftedRows recorded in the registry). There is no dev upload lane for a
// body — the documents are generated (the builder's) or authored in the workspace, and change by
// re-apply, never by editing the entry.

import { getStandaloneLorebookEntries, getEmbeddedCharBookEntries, upsertLorebookEntry, deleteLorebookEntriesByNeedle } from '../../sillytavern/lorebook.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { MENU_BODY_ENTRY_PREFIX, menuBodyComment, menuBodyRowName } from './statusmenu-pack-core.js';

const log = createModuleLog('statusmenu-pack');

// The comment substring every body entry carries, lower-cased — the needle the sweep and the reads use.
export const MENU_BODY_ENTRY_MATCH = MENU_BODY_ENTRY_PREFIX.toLowerCase();

function bodiesFrom(entries) {
    const bodies = {};
    for (const e of (Array.isArray(entries) ? entries : [])) {
        const row = menuBodyRowName(e && e.comment);
        if (row) bodies[row] = String((e && e.content) || '');
    }
    return bodies;
}

// Every lifted document on the card, by row name: { [rowName]: text } — or null when the worldbook
// API/book is not ready yet (the tri-state the mount and the export need to tell "none installed"
// from "can't look yet"). An empty object means the card has no lifted rows.
export async function readMenuBodies() {
    const entries = await getStandaloneLorebookEntries();
    if (entries === null) return null;
    return bodiesFrom(entries);
}

// PROVISIONAL read from the card's EMBEDDED character_book — same load-order gap as the engine's (ST
// registers the standalone book AFTER CHAT_CHANGED), same staleness caveat: the import-time snapshot,
// and the standalone copy wins the moment it is readable. null when the card has no embedded book.
export function readEmbeddedMenuBodies() {
    const entries = getEmbeddedCharBookEntries();
    if (!Array.isArray(entries) || entries.length === 0) return null;
    return bodiesFrom(entries);
}

// Install/replace ONE row's body entry (silent data carrier — upsertLorebookEntry writes enabled:false
// + keys:[], so the document can never leak into a prompt). Returns the upsert result ({ changed }
// says whether the text MOVED) or null when the book is unavailable.
export async function writeMenuBody(rowName, text) {
    const comment = menuBodyComment(rowName);
    const res = await upsertLorebookEntry(comment.toLowerCase(), comment, String(text || ''));
    if (!res) log.warn('could not write the ' + comment + ' worldbook entry (book unavailable)');
    return res;
}

// Remove EVERY body entry on the card. Returns the number of entries deleted. The whole set goes at
// once because the registry's liftedRows is the record and an uninstall or a no-document version
// replaces the set, never one member of it.
export async function clearMenuBodies() {
    return deleteLorebookEntriesByNeedle(MENU_BODY_ENTRY_MATCH);
}
