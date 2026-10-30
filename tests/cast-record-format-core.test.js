/**
 * MVU Helper — the cast record format (character-roster/cast-record-format-core.js).
 *
 * The one file that knows how a cast record is written. Everything else handles records, so these
 * tests pin the format's promises: one line per record, no closer, a malformed record never
 * swallows what follows it, and write/read round-trip.
 *
 * Run:  npm test
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { readCastRecords, writeCastRecord, CAST_RECORD_PATTERN, CAST_RECORD_FORMAT_RULES } from '../src/features/character-roster/cast-record-format-core.js';

describe('readCastRecords — records out of model text', () => {
    it('reads every record in text order, with name apart from the other attributes', () => {
        const text = 'She smiled.\n<pic char="美月" prompt="x">\n<cast name="美月" outfit="swimsuit">\n<cast name="勇希">';
        const { records, invalid, strayMarkup } = readCastRecords(text);
        expect(records.map((r) => r.name)).toEqual(['美月', '勇希']);
        expect(records[0].attributes).toEqual({ outfit: 'swimsuit' });
        expect(records[1].attributes).toEqual({});
        expect(records[0].raw).toBe('<cast name="美月" outfit="swimsuit">');
        expect(invalid).toEqual([]);
        expect(strayMarkup).toEqual([]);
    });

    it('reserved keys are case-folded; a user field keeps its key as written, in any script', () => {
        const { records } = readCastRecords('<cast NAME="A" Body="b" InT="+1" 好感度="+2">');
        expect(records[0].name).toBe('A');
        expect(records[0].attributes).toEqual({ body: 'b', InT: '+1', 好感度: '+2' });
    });

    it('unknown attributes are kept raw, never dropped (plans/reply-cast.md §1.8 rule 2)', () => {
        expect(readCastRecords('<cast name="A" weapon="short sword">').records[0].attributes.weapon).toBe('short sword');
    });

    it('the first occurrence of a repeated key wins', () => {
        expect(readCastRecords('<cast name="A" name="B" body="1" body="2">').records[0]).toMatchObject({ name: 'A', attributes: { body: '1' } });
    });

    it('a record with no name is INVALID, reported with its raw text', () => {
        const { records, invalid } = readCastRecords('<cast char="A" body="x">');
        expect(records).toEqual([]);
        expect(invalid).toHaveLength(1);
        expect(invalid[0].raw).toBe('<cast char="A" body="x">');
    });

    // THE FORMAT'S CORE PROMISE. A record cannot cross a line, so a malformed one leaks at most the rest
    // of its own line. MUTATION TARGET: drop `\n` from CAST_RECORD_PATTERN and the prose below is eaten.
    it('a record missing its ">" never swallows the next line', () => {
        const text = '<cast name="A" body="x"\nShe walked to the gate > and waited.\n<cast name="B">';
        const { records } = readCastRecords(text);
        expect(records.map((r) => r.name)).toEqual(['B']);
    });

    it('a ">" inside a value ends the record there (the instruction bans it)', () => {
        const { records } = readCastRecords('<cast name="A" body="smile >_< face">');
        expect(records[0].name).toBe('A');
        expect(records[0].attributes.body).toBeUndefined();
    });

    it('stray closers are reported for removal, never as records', () => {
        const { records, strayMarkup } = readCastRecords('<cast name="A">\n</cast>\ntail</cast');
        expect(records).toHaveLength(1);
        expect(strayMarkup).toEqual(['</cast>', '</cast']);
    });

    // An unfinished closer made the browser swallow the page to the next ">" (live 2026-08-09).
    // MUTATION TARGET: widen the closer pattern to `[^>]*>` and it takes the placeholder with it.
    it('an UNFINISHED closer is matched without anything past it', () => {
        const { strayMarkup } = readCastRecords('x</cast\n\n<StatusPlaceHolderImpl/>');
        expect(strayMarkup).toEqual(['</cast\n\n']);
    });

    it('never throws on garbage', () => {
        expect(readCastRecords(null)).toEqual({ records: [], invalid: [], strayMarkup: [] });
        expect(readCastRecords('<castle name="A">').records).toEqual([]);
    });
});

describe('writeCastRecord — the syntax every instruction example is built from', () => {
    it('round-trips through readCastRecords', () => {
        const written = writeCastRecord({ name: '勇希', attributes: { body: 'red hair', outfit: 'pajama' } });
        expect(written).toBe('<cast name="勇希" body="red hair" outfit="pajama">');
        expect(readCastRecords(written).records[0]).toMatchObject({ name: '勇希', attributes: { body: 'red hair', outfit: 'pajama' } });
    });

    it('drops the characters a value may never contain, so a written record always reads back', () => {
        const written = writeCastRecord({ name: 'A"B', attributes: { body: 'x>y\nz' } });
        expect(written).toBe('<cast name="AB" body="xyz">');
        expect(written.match(CAST_RECORD_PATTERN)).toEqual([written]);
    });

    // Live 2026-09-26: a generic `key="value"` example here was copied by the narrator as a real attribute
    // on every record. MUTATION TARGET: put an example record back into the rules and this fails.
    it('the format rules carry no example record to copy, forbid a closer and extra attributes', () => {
        CAST_RECORD_PATTERN.lastIndex = 0;
        expect(CAST_RECORD_PATTERN.test(CAST_RECORD_FORMAT_RULES)).toBe(false);
        expect(CAST_RECORD_FORMAT_RULES).toMatch(/NEVER write a closing tag/);
        expect(CAST_RECORD_FORMAT_RULES).toMatch(/Attributes: those an instruction in this prompt asks for — never one you invent\./);
    });
});

// The narrator writes its records in the reply whichever call registers the looks, so a closer it writes is removed
// from the reply on both routes (D15); the write lives in a host file no unit test can open. MUTATION TARGETS: gate the
// removal on the narrate route again and a POST-route reply keeps its closer, which the next prompt's history shows the
// narrator; read the closers from the call's output and the POST route looks for them in the wrong text.
describe('SOURCE GATE — stray closers leave the narrator\'s reply on both routes (D15)', () => {
    const imageGen = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const onOutput = imageGen.slice(imageGen.indexOf('async function onRegistrationOutput('), imageGen.indexOf('async function removeStrayCastClosers('));

    it('MUTATION TARGET — every registration output, narrate or POST, removes them, with no route gate', () => {
        expect(onOutput).toContain('    await removeStrayCastClosers(meta.messageId);\n    // POST capture done');
        expect(onOutput).not.toMatch(/strayMarkup/);
    });

    it('MUTATION TARGET — they are read from the reply as it is now, and removed by exact string', () => {
        expect(imageGen).toContain('const m = getContext().chat[messageId];\n        if (!m || m.is_user) return;\n        const { strayMarkup } = readCastRecords(m.mes);');
        expect(imageGen).toContain('const cut = removeTagsPinpoint(m.mes, strayMarkup);');
        expect(imageGen).toContain("await redrawReply(m, messageId, 'stray </cast> closer removal');");
    });
});
