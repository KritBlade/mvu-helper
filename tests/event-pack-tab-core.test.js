/**
 * MVU Helper — event-pack/event-pack-tab-core.js, what the Event Packs tab shows.
 *
 * An installed row is read from buildPackInfo's row, the same read MvuHelper.packInfo() reports, so the tab and the
 * diagnostic cannot disagree. What each row must hold: its state as a pill, a fired count that is never a guessed 0, and
 * a line saying what to do for the two states a user must act on.
 */
import { describe, it, expect } from 'vitest';
import { buildPackInfo, packEntryComment } from '../src/features/event-pack/event-pack-core.js';
import { installedPackRowView, libraryPackRowView, fileErrors, packPreviewView } from '../src/features/event-pack/event-pack-tab-core.js';

const packEntry = (id, version, keys, { isEnabled = true } = {}) => ({
    comment: packEntryComment(id),
    enabled: isEnabled,
    content: '<%_ if (false) { _%>\n<mvueventpack>\n' + JSON.stringify({
        format: '1.0', creator: 'test', event: 'Series', version,
        triggers: Object.fromEntries(keys.map((k) => [k, { cat: 'TRG', when: 'T>=00:01', fx: { summary: 's', scope: 'save' } }])),
    }) + '\n</mvueventpack>\n<%_ } _%>',
});
const KEYS = ['test_series_step1', 'test_series_step2'];
const STAT_DATA = { EventPack: { triggers: {}, fired: { test_series_step1: { state: 'done' } } } };

function rowFor({ entries = [packEntry('test.series', '3.0', KEYS)], stored = [{ id: 'test.series', version: '3.0', events: 2, parseError: '' }],
    enginePaths = { ok: true, triggerRoot: 'EventPack.triggers' } } = {}) {
    const info = buildPackInfo({ entries, registry: { 'test.series': { ver: '3.0' } }, stored, statData: STAT_DATA, enginePaths });
    return installedPackRowView(info.card.packs[0]);
}

describe('installedPackRowView — from the packInfo row', () => {
    it('installed and complete: the version, the events and how many fired', () => {
        const view = rowFor();
        expect(view.pill).toEqual({ text: 'Installed', status: 'success' });
        expect(view.sub).toEqual([{ parts: [{ name: 'v3.0' }, { name: ' · 2 ' }, { text: 'events' }, { name: ' · ' }, { name: '1 ' }, { text: 'fired' }] }]);
        expect(view.toggle).toBe('disable');
    });

    // MUTATION TARGET: with no trigger table to read, "0 fired" would be a claim about the save that cannot be made.
    it('an engine that names no trigger table: the fired count is unknown, never 0', () => {
        const parts = rowFor({ enginePaths: { ok: false, reason: 'no adapter' } }).sub[0].parts;
        expect(parts.slice(-1)).toEqual([{ text: 'fired state unknown' }]);
        expect(parts).not.toContainEqual({ name: '0 ' });
    });

    it('disabled: the pill says so and the toggle enables', () => {
        const view = rowFor({ entries: [packEntry('test.series', '3.0', KEYS, { isEnabled: false })] });
        expect(view.pill).toEqual({ text: 'Disabled', status: 'neutral' });
        expect(view.toggle).toBe('enable');
    });

    it('entry missing: no toggle, and a line saying what to do', () => {
        const view = rowFor({ entries: [] });
        expect(view.pill).toEqual({ text: 'Entry missing', status: 'danger' });
        expect(view.toggle).toBe('');
        expect(view.sub).toEqual([{ parts: [{ name: 'v3.0' }] }, { text: 'Its lorebook entry is gone: install it again from the library, or uninstall it.' }]);
    });

    it('no library copy: a warning, and a line saying how to keep one', () => {
        const view = rowFor({ stored: [] });
        expect(view.pill).toEqual({ text: 'No library copy', status: 'warning' });
        expect(view.sub[1]).toEqual({ text: 'Not in the library: import it again to keep a copy a card rebuild cannot lose.' });
    });

    it('a library that cannot be read is not "no library copy"', () => {
        expect(rowFor({ stored: null }).pill).toEqual({ text: 'Installed', status: 'success' });
    });

    it('a state it does not know reads as entry missing', () => {
        expect(installedPackRowView({ led: 'purple', version: '1', events: 0, fired: -1, entryPresent: true, entryEnabled: true }).pill.text).toBe('Entry missing');
    });
});

describe('libraryPackRowView', () => {
    it('a stored pack: its version and events, and an install', () => {
        expect(libraryPackRowView({ id: 'p', version: '1.2', events: 5, parseError: '' })).toEqual({
            pills: [], sub: [{ parts: [{ name: 'v1.2 · 5 ' }, { text: 'events' }] }], canInstall: true,
        });
    });

    it('one installed on the open card says so', () => {
        expect(libraryPackRowView({ id: 'p', version: '1', events: 1, parseError: '' }, { isOnThisCard: true }).pills).toEqual([{ text: 'Installed here', status: 'accent' }]);
    });

    it('a stored file that no longer parses: a danger pill, its error, and no install', () => {
        expect(libraryPackRowView({ id: 'p', version: '', events: 0, parseError: 'bad JSON' })).toEqual({
            pills: [{ text: 'Does not parse', status: 'danger' }], sub: [{ name: 'bad JSON' }], canInstall: false,
        });
    });
});

describe('packPreviewView and fileErrors', () => {
    const pack = (packId, triggers, extra = {}) => ({ pack: { packId, version: '2.0', triggers }, action: 'install', errors: [], warnings: [], ...extra });

    it('one valid pack: its line, each event with its condition, then "Pack is valid"; no heading', () => {
        const view = packPreviewView({ packs: [pack('a.b', { k1: { series: 's', when: 'T>=1' }, k2: { whenAny: ['x', 'y'] } })], errors: [], warnings: [] });
        expect(view.heading).toBeNull();
        expect(view.lines).toEqual([
            { icon: 'fa-calendar-days', parts: [{ name: 'a.b v2.0 · ' }, { text: 'series' }, { name: ' s · 2 ' }, { text: 'events' }] },
            { icon: 'fa-angle-right', parts: [{ name: 'k1 ' }, { code: 'T>=1' }] },
            { icon: 'fa-angle-right', parts: [{ name: 'k2 ' }, { code: 'x  OR  y' }] },
            { text: 'Pack is valid', status: 'success' },
        ]);
    });

    it('several packs: a heading says they install together; an upgrade names the version it replaces', () => {
        const view = packPreviewView({ packs: [pack('a', {}), pack('b', {}, { action: 'upgrade', installedVer: '1.0' })], errors: [], warnings: [] });
        expect(view.heading).toEqual({ parts: [{ name: '2 ' }, { text: 'packs in this file' }, { name: ' — ' }, { text: 'all install together or none do' }] });
        expect(view.lines[1].parts.slice(-3)).toEqual([{ name: ' · ' }, { text: 'upgrade from' }, { name: ' v1.0' }]);
    });

    it('errors and warnings are shown, tagged with their pack, the file\'s own last; with an error, no "valid" line', () => {
        const result = { packs: [pack('a', {}, { errors: ['bad key'], warnings: ['odd'] })], errors: ['block #2: no JSON'], warnings: ['w'] };
        const view = packPreviewView(result);
        expect(view.lines.slice(1)).toEqual([
            { status: 'danger', name: 'a: bad key' },
            { status: 'warning', name: 'a: odd' },
            { status: 'danger', name: 'block #2: no JSON' },
            { status: 'warning', name: 'w' },
        ]);
        expect(fileErrors(result)).toEqual(['block #2: no JSON', 'a: bad key']);
    });
});
