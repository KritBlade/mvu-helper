/**
 * MVU Helper — buildAllPackInfo / normalizeInstalledRecords (pack-info/pack-info-core.js)
 *
 * The all-artifact install report behind globalThis.MvuHelper.packInfo(). Four packTypes share one
 * library book and one card but NOT one registry shape — gamelogic and statusmenu each record ONE
 * active artifact, plugin records an array, event-pack a map — so "what is installed?" used to be
 * answered per-tab, by eye. Coverage targets the flattening and the `disagreements` verdict.
 *
 * Run:  npm test
 */

import { describe, it, expect } from 'vitest';
import { buildAllPackInfo, normalizeInstalledRecords } from '../src/features/pack-info/pack-info-core.js';

describe('normalizeInstalledRecords — four registry shapes, one row shape', () => {
    it('reads the gamelogic registry ONE active pack', () => {
        const rows = normalizeInstalledRecords('gamelogic', {
            activePackId: 'school-v4', ver: '5.60', name: 'ArtificKoi — School v4',
            installedComments: ['a', 'b'], engineOwned: true, schemaOwned: true,
            exposes: { 'cast@1': 'Classmate' }, installedRegexNames: ['x'], installedAt: '2026-09-09',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('school-v4');
        expect(rows[0].version).toBe('5.60');
        expect(rows[0].entryCount).toBe(2);
        expect(rows[0].detail.engineOwned).toBe(true);
        expect(rows[0].detail.exposes).toEqual({ 'cast@1': 'Classmate' });
    });

    it('reads the statusmenu registry active menu', () => {
        const rows = normalizeInstalledRecords('statusmenu', {
            activeMenuId: 'artifickoi', ver: '2.1', installedComments: ['a'], shellOwned: true,
        });
        expect(rows.map((r) => [r.id, r.version, r.detail.shellOwned])).toEqual([['artifickoi', '2.1', true]]);
    });

    it('reads the plugin registry ARRAY — many at once', () => {
        const rows = normalizeInstalledRecords('plugin', {
            activePlugins: [
                { id: 'galgame', ver: '1.2', stateName: 'Galgame', boundCalls: { pre: 'p', post: '' }, requires: ['cast@1'] },
                { id: 'sidepanel', ver: '0.4', stateName: 'Panel', boundCalls: {}, installedComments: ['a', 'b', 'c'] },
            ],
        });
        expect(rows.map((r) => r.id)).toEqual(['galgame', 'sidepanel']);
        expect(rows[0].detail.requires).toEqual(['cast@1']);
        expect(rows[1].entryCount).toBe(3);
    });

    it('reads the event-pack registry MAP', () => {
        const rows = normalizeInstalledRecords('eventpack', { 'test.series': { ver: '3.0' }, 'x.y': { ver: '1.0' } });
        expect(rows.map((r) => [r.id, r.version])).toEqual([['test.series', '3.0'], ['x.y', '1.0']]);
    });

    it('returns nothing for an absent registry rather than throwing', () => {
        expect(normalizeInstalledRecords('gamelogic', null)).toEqual([]);
        expect(normalizeInstalledRecords('nosuchtype', { a: 1 })).toEqual([]);
    });
});

// A card with one artifact of each type, and a library holding the same four at the same versions.
function healthy(overrides = {}) {
    return {
        boundWorld: 'ArtificKoi',
        worldbookReadable: true,
        byType: {
            gamelogic: { state: 'ok', problem: '', parsed: { activePackId: 'school-v4', ver: '5.60', installedComments: [] } },
            statusmenu: { state: 'ok', problem: '', parsed: { activeMenuId: 'artifickoi', ver: '2.1', installedComments: [] } },
            plugin: { state: 'ok', problem: '', parsed: { activePlugins: [{ id: 'galgame', ver: '1.2' }] } },
            eventpack: { state: 'ok', problem: '', parsed: { 'test.series': { ver: '3.0' } } },
        },
        library: [
            { packType: 'gamelogic', id: 'school-v4', name: 'School v4', version: '5.60', parseError: '' },
            { packType: 'statusmenu', id: 'artifickoi', name: 'Menu', version: '2.1', parseError: '' },
            { packType: 'plugin', id: 'galgame', name: 'Galgame', version: '1.2', parseError: '' },
            { packType: 'eventpack', id: 'test.series', name: '', version: '3.0', parseError: '' },
        ],
        eventPackDetail: null,
        ...overrides,
    };
}

describe('buildAllPackInfo — all four lanes at once', () => {
    it('reports every type with no disagreements when card and library match', () => {
        const info = buildAllPackInfo(healthy());
        expect(info.disagreements).toEqual([]);
        expect(Object.keys(info.types).sort()).toEqual(['eventpack', 'gamelogic', 'plugin', 'statusmenu']);
        expect(info.types.gamelogic.installedCount).toBe(1);
        expect(info.types.plugin.activeAtOnce).toBe('many');
        expect(info.types.gamelogic.activeAtOnce).toBe(1);
        expect(info.library.packs.every((p) => p.onThisCard)).toBe(true);
    });

    it('names a card copy that has drifted from the library copy', () => {
        const args = healthy();
        args.library[0].version = '5.44';
        const info = buildAllPackInfo(args);
        expect(info.disagreements).toEqual([
            'GameLogic Pack "school-v4": installed v5.60 but the library holds v5.44',
        ]);
    });

    it('names an installed artifact the library can no longer restore', () => {
        const args = healthy();
        args.library = args.library.filter((r) => r.packType !== 'plugin');
        const info = buildAllPackInfo(args);
        expect(info.disagreements).toEqual([
            'GameLogic Plugin "galgame": installed on this card but NOT in the library — a card rebuild could not get it back',
        ]);
    });

    it('names a malformed registry instead of reading it as nothing installed', () => {
        const args = healthy();
        args.byType.statusmenu = { state: 'malformed', problem: 'has no "activeMenuId"', parsed: null };
        const info = buildAllPackInfo(args);
        expect(info.disagreements).toContain('StatusMenu Pack: its registry entry is malformed — has no "activeMenuId"');
        expect(info.types.statusmenu.installedCount).toBe(0);
        expect(info.types.statusmenu.registryState).toBe('malformed');
    });

    it('distinguishes a type with no registry entry from one that would not parse', () => {
        const args = healthy();
        args.byType.plugin = { state: 'missing', problem: '', parsed: null };
        const info = buildAllPackInfo(args);
        expect(info.types.plugin.registryState).toBe('missing');
        expect(info.disagreements).toEqual([]);   // nothing installed is not a defect
    });

    it('surfaces a library file that no longer parses', () => {
        const args = healthy();
        args.library.push({ packType: 'gamelogic', id: 'broken', name: '', version: '', parseError: 'bad JSON' });
        const info = buildAllPackInfo(args);
        expect(info.disagreements).toContain('library "broken" (gamelogic): stored file no longer parses — bad JSON');
    });

    it('leaves inLibrary UNKNOWN rather than false when the library could not be read', () => {
        const info = buildAllPackInfo(healthy({ library: null }));
        expect(info.library.readable).toBe(false);
        expect(info.types.gamelogic.installed[0].inLibrary).toBe(null);
        expect(info.disagreements).toEqual([]);   // unknown must never read as "about to be lost"
    });

    it('folds the event-pack lane deeper findings in rather than recomputing them', () => {
        const info = buildAllPackInfo(healthy({
            eventPackDetail: { disagreements: ['test.series: worldbook entry is v3.0 but the stat_data watermark says v2.0'], library: { readable: true, packs: [] } },
        }));
        expect(info.disagreements).toEqual([
            'test.series: worldbook entry is v3.0 but the stat_data watermark says v2.0',
        ]);
        expect(info.eventPackDetail).not.toBe(null);
    });
});

describe('buildAllPackInfo — where it read from', () => {
    it('names the bound standalone world and warns off the embedded book', () => {
        const info = buildAllPackInfo(healthy());
        expect(info.source.cardReadFrom).toContain('standalone worldbook "ArtificKoi"');
        expect(info.source.warning).toContain('character_book');
        expect(info.source.worldbookReadable).toBe(true);
    });

    it('says nothing is readable when no world is bound', () => {
        const info = buildAllPackInfo(healthy({ boundWorld: '', worldbookReadable: false }));
        expect(info.source.cardReadFrom).toContain('no bound worldbook');
    });
});
