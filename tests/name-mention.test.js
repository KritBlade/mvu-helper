/**
 * MVU Helper — is a name written in a text (shared/name-mention.js).
 *
 * The roster's ON FILE scan and the image pipeline's main-character check both ask it, so a name counts the
 * same way wherever it is looked for.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import { mentionsName } from '../src/shared/name-mention.js';

describe('mentionsName — is a name written in the text', () => {
    it('MUTATION TARGET — a Latin-script name: no Latin letter or digit may touch either end', () => {
        expect(mentionsName('the life manager', 'Mana')).toBe(false);
        expect(mentionsName('the Amana family', 'Mana')).toBe(false);
        expect(mentionsName('Mana2 waved', 'Mana')).toBe(false);
        expect(mentionsName("Mitsuki's bag", 'Mitsuki')).toBe(true);
        expect(mentionsName('Mitsuki-chan!', 'Mitsuki')).toBe(true);
        expect(mentionsName('<cast name="Kamiya">', 'Kamiya')).toBe(true);
    });

    it('ignores case, and matches a Latin-script name of several words whole', () => {
        expect(mentionsName('ANN opened the door.', 'ann')).toBe(true);
        expect(mentionsName('Mitsuki Tachibana waved', 'Mitsuki Tachibana')).toBe(true);
        expect(mentionsName('Mitsuki waved', 'Mitsuki Tachibana')).toBe(false);
    });

    // Those scripts put no space between words, so a name in one counts wherever it appears.
    it('MUTATION TARGET — a name in another script counts wherever it appears', () => {
        expect(mentionsName('她和柚月一起走', '柚月')).toBe(true);
        expect(mentionsName('薇歐拉 drew the dagger.', '薇歐拉')).toBe(true);
        expect(mentionsName('АННА вошла', 'Анна')).toBe(true);
        expect(mentionsName('柚月san waved', '柚月')).toBe(true);
        expect(mentionsName('room 3柚月', '柚月')).toBe(true);
        expect(mentionsName('nobody here', '柚月')).toBe(false);
    });

    it('no name, or a name with no letter, is never found', () => {
        expect(mentionsName('Ann', '')).toBe(false);
        expect(mentionsName('', 'Ann')).toBe(false);
        expect(mentionsName('2026 was the year', '2026')).toBe(false);
    });

    it('MUTATION TARGET — a name is read literally, never as a pattern', () => {
        expect(mentionsName('Mr. Smith arrived', 'Mr. Smith')).toBe(true);
        expect(mentionsName('Mrs Smith arrived', 'Mr. Smith')).toBe(false);
    });
});
