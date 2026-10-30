/**
 * MVU Helper — roster-scan pure-core tests (character-roster/roster-scan-core.js).
 *
 * The heroine collection is named per-genre (School Classmate / Love Partner /
 * RPG Familiar); discovery is by RECORD SHAPE (children carry Is_present), so one
 * code path serves every genre. These tests lock that shape-detection + the
 * present/all key extraction + the override.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import {
    findCharacterCollection,
    allCharKeys,
    presentCharKeys,
} from '../src/features/character-roster/roster-scan-core.js';

// School-shaped stat_data (#tuple fields), abbreviated.
const SCHOOL = {
    World: { Time: ['07:30', 'time'] },
    World_Calc: { IntimacyActive: [false, 'latch'] },
    Mainchar: { Name: ['Goten', 'name'], Sta: [50, 'stamina'] },  // single record, NOT a collection
    Classmate: {
        Mitsuki: { Name: ['Mitsuki', 'n'], Is_present: [true, 'p'], Affection: [40, 'a'] },
        Mana: { Name: ['Mana', 'n'], Is_present: [true, 'p'], Affection: [10, 'a'] },
        Iori: { Name: ['Iori', 'n'], Is_present: [false, 'p'], Affection: [5, 'a'] },
    },
};

describe('findCharacterCollection (shape discovery)', () => {
    it('picks the object whose children are Is_present records (Classmate), not Mainchar/World', () => {
        expect(findCharacterCollection(SCHOOL)).toBe('Classmate');
    });
    it('works for other genre names by shape alone (Partner / Familiar)', () => {
        const love = { Partner: { Ann: { Is_present: [true, 'p'] }, Bea: { Is_present: [false, 'p'] } } };
        const rpg = { Familiar: { Fox: { Is_present: [true, 'p'] } } };
        expect(findCharacterCollection(love)).toBe('Partner');
        expect(findCharacterCollection(rpg)).toBe('Familiar');
    });
    it('override wins when it names a real object', () => {
        const sd = { Classmate: { A: { Is_present: [true, 'p'] } }, Roster: { B: { Is_present: [true, 'p'] } } };
        expect(findCharacterCollection(sd, 'Roster')).toBe('Roster');
    });
    it('override tolerates a leading "stat_data." prefix (bare + prefixed both resolve)', () => {
        const sd = { Classmate: { A: { Is_present: [true, 'p'] } }, Partner: { B: { Is_present: [true, 'p'] } } };
        expect(findCharacterCollection(sd, 'stat_data.Partner')).toBe('Partner');
        expect(findCharacterCollection(sd, ' stat_data.Partner ')).toBe('Partner');   // trims too
        expect(findCharacterCollection(sd, 'Partner')).toBe('Partner');
    });
    it('override is ignored when it does not name a real object (falls back to discovery)', () => {
        expect(findCharacterCollection(SCHOOL, 'Nonexistent')).toBe('Classmate');
        expect(findCharacterCollection(SCHOOL, 'stat_data.Nonexistent')).toBe('Classmate');
    });
    it('returns null when there is no roster-shaped collection', () => {
        expect(findCharacterCollection({ World: { Time: ['x', 't'] } })).toBe(null);
        expect(findCharacterCollection(null)).toBe(null);
    });
});

describe('allCharKeys / presentCharKeys', () => {
    it('allCharKeys lists every member of the collection', () => {
        expect(allCharKeys(SCHOOL).sort()).toEqual(['Iori', 'Mana', 'Mitsuki']);
    });
    it('presentCharKeys lists only Is_present === true', () => {
        expect(presentCharKeys(SCHOOL).sort()).toEqual(['Mana', 'Mitsuki']);
    });
    it('empty for a non-MVU / rosterless stat_data (→ caller falls back to pic-anchor)', () => {
        expect(presentCharKeys({ World: {} })).toEqual([]);
        expect(allCharKeys({})).toEqual([]);
    });
});

describe('custom presence field (presenceField override)', () => {
    // A card that renamed the presence field to "inHere".
    const CUSTOM = {
        Mainchar: { Name: ['Goten', 'n'] },
        Partner: {
            Ann: { Name: ['Ann', 'n'], inHere: [true, 'p'] },
            Bea: { Name: ['Bea', 'n'], inHere: [false, 'p'] },
        },
    };
    it('auto-detects the collection by the custom field (blank collection + presenceField)', () => {
        expect(findCharacterCollection(CUSTOM, undefined, 'inHere')).toBe('Partner');
    });
    it('default Is_present finds NOTHING when members use the custom field', () => {
        expect(findCharacterCollection(CUSTOM)).toBe(null);           // no Is_present-bearing records
        expect(presentCharKeys(CUSTOM)).toEqual([]);
    });
    it('reads presence from the custom field (with or without a collection override)', () => {
        expect(presentCharKeys(CUSTOM, undefined, 'inHere')).toEqual(['Ann']);
        expect(presentCharKeys(CUSTOM, 'stat_data.Partner', 'inHere')).toEqual(['Ann']);
        expect(allCharKeys(CUSTOM, 'Partner', 'inHere').sort()).toEqual(['Ann', 'Bea']);
    });
    it('blank/undefined presenceField falls back to Is_present', () => {
        expect(presentCharKeys(SCHOOL, undefined, '').sort()).toEqual(['Mana', 'Mitsuki']);
        expect(presentCharKeys(SCHOOL, undefined, undefined).sort()).toEqual(['Mana', 'Mitsuki']);
    });
});

// ── An EXPLICIT collection is ENUMERATED, not re-probed ──────────────────────
// Naming the collection is a statement that its members ARE the cast. Filtering them by a presence
// field the card may have renamed (or never had) answered "who is in the cast?" with [] and no
// complaint — which silently killed the char= typo warnings in image-gen.js. CLAUDE.md L2:
// consumers declare, platforms enumerate. Live case: a Chinese card whose 关系列表 members carry
// 在场, with the Present flag box left blank. See plans/roster-registration-integrity.md P3.
describe('explicit collection vs the presence probe', () => {
    // Members carry 在场 — a real presence field, but NOT the published default name.
    const CHINESE = {
        任务列表: { MQ1: { 状态: '进行中' } },
        关系列表: {
            '阿曼德·布劳尔': { 在场: true, 种族: '人类' },
            '莉莉絲': { 在场: false, 种族: '魔族' },
        },
    };

    it('names the whole cast when the collection is explicit and the flag is BLANK', () => {
        expect(allCharKeys(CHINESE, '关系列表', '').sort()).toEqual(['莉莉絲', '阿曼德·布劳尔'].sort());
    });

    it('…and with a stat_data. prefix, which is tolerated everywhere else too', () => {
        expect(allCharKeys(CHINESE, 'stat_data.关系列表', '').length).toBe(2);
    });

    it('presentCharKeys still needs the field — blank means no presence to report', () => {
        expect(presentCharKeys(CHINESE, '关系列表', '')).toEqual([]);
        expect(presentCharKeys(CHINESE, '关系列表', '在场')).toEqual(['阿曼德·布劳尔']);
    });

    it('auto-discovery is unchanged: no usable field name, no collection', () => {
        expect(findCharacterCollection(CHINESE, '', '')).toBeNull();
        expect(allCharKeys(CHINESE, '', '')).toEqual([]);
        expect(findCharacterCollection(CHINESE, '', '在场')).toBe('关系列表');
    });

    it('an AUTO-discovered collection still filters — the probe is why we trust it', () => {
        const mixed = {
            Classmate: {
                Mitsuki: { Is_present: true },
                $meta: { note: 'not a character' },
            },
        };
        expect(allCharKeys(mixed, '', '').sort()).toEqual(['Mitsuki']);
        expect(allCharKeys(mixed, 'Classmate', '').sort()).toEqual(['$meta', 'Mitsuki']);
    });

    it('an override naming something that is not an object falls back to discovery', () => {
        expect(allCharKeys(CHINESE, 'nope', '在场').sort()).toEqual(['莉莉絲', '阿曼德·布劳尔'].sort());
    });

    it('non-object members are never cast, explicit collection or not', () => {
        const junk = { Cast: { Real: { Is_present: true }, count: 3, list: [1, 2] } };
        expect(allCharKeys(junk, 'Cast', '').sort()).toEqual(['Real']);
    });
});
