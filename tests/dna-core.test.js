/**
 * MVU Helper — character-DNA pure-core tests (character-roster/dna-core.js).
 *
 * Same pattern as extra-llm-calls-core: the runtime halves (dna.js/harvest.js) import
 * the SillyTavern host and can't load under vitest, so all parsing/decision logic lives in
 * dna-core.js (zero imports) and is exercised here.
 *
 * Coverage targets:
 *   - [Body]/[Clothes]/[Clothes:variant] section parsing (the DNA entry format)
 *   - outfit= selection semantics (named / newclothes / same-as-last-picture / undressed / a slip ⇒ what the
 *     worn-outfit store holds, else no clothes)
 *   - the worn-outfit store: what a reply's pictures report, the store after a reply and its stamps, what a picture
 *     is drawn in, who is offered "same-as-last-picture" (wornReportsOf, nextWornOutfit, wornOutfitOn, lastPictureOutfitsIn)
 *   - its edits (plans/reply-cast.md §11): an outfit the harvest saved held by name, and what the log says it found
 *     (keptOutfitFinding), "Wearing now", where an edit is written, and what a regen draws from the store saved with
 *     the reply (applyWornOutfitEdits, wornOutfitEditTargets, wearingNowFromEditorFields, isSameWear, shownForRegen,
 *     selectClothesForOutfit `shown`)
 *   - what a reply's one-off pictures drew, which the harvest saves (drawnOneOffClothesOf, drawnClothesFor, D40)
 *   - one drawn person's look: stored, else this reply's <cast> record, else none (chooseLook)
 *   - what one cast record asks of the registry (registrationFromCastRecord), and where its clothes are saved by
 *     what her entry holds (registrationClothesTarget, hasClothesOnFile: a character's first clothes are kept)
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    parseDnaSections,
    hasStoredAppearance,
    listOutfitVariants,
    chooseLook,
    lookSourceFor,
    lookWaitsForReply,
    lookWaitsForRegistration,
    replyRecordOf,
    wornReportsOf,
    drawnOneOffClothesOf,
    drawnClothesFor,
    keptOutfitFinding,
    nextWornOutfit,
    wornOutfitOn,
    lastPictureOutfitsIn,
    LAST_PICTURE_MESSAGE,
    WORN_OUTFIT_PART,
    WORN_OUTFIT_KEEP_REPLIES,
    wornOutfitCleaningMission,
    parseBustMultiplier,
    registrationToEntryContent,
    registrationFromCastRecord,
    registrationClothesTarget,
    hasClothesOnFile,
    hasBodyOnly,
    newOutfitNameProblem,
    pickCharEntry,
    appendClothesVariant,
    selectClothesForOutfit,
    namesNearMiss,
    findNameSplits,
    namesWithoutRegistration,
    allowsClothesUpdate,
    mayStoryReplaceClothes,
    setAllowUpdate,
    replaceClothesInContent,
    OUTFIT_NEW_CLOTHES,
    OUTFIT_SAME_AS_LAST_PICTURE,
    RESERVED_OUTFIT_NAMES,
    listAliases,
    entryAnswersTo,
    appendAliases,
    applyWornOutfitEdits,
    wornOutfitSet,
    wornOutfitCleared,
    wornOutfitKeptByName,
    wornOutfitEditTargets,
    shownForRegen,
    isSameWear,
    wearingNowFromEditorFields,
    wearingNowChoices,
    wearingNowSelection,
} from '../src/features/character-roster/dna-core.js';

const MITSUKI = `[Body]
petite, slim, golden eyes, plum-purple hair
[Clothes]
brown school uniform, green ribbon bow
[Clothes:gym]
white gym shirt, navy bloomers
[Clothes:swimsuit]
navy one-piece school swimsuit`;

describe('parseDnaSections ([Body]/[Clothes]/[Clothes:variant] format)', () => {
    it('parses body + default clothes + named variants', () => {
        const s = parseDnaSections(MITSUKI);
        expect(s.body).toContain('plum-purple hair');
        expect(s.clothes.default).toContain('green ribbon bow');
        expect(s.clothes.gym).toContain('bloomers');
        expect(s.clothes.swimsuit).toContain('one-piece');
    });
    it('variant names are case-insensitive (stored lowercase)', () => {
        const s = parseDnaSections('[Body]\nx\n[Clothes:GYM]\ny');
        expect(s.clothes.gym).toBe('y');
    });
    it('missing sections come back empty, not undefined-crash', () => {
        const s = parseDnaSections('just some prose, no sections');
        expect(s.body).toBe('');
        expect(s.clothes).toEqual({});
    });
    it('listOutfitVariants puts default first', () => {
        expect(listOutfitVariants(MITSUKI)).toEqual(['default', 'gym', 'swimsuit']);
    });
});

describe('selectClothesForOutfit — the clothes one outfit= value selects', () => {
    const s = () => parseDnaSections(MITSUKI);
    // Outfits all named, no default: School's heroines.
    const named = () => parseDnaSections('[Body]\nb\n[Clothes:school-uniform]\nbrown uniform\n[Clothes:school-gym]\nwhite gym shirt');
    const oneOff = (clothes, lastPictureMessage = 12) => ({ outfit: 'newclothes', clothes, lastPictureMessage });
    const onFile = (outfit, lastPictureMessage = 12) => ({ outfit, clothes: '', lastPictureMessage });

    it('an outfit on file → that outfit, "default" included when she has one', () => {
        expect(selectClothesForOutfit(s(), 'gym')).toMatchObject({ clothes: s().clothes.gym, clothesSource: 'stored', warning: '' });
        expect(selectClothesForOutfit(s(), 'default')).toMatchObject({ clothes: s().clothes.default, clothesSource: 'stored', warning: '' });
        expect(selectClothesForOutfit(named(), 'School-Uniform').clothes).toBe('brown uniform');
    });

    // A named outfit is what she wears now, whatever the store holds.
    it('MUTATION TARGET — a listed outfit outranks what the store holds', () => {
        expect(selectClothesForOutfit(named(), 'school-gym', { carried: oneOff('grey hoodie') }).clothes).toBe('white gym shirt');
    });

    // The one-off a picture described is offered back by name and drawn from the store, so it is described once.
    it('MUTATION TARGET — "same-as-last-picture" draws the one-off the store holds, silently, and names its picture', () => {
        for (const o of [OUTFIT_SAME_AS_LAST_PICTURE, ' Same-As-Last-Picture ']) {
            expect(selectClothesForOutfit(named(), o, { carried: oneOff('grey hoodie, pleated skirt', 41) }))
                .toEqual({ clothes: 'grey hoodie, pleated skirt', clothesSource: 'carried', wornEntry: { outfit: '', lastPictureMessage: 41 }, warning: '' });
        }
    });

    // D30: the outfit on file her last picture showed is offered back the same way, so the narrator reads what she
    // wears instead of re-picking it from a bare list. MUTATION TARGET: draw only one-offs and this is a slip again.
    it('MUTATION TARGET — "same-as-last-picture" draws the outfit on file the store holds, silently, and names its picture', () => {
        expect(selectClothesForOutfit(named(), OUTFIT_SAME_AS_LAST_PICTURE, { carried: onFile('school-gym', 41) }))
            .toEqual({ clothes: 'white gym shirt', clothesSource: 'carried', wornEntry: { outfit: 'school-gym', lastPictureMessage: 41 }, warning: '' });
    });

    it('MUTATION TARGET — "same-as-last-picture" never takes this reply\'s record', () => {
        const r = selectClothesForOutfit(named(), OUTFIT_SAME_AS_LAST_PICTURE, { replyClothes: 'red coat', replyOutfit: 'same-as-last-picture', carried: oneOff('grey hoodie') });
        expect(r.clothes).toBe('grey hoodie');
        // With nothing stored it is a slip, never an outfit a record of hers defines under that word.
        const slip = selectClothesForOutfit(named(), OUTFIT_SAME_AS_LAST_PICTURE, { replyClothes: 'red coat', replyOutfit: 'same-as-last-picture' });
        expect(slip).toMatchObject({ clothes: '', clothesSource: '' });
        expect(slip.warning).toMatch(/said "same-as-last-picture", and nothing is stored for her/);
    });

    // A slip: no value, a name she does not have, a "default" she does not have, "newclothes" with no clothes=. She is
    // drawn in what the store holds, and it always says so.
    it('MUTATION TARGET — a slip draws the outfit the store holds, and says which slip', () => {
        const cases = [
            ['', /was drawn with no outfit= \(every picture names one\) — drawn in what she last wore \(\[Clothes:school-gym\]\)/],
            ['default', /said "default", which she does not have — drawn in what she last wore/],
            ['swimsuit', /has no \[Clothes:swimsuit\] on file — drawn in what she last wore/],
            ['none', /has no \[Clothes:none\] on file — drawn in what she last wore/],
            ['newclothes', /said "newclothes" but her <cast> record carries no clothes= — drawn in what she last wore/],
        ];
        for (const [o, warning] of cases) {
            const r = selectClothesForOutfit(named(), o, { carried: onFile('school-gym', 7) });
            expect(r, o).toMatchObject({ clothes: 'white gym shirt', clothesSource: 'carried', wornEntry: { outfit: 'school-gym', lastPictureMessage: 7 } });
            expect(r.warning, o).toMatch(warning);
        }
    });

    it('MUTATION TARGET — a slip draws the one-off the store holds, and says so', () => {
        const r = selectClothesForOutfit(named(), '', { carried: oneOff('grey hoodie') });
        expect(r).toMatchObject({ clothes: 'grey hoodie', clothesSource: 'carried', wornEntry: { outfit: '', lastPictureMessage: 12 } });
        expect(r.warning).toMatch(/— drawn in what she last wore \(her one-off\)/);
    });

    // No default outfit to fall back on: her own [Clothes] is a choice like any other, never a floor.
    it('MUTATION TARGET — a slip with nothing stored draws no clothes, [Clothes] or not, and says so', () => {
        for (const sections of [s(), named()]) {
            const r = selectClothesForOutfit(sections, '');
            expect(r).toMatchObject({ clothes: '', clothesSource: '', wornEntry: null });
            expect(r.warning).toMatch(/was drawn with no outfit= \(every picture names one\), and nothing is stored for her — drawn with no clothes described/);
        }
        expect(selectClothesForOutfit(named(), 'default').warning).toMatch(/said "default", which she does not have, and nothing is stored for her/);
        expect(selectClothesForOutfit(named(), OUTFIT_SAME_AS_LAST_PICTURE).warning).toMatch(/said "same-as-last-picture", and nothing is stored for her/);
        // An outfit name she no longer has on file is nothing she can be drawn in.
        expect(selectClothesForOutfit(named(), OUTFIT_SAME_AS_LAST_PICTURE, { carried: onFile('beach-swimsuit') }).warning)
            .toMatch(/said "same-as-last-picture", and nothing is stored for her — drawn with no clothes described/);
        expect(selectClothesForOutfit(named(), 'newclothes').warning).toMatch(/carries no clothes=, and nothing is stored for her/);
    });

    it('a stored outfit she no longer has on file draws no clothes, and says so', () => {
        const r = selectClothesForOutfit(s(), '', { carried: onFile('school-uniform') });
        expect(r.clothes).toBe('');
        expect(r.warning).toMatch(/drawn with no clothes described/);
    });

    it('newclothes is reserved as an outfit name; "custom" is not vocabulary at all', () => {
        expect(RESERVED_OUTFIT_NAMES).toContain('newclothes');
        expect(RESERVED_OUTFIT_NAMES).not.toContain('custom');
    });

    // MUTATION TARGET: drop "none" and a char="none" picture mints a registry entry named "none"; drop
    // "same-as-last-picture" and a registration can save an outfit under it.
    it('"undressed", "same-as-last-picture" and "none", which models write for nobody, are reserved', () => {
        expect(RESERVED_OUTFIT_NAMES).toContain('undressed');
        expect(RESERVED_OUTFIT_NAMES).toContain(OUTFIT_SAME_AS_LAST_PICTURE);
        expect(RESERVED_OUTFIT_NAMES).toContain('none');
    });

    // "custom" is an ordinary word, so it is a slip like any outfit she does not have: drawn from the store, and loud.
    it('a word that is not vocabulary is a slip', () => {
        const r = selectClothesForOutfit(s(), 'custom', { carried: onFile('gym') });
        expect(r.clothes).toBe(s().clothes.gym);
        expect(r.warning).toContain('custom');
    });

    // sections.clothes is a plain object: a bare index would answer this with a function off the
    // prototype and stringify it into the prompt.
    it('a prototype key is not an outfit', () => {
        for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
            const r = selectClothesForOutfit(s(), key, { carried: onFile('gym') });
            expect(typeof r.clothes).toBe('string');
            expect(r.clothes).toBe(s().clothes.gym);
            expect(r.warning).toContain(key.toLowerCase());
        }
    });

    it('"undressed" is never clothed, whatever the reply or the store says, and is no slip', () => {
        for (const o of ['undressed', 'UNDRESSED', ' undressed ']) {
            expect(selectClothesForOutfit(s(), o, { replyClothes: 'red coat', carried: oneOff('hoodie') })).toMatchObject({ clothes: '', clothesSource: '', warning: '' });
        }
    });

    it('says where the clothes came from: the outfit named, her record this reply, the store, or nowhere', () => {
        const bodyOnly = parseDnaSections('[Body]\nsome body tags');
        expect(selectClothesForOutfit(s(), 'gym')).toMatchObject({ clothesSource: 'stored', wornEntry: null });
        expect(selectClothesForOutfit(s(), 'newclothes', { replyClothes: 'plate armor' }).clothesSource).toBe('reply');
        expect(selectClothesForOutfit(s(), 'pajama', { replyClothes: 'pink nightdress', replyOutfit: 'pajama' }).clothesSource).toBe('reply');
        expect(selectClothesForOutfit(bodyOnly, OUTFIT_SAME_AS_LAST_PICTURE, { carried: oneOff('x') }).clothesSource).toBe('carried');
        expect(selectClothesForOutfit(bodyOnly, 'newclothes').clothesSource).toBe('');
    });

    // A one-off: clothes she has no stored outfit for, written on her <cast> record in the same reply.
    it('"newclothes" takes this reply\'s clothes=', () => {
        for (const o of [OUTFIT_NEW_CLOTHES, ' NewClothes ']) {
            const r = selectClothesForOutfit(s(), o, { replyClothes: 'plate armor, red cape', carried: oneOff('hoodie') });
            expect(r.clothes).toBe('plate armor, red cape');
            expect(r.warning).toBe('');
        }
    });

    // The slot names nothing she has, so this reply's record never answers it: a picture drawn mid-stream (before the
    // records exist) and one drawn after them come out the same.
    it('MUTATION TARGET — this reply\'s record never answers a slip', () => {
        expect(selectClothesForOutfit(named(), '', { replyClothes: 'red coat', carried: oneOff('grey hoodie') }).clothes).toBe('grey hoodie');
        expect(selectClothesForOutfit(parseDnaSections('[Body]\nx'), 'default', { replyClothes: 'red coat' }).clothes).toBe('');
    });

    // An outfit the reply defines and harvest has not stored yet (or never will, with harvest off).
    it('an outfit not on file but defined by her record this reply uses the record', () => {
        expect(selectClothesForOutfit(s(), 'pajama', { replyClothes: 'pink nightdress', replyOutfit: 'Pajama' }).clothes).toBe('pink nightdress');
        // a record for ANOTHER outfit does not stand in: a slip, drawn from the store
        const r = selectClothesForOutfit(s(), 'pajama', { replyClothes: 'pink nightdress', replyOutfit: 'sunday', carried: onFile('gym') });
        expect(r.clothes).toBe(s().clothes.gym);
        expect(r.warning).toContain('pajama');
    });
});

// What a reply's pictures say about each person they draw — the store's input.
describe('wornReportsOf — what one reply\'s pictures say about each person they draw', () => {
    const mitsuki = { key: 'Mitsuki', content: '[Body]\nb\n[Clothes:school-uniform]\nbrown uniform\n[Clothes:school-gym]\nwhite gym shirt\n[Alias]\n美月' };
    const main = { key: 'Mainchar', content: '[Body]\nm\n[Clothes:school-uniform]\nblazer' };
    const entries = [mitsuki, main];
    const hoodie = [{ name: 'Mitsuki', attributes: { outfit: 'newclothes', clothes: 'grey hoodie' } }];
    const drawnOnly = (key) => ({ key, outfit: '', clothes: '' });

    it('MUTATION TARGET — an outfit she has on file is reported by name, under her entry\'s key', () => {
        expect(wornReportsOf([{ name: 'Mitsuki', outfit: 'School-Gym' }], [], entries)).toEqual([{ key: 'Mitsuki', outfit: 'school-gym', clothes: '' }]);
    });

    it('MUTATION TARGET — "newclothes" with clothes= on her record is reported as a one-off', () => {
        expect(wornReportsOf([{ name: 'Mitsuki', outfit: 'newclothes' }], hoodie, entries)).toEqual([{ key: 'Mitsuki', outfit: 'newclothes', clothes: 'grey hoodie' }]);
    });

    // What the picture is drawn in is what the store keeps, so a value drawn from the store — "undressed",
    // "same-as-last-picture", a slip — reports her drawn and her clothes unchanged.
    it('MUTATION TARGET — "undressed", "same-as-last-picture" and a slip report her drawn, with no clothes', () => {
        const towel = [{ name: 'Mitsuki', attributes: { clothes: 'bath towel' } }];
        expect(wornReportsOf([{ name: 'Mitsuki', outfit: 'undressed' }], towel, entries)).toEqual([drawnOnly('Mitsuki')]);
        expect(wornReportsOf([{ name: 'Mitsuki', outfit: OUTFIT_SAME_AS_LAST_PICTURE }], hoodie, entries)).toEqual([drawnOnly('Mitsuki')]);
        expect(wornReportsOf([{ name: 'Mitsuki', outfit: '' }, { name: 'Mitsuki', outfit: 'default' }, { name: 'Mitsuki', outfit: 'newclothes' }], [], entries))
            .toEqual([drawnOnly('Mitsuki'), drawnOnly('Mitsuki'), drawnOnly('Mitsuki')]);
    });

    // A slip is drawn from the store, so her record's clothes= — written for another picture, or by mistake — never
    // reaches the store through it.
    it('MUTATION TARGET — a slip never reports her record\'s clothes', () => {
        expect(wornReportsOf([{ name: 'Mitsuki', outfit: '' }], hoodie, entries)).toEqual([drawnOnly('Mitsuki')]);
    });

    // A newcomer drawn from the look her record described: those clothes are what she wears.
    it('a look from her record reports its clothes=, under the name as written, unless the shot undresses her', () => {
        const aria = [{ name: 'Aria', attributes: { body: 'elf woman', clothes: 'plate armor' } }];
        expect(wornReportsOf([{ name: 'Aria', outfit: 'newclothes' }], aria, entries)).toEqual([{ key: 'Aria', outfit: 'newclothes', clothes: 'plate armor' }]);
        expect(wornReportsOf([{ name: 'Aria', outfit: 'undressed' }], aria, entries)).toEqual([drawnOnly('Aria')]);
    });

    // An outfit her record saves this reply is drawn from the record; the store keeps those clothes as a one-off.
    it('an outfit her record defines this reply reports the record\'s clothes as a one-off', () => {
        const waitress = [{ name: 'Mitsuki', attributes: { outfit: 'cafe-waitress', clothes: 'black dress, white apron' } }];
        expect(wornReportsOf([{ name: 'Mitsuki', outfit: 'cafe-waitress' }], waitress, entries))
            .toEqual([{ key: 'Mitsuki', outfit: 'newclothes', clothes: 'black dress, white apron' }]);
    });

    // The story calls her 美月 or Mitsuki: one entry, one key — the store never splits her in two.
    it('MUTATION TARGET — a name her entry answers to reports under her entry\'s key', () => {
        expect(wornReportsOf([{ name: '美月', outfit: 'school-gym' }], [], entries)).toEqual([{ key: 'Mitsuki', outfit: 'school-gym', clothes: '' }]);
        expect(wornReportsOf([{ name: '美月', outfit: 'newclothes' }], hoodie, entries)).toEqual([{ key: 'Mitsuki', outfit: 'newclothes', clothes: 'grey hoodie' }]);
        expect(wornReportsOf([{ name: '美月', outfit: 'undressed' }], [], entries)).toEqual([drawnOnly('Mitsuki')]);
    });

    // He never has a record: the outfit his picture named is all there is.
    it('the main character reports under his entry\'s key, by the outfit his picture named', () => {
        expect(wornReportsOf([{ name: 'Mainchar', outfit: 'school-uniform' }], [], entries)).toEqual([{ key: 'Mainchar', outfit: 'school-uniform', clothes: '' }]);
    });

    it('every picture reports, in text order', () => {
        const people = [{ name: 'Mitsuki', outfit: 'newclothes' }, { name: 'Mitsuki', outfit: 'school-gym' }, { name: 'Mitsuki', outfit: 'undressed' }];
        expect(wornReportsOf(people, hoodie, entries).map((r) => r.outfit)).toEqual(['newclothes', 'school-gym', '']);
    });

    it('nothing drawn ⇒ nothing reported', () => {
        expect(wornReportsOf([], hoodie, entries)).toEqual([]);
        expect(wornReportsOf(null, null, null)).toEqual([]);
        expect(wornReportsOf([{ name: '  ', outfit: 'school-gym' }], [], entries)).toEqual([]);
    });
});

describe('drawnOneOffClothesOf / drawnClothesFor — what a reply\'s one-off pictures drew, which the harvest saves (D40)', () => {
    const vela = { key: '薇拉', content: '[Body]\nb\n[Clothes]\nfairy outfit\n[Alias]\nMayla' };
    const oneOff = (key, clothes) => ({ key, outfit: OUTFIT_NEW_CLOTHES, clothes });

    it('MUTATION TARGET — each character\'s last one-off picture wins; outfits on file and clothes-less reports give nothing', () => {
        const reports = [oneOff('薇拉', 'blue gown'), { key: '薇拉', outfit: 'default', clothes: '' }, oneOff('薇拉', 'red coat'),
            oneOff('靈青', 'teal armor'), { key: 'Mana', outfit: '', clothes: '' }, oneOff('Aoi', '  '),
            { key: 'Mitsuki', outfit: 'school-gym', clothes: 'white gym shirt' }];
        expect(drawnOneOffClothesOf(reports)).toEqual([{ key: '薇拉', clothes: 'red coat' }, { key: '靈青', clothes: 'teal armor' }]);
        expect(drawnOneOffClothesOf(null)).toEqual([]);
    });

    it('MUTATION TARGET — found by her entry\'s key or alias, or by the name a record wrote, without regard to case', () => {
        const drawn = [{ key: '薇拉', clothes: 'red coat' }, { key: 'Aria', clothes: 'plate armor' }];
        expect(drawnClothesFor(drawn, vela, '薇拉')).toBe('red coat');
        expect(drawnClothesFor([{ key: 'mayla', clothes: 'red coat' }], vela, 'someone')).toBe('red coat');
        expect(drawnClothesFor(drawn, null, 'ARIA')).toBe('plate armor');
    });

    it('nothing drawn for her ⇒ no clothes', () => {
        expect(drawnClothesFor([{ key: 'Aria', clothes: 'plate armor' }], vela, '薇拉')).toBe('');
        expect(drawnClothesFor([], null, '')).toBe('');
        expect(drawnClothesFor(null, vela, '薇拉')).toBe('');
    });
});

describe('nextWornOutfit — the store after one reply', () => {
    const report = (key, outfit = '', clothes = '') => ({ key, outfit, clothes });
    const stamped = (outfit, clothes, at) => ({ outfit, clothes, last_picture_message: at });

    it('MUTATION TARGET — a report replaces her entry, the last one in the reply winning, stamped with the reply', () => {
        const next = nextWornOutfit({ Mitsuki: stamped('school-uniform', '', 10) },
            { reports: [report('Mitsuki', 'newclothes', 'grey hoodie'), report('Mitsuki', 'school-gym')], replyIndex: 14 });
        expect(next).toEqual({ Mitsuki: stamped('school-gym', '', 14) });
    });

    it('MUTATION TARGET — someone the reply did not draw keeps what she wore, and her stamp', () => {
        const next = nextWornOutfit({ Yuki: stamped('newclothes', 'sundress', 3) }, { reports: [report('Mitsuki', 'school-gym')], replyIndex: 14 });
        expect(next.Yuki).toEqual(stamped('newclothes', 'sundress', 3));
    });

    // No story day: what she wore carries until a picture names other clothes for her.
    it('MUTATION TARGET — a reply with no pictures carries every entry as it was', () => {
        const store = { Mitsuki: stamped('school-gym', '', 2), Yuki: stamped('newclothes', 'sundress', 5) };
        expect(nextWornOutfit(store, { replyIndex: 30 })).toEqual(store);
        expect(nextWornOutfit(store)).toEqual(store);
    });

    // Drawn from the store ("same-as-last-picture", "undressed", a slip): her clothes stay, her stamp moves.
    it('MUTATION TARGET — a report without an outfit moves only her stamp', () => {
        const next = nextWornOutfit({ Mitsuki: stamped('newclothes', 'grey hoodie', 4) }, { reports: [report('Mitsuki')], replyIndex: 9 });
        expect(next).toEqual({ Mitsuki: stamped('newclothes', 'grey hoodie', 9) });
    });

    it('MUTATION TARGET — a report without an outfit never creates an entry', () => {
        expect(nextWornOutfit({}, { reports: [report('Mitsuki')], replyIndex: 9 })).toEqual({});
    });

    it('a report without an outfit finds her entry whatever its key\'s case', () => {
        expect(nextWornOutfit({ mitsuki: stamped('school-gym', '', 1) }, { reports: [report('Mitsuki')], replyIndex: 2 })).toEqual({ mitsuki: stamped('school-gym', '', 2) });
    });

    it('a reply index that is no message index stamps nothing, and leaves a stamp as it was', () => {
        for (const replyIndex of [null, undefined, -1, 2.5, '7']) {
            expect(nextWornOutfit({}, { reports: [report('Mitsuki', 'school-gym')], replyIndex })).toEqual({ Mitsuki: { outfit: 'school-gym', clothes: '' } });
            expect(nextWornOutfit({ Mitsuki: stamped('school-gym', '', 3) }, { reports: [report('Mitsuki')], replyIndex })).toEqual({ Mitsuki: stamped('school-gym', '', 3) });
        }
    });

    // An entry from before every picture named its outfit carries a story `day` and no stamp.
    it('an entry with no stamp carries without one, and a story day is no field of an entry', () => {
        expect(nextWornOutfit({ Mitsuki: { outfit: 'school-gym', clothes: '', day: '2026-04-12' } })).toEqual({ Mitsuki: { outfit: 'school-gym', clothes: '' } });
        expect(nextWornOutfit({ Mitsuki: { outfit: 'school-gym', clothes: '', last_picture_message: 'x' } })).toEqual({ Mitsuki: { outfit: 'school-gym', clothes: '' } });
    });

    // Keys are matched without regard to case, as every registry key is.
    it('a report replaces her entry whatever the case its key was stored in', () => {
        const next = nextWornOutfit({ mitsuki: stamped('newclothes', 'hoodie', 1) }, { reports: [report('Mitsuki', 'school-gym')], replyIndex: 4 });
        expect(next).toEqual({ Mitsuki: stamped('school-gym', '', 4) });
    });

    it('anything that is not a store entry is dropped', () => {
        expect(nextWornOutfit(null)).toEqual({});
        expect(nextWornOutfit(['x'])).toEqual({});
        expect(nextWornOutfit({ A: null, B: 'school-gym', C: { outfit: '' }, D: { outfit: ' School-Gym ', clothes: ' x ' } })).toEqual({ D: { outfit: 'school-gym', clothes: 'x' } });
        const hostile = nextWornOutfit(JSON.parse('{"__proto__": {"outfit": "x"}}'), { reports: [report('__proto__', 'x')] });
        expect(hostile).toEqual({});
        expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);
    });

    it('the stamp is the persisted field last_picture_message', () => {
        expect(LAST_PICTURE_MESSAGE).toBe('last_picture_message');
    });
});

describe('wornOutfitOn — what the store holds for her', () => {
    const store = {
        Mitsuki: { outfit: 'newclothes', clothes: 'white sundress', last_picture_message: 12 },
        Yuki: { outfit: 'school-gym', clothes: '' },
    };

    it('MUTATION TARGET — her entry, with the message of her last picture', () => {
        expect(wornOutfitOn(store, 'Mitsuki')).toEqual({ outfit: 'newclothes', clothes: 'white sundress', lastPictureMessage: 12 });
    });

    it('an entry with no stamp reads no message', () => {
        expect(wornOutfitOn(store, 'Yuki')).toEqual({ outfit: 'school-gym', clothes: '', lastPictureMessage: null });
    });

    it('her key is matched without regard to case', () => {
        expect(wornOutfitOn(store, 'mitsuki')).toMatchObject({ clothes: 'white sundress' });
    });

    it('nothing for her ⇒ null', () => {
        expect(wornOutfitOn(store, 'Mana')).toBeNull();
        expect(wornOutfitOn(store, '')).toBeNull();
        expect(wornOutfitOn(null, 'Mitsuki')).toBeNull();
        expect(wornOutfitOn({ Mitsuki: { outfit: '' } }, 'Mitsuki')).toBeNull();
        expect(wornOutfitOn({}, 'constructor')).toBeNull();
    });
});

describe('lastPictureOutfitsIn — who is offered "same-as-last-picture", and what it draws', () => {
    it('MUTATION TARGET — every outfit on file by name, every one-off with clothes, and nothing else', () => {
        const store = {
            Mitsuki: { outfit: 'newclothes', clothes: 'white sundress' },
            Yuki: { outfit: 'School-Gym', clothes: '' },
            Mana: { outfit: 'newclothes', clothes: '' },
            // an outfit on file draws its registered clothes, whatever text its entry carries: never a one-off
            Kana: { outfit: 'school-gym', clothes: 'stray text' },
            Rin: { outfit: '', clothes: 'x' },
        };
        expect(lastPictureOutfitsIn(store)).toEqual([
            { key: 'Mitsuki', outfit: 'newclothes', clothes: 'white sundress' },
            { key: 'Yuki', outfit: 'school-gym', clothes: '' },
            { key: 'Kana', outfit: 'school-gym', clothes: '' },
        ]);
    });

    it('no store ⇒ nobody', () => {
        expect(lastPictureOutfitsIn(null)).toEqual([]);
        expect(lastPictureOutfitsIn(['x'])).toEqual([]);
        expect(lastPictureOutfitsIn({})).toEqual([]);
    });
});

// The streetcleaner's first mission (plans/executed/streetcleaner.md §6): the clock here is a stand-in that counts every
// message as a reply; the real one is tested with the sweep (streetcleaner-core.test.js).
describe('wornOutfitCleaningMission — an entry no picture drew for more than 100 replies is dropped', () => {
    const clockAt = (replyIndex) => ({ replyIndex, repliesSince: (stamp) => Math.max(0, replyIndex - stamp) });
    const entry = (stamp) => ({ outfit: 'newclothes', clothes: 'sundress', last_picture_message: stamp });

    it('cleans the worn-outfit store, keeping 100 replies', () => {
        expect(wornOutfitCleaningMission.part).toBe(WORN_OUTFIT_PART);
        expect(WORN_OUTFIT_KEEP_REPLIES).toBe(100);
    });

    it('MUTATION TARGET — 100 replies after her last picture she is kept; 101 and she is dropped, with how old', () => {
        const { kept, dropped, warnings } = wornOutfitCleaningMission.sweep({ Kept: entry(100), Gone: entry(99) }, clockAt(200));
        expect(kept).toEqual({ Kept: entry(100) });
        expect(dropped).toEqual([{ key: 'Gone', why: 'last picture msg 99, 101 replies ago' }]);
        expect(warnings).toEqual([]);
    });

    it('MUTATION TARGET — what it keeps is kept as it was', () => {
        const store = { Mitsuki: entry(99), Late: entry(140) };
        const { kept } = wornOutfitCleaningMission.sweep(store, clockAt(100));
        expect(kept.Mitsuki).toBe(store.Mitsuki);
        expect(kept.Late).toBe(store.Late);
    });

    // The card's schema strips the field, or the chat was played before every picture stamped what it drew.
    it('MUTATION TARGET — an entry with no stamp is dropped, and the warning names the schema', () => {
        const store = { Old: { outfit: 'school-gym', clothes: '' }, Bad: { outfit: 'x', clothes: '', last_picture_message: 'x' }, Fine: entry(95) };
        const { kept, dropped, warnings } = wornOutfitCleaningMission.sweep(store, clockAt(100));
        expect(Object.keys(kept)).toEqual(['Fine']);
        expect(dropped).toEqual([{ key: 'Old', why: 'no stamp' }, { key: 'Bad', why: 'no stamp' }]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/worn_outfit entries arrive without last_picture_message, and they are dropped — the card's Zod schema strips the field \(declare \$mvuhelper open: z\.record\(z\.string\(\), z\.any\(\)\)\)/);
    });

    it('junk is no entry', () => {
        expect(wornOutfitCleaningMission.sweep(null, clockAt(10))).toEqual({ kept: {}, dropped: [], warnings: [] });
        const hostile = wornOutfitCleaningMission.sweep(JSON.parse('{"__proto__": {"outfit": "x", "last_picture_message": 9}}'), clockAt(10));
        expect(hostile.kept).toEqual({});
        expect(Object.getPrototypeOf(hostile.kept)).toBe(Object.prototype);
    });
});

// The path a picture takes: the state before its reply, then the reply's own pictures.
describe('the worn-outfit store end to end — a one-off, picked again, then replaced', () => {
    const entries = [{ key: 'Mitsuki', content: '[Body]\nb\n[Clothes:school-uniform]\nbrown uniform\n[Alias]\n美月' }];
    const sundress = [{ name: '美月', attributes: { outfit: 'newclothes', clothes: 'white sundress' } }];
    const sections = parseDnaSections(entries[0].content);

    it('MUTATION TARGET — Saturday\'s one-off is offered and drawn again by name; Monday\'s uniform replaces it', () => {
        const saturday = nextWornOutfit({}, { reports: wornReportsOf([{ name: '美月', outfit: 'newclothes' }], sundress, entries), replyIndex: 20 });
        expect(lastPictureOutfitsIn(saturday)).toEqual([{ key: 'Mitsuki', outfit: 'newclothes', clothes: 'white sundress' }]);
        // The next reply picks it from her line, and its picture is drawn from the store, mid-stream or not.
        expect(selectClothesForOutfit(sections, OUTFIT_SAME_AS_LAST_PICTURE, { carried: wornOutfitOn(saturday, 'Mitsuki') }))
            .toMatchObject({ clothes: 'white sundress', clothesSource: 'carried', warning: '' });
        const later = nextWornOutfit(saturday, { reports: wornReportsOf([{ name: 'Mitsuki', outfit: OUTFIT_SAME_AS_LAST_PICTURE }], [], entries), replyIndex: 22 });
        expect(later).toEqual({ Mitsuki: { outfit: 'newclothes', clothes: 'white sundress', last_picture_message: 22 } });
        // Monday's class names the uniform: the one-off is gone, and her line offers the uniform instead.
        const monday = nextWornOutfit(later, { reports: wornReportsOf([{ name: 'Mitsuki', outfit: 'school-uniform' }], [], entries), replyIndex: 30 });
        expect(monday).toEqual({ Mitsuki: { outfit: 'school-uniform', clothes: '', last_picture_message: 30 } });
        expect(lastPictureOutfitsIn(monday)).toEqual([{ key: 'Mitsuki', outfit: 'school-uniform', clothes: '' }]);
        // A picture without her, then one that picks it: still the uniform, and only her stamp moves.
        expect(selectClothesForOutfit(sections, OUTFIT_SAME_AS_LAST_PICTURE, { carried: wornOutfitOn(monday, 'Mitsuki') }))
            .toMatchObject({ clothes: 'brown uniform', clothesSource: 'carried', warning: '' });
        const tuesday = nextWornOutfit(monday, { reports: wornReportsOf([{ name: 'Mitsuki', outfit: OUTFIT_SAME_AS_LAST_PICTURE }], [], entries), replyIndex: 34 });
        expect(tuesday).toEqual({ Mitsuki: { outfit: 'school-uniform', clothes: '', last_picture_message: 34 } });
    });
});

describe('chooseLook — one drawn person: stored, else this reply, else none', () => {
    const entry = { key: 'Mitsuki', content: `${MITSUKI}\n[Bust]\n2` };
    const record = (attributes) => ({ name: 'Mitsuki', attributes });

    it('a stored look wins, with the clothes its outfit= selects and its [Bust]', () => {
        const look = chooseLook({ name: 'Mitsuki', entry, record: record({ body: 'man, other body', clothes: 'other clothes' }), outfit: 'gym' });
        expect(look).toMatchObject({ source: 'stored', body: parseDnaSections(MITSUKI).body, bust: 2 });
        expect(look.clothes).toContain('bloomers');
    });

    it('no stored look ⇒ the look her <cast> record gives her this reply', () => {
        const look = chooseLook({ name: 'Aria', entry: null, record: { name: 'Aria', attributes: { body: 'elf woman, silver hair', clothes: 'plate armor' } }, outfit: 'newclothes' });
        expect(look).toEqual({ source: 'reply', body: 'elf woman, silver hair', clothes: 'plate armor', clothesSource: 'reply', wornEntry: null, bust: null, warnings: [] });
    });

    it('a reply look drawn "undressed" keeps its body and drops its clothes', () => {
        const look = chooseLook({ name: 'Aria', record: { name: 'Aria', attributes: { body: 'elf woman', clothes: 'plate armor' } }, outfit: 'undressed' });
        expect(look.clothes).toBe('');
        expect(look.body).toBe('elf woman');
    });

    // A name-only placeholder is a row, not a look. MUTATION TARGET: count any entry as stored.
    it('a name-only placeholder is not a stored look', () => {
        const placeholder = { key: 'Aria', content: '' };
        expect(chooseLook({ name: 'Aria', entry: placeholder, record: null }).source).toBe('none');
        expect(chooseLook({ name: 'Aria', entry: placeholder, record: { name: 'Aria', attributes: { body: 'elf woman' } } }).source).toBe('reply');
    });

    it('nothing anywhere ⇒ none, with nothing to draw', () => {
        expect(chooseLook({ name: 'Ghost' })).toEqual({ source: 'none', body: '', clothes: '', clothesSource: '', wornEntry: null, bust: null, warnings: [] });
    });

    it('a record with clothes but no body= is not a look for someone with nothing stored', () => {
        expect(chooseLook({ name: 'Aria', record: { name: 'Aria', attributes: { outfit: 'newclothes', clothes: 'x' } } }).source).toBe('none');
    });

    // The picture log prints both, so a one-off on a stored look never reads as stored clothes. MUTATION TARGET:
    // report the look's source for the clothes too.
    it('where her clothes came from is reported apart from where her look came from', () => {
        const oneOff = chooseLook({ name: 'Mitsuki', entry, record: record({ outfit: 'newclothes', clothes: 'navy hoodie' }), outfit: 'newclothes' });
        expect(oneOff).toMatchObject({ source: 'stored', clothes: 'navy hoodie', clothesSource: 'reply' });
        const slip = chooseLook({ name: 'Mitsuki', entry, record: record({ outfit: 'newclothes' }), outfit: 'newclothes' });
        expect(slip).toMatchObject({ source: 'stored', clothes: '', clothesSource: '' });
        expect(chooseLook({ name: 'Mitsuki', entry, outfit: 'gym' }).clothesSource).toBe('stored');
        expect(chooseLook({ name: 'Mitsuki', entry, outfit: 'undressed' }).clothesSource).toBe('');
        expect(chooseLook({ name: 'Aria', record: { name: 'Aria', attributes: { body: 'elf woman' } } }).clothesSource).toBe('');
    });

    it('MUTATION TARGET — a stored look in "same-as-last-picture" wears the one-off the store holds, and says from which picture', () => {
        const allNamed = { key: 'Mitsuki', content: '[Body]\nb\n[Clothes:school-uniform]\nbrown uniform' };
        expect(chooseLook({ name: 'Mitsuki', entry: allNamed, outfit: OUTFIT_SAME_AS_LAST_PICTURE, carried: { outfit: 'newclothes', clothes: 'grey hoodie', lastPictureMessage: 41 } }))
            .toMatchObject({ source: 'stored', clothes: 'grey hoodie', clothesSource: 'carried', wornEntry: { outfit: '', lastPictureMessage: 41 }, warnings: [] });
    });

    it('MUTATION TARGET — a stored look\'s slip with nothing stored draws no clothes, and the warning names her', () => {
        const allNamed = { key: 'Mitsuki', content: '[Body]\nb\n[Clothes:school-uniform]\nbrown uniform' };
        const look = chooseLook({ name: 'Mitsuki', entry: allNamed, outfit: '' });
        expect(look).toMatchObject({ source: 'stored', clothes: '', clothesSource: '' });
        expect(look.warnings.join(' ')).toMatch(/"Mitsuki" was drawn with no outfit=/);
    });

    it('a look from this reply with no clothes= wears what the store holds, unless undressed', () => {
        const record = { name: 'Aria', attributes: { body: 'elf woman' } };
        const carried = { outfit: 'newclothes', clothes: 'plate armor', lastPictureMessage: 3 };
        expect(chooseLook({ name: 'Aria', record, outfit: OUTFIT_SAME_AS_LAST_PICTURE, carried }))
            .toMatchObject({ source: 'reply', clothes: 'plate armor', clothesSource: 'carried', wornEntry: { outfit: '', lastPictureMessage: 3 } });
        expect(chooseLook({ name: 'Aria', record, outfit: 'undressed', carried }).clothes).toBe('');
    });

    it('a stored entry with clothes but no [Body] draws its clothes and says so', () => {
        const look = chooseLook({ name: 'Ren', entry: { key: 'Ren', content: '[Clothes]\nred coat' }, outfit: 'default' });
        expect(look).toMatchObject({ source: 'stored', body: '', clothes: 'red coat' });
        expect(look.warnings.join(' ')).toMatch(/no \[Body\]/);
    });
});

describe('replyRecordOf / lookSourceFor / lookWaitsForReply / lookWaitsForRegistration', () => {
    const ENTRIES = [{ key: 'Mitsuki', content: `${MITSUKI}\n[Alias]\n橘美月` }, { key: 'Yuki', content: '' }];

    it('her records are found by the picture\'s name or any name her entry answers to, merged', () => {
        const records = [
            { name: '橘美月', attributes: { outfit: 'newclothes' } },
            { name: 'Mitsuki', attributes: { clothes: 'red dress', outfit: 'default' } },
            { name: 'Other', attributes: { clothes: 'x' } },
        ];
        expect(replyRecordOf(records, 'Mitsuki', ENTRIES[0])).toEqual({ name: '橘美月', attributes: { outfit: 'newclothes', clothes: 'red dress' } });
        expect(replyRecordOf(records, 'nobody', null)).toBeNull();
    });

    it('lookSourceFor names where a look would come from', () => {
        const records = [{ name: 'Aria', attributes: { body: 'elf woman' } }];
        expect(lookSourceFor('橘美月', ENTRIES, records)).toBe('stored');
        expect(lookSourceFor('Aria', ENTRIES, records)).toBe('reply');
        expect(lookSourceFor('Yuki', ENTRIES, records)).toBe('none');      // a placeholder
        expect(lookSourceFor('Ghost', ENTRIES, [])).toBe('none');
    });

    // MUTATION TARGET: return '' for newclothes and a pre-generated picture renders without its one-off.
    it('lookWaitsForReply: a stored look in a stored outfit, or drawn from the store, is drawn before the reply ends', () => {
        expect(lookWaitsForReply({ name: 'Mitsuki', outfit: 'gym', entries: ENTRIES })).toBe('');
        expect(lookWaitsForReply({ name: 'Mitsuki', outfit: OUTFIT_SAME_AS_LAST_PICTURE, entries: ENTRIES })).toBe('');
        expect(lookWaitsForReply({ name: 'Mitsuki', outfit: '', entries: ENTRIES })).toBe('');
        expect(lookWaitsForReply({ name: 'Mitsuki', outfit: 'undressed', entries: ENTRIES })).toBe('');
        expect(lookWaitsForReply({ name: 'Mitsuki', outfit: 'newclothes', entries: ENTRIES })).toMatch(/newclothes/);
        expect(lookWaitsForReply({ name: 'Mitsuki', outfit: 'pajama', entries: ENTRIES })).toMatch(/pajama/);
        expect(lookWaitsForReply({ name: 'Yuki', outfit: '', entries: ENTRIES })).toMatch(/no stored look/);
        expect(lookWaitsForReply({ name: 'Ghost', entries: ENTRIES })).toMatch(/no stored look/);
        // drawn from the store: the earlier replies that wrote it are written already
        expect(lookWaitsForReply({ name: 'Ren', entries: [{ key: 'Ren', content: '[Body]\nx' }] })).toBe('');
        expect(lookWaitsForReply({ name: 'Ren', outfit: 'default', entries: [{ key: 'Ren', content: '[Body]\nx' }] })).toBe('');
    });

    // An earlier picture in this same reply may take her clothes from this reply's records, written after the story:
    // "newclothes", or a name her record may define. One drawn from the store or in an outfit on file does not.
    it('MUTATION TARGET — lookWaitsForReply: a picture drawn from the store waits only on an earlier picture of THIS reply in clothes its records define', () => {
        const wait = (earlierSlots, outfit = OUTFIT_SAME_AS_LAST_PICTURE) => lookWaitsForReply({ name: 'Mitsuki', outfit, entries: ENTRIES, earlierSlots });
        expect(wait([{ key: '橘美月', outfit: 'newclothes' }])).toMatch(/earlier in this reply/);
        expect(wait([{ key: 'Mitsuki', outfit: 'pajama' }])).toMatch(/earlier in this reply/);
        expect(wait([{ key: 'Mitsuki', outfit: 'newclothes' }], '')).toMatch(/earlier in this reply/);
        expect(wait([{ key: 'Mitsuki', outfit: '' }])).toBe('');
        expect(wait([{ key: 'Mitsuki', outfit: OUTFIT_SAME_AS_LAST_PICTURE }])).toBe('');
        expect(wait([{ key: 'Mitsuki', outfit: 'gym' }])).toBe('');
        expect(wait([{ key: 'Mitsuki', outfit: 'undressed' }])).toBe('');
        expect(wait([{ key: 'Yuki', outfit: 'newclothes' }])).toBe('');
        expect(wait([{ key: 'Mitsuki', outfit: 'newclothes' }], 'gym')).toBe('');
    });

    // While a POST call stores looks, its look is the one kept, so a picture waits for it. MUTATION TARGETS: count
    // a placeholder as stored, skip the alias lookup, or let a reserved word wait on a registration never coming.
    it('lookWaitsForRegistration: a picture waits until a look is STORED — a look in the reply does not end the wait', () => {
        const records = [{ name: 'Aria', attributes: { body: 'elf woman' } }];
        expect(lookSourceFor('Aria', ENTRIES, records)).toBe('reply');     // this reply describes her …
        expect(lookWaitsForRegistration('Aria', ENTRIES)).toBe(true);       // … and her picture still waits
        expect(lookWaitsForRegistration('Yuki', ENTRIES)).toBe(true);       // a name-only placeholder
        expect(lookWaitsForRegistration('Ghost', ENTRIES)).toBe(true);
        expect(lookWaitsForRegistration('Mitsuki', ENTRIES)).toBe(false);
        expect(lookWaitsForRegistration('橘美月', ENTRIES)).toBe(false);    // through her alias
        for (const word of ['default', 'Undressed', 'newclothes', 'Same-As-Last-Picture', 'None', '']) expect(lookWaitsForRegistration(word, ENTRIES)).toBe(false);
    });
});

describe('appendClothesVariant (a registered character gains an outfit)', () => {
    it('appendClothesVariant appends a new section', () => {
        const r = appendClothesVariant(MITSUKI, 'sunday', 'white sundress, straw hat');
        expect(r.changed).toBe(true);
        const s = parseDnaSections(r.content);
        expect(s.clothes.sunday).toBe('white sundress, straw hat');
        expect(s.clothes.default).toContain('green ribbon bow');   // existing sections intact
        expect(s.body).toContain('plum-purple hair');
    });
    it('appendClothesVariant never clobbers an existing variant', () => {
        const r = appendClothesVariant(MITSUKI, 'gym', 'something else');
        expect(r.changed).toBe(false);
        expect(r.content).toBe(MITSUKI.trim());
        expect(r.reason).toContain('already registered');
    });
    it('appendClothesVariant variant name matched case-insensitively', () => {
        expect(appendClothesVariant(MITSUKI, 'GYM', 'x').changed).toBe(false);
    });
    it('appendClothesVariant rejects empty inputs', () => {
        expect(appendClothesVariant(MITSUKI, '', 'x').changed).toBe(false);
        expect(appendClothesVariant(MITSUKI, 'sunday', '').changed).toBe(false);
    });
    // A character's first clothes saved as "default" are her [Clothes], the section every reader and the Roster tab
    // know. MUTATION TARGET: write [Clothes:default] and the entry carries a label nothing else writes.
    it('"default" is appended as [Clothes], and never over a [Clothes] already on file', () => {
        const r = appendClothesVariant('[Body]\nwoman, pink hair', 'Default', 'pink gothic dress');
        expect(r).toEqual({ changed: true, content: '[Body]\nwoman, pink hair\n[Clothes]\npink gothic dress' });
        expect(parseDnaSections(r.content).clothes).toEqual({ default: 'pink gothic dress' });
        const again = appendClothesVariant(MITSUKI, 'default', 'x');
        expect(again.changed).toBe(false);
        expect(again.reason).toBe('[Clothes] already registered');
    });
    it('round-trip: an appended outfit is selected by its key', () => {
        const r = appendClothesVariant(MITSUKI, 'sunday', 'white sundress');
        const look = chooseLook({ name: 'Mitsuki', entry: { key: 'Mitsuki', content: r.content }, outfit: 'sunday' });
        expect(look.warnings).toEqual([]);
        expect(look.clothes).toBe('white sundress');
    });
});

describe('parseBustMultiplier ([Bust] → the backend LoRA strength)', () => {
    it('reads the number and keeps it out of the look', () => {
        const content = '[Body]\nred hair\n[Bust]\n2.1\n[Clothes]\nuniform';
        expect(parseBustMultiplier('Iori', content).value).toBe(2.1);
        expect(chooseLook({ name: 'Iori', entry: { key: 'Iori', content }, outfit: 'default' })).toMatchObject({ body: 'red hair', clothes: 'uniform', bust: 2.1 });
    });

    it('an entry with no [Bust] returns null, silently — that is not an error', () => {
        const res = parseBustMultiplier('Iori', '[Body]\nred hair');
        expect(res.value).toBeNull();
        expect(res.warnings).toEqual([]);
    });

    it('a present-but-unreadable value WARNS instead of silently defaulting', () => {
        const res = parseBustMultiplier('Iori', '[Body]\nred hair\n[Bust]\nbig');
        expect(res.value).toBeNull();
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings[0]).toContain('[Bust]');
    });

    it('rejects a negative multiplier', () => {
        expect(parseBustMultiplier('Iori', '[Body]\nx\n[Bust]\n-3').value).toBeNull();
    });

    it('[Bust] does not swallow the clothes variants that follow it', () => {
        const content = '[Body]\nred hair\n[Bust]\n1.5\n[Clothes]\nuniform\n[Clothes:gym]\ngym kit';
        const sections = parseDnaSections(content);
        expect(sections.bust).toBe('1.5');
        expect(sections.clothes.gym).toBe('gym kit');
        expect(sections.body).toBe('red hair');
    });
});

// ── [Alias] — the drift repair (plans/roster-registration-integrity.md P6) ────
// No prompt stops a model spelling one name two ways, so the user declares the equivalence once
// and every lookup resolves through it. These tests pin the PURE half; dna.js owns the lorebook.
describe('[Alias] section', () => {
    const VISCOUNT = `[Body]
middle-aged male, thin mustache, brown eyes
[Clothes]
tattered red noble robe
[Alias]
阿曼德
Amand`;

    it('parses aliases, one per line', () => {
        expect(parseDnaSections(VISCOUNT).aliases).toEqual(['阿曼德', 'Amand']);
    });

    it('does not disturb the sections around it', () => {
        const s = parseDnaSections(VISCOUNT);
        expect(s.body).toBe('middle-aged male, thin mustache, brown eyes');
        expect(s.clothes.default).toBe('tattered red noble robe');
    });

    it('an entry with no [Alias] reports none', () => {
        expect(listAliases('[Body]\nred hair')).toEqual([]);
        expect(listAliases('')).toEqual([]);
    });

    // A name may legally contain a comma or a middle dot (阿曼德·布劳尔) — splitting on
    // punctuation instead of newlines would shred real keys into fragments.
    it('does NOT split a key on its middle dot or comma', () => {
        expect(listAliases('[Body]\nx\n[Alias]\n阿曼德·布劳尔')).toEqual(['阿曼德·布劳尔']);
        expect(listAliases('[Body]\nx\n[Alias]\nSmith, John')).toEqual(['Smith, John']);
    });

    it('repeated [Alias] sections accumulate rather than overwrite', () => {
        expect(listAliases('[Body]\nx\n[Alias]\nA\n[Alias]\nB')).toEqual(['A', 'B']);
    });

    it('drops duplicates case-insensitively, keeping the first spelling', () => {
        expect(listAliases('[Body]\nx\n[Alias]\nAmand\namand\nAMAND')).toEqual(['Amand']);
    });

    it('a variant after [Alias] still parses — [Alias] does not swallow it', () => {
        const s = parseDnaSections('[Body]\nx\n[Alias]\nA\n[Clothes:gym]\ngym kit');
        expect(s.aliases).toEqual(['A']);
        expect(s.clothes.gym).toBe('gym kit');
    });
});

describe('entryAnswersTo', () => {
    const content = '[Body]\nx\n[Alias]\n阿曼德';

    it('matches the entry\'s own key', () => {
        expect(entryAnswersTo('阿曼德·布劳尔', content, '阿曼德·布劳尔')).toBe(true);
    });

    it('matches an alias', () => {
        expect(entryAnswersTo('阿曼德·布劳尔', content, '阿曼德')).toBe(true);
    });

    it('is case-insensitive, like every other key comparison in the registry', () => {
        expect(entryAnswersTo('Mitsuki', '[Body]\nx\n[Alias]\nMitchi', 'MITCHI')).toBe(true);
        expect(entryAnswersTo('Mitsuki', '', 'mitsuki')).toBe(true);
    });

    it('rejects a stranger, and rejects empty', () => {
        expect(entryAnswersTo('阿曼德·布劳尔', content, '莉莉絲')).toBe(false);
        expect(entryAnswersTo('阿曼德·布劳尔', content, '')).toBe(false);
        expect(entryAnswersTo('阿曼德·布劳尔', content, '   ')).toBe(false);
    });
});

describe('appendAliases', () => {
    it('appends a new alias and reports what it added', () => {
        const res = appendAliases('[Body]\nx', '阿曼德·布劳尔', 'Amand');
        expect(res.changed).toBe(true);
        expect(res.added).toEqual(['Amand']);
        expect(listAliases(res.content)).toEqual(['Amand']);
    });

    it('carries several at once and preserves the existing ones', () => {
        const res = appendAliases('[Body]\nx\n[Alias]\nA', 'Key', ['B', 'C']);
        expect(listAliases(res.content)).toEqual(['A', 'B', 'C']);
    });

    // A self-referencing alias is a cycle the resolver would never reach — exact key wins first.
    it('refuses to alias an entry to its OWN key', () => {
        const res = appendAliases('[Body]\nx', 'Mitsuki', 'mitsuki');
        expect(res.changed).toBe(false);
        expect(res.added).toEqual([]);
    });

    it('is idempotent — re-adding a known alias changes nothing', () => {
        const once = appendAliases('[Body]\nx', 'Key', 'Amand');
        const twice = appendAliases(once.content, 'Key', 'AMAND');
        expect(twice.changed).toBe(false);
        expect(twice.content).toBe(once.content);
    });

    it('empty / blank input is a no-op, not an empty alias line', () => {
        expect(appendAliases('[Body]\nx', 'Key', '   ').changed).toBe(false);
        expect(appendAliases('[Body]\nx', 'Key', []).changed).toBe(false);
    });

    it('the appended content still parses as a whole entry', () => {
        const res = appendAliases('[Body]\nred hair\n[Clothes]\nuniform', 'Key', 'Alt');
        const s = parseDnaSections(res.content);
        expect(s.body).toBe('red hair');
        expect(s.clothes.default).toBe('uniform');
        expect(s.aliases).toEqual(['Alt']);
    });
});

describe('hasStoredAppearance — placeholder vs real DNA (the mechanical-registration chain)', () => {
    it('a name-only entry has no appearance', () => {
        expect(hasStoredAppearance('')).toBe(false);
        expect(hasStoredAppearance(null)).toBe(false);
        expect(hasStoredAppearance('   \n  ')).toBe(false);
    });

    it('an [Alias]-only entry is still a placeholder — a name is not a look', () => {
        expect(hasStoredAppearance('[Alias]\n橘美月')).toBe(false);
    });

    it('body OR clothes counts as real — either means a human or a harvest authored it', () => {
        expect(hasStoredAppearance('[Body]\nlong purple hair')).toBe(true);
        expect(hasStoredAppearance('[Clothes]\nschool uniform')).toBe(true);
        expect(hasStoredAppearance('[Clothes:gym]\ngym uniform')).toBe(true);
    });

    it('an EMPTY [Body] header is not appearance — the header alone must not lock the placeholder', () => {
        // This is the one that decides whether harvest can ever fill a minted entry: if a bare
        // header counted, the placeholder would masquerade as real DNA and harvest would skip it
        // forever, which is the exact failure minting exists to end.
        expect(hasStoredAppearance('[Body]\n')).toBe(false);
        expect(hasStoredAppearance('[Body]\n\n[Clothes]\n   ')).toBe(false);
    });
});

// D10 — ONE CHARACTER UNDER TWO KEYS. Measured live 2026-09-19 across three generations: a reply
// registered <charImage char="Nanami Kujou"> and drew <pic char2="Nanami">, neither resolved to the
// other, and she vanished from her own "2girls, 1boy" render. A second generation left TWO entries
// for her with two different faces.
describe('namesNearMiss — the shape that splits one character across two keys', () => {
    it('MUTATION TARGET: the live pair, both directions and either case', () => {
        expect(namesNearMiss('Nanami', 'Nanami Kujou')).toBe(true);
        expect(namesNearMiss('Nanami Kujou', 'Nanami')).toBe(true);
        expect(namesNearMiss('nanami', 'NANAMI KUJOU')).toBe(true);
        expect(namesNearMiss('  Nanami  ', 'Nanami Kujou')).toBe(true);
    });

    // TWO DIFFERENT PEOPLE who share a given name are NOT a split. Neither is the first token of the
    // other, and warning here would fire on every classmate pair the story invents.
    it('two full names sharing a first name are NOT a split', () => {
        expect(namesNearMiss('Haruka Sato', 'Haruka Kurusu')).toBe(false);
        expect(namesNearMiss('Nanami Kujou', 'Nanami Ito')).toBe(false);
    });

    it('identical, empty and junk names are not splits', () => {
        expect(namesNearMiss('Nanami', 'Nanami')).toBe(false);
        expect(namesNearMiss('Nanami', 'nanami')).toBe(false);
        for (const junk of ['', null, undefined, '   ']) {
            expect(namesNearMiss('Nanami', junk)).toBe(false);
            expect(namesNearMiss(junk, 'Nanami')).toBe(false);
        }
    });

    // A CJK full name is unspaced, so it has no first token. A prefix test over two-character kanji
    // given names would fire on unrelated pairs, so that case is deliberately NOT covered here.
    it('unspaced CJK names are out of scope, stated not hidden', () => {
        expect(namesNearMiss('来栖遥香', '遥香')).toBe(false);
        expect(namesNearMiss('遥香', '来栖遥香')).toBe(false);
    });

    it('a middle name still splits against the given name', () => {
        expect(namesNearMiss('Amand', 'Amand de Brouwer')).toBe(true);
    });
});

describe('findNameSplits — which pairs get reported', () => {
    const entry = (key, content) => ({ key, content: content || ['[Body]', 'x'].join(String.fromCharCode(10)) });

    // THE CASE THAT COST A CHARACTER: the registry was EMPTY, so comparing against it finds nothing.
    // The disagreement was between the two TAG FAMILIES in one reply.
    it('MUTATION TARGET: catches the within-reply split with an EMPTY registry', () => {
        const hits = findNameSplits('Nanami Kujou', { drawnNames: ['Mitsuki', 'Nanami'], entries: [] });
        expect(hits).toEqual([{ other: 'Nanami', where: 'drawn by a <pic> in this same reply' }]);
    });

    it('catches the cross-reply split against an existing entry', () => {
        const hits = findNameSplits('Nanami Kujou', { drawnNames: [], entries: [entry('Mitsuki'), entry('Nanami')] });
        expect(hits).toEqual([{ other: 'Nanami', where: 'already a registry entry' }]);
    });

    it('finds it through an ALIAS on the other entry, not only its key', () => {
        const withAlias = entry('Kujou-san', ['[Body]', 'x', '[Alias]', 'Nanami'].join(String.fromCharCode(10)));
        expect(findNameSplits('Nanami Kujou', { entries: [withAlias] }))
            .toEqual([{ other: 'Kujou-san', where: 'already a registry entry' }]);
    });

    it('reports each other-name ONCE however many arms found it', () => {
        const hits = findNameSplits('Nanami Kujou', { drawnNames: ['Nanami'], entries: [entry('Nanami')] });
        expect(hits.length).toBe(1);
        expect(hits[0].where).toBe('drawn by a <pic> in this same reply');
    });

    // THE FALSE POSITIVE THE LIVE REGISTRY FOUND, and no fixture would have. Every School heroine is
    // keyed by her given name and carries her full name as an [Alias], so "Mitsuki" is a near-miss of
    // her own alias "Mitsuki Tachibana" — the registry arm reported all 21 of them against themselves.
    // MUTATION TARGET: drop the entryAnswersTo guard and this fires on every registered heroine.
    it('a heroine is never a split against her OWN entry', () => {
        const heroine = { key: 'Mitsuki', content: ['[Body]', 'x', '[Alias]', 'Tachibana', 'Mitsuki Tachibana'].join(String.fromCharCode(10)) };
        expect(findNameSplits('Mitsuki', { entries: [heroine] })).toEqual([]);
        expect(findNameSplits('Mitsuki Tachibana', { entries: [heroine] })).toEqual([]);
        // ...but a DIFFERENT character who shortens to her key still reports.
        const other = { key: 'Mitsuki Aoyama', content: ['[Body]', 'y'].join(String.fromCharCode(10)) };
        expect(findNameSplits('Mitsuki Aoyama', { entries: [heroine, other] }))
            .toEqual([{ other: 'Mitsuki', where: 'already a registry entry' }]);
    });

    it('says nothing for a clean reply', () => {
        expect(findNameSplits('Mitsuki', { drawnNames: ['Mitsuki', 'Mana'], entries: [entry('Mitsuki'), entry('Mana')] })).toEqual([]);
        expect(findNameSplits('Haruka Sato', { drawnNames: ['Haruka Kurusu'], entries: [entry('Haruka Kurusu')] })).toEqual([]);
    });

    it('junk in, empty out — never a throw', () => {
        expect(findNameSplits('Nanami', {})).toEqual([]);
        expect(findNameSplits('Nanami', { drawnNames: null, entries: null })).toEqual([]);
        expect(findNameSplits('Nanami', { entries: [null, undefined] })).toEqual([]);
    });
});

// D11 — [AllowUpdate], the per-character switch that lets the STORY replace clothes already on file.
// One more non-image section beside [Bust] and [Alias]. ABSENT MEANS FALSE, which is the behaviour
// every entry already has, so nothing migrates and there is no version field.
describe('[AllowUpdate] — reading the switch', () => {
    const entry = (tail) => ['[Body]', 'b tags', '[Clothes]', 'old clothes', '[Clothes:gym]', 'gym kit', '[Alias]', 'Nan']
        .concat(tail || []).join(String.fromCharCode(10));

    it('MUTATION TARGET: absent reads false, and says nothing about it', () => {
        expect(allowsClothesUpdate(entry())).toEqual({ allowed: false, warning: '' });
    });

    it('true and false are read, either case, either spacing', () => {
        expect(allowsClothesUpdate(entry(['[AllowUpdate]', 'true'])).allowed).toBe(true);
        expect(allowsClothesUpdate(entry(['[AllowUpdate]', '  TRUE  '])).allowed).toBe(true);
        expect(allowsClothesUpdate(entry(['[AllowUpdate]', 'false'])).allowed).toBe(false);
        expect(allowsClothesUpdate(entry(['[AllowUpdate]', 'False'])).warning).toBe('');
    });

    // FAIL CLOSED: a flag that cannot be parsed must never be the one authorising an overwrite.
    it('an unreadable value reads FALSE and warns', () => {
        const r = allowsClothesUpdate(entry(['[AllowUpdate]', 'yes please']));
        expect(r.allowed).toBe(false);
        expect(r.warning).toContain('unreadable');
        expect(r.warning).toContain('yes please');
    });

    // The section must not be swallowed into whichever section precedes it, which is what an untaught
    // SECTION_RE does -- and [Alias] is LAST in these entries, so the tag and its value would have
    // become ALIASES that entryAnswersTo then matches.
    it('the parser KNOWS the label — it never leaks into [Alias]', () => {
        const withFlag = entry(['[AllowUpdate]', 'true']);
        expect(listAliases(withFlag)).toEqual(['Nan']);
        expect(parseDnaSections(withFlag).allowUpdate).toBe('true');
        expect(entryAnswersTo('X', withFlag, 'true')).toBe(false);
        expect(entryAnswersTo('X', withFlag, '[AllowUpdate]')).toBe(false);
    });
});

describe('setAllowUpdate — the GUI writes the section, never removes one', () => {
    const base = ['[Body]', 'b tags', '[Clothes]', 'old clothes', '[Alias]', 'Nan'].join(String.fromCharCode(10));

    it('appends on first enable, then FLIPS the value in place', () => {
        const on = setAllowUpdate(base, true);
        expect(on.changed).toBe(true);
        expect(allowsClothesUpdate(on.content).allowed).toBe(true);
        const off = setAllowUpdate(on.content, false);
        expect(off.changed).toBe(true);
        expect(allowsClothesUpdate(off.content).allowed).toBe(false);
        // turning it OFF needs no section-removal helper
        expect(off.content).toContain('[AllowUpdate]');
    });

    it('is idempotent', () => {
        const on = setAllowUpdate(base, true);
        expect(setAllowUpdate(on.content, true).changed).toBe(false);
    });

    it('leaves every other section intact', () => {
        const on = setAllowUpdate(base, true);
        const p = parseDnaSections(on.content);
        expect(p.body).toBe('b tags');
        expect(p.clothes.default).toBe('old clothes');
        expect(listAliases(on.content)).toEqual(['Nan']);
    });
});

describe('replaceClothesInContent — the only writer that overwrites appearance', () => {
    const base = ['[Body]', 'b tags', '[Clothes]', 'old clothes', '[Clothes:gym]', 'gym kit', '[Alias]', 'Nan'].join(String.fromCharCode(10));

    it('MUTATION TARGET: replaces the default outfit and NOTHING else', () => {
        const r = replaceClothesInContent(base, '', 'new clothes');
        expect(r.changed).toBe(true);
        const p = parseDnaSections(r.content);
        expect(p.clothes.default).toBe('new clothes');
        expect(p.clothes.gym).toBe('gym kit');
        expect(p.body).toBe('b tags');
        expect(listAliases(r.content)).toEqual(['Nan']);
    });

    it('"default" targets the same section as ""', () => {
        expect(parseDnaSections(replaceClothesInContent(base, 'default', 'x').content).clothes.default).toBe('x');
    });

    it('replaces a NAMED variant, leaving the default alone', () => {
        const p = parseDnaSections(replaceClothesInContent(base, 'gym', 'new gym').content).clothes;
        expect(p.gym).toBe('new gym');
        expect(p.default).toBe('old clothes');
    });

    // This path CORRECTS clothes on file. Creating a section is appendClothesVariant's job, which has
    // its own no-clobber rule -- doing both here would make one function two features.
    it('never CREATES a section that is not there', () => {
        const r = replaceClothesInContent(base, 'pajama', 'x');
        expect(r.changed).toBe(false);
        expect(r.reason).toContain('no [Clothes:pajama]');
        expect(r.content).toBe(base.trim());
    });

    it('empty or identical clothes change nothing', () => {
        expect(replaceClothesInContent(base, '', '').changed).toBe(false);
        expect(replaceClothesInContent(base, '', 'old clothes').reason).toBe('identical');
    });
});

// D11 — THE GATE. Every clothes-overwrite in the codebase passes through this one decision.
describe('mayStoryReplaceClothes — the switch AND the informed signal, together', () => {
    const entry = (flag) => ['[Body]', 'b', '[Clothes]', 'old']
        .concat(flag === undefined ? [] : ['[AllowUpdate]', flag]).join(String.fromCharCode(10));

    it('MUTATION TARGET: allowed only when the switch is ON and she was UNINFORMED', () => {
        expect(mayStoryReplaceClothes('Nanami', entry('true'), ['Mitsuki']).allowed).toBe(true);
    });

    it('the switch OFF blocks it however uninformed she was', () => {
        expect(mayStoryReplaceClothes('Nanami', entry('false'), []).allowed).toBe(false);
        expect(mayStoryReplaceClothes('Nanami', entry(), []).allowed).toBe(false);          // absent
        expect(mayStoryReplaceClothes('Nanami', entry(), []).reason).toContain('[AllowUpdate]');
    });

    // An INFORMED character is told to take default/a listed variant/undressed and is forbidden
    // `newclothes`, so she never invents and her registration proves nothing.
    it('being INFORMED blocks it however true the switch is', () => {
        const r = mayStoryReplaceClothes('Nanami', entry('true'), ['Mitsuki', 'Nanami']);
        expect(r.allowed).toBe(false);
        expect(r.reason).toContain('SHOWED');
    });

    it('the informed match is case- and space-insensitive, like every other key comparison', () => {
        expect(mayStoryReplaceClothes('Nanami', entry('true'), ['  nanami  ']).allowed).toBe(false);
    });

    // FAIL CLOSED. null = the turn was never measured; unknown must never authorise an overwrite.
    it('MUTATION TARGET: an UNMEASURED turn reads as informed', () => {
        expect(mayStoryReplaceClothes('Nanami', entry('true'), null).allowed).toBe(false);
        expect(mayStoryReplaceClothes('Nanami', entry('true'), undefined).allowed).toBe(false);
        // ...but an EMPTY list is a measurement ("nobody was shown"), and that is when it is legitimate
        expect(mayStoryReplaceClothes('Nanami', entry('true'), []).allowed).toBe(true);
    });

    it('an unreadable flag blocks it AND surfaces the warning', () => {
        const r = mayStoryReplaceClothes('Nanami', entry('maybe'), []);
        expect(r.allowed).toBe(false);
        expect(r.warning).toContain('unreadable');
    });
});

describe('namesWithoutRegistration — a drawn or asked-for character the registration call skipped', () => {
    // Live 2026-09-24: a POST call drew no tag for 相川老師, whom the reply's own <pic> named.
    // MUTATION TARGET: return [] and this fails.
    it('returns a name no registration carries, as written', () => {
        expect(namesWithoutRegistration(['相川老師', 'Mitsuki'], ['Mitsuki'])).toEqual(['相川老師']);
    });

    // MUTATION TARGET: compare case-sensitively and a correct registration is reported as missing.
    it('matches a registration case-insensitively, like every key comparison', () => {
        expect(namesWithoutRegistration(['Mitsuki'], ['mitsuki'])).toEqual([]);
    });

    it('reports each name once, however many pics drew it', () => {
        expect(namesWithoutRegistration(['Mana', 'mana', 'Mana'], [])).toEqual(['Mana']);
    });

    // One cause, one line: a registration that spells the name differently is findNameSplits' report.
    it('leaves a differently-spelled registration to the split check', () => {
        expect(namesWithoutRegistration(['Nanami'], ['Nanami Kujou'])).toEqual([]);
    });

    // The harvest's second use: the newcomers the POST call was asked to register, against what this reply
    // registered AND drew — a drawn one is the drawn check's line, so one name gets one warning.
    it('an asked-for newcomer left out by a registration or a picture is not reported again', () => {
        expect(namesWithoutRegistration(['英妮', '索拉雅', '惠娜里'], ['英妮', ...['索拉雅']])).toEqual(['惠娜里']);
    });

    it('never throws on garbage', () => {
        expect(namesWithoutRegistration(null, undefined)).toEqual([]);
        expect(namesWithoutRegistration(['', '  ', null], ['x'])).toEqual([]);
    });
});

describe('registrationFromCastRecord — what one cast record asks of the registry', () => {
    const record = (name, attributes = {}) => ({ name, attributes });

    // The record says what it carries; where her clothes go depends on what her entry holds, which only the caller
    // can look up (registrationClothesTarget). MUTATION TARGET: decide the target here, from the record alone, and a
    // character with clothes on file loses the rule that a one-off of hers is never saved.
    it('body= makes a CHARACTER registration, carrying outfit= (lower-cased) and clothes= as written', () => {
        expect(registrationFromCastRecord(record('Aqua', { body: 'blue hair', outfit: 'default', clothes: 'blue goddess dress' })))
            .toEqual({ ok: true, kind: 'char', name: 'Aqua', body: 'blue hair', outfit: 'default', clothes: 'blue goddess dress' });
        expect(registrationFromCastRecord(record('Tanaka', { body: 'man', outfit: 'Postal-Uniform', clothes: 'blue cap' })))
            .toEqual({ ok: true, kind: 'char', name: 'Tanaka', body: 'man', outfit: 'postal-uniform', clothes: 'blue cap' });
        expect(registrationFromCastRecord(record('Varro', { body: 'man' })))
            .toEqual({ ok: true, kind: 'char', name: 'Varro', body: 'man', outfit: '', clothes: '' });
    });

    // Live 2026-08-08: a registration carrying outfit="newclothes" was discarded whole when outfit= was
    // read first. outfit= beside body= says what she wears NOW; it never turns her into an outfit.
    // MUTATION TARGET: test outfit before body and every one of these fails.
    it('body= decides, whatever outfit= says beside it', () => {
        for (const outfit of ['newclothes', 'undressed', 'none', 'default', 'pajama', '日曜日', 'has space']) {
            const r = registrationFromCastRecord(record('A', { body: 'x', clothes: 'y', outfit }));
            expect(r.ok).toBe(true);
            expect(r.kind).toBe('char');
        }
    });

    it('a name-only record is PRESENCE: she is in the scene and nothing is registered', () => {
        expect(registrationFromCastRecord(record('Mitsuki'))).toEqual({ ok: true, kind: 'presence', name: 'Mitsuki' });
        // outfit= alone says what she wears now, which the registry does not store
        expect(registrationFromCastRecord(record('Mitsuki', { outfit: 'swimsuit' })).kind).toBe('presence');
    });

    // A NEW outfit name must say which clothes it is; harvest reads `nameProblem` only for a name not yet
    // on file, so a hand-added bare name can still be corrected. A name in another script, or with a space, is no
    // static name either: the record is still an outfit, and its clothes follow what her entry holds.
    it('clothes= with a named outfit= is an OUTFIT (key lower-cased), and says when the name is not static', () => {
        expect(registrationFromCastRecord(record('Mitsuki', { outfit: 'Cafe-Waitress', clothes: 'black dress' })))
            .toEqual({ ok: true, kind: 'outfit', name: 'Mitsuki', outfit: 'cafe-waitress', clothes: 'black dress', nameProblem: '' });
        expect(registrationFromCastRecord(record('Mitsuki', { outfit: 'Pajama', clothes: 'pink nightdress' })))
            .toMatchObject({ kind: 'outfit', outfit: 'pajama' });
        expect(registrationFromCastRecord(record('Mitsuki', { outfit: 'Pajama', clothes: 'pink nightdress' })).nameProblem)
            .toMatch(/not a <place or role>-<outfit> name/);
        for (const outfit of ['日曜日', 'sun day']) {
            const r = registrationFromCastRecord(record('M', { outfit, clothes: 'x' }));
            expect(r).toMatchObject({ ok: true, kind: 'outfit', outfit });
            expect(r.nameProblem).toMatch(/not a <place or role>-<outfit> name/);
        }
    });

    it('clothes= with outfit= absent or "default" is a CLOTHES record: her default clothes', () => {
        expect(registrationFromCastRecord(record('Mitsuki', { clothes: 'red coat' })))
            .toEqual({ ok: true, kind: 'clothes', name: 'Mitsuki', outfit: '', clothes: 'red coat' });
        expect(registrationFromCastRecord(record('Mitsuki', { outfit: 'default', clothes: 'red coat' })))
            .toEqual({ ok: true, kind: 'clothes', name: 'Mitsuki', outfit: 'default', clothes: 'red coat' });
    });

    // A one-off is a valid record, not a refusal. MUTATION TARGET: refuse it again and harvest warns on every
    // one-off the narrator correctly writes.
    it('clothes= with outfit="newclothes" is a ONE-OFF: a valid record', () => {
        expect(registrationFromCastRecord(record('M', { outfit: 'NewClothes', clothes: 'plate armor' })))
            .toEqual({ ok: true, kind: 'oneoff', name: 'M', outfit: 'newclothes', clothes: 'plate armor' });
    });

    it('clothes= with outfit="undressed" contradicts itself and is refused', () => {
        const r = registrationFromCastRecord(record('M', { outfit: 'undressed', clothes: 'x' }));
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/undressed wears nothing/);
    });

    it('a reserved outfit word as a NAME is refused — an entry under it could never be matched', () => {
        for (const bad of RESERVED_OUTFIT_NAMES) {
            const r = registrationFromCastRecord(record(bad, { body: 'x' }));
            expect(r.ok).toBe(false);
            expect(r.name).toBe(bad);
        }
    });

    it('values are trimmed and a missing name is refused', () => {
        expect(registrationFromCastRecord(record('  Aya ', { body: ' red hair ' }))).toMatchObject({ name: 'Aya', body: 'red hair' });
        expect(registrationFromCastRecord(record('', { body: 'x' })).ok).toBe(false);
        expect(registrationFromCastRecord(null).ok).toBe(false);
    });

    it('registrationToEntryContent puts her clothes in the section her registration names', () => {
        expect(registrationToEntryContent({ body: 'b', clothes: 'c', variant: 'default' })).toBe('[Body]\nb\n[Clothes]\nc');
        expect(registrationToEntryContent({ body: 'b', clothes: 'c', variant: 'cafe-waitress' })).toBe('[Body]\nb\n[Clothes:cafe-waitress]\nc');
        expect(registrationToEntryContent({ body: 'b', clothes: 'c', variant: '' })).toBe('[Body]\nb');
        expect(registrationToEntryContent({ body: 'b', clothes: '', variant: 'default' })).toBe('[Body]\nb');
    });
});

// WHERE A RECORD'S CLOTHES GO (plans/reply-cast.md D29): a character's FIRST clothes are always kept — under a static
// name, else as her [Clothes] — and after that only static clothes are saved.
describe('registrationClothesTarget — where the clothes on a record are saved', () => {
    const none = { hasClothesOnFile: false };
    const some = { hasClothesOnFile: true };

    // MUTATION TARGET: keep her body only and a character the card ships no outfit for (an RPG party member, a
    // teacher, a relative) has no clothes on file, so every picture of her after the worn-outfit store lets go of
    // her one-off draws her in clothes made up again.
    it('with no clothes on file, "newclothes" keeps them as her [Clothes] ("default")', () => {
        expect(registrationClothesTarget('black tuxedo', 'newclothes', none))
            .toEqual({ variant: 'default', clothes: 'black tuxedo', refusal: '', notice: '' });
        expect(registrationClothesTarget('black tuxedo', 'default', none))
            .toEqual({ variant: 'default', clothes: 'black tuxedo', refusal: '', notice: '' });
    });

    it('a static <place or role>-<outfit> name keeps them under that name, with or without clothes on file', () => {
        for (const state of [none, some]) {
            expect(registrationClothesTarget('blue cap, grey jacket', 'Postal-Uniform', state))
                .toEqual({ variant: 'postal-uniform', clothes: 'blue cap, grey jacket', refusal: '', notice: '' });
        }
    });

    // The record broke the outfit rules, and they are the only clothes she has: kept, and the notice names the break
    // for the caller's warning. MUTATION TARGET: refuse them and one slip in outfit= leaves her with no clothes on file.
    it('with no clothes on file, a missing, bare or reserved outfit= keeps them as [Clothes] and names the break', () => {
        const unsaid = registrationClothesTarget('jeans', '', none);
        expect(unsaid).toMatchObject({ variant: 'default', clothes: 'jeans', refusal: '' });
        expect(unsaid.notice).toBe('clothes= with no outfit= — kept as her [Clothes], the first clothes she has on file');
        for (const outfit of ['casual', '日曜日', 'same-as-last-picture', 'none']) {
            const r = registrationClothesTarget('jeans', outfit, none);
            expect(r).toMatchObject({ variant: 'default', clothes: 'jeans', refusal: '' });
            expect(r.notice).toMatch(new RegExp(`^outfit name "${outfit}" .* — kept as her \\[Clothes\\], the first clothes she has on file$`));
        }
    });

    // MUTATION TARGET: save it and a weekend sundress becomes an outfit of a heroine who has her uniforms on file.
    it('with clothes on file a one-off is never saved, and is no refusal', () => {
        expect(registrationClothesTarget('white sundress', 'newclothes', some))
            .toEqual({ variant: '', clothes: '', refusal: '', notice: '' });
    });

    it('with clothes on file, "default" names her [Clothes]; a missing or bare outfit= is refused', () => {
        expect(registrationClothesTarget('red coat', 'default', some)).toEqual({ variant: 'default', clothes: 'red coat', refusal: '', notice: '' });
        expect(registrationClothesTarget('jeans', '', some)).toMatchObject({ variant: '', clothes: '', notice: '' });
        expect(registrationClothesTarget('jeans', '', some).refusal).toMatch(/^clothes= with no outfit= — not saved/);
        expect(registrationClothesTarget('jeans', 'casual', some).refusal).toMatch(/^outfit name "casual" is not a <place or role>-<outfit> name .* — clothes not saved$/);
    });

    it('"undressed" beside clothes= saves nothing either way, and no clothes= is nothing to save', () => {
        for (const state of [none, some]) {
            const undressed = registrationClothesTarget('x', 'undressed', state);
            expect(undressed).toMatchObject({ variant: '', clothes: '', notice: '' });
            expect(undressed.refusal).toMatch(/undressed wears nothing/);
            expect(registrationClothesTarget('', 'newclothes', state)).toEqual({ variant: '', clothes: '', refusal: '', notice: '' });
        }
    });

    it('reads "no clothes on file" when the caller passes nothing', () => {
        expect(registrationClothesTarget('black tuxedo', 'newclothes').variant).toBe('default');
    });
});

describe('hasBodyOnly — her [Body] on file and no clothes: the next clothes a record gives her are her first', () => {
    // MUTATION TARGET: count a name-only placeholder and a record with no body= fills it with clothes alone, so she
    // is listed ON FILE and never described; count an entry with clothes and her one-offs are saved as outfits.
    it('a body with no clothes is; a body with clothes, a placeholder or nothing is not', () => {
        expect(hasBodyOnly('[Body]\nwoman, pink hair')).toBe(true);
        expect(hasBodyOnly('[Body]\nwoman\n[Clothes]\n  ')).toBe(true);
        expect(hasBodyOnly(MITSUKI)).toBe(false);
        expect(hasBodyOnly('[Body]\nwoman\n[Clothes:school-uniform]\nbrown blazer')).toBe(false);
        expect(hasBodyOnly('')).toBe(false);
        expect(hasBodyOnly(undefined)).toBe(false);
    });
});

// The harvest and the POST route's reply pass touch the lorebook, so no unit test can open them; the wiring that
// applies the first-clothes rule is checked here.
describe('SOURCE GATE — first clothes reach the registry on both routes (D29)', () => {
    // LF either way: a Windows checkout holds the sources with CRLF, and the expected lines below are written with \n.
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const harvest = read('../src/features/character-roster/harvest.js');

    it('MUTATION TARGET — every record kind keeps the first clothes of a character with only her [Body] on file', () => {
        expect(harvest).toContain("if (parsed.kind === 'oneoff' && !hasBodyOnly(pickCharEntry(known, parsed.name).entry?.content)) { oneOffs++; continue; }");
        expect(harvest).toContain('if (owner && hasBodyOnly(owner.content)) {\n                const first = await keepFirstClothes(owner, parsed, kept);');
        expect(harvest).toContain("const target = registrationClothesTarget(parsed.clothes, parsed.outfit, { hasClothesOnFile: false });\n    if (target.notice) log.child('harvest').warn(");
    });

    it('MUTATION TARGET — the clothes on a registration follow what her entry holds', () => {
        expect(harvest).toContain('const holdsClothes = !!existing && hasClothesOnFile(existing.content);');
        expect(harvest).toContain('const target = registrationClothesTarget(parsed.clothes, parsed.outfit, { hasClothesOnFile: holdsClothes });');
        expect(harvest).toContain('const updated = !holdsClothes\n                ? await keepFirstClothes(existing, parsed, kept)');
        expect(harvest).toContain('const content = registrationToEntryContent({ body: parsed.body, clothes: target.clothes, variant: target.variant });');
    });

    it('MUTATION TARGET — on the POST route the records in the reply itself are read for first clothes', () => {
        expect(harvest).toContain("if (!parsed.ok || parsed.kind === 'presence' || parsed.kind === 'char') continue;");
        expect(harvest).toContain('if (!owner || !hasBodyOnly(owner.content)) continue;');
        const imageGen = read('../src/features/imagegen/image-gen.js');
        expect(imageGen).toContain("if (meta.phase === 'post') {\n            try { await keepFirstClothesFromReply(picText); }");
    });
});

// The POST call's answer may be empty when nobody needed anything, so the empty answer warns only through the
// harvest's own check of who it was asked to register. The harvest and image-gen.js read the registry: source gate.
describe('SOURCE GATE — a newcomer the POST call was asked to register and left without a look is warned', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const harvest = read('../src/features/character-roster/harvest.js');
    const imageGen = read('../src/features/imagegen/image-gen.js');

    it('MUTATION TARGET — each asked newcomer no record registered is checked against the registry, a drawn one left to the drawn check', () => {
        expect(harvest).toContain('for (const name of namesWithoutRegistration(askedNewcomers, [...registeredNames, ...drawnNames])) {\n            if (await isOnFile(name)) continue;');
        expect(harvest).toContain('return !!entry && hasStoredAppearance(entry.content);');
        expect(harvest).toContain('the POST call was asked to register them, but no cast record registers them');
    });

    it('MUTATION TARGET — both ends of the harvest run the check, so an answer with no record reaches it', () => {
        expect(harvest).toContain('await reportUnregistered([]);\n        return { stored: [] };');
        expect(harvest).toContain('await reportUnregistered(registeredNames);\n    return { stored };');
    });

    it('MUTATION TARGET — only the POST route says who was asked, read from the reply cast its contract is built from', () => {
        expect(imageGen).toContain("askedNewcomers: meta.phase === 'post' ? (await replyCastOf(meta.messageId)).cast.newcomers : [],");
        expect(imageGen).toContain('const { names, cast } = await replyCastOf(messageId);');
    });
});

describe('hasClothesOnFile — does her entry hold any clothes', () => {
    it('[Clothes] or any [Clothes:<outfit>] with text counts; a body-only entry, an empty section or nothing does not', () => {
        expect(hasClothesOnFile(MITSUKI)).toBe(true);
        expect(hasClothesOnFile('[Body]\nwoman\n[Clothes:school-uniform]\nbrown blazer')).toBe(true);
        expect(hasClothesOnFile('[Body]\nwoman, pink hair')).toBe(false);
        expect(hasClothesOnFile('[Body]\nwoman\n[Clothes]\n   ')).toBe(false);
        expect(hasClothesOnFile('')).toBe(false);
    });
});

// The narrator is shown only an outfit's NAME (the ON FILE list), so a name a model saves must say which
// clothes it is: <place or role>-<outfit>. A bare word would dress every later swimsuit in this one.
describe('newOutfitNameProblem — a saved outfit name says which clothes it is', () => {
    it('MUTATION TARGET — <place or role>-<outfit> passes; a bare word is refused', () => {
        for (const name of ['school-uniform', 'cafe-waitress', 'post-office-uniform', 'team2-kit', 'School-Gym']) {
            expect(newOutfitNameProblem(name), name).toBe('');
        }
        for (const name of ['swimsuit', 'casual', 'uniform', 'school_uniform', '-uniform', 'school-', 'school--gym', '', null]) {
            expect(newOutfitNameProblem(name), String(name)).toMatch(/not a <place or role>-<outfit> name/);
        }
    });

    // "same-as-last-picture" has the shape of a saved name, so the shape alone would let a registration save under it.
    it('MUTATION TARGET — an outfit= word is refused whatever its shape', () => {
        for (const name of ['same-as-last-picture', 'Same-As-Last-Picture', 'newclothes', 'undressed', 'default', 'none']) {
            expect(newOutfitNameProblem(name), name).toMatch(/is an outfit= value, never the name of saved clothes/);
        }
    });
});

describe('pickCharEntry — which entry a name resolves to', () => {
    const entries = [
        { key: 'Mitsuki', content: '[Body]\nb\n[Alias]\n橘美月\nTachibana' },
        { key: 'Tachibana', content: '[Body]\nother' },
        { key: 'Mana', content: '[Body]\nm\n[Alias]\n美月' },
    ];

    it('an exact key wins over any alias', () => {
        const r = pickCharEntry(entries, 'tachibana');
        expect(r.entry.key).toBe('Tachibana');
        expect(r.viaAlias).toBe(false);
    });

    it('an alias resolves to its owner, case-insensitively', () => {
        const r = pickCharEntry(entries, '橘美月');
        expect(r.entry.key).toBe('Mitsuki');
        expect(r.viaAlias).toBe(true);
    });

    it('two entries claiming one alias are both reported; the first wins', () => {
        const shared = [{ key: 'A', content: '[Alias]\nX' }, { key: 'B', content: '[Alias]\nX' }];
        const r = pickCharEntry(shared, 'x');
        expect(r.entry.key).toBe('A');
        expect(r.claimants.map((e) => e.key)).toEqual(['A', 'B']);
    });

    it('no match and garbage return no entry', () => {
        expect(pickCharEntry(entries, 'Nobody').entry).toBe(null);
        expect(pickCharEntry(null, 'Mitsuki').entry).toBe(null);
        expect(pickCharEntry(entries, '').entry).toBe(null);
    });
});

describe('mayStoryReplaceClothes — a POST registration is a change report (D3)', () => {
    const entry = (flag) => ['[Body]', 'b', '[Clothes]', 'old']
        .concat(flag === undefined ? [] : ['[AllowUpdate]', flag]).join(String.fromCharCode(10));

    // MUTATION TARGET: drop the isChangeReport branch and the informed set blocks the POST route.
    it('[AllowUpdate] alone decides — being informed does not block a change report', () => {
        const r = mayStoryReplaceClothes('Nanami', entry('true'), ['Nanami'], { isChangeReport: true });
        expect(r.allowed).toBe(true);
        expect(r.reason).toMatch(/change/);
        expect(mayStoryReplaceClothes('Nanami', entry('true'), null, { isChangeReport: true }).allowed).toBe(true);
    });

    // outfit="newclothes" is the narrator saying the story CHANGED her clothes: whatever any writer records
    // for her that reply describes the one-off, and a one-off never replaces what is on file.
    it('MUTATION TARGET — a reply that drew her in a one-off never replaces her clothes, even as a change report', () => {
        expect(mayStoryReplaceClothes('Nanami', entry('true'), [], { isChangeReport: true }).allowed).toBe(true);
        const r = mayStoryReplaceClothes('Nanami', entry('true'), [], { isChangeReport: true, drawnAsOneOff: true });
        expect(r.allowed).toBe(false);
        expect(r.reason).toMatch(/one-off/);
        expect(mayStoryReplaceClothes('Nanami', entry('true'), [], { drawnAsOneOff: true }).allowed).toBe(false);
    });

    // [AllowUpdate] guards the REGISTRY and is off unless her entry says true (plans/reply-cast.md §1.9).
    it('the switch OFF or absent still blocks a change report', () => {
        expect(mayStoryReplaceClothes('Nanami', entry('false'), [], { isChangeReport: true }).allowed).toBe(false);
        expect(mayStoryReplaceClothes('Nanami', entry(), [], { isChangeReport: true }).allowed).toBe(false);
    });
});

describe('applyWornOutfitEdits — edits of the worn-outfit store from outside a reply\'s pictures (plans/reply-cast.md §11)', () => {
    const stamped = (outfit, clothes, stamp) => ({ outfit, clothes, [LAST_PICTURE_MESSAGE]: stamp });

    it('MUTATION TARGET — a set keeps her stamp, and an entry made where she had none takes the new one', () => {
        const worn = { Mitsuki: stamped('newclothes', 'grey hoodie', 41) };
        expect(applyWornOutfitEdits(worn, [wornOutfitSet('mitsuki', 'School-Uniform', 'ignored', 50)]))
            .toEqual({ Mitsuki: stamped('school-uniform', '', 41) });
        expect(applyWornOutfitEdits({}, [wornOutfitSet('Yuki', 'newclothes', 'red  coat,\n blue scarf', 50)]))
            .toEqual({ Yuki: stamped('newclothes', 'red coat, blue scarf', 50) });
        expect(applyWornOutfitEdits({ Yuki: { outfit: 'default', clothes: '' } }, [wornOutfitSet('Yuki', 'default', '', 50)]))
            .toEqual({ Yuki: stamped('default', '', 50) });
    });

    it('a set of one-off clothes with no clothes, or of no outfit, changes nothing', () => {
        const worn = { Mitsuki: stamped('default', '', 41) };
        expect(applyWornOutfitEdits(worn, [wornOutfitSet('Mitsuki', 'newclothes', '   ', 50)])).toEqual(worn);
        expect(applyWornOutfitEdits(worn, [wornOutfitSet('Mitsuki', '', 'red coat', 50)])).toEqual(worn);
    });

    it('MUTATION TARGET — a clear removes her entry, matched without regard to case', () => {
        const worn = { Mitsuki: stamped('default', '', 41), Yuki: stamped('school-gym', '', 40) };
        expect(applyWornOutfitEdits(worn, [wornOutfitCleared('MITSUKI')])).toEqual({ Yuki: stamped('school-gym', '', 40) });
        expect(applyWornOutfitEdits(worn, [wornOutfitCleared('Nobody')])).toEqual(worn);
    });

    it('MUTATION TARGET — a kept outfit replaces only the one-off holding exactly its clothes, under any of her names', () => {
        const worn = {
            薇拉: stamped('newclothes', 'pink gothic short dress, black lace trim', 2622),
            靈青: stamped('newclothes', 'blue robe', 2622),
        };
        const kept = wornOutfitKeptByName(['薇拉', 'Mayla'], 'default', 'pink gothic  short dress,\nblack lace trim');
        expect(applyWornOutfitEdits(worn, [kept])).toEqual({ 薇拉: stamped('default', '', 2622), 靈青: stamped('newclothes', 'blue robe', 2622) });
        // The picture drew her before she was registered, under a name her entry now carries as an alias.
        expect(applyWornOutfitEdits({ Mayla: stamped('newclothes', 'pink gothic short dress, black lace trim', 2622) }, [kept]))
            .toEqual({ Mayla: stamped('default', '', 2622) });
    });

    it('a kept outfit leaves a one-off in other words, an outfit held by name, and anyone it does not name', () => {
        const kept = wornOutfitKeptByName(['薇拉'], 'default', 'pink gothic short dress');
        const reworded = { 薇拉: stamped('newclothes', 'a pink gothic dress', 2622) };
        expect(applyWornOutfitEdits(reworded, [kept])).toEqual(reworded);
        const byName = { 薇拉: stamped('atlantis-gown', '', 2622) };
        expect(applyWornOutfitEdits(byName, [kept])).toEqual(byName);
        const other = { 靈青: stamped('newclothes', 'pink gothic short dress', 2622) };
        expect(applyWornOutfitEdits(other, [kept])).toEqual(other);
        expect(applyWornOutfitEdits(reworded, [wornOutfitKeptByName(['薇拉'], 'newclothes', 'a pink gothic dress')])).toEqual(reworded);
    });

    it('the store handed in is never touched; junk edits and a prototype key are skipped', () => {
        const worn = { Mitsuki: stamped('newclothes', 'grey hoodie', 41) };
        const before = structuredClone(worn);
        applyWornOutfitEdits(worn, [wornOutfitSet('Mitsuki', 'school-gym', '', 50), wornOutfitCleared('Mitsuki')]);
        expect(worn).toEqual(before);
        expect(applyWornOutfitEdits(worn, [null, 'x', { op: 'paint', key: 'Mitsuki' }, wornOutfitSet('__proto__', 'default', '', 1)])).toEqual(before);
        expect(applyWornOutfitEdits(undefined, [wornOutfitCleared('Mitsuki')])).toEqual({});
    });
});

describe('keptOutfitFinding — what the harvest\'s log says a kept outfit found (D37)', () => {
    const stamped = (outfit, clothes, stamp) => ({ outfit, clothes, [LAST_PICTURE_MESSAGE]: stamp });
    const kept = wornOutfitKeptByName(['薇拉', 'Mayla'], 'dark-blue-gown', 'tight dark blue  silk gown');

    it('MUTATION TARGET — the one-off holding exactly its clothes is held; a one-off in other words is not', () => {
        expect(keptOutfitFinding({ Mayla: stamped('newclothes', 'tight dark blue silk gown', 2624) }, kept)).toEqual({ finding: 'held', held: 'tight dark blue silk gown' });
        expect(keptOutfitFinding({ 薇拉: stamped('newclothes', 'dark blue silk high-neck gown', 2624) }, kept))
            .toEqual({ finding: 'other-clothes', held: 'dark blue silk high-neck gown' });
    });

    it('an outfit held by name, and nothing recorded, are named as such', () => {
        expect(keptOutfitFinding({ 薇拉: stamped('default', '', 2622) }, kept)).toEqual({ finding: 'outfit', held: 'default' });
        expect(keptOutfitFinding({ 靈青: stamped('newclothes', 'tight dark blue silk gown', 2624) }, kept)).toEqual({ finding: 'none', held: '' });
        expect(keptOutfitFinding(undefined, kept)).toEqual({ finding: 'none', held: '' });
    });

    it('it agrees with the edit itself: "held" exactly when applyWornOutfitEdits holds her by name', () => {
        const stores = [{ 薇拉: stamped('newclothes', 'tight dark blue silk gown', 2624) }, { 薇拉: stamped('newclothes', 'other', 2624) }, {}];
        for (const worn of stores) {
            const isHeld = applyWornOutfitEdits(worn, [kept])['薇拉']?.outfit === 'dark-blue-gown';
            expect(keptOutfitFinding(worn, kept).finding === 'held').toBe(isHeld);
        }
    });
});

describe('wornOutfitEditTargets — where a "Wearing now" edit is written (D38)', () => {
    it('MUTATION TARGET — every saved state from her last picture on, and every generation floor, ascending and once each', () => {
        expect(wornOutfitEditTargets({ stateIndices: [0, 5, 8, 9, 10, 11, 12], lastPictureMessage: 9, generationFloors: [12, 11] })).toEqual([9, 10, 11, 12]);
        expect(wornOutfitEditTargets({ stateIndices: [0, 5, 8, 9, 10, 11, 12], lastPictureMessage: 12, generationFloors: [12, 11] })).toEqual([11, 12]);
    });

    it('with nothing held for her, only the generation floors', () => {
        expect(wornOutfitEditTargets({ stateIndices: [0, 5, 11, 12], lastPictureMessage: null, generationFloors: [12, 11] })).toEqual([11, 12]);
        expect(wornOutfitEditTargets({})).toEqual([]);
    });
});

describe('shownForRegen — what a regen draws her in from the store saved with her picture\'s reply (D39)', () => {
    const saved = { Mitsuki: { outfit: 'school-gym', clothes: '', [LAST_PICTURE_MESSAGE]: 41 } };

    it('MUTATION TARGET — her entry, when it is stamped with the reply and this is her last picture in it', () => {
        expect(shownForRegen(saved, 'mitsuki', { replyIndex: 41, isLastPicture: true })).toEqual({ outfit: 'school-gym', clothes: '', lastPictureMessage: 41 });
    });

    it('MUTATION TARGET — nothing for an earlier picture of hers, an entry another reply stamped, or no entry', () => {
        expect(shownForRegen(saved, 'Mitsuki', { replyIndex: 41, isLastPicture: false })).toBeNull();
        expect(shownForRegen(saved, 'Mitsuki', { replyIndex: 42, isLastPicture: true })).toBeNull();
        expect(shownForRegen(saved, 'Yuki', { replyIndex: 41, isLastPicture: true })).toBeNull();
        expect(shownForRegen(undefined, 'Mitsuki', { replyIndex: 41, isLastPicture: true })).toBeNull();
    });
});

describe('selectClothesForOutfit and chooseLook with `shown` — a regen draws what the reply saved (D39)', () => {
    const named = () => parseDnaSections('[Body]\nb\n[Clothes]\nfairy outfit\n[Clothes:school-gym]\nwhite gym shirt');
    const shownOnFile = (outfit) => ({ outfit, clothes: '', lastPictureMessage: 2622 });
    const shownOneOff = (clothes) => ({ outfit: 'newclothes', clothes, lastPictureMessage: 2622 });

    it('MUTATION TARGET — a saved outfit on file outranks what the slot names, drawn in its text now', () => {
        expect(selectClothesForOutfit(named(), 'newclothes', { replyClothes: 'pink gothic short dress', shown: shownOnFile('default') }))
            .toEqual({ clothes: 'fairy outfit', clothesSource: 'saved', wornEntry: { outfit: 'default', lastPictureMessage: 2622 }, warning: '' });
    });

    it('a saved one-off draws its text', () => {
        expect(selectClothesForOutfit(named(), 'school-gym', { shown: shownOneOff('red coat, blue scarf') }))
            .toEqual({ clothes: 'red coat, blue scarf', clothesSource: 'saved', wornEntry: { outfit: '', lastPictureMessage: 2622 }, warning: '' });
    });

    it('MUTATION TARGET — an "undressed" shot still draws no clothes', () => {
        expect(selectClothesForOutfit(named(), 'undressed', { shown: shownOnFile('default') })).toMatchObject({ clothes: '', clothesSource: '' });
    });

    it('an outfit she no longer has falls back to the rule a first draw follows', () => {
        expect(selectClothesForOutfit(named(), 'school-gym', { shown: shownOnFile('beach-swimsuit') })).toMatchObject({ clothes: 'white gym shirt', clothesSource: 'stored' });
        expect(selectClothesForOutfit(named(), 'newclothes', { replyClothes: 'pink dress', shown: shownOneOff('') })).toMatchObject({ clothes: 'pink dress', clothesSource: 'reply' });
    });

    it('a look from the reply wears its saved one-off; a saved outfit name draws nothing for her', () => {
        const record = { name: 'Ghost', attributes: { body: 'elf woman', clothes: 'plate armor' } };
        expect(chooseLook({ name: 'Ghost', record, outfit: 'newclothes', shown: shownOneOff('blue robe') }))
            .toMatchObject({ source: 'reply', clothes: 'blue robe', clothesSource: 'saved', wornEntry: { outfit: '', lastPictureMessage: 2622 } });
        expect(chooseLook({ name: 'Ghost', record, outfit: 'newclothes', shown: shownOnFile('default') })).toMatchObject({ clothes: 'plate armor', clothesSource: 'reply' });
        expect(chooseLook({ name: 'Ghost', record, outfit: 'undressed', shown: shownOneOff('blue robe') })).toMatchObject({ clothes: '', clothesSource: '' });
    });

    it('a stored look hands `shown` on: a saved outfit reaches her picture', () => {
        const entry = { key: '薇拉', content: '[Body]\nsuccubus girl\n[Clothes]\nfairy outfit' };
        const record = { name: '薇拉', attributes: { outfit: 'newclothes', clothes: 'pink gothic short dress' } };
        expect(chooseLook({ name: '薇拉', entry, record, outfit: 'newclothes', shown: shownOnFile('default') }))
            .toMatchObject({ source: 'stored', clothes: 'fairy outfit', clothesSource: 'saved' });
        expect(chooseLook({ name: '薇拉', entry, record, outfit: 'newclothes' })).toMatchObject({ clothes: 'pink gothic short dress', clothesSource: 'reply' });
    });
});

describe('wearingNowFromEditorFields and isSameWear — the editor\'s "Wearing now" line (D38)', () => {
    const held = (outfit, clothes = '') => ({ outfit, clothes, lastPictureMessage: 3 });

    it('MUTATION TARGET — a line that says what she holds is unchanged and never checked, a lost outfit included', () => {
        expect(wearingNowFromEditorFields({ wearing: 'beach-swimsuit' }, ['default'], held('beach-swimsuit'))).toEqual({ value: { outfit: 'beach-swimsuit', clothes: '' }, problems: [], isChanged: false });
        expect(wearingNowFromEditorFields({ wearing: 'newclothes', oneOffClothes: 'red coat,\n blue scarf' }, [], held('newclothes', 'red coat, blue scarf')).isChanged).toBe(false);
        expect(wearingNowFromEditorFields({ wearing: '' }, [], null).isChanged).toBe(false);
    });

    it('nothing recorded clears; an outfit on file sets it; one-off clothes come as one line', () => {
        expect(wearingNowFromEditorFields({ wearing: '' }, ['default'], held('default'))).toEqual({ value: null, problems: [], isChanged: true });
        expect(wearingNowFromEditorFields({ wearing: 'Default' }, ['default'], null)).toEqual({ value: { outfit: 'default', clothes: '' }, problems: [], isChanged: true });
        expect(wearingNowFromEditorFields({ wearing: 'newclothes', oneOffClothes: 'red coat,\n blue scarf' }, [], held('default')).value).toEqual({ outfit: 'newclothes', clothes: 'red coat, blue scarf' });
    });

    it('MUTATION TARGET — blank one-off clothes and an outfit the record does not have are refused', () => {
        const blank = wearingNowFromEditorFields({ wearing: 'newclothes', oneOffClothes: '   ' }, ['default'], held('default'));
        expect(blank.value).toBeNull();
        expect(blank.problems).toHaveLength(1);
        const lost = wearingNowFromEditorFields({ wearing: 'school-gym' }, ['default'], held('default'));
        expect(lost.value).toBeNull();
        expect(lost.problems[0]).toMatch(/"school-gym" is not one of this character's outfits/);
    });

    it('isSameWear compares the outfit, and a one-off\'s clothes without regard to spacing', () => {
        expect(isSameWear(null, null)).toBe(true);
        expect(isSameWear(null, held('default'))).toBe(false);
        expect(isSameWear({ outfit: 'Default', clothes: '' }, held('default'))).toBe(true);
        expect(isSameWear({ outfit: 'newclothes', clothes: 'red  coat' }, held('newclothes', 'red coat'))).toBe(true);
        expect(isSameWear({ outfit: 'newclothes', clothes: 'red cape' }, held('newclothes', 'red coat'))).toBe(false);
    });
});

describe('wearingNowChoices and wearingNowSelection — what "Wearing now" offers while the editor changes its outfits', () => {
    const held = (outfit, clothes = '') => ({ outfit, clothes, lastPictureMessage: 3 });

    it('MUTATION TARGET — the outfits the pairs hold now, each once, as Save writes them; an empty name is no outfit', () => {
        expect(wearingNowChoices(['school-uniform', ' Beach-Swimsuit ', '', 'school-uniform'], null)).toEqual(['school-uniform', 'beach-swimsuit']);
    });

    it('MUTATION TARGET — the held outfit is offered when she no longer has it, never twice, and one-off clothes is not an outfit', () => {
        expect(wearingNowChoices(['default'], held('school-gym'))).toEqual(['default', 'school-gym']);
        expect(wearingNowChoices(['school-gym'], held('school-gym'))).toEqual(['school-gym']);
        expect(wearingNowChoices(['default'], held('newclothes', 'red coat'))).toEqual(['default']);
    });

    it('MUTATION TARGET — a pick still offered stays; one that left the list gives way to what she holds, else nothing', () => {
        expect(wearingNowSelection('beach-swimsuit', ['default', 'beach-swimsuit'], held('default'))).toBe('beach-swimsuit');
        expect(wearingNowSelection('beach-swimsuit', ['default'], held('default'))).toBe('default');
        expect(wearingNowSelection('beach-swimsuit', ['default'], null)).toBe('');
        expect(wearingNowSelection('newclothes', ['default'], held('default'))).toBe('newclothes');
        expect(wearingNowSelection('', ['default'], held('default'))).toBe('');
    });
});

describe('SOURCE GATE — the worn-outfit store\'s edits are wired (plans/reply-cast.md §11)', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r/g, '');

    it('MUTATION TARGET — every clothes the harvest saves from records joins the kept list, which both passes hand on (D37)', () => {
        const harvest = read('../src/features/character-roster/harvest.js');
        expect(harvest.match(/await nameKeptOutfitsInWornStore\(kept\);/g)).toHaveLength(2);
        expect(harvest).toContain("if (await upsertOutfitVariant(entry.key, target.variant, target.clothes) !== 'stored') return '';\n    kept.push(keptOutfit(entry, parsed.name, target.variant, target.clothes));");
        expect(harvest).toContain("if (await upsertOutfitVariant(entry.key, variant, clothesText) !== 'stored') return '';\n        kept.push(keptOutfit(entry, writtenName, variant, clothesText));");
        expect(harvest).toContain('if (owner) kept.push(keptOutfit(owner, parsed.name, parsed.outfit, parsed.clothes));');
        expect(harvest).toContain("kept.push(keptOutfit(entry, entry.key, variant || 'default', clothesText));");
        expect(harvest).toContain('if (target.variant) kept.push(keptOutfit({ key, content }, parsed.name, target.variant, target.clothes));');
    });

    it('MUTATION TARGET — every record the harvest saves takes the clothes its picture drew, read as the store reads them (D40)', () => {
        const harvest = read('../src/features/character-roster/harvest.js');
        expect(harvest).toContain('registrations.push({ parsed: asDrawn(parsed), raw: record.raw });');
        expect(harvest).toContain('const drawn = drawnClothesFor(drawnOneOffs, pickCharEntry(known, parsed.name).entry, parsed.name);');
        const imageGen = read('../src/features/imagegen/image-gen.js');
        expect(imageGen).toContain('drawnOneOffs: drawnOneOffClothesOf(await wornReportsThrough(meta.messageId, allTagStrings(replyTextWithPicTags(meta.messageId)))),');
        expect(imageGen).toContain('return nextWornOutfit(previous, { reports: await wornReportsThrough(mesId, tags), replyIndex: mesId });');
        expect(imageGen.match(/wornReportsOf\(/g)).toHaveLength(1);
    });

    it('MUTATION TARGET — the kept outfits\' log line says what each found in the reply\'s saved store (D37)', () => {
        const edits = read('../src/features/character-roster/worn-outfit-edits.js');
        expect(edits).toContain('describeKeptFinding(item, keptOutfitFinding(ownStatPart(saved, WORN_OUTFIT_PART), edits[index]))');
    });

    it('MUTATION TARGET — the edits run right after the store\'s own write, before the streetcleaner (§11.2)', () => {
        const index = read('../src/index.js');
        expect(index).toMatch(/registerOwnStateTask\(wornOutfitWriteTask\);\nregisterOwnStateTask\(wornOutfitEditJournalTask\);\nregisterOwnStateTask\(streetcleanerTask\);/);
        expect(index).toContain('resetCharacterRegistryForChat(); resetWornOutfitEditsForChat();');
    });

    it('MUTATION TARGET — only the regen hands the reply\'s saved entries, and both draws log through one function (D39)', () => {
        const imageGen = read('../src/features/imagegen/image-gen.js');
        expect(imageGen).toContain('const rebuilt = await assembleForReply(mesId, rawTag, composition, { shownFor: await shownInReplyFor(mesId, rawTag) });');
        expect(imageGen).toContain("logDrawnPicture('regen', { resolution: dims, drawn: rebuilt.drawn, camera: rebuilt.camera, mainchar: rebuilt.mainchar, bust, composition, sentPrompt: prompt });");
        expect(imageGen).toContain('const { prompt: fullPrompt, drawn, camera, mainchar } = await assembleForReply(job.mesId, job.rawTag, job.prompt);');
        expect(imageGen).toContain("logDrawnPicture('gen', { resolution, drawn, camera, mainchar, bust, composition: job.prompt, sentPrompt: fullPrompt });");
        expect(imageGen.match(/shownInReplyFor\(/g)).toHaveLength(2);
        expect(imageGen.match(/logDrawnPicture\(/g)).toHaveLength(3);
    });
});
