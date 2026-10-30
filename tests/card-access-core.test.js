// tests/card-access-core.test.js — the shared lobby/loading/unstarted ordering every per-card lane
// now consumes (card-access-core.js). Both live bugs it exists to end are pinned here IN ADDITION to
// the lane-level tests: the lanes test their wording, this file tests the one ordering they share.

import { describe, it, expect } from 'vitest';
import { cardAccessProblem, cardBookProblem, cardUnreadableReason, embeddedImportSafety, embeddedBookName, embeddedBookResolution, cardBookRepairMessage, freeLorebookName } from '../src/sillytavern/card-access-core.js';

describe('cardAccessProblem — the one ordering', () => {
    it('all three facts hold ⇒ null, the operation may proceed', () => {
        expect(cardAccessProblem({ isCardOpen: true, isChatStarted: true, areEntriesReadable: true })).toBeNull();
    });

    // THE LOBBY (live bug #2): its placeholder chat HAS messages and its book never answers, so a
    // message-count test plus an unreadable-first ordering told a lobby user to wait for a book that
    // would never load. No card ⇒ 'no-chat', whatever the other facts claim.
    it('the lobby is no-chat even with messages and an unreadable book', () => {
        expect(cardAccessProblem({ isCardOpen: false, isChatStarted: true, areEntriesReadable: false })).toBe('no-chat');
    });

    it('no card open refuses no-chat whatever else is true', () => {
        for (const isChatStarted of [true, false]) {
            for (const areEntriesReadable of [true, false]) {
                expect(cardAccessProblem({ isCardOpen: false, isChatStarted, areEntriesReadable })).toBe('no-chat');
            }
        }
    });

    // THE LOADING CARD (live bug #1): a card open with a book that has not answered yet is a WAIT,
    // and reporting it as "no chat" told a user with an installed, running pack to open a chat.
    it('a card whose book has not answered is card-unreadable, never no-chat', () => {
        expect(cardAccessProblem({ isCardOpen: true, isChatStarted: true, areEntriesReadable: false })).toBe('card-unreadable');
    });

    // Unreadable outranks the message count: an unread book is not an empty one, and the count read
    // off it means nothing yet.
    it('unreadable wins over an unstarted chat while the card is open', () => {
        expect(cardAccessProblem({ isCardOpen: true, isChatStarted: false, areEntriesReadable: false })).toBe('card-unreadable');
    });

    it('a card open on an unstarted chat with a readable book is the classic §6 no-chat', () => {
        expect(cardAccessProblem({ isCardOpen: true, isChatStarted: false, areEntriesReadable: true })).toBe('no-chat');
    });

    it('missing input refuses rather than proceeding', () => {
        expect(cardAccessProblem()).toBe('no-chat');
        expect(cardAccessProblem({})).toBe('no-chat');
    });
});

// ── WHY the book did not answer (2026-08-31) ─────────────────────────────────
//
// The live bug: a card carrying an EMBEDDED character_book but no linked worldbook said "retry in a
// moment" forever. Three of the four states never resolve, so each needs its own instruction, and the
// wrong one is worse than none — it describes a wait that cannot end.
describe('cardBookProblem — which kind of unreadable', () => {
    it('no link + an embedded book ⇒ embedded-not-imported (the live bug)', () => {
        expect(cardBookProblem({ hasEmbeddedBook: true, primaryBookName: '', knownBookNames: ['Other'] }))
            .toBe('embedded-not-imported');
        expect(cardBookProblem({ hasEmbeddedBook: true, primaryBookName: null, knownBookNames: [] }))
            .toBe('embedded-not-imported');
    });

    it('no link and nothing embedded ⇒ no-book-bound', () => {
        expect(cardBookProblem({ hasEmbeddedBook: false, primaryBookName: '', knownBookNames: ['Other'] }))
            .toBe('no-book-bound');
    });

    it('linked to a book SillyTavern does not have ⇒ dangling-bind', () => {
        expect(cardBookProblem({ hasEmbeddedBook: false, primaryBookName: 'Gone', knownBookNames: ['A', 'B'] }))
            .toBe('dangling-bind');
    });

    it('linked to a book that exists ⇒ loading, the only genuine wait', () => {
        expect(cardBookProblem({ hasEmbeddedBook: false, primaryBookName: 'A', knownBookNames: ['A', 'B'] }))
            .toBe('loading');
        // An embedded book alongside a working link changes nothing: the link is what is read.
        expect(cardBookProblem({ hasEmbeddedBook: true, primaryBookName: 'A', knownBookNames: ['A'] }))
            .toBe('loading');
    });

    // The invisibility-as-absence rule, and the reason the host reader's [] is safe to pass: it means
    // BOTH "no books" and "the API did not answer", so a dangling verdict off it would be invented.
    it('an empty or missing book list is UNKNOWN, never proof of a dangling bind', () => {
        expect(cardBookProblem({ hasEmbeddedBook: false, primaryBookName: 'A', knownBookNames: [] })).toBe('loading');
        expect(cardBookProblem({ hasEmbeddedBook: false, primaryBookName: 'A', knownBookNames: null })).toBe('loading');
        expect(cardBookProblem({ hasEmbeddedBook: false, primaryBookName: 'A' })).toBe('loading');
    });

    it('nothing known at all reads as no-book-bound — link one is the instruction that helps', () => {
        expect(cardBookProblem()).toBe('no-book-bound');
        expect(cardBookProblem({})).toBe('no-book-bound');
    });
});

describe('cardUnreadableReason — one wording per state', () => {
    // Each never-resolving state must NAME its fix and must NOT tell the user to wait. The negative
    // half is the point: "retry in a moment" was the whole bug.
    it('embedded-not-imported names Import Card Lore and denies the wait', () => {
        const s = cardUnreadableReason({ binding: 'embedded-not-imported' });
        expect(s).toContain('Import Card Lore');
        expect(s).toContain('More...');
        expect(s).toContain('Waiting will not help');
        expect(s).not.toContain('Retry in a moment');
    });

    it('no-book-bound names Link to World Info and denies the wait', () => {
        const s = cardUnreadableReason({ binding: 'no-book-bound' });
        expect(s).toContain('Link to World Info');
        expect(s).toContain('Waiting will not help');
        expect(s).not.toContain('Retry in a moment');
    });

    it('dangling-bind names the missing book so the user can find it', () => {
        const s = cardUnreadableReason({ binding: 'dangling-bind', bookName: "Flora's Lore" });
        expect(s).toContain('"Flora\'s Lore"');
        expect(s).toContain('renamed or deleted');
        expect(s).toContain('Waiting will not help');
    });

    it('loading is the ONLY state that says retry', () => {
        const s = cardUnreadableReason({ binding: 'loading' });
        expect(s).toContain('Retry in a moment');
        expect(s).not.toContain('Waiting will not help');
    });

    // An unwired lane (or a state read that could not run) must degrade to the honest generic wait,
    // never to a confident wrong instruction.
    it('an unknown or missing binding degrades to the generic wait', () => {
        expect(cardUnreadableReason()).toContain('Retry in a moment');
        expect(cardUnreadableReason({ binding: null })).toContain('Retry in a moment');
        expect(cardUnreadableReason({ binding: 'something-new' })).toContain('Retry in a moment');
    });

    it('the uninstall lanes\' suffix rides every state, spaced', () => {
        for (const binding of ['embedded-not-imported', 'no-book-bound', 'dangling-bind', 'loading']) {
            const s = cardUnreadableReason({ binding, suffix: '(SUFFIX.)' });
            expect(s).toContain(' (SUFFIX.)');
            expect(s.endsWith('(SUFFIX.)')).toBe(true);
        }
        expect(cardUnreadableReason({ binding: 'loading' })).not.toContain('(SUFFIX.)');
    });
});

// The guard on handing SillyTavern's own importEmbeddedWorldInfo() the wheel. It reads its target
// from a DOM data attribute that ST hides but never clears, so on a card switch it can still name the
// previous card while the bind lands on the current one — card A's lorebook, linked to card B.
describe('embeddedImportSafety — never import the wrong card\'s book', () => {
    it('the attribute agrees with the open card and there is a book ⇒ ok', () => {
        expect(embeddedImportSafety({ buttonChid: '6', currentCharacterId: '6', hasEmbeddedBook: true })).toBe('ok');
        // ST stores chid as a string in the DOM and a number in the context — the comparison must not
        // care, or every import would refuse itself.
        expect(embeddedImportSafety({ buttonChid: 6, currentCharacterId: '6', hasEmbeddedBook: true })).toBe('ok');
        expect(embeddedImportSafety({ buttonChid: '0', currentCharacterId: 0, hasEmbeddedBook: true })).toBe('ok');
    });

    it('a stale attribute from the PREVIOUS card refuses', () => {
        expect(embeddedImportSafety({ buttonChid: '2', currentCharacterId: '6', hasEmbeddedBook: true })).toBe('stale-target');
        expect(embeddedImportSafety({ buttonChid: undefined, currentCharacterId: '6', hasEmbeddedBook: true })).toBe('stale-target');
    });

    it('no embedded book on the open card refuses before the attribute is even read', () => {
        expect(embeddedImportSafety({ buttonChid: '6', currentCharacterId: '6', hasEmbeddedBook: false })).toBe('nothing-embedded');
    });

    it('no card open refuses first of all', () => {
        expect(embeddedImportSafety({ buttonChid: '6', currentCharacterId: null, hasEmbeddedBook: true })).toBe('no-card');
        expect(embeddedImportSafety({ buttonChid: '6', currentCharacterId: '', hasEmbeddedBook: true })).toBe('no-card');
        expect(embeddedImportSafety()).toBe('no-card');
    });
});

// SillyTavern's own name derivation, mirrored so a COLLISION can be seen coming: the import
// overwrites a book of the same name, and the dialog that says so is the one we suppress by asking
// first. Getting this wrong means the warning appears for the wrong name, or not at all.
describe('embeddedBookName — what SillyTavern will call the imported book', () => {
    it('the embedded book\'s own title wins when it has one', () => {
        expect(embeddedBookName({ bookTitle: 'Regency Lore', characterName: 'Flora' })).toBe('Regency Lore');
    });

    it('falls back to "<character>\'s Lorebook", ST\'s exact spelling', () => {
        expect(embeddedBookName({ bookTitle: '', characterName: 'Your Wives' })).toBe("Your Wives's Lorebook");
        expect(embeddedBookName({ characterName: 'Flora' })).toBe("Flora's Lorebook");
    });

    it('a whitespace-only title is not a title', () => {
        expect(embeddedBookName({ bookTitle: '   ', characterName: 'Flora' })).toBe("Flora's Lorebook");
    });
});

// LINK or IMPORT — the branch whose wrong side destroys a book and whose right side is free.
describe('embeddedBookResolution — link beats import whenever the name is taken', () => {
    it('a book of that name exists ⇒ link, WITHOUT comparing contents', () => {
        expect(embeddedBookResolution({ bookName: 'Flora Lore', knownBookNames: ['Flora Lore', 'X'] })).toBe('link');
    });

    it('no such book ⇒ import, the only case that may create one', () => {
        expect(embeddedBookResolution({ bookName: 'Flora Lore', knownBookNames: ['X', 'Y'] })).toBe('import');
    });

    it('an unknown book list falls to import, which re-checks the name before writing', () => {
        expect(embeddedBookResolution({ bookName: 'Flora Lore', knownBookNames: [] })).toBe('import');
        expect(embeddedBookResolution({ bookName: 'Flora Lore' })).toBe('import');
    });

    it('no derived name at all is never a link', () => {
        expect(embeddedBookResolution({ bookName: '', knownBookNames: ['X'] })).toBe('import');
        expect(embeddedBookResolution()).toBe('import');
    });
});

describe('cardUnreadableReason — the embedded case splits on canLink', () => {
    it('linkable says LINK and never mentions importing', () => {
        const s = cardUnreadableReason({ binding: 'embedded-not-imported', bookName: 'Flora Lore', canLink: true });
        expect(s).toContain('"Flora Lore"');
        expect(s).toContain('writes nothing and loses nothing');
        expect(s).not.toContain('Import Card Lore');
    });

    it('not linkable keeps the import instructions', () => {
        const s = cardUnreadableReason({ binding: 'embedded-not-imported', canLink: false });
        expect(s).toContain('Import Card Lore');
    });

    // A CARD WITH NO LOREBOOK AT ALL is a different verdict entirely, and canLink must not reach it:
    // there is no book of the card's name to link and nothing embedded to import.
    it('no-book-bound ignores canLink — nothing exists to link OR import', () => {
        for (const canLink of [true, false]) {
            const s = cardUnreadableReason({ binding: 'no-book-bound', bookName: 'Flora Lore', canLink });
            expect(s).toContain('Link to World Info');
            expect(s).not.toContain('writes nothing and loses nothing');
        }
    });
});

describe('cardBookRepairMessage — the toast names the verb that actually ran', () => {
    it('linked says linked, and says nothing was written', () => {
        const s = cardBookRepairMessage({ action: 'linked', bookName: 'Flora Lore' });
        expect(s).toContain('Linked');
        expect(s).toContain('nothing was written');
        expect(s).not.toContain('Imported');
    });

    it('imported says imported and says the book is new', () => {
        const s = cardBookRepairMessage({ action: 'imported', bookName: 'Flora Lore' });
        expect(s).toContain('Imported');
        expect(s).toContain('new worldbook');
        expect(s).not.toContain('Linked this card to the existing');
    });

    it('every non-outcome is empty, so a caller cannot toast a lie', () => {
        for (const action of ['declined', 'failed', 'none', undefined]) {
            expect(cardBookRepairMessage({ action, bookName: 'X' })).toBe('');
        }
        expect(cardBookRepairMessage()).toBe('');
    });
});

// A card with NO lore at all: nothing to link, nothing to import, so the only repair is to CREATE —
// and the name must be one nobody else is using, because a card with no lore has no claim on a book
// that merely shares its derived name.
describe('freeLorebookName — create, never adopt and never overwrite', () => {
    it('an unused name is used as-is', () => {
        expect(freeLorebookName({ base: "Flora's Lorebook", knownBookNames: ['X'] })).toBe("Flora's Lorebook");
    });

    it('a taken name steps to a counter rather than colliding', () => {
        expect(freeLorebookName({ base: 'Lore', knownBookNames: ['Lore'] })).toBe('Lore 2');
        expect(freeLorebookName({ base: 'Lore', knownBookNames: ['Lore', 'Lore 2', 'Lore 3'] })).toBe('Lore 4');
    });

    it('an unknown book list returns the base — the create step is create-only anyway', () => {
        expect(freeLorebookName({ base: 'Lore', knownBookNames: [] })).toBe('Lore');
        expect(freeLorebookName({ base: 'Lore' })).toBe('Lore');
    });

    it('no base is no name — never invents one', () => {
        expect(freeLorebookName({ base: '', knownBookNames: ['X'] })).toBe('');
        expect(freeLorebookName()).toBe('');
    });

    // The name a card with no embedded book gets: ST's own fallback spelling, so a user who later
    // looks in the Worlds panel sees the name SillyTavern would have chosen.
    it('composes with embeddedBookName to give ST\'s own fallback spelling', () => {
        const base = embeddedBookName({ bookTitle: '', characterName: 'Your Wives' });
        expect(freeLorebookName({ base, knownBookNames: [] })).toBe("Your Wives's Lorebook");
    });
});

describe('cardBookRepairMessage — created is its own verb', () => {
    it('created says created, and never claims a link to something pre-existing', () => {
        const s = cardBookRepairMessage({ action: 'created', bookName: 'Flora Lore' });
        expect(s).toContain('Created the worldbook "Flora Lore"');
        expect(s).not.toContain('existing');
        expect(s).not.toContain('Imported');
    });
});
