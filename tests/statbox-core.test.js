// statbox-core — the StatBox's pure decisions: normalize the card's section (unknown vocabulary
// ignored piece by piece), render baseline vs current, place / refresh / strip the box, pick the
// baseline message, and decide which of MVU's parses build the box. Source gates cover the host-side
// listener a unit test cannot open.
//
// Fixtures use a School-shaped and an RPG-shaped config side by side: the platform must serve both
// with the same code, and neither is the default.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    normalizeStatBoxSection, serializeStatBoxSection, isStatBoxConfigured,
    renderStatBox, placeStatBox, stripStatBox, statBoxBaselineIndex, messageStatData, unresolvedStatBoxPaths,
    isStatBoxParseWriter, shouldBuildStatBoxOnParse, shouldAwaitBoxAtArrival, isAwaitedBoxRendered,
} from '../src/features/statbox/statbox-core.js';
import { WRITER_MESSAGE, WRITER_POST } from '../src/sillytavern/mvu-bridge-core.js';

const newReport = () => ({ retired: [], unknown: [], blocked: [] });
const normalize = (raw) => {
    const report = newReport();
    return { section: normalizeStatBoxSection(raw, report), report };
};

const OPEN = '<styled type="terminal" title="Scene Stats">';
const CLOSE = '</styled>';

const SCHOOL_RAW = {
    open: OPEN,
    close: CLOSE,
    placeBefore: ['</maintext>', '</gametxt>'],
    groups: [
        { path: 'Mainchar', kind: 'record', nameField: 'Name',
            fields: [{ path: 'Cha', label: 'CHA' }, { path: 'Money', label: 'Money' }] },
        { path: 'Classmate', kind: 'collection', nameField: 'Name',
            fields: [
                { path: 'RelationshipStage', label: 'Stage' },
                { path: 'Affection', label: 'Affection', resetWith: 'RelationshipStage', onReset: 'hide' },
            ] },
    ],
};
const RPG_RAW = {
    open: '<box>',
    close: '</box>',
    placeBefore: ['</story>'],
    groups: [
        { path: 'Hero', kind: 'record',
            fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp', label: 'Exp', resetWith: 'Level', onReset: 'value' }] },
        { path: 'Party', kind: 'collection', nameField: 'Name',
            fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp', label: 'Exp', resetWith: 'Level', onReset: 'value' }] },
    ],
};
const SCHOOL = normalize(SCHOOL_RAW).section;
const RPG = normalize(RPG_RAW).section;

const girl = (name, stage, aff, extra = {}) => ({ Name: [name, 'Name'], RelationshipStage: [stage, ''], Affection: [aff, ''], ...extra });
const schoolState = ({ cha = 10, money = 500, girls = {} } = {}) => ({
    Mainchar: { Name: ['{{user}}', 'Name'], Cha: [cha, 'CHA'], Money: [money, 'Money'] },
    Classmate: girls,
});
const lines = (box) => box.split('\n').slice(1, -1);

// ── normalize ──────────────────────────────────────────────────────────────────
describe('normalizeStatBoxSection — a valid section', () => {
    it('keeps every declared piece and reports nothing', () => {
        const { section, report } = normalize(SCHOOL_RAW);
        expect(report).toEqual(newReport());
        expect(section.groups.map((g) => g.path)).toEqual(['Mainchar', 'Classmate']);
        expect(section.groups[1].fields[1]).toEqual({ path: 'Affection', label: 'Affection', resetWith: 'RelationshipStage', onReset: 'hide', show: 'whenMoved' });
    });
    it('absent → null with nothing reported (the box is idle)', () => {
        expect(normalize(undefined)).toEqual({ section: null, report: newReport() });
    });
    it('onReset absent beside resetWith → hide (the default)', () => {
        const raw = { ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp', label: 'Exp', resetWith: 'Level' }] }] };
        expect(normalize(raw).section.groups[0].fields[1].onReset).toBe('hide');
    });
});

describe('normalizeStatBoxSection — config this mvu-helper does not recognise (one fixture per row)', () => {
    const renderable = (section) => renderStatBox(section, { Hero: { Level: 1 }, Party: {} }, { Hero: { Level: 2 }, Party: {} });

    it('unknown KEY on the section, a group or a field → that key ignored, named in report.unknown', () => {
        const raw = {
            ...RPG_RAW,
            theme: 'dark',
            groups: [{ ...RPG_RAW.groups[0], colour: 'red', fields: [{ path: 'Level', label: 'Level', format: 'pct' }] }],
        };
        const { section, report } = normalize(raw);
        expect(report.unknown.map((u) => u.path)).toEqual([
            'statBox.theme',
            'statBox.groups[0] "Hero".colour',
            'statBox.groups[0] "Hero".fields "Level".format',
        ]);
        expect(report.blocked).toEqual([]);
        expect(section.groups[0].fields).toEqual([{ path: 'Level', label: 'Level', resetWith: '', onReset: '', show: 'whenMoved' }]);
    });
    it('onReset with an unknown value → onReset ignored (hide), blocked names it', () => {
        const raw = { ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp', label: 'Exp', resetWith: 'Level', onReset: 'fade' }] }] };
        const { section, report } = normalize(raw);
        expect(section.groups[0].fields[1].onReset).toBe('hide');
        expect(report.blocked).toHaveLength(1);
        expect(report.blocked[0].path).toBe('statBox.groups[0] "Hero".fields "Exp".onReset');
        expect(report.blocked[0].why).toMatch(/"fade" is not a mode/);
    });
    it('onReset without resetWith → ignored and said', () => {
        const raw = { ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level', onReset: 'value' }] }] };
        const { section, report } = normalize(raw);
        expect(section.groups[0].fields[0].onReset).toBe('');
        expect(report.blocked[0].why).toMatch(/no effect without resetWith/);
    });
    it('resetWith naming no field in the list → the FIELD is ignored, not just resetWith', () => {
        const raw = { ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp', label: 'Exp', resetWith: 'Lvl' }] }] };
        const { section, report } = normalize(raw);
        expect(section.groups[0].fields.map((f) => f.path)).toEqual(['Level']);
        expect(report.blocked[0].path).toBe('statBox.groups[0] "Hero".fields "Exp".resetWith');
    });
    it('a dropped sibling drops the field that resets with it (cascade)', () => {
        const raw = { ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [
            { path: 'Rank', label: 'Rank', resetWith: 'Tier' },
            { path: 'Level', label: 'Level' },
            { path: 'Exp', label: 'Exp', resetWith: 'Rank' },
        ] }] };
        const { section } = normalize(raw);
        expect(section.groups[0].fields.map((f) => f.path)).toEqual(['Level']);
    });
    it('a field without path or label → the field ignored', () => {
        const raw = { ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ label: 'Level' }, { path: 'Exp' }, { path: 'HP', label: 'HP' }] }] };
        const { section, report } = normalize(raw);
        expect(section.groups[0].fields.map((f) => f.path)).toEqual(['HP']);
        expect(report.blocked.map((b) => b.path)).toEqual([
            'statBox.groups[0] "Hero".fields[0].path',
            'statBox.groups[0] "Hero".fields "Exp".label',
        ]);
    });
    it('MUTATION TARGET — kind missing or unknown → that group ignored, the sibling group still renders', () => {
        const raw = { ...RPG_RAW, groups: [{ path: 'Party', kind: 'tree', fields: [{ path: 'Level', label: 'Level' }] }, RPG_RAW.groups[0]] };
        const { section, report } = normalize(raw);
        expect(section.groups.map((g) => g.path)).toEqual(['Hero']);
        expect(report.blocked[0].path).toBe('statBox.groups[0] "Party".kind');
        expect(report.blocked[0].why).toMatch(/"tree" is not a kind this mvu-helper knows \(record, collection\) — the group was ignored/);
        expect(renderable(section)).toContain('Hero: Level 2 (+1)');
        const missing = normalize({ ...RPG_RAW, groups: [{ path: 'Party', fields: [{ path: 'Level', label: 'Level' }] }, RPG_RAW.groups[0]] });
        expect(missing.section.groups.map((g) => g.path)).toEqual(['Hero']);
        expect(missing.report.blocked[0].why).toMatch(/is missing/);
    });
    it('a group without path, or with no usable field left → the group ignored', () => {
        const raw = { ...RPG_RAW, groups: [{ kind: 'record', fields: [{ path: 'Level', label: 'Level' }] }, { path: 'Party', kind: 'collection', fields: [{ path: 'Exp' }] }, RPG_RAW.groups[0]] };
        const { section } = normalize(raw);
        expect(section.groups.map((g) => g.path)).toEqual(['Hero']);
    });
    it('the section is ignored when it has no wrapper, nowhere to go, or is not an object', () => {
        for (const bad of [
            { ...RPG_RAW, open: 5 },
            { ...RPG_RAW, close: '' },
            { ...RPG_RAW, placeBefore: [] },
            { ...RPG_RAW, placeBefore: '</story>' },
            { ...RPG_RAW, groups: 'Hero' },
            { ...RPG_RAW, groups: [{ path: 'Hero', kind: 'tree', fields: [] }] },
            'yes',
        ]) {
            const { section, report } = normalize(bad);
            expect(section).toBe(null);
            expect(report.blocked.length).toBeGreaterThan(0);
        }
    });
    it('nothing throws on garbage anywhere in the tree', () => {
        expect(() => normalize({ open: OPEN, close: CLOSE, placeBefore: [null, 3, '</x>'], groups: [null, 7, { path: 'A', kind: 'record', fields: [null, 'x', { path: 'B', label: 'B' }] }] })).not.toThrow();
    });
});

// install / merge are the shared whole-section handler's (tests/card-config-whole-section.test.js).
describe('the section handler — serialize / configured', () => {
    it('serialize round-trips through normalize with an empty report', () => {
        for (const section of [SCHOOL, RPG]) {
            const { section: again, report } = normalize(JSON.parse(JSON.stringify(serializeStatBoxSection(section))));
            expect(report).toEqual(newReport());
            expect(again).toEqual(section);
        }
    });
    it('serialize omits an unconfigured section', () => {
        expect(serializeStatBoxSection(null)).toBe(undefined);
    });
    it('configured = at least one group', () => {
        expect(isStatBoxConfigured(SCHOOL)).toBe(true);
        expect(isStatBoxConfigured(null)).toBe(false);
        expect(isStatBoxConfigured({ groups: [] })).toBe(false);
    });
});

// ── render ─────────────────────────────────────────────────────────────────────
describe('renderStatBox', () => {
    const before = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 10), Mana: girl('Mana', 'Friend', 20) } });

    it('numbers print the value and the signed change; unchanged members are left off', () => {
        const after = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 13), Mana: girl('Mana', 'Friend', 20) } });
        expect(renderStatBox(SCHOOL, before, after)).toBe(`${OPEN}\nMitsuki Tachibana: Affection 13 (+3)\n${CLOSE}`);
    });
    it('a loss prints a minus', () => {
        const after = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 7), Mana: girl('Mana', 'Friend', 20) } });
        expect(lines(renderStatBox(SCHOOL, before, after))).toEqual(['Mitsuki Tachibana: Affection 7 (-3)']);
    });
    it('nothing moved → empty string', () => {
        expect(renderStatBox(SCHOOL, before, before)).toBe('');
    });
    it('a record group and a collection group in one box, in declared order', () => {
        const after = schoolState({ cha: 11, girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 12), Mana: girl('Mana', 'Friend', 21) } });
        expect(lines(renderStatBox(SCHOOL, before, after, { formatName: (n) => n.replace('{{user}}', 'Critblade') }))).toEqual([
            'Critblade: CHA 11 (+1)',
            'Mitsuki Tachibana: Affection 12 (+2)',
            'Mana: Affection 21 (+1)',
        ]);
    });
    it('MUTATION TARGET — a member out of the scene is printed too (RPG familiars off-scene gain exp)', () => {
        const was = { Hero: { Level: 3, Exp: 10 }, Party: { Wolf: { Name: 'Wolf', Level: 2, Exp: 5, Is_present: [false, ''] } } };
        const now = { Hero: { Level: 3, Exp: 30 }, Party: { Wolf: { Name: 'Wolf', Level: 2, Exp: 25, Is_present: [false, ''] } } };
        expect(lines(renderStatBox(RPG, was, now))).toEqual(['Hero: Exp 30 (+20)', 'Wolf: Exp 25 (+20)']);
    });
    it('a non-number that changed prints old → new; a value with no old prints alone', () => {
        const was = { Hero: { Level: 3, Exp: 10 }, Party: { Wolf: { Name: 'Wolf', Level: 'two', Exp: '' } } };
        const now = { Hero: { Level: 3, Exp: 10 }, Party: { Wolf: { Name: 'Wolf', Level: 'three', Exp: 'lots' } } };
        expect(lines(renderStatBox(RPG, was, now))).toEqual(['Wolf: Level two → three · Exp lots']);
    });
    it('a member absent from the baseline is new, with every field it has', () => {
        const after = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 10), Mana: girl('Mana', 'Friend', 20), Iori: girl('Iori', 'Stranger', 0) } });
        expect(lines(renderStatBox(SCHOOL, before, after))).toEqual(['Iori: new · Stage Stranger · Affection 0']);
    });
    it('MUTATION TARGET — no baseline at all → no box (the first message has nothing to compare against)', () => {
        expect(renderStatBox(RPG, null, { Hero: { Level: 1, Exp: 0 }, Party: {} })).toBe('');
    });
    it('tuple and plain values read the same; floats lose their residue', () => {
        const was = { Hero: { Level: [3, 'Lv'], Exp: 0.1 }, Party: {} };
        const now = { Hero: { Level: 3, Exp: 0.30000000000000004 }, Party: {} };
        expect(lines(renderStatBox(RPG, was, now))).toEqual(['Hero: Exp 0.3 (+0.2)']);
    });
    it('names: blank nameField → the key (collection) or the last path segment (record); newlines never split a line', () => {
        const section = normalize({ ...RPG_RAW, groups: [
            { path: 'World.Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }] },
            { path: 'Party', kind: 'collection', nameField: 'Name', fields: [{ path: 'Level', label: 'Level' }] },
        ] }).section;
        const was = { World: { Hero: { Level: 1 } }, Party: { wolf: { Name: '', Level: 1 }, cat: { Name: 'Tom\nCat', Level: 1 } } };
        const now = { World: { Hero: { Level: 2 } }, Party: { wolf: { Name: '', Level: 2 }, cat: { Name: 'Tom\nCat', Level: 2 } } };
        expect(lines(renderStatBox(section, was, now))).toEqual(['Hero: Level 2 (+1)', 'wolf: Level 2 (+1)', 'Tom Cat: Level 2 (+1)']);
    });
});

describe('renderStatBox — resets (resetWith + onReset)', () => {
    it('MUTATION TARGET — School stage advance with hide: the stage line, and no Affection sentinel or bogus delta', () => {
        const was = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 99) } });
        const now = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Crush', -1) } });
        expect(lines(renderStatBox(SCHOOL, was, now))).toEqual(['Mitsuki Tachibana: Stage Friend → Crush']);
    });
    it('a demote under hide prints the stage line only', () => {
        const was = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Crush', 14) } });
        const now = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 0) } });
        expect(lines(renderStatBox(SCHOOL, was, now))).toEqual(['Mitsuki Tachibana: Stage Crush → Friend']);
    });
    it('the first gain after a reset is an ordinary delta again', () => {
        const was = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Crush', -1) } });
        const now = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Crush', 2) } });
        expect(lines(renderStatBox(SCHOOL, was, now))).toEqual(['Mitsuki Tachibana: Affection 2 (+3)']);
    });
    it('MUTATION TARGET — RPG level-up with value: the value, no delta', () => {
        const was = { Hero: { Level: 4, Exp: 95 }, Party: {} };
        const now = { Hero: { Level: 5, Exp: 20 }, Party: {} };
        expect(lines(renderStatBox(RPG, was, now))).toEqual(['Hero: Level 5 (+1) · Exp 20']);
    });
    it('onReset absent behaves as hide', () => {
        const section = normalize({ ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp', label: 'Exp', resetWith: 'Level' }] }] }).section;
        expect(lines(renderStatBox(section, { Hero: { Level: 4, Exp: 95 } }, { Hero: { Level: 5, Exp: 20 } }))).toEqual(['Hero: Level 5 (+1)']);
    });
});

// A `whenSet` field is a note the card's logic writes for one reply: it prints whenever it holds a value in this
// reply's state, moved or not, and its label may be left out. The notes here are an RPG's, so no consumer's words
// are taught: mvu-helper prints the card's text and knows nothing of what it says.
describe('renderStatBox — whenSet fields (a note the card writes for one reply)', () => {
    const NOTED_RAW = { ...RPG_RAW, groups: [{ path: 'Party', kind: 'collection', nameField: 'Name', fields: [
        { path: 'HP', label: 'HP' },
        { path: 'Note', show: 'whenSet' },
    ] }] };
    const NOTED = normalize(NOTED_RAW).section;
    const member = (hp, note) => ({ Party: { ayla: { Name: ['Ayla', ''], HP: [hp, ''], Note: [note, ''] } } });

    it("MUTATION TARGET — a note equal to the baseline's still prints: the card set it for this reply", () => {
        expect(lines(renderStatBox(NOTED, member(40, 'Heal +0 (out of potions)'), member(40, 'Heal +0 (out of potions)'))))
            .toEqual(['Ayla: Heal +0 (out of potions)']);
    });
    it('beside a field that moved, both print, in declared order', () => {
        expect(lines(renderStatBox(NOTED, member(40, ''), member(42, 'Heal +2 (out of potions)'))))
            .toEqual(['Ayla: HP 42 (+2) · Heal +2 (out of potions)']);
    });
    it('MUTATION TARGET — an empty note prints nothing, even when the baseline held one', () => {
        expect(renderStatBox(NOTED, member(40, 'Heal +0 (out of potions)'), member(40, ''))).toBe('');
    });
    it('with a label, the label leads the note; a new member carries it like any field', () => {
        const labelled = normalize({ ...NOTED_RAW, groups: [{ ...NOTED_RAW.groups[0], fields: [{ path: 'Note', label: 'Note', show: 'whenSet' }] }] }).section;
        expect(lines(renderStatBox(labelled, member(40, 'x'), member(40, 'x')))).toEqual(['Ayla: Note x']);
        expect(lines(renderStatBox(NOTED, { Party: {} }, member(40, 'Heal +0 (out of potions)'))))
            .toEqual(['Ayla: new · HP 40 · Heal +0 (out of potions)']);
    });
    it('normalize: whenSet needs no label, a moved field still does, and an unknown show is ignored and said', () => {
        expect(NOTED.groups[0].fields[1]).toEqual({ path: 'Note', label: '', resetWith: '', onReset: '', show: 'whenSet' });
        const unlabelled = normalize({ ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level' }, { path: 'Exp' }] }] });
        expect(unlabelled.section.groups[0].fields.map((f) => f.path)).toEqual(['Level']);
        expect(unlabelled.report.blocked[0].why).toMatch(/must be a non-empty string/);
        const typo = normalize({ ...RPG_RAW, groups: [{ path: 'Hero', kind: 'record', fields: [{ path: 'Level', label: 'Level', show: 'always' }] }] });
        expect(typo.section.groups[0].fields[0].show).toBe('whenMoved');
        expect(typo.report.blocked[0].path).toBe('statBox.groups[0] "Hero".fields "Level".show');
        expect(typo.report.blocked[0].why).toMatch(/"always" is not a mode/);
    });
    it('serialize round-trips a whenSet field and writes nothing for the default', () => {
        const report = newReport();
        expect(normalizeStatBoxSection(serializeStatBoxSection(NOTED), report)).toEqual(NOTED);
        expect(report).toEqual(newReport());
        expect(serializeStatBoxSection(NOTED).groups[0].fields).toEqual([{ path: 'HP', label: 'HP' }, { path: 'Note', label: '', show: 'whenSet' }]);
    });
});

// ── place / strip ──────────────────────────────────────────────────────────────
describe('placeStatBox / stripStatBox', () => {
    const box = `${OPEN}\nMitsuki Tachibana: Affection 13 (+3)\n${CLOSE}`;
    const box2 = `${OPEN}\nMitsuki Tachibana: Affection 15 (+5)\n${CLOSE}`;
    const reply = '<gametxt>\nShe smiled.\n</gametxt>\n<UpdateVariable>x</UpdateVariable>';

    it('inserts before the first declared anchor that is present', () => {
        expect(placeStatBox(reply, SCHOOL, box)).toEqual({ text: `<gametxt>\nShe smiled.\n${box}\n</gametxt>\n<UpdateVariable>x</UpdateVariable>`, hit: 'inserted' });
        const both = '<maintext>a</maintext><gametxt>b</gametxt>';
        expect(placeStatBox(both, SCHOOL, box).text).toBe(`<maintext>a${box}\n</maintext><gametxt>b</gametxt>`);
    });
    it('refreshes a box already there IN PLACE — wherever the envelope was renamed to', () => {
        const once = placeStatBox(reply, SCHOOL, box).text;
        const renamed = once.replace('<gametxt>', '<maintext>').replace('</gametxt>', '</maintext>');
        expect(placeStatBox(renamed, SCHOOL, box2)).toEqual({ text: renamed.replace(box, box2), hit: 'replaced' });
    });
    it('is idempotent: placing the same box twice changes nothing', () => {
        const once = placeStatBox(reply, SCHOOL, box).text;
        expect(placeStatBox(once, SCHOOL, box)).toEqual({ text: once, hit: 'unchanged' });
    });
    it('an empty render removes the box, newline included', () => {
        const once = placeStatBox(reply, SCHOOL, box).text;
        expect(placeStatBox(once, SCHOOL, '')).toEqual({ text: reply, hit: 'removed' });
    });
    it('extra boxes are removed, the first is refreshed', () => {
        const twice = `<gametxt>\n${box}\nprose\n${box}\n</gametxt>`;
        expect(placeStatBox(twice, SCHOOL, box2).text).toBe(`<gametxt>\n${box2}\nprose\n</gametxt>`);
    });
    it('MUTATION TARGET — inserts at the anchor\'s LAST occurrence: an earlier one is the tag quoted', () => {
        const leaked = '<think>the reply must end with </gametxt></think>\n<gametxt>\nShe smiled.\n</gametxt>';
        expect(placeStatBox(leaked, SCHOOL, box)).toEqual({
            text: `<think>the reply must end with </gametxt></think>\n<gametxt>\nShe smiled.\n${box}\n</gametxt>`,
            hit: 'inserted',
        });
    });
    it('no anchor → untouched, and said', () => {
        const cut = '<gametxt>\nShe smiled and';
        expect(placeStatBox(cut, SCHOOL, box)).toEqual({ text: cut, hit: 'no-anchor' });
    });
    it('an unclosed open is not a box', () => {
        const text = `<gametxt>${OPEN} half</gametxt>`;
        expect(placeStatBox(text, SCHOOL, box).hit).toBe('inserted');
    });
    it('MUTATION TARGET — a `$&` in a rendered name lands literally', () => {
        const odd = `${OPEN}\nA$&B$'C: Affection 1 (+1)\n${CLOSE}`;
        expect(placeStatBox(reply, SCHOOL, odd).text).toContain(`A$&B$'C: Affection 1 (+1)`);
        const once = placeStatBox(reply, SCHOOL, box).text;
        expect(placeStatBox(once, SCHOOL, odd).text).toContain(`A$&B$'C: Affection 1 (+1)`);
    });
    it('strip removes every box and keeps the prose around it', () => {
        const once = placeStatBox(reply, SCHOOL, box).text;
        expect(stripStatBox(once, SCHOOL)).toBe(reply);
        expect(stripStatBox(once, null)).toBe(once);
    });
});

// ── baseline ───────────────────────────────────────────────────────────────────
describe('statBoxBaselineIndex / messageStatData', () => {
    const withState = (isUser, swipe = 0, stat = { x: 1 }) => ({ is_user: isUser, swipe_id: swipe, variables: { [swipe]: { stat_data: stat } } });
    it('the nearest assistant message below mid that carries state — a user message is skipped even with state', () => {
        const chat = [withState(false), withState(true), withState(false)];
        expect(statBoxBaselineIndex(chat, 2)).toBe(0);
    });
    it('two replies after one user line: the reply directly below is the baseline', () => {
        const chat = [withState(false), withState(true), withState(false), withState(false)];
        expect(statBoxBaselineIndex(chat, 3)).toBe(2);
    });
    it('skips replies without state; none → -1', () => {
        expect(statBoxBaselineIndex([{ is_user: false }, withState(true), withState(false)], 2)).toBe(-1);
        expect(statBoxBaselineIndex(null, 3)).toBe(-1);
    });
    it('reads the active swipe', () => {
        const m = { is_user: false, swipe_id: 1, variables: { 0: { stat_data: { a: 0 } }, 1: { stat_data: { a: 1 } } } };
        expect(messageStatData(m)).toEqual({ a: 1 });
        expect(messageStatData({ swipe_id: 2, variables: { 0: { stat_data: {} } } })).toBe(null);
    });
});

// ── declared paths that point at nothing ──────────────────────────────────────
describe('unresolvedStatBoxPaths — a misspelled path is reported, partial data is not', () => {
    const typo = (field) => normalize({ ...SCHOOL_RAW, groups: [
        SCHOOL_RAW.groups[0],
        { ...SCHOOL_RAW.groups[1], fields: [{ path: 'RelationshipStage', label: 'Stage' }, { path: field, label: 'Affection' }] },
    ] }).section;
    const state = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 10), Mana: girl('Mana', 'Friend', 20) } });

    it('the real School config against real-shaped state reports nothing', () => {
        expect(unresolvedStatBoxPaths(SCHOOL, state)).toEqual([]);
    });
    it('MUTATION TARGET — a field in NONE of the members is reported, with its group path', () => {
        const found = unresolvedStatBoxPaths(typo('Afection'), state);
        expect(found.map((f) => f.path)).toEqual(['Classmate.Afection']);
        expect(found[0].why).toMatch(/not in any of the 2 member\(s\) of "Classmate", so "Affection" never prints/);
    });
    it('a field missing on SOME members is data, not a typo', () => {
        const partial = schoolState({ girls: { Mitsuki: girl('Mitsuki Tachibana', 'Friend', 10), Mana: { Name: ['Mana', ''], RelationshipStage: ['Friend', ''] } } });
        expect(unresolvedStatBoxPaths(SCHOOL, partial)).toEqual([]);
    });
    it('an empty collection proves nothing', () => {
        expect(unresolvedStatBoxPaths(typo('Afection'), schoolState({ girls: {} }))).toEqual([]);
    });
    it('a record field, a group path and a nameField are checked too', () => {
        const section = normalize({ ...RPG_RAW, groups: [
            { path: 'Hero', kind: 'record', nameField: 'Nmae', fields: [{ path: 'Lvl', label: 'Level' }] },
            { path: 'Pary', kind: 'collection', fields: [{ path: 'Level', label: 'Level' }] },
        ] }).section;
        expect(unresolvedStatBoxPaths(section, { Hero: { Name: 'Aki', Level: 3 }, Party: {} }).map((f) => f.path))
            .toEqual(['Hero.Lvl', 'Hero.Nmae', 'Pary']);
    });
});

// ── which of MVU's parses build the box ───────────────────────────────────────
describe('isStatBoxParseWriter / shouldBuildStatBoxOnParse', () => {
    it('MUTATION TARGET — a reply\'s own parse and POST\'s record build it; a writer parsing its own patch does not', () => {
        expect(isStatBoxParseWriter(WRITER_MESSAGE)).toBe(true);
        expect(isStatBoxParseWriter(WRITER_POST)).toBe(true);
        for (const writer of ['pre-sim', 'plugin:probe', 'statusmenu:menu', 'host', '', undefined]) {
            expect(isStatBoxParseWriter(writer)).toBe(false);
        }
    });
    it('MUTATION TARGET — only a parse of the live chat builds it: MVU\'s floor replay does not', () => {
        expect(shouldBuildStatBoxOnParse({ writer: WRITER_MESSAGE, disposition: 'turn', mid: 12 })).toBe(true);
        expect(shouldBuildStatBoxOnParse({ writer: WRITER_MESSAGE, disposition: 'foreign', mid: 12 })).toBe(false);
    });
    it('MUTATION TARGET — no reply to put it in, no box', () => {
        expect(shouldBuildStatBoxOnParse({ writer: WRITER_POST, disposition: 'turn', mid: -1 })).toBe(false);
        expect(shouldBuildStatBoxOnParse({ writer: WRITER_POST, disposition: 'turn', mid: 0 })).toBe(true);
    });
    it('the writer rule holds inside the full decision too', () => {
        expect(shouldBuildStatBoxOnParse({ writer: 'pre-sim', disposition: 'turn', mid: 3 })).toBe(false);
    });
});

// The listener lives in the host-coupled statbox.js, so its load-bearing lines are gated as SOURCE.
describe('SOURCE GATE — the box is built on MVU\'s parse by the statbox itself', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/statbox/statbox.js'), 'utf8');
    const fn = src.slice(src.indexOf('function buildBoxOnParse'), src.indexOf('if (eventSource && event_types)'));

    it('MUTATION TARGET — it listens to MVU\'s update event', () => {
        expect(src).toMatch(/eventSource\.on\(MVU_VARIABLE_UPDATE_ENDED, \(mvuData, variablesBefore\) =>/);
    });
    it('MUTATION TARGET — it decides with the parse\'s own start state, and builds only when told to', () => {
        expect(fn).toMatch(/endedEventDisposition\(variablesBefore && variablesBefore\.stat_data, chat\)/);
        expect(fn).toMatch(/if \(!shouldBuildStatBoxOnParse\(\{ writer, disposition, mid \}\)\) return;/);
    });
    it('the writer label is read before anything that could wait', () => {
        expect(fn.indexOf('currentWriter()')).toBeGreaterThan(-1);
        expect(fn.indexOf('currentWriter()')).toBeLessThan(fn.indexOf('endedEventDisposition('));
        expect(fn).not.toMatch(/\bawait\b/);
    });
    it('MUTATION TARGET — the edit goes to the reply redraw, never written here', () => {
        expect(fn).toMatch(/redrawReply\(message, mid, 'stat box'\)/);
        expect(src).not.toMatch(/commitReplyTextEdit|saveChat\(/);
    });
});

describe('shouldAwaitBoxAtArrival / isAwaitedBoxRendered — the box at MVU\'s parse joins the turn\'s one write', () => {
    const reply = { is_user: false, mes: 'reply' };
    it('MUTATION TARGET — a card that declares a box announces it for an arriving reply', () => {
        expect(shouldAwaitBoxAtArrival({ isDeclared: true, message: reply })).toBe(true);
    });
    it('MUTATION TARGET — a card that declares no box announces nothing', () => {
        expect(shouldAwaitBoxAtArrival({ isDeclared: false, message: reply })).toBe(false);
    });
    it('MUTATION TARGET — a user message or a missing one is never awaited', () => {
        expect(shouldAwaitBoxAtArrival({ isDeclared: true, message: { is_user: true, mes: 'line' } })).toBe(false);
        expect(shouldAwaitBoxAtArrival({ isDeclared: true, message: null })).toBe(false);
    });
    it('MUTATION TARGET — the render of the announced reply settles it, whatever type its id arrives as', () => {
        expect(isAwaitedBoxRendered({ mid: 7 }, 7)).toBe(true);
        expect(isAwaitedBoxRendered({ mid: 7 }, '7')).toBe(true);
    });
    it('MUTATION TARGET — another reply\'s render, or no announcement, settles nothing', () => {
        expect(isAwaitedBoxRendered({ mid: 7 }, 6)).toBe(false);
        expect(isAwaitedBoxRendered(null, 7)).toBe(false);
    });
});

// The arrival's listeners live in the host-coupled statbox.js, so their load-bearing lines are gated as SOURCE.
describe('SOURCE GATE — the box is announced when its reply arrives, settled when the reply is rendered', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/statbox/statbox.js'), 'utf8').replace(/\r/g, '');
    const arrival = src.slice(src.indexOf('function announceBoxAtArrival'), src.indexOf('function settleAwaitedBox'));
    const smallLlm = readFileSync(path.join(process.cwd(), 'src/features/small-llm/extra-llm-calls.js'), 'utf8').replace(/\r/g, '');

    it('MUTATION TARGET — it announces on MESSAGE_RECEIVED and settles on the reply\'s CHARACTER_MESSAGE_RENDERED', () => {
        expect(src).toMatch(/eventSource\.on\(event_types\.MESSAGE_RECEIVED, \(messageId\) => \{\n\s*try \{ announceBoxAtArrival\(messageId\); \}/);
        expect(src).toMatch(/eventSource\.on\(event_types\.CHARACTER_MESSAGE_RENDERED, \(messageId\) => \{\n\s*if \(isAwaitedBoxRendered\(awaitedBox, messageId\)\) settleAwaitedBox\(\);/);
    });
    it('MUTATION TARGET — the announcement goes to the reply redraw with the work the render settles', () => {
        expect(arrival).toMatch(/if \(!shouldAwaitBoxAtArrival\(\{ isDeclared: isStatBoxDeclared\(\), message \}\)\) return;/);
        expect(arrival).toMatch(/announceReplyEdit\(message, mid, \{ label: 'stat box \(MVU parse\)', work: rendered, allowanceMs: BOX_AT_PARSE_WAIT_MS \}\)/);
        expect(arrival).toMatch(/awaitedBox = \{ mid, settle \};/);
    });
    it('the announcement is made before anything that could wait: the turn can end at any await', () => {
        expect(arrival.length).toBeGreaterThan(0);
        expect(arrival).not.toMatch(/\bawait\b/);
    });
    it('MUTATION TARGET — a chat change ends the wait, and so does a newer reply\'s arrival', () => {
        expect(src).toMatch(/CHAT_CHANGED, \(\) => \{ warnedPaths\.clear\(\); settleAwaitedBox\(\); \}/);
        expect(arrival).toMatch(/^function announceBoxAtArrival\(messageId\) \{\n\s*settleAwaitedBox\(\);/);
    });
    it('MUTATION TARGET — small-llm imports the statbox, so the arrival listener is added before the POST pass\'s', () => {
        expect(smallLlm).toMatch(/^import \{[^}]*\} from '\.\.\/statbox\/index\.js';$/m);
        expect(src).not.toMatch(/from '\.\.\/small-llm\//);
    });
});
