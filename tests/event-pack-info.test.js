/**
 * MVU Helper — buildPackInfo (event-pack/event-pack-core.js)
 *
 * The read-only "what is actually installed?" report behind globalThis.MvuHelper.packInfo(). It
 * exists because answering that by hand reads the WRONG store: a card's embedded character_book is a
 * build-time snapshot ST ignores whenever a standalone world is bound, and both
 * ctx.characters[].data.character_book and POST /api/characters/get return that same snapshot — so
 * the two agree while both are stale, and the agreement reads as confirmation. Live 2026-09-09: the
 * bound world held a pack at v3.0, the embedded book at v2.0, and the tab's correct "installed and
 * complete" was reported to the user as a lie.
 *
 * Coverage targets the verdict field (`disagreements`) and the source labelling that prevents the
 * repeat, not the plumbing.
 *
 * Run:  npm test
 */

import { describe, it, expect } from 'vitest';
import { buildPackInfo, packEntryComment } from '../src/features/event-pack/event-pack-core.js';

// One pack entry as the worldbook holds it: hidden JSON block + a gated prose body.
const packEntry = (id, version, keys) => ({
    comment: packEntryComment(id),
    enabled: true,
    content: '<%_ if (false) { _%>\n<mvueventpack>\n' + JSON.stringify({
        format: '1.0', creator: 'test', event: 'Series', version,
        triggers: Object.fromEntries(keys.map((k) => [k, { cat: 'TRG', when: 'T>=00:01', fx: { summary: 's', scope: 'save' } }])),
    }) + '\n</mvueventpack>\n<%_ } _%>',
});

const ENGINE_PATHS = { ok: true, triggerRoot: 'EventPack.triggers' };

// The healthy world: entry, registry, watermark and library all at the same version.
function agreeing(overrides = {}) {
    const keys = ['test_series_step1', 'test_series_step2'];
    return {
        boundWorld: 'ArtificKoi',
        entries: [packEntry('test.series', '3.0', keys)],
        registry: { 'test.series': { ver: '3.0' } },
        stored: [{ id: 'test.series', version: '3.0', events: 2, parseError: '' }],
        statData: {
            EventPack: {
                triggers: Object.fromEntries(keys.map((k) => [k, {}])),
                installed: { 'test.series': { ver: '3.0', keys } },
                fired: { test_series_step1: { state: 'done', scope: 'save', at: '2026-04-08 07:55' } },
            },
        },
        enginePaths: ENGINE_PATHS,
        ...overrides,
    };
}

describe('buildPackInfo — the verdict', () => {
    it('reports no disagreements when every store holds the same version', () => {
        const info = buildPackInfo(agreeing());
        expect(info.disagreements).toEqual([]);
        expect(info.card.packs[0].version).toBe('3.0');
        expect(info.card.packs[0].led).toBe('green');
    });

    it('names the store that disagrees with the worldbook entry — the live 2026-09-09 case', () => {
        const args = agreeing();
        args.statData.EventPack.installed['test.series'].ver = '2.0';
        const info = buildPackInfo(args);
        expect(info.disagreements).toEqual([
            'test.series: worldbook entry is v3.0 but the stat_data watermark says v2.0',
        ]);
    });

    it('flags the registry and the library independently of each other', () => {
        const args = agreeing();
        args.registry['test.series'].ver = '2.0';
        args.stored[0].version = '1.0';
        const info = buildPackInfo(args);
        expect(info.disagreements).toEqual([
            'test.series: worldbook entry is v3.0 but the registry says v2.0',
            'test.series: worldbook entry is v3.0 but the library says v1.0',
        ]);
    });

    it('calls out a registered pack whose worldbook entry is gone', () => {
        const info = buildPackInfo(agreeing({ entries: [] }));
        expect(info.disagreements).toEqual([
            'test.series: recorded in the registry but its worldbook entry is MISSING — reinstall or uninstall',
        ]);
        expect(info.card.packs[0].led).toBe('red');
        expect(info.card.packs[0].entryPresent).toBe(false);
    });

    it('calls out an installed pack whose rows never reached this chat', () => {
        const args = agreeing();
        args.statData.EventPack.triggers = {};
        const info = buildPackInfo(args);
        expect(info.disagreements).toEqual([
            "test.series: the entry carries 2 row(s) but none are in this chat's EventPack.triggers — the sync pass has not run here",
        ]);
    });
});

describe('buildPackInfo — fired state', () => {
    it('counts fires from the library own root beside the trigger table', () => {
        const info = buildPackInfo(agreeing());
        expect(info.card.firedRoot).toBe('EventPack.fired');
        expect(info.card.packs[0].fired).toBe(1);
        expect(info.card.packs[0].firedKeys).toEqual(['test_series_step1']);
    });

    it('counts a pack with no fires yet as ZERO, not unknown — the table is made by the first fire', () => {
        const args = agreeing();
        delete args.statData.EventPack.fired;
        const info = buildPackInfo(args);
        expect(info.card.packs[0].fired).toBe(0);
        expect(info.card.packs[0].firedKeys).toEqual([]);
        expect(info.chat.firedTablePresent).toBe(false);   // absent is still reported honestly
        expect(info.chat.firedTotal).toBe(0);
    });

    it('reports UNKNOWN rather than zero when the engine declares no trigger root', () => {
        const info = buildPackInfo(agreeing({ enginePaths: { ok: false, reason: 'no header' } }));
        expect(info.card.packs[0].fired).toBe(-1);
        expect(info.card.packs[0].firedKeys).toBe(null);
        expect(info.card.enginePathsProblem).toBe('no header');
    });
});

describe('buildPackInfo — where it read from', () => {
    it('names the bound standalone world and warns off the embedded book', () => {
        const info = buildPackInfo(agreeing());
        expect(info.source.boundWorld).toBe('ArtificKoi');
        expect(info.source.cardPacksReadFrom).toContain('standalone worldbook "ArtificKoi"');
        expect(info.source.warning).toContain('character_book');
    });

    it('says nothing is readable when no world is bound', () => {
        const info = buildPackInfo(agreeing({ boundWorld: '', entries: null, registry: null }));
        expect(info.source.cardPacksReadFrom).toContain('no bound worldbook');
        expect(info.card.worldbookReadable).toBe(false);
        expect(info.card.registryState).toBe('unreadable');
    });

    it('separates a malformed registry from an unreadable book', () => {
        const info = buildPackInfo(agreeing({ registry: null }));
        expect(info.card.registryState).toBe('malformed');
        expect(info.card.packs).toEqual([]);
    });
});

describe('buildPackInfo — the library half', () => {
    it('marks which stored packs are on this card', () => {
        const args = agreeing();
        args.stored.push({ id: 'other.pack', version: '1.0', events: 1, parseError: '' });
        const info = buildPackInfo(args);
        expect(info.library.packs.map((p) => [p.id, p.onThisCard])).toEqual([['test.series', true], ['other.pack', false]]);
    });

    it('surfaces a stored file that no longer parses', () => {
        const args = agreeing();
        args.stored.push({ id: 'broken.pack', version: '', events: 0, parseError: 'no <mvueventpack> block' });
        const info = buildPackInfo(args);
        expect(info.disagreements).toContain('broken.pack: stored in the library but no longer parses — no <mvueventpack> block');
    });

    it('reports an unreadable library without calling it empty', () => {
        const info = buildPackInfo(agreeing({ stored: null }));
        expect(info.library.readable).toBe(false);
        expect(info.card.packs[0].inLibrary).toBe(null);
        expect(info.card.packs[0].led).toBe('green');   // unknown must not read as "about to be lost"
    });
});
