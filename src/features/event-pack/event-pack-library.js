// event-pack/event-pack-library.js — the EVENT-PACK layer over the shared artifact library (§4b).
//
// WHY THIS EXISTS (the second survival defect, phase GE): before this file, a pasted event pack was
// written straight into the CARD's worldbook and nowhere else. The dev loop of "rebuild the card,
// delete the old card + its book, import the new one" recreates that book from the card's EMBEDDED
// snapshot, which cannot contain tab-installed entries — so every installed pack, and the registry
// recording them, vanished with the card. The only surviving copy was the file on the user's disk,
// which is why event-pack looked like it needed a re-import "on every new chat" (§12a.1: the
// fresh-chat reconcile was never the fault).
//
// The library book is ROOT-LEVEL and never bound to a character, so it survives the card entirely.
// After a card rebuild the packs are still there and come back by RE-INSTALLING FROM THE LIBRARY —
// re-activating is not re-importing.
//
// WHAT IS STORED: one entry per pack, id = the packId, content = that pack's OWN `entryContent` —
// the canonical single-pack text (block + its gated bodies) that parseUploadFile reads back
// identically. NOT the upload file: a multi-pack file is N artifacts, and storing the whole file
// under each id would hand every pack the others' JSON on reinstall.

import {
    writeLibraryEntry,
    readLibraryEntry,
    listLibraryEntries,
    deleteLibraryEntry,
} from '../../shared/card-artifact-library.js';
import { parseUploadFile } from './event-pack-core.js';
import { createModuleLog } from '../../sillytavern/log.js';

const log = createModuleLog('event-pack');

const ARTIFACT_TYPE = 'eventpack';

// Store ONE pack's canonical text. Returns { ok, created, error }.
async function storeEventPack(packId, entryContent) {
    return writeLibraryEntry(ARTIFACT_TYPE, packId, String(entryContent || ''));
}

// One pack's stored text, or null when absent/unreadable.
export async function readStoredEventPack(packId) {
    return readLibraryEntry(ARTIFACT_TYPE, packId);
}

// Drop one pack from the library. Copies INSTALLED on cards keep working (§4) — their registry
// records are untouched; the tab's row says "No library copy" to say the source is gone.
export async function deleteStoredEventPack(packId) {
    return deleteLibraryEntry(ARTIFACT_TYPE, packId);
}

// Every event pack in the library as { id, text, version, events, parseError }.
// A stored file that no longer parses is STILL listed (parseError set) — hiding it would make a
// corrupted entry undeletable from the UI, the same rule the pack library follows.
// null = the book could not be read at all; [] = readable, no event packs stored.
export async function listStoredEventPacks() {
    const stored = await listLibraryEntries();
    if (stored === null) return null;
    const out = [];
    for (const record of stored) {
        if (record.packType !== ARTIFACT_TYPE) continue;   // pack files share the book, not the format
        const parsed = parseUploadFile(record.text);
        const pack = parsed.packs[0] || null;
        out.push({
            id: record.id,
            text: record.text,
            version: pack ? String(pack.version || '') : '',
            events: pack && pack.triggers && typeof pack.triggers === 'object' ? Object.keys(pack.triggers).length : 0,
            parseError: pack ? '' : (parsed.errors[0] ? parsed.errors[0].error : 'no <mvueventpack> block'),
        });
    }
    return out;
}

// Mirror the packs an install just wrote into the library, so they survive the card. Called AFTER the
// card writes succeeded, and deliberately NOT able to fail the install: the card copy is what makes
// the pack play, the library copy is what makes it recoverable. A failure here is surfaced (never
// swallowed) and named for what it costs — you keep the working pack, you lose the safety net.
// Returns { stored: [ids], failed: [{ id, error }] }.
export async function mirrorInstalledPacks(packs) {
    const out = { stored: [], failed: [] };
    for (const pack of (packs || [])) {
        const res = await storeEventPack(pack.packId, pack.entryContent);
        if (res.ok) out.stored.push(pack.packId);
        else out.failed.push({ id: pack.packId, error: res.error });
    }
    if (out.stored.length) log.lifecycle('library copy stored: ' + out.stored.join(', ') + ' (survives a card rebuild — §4b)');
    for (const f of out.failed) {
        log.warn('' + f.id + ' installed on this card but NOT stored in the library: ' + f.error
            + ' — it will be gone if the card is rebuilt; keep the source file.');
    }
    return out;
}
