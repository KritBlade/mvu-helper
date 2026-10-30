// shared/card-artifact-library.js — lorebook I/O for the artifact LIBRARY (§4/§4b), the half of
// card-artifact-store.js that cannot be pure.
//
// WHY THE SPLIT: every DECISION (names, needles, LED, exactness) lives in card-artifact-store.js where
// a test can reach it without a host (L6). This file is the plumbing those decisions dictate — four
// operations over ONE root-level worldbook, none of which knows what an artifact's file CONTAINS.
//
// WHAT THE LIBRARY IS FOR (§4b/V28): the card's own book dies with the card in the rebuild dev loop
// (delete card + book, import the rebuilt one). The library is root-level and never bound to a
// character, so it survives — and the artifact comes back by RE-INSTALLING FROM IT, not by the user
// finding the file on disk again. Re-activating is not re-importing.
//
// LOGGING: this file logs FAILURES only. What was installed, at which version, for which feature is
// the caller's line to write — a shared module narrating "added [EventPack:x]" beside the feature's own
// "installed x v1.2" would double every lifecycle event in the console.

import {
    ensureLorebookExists,
    getLorebookEntriesByBook,
    upsertLorebookEntry,
    deleteLorebookEntriesByNeedle,
} from '../sillytavern/lorebook.js';
import { createModuleLog } from '../sillytavern/log.js';
import {
    LIBRARY_BOOK_NAME,
    libraryEntryComment,
    libraryEntryMatch,
    parseLibraryComment,
} from './card-artifact-store.js';

const log = createModuleLog('card-artifact-library');

// Store one artifact's file text VERBATIM (§4 — the author's formatting is theirs; a round-trip means
// byte-identical, never re-serialized). Same type+id overwrites: the library holds ONE copy per
// artifact, and whether that copy's version moved is the INSTALL flow's business, not the library's.
// Returns { ok, created, error } — `error` is a sentence a user can act on, never a bare code.
export async function writeLibraryEntry(artifactType, id, text) {
    const comment = libraryEntryComment(artifactType, id);
    const ensured = await ensureLorebookExists(LIBRARY_BOOK_NAME);
    if (!ensured) {
        return { ok: false, created: false, error: 'the library worldbook "' + LIBRARY_BOOK_NAME + '" could not be created (lorebook API unavailable — see the warning above)' };
    }
    const wrote = await upsertLorebookEntry(libraryEntryMatch(artifactType, id), comment, String(text), LIBRARY_BOOK_NAME);
    if (!wrote) {
        return { ok: false, created: false, error: 'the library entry ' + comment + ' could not be written (lorebook API unavailable)' };
    }
    return { ok: true, created: Boolean(wrote.created), error: '' };
}

// One artifact's file text, verbatim. null = absent OR unreadable — callers that must tell those apart
// call listLibraryEntries() first (null there means "could not look at all").
export async function readLibraryEntry(artifactType, id) {
    const entries = await getLorebookEntriesByBook(LIBRARY_BOOK_NAME);
    if (entries === null) return null;
    const needle = libraryEntryMatch(artifactType, id);
    const entry = entries.find((e) => String(e.comment || '').toLowerCase().includes(needle));
    return entry ? String(entry.content || '') : null;
}

// Every artifact in the library as { packType, id, text } — unparsed, because "what is a valid file"
// is the consuming feature's question (L1). A user's own note in the book is not an artifact and is
// skipped; it is theirs to keep.
// Returns null when the book cannot be READ at all ("could not look" ≠ "empty library" — callers
// render those two very differently), [] for a readable book holding no artifacts.
export async function listLibraryEntries() {
    const entries = await getLorebookEntriesByBook(LIBRARY_BOOK_NAME);
    if (entries === null) return null;
    const out = [];
    for (const entry of entries) {
        const named = parseLibraryComment(entry.comment);
        if (!named) continue;
        out.push({ packType: named.packType, id: named.id, text: String(entry.content || '') });
    }
    return out;
}

// Remove one artifact from the library. Copies INSTALLED on cards are NOT touched (§4): each card's
// registry keeps them working, and the LED shows the amber library-missing state. Returns the count
// removed (0 = it was not there, which is not an error).
export async function deleteLibraryEntry(artifactType, id) {
    const removed = await deleteLorebookEntriesByNeedle(libraryEntryMatch(artifactType, id), LIBRARY_BOOK_NAME);
    if (!removed) log.verbose('nothing to remove for ' + libraryEntryComment(artifactType, id));
    return removed;
}
