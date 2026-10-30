// tests/character-registry-core.test.js — the character registry's pure store half: a record turned into the entry
// text dna-core reads and back, entry-level changes applied to a registry and to a state's part, a reply's journal, and
// the shape check; and source gates on the store's doors into a state (character-registry.js).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    CHARACTER_REGISTRY_PART, contentFromRecord, recordFromContent, registryIn, entriesOfRegistry, setChange, deleteChange,
    applyRegistryChanges, registryPartAfter, describeChange, newJournal, isJournalOf, recordProblems, recordFromEditorFields, editorFieldsFromRecord,
} from '../src/features/character-roster/character-registry-core.js';
import { parseDnaSections, listOutfitVariants, listAliases, allowsClothesUpdate, hasStoredAppearance, parseBustMultiplier } from '../src/features/character-roster/dna-core.js';

const airi = {
    body: 'curvy figure, mint-green hair',
    bust: 2.1,
    clothes: { 'school-uniform': 'red track jacket, plaid skirt', 'school-gym': 'white shirt, navy shorts' },
    aliases: ['Kuraha', '倉葉アイリ'],
    allow_update: true,
};

describe('contentFromRecord / recordFromContent — the record and the entry text dna-core reads', () => {
    it('the part is named after the Roster tab\'s "Character registry"', () => {
        expect(CHARACTER_REGISTRY_PART).toBe('character_registry');
    });

    it('MUTATION TARGET — writes the sections in the order the card build writes them', () => {
        expect(contentFromRecord(airi)).toBe([
            '[Body]', 'curvy figure, mint-green hair',
            '[Bust]', '2.1',
            '[Clothes:school-uniform]', 'red track jacket, plaid skirt',
            '[Clothes:school-gym]', 'white shirt, navy shorts',
            '[Alias]', 'Kuraha', '倉葉アイリ',
            '[AllowUpdate]', 'true',
        ].join('\n'));
    });

    it('MUTATION TARGET — dna-core reads every field back from the text as the record holds it', () => {
        const content = contentFromRecord(airi);
        const parsed = parseDnaSections(content);
        expect(parsed.body).toBe(airi.body);
        expect(parseBustMultiplier('Airi', content).value).toBe(2.1);
        expect(listOutfitVariants(content)).toEqual(['school-uniform', 'school-gym']);
        expect(listAliases(content)).toEqual(airi.aliases);
        expect(allowsClothesUpdate(content).allowed).toBe(true);
    });

    it('MUTATION TARGET — a record round-trips through its text unchanged', () => {
        for (const record of [airi, { body: 'b' }, { clothes: { default: 'plain dress' } }, { allow_update: false }, {}]) {
            expect(recordFromContent(contentFromRecord(record))).toEqual(record);
        }
    });

    it('the default outfit is [Clothes], written ahead of every named outfit', () => {
        const content = contentFromRecord({ clothes: { gym: 'shorts', default: 'uniform' } });
        expect(content).toBe('[Clothes]\nuniform\n[Clothes:gym]\nshorts');
        expect(recordFromContent(content).clothes).toEqual({ default: 'uniform', gym: 'shorts' });
    });

    it('a name-only record is empty text, which dna-core reads as no stored appearance', () => {
        expect(contentFromRecord({})).toBe('');
        expect(hasStoredAppearance(contentFromRecord({}))).toBe(false);
        expect(recordFromContent('')).toEqual({});
    });

    it('MUTATION TARGET — a field a later feature added is kept when the entry text is replaced', () => {
        const previous = { ...airi, inventory: { umbrella: 1 } };
        const next = recordFromContent('[Body]\nshort hair', previous);
        expect(next).toEqual({ body: 'short hair', inventory: { umbrella: 1 } });
    });

    it('a field the new text drops is gone — the text is the whole of the fields it carries', () => {
        expect(recordFromContent('[Body]\nb', airi)).toEqual({ body: 'b' });
    });

    it('an unreadable [AllowUpdate] stays text, so dna-core still reads it as false and says so', () => {
        const record = recordFromContent('[AllowUpdate]\nmaybe');
        expect(record.allow_update).toBe('maybe');
        const gate = allowsClothesUpdate(contentFromRecord(record));
        expect(gate.allowed).toBe(false);
        expect(gate.warning).toMatch(/unreadable/);
    });

    it('a bust that is not a number stays text, so dna-core reports it as today', () => {
        expect(recordFromContent('[Bust]\nbig').bust).toBe('big');
        expect(recordFromContent('[Bust]\n1.5').bust).toBe(1.5);
    });
});

describe('entriesOfRegistry — what every caller of the store reads', () => {
    it('MUTATION TARGET — one { key, content } per record, sorted by key', () => {
        const entries = entriesOfRegistry({ Mana: { body: 'm' }, Airi: { body: 'a' } });
        expect(entries).toEqual([{ key: 'Airi', content: '[Body]\na' }, { key: 'Mana', content: '[Body]\nm' }]);
    });

    it('a value that is not a record, or a blank key, is no entry', () => {
        expect(entriesOfRegistry({ Bad: 'text', '': { body: 'x' }, Ok: {} })).toEqual([{ key: 'Ok', content: '' }]);
        expect(entriesOfRegistry(null)).toEqual([]);
        expect(registryIn(['x'])).toEqual({});
    });
});

describe('applyRegistryChanges — entry-level changes, written into any copy of a state', () => {
    it('MUTATION TARGET — sets and deletes in order, without touching the registry it was given', () => {
        const before = { Airi: { body: 'a' }, Kenji: {} };
        const after = applyRegistryChanges(before, [setChange('Mana', { body: 'm' }), deleteChange('Kenji'), setChange('Airi', { body: 'a2' })]);
        expect(after).toEqual({ Airi: { body: 'a2' }, Mana: { body: 'm' } });
        expect(before).toEqual({ Airi: { body: 'a' }, Kenji: {} });
    });

    it('MUTATION TARGET — applying changes a copy already holds changes nothing', () => {
        const changes = [setChange('Mana', { body: 'm' }), deleteChange('Kenji')];
        const once = applyRegistryChanges({ Kenji: {} }, changes);
        expect(applyRegistryChanges(once, changes)).toEqual(once);
    });

    it('MUTATION TARGET — a change keeps its own copy of the record, so a later edit of the source cannot reach it', () => {
        const record = { body: 'a' };
        const change = setChange('Airi', record);
        record.body = 'changed afterwards';
        expect(applyRegistryChanges({}, [change]).Airi.body).toBe('a');
        const applied = applyRegistryChanges({}, [change]);
        applied.Airi.body = 'edited copy';
        expect(applyRegistryChanges({}, [change]).Airi.body).toBe('a');
    });

    it('names a change for a log line', () => {
        expect(describeChange(setChange('Airi', {}))).toBe('set Airi');
        expect(describeChange(deleteChange('Kenji'))).toBe('delete Kenji');
    });
});

describe("registryPartAfter — what a state's registry part becomes", () => {
    it('MUTATION TARGET — a state that holds no registry is never handed an empty one', () => {
        expect(registryPartAfter(undefined, [deleteChange('薇拉')])).toBeUndefined();
        expect(registryPartAfter(undefined, [])).toBeUndefined();
    });

    it('MUTATION TARGET — a copy that already holds the changes is left as it is, the same object', () => {
        const part = { Airi: { body: 'a' } };
        expect(registryPartAfter(part, [setChange('Airi', { body: 'a' }), deleteChange('Kenji')])).toBe(part);
    });

    it('changes that do something give a new registry, and the part is not touched', () => {
        const part = { Airi: { body: 'a' }, Kenji: {} };
        expect(registryPartAfter(part, [deleteChange('Kenji'), setChange('Mana', { body: 'm' })])).toEqual({ Airi: { body: 'a' }, Mana: { body: 'm' } });
        expect(part).toEqual({ Airi: { body: 'a' }, Kenji: {} });
        expect(registryPartAfter(undefined, [setChange('Airi', { body: 'a' })])).toEqual({ Airi: { body: 'a' } });
    });
});

describe("SOURCE GATE — the store's doors into a state (character-registry.js)", () => {
    const source = readFileSync(new URL('../src/features/character-roster/character-registry.js', import.meta.url), 'utf8').replace(/\r/g, '');

    it('MUTATION TARGET — the save door and the journal task each write only a registry the changes altered', () => {
        expect(source).toContain('rewriteOwnStatPart(messageId, CHARACTER_REGISTRY_PART, (part) => registryPartAfter(part, changes), { writer: SAVE_WRITER })');
        expect(source).toContain('const after = registryPartAfter(before, journal.changes);\n        if (after === before) return;\n        setOwnStatPart(statData, CHARACTER_REGISTRY_PART, after);');
        expect(source.match(/setOwnStatPart\(/g)).toHaveLength(1);
    });

    it('MUTATION TARGET — a delete is logged once it is on file', () => {
        expect(source).toContain("if (!(await commitChanges([deleteChange(cleanKey)], { isUserEdit }))) return false;\n    log.child('dna').lifecycle(`deleted entry for \"${cleanKey}\"`);");
    });
});

describe('a reply\'s journal — one message, one swipe', () => {
    it('MUTATION TARGET — matches only its own message object and swipe', () => {
        const reply = { mes: 'x' };
        const journal = newJournal(reply, 1);
        expect(isJournalOf(journal, reply, 1)).toBe(true);
        expect(isJournalOf(journal, reply, 0)).toBe(false);          // a regenerate or a swipe
        expect(isJournalOf(journal, { mes: 'x' }, 1)).toBe(false);   // another message with the same text
        expect(isJournalOf(null, reply, 1)).toBe(false);
    });
});

describe('recordProblems — the shape check a hand-written seed needs', () => {
    it('a well-formed record has none', () => {
        expect(recordProblems('Airi', airi)).toEqual([]);
        expect(recordProblems('Name only', {})).toEqual([]);
        expect(recordProblems('Text bust', { bust: '1.5' })).toEqual([]);
    });

    it('MUTATION TARGET — names each wrong field', () => {
        const problems = recordProblems('Airi', { body: 3, bust: 'big', aliases: 'Kuraha', clothes: { 'school uniform': 'x', gym: 4 }, allow_update: 'yes' });
        expect(problems).toEqual([
            '"Airi".body is not text',
            '"Airi".bust is not a number',
            '"Airi".aliases is not a list of names',
            '"Airi".clothes has an outfit named "school uniform" — letters, digits, - and _ only',
            '"Airi".clothes.gym is not text',
            '"Airi".allow_update is not true or false',
        ]);
    });

    it('a value that is not an object is not a record', () => {
        expect(recordProblems('Airi', 'text')).toHaveLength(1);
    });
});

describe("recordFromEditorFields — the Roster tab's editor, as a record", () => {
    const fields = (over = {}) => ({
        body: 'curvy figure', bust: '2.1', aliasesText: 'Kuraha\n倉葉アイリ\n\nkuraha', allowUpdate: false,
        outfits: [{ name: 'default', clothes: 'uniform' }, { name: 'School-Gym', clothes: 'shorts' }, { name: '', clothes: '' }],
        ...over,
    });

    it('MUTATION TARGET — reads every field: one alias per line, outfit names in lowercase, blank lines dropped', () => {
        const { record, problems } = recordFromEditorFields(fields());
        expect(problems).toEqual([]);
        expect(record).toEqual({ body: 'curvy figure', bust: 2.1, aliases: ['Kuraha', '倉葉アイリ'], clothes: { default: 'uniform', 'school-gym': 'shorts' } });
    });

    it('MUTATION TARGET — the outfits are the pairs the dialog holds: one taken out is removed, one added is written', () => {
        const { record, problems } = recordFromEditorFields(fields({ outfits: [{ name: 'swim', clothes: 'swimsuit' }, { name: '', clothes: '' }] }), { clothes: { default: 'uniform', gym: 'shorts' } });
        expect(problems).toEqual([]);
        expect(record.clothes).toEqual({ swim: 'swimsuit' });
    });

    it('MUTATION TARGET — a named outfit with no clothes is a problem, not a silent removal', () => {
        const { problems } = recordFromEditorFields(fields({ outfits: [{ name: 'default', clothes: 'uniform' }, { name: 'beach-swimsuit', clothes: '  ' }] }));
        expect(problems).toEqual(['The outfit "beach-swimsuit" has no clothes: write them, or remove the outfit with ×.']);
    });

    it('MUTATION TARGET — the switch: on writes true; off writes false only where the record already said something', () => {
        expect(recordFromEditorFields(fields({ allowUpdate: true })).record.allow_update).toBe(true);
        expect(recordFromEditorFields(fields()).record.allow_update).toBeUndefined();
        expect(recordFromEditorFields(fields(), { allow_update: true }).record.allow_update).toBe(false);
    });

    it('MUTATION TARGET — keeps the fields the editor does not show', () => {
        const { record } = recordFromEditorFields(fields(), { body: 'old', inventory: { umbrella: 1 } });
        expect(record.inventory).toEqual({ umbrella: 1 });
        expect(record.body).toBe('curvy figure');
    });

    it('MUTATION TARGET — names each problem, and the record is not one to save', () => {
        const { problems } = recordFromEditorFields(fields({
            bust: 'big',
            outfits: [{ name: '', clothes: 'orphan' }, { name: 'school uniform', clothes: 'x' }, { name: 'newclothes', clothes: 'y' }, { name: 'gym', clothes: 'a' }, { name: 'GYM', clothes: 'b' }],
        }));
        expect(problems).toEqual([
            'Bust is a number, such as 1.2 — "big" is not one.',
            'An outfit needs a name before its clothes can be saved.',
            'The outfit name "school uniform" may hold letters, digits, - and _ only.',
            '"newclothes" is a word the pictures use, not an outfit name.',
            'Two outfits are named "gym".',
        ]);
    });

    it('the record it builds is entry text dna-core reads back unchanged', () => {
        const { record } = recordFromEditorFields(fields({ allowUpdate: true }));
        expect(recordFromContent(contentFromRecord(record))).toEqual(record);
    });
});

describe("editorFieldsFromRecord — a record as the Roster tab's editor shows it", () => {
    const record = { body: 'slim', bust: 1.2, aliases: ['Mitsu', '光希'], clothes: { gym: 'shorts', default: 'uniform', 'home-pajamas': 'pajamas' }, allow_update: true };

    it('MUTATION TARGET — one pair per outfit on file, the default first, and no empty pair', () => {
        expect(editorFieldsFromRecord(record)).toEqual({
            body: 'slim', bust: '1.2', aliasesText: 'Mitsu\n光希', allowUpdate: true,
            outfits: [{ name: 'default', clothes: 'uniform' }, { name: 'gym', clothes: 'shorts' }, { name: 'home-pajamas', clothes: 'pajamas' }],
        });
    });

    it('a record with no look shows empty fields and no outfit pairs', () => {
        expect(editorFieldsFromRecord({})).toEqual({ body: '', bust: '', aliasesText: '', allowUpdate: false, outfits: [] });
        expect(editorFieldsFromRecord(null).outfits).toEqual([]);
    });

    it('saving the fields unchanged writes the record back as it was', () => {
        const { record: saved, problems } = recordFromEditorFields(editorFieldsFromRecord(record), record);
        expect(problems).toEqual([]);
        expect(saved).toEqual(record);
    });
});
