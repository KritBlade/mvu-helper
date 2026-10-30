/**
 * MVU Helper — sillytavern/popup-core.js: a dialog's lines. A fixed word comes out as a key the locale pass
 * translates; a value comes out as written; the same lines read as plain English in a log.
 */
import { describe, it, expect } from 'vitest';
import { dialogLineSegments, dialogLineText } from '../src/sillytavern/popup-core.js';

describe('dialogLineSegments', () => {
    it('a fixed sentence is one key', () => {
        expect(dialogLineSegments({ text: 'Delete this call?' })).toEqual([{ key: 'Delete this call?' }]);
    });

    it('a value is shown as written, strong', () => {
        expect(dialogLineSegments({ name: 'PRE' })).toEqual([{ value: 'PRE', isStrong: true }]);
        expect(dialogLineSegments({ name: 0 })).toEqual([{ value: '0', isStrong: true }]);
    });

    it('a lead-in keys its words and keeps the value apart', () => {
        expect(dialogLineSegments({ text: 'Card:', name: 'Mia' }))
            .toEqual([{ key: 'Card:' }, { value: ' ', isStrong: false }, { value: 'Mia', isStrong: true }]);
    });

    it('a mixed line keeps its segments in order; values in it are not strong', () => {
        expect(dialogLineSegments({ parts: [{ name: '12 ' }, { text: 'entries' }, { name: ', ' }, { text: 'engine' }] }))
            .toEqual([{ value: '12 ', isStrong: false }, { key: 'entries' }, { value: ', ', isStrong: false }, { key: 'engine' }]);
    });

    it('MUTATION TARGET — a leading icon comes first, on any shape', () => {
        expect(dialogLineSegments({ text: 'This pack can reach outside the game.', icon: 'fa-circle-exclamation' }))
            .toEqual([{ icon: 'fa-circle-exclamation' }, { key: 'This pack can reach outside the game.' }]);
        expect(dialogLineSegments({ icon: 'fa-angle-right', parts: [{ name: '3 ' }, { text: 'regexes' }] }))
            .toEqual([{ icon: 'fa-angle-right' }, { value: '3 ', isStrong: false }, { key: 'regexes' }]);
    });

    it('MUTATION TARGET — an icon that is not a Font Awesome class, or on a line with nothing else, shows nothing', () => {
        expect(dialogLineSegments({ text: 'x', icon: 'fa-x" onclick="y' })).toEqual([{ key: 'x' }]);
        expect(dialogLineSegments({ text: 'x', icon: 'circle' })).toEqual([{ key: 'x' }]);
        expect(dialogLineSegments({ icon: 'fa-circle-exclamation' })).toEqual([]);
    });

    it('empty pieces and unknown shapes show nothing', () => {
        expect(dialogLineSegments({ text: '', name: '' })).toEqual([]);
        expect(dialogLineSegments({ text: 'Card:', name: null })).toEqual([{ key: 'Card:' }]);
        expect(dialogLineSegments('Delete?')).toEqual([]);
        expect(dialogLineSegments(null)).toEqual([]);
        expect(dialogLineSegments({ parts: [null, { name: '' }, { text: 'x' }] })).toEqual([{ key: 'x' }]);
    });
});

describe('dialogLineText', () => {
    it('reads every shape as plain English', () => {
        expect(dialogLineText({ text: 'Delete this call?' })).toBe('Delete this call?');
        expect(dialogLineText({ text: 'Card:', name: 'Mia' })).toBe('Card: Mia');
        expect(dialogLineText({ parts: [{ name: '3 ' }, { text: 'regexes' }] })).toBe('3 regexes');
        expect(dialogLineText({ text: 'Careful.', icon: 'fa-circle-exclamation' })).toBe('Careful.');
        expect(dialogLineText(undefined)).toBe('');
    });
});
