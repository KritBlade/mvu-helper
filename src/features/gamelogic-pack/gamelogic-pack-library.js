// gamelogic-pack/gamelogic-pack-library.js — the PACK-FILE layer over the shared artifact library:
// judge, then store the file text verbatim; list, parsed enough to show a pack row.
//
// The library book itself, its naming and its four I/O operations live in shared/card-artifact-library.js
// (event-pack stores its own files there too). What is here is the pack-file knowledge: WHICH text is
// allowed in (judgePackFile) and HOW a stored file reads back as a listing row (parsePackFile).

import {
    writeLibraryEntry,
    readLibraryEntry,
    listLibraryEntries,
    deleteLibraryEntry,
} from '../../shared/card-artifact-library.js';
import { createModuleLog } from '../../sillytavern/log.js';
import {
    libraryEntryComment,
    parsePackFile,
    judgePackFile,
} from './gamelogic-pack-core.js';
import { readMenuEngineExportsInWorker } from '../logic-engine/index.js';
import { storeEventPacksInLibrary, eventPackArtifactTexts } from '../event-pack/index.js';

const log = createModuleLog('gamelogic-pack');

// Install a judged pack file into the library. `text` is the file as pasted/loaded; it is stored
// VERBATIM (the author's formatting is theirs; round-trip means byte-identical, not re-serialized).
// Same id+type overwrites the existing entry — the library holds ONE copy per artifact, and whether
// that copy's version moved is the ACTIVATION flow's business, not the library's.
// Returns { ok, pack, errors, warnings, created, eventPackIds? } — ok:false carries the named rules and gate
// findings; `eventPackIds` is set when the file was an event pack (see below).
export async function installPackToLibrary(text) {
    const res = await judgePackFile(text, { readMenuEngine: readMenuEngineExportsInWorker });
    if (!res.ok) return { ...res, created: false };
    // An event pack's files go to the EVENT-PACK library — one entry per packId, the canonical single-pack
    // text — which the Event Packs tab lists and installs from. Stored here as a pack file instead, it
    // would be a copy that tab never sees. `eventPackIds` names what was stored there.
    if (res.pack.packType === 'eventpack') {
        const stored = await storeEventPacksInLibrary(eventPackArtifactTexts(res.pack));
        return { ...res, ok: stored.ok, errors: [...res.errors, ...stored.errors], created: false, eventPackIds: stored.stored || [] };
    }

    const wrote = await writeLibraryEntry(res.pack.packType, res.pack.id, String(text));
    if (!wrote.ok) return { ...res, ok: false, errors: [wrote.error], created: false };

    log.lifecycle('library ' + (wrote.created ? 'added' : 'updated')
        + ' ' + libraryEntryComment(res.pack.packType, res.pack.id)
        + ' — "' + res.pack.name + '" v' + (res.pack.version || '?') + ' (' + String(text).length + ' bytes)');
    return { ...res, created: wrote.created };
}

// Every artifact in the library, parsed enough to list: { packType, id, name, description, version,
// builtWith, bytes, parseError }. A library entry whose content no longer parses is STILL listed
// (with parseError set) — hiding it would make a corrupted import undeletable from the UI.
// Returns null when the book cannot be read at all ("could not look" ≠ "empty library" — callers
// render the two differently), [] for a readable book with no artifacts.
export async function listLibraryPacks() {
    const stored = await listLibraryEntries();
    if (stored === null) return null;
    const out = [];
    for (const record of stored) {
        // Event packs share the library book but not the pack-file FORMAT, so listing them here as
        // unparseable rows would invent a defect. They belong to the EventPack tab's own listing.
        if (record.packType === 'eventpack') continue;
        const { pack, error } = parsePackFile(record.text);
        out.push({
            packType: record.packType,
            id: record.id,
            name: pack ? String(pack.name || '') : '',
            description: pack ? String(pack.description || '') : '',
            version: pack ? String(pack.version || '') : '',
            builtWith: pack ? String(pack.builtWith || '') : '',
            requires: (pack && Array.isArray(pack.requires)) ? pack.requires.map(String) : [],
            bytes: record.text.length,
            parseError: error,
        });
    }
    return out;
}

// Read one artifact's file text back, verbatim — the activation lane consumes this.
// Returns the text, or null when absent/unreadable.
export async function readLibraryPack(packType, id) {
    return readLibraryEntry(packType, id);
}

// Delete one artifact from the library. Active installs on cards are NOT touched: the card's
// registry keeps them working, and the LED shows library-missing state. Returns the count removed.
export async function deleteLibraryPack(packType, id) {
    const removed = await deleteLibraryEntry(packType, id);
    if (removed) log.lifecycle('library removed ' + libraryEntryComment(packType, id) + ' (' + removed + ' entry)');
    return removed;
}
