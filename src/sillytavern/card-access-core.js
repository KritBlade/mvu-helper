// sillytavern/card-access-core.js — PURE classification of "may a card operation run, and if not,
// what is actually wrong?". The host reads live in card-access.js (the same L6 split as
// tavern-regex-core / tavern-script-core: the decision is testable, the I/O is not).
//
// THE BUG CLASS THIS EXISTS TO END (live, 2026-08-17, twice in one day): every per-card lane needs
// this same verdict, and each lane that derived it locally conflated the three facts differently —
//   • the pack tab folded "book not readable yet" into "no chat" and told a user whose pack was
//     installed and running to open a chat;
//   • the first fix then read "chat has messages" as "a card is open" and told a user standing in
//     the LOBBY (whose placeholder chat has messages but no book) to wait for a book that would
//     never load.
// Both wrong answers came from re-deriving the ordering at the call site. It is derived HERE, once;
// a lane that needs the verdict imports it and cannot drift.
//
// The three facts (read by card-access.js, or passed by a test):
//   isCardOpen         — a CARD is open, as opposed to ST's lobby. Decided by the selected
//                        character, never by message count: the lobby carries a placeholder chat.
//   areEntriesReadable — the card's worldbook actually answered (null = still loading or API detached).
//   isChatStarted      — the chat has at least one message (the §6/V8 in-chat write guard).
//
// The verdicts, in the ONLY order that makes every message truthful:
//   'no-chat'          — no card open. "Open a chat first" is the one instruction that helps; a
//                        "still loading" message here would describe a wait that never ends.
//   'card-unreadable'  — a card IS open but its book has not answered. Checked BEFORE the message
//                        count because an unread book is not an empty one — acting on it as empty is
//                        how residue and overwrites happen. WHY it did not answer is a separate
//                        question with separate instructions: see cardBookProblem below.
//   'no-chat' (again)  — card open, book readable, but the chat has no messages yet: the original
//                        §6/V8 guard, with the words it has always used.
//   null               — all three hold; the operation may proceed.

export function cardAccessProblem({ isCardOpen, isChatStarted, areEntriesReadable } = {}) {
    if (!isCardOpen) return 'no-chat';
    if (!areEntriesReadable) return 'card-unreadable';
    if (!isChatStarted) return 'no-chat';
    return null;
}

// WHY the book did not answer — the second half of 'card-unreadable', and the reason it needed one.
//
// THE BUG THIS ENDS (live, 2026-08-31): a plain card carrying an EMBEDDED character_book but no
// linked worldbook produced "retry in a moment" forever. Three of the four states below never
// resolve on their own, so the wait the message described could not end, and the message named no
// action that would end it. SillyTavern surfaces the distinction in exactly two places — a CSS tint
// on the globe icon, and an alert gated by `accountStorage['AlertWI_<avatar>']` that fires ONCE per
// card for the life of the install — so a user who dismissed it has no way left to see the state.
// This is the only place in the stack that can name it, which is why it names it precisely.
//
//   hasEmbeddedBook — the card file carries data.character_book (an import-time snapshot, never live).
//   primaryBookName — data.extensions.world: the worldbook LINKED to the card, '' / null when none.
//   knownBookNames  — every worldbook SillyTavern actually has. EMPTY MEANS UNKNOWN, not "none":
//                     the host reader returns [] both for "no books" and "the API did not answer",
//                     and inventing 'dangling-bind' out of an unknown is the same
//                     invisibility-as-absence mistake the header above is about.
//
// Verdicts:
//   'embedded-not-imported' — no link, but the card carries an embedded book. Import Card Lore.
//   'no-book-bound'         — no link and nothing embedded. Link or create one.
//   'dangling-bind'         — linked to a name SillyTavern does not have (renamed or deleted).
//   'loading'               — linked to a book that exists: the genuine wait, and the ONLY one.
export function cardBookProblem({ hasEmbeddedBook, primaryBookName, knownBookNames } = {}) {
    const linked = String(primaryBookName || '');
    if (!linked) return hasEmbeddedBook ? 'embedded-not-imported' : 'no-book-bound';
    const known = Array.isArray(knownBookNames) ? knownBookNames : [];
    if (known.length && !known.includes(linked)) return 'dangling-bind';
    return 'loading';
}

// The sentence for a 'card-unreadable' verdict. ONE wording per state, because the nine copies this
// replaces had drifted into nine near-identical lies. `suffix` is the uninstall lanes' extra clause
// (they refuse for the same reason but must say what refusing protects). `canLink` splits the embedded
// case in two — see embeddedBookResolution.
export function cardUnreadableReason({ binding, bookName, suffix, canLink = false } = {}) {
    const tail = suffix ? ' ' + suffix : '';
    switch (binding) {
        case 'embedded-not-imported':
            // Two different fixes wear this one verdict. When a worldbook of the card's own name already
            // exists, the lore is NOT missing — only the LINK is, and re-importing would overwrite a good
            // book with an identical copy (live 2026-08-31: "Your Wives" and a 48-entry book, byte-equal).
            return canLink
                ? 'this card is not LINKED to a worldbook, though "' + String(bookName || '') + '" already exists'
                    + ' and holds its lore. Linking it writes nothing and loses nothing.'
                    + ' Waiting will not help: a missing link never appears on its own.' + tail
                : 'this card\'s lore is EMBEDDED in the card file and has not been imported, so SillyTavern has'
                    + ' no worldbook to write to. On the character panel open the "More..." dropdown and choose'
                    + ' "Import Card Lore" — that converts the embedded book into a real worldbook and links it.'
                    + ' Waiting will not help: an embedded book never becomes readable on its own.' + tail;
        case 'no-book-bound':
            return 'this card has NO worldbook linked, and carries no embedded lore to import — so there is'
                + ' nothing for an artifact to write into. Installing anything offers to create one and link it;'
                + ' the globe icon on the character panel ("Link to World Info") is the manual route.'
                + ' Waiting will not help: nothing is loading.' + tail;
        case 'dangling-bind':
            return 'this card is linked to the worldbook "' + String(bookName || '') + '", but SillyTavern has no'
                + ' book by that name — it was renamed or deleted. Re-link the card from the globe icon on the'
                + ' character panel. Waiting will not help.' + tail;
        default:
            return 'this card\'s worldbook could not be read yet — it is still loading, or the lorebook API is'
                + ' not attached. Retry in a moment.' + tail;
    }
}

// May we hand SillyTavern's own importEmbeddedWorldInfo() the wheel? PURE, because the hazard is a
// COMPARISON and comparisons are exactly what belongs outside a host-coupled file (L6).
//
// THE HAZARD: ST's import reads its target card from `$('#import_character_info').data('chid')`,
// which `checkEmbeddedWorld` sets on select — and on a card with NO embedded book that function only
// HIDES the button, it never clears the id. So the attribute can still name the PREVIOUS card, while
// the bind that follows the import (`#character_world` change, setWorldInfoButtonClass) lands on the
// card open NOW. Calling it blind would import card A's lorebook and link it to card B.
//
//   buttonChid         — what '#import_character_info' currently claims (may be stale, may be absent)
//   currentCharacterId — the open card's index
//   hasEmbeddedBook    — does the OPEN card carry data.character_book?
//
// Verdicts: 'ok' · 'no-card' · 'nothing-embedded' · 'stale-target' (never 'ok' on a mismatch).
export function embeddedImportSafety({ buttonChid, currentCharacterId, hasEmbeddedBook } = {}) {
    const now = String(currentCharacterId == null ? '' : currentCharacterId);
    if (now === '') return 'no-card';
    if (!hasEmbeddedBook) return 'nothing-embedded';
    if (String(buttonChid == null ? '' : buttonChid) !== now) return 'stale-target';
    return 'ok';
}

// The name SillyTavern will give the imported book — its own derivation, mirrored so the caller can
// see a COLLISION coming (importEmbeddedWorldInfo's saveWorldInfo overwrites a book of the same name,
// and the dialog that warns about that is the one we suppress by asking first). ST's rule:
// `character_book.name` when the embedded book carries one, else "<character name>'s Lorebook".
export function embeddedBookName({ bookTitle, characterName } = {}) {
    const title = String(bookTitle || '').trim();
    return title || (String(characterName || '') + '\'s Lorebook');
}

// LINK or IMPORT? The whole decision, in one pure line, because the wrong branch is destructive and
// the right one is free.
//
// A card whose lore is embedded and unlinked has TWO possible histories, and they need opposite
// actions. If no worldbook of its name exists, the lore really is only inside the card file and must
// be converted out — that is an import. If one DOES exist, the lore is already on disk and the card
// has merely lost its pointer; importing would call saveWorldInfo on that name and OVERWRITE a good
// book with a copy. Linking writes nothing at all, so it is never the worse choice — which is why
// this returns 'link' on ANY name match and does not compare contents first. A book that differs is
// still not something to destroy, and the difference is reported (not decided on) by the caller.
//
// `knownBookNames` empty means UNKNOWN, exactly as in cardBookProblem — and here the safe reading is
// 'import', because that path re-checks the name itself before writing (importEmbeddedCardBook).
export function embeddedBookResolution({ bookName, knownBookNames } = {}) {
    const name = String(bookName || '');
    if (!name) return 'import';
    const known = Array.isArray(knownBookNames) ? knownBookNames : [];
    return known.includes(name) ? 'link' : 'import';
}

// What the repair actually DID, in words. One sentence per outcome, in one place, because the four
// call sites all said "Imported" while half of them had linked — a toast that names the wrong verb
// teaches the wrong model of what just happened to the card.
export function cardBookRepairMessage({ action, bookName } = {}) {
    const name = String(bookName || '');
    switch (action) {
        case 'linked':   return 'Linked this card to the existing worldbook "' + name + '" — nothing was written to it.';
        case 'created':  return 'Created the worldbook "' + name + '" and linked it to this card.';
        case 'imported': return 'Imported this card\'s lore into a new worldbook, "' + name + '", and linked it.';
        default:         return '';
    }
}

// A worldbook name that is FREE — the card-with-no-lore case (user, 2026-08-31). The proposal is what
// SillyTavern itself would call the card's book, and a taken name gets a counter rather than being
// adopted: a card with no lore has no relationship to a book that merely shares its derived name, so
// linking that stranger's book would be a guess, and creating over it would be destruction. Neither.
//
// `knownBookNames` empty means UNKNOWN here as everywhere else, and the base name is returned — the
// create step is `ensureLorebookExists`, which is create-only and returns an existing book untouched,
// so an unknown list can never overwrite anything.
export function freeLorebookName({ base, knownBookNames } = {}) {
    const name = String(base || '').trim();
    if (!name) return '';
    const known = Array.isArray(knownBookNames) ? knownBookNames : [];
    if (!known.includes(name)) return name;
    for (let n = 2; n < 1000; n++) {
        const candidate = name + ' ' + n;
        if (!known.includes(candidate)) return candidate;
    }
    return name + ' ' + Date.now();     // a thousand collisions is not a naming problem any more
}
