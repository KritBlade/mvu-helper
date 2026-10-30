// sillytavern/card-access.js — the ONE place the three card-access facts are read from the host.
// The classification of those facts is pure and lives in card-access-core.js; see the bug history
// there for why no lane may re-derive either half locally.

import { getContext } from '../../../../../extensions.js';
import { hasActiveCharacter, getStandaloneLorebookEntries, getPrimaryLorebookName, listLorebookNames, setPrimaryLorebook, ensureLorebookExists } from './lorebook.js';
import { latestMsgId } from './mvu-bridge.js';
import { cardBookProblem, embeddedImportSafety, embeddedBookName, embeddedBookResolution, freeLorebookName } from './card-access-core.js';
import { confirmPopup } from './popup.js';
import { createModuleLog } from './log.js';

const log = createModuleLog('card-access');

// WHICH card is open, as a key. The avatar FILENAME, because that is the identity SillyTavern itself
// keys a character by (character_allowed_regex holds these, so does every /api/characters call) —
// the display name is editable and duplicates freely across cards.
//
// Returns '' with no card open. Callers store per-card answers against this, so '' must never be
// treated as a card: an answer filed under "no card" would be handed to whatever opens next.
export function openCardKey() {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    return String((character && character.avatar) || '');
}

// Does the open card carry an EMBEDDED lorebook (data.character_book)? The import-time snapshot,
// which SillyTavern will not read from and this extension must never write to — but whose presence
// is the difference between "Import Card Lore" and "link a book", so it has to be readable.
// False with no card open, and false when the context is not up: absence of an answer is not an
// embedded book, and the verdict it feeds treats no-link-no-embed as "link one", which is the
// instruction that helps in both cases.
export function hasEmbeddedCardBook() {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    return Boolean(character && character.data && character.data.character_book);
}

// The open card's display NAME and the TITLE its embedded book carries — the two halves SillyTavern
// derives the imported book's name from (embeddedBookName). Read here rather than in the offer so the
// context walk lives with its siblings above.
export function openCardName() {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    return String((character && character.name) || '');
}

export function embeddedBookTitle() {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const character = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
    const book = character && character.data && character.data.character_book;
    return String((book && book.name) || '');
}

// The synchronous §6 in-chat guard, CARD-AWARE. `latestMsgId() >= 0` alone is not that guard: ST's
// lobby carries a 2-message placeholder chat, so a bare count test passes with no card open at all
// (a lane using it would let a write proceed into a book that does not exist).
export function isCardChatActive() {
    return hasActiveCharacter() && latestMsgId() >= 0;
}

// The three facts in one read, plus the entries the caller was going to fetch anyway (every consumer
// needs them next, and reading twice would let the facts and the entries disagree mid-load).
// `canOperateOnCard` is the write gate: deliberately `isChatStarted && areEntriesReadable` — the
// exact compound the per-card lanes always used — so adopting this helper cannot widen a write path.
// (It needs no isCardOpen term: with no card there is no book, so areEntriesReadable is false.)
//
// `bookBinding` and `bookName` ride along so an unreadable book can SAY why (card-access-core's
// cardBookProblem). They are read only when the book did NOT answer: on the happy path the extra
// host calls would be two round trips for a question nobody asks.
export async function readCardAccess() {
    const entries = await getStandaloneLorebookEntries();
    const isCardOpen = hasActiveCharacter();
    const isChatStarted = latestMsgId() >= 0;
    const areEntriesReadable = entries !== null;

    let bookBinding = null;
    let bookName = '';
    let canLinkExistingBook = false;
    if (isCardOpen && !areEntriesReadable) {
        bookName = (await getPrimaryLorebookName()) || '';
        const known = await listLorebookNames();
        bookBinding = cardBookProblem({
            hasEmbeddedBook: hasEmbeddedCardBook(),
            primaryBookName: bookName,
            knownBookNames: bookName ? known : [],
        });
        // An embedded, unlinked card whose own book ALREADY EXISTS needs a link, not an import — and
        // the message, the button label and the action all have to agree about which. Decided once,
        // here, and reported so nothing downstream re-derives it (embeddedBookResolution).
        if (bookBinding === 'embedded-not-imported') {
            bookName = embeddedBookName({ bookTitle: embeddedBookTitle(), characterName: openCardName() });
            canLinkExistingBook = embeddedBookResolution({ bookName, knownBookNames: known }) === 'link';
        } else if (bookBinding === 'no-book-bound') {
            // Nothing to link and nothing to import: the only repair left is to CREATE. The name is
            // what SillyTavern itself would call this card's book, stepped past any collision so the
            // card never adopts a stranger's book that merely shares the derived name.
            bookName = freeLorebookName({
                base: embeddedBookName({ bookTitle: '', characterName: openCardName() }),
                knownBookNames: known,
            });
        }
    }

    return {
        entries, isCardOpen, isChatStarted, areEntriesReadable,
        bookBinding, bookName, canLinkExistingBook,
        canOperateOnCard: isChatStarted && areEntriesReadable,
    };
}

// ── importing a card's EMBEDDED lorebook (2026-08-31) ────────────────────────

// Turn the open card's embedded character_book into a real, linked worldbook by calling
// SILLYTAVERN'S OWN function — never a re-implementation of it. `importEmbeddedWorldInfo` does five
// things in order (convert, saveWorldInfo, updateWorldInfoList, bind via #character_world, relight
// the globe) and a port that copied four of them would leave the card looking imported and behaving
// unimported. The whole sequence belongs to the host; this wrapper only decides whether it is SAFE
// to call and reports what happened.
//
// `skipPopup` is passed TRUE deliberately: the caller has already asked. Two dialogs for one yes is
// how a confirmation stops being read.
//
// Returns { ok, bookName, reason } and never throws.
export async function importEmbeddedCardBook() {
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const safety = embeddedImportSafety({
        buttonChid: (typeof $ === 'function') ? $('#import_character_info').data('chid') : undefined,
        currentCharacterId: ctx ? ctx.characterId : null,
        hasEmbeddedBook: hasEmbeddedCardBook(),
    });
    if (safety === 'no-card') return { ok: false, bookName: '', reason: 'no card is open' };
    if (safety === 'nothing-embedded') return { ok: false, bookName: '', reason: 'this card carries no embedded lorebook to import' };
    if (safety === 'stale-target') {
        // Not a wait and not a user error: SillyTavern's own bookkeeping is pointing at another card.
        // Reselecting the card re-runs checkEmbeddedWorld and repoints it.
        log.warn('SillyTavern\'s embedded-lorebook target still names another card — not importing.'
            + ' Reselect this character and try again.');
        return { ok: false, bookName: '', reason: 'SillyTavern still has another card as the import target — reselect this character, then retry' };
    }

    // NEVER import onto a name that exists: importEmbeddedWorldInfo ends in saveWorldInfo, which
    // OVERWRITES a book of the same name. Callers reach the link path instead (embeddedBookResolution),
    // and this is the backstop for the one case they cannot cover — our mirrored name derivation
    // disagreeing with ST's, which would put the write on a name nobody checked.
    const targetName = embeddedBookName({ bookTitle: embeddedBookTitle(), characterName: openCardName() });
    const known = await listLorebookNames();
    if (Array.isArray(known) && known.includes(targetName)) {
        return { ok: false, bookName: targetName, reason: 'a worldbook called "' + targetName + '" already exists —'
            + ' importing would overwrite it. Link that book to this card instead.' };
    }

    try {
        const wi = await import('../../../../../world-info.js');
        if (typeof wi.importEmbeddedWorldInfo !== 'function') {
            return { ok: false, bookName: '', reason: 'this SillyTavern build does not expose importEmbeddedWorldInfo' };
        }
        await wi.importEmbeddedWorldInfo(true);
    } catch (e) {
        log.warn('importEmbeddedWorldInfo failed:', e);
        return { ok: false, bookName: '', reason: 'SillyTavern\'s Import Card Lore failed (see console)' };
    }

    // Verified by READING BACK, not by the call returning: the import ends in a bind, and a bind that
    // did not take would leave the card exactly as unreadable as before while this reported success.
    const bookName = (await getPrimaryLorebookName()) || '';
    if (!bookName) return { ok: false, bookName: '', reason: 'the import ran but no worldbook is linked to this card afterwards' };
    log.lifecycle('imported this card\'s embedded lorebook as "' + bookName + '" and linked it');
    return { ok: true, bookName, reason: '' };
}

// LINK an existing worldbook to the open card — the other half of the same repair, and the one that
// writes NO lore at all. TavernHelper's setCurrentCharLorebooks is SillyTavern's own sequence
// (validate the book exists, set #character_world, persist via editCurrentCharacter, relight the
// globe) and it leaves data.character_book untouched when setting a primary.
// Returns { ok, bookName, reason } and never throws.
export async function linkExistingCardBook(bookName) {
    const name = String(bookName || '').trim();
    if (!name) return { ok: false, bookName: '', reason: 'no worldbook name to link' };
    if (!hasActiveCharacter()) return { ok: false, bookName: name, reason: 'no card is open' };
    if (!await setPrimaryLorebook(name)) {
        return { ok: false, bookName: name, reason: 'SillyTavern would not link "' + name + '" to this card (see console)' };
    }
    // Read back, same stance as the import: a link that did not take would leave the card exactly as
    // unreadable while this reported success.
    const now = (await getPrimaryLorebookName()) || '';
    if (now !== name) return { ok: false, bookName: name, reason: 'the link ran but this card is still not pointing at "' + name + '"' };
    log.lifecycle('linked this card to the existing worldbook "' + name + '" — nothing was written to it');
    return { ok: true, bookName: name, reason: '' };
}

// CREATE a worldbook and link the open card to it — the repair for a card that has no lore at all
// (user, 2026-08-31). `ensureLorebookExists` is create-only and returns an existing book untouched,
// so this can never overwrite; the name it is handed has already been stepped past any collision
// (freeLorebookName), so it never quietly adopts someone else's book either.
// Returns { ok, bookName, reason } and never throws.
export async function createAndLinkCardBook(bookName) {
    const name = String(bookName || '').trim();
    if (!name) return { ok: false, bookName: '', reason: 'no worldbook name to create' };
    if (!hasActiveCharacter()) return { ok: false, bookName: name, reason: 'no card is open' };

    const made = await ensureLorebookExists(name);
    if (!made) return { ok: false, bookName: name, reason: 'the worldbook "' + name + '" could not be created (see console)' };
    const linked = await linkExistingCardBook(name);
    if (!linked.ok) {
        // The book exists but the card is not pointing at it — say exactly that, because "create
        // failed" would send the user looking for a book that is already there.
        return { ok: false, bookName: name, reason: 'the worldbook "' + name + '" was created, but linking it to this card failed: ' + linked.reason };
    }
    log.lifecycle('created worldbook "' + name + '" and linked it to this card');
    return { ok: true, bookName: name, reason: '' };
}

// REPAIR the open card's worldbook link — the one gesture every lane's install can make when a card
// refuses for the one reason mvu-helper can fix from here.
//
// THREE OUTCOMES, and only one of them is silent (user, 2026-08-31):
//   LINK   — a worldbook of this card's name already exists, so the lore is on disk and only the
//            pointer is missing. Nothing is overwritten and nothing is created, so nothing is asked.
//   IMPORT — the card carries embedded lore and no such book. Converting it out CREATES a worldbook:
//            a real change to the user's SillyTavern, so it asks first.
//   CREATE — the card has no lore at all. An empty worldbook is made and linked. Also asks, and for
//            the same reason: it makes something that was not there.
// The split is embeddedBookResolution's, decided in readCardAccess so the message, the button label
// and the action cannot disagree about which repair this card needs.
//
// Returns { offered, resolved, action, bookName, reason }. `offered:false` means this card's problem
// is not one this can fix, and the caller falls back to the reason it already has.
// `action` is 'linked' | 'imported' | 'created' | 'declined' | 'failed' | 'none'.
export async function repairCardBookLink() {
    const none = { offered: false, resolved: false, action: 'none', bookName: '', reason: '' };
    const state = await readCardAccess();

    // THIRD case: the card has no lore at all — nothing to link, nothing to import. Creating a
    // worldbook is the only repair, and unlike a link it MAKES something, so it always asks.
    if (state.bookBinding === 'no-book-bound') {
        const yes = await confirmPopup([
            { text: 'Create a worldbook for this card?' },
            { text: 'This card has no worldbook, so a pack has nothing to write into.' },
            { text: 'New worldbook, linked to the card:', name: state.bookName },
            { text: 'It starts empty. Nothing existing is touched, and the card file is not modified.' },
        ], { okButton: 'Create' });
        if (!yes) return { offered: true, resolved: false, action: 'declined', bookName: state.bookName, reason: 'declined' };
        const res = await createAndLinkCardBook(state.bookName);
        return { offered: true, resolved: res.ok, action: res.ok ? 'created' : 'failed', bookName: res.bookName, reason: res.reason };
    }

    if (state.bookBinding !== 'embedded-not-imported') return none;

    if (state.canLinkExistingBook) {
        const res = await linkExistingCardBook(state.bookName);
        return { offered: true, resolved: res.ok, action: res.ok ? 'linked' : 'failed', bookName: res.bookName, reason: res.reason };
    }

    const yes = await confirmPopup([
        { text: "Import this card's embedded lore?" },
        { text: "Its lore is inside the card file, so SillyTavern has no worldbook to write to." },
        { text: 'New worldbook, linked to the card:', name: state.bookName },
        { text: "This is SillyTavern's own Import Card Lore: it copies the embedded entries. The card file and every existing worldbook stay as they are." },
    ], { okButton: 'Import' });
    if (!yes) return { offered: true, resolved: false, action: 'declined', bookName: state.bookName, reason: 'declined' };
    const res = await importEmbeddedCardBook();
    return { offered: true, resolved: res.ok, action: res.ok ? 'imported' : 'failed', bookName: res.bookName, reason: res.reason };
}
