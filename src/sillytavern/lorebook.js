// sillytavern/lorebook.js — lorebook-helper resolution, shared by image-gen (img_<char>
// appearance) and the small-LLM calls ([name]-prefixed system blocks).
//
// The lorebook helpers are provided by JS-Slash-Runner (酒馆助手). In the MAIN
// window — where ST extensions run — they live on `window.TavernHelper.*`, NOT as
// bare globals (those only exist inside the iframe script runtime that cards like
// gen_status_menu.html run in). Verified live: window.TavernHelper.getLorebookEntries.
// Resolve in order: bare global → TavernHelper → parent's bare → parent's TavernHelper.

import { createModuleLog } from './log.js';
import { normalizeCharBookEntries, preserveCommentLeadIn } from './lorebook-core.js';
import { entryFieldsDiffer, commentMatchesNeedle } from '../shared/card-artifact-store.js';

const log = createModuleLog('lorebook');

function resolveLoreFn(name) {
    if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') return globalThis[name];
    const th = typeof window !== 'undefined' ? window.TavernHelper : undefined;
    if (th && typeof th[name] === 'function') return th[name].bind(th);
    try {
        const p = typeof window !== 'undefined' ? window.parent : undefined;
        if (p && typeof p[name] === 'function') return p[name];
        if (p && p.TavernHelper && typeof p.TavernHelper[name] === 'function') return p.TavernHelper[name].bind(p.TavernHelper);
    } catch (_e) { /* EXPECTED: cross-origin parent access throws — that resolution path is simply unavailable */ }
    return null;
}

function stContext() {
    const ST = (typeof SillyTavern !== 'undefined' && SillyTavern)
        || (typeof window !== 'undefined' && window.SillyTavern) || null;
    return ST && typeof ST.getContext === 'function' ? ST.getContext() : null;
}

// ── ST's world-info save COALESCES ACROSS BOOKS — the §12a.2 data loss (found + reproduced 2026-08-15) ──
//
// ST's saveWorldInfo updates its CACHE synchronously and unconditionally, then defers the DISK write
// through ONE shared debounce for every book that exists:
//
//     const saveWorldDebounced = debounce(async (name, data) => await _save(name, data), relaxed);
//     export async function saveWorldInfo(name, data, immediately = false) {
//         worldInfoCache.set(name, data);            // immediate
//         if (immediately) return await _save(name, data);
//         saveWorldDebounced(name, data);            // deferred — and there is only ONE pending call
//     }
//
// A debounce holds exactly one pending (name, data). Write book A, then book B inside the window, and
// B's call REPLACES A's: only B ever reaches disk. Nothing looks wrong afterwards — A's cache is already
// correct, so every read agrees — and nothing is marked dirty, so nothing retries. A's entry then lives
// in memory alone until some unrelated later write to A happens to re-save it. A reload before that
// loses it outright.
//
// WE DID NOT HAVE THIS BUG UNTIL GE. Before the library mirror, one operation touched one book. Now an
// install writes the card book AND mirrors into MVU_GameLogic_Library, which is precisely the A-then-B
// shape. Reproduced deterministically: two createLorebookEntries calls at different books, and the first
// book's entry never reached disk at +5s or +13s while the second's did.
//
// THE FIX IS BOOK-SWITCH DRIVEN, NOT TIMED. Flushing after every write would mean a 70-entry pack
// install performing 70 full-book saves of a ~900 KB book; sleeping between writes would hardcode ST's
// debounce constant, which is the kind of timing dependency that rots silently. Instead we remember
// which book our last write left riding the debounce, and force it to disk the moment a write targets a
// DIFFERENT one. Same-book loops (the pack installer) cost nothing extra; a book switch costs one
// synchronous save of the book that was about to be dropped.
//
// This REPAIRS someone else's defect rather than only reporting it (L7's corollary), which was the
// user's call: the alternative left every install one reload away from losing the pack it just wrote.
// The warn below keeps the cause visible so it is never mistaken for our own design.
let bookRidingDebounce = null;

// Force ST to write ONE book to disk now, bypassing the shared debounce. Returns true if it saved.
export async function flushLorebookWrites() {
    const book = bookRidingDebounce;
    bookRidingDebounce = null;
    if (!book) return false;
    const ctx = stContext();
    if (!ctx || typeof ctx.loadWorldInfo !== 'function' || typeof ctx.saveWorldInfo !== 'function') {
        log.warn(`lorebook flush unavailable — "${book}" is left riding ST's shared save debounce, so a `
            + 'write to any OTHER book before it fires will drop it (ST world-info.js saveWorldDebounced).');
        return false;
    }
    try {
        const data = await ctx.loadWorldInfo(book);   // the cache is already correct — this is not a re-read of disk
        if (!data) { log.child('flush').warn(`"${book}" did not load — cannot force its save`); return false; }
        await ctx.saveWorldInfo(book, data, true);    // immediately=true — the debounce cannot lose it
        log.child('flush').trace(`"${book}" written to disk immediately`);
        return true;
    } catch (e) {
        log.warn(`lorebook flush failed for "${book}" — its last write may exist only in memory:`, e);
        return false;
    }
}

// Call BEFORE issuing a write to `book`: if a DIFFERENT book is still riding the debounce, that one is
// about to be dropped, so save it first. Then record this book as the new rider.
async function claimBookForWrite(book) {
    if (bookRidingDebounce && bookRidingDebounce !== book) await flushLorebookWrites();
    bookRidingDebounce = book || null;
}

// Race-free FALLBACK SOURCE: the ACTIVE character's EMBEDDED character_book entries, read straight from the
// ST context. These are available the instant the character is selected — BEFORE ST registers that book as a
// queryable standalone worldbook. That registration lags CHAT_CHANGED, so during chat load
// getLorebookEntries(name) throws "未能找到世界书 '<name>'" even though the name already resolves.
// The embedded book is a SNAPSHOT of the card as it was imported: a pack upgrade or a user's edit changes the
// standalone book only, so the two can differ. Normalized to the TavernHelper entry shape (see lore-core).
function readEmbeddedCharBook() {
    try {
        const ST = (typeof SillyTavern !== 'undefined' && SillyTavern)
            || (typeof window !== 'undefined' && window.SillyTavern) || null;
        const ctx = ST && typeof ST.getContext === 'function' ? ST.getContext() : null;
        const ch = ctx && Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        const raw = ch && ch.data && ch.data.character_book && ch.data.character_book.entries;
        return normalizeCharBookEntries(raw);
    } catch (e) { log.warn('readEmbeddedCharBook (embedded fallback) failed:', e); return []; }
}

// Is a character actually selected right now — i.e. is a CARD open, as opposed to ST's lobby?
// Two consumers, and neither may decide whether to READ:
//   • grading the severity of a missing lorebook API (below);
//   • telling the lobby apart from an open card when a UI must choose what to SAY.
// Message COUNT cannot do that second job: ST's lobby carries a 2-message placeholder chat, so
// `latestMsgId() >= 0` is true with no card open at all. The character is the only honest signal.
export function hasActiveCharacter() {
    try {
        const ST = (typeof SillyTavern !== 'undefined' && SillyTavern)
            || (typeof window !== 'undefined' && window.SillyTavern) || null;
        const ctx = ST && typeof ST.getContext === 'function' ? ST.getContext() : null;
        if (!ctx) return false;
        if (ctx.groupId != null) return true;                 // a group chat has no characterId but IS a live card context
        return ctx.characterId != null && Array.isArray(ctx.characters) && Boolean(ctx.characters[ctx.characterId]);
    } catch (e) {
        // Unknown beats wrong: if the context cannot be read, assume a card IS open so a genuine
        // missing-API stays loud. Silence is only ever granted on POSITIVE evidence of "no card".
        log.child('hasActiveCharacter').lifecycle('context unreadable, assuming a character is selected:', e);
        return true;
    }
}

// TavernHelper (JS-Slash-Runner) missing has TWO causes that look identical at the call site, and they
// deserve opposite volumes:
//   • Not attached YET. ST registers it asynchronously, and our CHAT_CHANGED handler reads the lorebook
//     immediately — so at startup this fires routinely, resolves itself, and warning about it is noise.
//   • Not installed / wrong version. A real misconfiguration: every lorebook read silently serves the
//     card's IMPORT-TIME embedded snapshot, so any hand-edit to the standalone worldbook is invisible.
// A SELECTED CHARACTER is what separates them. With no card open, startup is plainly still in progress
// and there is nothing to read anyway. With a card open, loading is done — an absent API is real, and
// this warns. Warn once per session, then drop to lifecycle: the condition is global, not per-card, so
// repeating it on every read (and every card switch) would bury the one line that matters.
let apiUnavailableWarned = false;
function reportLorebookApiUnavailable(where, consequence) {
    const msg = `${where}: lorebook API (TavernHelper) unavailable — ${consequence}`;
    if (!hasActiveCharacter()) {
        log.lifecycle(`${msg} [no character selected — normal during startup]`);
        return;
    }
    if (apiUnavailableWarned) { log.lifecycle(`${msg} [repeat]`); return; }
    apiUnavailableWarned = true;
    log.warn(`${msg}\nA character IS selected, so this is not a startup race: JS-Slash-Runner (酒馆助手) is `
        + 'missing, disabled, or too old. Until it loads, reads fall back to the card\'s embedded '
        + 'character_book — the IMPORT-TIME snapshot — so edits made directly to the standalone '
        + 'worldbook will NOT be seen.');
}

// The embedded character_book entries, exposed for callers that need a read which CANNOT fail on the
// chat-load race — the engine loader above all: the card's [PRE] entries render during CHAT_CHANGED,
// before ST registers the standalone book, so a standalone-only read has nothing to give them.
// THIS IS THE IMPORT-TIME SNAPSHOT. Anything served from here must be treated as provisional and
// re-checked against the standalone copy once it registers (logic-engine-loader hot-swaps).
export function getEmbeddedCharBookEntries() {
    return readEmbeddedCharBook();
}

// EXPLICIT availability check, to be called once a card is open (index.js, end of CHAT_CHANGED).
//
// WHY THIS EXISTS SEPARATELY: every other report above is a passenger on a read that happened to
// occur. That is not good enough for the case that matters. CHAT_CHANGED's first read can run before
// ST has populated characterId, and a report made in that instant is graded "no character selected"
// and stays quiet — so a genuinely missing JS-Slash-Runner could go unannounced until some later read
// happened to land after the context settled. Calling this at the END of the handler, after the
// awaits, checks the API at a moment when a character demonstrably IS selected.
// Returns true when the API is usable. Cheap: two property lookups, no I/O.
export function checkLorebookApiAvailable() {
    const ok = typeof resolveLoreFn('getCurrentCharPrimaryLorebook') === 'function'
        && typeof resolveLoreFn('getLorebookEntries') === 'function';
    if (!ok) reportLorebookApiUnavailable('checkLorebookApiAvailable', 'every lorebook read will fall back to the embedded snapshot');
    return ok;
}

// THE single lorebook-read path, shared by image-gen (img_<char> appearance), the small-LLM calls
// ([name]-prefixed system blocks) and the card config. Resolves the TavernHelper APIs, fetches the current
// character's primary-lorebook entries, and ALWAYS returns an array in `entries`.
// If the standalone worldbook isn't queryable yet (the chat-load race — see readEmbeddedCharBook) OR the API
// is unavailable, it FALLS BACK to the card's embedded character_book so the read is race-free, and says so
// in `isEmbeddedSnapshot`: a caller comparing the card with an earlier read must not act on the snapshot.
// `entries` is [] only when there's genuinely no book (standalone or embedded).
export async function readPrimaryLorebookEntries() {
    const getBook = resolveLoreFn('getCurrentCharPrimaryLorebook');
    const getEntries = resolveLoreFn('getLorebookEntries');
    if (typeof getBook === 'function' && typeof getEntries === 'function') {
        try {
            const book = await getBook();
            if (book) {
                const entries = await getEntries(book);
                if (Array.isArray(entries) && entries.length) return { entries, isEmbeddedSnapshot: false };   // normal path: standalone book loaded
            }
        } catch (e) {
            // LOAD-ORDER RACE (see readEmbeddedCharBook): standalone book not registered yet → fall through.
            log.child('getPrimaryLorebookEntries').lifecycle('standalone book not ready (' + (e && e.message || e) + ') — using embedded character_book');
        }
    } else {
        reportLorebookApiUnavailable('getPrimaryLorebookEntries', 'using the embedded character_book if present');
    }
    return { entries: readEmbeddedCharBook(), isEmbeddedSnapshot: true };
}

// The entries alone, for readers that only look things up.
export async function getPrimaryLorebookEntries() {
    return (await readPrimaryLorebookEntries()).entries;
}

// The active character's primary lorebook NAME (or null). Used by the config export to know which book to write.
export async function getPrimaryLorebookName() {
    const getBook = resolveLoreFn('getCurrentCharPrimaryLorebook');
    if (typeof getBook !== 'function') {
        reportLorebookApiUnavailable('getPrimaryLorebookName', 'cannot resolve the book name (returning null)');
        return null;
    }
    return (await getBook()) || null;
}

// STANDALONE-ONLY read — NO embedded fallback. The embedded character_book is the IMPORT-TIME SNAPSHOT;
// the registered standalone worldbook is what SillyTavern actually uses and what a user's live edits go
// into. Callers that must never act on a stale snapshot (data-sync: a hand-bumped [MVU_Update_Data]
// exists only in the standalone copy) use this and treat `null` as NOT-READY-YET (retry), where
// getPrimaryLorebookEntries above would have silently served the stale embedded entries instead.
export async function getStandaloneLorebookEntries() {
    const getBook = resolveLoreFn('getCurrentCharPrimaryLorebook');
    const getEntries = resolveLoreFn('getLorebookEntries');
    if (typeof getBook !== 'function' || typeof getEntries !== 'function') return null;   // API not up yet
    try {
        const book = await getBook();
        if (!book) return null;                              // char/book not resolved yet → not ready
        const entries = await getEntries(book);
        return Array.isArray(entries) ? entries : null;
    } catch (e) {
        // EXPECTED during chat load: the book name resolves before ST registers it as queryable.
        log.child('getStandaloneLorebookEntries').lifecycle('not ready yet (' + (e && e.message || e) + ')');
        return null;
    }
}

// Resolve which book a write targets: an EXPLICIT name (the GameLogic Pack library lane, which writes to a
// root-level worldbook that is never bound to a character) or — when omitted — the active character's primary
// book, which is what every caller predating the parameter means. Kept in ONE place so the default can never
// drift between the write paths below.
async function resolveBookName(bookName) {
    return bookName ? String(bookName) : await getPrimaryLorebookName();
}

// Upsert a single lorebook entry, matched by its COMMENT containing `matchNeedle` (case-insensitive) — the same
// way MVU/this-extension locate `[InitVar]`/`[Initmvuhelper]`. Updates the first match in place (preserving its
// uid) or creates a fresh entry. The written entry is a DATA CARRIER (enabled:false, keys:[]) like [InitVar], so
// SillyTavern never injects it into the prompt while the extension can still read it via getLorebookEntries.
// `bookName` is optional and defaults to the primary book (see resolveBookName).
// Returns { book, uid, created } or null if the API/book is unavailable.
export async function upsertLorebookEntry(matchNeedle, comment, content, bookName) {
    return upsertLorebookEntryFields(matchNeedle, { comment, content, enabled: false, keys: [] }, bookName);
}

// Upsert with an EXPLICIT field set — the general form behind upsertLorebookEntry. Lets a caller write an
// INJECTED entry (enabled:true + type:'constant' → ST fires it every turn without keywords, e.g. the LLM-task
// router's narrate target and the event-pack body) as well as the silent data-carrier default. NB: the
// always-on flag is `type:'constant'`, NOT a `constant` boolean — TavernHelper silently drops the boolean,
// leaving `type:'selective'` + no keys, which ST never injects. `fields` is a partial TavernHelper entry
// (comment, content, enabled, type, keys, order, …); it's merged onto the matched entry (uid preserved) or created.
// `bookName` is optional and defaults to the primary book (see resolveBookName).
// Returns { book, uid, created, changed } or null if the API/book is unavailable. `changed` says whether
// the entry MOVED — a rewrite with identical fields reports false, which is how a caller tells a real
// content change from a routine re-apply without reading the book a second time.
export async function upsertLorebookEntryFields(matchNeedle, fields, bookName) {
    const book = await resolveBookName(bookName);
    if (!book) return null;
    const getEntries = resolveLoreFn('getLorebookEntries');
    const setEntries = resolveLoreFn('setLorebookEntries');
    const createEntries = resolveLoreFn('createLorebookEntries');
    if (typeof getEntries !== 'function' || typeof setEntries !== 'function' || typeof createEntries !== 'function') {
        log.warn('lorebook write API unavailable'); return null;
    }
    const f = fields || {};
    await claimBookForWrite(book);          // a pending save for ANOTHER book would be dropped by ours
    const entries = await getEntries(book);
    const needle = String(matchNeedle || '').toLowerCase();
    const existing = (Array.isArray(entries) ? entries : []).find((e) => commentMatchesNeedle(e.comment, needle));
    if (existing) {
        // The comment written back keeps whatever an installer wrote in FRONT of our needle — see
        // preserveCommentLeadIn in lorebook-core.js for why a bare rewrite is destructive.
        const written = { ...f, ...preserveCommentLeadIn(existing.comment, needle, f) };
        // `changed` is compared against what is ACTUALLY written (lead-in included), because a caller
        // uses it to decide whether the rendered chat must reload — see chat-reload.js.
        const changed = entryFieldsDiffer(existing, written);
        await setEntries(book, [{ uid: existing.uid, ...written }]);
        return { book, uid: existing.uid, created: false, changed };
    }
    await createEntries(book, [{ ...f }]);
    return { book, uid: null, created: true, changed: true };
}

// Delete EVERY entry in the target book whose comment contains `needle` (case-insensitive) — the routing-entry
// cleanup path for the LLM-task router (a task keys its entry by a `mvu-llm-task:<id>` needle, so switching or
// clearing the target deletes any prior entry regardless of which call it was routed to), and the exact-uninstall
// path for GameLogic Pack artifacts. `bookName` is optional and defaults to the primary book (see
// resolveBookName). Returns the count removed; 0 when nothing matched or the API/book is unavailable (logged,
// never silent on error).
export async function deleteLorebookEntriesByNeedle(needle, bookName) {
    // A substring (trimmed, lowercased) or the uninstall sweep's RegExp — commentMatchesNeedle is the
    // ONE test, shared with the read side, so a count and a delete can never disagree.
    const n = needle instanceof RegExp ? needle : String(needle || '').trim().toLowerCase();
    if (!n) return 0;
    const book = await resolveBookName(bookName);
    const getEntries = resolveLoreFn('getLorebookEntries');
    const delEntries = resolveLoreFn('deleteLorebookEntries');
    if (!book || typeof getEntries !== 'function' || typeof delEntries !== 'function') {
        log.child('deleteLorebookEntriesByNeedle').warn('lorebook API or book unavailable (book=' + book + ')');
        return 0;
    }
    try {
        const entries = await getEntries(book);
        const uids = (Array.isArray(entries) ? entries : [])
            .filter((e) => commentMatchesNeedle(e.comment, n))
            .map((e) => e.uid);
        if (!uids.length) return 0;
        await claimBookForWrite(book);
        await delEntries(book, uids);
        return uids.length;
    } catch (e) {
        log.warn('deleteLorebookEntriesByNeedle failed for "' + needle + '":', e);
        return 0;
    }
}

// Read EVERY entry of an EXPLICITLY NAMED book — the read half of the library lane (the writes above
// take bookName; a library list obviously cannot go through the primary-book default). Distinct from
// getStandaloneLorebookEntries on purpose: that one answers "the active CARD's book" with an embedded-
// fallback story this book can never have. Returns the entries array, or null when the API is
// unavailable / the book does not exist — null means "could not look", NOT "empty book" (the
// mvu-bootstrap lesson: acting on invisibility as absence is how races write wrong records).
export async function getLorebookEntriesByBook(bookName) {
    const name = String(bookName || '').trim();
    if (!name) { log.child('getLorebookEntriesByBook').warn('called with an empty book name'); return null; }
    const getEntries = resolveLoreFn('getLorebookEntries');
    if (typeof getEntries !== 'function') {
        log.child('getLorebookEntriesByBook').warn('lorebook API unavailable — cannot read "' + name + '"');
        return null;
    }
    try {
        const entries = await getEntries(name);
        return Array.isArray(entries) ? entries : null;
    } catch (e) {
        // EXPECTED for a book that does not exist yet (the library before first use) — report as
        // not-readable and let the caller decide whether to create it.
        log.lifecycle('getLorebookEntriesByBook("' + name + '") not readable (' + (e && e.message || e) + ')');
        return null;
    }
}

// All worldbook NAMES known to SillyTavern. [] when unavailable.
export async function listLorebookNames() {
    const getBooks = resolveLoreFn('getLorebooks');
    if (typeof getBooks !== 'function') { log.child('listLorebookNames').warn('getLorebooks API unavailable'); return []; }
    try {
        const books = await getBooks();
        return Array.isArray(books) ? books : [];
    } catch (e) {
        log.warn('listLorebookNames failed:', e);
        return [];
    }
}

// Ensure a root-level worldbook EXISTS, creating it only when absent. The GameLogic Pack library
// (`MVU_GameLogic_Library`) is such a book: root level, never bound to a character, created on first use.
// Create-only by design — an existing book is returned untouched, never recreated or cleared, because it
// holds every artifact the user has imported.
// Returns { name, created } on success, or null when the API is unavailable (logged, never silent).
// API note (verified, lorebook.d.ts:31): `createLorebook(name)` resolves false when the name is already taken,
// which is why existence is checked FIRST rather than inferred from that return.
export async function ensureLorebookExists(bookName) {
    const name = String(bookName || '').trim();
    if (!name) { log.child('ensureLorebookExists').warn('called with an empty book name'); return null; }
    const createBook = resolveLoreFn('createLorebook');
    if (typeof createBook !== 'function') {
        log.child('ensureLorebookExists').warn('createLorebook API unavailable — cannot create "' + name + '"');
        return null;
    }
    try {
        const existing = await listLorebookNames();
        if (existing.includes(name)) return { name, created: false };
        const ok = await createBook(name);
        if (!ok) {
            log.child('ensureLorebookExists').warn('createLorebook("' + name + '") returned false and the book is not in the book list — not created');
            return null;
        }
        log.lifecycle('created worldbook "' + name + '"');
        return { name, created: true };
    } catch (e) {
        log.warn('ensureLorebookExists("' + name + '") failed:', e);
        return null;
    }
}

// Point the OPEN CARD at an existing worldbook (data.extensions.world). SillyTavern's own sequence,
// via TavernHelper: it validates the book exists, sets #character_world, persists the character with
// editCurrentCharacter, and relights the globe — and it leaves data.character_book alone when a
// primary is being SET (it only clears it when one is being removed).
//
// Writes NOTHING to the book itself, which is what makes it the right repair for a card that lost its
// link while its lore stayed on disk (card-access-core.js, embeddedBookResolution).
// Returns true on success; false (logged, never silent) when the API is absent or refuses.
// `additional` is passed EXPLICITLY, and must be — two independent reasons, both load-bearing:
//   1. TavernHelper's own bug (verified live 2026-08-31, JS-Slash-Runner lorebook.ts:255). It builds
//      `_.concat(primary ? [primary] : [], lorebooks.additional)` and then filters with `_.isNull`
//      rather than `_.isNil`, so an omitted `additional` leaves a literal `undefined` in the list,
//      which matches no known book and throws — with the name printed as an empty string:
//      "尝试修改 'X' 绑定的世界书, 但未找到以下世界书: ". So `{ primary }` alone ALWAYS fails.
//      Their bug, their repo (L7): surfaced here, not repaired there.
//   2. Passing `[]` instead would be destructive — `additional: []` SPLICES the card's charLore entry
//      out, dropping every extra book bound to it. So the card's CURRENT list is read and handed back
//      unchanged, which is the only value that means "leave this alone".
export async function setPrimaryLorebook(bookName) {
    const name = String(bookName || '').trim();
    if (!name) { log.child('setPrimaryLorebook').warn('called with an empty book name'); return false; }
    const setBooks = resolveLoreFn('setCurrentCharLorebooks');
    const getBooks = resolveLoreFn('getCharLorebooks');
    if (typeof setBooks !== 'function' || typeof getBooks !== 'function') {
        log.child('setPrimaryLorebook').warn('the character-lorebook API is unavailable — cannot link "' + name + '"');
        return false;
    }
    try {
        const current = getBooks();
        const additional = (current && Array.isArray(current.additional)) ? current.additional : [];
        await setBooks({ primary: name, additional });
        return true;
    } catch (e) {
        log.warn('setPrimaryLorebook("' + name + '") failed:', e);
        return false;
    }
}
