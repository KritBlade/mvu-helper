// tests/reply-block-placement.test.js — shared/reply-block-placement.js: where a writer puts a block it adds above
// something in a finished reply. The callers (the engine's end text, POST's blocks, the relay receipt) pass their
// own anchors, so the tests use stub ones.

import { describe, it, expect } from 'vitest';
import { placeAboveFirstAnchor } from '../src/shared/reply-block-placement.js';

describe('placeAboveFirstAnchor', () => {
    it('goes directly above the first anchor IN THE LIST\'S ORDER that the text carries, a blank line between', () => {
        const text = 'story\n\n<B/>\n\n<A/>';
        expect(placeAboveFirstAnchor(text, 'X', ['<A/>', '<B/>'])).toBe('story\n\n<B/>\n\nX\n\n<A/>');
        expect(placeAboveFirstAnchor(text, 'X', ['<Missing/>', '<B/>'])).toBe('story\n\nX\n\n<B/>\n\n<A/>');
    });
    it('uses the anchor\'s first occurrence', () => {
        expect(placeAboveFirstAnchor('<A/> and <A/>', 'X', ['<A/>'])).toBe('X\n\n<A/> and <A/>');
    });
    it('MUTATION TARGET — with no anchor in the text it goes after the text, trailing whitespace dropped', () => {
        expect(placeAboveFirstAnchor('story  \n\n', 'X', ['<A/>'])).toBe('story\n\nX');
        expect(placeAboveFirstAnchor('story', 'X', [])).toBe('story\n\nX');
        expect(placeAboveFirstAnchor('story', 'X', undefined)).toBe('story\n\nX');
    });
    it('an empty text gains no leading blank line; an empty block changes nothing', () => {
        expect(placeAboveFirstAnchor('', 'X', ['<A/>'])).toBe('X');
        expect(placeAboveFirstAnchor('story\n\n<A/>', '', ['<A/>'])).toBe('story\n\n<A/>');
    });
    it('MUTATION TARGET — the block is written literally: `$&` and `$1` are no replacement patterns', () => {
        expect(placeAboveFirstAnchor('s <A/>', 'pay $& and $1', ['<A/>'])).toBe('s pay $& and $1\n\n<A/>');
    });
});
