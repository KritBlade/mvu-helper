/**
 * MVU Helper — the reply cast (character-roster/reply-cast-core.js, plans/reply-cast.md).
 *
 * Who is in a reply, and what the roster knows about each of them. The POST registration text is
 * built from classifyReplyCast, so these decide what the registration call is asked for.
 *
 * Run:  npm test
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { replyCastNames, classifyReplyCast, replyCastInstruction, onFileListText, onFileCast, namedKeysOf, activatedKeysOf, lorebookKeysOf, uncastNamesOf, isUncastName, lastPictureWearOf, userLastPictureWear, userOutfitsOnFile } from '../src/features/character-roster/reply-cast-core.js';
import { CAST_RECORD_PATTERN, NAME_RULES } from '../src/features/character-roster/cast-record-format-core.js';

const MITSUKI = { key: 'Mitsuki', content: '[Body]\nb\n[Clothes]\nuniform\n[Clothes:gym]\ngym shirt\n[Alias]\n橘美月' };
const NANAMI = { key: 'Nanami', content: '[Body]\nb\n[Clothes]\nblazer\n[AllowUpdate]\ntrue' };
const PLACEHOLDER = { key: '勇希', content: '' };

describe('replyCastNames — who is in the reply', () => {
    it('declared names first, then every drawn name the records left out (§2.2)', () => {
        const records = [{ name: '美月' }, { name: 'Nanami' }];
        expect(replyCastNames(records, ['Nanami', '勇希'])).toEqual(['美月', 'Nanami', '勇希']);
    });

    it('each name once, case-insensitively, as first written', () => {
        expect(replyCastNames([{ name: 'Mana' }, { name: 'mana' }], ['MANA'])).toEqual(['Mana']);
    });

    it('never throws on garbage', () => {
        expect(replyCastNames(null, undefined)).toEqual([]);
        expect(replyCastNames([null, { name: '  ' }], ['', null])).toEqual([]);
    });
});

describe('classifyReplyCast — the cast against the roster', () => {
    it('a registered character is one member however many of her spellings the reply used', () => {
        const { registered, newcomers } = classifyReplyCast(['Mitsuki', '橘美月'], [MITSUKI, NANAMI]);
        expect(newcomers).toEqual([]);
        expect(registered).toHaveLength(1);
        expect(registered[0]).toMatchObject({ key: 'Mitsuki', names: ['Mitsuki', '橘美月'], outfits: ['default', 'gym'], allowUpdate: false });
    });

    // Her clothes are sent only when the story may correct them — the one case the call must compare.
    // MUTATION TARGET: send clothes for everyone and a 40-character roster costs ~108 tokens each.
    it('clothes on file ride along ONLY under [AllowUpdate]', () => {
        const { registered } = classifyReplyCast(['Mitsuki', 'Nanami'], [MITSUKI, NANAMI]);
        expect(registered.find((m) => m.key === 'Mitsuki').clothes).toEqual({});
        expect(registered.find((m) => m.key === 'Nanami')).toMatchObject({ allowUpdate: true, clothes: { default: 'blazer' } });
    });

    it('no entry, or a name-only placeholder, is a NEWCOMER — nothing on file to draw her from', () => {
        const { registered, newcomers } = classifyReplyCast(['勇希', 'Stranger', 'stranger'], [MITSUKI, PLACEHOLDER]);
        expect(registered).toEqual([]);
        expect(newcomers).toEqual(['勇希', 'Stranger']);
    });

    it('a reserved outfit word is nobody', () => {
        expect(classifyReplyCast(['none', 'default', 'undressed', 'newclothes'], [MITSUKI])).toEqual({ registered: [], newcomers: [], uncast: [] });
    });

    it('an empty cast classifies to nothing', () => {
        expect(classifyReplyCast([], [MITSUKI])).toEqual({ registered: [], newcomers: [], uncast: [] });
        expect(classifyReplyCast(null, null)).toEqual({ registered: [], newcomers: [], uncast: [] });
    });

    // A record under a name the user's own character goes by asks the registration call to describe them, and
    // they are stored as a second character. MUTATION TARGET: drop the uncast check and 勇希 is a newcomer again.
    it('a name the user\'s own character goes by is never a member or a newcomer — as written, each once', () => {
        const userNames = ['Critblade', 'Mainchar', '勇希'];
        const { registered, newcomers, uncast } = classifyReplyCast(['勇希', 'critblade', 'CRITBLADE', 'Stranger'], [MITSUKI, PLACEHOLDER], userNames);
        expect(uncast).toEqual(['勇希', 'critblade']);
        expect(newcomers).toEqual(['Stranger']);
        expect(registered).toEqual([]);
        expect(classifyReplyCast(['橘美月'], [MITSUKI], userNames).registered.map((m) => m.key)).toEqual(['Mitsuki']);
    });

    it('no user names ⇒ the cast classifies as before', () => {
        expect(classifyReplyCast(['勇希'], [PLACEHOLDER]).newcomers).toEqual(['勇希']);
        expect(classifyReplyCast(['勇希'], [PLACEHOLDER], null).newcomers).toEqual(['勇希']);
    });
});

describe('replyCastInstruction — what the narrator is asked', () => {
    const INSTRUCTION = replyCastInstruction([{ key: 'Mitsuki', variants: ['default', 'gym'] }]);

    it('asks for every named character present, every reply — never for a judgement of who is new', () => {
        expect(INSTRUCTION).toMatch(/EVERY named character present/);
        expect(INSTRUCTION).toMatch(/Every reply, even when nobody is new/);
        expect(INSTRUCTION).not.toMatch(/already registered/i);
    });

    it('shows a record the published pattern matches, built by the format file', () => {
        CAST_RECORD_PATTERN.lastIndex = 0;
        expect(CAST_RECORD_PATTERN.test(INSTRUCTION)).toBe(true);
    });

    it('never shows a paired <cast>…</cast>', () => {
        expect(INSTRUCTION).not.toMatch(/<\/cast/);
    });

    // The same ON FILE text reaches a POST call that writes the pictures (onFileListText), so the two never drift.
    it('MUTATION TARGET — its ON FILE part is onFileListText\'s, word for word', () => {
        const onFile = [{ key: 'Mitsuki', variants: ['default', 'gym'], lastPictureWear: 'gym' }];
        const list = onFileListText(onFile, 'town-casual', ['town-casual']);
        expect(list).toMatch(/^ON FILE — characters whose look is stored\./);
        expect(replyCastInstruction(onFile, [], [], 'town-casual', ['town-casual'])).toContain(`\n${list}\n`);
        expect(onFileListText([], '', [])).toMatch(/^ON FILE — nobody the story has named has a stored look\./);
    });

    // MUTATION TARGET: claim "the very END of your reply, after every other block" again and a block another
    // instruction puts last (a player-choice block) is dropped — the narrator obeys the later-placed claim.
    it('never claims the last slot of the reply, and yields it to a block that does', () => {
        expect(INSTRUCTION).not.toMatch(/after every other block/i);
        expect(INSTRUCTION).toMatch(/never take another block's place/);
        expect(INSTRUCTION).toMatch(/just before that block/);
    });

    // Describe once: the list is mvu-helper's statement of what is stored, so the narrator reads it and
    // never judges. MUTATION TARGET: drop the list and every character is described every reply.
    it('lists who is ON FILE with their outfits, and says they are never described again', () => {
        expect(INSTRUCTION).toContain('- Mitsuki: default, gym');
        expect(INSTRUCTION).toMatch(/ON FILE[^\n]*Never write body= for them/);
    });

    it('an empty list says so, rather than dropping the ON FILE line other blocks refer to', () => {
        const empty = replyCastInstruction([]);
        expect(empty).toMatch(/ON FILE — nobody/);
        expect(replyCastInstruction()).toMatch(/ON FILE — nobody/);
    });

    // The list is scoped by mention, so a character the story brings back after a gap is off it while the narrator
    // remembers her. MUTATION TARGET: drop the line and the narrator copies an outfit= from earlier replies — a value
    // she does not have draws her with no clothes.
    it('says anyone off the list has no outfit on file, however often the story met them, with or without a list', () => {
        const rule = 'Anyone this reply names who is not on this list has no outfit on file, however often the story has met them before — this list is all that is on file: a picture of them is "newclothes" or "undressed".';
        expect(INSTRUCTION).toContain('- Mitsuki: default, gym\n' + rule);
        expect(replyCastInstruction([])).toContain('has a stored look. ' + rule);
    });

    // THE ASKS A READER HANDS IN (requestReplyCast recordAsks), printed beside the records they go on so a record
    // is described in one place. MUTATION TARGET: drop the asks and the one-off record is asked for nowhere here.
    it('prints every ask inside the block, ahead of the format rules', () => {
        const text = replyCastInstruction([{ key: 'Mitsuki', variants: ['default'] }], ['first ask', 'second ask']);
        expect(text).toMatch(/ALSO ASKED FOR on a record, when it applies:\r?\n- first ask\r?\n- second ask/);
        expect(text.indexOf('- second ask')).toBeLessThan(text.indexOf('Record format:'));
        expect(text.indexOf('- first ask')).toBeGreaterThan(text.indexOf('- Mitsuki: default'));
    });

    // The narrator reads the names instead of judging which one means the user. MUTATION TARGET: drop the names
    // and a narrator that does not connect a protagonist's story name with the user writes a record for them.
    it('names the user\'s own character, and says a record under those names is ignored', () => {
        const text = replyCastInstruction([], [], ['Critblade', '勇希']);
        expect(text).toContain('- Never the user\'s own character, who goes by: Critblade, 勇希. A record under any of these names is ignored.');
        expect(text).toContain(NAME_RULES);
    });

    // <reply_cast> is the one home of how a name is written: the <pic> contract and <scene_roster> point here, and the
    // block also stands alone while only looks are stored. MUTATION TARGET: drop NAME_RULES from the block and no
    // prompt says a name stays in the story's own script, or that a role is not a name.
    it('MUTATION TARGET — carries Names: the story\'s own script, never a role, for name= and char= alike', () => {
        const text = replyCastInstruction([], [], []);
        expect(text).toContain(NAME_RULES);
        expect(NAME_RULES).toContain('name= on a record, and char=, char2= … on a <pic>, name the same people');
        expect(NAME_RULES).toContain('in the story\'s own script: NEVER translated, romanized, transliterated, shortened, re-spelled, or with a title welded on.');
        expect(NAME_RULES).toContain('A Chinese/Japanese/Korean/Cyrillic name STAYS in that script.');
        expect(NAME_RULES).toContain('a NAME, never a role or description');
        expect(text).not.toMatch(/name= is copied|Named means named/);
    });

    it('no user names ⇒ the rule still stands, with no empty list', () => {
        for (const names of [undefined, [], ['  ', null]]) {
            const text = replyCastInstruction([], [], names);
            expect(text).toContain('- Never the user\'s own character.');
            expect(text).not.toContain('goes by');
        }
    });

    it('no asks ⇒ no ask heading, and blank asks are dropped', () => {
        expect(INSTRUCTION).not.toMatch(/ALSO ASKED FOR/);
        expect(replyCastInstruction([], [])).not.toMatch(/ALSO ASKED FOR/);
        expect(replyCastInstruction([], ['  ', '', null])).not.toMatch(/ALSO ASKED FOR/);
        expect(replyCastInstruction([], ['  kept  ', ''])).toMatch(/- kept\r?\n/);
    });
});

describe('onFileCast — who the narrator is told has a stored look', () => {
    const YUZUKI = { key: '柚月', names: ['柚月'], variants: ['gym', 'swim'] };
    const VIOLA = { key: '薇歐拉·杜茲', names: ['薇歐拉·杜茲', '薇歐拉'], variants: ['casual'] };
    const PLAIN = { key: 'Mana', names: ['Mana'], variants: [] };
    const keys = (list) => list.map((e) => e.key);
    // The texts stand for the recent chat, so whoever they name is both named in the chat and recent — the host's
    // two scans, collapsed. The cases where the two differ are written against onFileCast directly, below.
    const cast = ({ entries, recentTexts = [], ...rest } = {}) => {
        const named = (Array.isArray(recentTexts) ? recentTexts : []).flatMap((t) => namedKeysOf(entries, t));
        return onFileCast({ entries, namedKeys: named, recentKeys: named, ...rest });
    };

    it('lists only characters the story has named, each with their outfits', () => {
        expect(cast({ entries: [YUZUKI, VIOLA], recentTexts: ['柚月 stood by the window.'] }))
            .toEqual([{ key: '柚月', variants: ['gym', 'swim'], lastPictureWear: '' }]);
    });

    // A name in Latin letters counts only as a whole word. MUTATION TARGET: match a substring and "Mana" is read
    // inside "manager", "Sui" inside "suit", and both are listed though nobody named them.
    it('MUTATION TARGET — a Latin-script name inside another word is no mention', () => {
        const mana = { key: 'Mana', names: ['Mana'], variants: ['school-uniform'] };
        const sui = { key: 'Sui', names: ['Sui'], variants: ['school-uniform'] };
        expect(cast({ entries: [mana, sui], recentTexts: ['her self-appointed life manager', 'a dark grey business suit'] })).toEqual([]);
        expect(keys(cast({ entries: [mana, sui], recentTexts: ['Mana laughed; Sui did not.'] }))).toEqual(['Mana', 'Sui']);
    });

    it('finds a Latin-script name written between characters of another script', () => {
        const yuzuki = { key: 'Yuzuki', names: ['Yuzuki'], variants: ['gym'] };
        expect(keys(cast({ entries: [yuzuki], recentTexts: ['她和Yuzuki一起走進教室。'] }))).toEqual(['Yuzuki']);
    });

    const oneOff = (key, clothes) => ({ key, outfit: 'newclothes', clothes });
    const wore = (key, outfit) => ({ key, outfit, clothes: '' });

    // What her last picture showed is offered back, so she is described once and her clothes are read, not
    // remembered. MUTATION TARGET: drop the clothes and "same-as-last-picture" is never offered; give them to everyone
    // and it is offered for clothes the store does not hold.
    it('carries the one-off the store holds for a listed character, by key without regard to case', () => {
        const listed = cast({ entries: [YUZUKI, VIOLA], recentTexts: ['柚月 and 薇歐拉'], lastPictures: [oneOff('柚月', 'white sundress')] });
        expect(listed.map((e) => [e.key, e.lastPictureWear])).toEqual([['柚月', 'white sundress'], ['薇歐拉·杜茲', '']]);
        const ann = { key: 'Ann', names: ['Ann'], variants: ['pajama'] };
        expect(cast({ entries: [ann], recentTexts: ['Ann'], lastPictures: [oneOff('ANN', 'red coat')] })[0].lastPictureWear).toBe('red coat');
    });

    // D30: an outfit on file she wore is offered back too, by its name, as she has it written. MUTATION TARGET: offer
    // only one-offs again and a girl in a named outfit is re-picked from a bare list after a picture without her.
    it('MUTATION TARGET — carries the outfit on file her last picture showed, by name, and never one she no longer has', () => {
        const ann = { key: 'Ann', names: ['Ann'], variants: ['School-Uniform', 'town-casual'] };
        expect(cast({ entries: [ann], recentTexts: ['Ann'], lastPictures: [wore('ann', 'town-casual')] })[0].lastPictureWear).toBe('town-casual');
        expect(cast({ entries: [ann], recentTexts: ['Ann'], lastPictures: [wore('Ann', 'school-uniform')] })[0].lastPictureWear).toBe('School-Uniform');
        expect(cast({ entries: [ann], recentTexts: ['Ann'], lastPictures: [wore('Ann', 'beach-swimsuit')] })[0].lastPictureWear).toBe('');
    });

    it('lastPictureWearOf — the one-off\'s clothes, the outfit\'s name, else nothing', () => {
        expect(lastPictureWearOf(oneOff('A', 'grey hoodie'), ['gym'])).toBe('grey hoodie');
        expect(lastPictureWearOf(wore('A', 'gym'), ['gym'])).toBe('gym');
        expect(lastPictureWearOf(wore('A', 'gym'), [])).toBe('');
        expect(lastPictureWearOf(null, ['gym'])).toBe('');
        expect(lastPictureWearOf({ key: 'A', outfit: 'newclothes', clothes: '' }, ['newclothes'])).toBe('');
    });

    // They are printed on one line of their own, so a line break in the stored text would break the ON FILE list.
    it('MUTATION TARGET — the one-off\'s clothes are one line, and a one-off with no clothes is none', () => {
        const ann = { key: 'Ann', names: ['Ann'], variants: ['pajama'] };
        expect(cast({ entries: [ann], recentTexts: ['Ann'], lastPictures: [oneOff('Ann', '  red coat,\n black  boots ')] })[0].lastPictureWear)
            .toBe('red coat, black boots');
        expect(cast({ entries: [ann], recentTexts: ['Ann'], lastPictures: [oneOff('Ann', '  ')] })[0].lastPictureWear).toBe('');
    });

    // The store never lists anyone by itself: the list is still who is named or present.
    it('a store entry lists nobody who is not named or present', () => {
        expect(cast({ entries: [YUZUKI], recentTexts: ['nobody here'], lastPictures: [oneOff('柚月', 'white sundress'), wore('柚月', 'gym')] })).toEqual([]);
    });

    // "same-as-last-picture" is per character, so it never joins a group line: it goes on lines of its own after the
    // groups, each naming what it draws, so the narrator compares the story with it instead of recalling her last
    // picture.
    const SAME_AS_HEADING = '"same-as-last-picture" is also a choice for these, and draws what they wore in their last picture — the outfit or clothes after their name:';
    it('MUTATION TARGET — "same-as-last-picture" is offered after the groups, each with what it draws', () => {
        expect(replyCastInstruction([{ key: 'Mitsuki', variants: ['school-uniform', 'school-gym'], lastPictureWear: 'white sundress, straw hat' }]))
            .toContain('- Mitsuki: school-uniform, school-gym\n' + SAME_AS_HEADING + '\n- Mitsuki: white sundress, straw hat\n');
        expect(replyCastInstruction([{ key: '健太', variants: [], lastPictureWear: 'navy swim trunks' }]))
            .toContain('- 健太: no outfit on file — "newclothes" or "undressed"\n' + SAME_AS_HEADING + '\n- 健太: navy swim trunks');
        const dressed = replyCastInstruction([{ key: 'Mitsuki', variants: ['school-uniform'], lastPictureWear: '' }]);
        expect(dressed).toContain('- Mitsuki: school-uniform\n');
        expect(dressed).not.toContain('same-as-last-picture" is also a choice');
        expect(replyCastInstruction([{ key: 'Mitsuki', variants: ['school-uniform', 'town-casual'], lastPictureWear: 'town-casual' }]))
            .toContain('- Mitsuki: school-uniform, town-casual\n' + SAME_AS_HEADING + '\n- Mitsuki: town-casual\n');
    });

    // D30, the main character: he takes no record, yet mainchar= names what he wears in every picture of him, so his
    // offer is a line of its own, last. MUTATION TARGET: leave him out and the narrator re-picks his outfit from a bare
    // list after a picture without him (staging msg 258: town-casual → school-uniform).
    it('MUTATION TARGET — the user\'s own character is offered "same-as-last-picture" for mainchar=, last', () => {
        const withGirl = replyCastInstruction([{ key: 'Mitsuki', variants: ['school-uniform'], lastPictureWear: 'white sundress' }], [], ['Critblade'], 'town-casual');
        expect(withGirl).toContain(SAME_AS_HEADING + '\n- Mitsuki: white sundress\n- {{user}} (mainchar=): town-casual\n');
        const alone = replyCastInstruction([], [], ['Critblade'], 'town-casual');
        expect(alone).toContain('ON FILE — nobody the story has named has a stored look.');
        expect(alone).toContain(SAME_AS_HEADING + '\n- {{user}} (mainchar=): town-casual\n');
        expect(replyCastInstruction([], [], ['Critblade'], '')).not.toContain('same-as-last-picture" is also a choice');
    });

    it('MUTATION TARGET — userLastPictureWear reads the uncast entry the store holds, whatever the story names', () => {
        const mainchar = { key: 'Mainchar', names: ['Mainchar'], variants: ['school-uniform', 'town-casual'] };
        const girl = { key: 'Mitsuki', names: ['Mitsuki'], variants: ['town-casual'] };
        const entries = [girl, mainchar];
        expect(userLastPictureWear({ entries, uncastKeys: ['mainchar'], lastPictures: [wore('Mitsuki', 'town-casual'), wore('MAINCHAR', 'town-casual')] })).toBe('town-casual');
        expect(userLastPictureWear({ entries, uncastKeys: ['Mainchar'], lastPictures: [wore('Mitsuki', 'town-casual')] })).toBe('');
        expect(userLastPictureWear({ entries, uncastKeys: [], lastPictures: [wore('Mainchar', 'town-casual')] })).toBe('');
        expect(userLastPictureWear({ entries: [girl], uncastKeys: ['Mainchar'], lastPictures: [wore('Mainchar', 'town-casual')] })).toBe('');
        expect(userLastPictureWear({ entries, uncastKeys: ['Mainchar'], lastPictures: [wore('Mainchar', 'pajama')] })).toBe('');
        expect(userLastPictureWear()).toBe('');
    });

    // D32: his worn outfit printed alone, right above "this list is all that is on file", read as all he has — the
    // narrator drew him town-casual at school ("His on-file list only lists town-casual for him"). So every outfit on
    // his entry is ON FILE on a line of his own. MUTATION TARGET: drop the line and that reply is back; group him and
    // a heroine with his set takes mainchar= as hers.
    const MAINCHAR = { key: 'Mainchar', names: ['Mainchar', '勇希'], variants: ['school-uniform', 'school-gym', 'school-swimsuit', 'town-casual'], hasLook: true };
    const USER_ON_FILE = '- {{user}} (mainchar=): school-uniform, school-gym, school-swimsuit, town-casual';
    const USER_NOTE = 'The {{user}} (mainchar=) line is the user\'s own character: its choices go in mainchar=, and he never takes a record.';
    const NOT_LISTED = 'Anyone this reply names who is not on this list has no outfit on file, however often the story has met them before — this list is all that is on file: a picture of them is "newclothes" or "undressed".';

    it('MUTATION TARGET — userOutfitsOnFile reads every outfit on the uncast entry, and nobody else\'s', () => {
        const girl = { key: 'Mitsuki', names: ['Mitsuki'], variants: ['school-uniform'] };
        expect(userOutfitsOnFile({ entries: [girl, MAINCHAR], uncastKeys: ['mainchar'] })).toEqual(MAINCHAR.variants);
        expect(userOutfitsOnFile({ entries: [girl, MAINCHAR], uncastKeys: [] })).toEqual([]);
        expect(userOutfitsOnFile({ entries: [girl], uncastKeys: ['Mainchar'] })).toEqual([]);
        expect(userOutfitsOnFile({ entries: [girl, { ...MAINCHAR, variants: [] }], uncastKeys: ['Mainchar'] })).toEqual([]);
        expect(userOutfitsOnFile({ entries: [girl, MAINCHAR], uncastKeys: ['Hero', 'Mainchar'] })).toEqual(MAINCHAR.variants);
        expect(userOutfitsOnFile()).toEqual([]);
    });

    it('MUTATION TARGET — the user\'s own character has every outfit on file on a line of his own, his same-as line kept', () => {
        const entries = [
            { key: 'Airi', names: ['Airi'], variants: ['school-uniform', 'school-gym', 'school-swimsuit'], hasLook: true },
            { key: 'Mitsuki', names: ['Mitsuki'], variants: ['school-uniform', 'school-gym', 'school-swimsuit'], hasLook: true },
            { key: 'Yuzuki', names: ['Yuzuki'], variants: ['school-uniform', 'school-gym', 'school-swimsuit'], hasLook: true },
            MAINCHAR,
        ];
        const uncastKeys = ['Mainchar'];
        const lastPictures = [wore('Mainchar', 'town-casual')];
        const onFile = onFileCast({ entries, namedKeys: ['Airi', 'Mitsuki', 'Yuzuki', 'Mainchar'], recentKeys: [], presentKeys: ['Mainchar'], uncastKeys, lastPictures });
        const text = replyCastInstruction(onFile, [], ['Critblade', 'Mainchar', '勇希'],
            userLastPictureWear({ entries, uncastKeys, lastPictures }), userOutfitsOnFile({ entries, uncastKeys }));
        expect(text).toContain('ON FILE — characters whose look is stored. Each line names one or more of them, then the outfit= choices a picture of any of them picks from. '
            + USER_NOTE + ' Never write body= for them; their stored look is used:\n'
            + '- Airi, Mitsuki, Yuzuki: school-uniform, school-gym, school-swimsuit\n'
            + USER_ON_FILE + '\n'
            + SAME_AS_HEADING + '\n- {{user}} (mainchar=): town-casual\n'
            + NOT_LISTED);
        expect(text).toContain('- Never the user\'s own character, who goes by: Critblade, Mainchar, 勇希. A record under any of these names is ignored.');
    });

    it('MUTATION TARGET — his line is never grouped, not even with a character who has the same outfits', () => {
        const text = replyCastInstruction([{ key: 'Airi', variants: MAINCHAR.variants.slice() }], [], [], '', MAINCHAR.variants);
        expect(text).toContain('- Airi: school-uniform, school-gym, school-swimsuit, town-casual\n' + USER_ON_FILE + '\n' + NOT_LISTED);
        expect(text).not.toContain('Airi, {{user}}');
    });

    // With nobody else listed his line still stands, under the heading for stored looks: "nobody … has a stored look"
    // above a line of stored outfits would contradict it.
    it('his line stands with nobody else ON FILE; no outfits ⇒ no line, no note, the block as before', () => {
        const alone = replyCastInstruction([], [], ['Critblade'], 'town-casual', MAINCHAR.variants);
        expect(alone).not.toContain('ON FILE — nobody');
        expect(alone).toContain(USER_NOTE + ' Never write body= for them; their stored look is used:\n' + USER_ON_FILE + '\n' + SAME_AS_HEADING + '\n- {{user}} (mainchar=): town-casual\n' + NOT_LISTED);
        for (const none of [[], undefined, ['  ', null]]) {
            const text = replyCastInstruction([], [], ['Critblade'], 'town-casual', none);
            expect(text).toBe(replyCastInstruction([], [], ['Critblade'], 'town-casual'));
            expect(text).toContain('ON FILE — nobody the story has named has a stored look.');
            expect(text).not.toContain(USER_NOTE);
            expect(text).not.toContain('(mainchar=): school-uniform');
        }
        const withGirl = replyCastInstruction([{ key: 'Ann', variants: ['school-uniform'] }], [], [], '', []);
        expect(withGirl).toContain('picks from. Never write body= for them; their stored look is used:\n- Ann: school-uniform\n' + NOT_LISTED);
    });

    // His line is printed text, never a listing: onFileCast still leaves him out, so he takes no record and is never in
    // the informed set the harvest reads. MUTATION TARGET: list the uncast entry to print the line and he is castable.
    it('MUTATION TARGET — his ON FILE line never makes him castable', () => {
        const entries = [MAINCHAR, { key: 'Airi', names: ['Airi'], variants: ['school-uniform'], hasLook: true }];
        const onFile = onFileCast({ entries, namedKeys: ['Mainchar', 'Airi'], recentKeys: ['Mainchar'], presentKeys: ['Mainchar', '勇希'], uncastKeys: ['Mainchar'] });
        expect(onFile.map((e) => e.key)).toEqual(['Airi']);
        expect(classifyReplyCast(['勇希', 'Mainchar'], [{ key: 'Mainchar', content: '[Body]\nb\n[Clothes:town-casual]\nhoodie\n[Alias]\n勇希' }], ['Critblade', 'Mainchar', '勇希']))
            .toEqual({ registered: [], newcomers: [], uncast: ['勇希', 'Mainchar'] });
    });

    it('MUTATION TARGET — the ON FILE heading says a line may name several characters who share its choices', () => {
        expect(replyCastInstruction([{ key: 'Ann', variants: ['school-uniform'] }]))
            .toContain('ON FILE — characters whose look is stored. Each line names one or more of them, then the outfit= choices a picture of any of them picks from.');
    });

    // THE GROUPING: a cast in one uniform set costs one line, however many wear it. MUTATION TARGET: one line per
    // character and the list grows with the roster; group by the set in written order and two girls whose outfits
    // were registered in a different order split onto two lines.
    it('MUTATION TARGET — characters with the same outfits share one line, in any order of the outfits', () => {
        const text = replyCastInstruction([
            { key: 'Airi', variants: ['school-uniform', 'school-gym'] },
            { key: 'Leila', variants: ['default', 'goddess-swimsuit'] },
            { key: 'Mana', variants: ['school-gym', 'school-uniform'] },
            { key: 'Varro', variants: [] },
            { key: 'Yuki', variants: ['school-uniform', 'school-gym'] },
            { key: 'Zed', variants: [] },
        ]);
        expect(text).toContain('- Airi, Mana, Yuki: school-uniform, school-gym\n- Leila: default, goddess-swimsuit\n- Varro, Zed: no outfit on file — "newclothes" or "undressed"\n');
    });

    // An outfit added to one girl moves her off the shared line on the very next prompt: the groups are recomputed
    // from the list every time, never remembered.
    it('a character whose outfits differ by one is on a line of her own', () => {
        const text = replyCastInstruction([
            { key: 'Airi', variants: ['school-uniform', 'school-gym'] },
            { key: 'Mana', variants: ['school-uniform', 'school-gym', 'cafe-waitress'] },
        ]);
        expect(text).toContain('- Airi: school-uniform, school-gym\n- Mana: school-uniform, school-gym, cafe-waitress\n');
    });

    // SCOPE: listed when named anywhere in the chat; offered "same-as-last-picture" only when the story is with her
    // (named recently, or present). MUTATION TARGET: scope the list by the recent messages again and a character the
    // story brings back after a gap is off it; offer it to everyone listed and days-old clothes ride every prompt.
    it('MUTATION TARGET — named earlier in the chat is listed; only a recent or present character is offered her last picture', () => {
        const lastPictures = [oneOff('柚月', 'white sundress')];
        expect(onFileCast({ entries: [YUZUKI], namedKeys: ['柚月'], recentKeys: [], lastPictures }))
            .toEqual([{ key: '柚月', variants: ['gym', 'swim'], lastPictureWear: '' }]);
        expect(onFileCast({ entries: [YUZUKI], namedKeys: ['柚月'], recentKeys: ['柚月'], lastPictures })[0].lastPictureWear).toBe('white sundress');
        expect(onFileCast({ entries: [YUZUKI], namedKeys: ['柚月'], recentKeys: [], presentKeys: ['柚月'], lastPictures })[0].lastPictureWear).toBe('white sundress');
        expect(onFileCast({ entries: [YUZUKI], namedKeys: [], recentKeys: ['柚月'], lastPictures })).toEqual([]);
    });

    it('namedKeysOf — the registered characters one text names, in entry order', () => {
        expect(namedKeysOf([YUZUKI, VIOLA], '薇歐拉 watched 柚月 closely.')).toEqual(['柚月', '薇歐拉·杜茲']);
        expect(namedKeysOf([YUZUKI, VIOLA], '')).toEqual([]);
        expect(namedKeysOf(undefined, '柚月')).toEqual([]);
    });

    it('matches on an ALIAS, not just the registered key — prose uses the short name', () => {
        expect(keys(cast({ entries: [VIOLA], recentTexts: ['薇歐拉 drew the dagger.'] }))).toEqual(['薇歐拉·杜茲']);
    });

    // Listed means never described: an entry with nothing stored (a name-only placeholder) still needs
    // describing, so it stays off the list.
    it('leaves out a character with nothing stored', () => {
        expect(cast({ entries: [PLAIN], recentTexts: ['Mana laughed.'] })).toEqual([]);
        expect(cast({ entries: [{ ...PLAIN, hasLook: false }], recentTexts: ['Mana laughed.'] })).toEqual([]);
    });

    // A character registered with her body only (she was shown undressed) is never described again, and
    // the line says she has nothing a picture could name. MUTATION TARGET: drop her and she is described
    // every reply; list her bare and the narrator writes "default" for clothes that do not exist.
    it('lists a character with a stored body and no outfit, and says she has none', () => {
        const varro = { key: 'Varro', names: ['Varro'], variants: [], hasLook: true };
        expect(cast({ entries: [varro], recentTexts: ['Varro bowed.'] })).toEqual([{ key: 'Varro', variants: [], lastPictureWear: '' }]);
        expect(replyCastInstruction([{ key: 'Varro', variants: [] }])).toContain('- Varro: no outfit on file — "newclothes" or "undressed"');
        expect(replyCastInstruction([{ key: 'Ann', variants: ['school-uniform'] }])).toContain('- Ann: school-uniform');
    });

    it('is case-insensitive on latin keys', () => {
        const ann = { key: 'Ann', names: ['Ann'], variants: ['pajama'] };
        expect(keys(cast({ entries: [ann], recentTexts: ['ANN opened the door.'] }))).toEqual(['Ann']);
    });

    it('nobody named and nobody present ⇒ nobody listed, never the whole roster', () => {
        expect(cast({ entries: [YUZUKI, VIOLA], recentTexts: ['The hall was empty.'] })).toEqual([]);
        expect(cast({ entries: [YUZUKI], recentTexts: [] })).toEqual([]);
        expect(cast({ entries: [YUZUKI] })).toEqual([]);
    });

    // A character present in the game state but unnamed in the recent text is still listed: presence
    // ADDS to the list. MUTATION TARGET: read the mention scan alone and she is described again.
    it('includes a PRESENT character the mention scan missed', () => {
        expect(keys(cast({ entries: [YUZUKI, VIOLA], recentTexts: ['nothing'], presentKeys: ['薇歐拉'] }))).toEqual(['薇歐拉·杜茲']);
    });

    // Presence never GATES the list: a card with no presence field still gets it.
    it('no presence field ⇒ the mention scan alone still lists people', () => {
        expect(keys(cast({ entries: [YUZUKI], recentTexts: ['柚月 waved'], presentKeys: [] }))).toEqual(['柚月']);
    });

    // The user's own character never takes a cast record; state paths name its key in the chat every turn,
    // so the mention scan alone would list it. MUTATION TARGET: drop the exclusion and it is offered.
    it('never lists an uncast key — the user\'s own character\'s entry — mentioned or present', () => {
        const player = { key: 'Hero', names: ['Hero'], variants: ['default', 'armor'] };
        expect(keys(cast({ entries: [player, YUZUKI], recentTexts: ['/Hero/Quests/0 … 柚月'], presentKeys: ['Hero'], uncastKeys: ['hero'] }))).toEqual(['柚月']);
        expect(keys(cast({ entries: [player], recentTexts: ['Hero'] }))).toEqual(['Hero']);
    });

    it('a present character with no outfit on file is not listed', () => {
        expect(cast({ entries: [PLAIN], recentTexts: [], presentKeys: ['Mana'] })).toEqual([]);
    });

    it('preserves registry order, lists every match, and degrades on junk', () => {
        expect(keys(cast({ entries: [YUZUKI, VIOLA], recentTexts: ['薇歐拉 watched 柚月 closely.'] }))).toEqual(['柚月', '薇歐拉·杜茲']);
        expect(cast({ entries: undefined, recentTexts: ['柚月'] })).toEqual([]);
        expect(keys(cast({ entries: [null, {}, YUZUKI], recentTexts: ['柚月'] }))).toEqual(['柚月']);
    });
});

describe('the lorebook lists a character this prompt is about to play (lorebookKeysOf, activatedKeysOf)', () => {
    const MITSUKI_ON_FILE = { key: 'Mitsuki', names: ['Mitsuki', '橘美月'], variants: ['school-uniform'] };
    const MANA = { key: 'Mana', names: ['Mana'], variants: ['school-uniform'] };
    const HARUKA = { key: 'Haruka', names: ['Haruka'], variants: ['school-uniform', 'school-gym'] };
    const keys = (list) => list.map((e) => e.key);

    // Secondary keys narrow when an entry fires and never say who it is about. MUTATION TARGET: read them too and an
    // entry about Mitsuki that requires "Mana" alongside lists Mana.
    it('MUTATION TARGET — lorebookKeysOf takes every activated entry\'s primary keys, trimmed, never its secondary keys', () => {
        expect(lorebookKeysOf([{ key: [' Mitsuki ', '美月'], keysecondary: ['Mana'] }, { key: ['Haruka'] }])).toEqual(['Mitsuki', '美月', 'Haruka']);
        expect(lorebookKeysOf([{ key: [] }, { key: 'Mana' }, null, { key: ['', null, '  '] }])).toEqual([]);
        expect(lorebookKeysOf(undefined)).toEqual([]);
    });

    // MUTATION TARGET: compare by substring and an entry keyed "Event_Body_Haruka" lists Haruka, "manager" Mana.
    it('MUTATION TARGET — activatedKeysOf counts a name EQUAL to a key, case ignored, never a substring', () => {
        expect(activatedKeysOf([MITSUKI_ON_FILE, MANA, HARUKA], [' MITSUKI '])).toEqual(['Mitsuki']);
        expect(activatedKeysOf([MITSUKI_ON_FILE, MANA, HARUKA], ['Event_Body_Haruka', 'manager', '/Mana/i'])).toEqual([]);
    });

    it('matches on an ALIAS, and returns registry keys in entry order', () => {
        expect(activatedKeysOf([MANA, MITSUKI_ON_FILE], ['橘美月', 'mana'])).toEqual(['Mana', 'Mitsuki']);
    });

    it('no keys, or junk ⇒ nobody', () => {
        expect(activatedKeysOf([MANA], [])).toEqual([]);
        expect(activatedKeysOf([MANA], undefined)).toEqual([]);
        expect(activatedKeysOf(null, ['Mana'])).toEqual([]);
        expect(activatedKeysOf([null, {}, MANA], ['Mana'])).toEqual(['Mana']);
    });

    // The prompt is built before the reply, so the chat has not named her on the reply that brings her in. MUTATION
    // TARGET: drop the lorebook from onFileCast and her first picture is "newclothes".
    it('MUTATION TARGET — onFileCast lists a character an activated entry is keyed on, though the chat never named her', () => {
        expect(keys(onFileCast({ entries: [MANA, HARUKA], namedKeys: [], recentKeys: [], activatedKeys: ['haruka'] }))).toEqual(['Haruka']);
    });

    // A loaded entry is no sign the story was with her lately. MUTATION TARGET: count the lorebook as "with her" and a
    // character back after a long gap is offered the clothes of a scene the story left behind.
    it('MUTATION TARGET — the lorebook alone offers no "same-as-last-picture"', () => {
        const lastPictures = [{ key: 'Haruka', outfit: 'school-gym', clothes: '' }];
        expect(onFileCast({ entries: [HARUKA], namedKeys: ['Haruka'], activatedKeys: ['Haruka'], lastPictures })[0].lastPictureWear).toBe('');
        expect(onFileCast({ entries: [HARUKA], namedKeys: ['Haruka'], recentKeys: ['Haruka'], activatedKeys: ['Haruka'], lastPictures })[0].lastPictureWear).toBe('school-gym');
    });

    it('ADDS to the list and never gates it; never lists the user\'s own character or one with nothing stored', () => {
        expect(keys(onFileCast({ entries: [MANA, HARUKA], namedKeys: ['Mana'] }))).toEqual(['Mana']);
        expect(keys(onFileCast({ entries: [MANA, HARUKA], namedKeys: ['Mana'], activatedKeys: ['Haruka'] }))).toEqual(['Mana', 'Haruka']);
        const player = { key: 'Hero', names: ['Hero'], variants: ['armor'] };
        const placeholder = { key: 'Sui', names: ['Sui'], variants: [] };
        expect(onFileCast({ entries: [player, placeholder], activatedKeys: ['Hero', 'Sui'], uncastKeys: ['Hero'] })).toEqual([]);
    });
});

// The host builds the ON FILE list from the store in the state the reply starts from; no unit test can open that
// file, so its wiring is checked here.
describe('uncastNamesOf — the names the user\'s own character goes by', () => {
    const PLAYER = { key: 'Mainchar', content: '[Body]\nb\n[Alias]\n勇希\nYuuki' };

    it('the persona name, then each uncast key with its entry\'s aliases', () => {
        expect(uncastNamesOf({ entries: [MITSUKI, PLAYER], uncastKeys: ['Mainchar'], personaName: 'Critblade' })).toEqual(['Critblade', 'Mainchar', '勇希', 'Yuuki']);
    });

    it('each name once, case-insensitively, as first written', () => {
        expect(uncastNamesOf({ entries: [PLAYER], uncastKeys: ['mainchar', 'MAINCHAR'], personaName: 'yuuki' })).toEqual(['yuuki', 'Mainchar', '勇希']);
    });

    it('an uncast key with no entry is still a name they go by; no key ⇒ the persona name alone', () => {
        expect(uncastNamesOf({ entries: [], uncastKeys: ['Hero'], personaName: 'Critblade' })).toEqual(['Critblade', 'Hero']);
        expect(uncastNamesOf({ entries: [PLAYER], uncastKeys: [], personaName: 'Critblade' })).toEqual(['Critblade']);
    });

    it('never throws on garbage', () => {
        expect(uncastNamesOf()).toEqual([]);
        expect(uncastNamesOf({ entries: null, uncastKeys: [null, '  '], personaName: undefined })).toEqual([]);
    });

    it('isUncastName compares trimmed and case-insensitively; nothing matches an empty name', () => {
        expect(isUncastName(' critblade ', ['Critblade'])).toBe(true);
        expect(isUncastName('勇希', ['Critblade', '勇希'])).toBe(true);
        expect(isUncastName('美月', ['Critblade', '勇希'])).toBe(false);
        expect(isUncastName('', [''])).toBe(false);
        expect(isUncastName('勇希', null)).toBe(false);
    });
});

describe('SOURCE GATE — the ON FILE list is given what the store holds from each last picture', () => {
    const src = readFileSync(new URL('../src/features/character-roster/reply-cast-prompt.js', import.meta.url), 'utf8');

    it('MUTATION TARGET — the store comes from the reply\'s starting state and reaches onFileCast and the user\'s line', () => {
        expect(src).toContain('return start ? lastPictureOutfitsIn(ownStatPart(start.statData, WORN_OUTFIT_PART)) : [];');
        expect(src).toContain('const lastPictures = lastPicturesAtReplyStart();');
        expect(src).toContain('        lastPictures,');
        expect(src).toContain('const userWear = userLastPictureWear({ entries: rosterEntries, uncastKeys, lastPictures });');
    });

    // A POST call that writes the pictures reads the same ON FILE list the narrator's <reply_cast> carries
    // (plans/executed/picture-writer-route.md D5): one computation (onFileNow) and one wording (onFileListText) for both.
    it('MUTATION TARGET — the narrator\'s block and the picture call\'s list come from one computation', () => {
        expect(src).toContain('const { entries, onFile, userWear, userOutfits, activatedKeys } = await onFileNow();');
        const forPictures = src.slice(src.indexOf('export async function onFileListForPictureCall('), src.indexOf('eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY'));
        expect(forPictures).toContain('const { onFile, userWear, userOutfits } = await onFileNow();');
        expect(forPictures).toContain('return onFileListText(onFile, userWear, userOutfits);');
    });

    // D32: his outfits come from his own entry in the registry read this prompt (listOutfitVariants, like every
    // character's), never from a list written by hand. MUTATION TARGET: drop the argument and his ON FILE line is gone.
    it('MUTATION TARGET — the user\'s own character\'s outfits on file reach his ON FILE line', () => {
        expect(src).toContain('variants: listOutfitVariants(e.content)');
        expect(src).toContain('const userOutfits = userOutfitsOnFile({ entries: rosterEntries, uncastKeys });');
        expect(src).toContain('const block = replyCastInstruction(onFile, recordAsksOfConsumers(consumers), userNames, userWear, userOutfits);');
    });

    // The scope is decided in the host file: ON FILE is whoever the WHOLE chat names, "same-as-last-picture" whoever
    // the recent messages name. MUTATION TARGET: slice the named set to the recent messages and a character the story
    // brings back after a gap is off the list again.
    it('MUTATION TARGET — the whole chat decides who is listed, the recent messages who is offered her last picture', () => {
        expect(src).toContain('namedKeys: perMessage.flat(),');
        expect(src).toContain('recentKeys: perMessage.slice(-RECENT_MESSAGES).flat(),');
        expect(src).toContain('const perMessage = namedKeysPerMessage(rosterEntries);');
    });

    // Each message is scanned once per text: a prompt build reuses every unchanged message's answer, and a changed
    // registry (an alias added) drops them all. MUTATION TARGET: drop the reuse and every build rescans the whole chat.
    it('MUTATION TARGET — the mention scan reuses an unchanged message\'s answer, and the registry\'s names reset it', () => {
        expect(src).toContain('if (known && known.mes === mes) return known.keys;');
        expect(src).toContain('if (mentionCache.chatId !== chatId || mentionCache.namesSignature !== namesSignature) {');
    });

    // SillyTavern reports the entries it activated, and nothing when none activates. MUTATION TARGET: drop the reset at
    // a real generation's start and a generation that loads no entry lists the last one's characters; drop the chat
    // check and another chat's entries list them.
    it('MUTATION TARGET — this generation\'s activated lorebook keys reach onFileCast; a real generation starts from none', () => {
        expect(src).toContain('activatedLorebook = { chatId: currentChatId(), keys: lorebookKeysOf(activatedEntries) };');
        const started = src.slice(src.indexOf('eventSource.on(event_types.GENERATION_STARTED'), src.indexOf('// What the worn-outfit store holds'));
        expect(started).toContain('if (dryRun) return;');
        expect(started).toContain('activatedLorebook = { chatId: currentChatId(), keys: [] };');
        expect(src).toContain('return activatedLorebook.chatId === currentChatId() ? activatedLorebook.keys : [];');
        expect(src).toContain('const activatedKeys = activatedKeysOf(rosterEntries, activatedLorebookKeys());');
        expect(src).toContain('        activatedKeys,');
    });
});

// The names reach the block, the POST call's cast and the harvest through host files no unit test can open, so
// that wiring is checked here.
describe('SOURCE GATE — the user\'s own character\'s names reach every reader of the records', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

    it('MUTATION TARGET — the <reply_cast> block prints them', () => {
        const src = read('../src/features/character-roster/reply-cast-prompt.js');
        expect(src).toContain('uncastNamesOf({ entries, uncastKeys: uncastKeysOfConsumers(), personaName: ctx ? ctx.name1 : \'\' })');
        expect(src).toContain('replyCastInstruction(onFile, recordAsksOfConsumers(consumers), userNames, userWear, userOutfits)');
    });

    it('MUTATION TARGET — the POST registration call is never asked about them', () => {
        expect(read('../src/features/imagegen/image-gen.js')).toContain('classifyReplyCast(names, entries, uncastNamesFor(entries))');
    });

    it('MUTATION TARGET — the harvest registers nothing under their names', () => {
        const src = read('../src/features/character-roster/harvest.js');
        expect(src).toContain('const uncastNames = uncastNamesFor(known);');
        expect(src).toContain('if (isUncastName(record.name, uncastNames)) { uncastWritten.push(record.name); continue; }');
    });
});
