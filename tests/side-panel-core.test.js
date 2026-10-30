// side-panel-core — the side panel's render decisions (devdoc/side-panel-format.md). Source gates cover the
// host-side triggers a unit test cannot open.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    parsePanelDeclaration, orderSlots, resolveStatePath, parsePathSpec, resolvePanelPath,
    displayValue, renderSlotModel, normalizeRenderedPanel, PANEL_CAPS,
    pickRowColor, isPanelColor, resolveCellStyles, ROW_CELLS, GROUP_CELLS,
    FIELDS_BLOCK_CELLS, COLLECTION_BLOCK_CELLS,
    isOwnScopeEmpty, emptyOwnScopeWarning,
} from '../src/features/side-panel/side-panel-core.js';

describe('parsePanelDeclaration', () => {
    it('accepts slot-list, errors broken JSON, skips a future kind by name', () => {
        expect(parsePanelDeclaration('{"kind":"slot-list","tabs":[]}').declaration.kind).toBe('slot-list');
        expect(parsePanelDeclaration('{oops').error).toMatch(/does not parse/);
        expect(parsePanelDeclaration('"a string"').error).toMatch(/not a JSON object/);
        expect(parsePanelDeclaration('{"kind":"holo-deck"}').skippedKind).toBe('holo-deck');
        expect(parsePanelDeclaration('{}').skippedKind).toBe('(none)');
    });
});

describe('orderSlots (D6)', () => {
    // MUTATION TARGET — configured order FIRST, registry order for the rest; a stale configured id
    // must not conjure a slot. Reverse the halves and the first test fails; skip the presence check
    // and the stale-id test fails.
    it('configured ids lead, in their own order; the rest follow in registry order', () => {
        expect(orderSlots(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
    });
    it('a configured id that is not installed is ignored', () => {
        expect(orderSlots(['a', 'b'], ['ghost', 'b'])).toEqual(['b', 'a']);
    });
    it('empty setting = registry order; duplicates collapse', () => {
        expect(orderSlots(['a', 'b'], [])).toEqual(['a', 'b']);
        expect(orderSlots(['a', 'b'], ['b', 'b'])).toEqual(['b', 'a']);
    });
});

describe('resolveStatePath (D5) + tuple unwrap', () => {
    const scope = { Turn: 3, Characters: { 美月: { Outfit: 'vest' } }, Money: [5000, 'Money'] };
    it('empty path is the scope itself; dotted paths walk; absent is found:false', () => {
        expect(resolveStatePath(scope, '').value).toBe(scope);
        expect(resolveStatePath(scope, 'Characters.美月.Outfit')).toEqual({ found: true, value: 'vest' });
        expect(resolveStatePath(scope, 'Nope.deeper').found).toBe(false);
        expect(resolveStatePath(null, 'x').found).toBe(false);
    });
    it('displayValue: tuples show the value, objects summarise, long strings cap', () => {
        expect(displayValue([5000, 'Money'])).toBe('5000');
        expect(displayValue({ a: 1, b: 2 })).toBe('{2 keys}');
        expect(displayValue(null)).toBe('');
        expect(displayValue('x'.repeat(500)).length).toBe(PANEL_CAPS.valueChars);
    });
});

describe('renderSlotModel', () => {
    const scope = {
        RelayTurn: 2, Money: [5000, 'Money'],
        Characters: { 美月: { Outfit: 'vest', At: '2:0' }, Mana: { Outfit: 'coat', At: '2:0' } },
    };
    const decl = {
        kind: 'slot-list', title: 'Probe', tabs: [
            { id: 't1', name: 'Lane', blocks: [{ type: 'fields', fields: [{ label: 'Turn', path: 'RelayTurn' }, { label: 'Gone', path: 'Nope' }] }] },
            { id: 't2', name: 'Wardrobe', blocks: [{ type: 'collection', path: 'Characters', fields: [{ label: 'Outfit', path: 'Outfit' }] }] },
        ],
    };
    it('binds fields and collections; the unresolved path renders empty with ONE warning', () => {
        const m = renderSlotModel(decl, scope);
        expect(m.title).toBe('Probe');
        expect(m.tabs[0].blocks[0].rows).toEqual([
            { label: 'Turn', value: '2', missing: false, style: {} },
            { label: 'Gone', value: '', missing: true, style: {} },
        ]);
        expect(m.tabs[1].blocks[0].groups.map((g) => g.key)).toEqual(['美月', 'Mana']);
        expect(m.tabs[1].blocks[0].groups[0].rows[0]).toEqual({ label: 'Outfit', value: 'vest', missing: false, style: {} });
        expect(m.warnings).toEqual(['tab "Lane": path "Nope" resolved to nothing']);
    });
    it('a collection at a missing or non-object path renders empty, never refuses the slot', () => {
        const m = renderSlotModel({ tabs: [{ id: 'x', name: 'X', blocks: [{ type: 'collection', path: 'Ghost', fields: [] }] }] }, scope);
        expect(m.tabs[0].blocks[0]).toEqual({ type: 'collection', heading: '', style: {}, groups: [], missing: true });
        expect(m.warnings.length).toBe(1);
    });
    it('unknown block types are skipped without a warning (a later format may add them)', () => {
        const m = renderSlotModel({ tabs: [{ id: 'x', name: 'X', blocks: [{ type: 'sparkline' }] }] }, scope);
        expect(m.tabs[0].blocks).toEqual([]);
        expect(m.warnings).toEqual([]);
    });
});

describe('parsePathSpec + resolvePanelPath (the two escapes out of own scope)', () => {
    const snapshot = { World: { Time: ['07:30', 'Time'] }, Classmate: { Mitsuki: { Hobbies: { Baking: { Desc: 'sweets' } } } } };
    const exposes = { 'cast@1': 'Classmate' };
    const own = { RelayTurn: 4, World: { Time: 'not this one' } };

    // MUTATION TARGET — the FORM picks the root. Resolve a bare path against the snapshot and the
    // first assertion fails; resolve an escape against own scope and the other two do.
    it('a bare path stays relative to the row root; $ and {token} do not', () => {
        expect(parsePathSpec('World.Time')).toEqual({ kind: 'own', path: 'World.Time' });
        expect(parsePathSpec('$.World.Time')).toEqual({ kind: 'root', path: 'World.Time' });
        expect(parsePathSpec('$')).toEqual({ kind: 'root', path: '' });
        expect(parsePathSpec('{cast@1}.Mitsuki')).toEqual({ kind: 'token', token: 'cast@1', path: 'Mitsuki' });
        expect(parsePathSpec('{cast@1}')).toEqual({ kind: 'token', token: 'cast@1', path: '' });
    });
    it('resolves each form against its own root', () => {
        expect(resolvePanelPath('RelayTurn', own, { snapshot, exposes }).value).toBe(4);
        expect(resolvePanelPath('World.Time', own, { snapshot, exposes }).value).toBe('not this one');
        expect(resolvePanelPath('$.World.Time', own, { snapshot, exposes }).value).toEqual(['07:30', 'Time']);
        expect(resolvePanelPath('{cast@1}.Mitsuki.Hobbies.Baking.Desc', own, { snapshot, exposes }).value).toBe('sweets');
    });
    it('an unexposed token is a DISTINCT miss from a dead path', () => {
        const miss = resolvePanelPath('{cast@9}.Mitsuki', own, { snapshot, exposes });
        expect(miss).toEqual({ found: false, value: undefined, unresolvedToken: 'cast@9' });
        expect(resolvePanelPath('$.World.Hello', own, { snapshot, exposes }).unresolvedToken).toBeUndefined();
        expect(resolvePanelPath('$.World.Hello', own, { snapshot, exposes }).found).toBe(false);
    });
    it('with no context an escape resolves to nothing instead of throwing', () => {
        expect(resolvePanelPath('$.World.Time', own).found).toBe(false);
        expect(resolvePanelPath('{cast@1}', own).unresolvedToken).toBe('cast@1');
    });
});

describe('escapes inside a rendered slot', () => {
    const snapshot = {
        World: { Time: ['07:30', 'Time'], Hello: undefined },
        Classmate: { Mitsuki: { Hobbies: { Baking: { Desc: 'sweets' }, Karaoke: { Desc: 'sings' } } } },
        GameLogicPlugin: { Probe: { RelayTurn: 2 } },
    };
    const context = { snapshot, exposes: { 'cast@1': 'Classmate' } };
    const ownState = snapshot.GameLogicPlugin.Probe;

    it('a field reads through both escapes; a collection loops an exposed map', () => {
        const m = renderSlotModel({
            tabs: [{ id: 'w', name: 'World', blocks: [
                { type: 'fields', fields: [
                    { label: 'Turn', path: 'RelayTurn' },
                    { label: 'Time', path: '$.World.Time' },
                ] },
                { type: 'collection', path: '{cast@1}.Mitsuki.Hobbies', fields: [{ label: 'Desc', path: 'Desc' }] },
            ] }],
        }, ownState, context);
        expect(m.tabs[0].blocks[0].rows).toEqual([
            { label: 'Turn', value: '2', missing: false, style: {} },
            { label: 'Time', value: '07:30', missing: false, style: {} },
        ]);
        expect(m.tabs[0].blocks[1].groups).toEqual([
            { key: 'Baking', style: {}, rows: [{ label: 'Desc', value: 'sweets', missing: false, style: {} }], blocks: [] },
            { key: 'Karaoke', style: {}, rows: [{ label: 'Desc', value: 'sings', missing: false, style: {} }], blocks: [] },
        ]);
        expect(m.warnings).toEqual([]);
    });
    it('an escape inside a collection child ignores the child root', () => {
        const m = renderSlotModel({
            tabs: [{ id: 'w', name: 'W', blocks: [
                { type: 'collection', path: '{cast@1}.Mitsuki.Hobbies', fields: [
                    { label: 'Desc', path: 'Desc' },
                    { label: 'Time', path: '$.World.Time' },
                ] },
            ] }],
        }, ownState, context);
        expect(m.tabs[0].blocks[0].groups[0].rows[1]).toEqual({ label: 'Time', value: '07:30', missing: false, style: {} });
    });
    it('the warning names the TOKEN when the pack exposes no such interface', () => {
        const m = renderSlotModel({
            tabs: [{ id: 'w', name: 'W', blocks: [
                { type: 'fields', fields: [{ label: 'Gone', path: '$.World.Hello' }] },
                { type: 'collection', path: '{cast@9}.X', fields: [] },
            ] }],
        }, ownState, context);
        expect(m.tabs[0].blocks[0].rows[0].missing).toBe(true);
        expect(m.warnings).toEqual([
            'tab "W": path "$.World.Hello" resolved to nothing',
            'tab "W" collection: token "{cast@9}" is not exposed by the active pack — nothing to read',
        ]);
    });
});

describe('pickRowColor — hex colours and their value rules', () => {
    // MUTATION TARGET — first match wins, every condition in a rule ANDs, and a rule with NO
    // condition is the default arm. Reverse the scan and the threshold test paints green at 10;
    // treat a conditionless rule as no-match and the fallback tests lose their colour.
    const ENERGY = [{ lt: 20, use: '#dd6a6a' }, { lt: 50, use: '#d3a03c' }, { use: '#5cb37a' }];
    it('numeric thresholds pick the FIRST matching arm', () => {
        expect(pickRowColor(ENERGY, 10)).toBe('#dd6a6a');
        expect(pickRowColor(ENERGY, 35)).toBe('#d3a03c');
        expect(pickRowColor(ENERGY, 90)).toBe('#5cb37a');
    });
    it('a numeric test never matches a non-numeric value — an empty stat is not a zero', () => {
        expect(pickRowColor([{ lt: 20, use: '#f00' }], 'unknown')).toBe('');
        expect(pickRowColor([{ gte: 0, use: '#0f0' }], 'n/a')).toBe('');
        // Number('') / Number(null) / Number(false) are all 0 — the trap this guard exists for.
        expect(pickRowColor([{ lt: 20, use: '#f00' }], '')).toBe('');
        expect(pickRowColor([{ lt: 20, use: '#f00' }], null)).toBe('');
        expect(pickRowColor([{ lt: 20, use: '#f00' }], false)).toBe('');
        expect(pickRowColor([{ lt: 20, use: '#f00' }], [])).toBe('');
        // a numeric STRING still works — MVU stores plenty of numbers that way
        expect(pickRowColor([{ lt: 20, use: '#f00' }], '12')).toBe('#f00');
    });
    it('eq / has / is, and tuples judged by their VALUE', () => {
        expect(pickRowColor([{ eq: 'Lover', use: '#e08ac0' }], 'Lover')).toBe('#e08ac0');
        expect(pickRowColor([{ eq: 'Lover', use: '#e08ac0' }], 'Friend')).toBe('');
        expect(pickRowColor([{ has: 'rain', use: '#d3a03c' }], 'Light Rain')).toBe('#d3a03c');
        expect(pickRowColor([{ is: true, use: '#d3a03c' }, { use: '#888' }], false)).toBe('#888');
        expect(pickRowColor(ENERGY, [12, 'Energy'])).toBe('#dd6a6a');
    });
    it('conditions within ONE rule all have to hold', () => {
        const band = [{ gte: 10, lt: 20, use: '#d3a03c' }];
        expect(pickRowColor(band, 15)).toBe('#d3a03c');
        expect(pickRowColor(band, 25)).toBe('');
        expect(pickRowColor(band, 5)).toBe('');
    });

    // MUTATION TARGET — ONLY a hex literal reaches a style property. Accept the string unchecked and
    // every case below passes something that is not a colour into the DOM.
    it('accepts every hex length and REFUSES anything else, saying so', () => {
        expect(isPanelColor('#abc')).toBe(true);
        expect(isPanelColor('#abcd')).toBe(true);
        expect(isPanelColor('#aabbcc')).toBe(true);
        expect(isPanelColor('#aabbccdd')).toBe(true);
        expect(isPanelColor('red')).toBe(false);
        expect(isPanelColor('rgb(1,2,3)')).toBe(false);
        expect(isPanelColor('#12345')).toBe(false);
        expect(isPanelColor('#abc; position:fixed')).toBe(false);
        expect(isPanelColor('var(--SmartThemeQuoteColor)')).toBe(false);
        expect(pickRowColor('  #A1B2C3  ', 'x')).toBe('#A1B2C3');
        const said = [];
        expect(pickRowColor('tomato', 'x', (m) => said.push(m))).toBe('');
        expect(said[0]).toMatch(/is not a hex colour/);
        // an OBJECT is the gradient form, so for TEXT it is refused as one
        const said2 = [];
        expect(pickRowColor({ nope: 1 }, 'x', (m) => said2.push(m))).toBe('');
        expect(said2[0]).toMatch(/only valid for "background"/);
    });
    it('no declaration is no colour', () => {
        expect(pickRowColor(undefined, 5)).toBe('');
        expect(pickRowColor(null, 5)).toBe('');
        expect(pickRowColor('', 5)).toBe('');
    });
});

describe('cell styling — one grammar, any cell', () => {
    // MUTATION TARGET — the CELL is named, and a name outside this site's list is reported rather
    // than painted. Accept any key and the unknown-cell test stops warning; paint the value cell
    // regardless of the name and the label test paints the wrong node.
    it('each named cell gets its own paint, judged against the same value', () => {
        const m = renderSlotModel({
            tabs: [{ id: 't', name: 'T', blocks: [{ type: 'fields', fields: [
                { label: 'Energy', path: 'Energy', style: {
                    label: { color: '#888888' },
                    value: { color: [{ lt: 20, use: '#dd6a6a' }, { use: '#5cb37a' }], background: '#2a1414' },
                    row: { background: [{ lt: 20, use: '#180000' }] },
                } },
            ] }] }],
        }, { Energy: 12 });
        expect(m.tabs[0].blocks[0].rows[0]).toEqual({
            label: 'Energy', value: '12', missing: false,
            style: {
                label: { color: '#888888', background: '' },
                value: { color: '#dd6a6a', background: '#2a1414' },
                row: { color: '', background: '#180000' },
            },
        });
    });
    it('a cell that declared nothing is ABSENT, never an empty paint', () => {
        const m = renderSlotModel({
            tabs: [{ id: 't', name: 'T', blocks: [{ type: 'fields', fields: [
                { label: 'E', path: 'Energy', style: { label: { color: '#fff' }, value: {} } },
            ] }] }],
        }, { Energy: 90 });
        expect(Object.keys(m.tabs[0].blocks[0].rows[0].style)).toEqual(['label']);
    });
    it('a MISSING row is never painted, static colours included', () => {
        const m = renderSlotModel({
            tabs: [{ id: 't', name: 'T', blocks: [{ type: 'fields', fields: [
                { label: 'Gone', path: 'Nope', style: { label: { color: '#fff' }, value: { background: '#f00' } } },
            ] }] }],
        }, { Energy: 1 });
        expect(m.tabs[0].blocks[0].rows[0].style).toEqual({});
    });
    it('a collection heading paints from the BLOCK, judged against the key', () => {
        const m = renderSlotModel({
            tabs: [{ id: 't', name: 'T', blocks: [{
                type: 'collection', path: 'Cast',
                style: { groupKey: { color: [{ eq: 'Mitsuki', use: '#e08ac0' }, { use: '#888888' }] } },
                fields: [{ label: 'Outfit', path: 'Outfit' }],
            }] }],
        }, { Cast: { Mitsuki: { Outfit: 'vest' }, Mana: { Outfit: 'coat' } } });
        const groups = m.tabs[0].blocks[0].groups;
        expect(groups[0].style).toEqual({ groupKey: { color: '#e08ac0', background: '' } });
        expect(groups[1].style).toEqual({ groupKey: { color: '#888888', background: '' } });
    });
    it('an unknown cell name is REPORTED, and each site names what it can paint', () => {
        const m = renderSlotModel({
            tabs: [{ id: 't', name: 'T', blocks: [{ type: 'fields', fields: [
                { label: 'E', path: 'Energy', style: { groupKey: { color: '#fff' } } },
            ] }] }],
        }, { Energy: 1 });
        expect(m.warnings[0]).toContain('unknown cell "groupKey"');
        expect(m.warnings[0]).toContain('label, value, row');
        expect(ROW_CELLS).toEqual(['label', 'value', 'row']);
        expect(GROUP_CELLS).toEqual(['groupKey']);
    });
    it('a style that is not an object, and a cell that is not an object, both report', () => {
        const said = [];
        expect(resolveCellStyles('#fff', 1, ROW_CELLS, (m) => said.push(m))).toEqual({});
        expect(said[0]).toMatch(/must be an object naming cells/);
        const said2 = [];
        expect(resolveCellStyles({ value: '#fff' }, 1, ROW_CELLS, (m) => said2.push(m))).toEqual({});
        expect(said2[0]).toMatch(/object with "color"/);
    });
    it('the hook names cells too, and only hex gets through', () => {
        const out = normalizeRenderedPanel({ tabs: [{ id: 'a', name: 'A', blocks: [
            { type: 'fields', rows: [
                { label: 'O', value: 1, style: { label: { color: '#5cb37a' }, value: { background: 'url(x)' } } },
            ] },
        ] }] });
        expect(out.tabs[0].blocks[0].rows[0].style).toEqual({ label: { color: '#5cb37a', background: '' } });
    });
});

describe('nested collections — a level per collection, paths relative to its own child', () => {
    const scope = { Cast: {
        Mitsuki: { Outfit: 'vest', Belongings: { CookieTin: { Type: 'Personal Item', Qty: 1 }, Bracelet: { Type: 'Accessory', Qty: 2 } } },
        Mana: { Outfit: 'coat', Belongings: { Coat: { Type: 'Clothing', Qty: 1 } } },
    } };
    const decl = { tabs: [{ id: 'b', name: 'B', blocks: [{
        type: 'collection', path: 'Cast',
        style: { groupKey: { color: '#e08ac0' } },
        fields: [{ label: 'Outfit', path: 'Outfit' }],
        blocks: [{
            type: 'collection', path: 'Belongings',
            style: { groupKey: { color: '#9ecbff' } },
            fields: [{ label: 'Type', path: 'Type' }, { label: 'Qty', path: 'Qty' }],
        }],
    }] }] };

    // MUTATION TARGET — the nested level reads the GROUP'S child, not the outer node. Pass the outer
    // node down and every inner group disappears (Cast has no Belongings of its own).
    it('every group gets its own nested level, read from that group', () => {
        const m = renderSlotModel(decl, scope);
        const outer = m.tabs[0].blocks[0].groups;
        expect(outer.map((g) => g.key)).toEqual(['Mitsuki', 'Mana']);
        expect(outer[0].rows).toEqual([{ label: 'Outfit', value: 'vest', missing: false, style: {} }]);
        expect(outer[0].blocks[0].groups.map((g) => g.key)).toEqual(['CookieTin', 'Bracelet']);
        expect(outer[0].blocks[0].groups[1].rows).toEqual([
            { label: 'Type', value: 'Accessory', missing: false, style: {} },
            { label: 'Qty', value: '2', missing: false, style: {} },
        ]);
        expect(outer[1].blocks[0].groups.map((g) => g.key)).toEqual(['Coat']);
        expect(m.warnings).toEqual([]);
    });
    it('each level paints its own heading', () => {
        const m = renderSlotModel(decl, scope);
        const outer = m.tabs[0].blocks[0].groups[0];
        expect(outer.style).toEqual({ groupKey: { color: '#e08ac0', background: '' } });
        expect(outer.blocks[0].groups[0].style).toEqual({ groupKey: { color: '#9ecbff', background: '' } });
    });
    it('an escape stays absolute at any depth', () => {
        const m = renderSlotModel({ tabs: [{ id: 'b', name: 'B', blocks: [{
            type: 'collection', path: 'Cast',
            blocks: [{ type: 'collection', path: 'Belongings', fields: [{ label: 'Time', path: '$.World.Time' }] }],
        }] }] }, scope, { snapshot: { World: { Time: '07:30' } }, exposes: {} });
        expect(m.tabs[0].blocks[0].groups[0].blocks[0].groups[0].rows[0].value).toBe('07:30');
    });
    it('a collection with no nested blocks carries an EMPTY list, not undefined', () => {
        const m = renderSlotModel({ tabs: [{ id: 'b', name: 'B', blocks: [
            { type: 'collection', path: 'Cast', fields: [] },
        ] }] }, scope);
        expect(m.tabs[0].blocks[0].groups[0].blocks).toEqual([]);
    });

    // MUTATION TARGET — the depth cap is a real stop, warned ONCE per block rather than once per key.
    it('nesting past the cap is refused, said once, and the levels above still render', () => {
        const deep = { L1a: { inner: { L2a: { inner: { L3a: { inner: { L4a: { leaf: 1 } } } } } } } };
        const nest = (rest) => [{ type: 'collection', path: 'inner', blocks: rest, fields: [] }];
        const m = renderSlotModel({ tabs: [{ id: 'd', name: 'D', blocks: [{
            type: 'collection', path: '', fields: [],
            blocks: nest(nest(nest([]))),
        }] }] }, deep);
        const l1 = m.tabs[0].blocks[0].groups[0];
        const l2 = l1.blocks[0].groups[0];
        const l3 = l2.blocks[0].groups[0];
        expect([l1.key, l2.key, l3.key]).toEqual(['L1a', 'L2a', 'L3a']);
        expect(l3.blocks).toEqual([]);
        expect(m.warnings).toEqual(['tab "D" · L1a · L2a: nested blocks below depth 3 are not rendered']);
    });
    it('the caps table names the depth', () => {
        expect(PANEL_CAPS.depth).toBe(3);
    });
});

describe('block headings and gradients', () => {
    // MUTATION TARGET — the three paint forms are told apart by SHAPE: string = hex, array = rules,
    // object = gradient. Treat the object as a rule list and the gradient tests all lose their paint.
    it('a gradient is an OBJECT, so it can never collide with the rule list', () => {
        expect(pickRowColor({ stops: ['#2a1a4a', '#1a2a4a'] }, null, () => {}, true))
            .toBe('linear-gradient(90deg, #2a1a4a, #1a2a4a)');
        expect(pickRowColor({ stops: ['#a00', '#0a0', '#00a'], angle: 135 }, null, () => {}, true))
            .toBe('linear-gradient(135deg, #a00, #0a0, #00a)');
        // as a rule's `use`, through the same validator
        expect(pickRowColor([{ gt: 5, use: { stops: ['#111', '#222'] } }], 9, () => {}, true))
            .toBe('linear-gradient(90deg, #111, #222)');
    });
    it('every stop is hex-checked and the angle is a number, so the CSS is BUILT not copied', () => {
        const said = [];
        expect(pickRowColor({ stops: ['#fff', 'red'] }, null, (m) => said.push(m), true)).toBe('');
        expect(said[0]).toMatch(/gradient stop "red" is not a hex colour/);
        const said2 = [];
        expect(pickRowColor({ stops: ['#fff'] }, null, (m) => said2.push(m), true)).toBe('');
        expect(said2[0]).toMatch(/2 to 6 stops, not 1/);
        const said3 = [];
        expect(pickRowColor({ angle: 90 }, null, (m) => said3.push(m), true)).toBe('');
        expect(said3[0]).toMatch(/needs "stops"/);
        // a non-numeric angle falls back to 90 rather than reaching the style property
        expect(pickRowColor({ stops: ['#111', '#222'], angle: 'evil; }' }, null, () => {}, true))
            .toBe('linear-gradient(90deg, #111, #222)');
    });
    it('a gradient is refused for TEXT, and said so', () => {
        const said = [];
        expect(pickRowColor({ stops: ['#111', '#222'] }, null, (m) => said.push(m), false)).toBe('');
        expect(said[0]).toMatch(/only valid for "background"/);
    });

    // MUTATION TARGET — a block's title is its own cell, and a collection's groupKey is judged against
    // the KEY while its title is judged against the TITLE. Feed the title to groupKey and the
    // per-group rule stops firing.
    it('a fields block may carry a heading and paint it', () => {
        const m = renderSlotModel({ tabs: [{ id: 't', name: 'T', blocks: [{
            type: 'fields', heading: 'NPC AGENDAS',
            style: { heading: { color: '#dfe7ff', background: { stops: ['#2a1a4a', '#1a2a4a'], angle: 100 } } },
            fields: [{ label: 'Turn', path: 'Turn' }],
        }] }] }, { Turn: 4 });
        const block = m.tabs[0].blocks[0];
        expect(block.heading).toBe('NPC AGENDAS');
        expect(block.style).toEqual({ heading: { color: '#dfe7ff', background: 'linear-gradient(100deg, #2a1a4a, #1a2a4a)' } });
        expect(block.rows[0].value).toBe('4');
    });
    it('a collection carries the heading, each group carries only its own groupKey', () => {
        const m = renderSlotModel({ tabs: [{ id: 't', name: 'T', blocks: [{
            type: 'collection', path: 'Cast', heading: 'FACTIONS',
            style: {
                heading: { background: { stops: ['#123', '#456'] } },
                groupKey: { color: [{ eq: 'Mitsuki', use: '#e08ac0' }, { use: '#888888' }] },
            },
            fields: [],
        }] }] }, { Cast: { Mitsuki: {}, Mana: {} } });
        const block = m.tabs[0].blocks[0];
        expect(block.heading).toBe('FACTIONS');
        expect(block.style).toEqual({ heading: { color: '', background: 'linear-gradient(90deg, #123, #456)' } });
        expect(block.groups[0].style).toEqual({ groupKey: { color: '#e08ac0', background: '' } });
        expect(block.groups[1].style).toEqual({ groupKey: { color: '#888888', background: '' } });
    });
    it('a block with no heading carries an empty one and an empty style', () => {
        const m = renderSlotModel({ tabs: [{ id: 't', name: 'T', blocks: [{ type: 'fields', fields: [] }] }] }, {});
        expect(m.tabs[0].blocks[0].heading).toBe('');
        expect(m.tabs[0].blocks[0].style).toEqual({});
    });
    it('each block site names the cells it can paint', () => {
        expect(FIELDS_BLOCK_CELLS).toEqual(['heading']);
        expect(COLLECTION_BLOCK_CELLS).toEqual(['heading', 'groupKey']);
        const m = renderSlotModel({ tabs: [{ id: 't', name: 'T', blocks: [
            { type: 'fields', heading: 'X', style: { groupKey: { color: '#fff' } }, fields: [] },
        ] }] }, {});
        expect(m.warnings[0]).toContain('unknown cell "groupKey"');
        expect(m.warnings[0]).toContain('"X"');
    });
});

describe('normalizeRenderedPanel (the pinned renderPanel hook contract)', () => {
    // MUTATION TARGET — the hook returns VALUES, and everything outside the vocabulary is dropped:
    // accept a markup-ish row object verbatim and the displayValue test fails; return the input
    // unchecked and the junk tests fail.
    it('normalizes the documented shape, running values through displayValue', () => {
        const out = normalizeRenderedPanel({
            title: 'Computed', tabs: [{ id: 'a', name: 'A', blocks: [
                { type: 'fields', rows: [{ label: 'Money', value: [5000, 'Money'] }] },
                { type: 'collection', groups: [{ key: 'k', rows: [{ label: 'L', value: { a: 1 } }] }] },
            ] }],
        });
        expect(out.title).toBe('Computed');
        expect(out.tabs[0].blocks[0].rows[0]).toEqual({ label: 'Money', value: '5000', missing: false, style: {} });
        expect(out.tabs[0].blocks[1].groups[0].rows[0].value).toBe('{1 keys}');
    });
    it('junk yields null so the host falls back to the bound declaration', () => {
        expect(normalizeRenderedPanel(null)).toBe(null);
        expect(normalizeRenderedPanel('html')).toBe(null);
        expect(normalizeRenderedPanel({ tabs: [] })).toBe(null);
        expect(normalizeRenderedPanel({ tabs: ['not-a-tab'] })).toBe(null);
    });
});

// ── an empty drawer is ONE fact ──────────────────────────────────────────────
//
// An empty drawer makes every binding to it resolve to nothing, and one line per binding would point at
// the declaration while the cause is the drawer they all share. These tests hold the replacement to being
// a REPLACEMENT: not fewer facts, the right one.
describe('an empty own drawer collapses to one warning', () => {
    const decl = { tabs: [{ id: 't', name: 'Lane', blocks: [{ type: 'fields', fields: [
        { label: 'Turn', path: 'RelayTurn' },
        { label: 'At', path: 'RelayAt' },
        { label: 'Said', path: 'PostSaid' },
    ] }] }] };

    it('says it once, with the count it stands in for, instead of once per binding', () => {
        const m = renderSlotModel(decl, {}, {});
        expect(m.warnings).toHaveLength(1);
        expect(m.warnings[0]).toContain('drawer is EMPTY');
        expect(m.warnings[0]).toContain('3 path(s)');
    });

    it('MUTATION TARGET — it goes FIRST, because it is the cause of everything under it', () => {
        const withForeign = { tabs: [{ id: 't', name: 'Lane', blocks: [{ type: 'fields', fields: [
            { label: 'Mine', path: 'RelayTurn' },
            { label: 'Theirs', path: '$.World.Time' },
        ] }] }] };
        const m = renderSlotModel(withForeign, {}, { snapshot: {} });
        expect(m.warnings[0]).toContain('drawer is EMPTY');
    });

    it('a $. path is NOT covered by it — that failure reads somewhere else entirely', () => {
        const foreign = { tabs: [{ id: 't', name: 'F', blocks: [{ type: 'fields', fields: [
            { label: 'Time', path: '$.World.Time' },
        ] }] }] };
        const m = renderSlotModel(foreign, {}, { snapshot: {} });
        expect(m.warnings.join(' ')).toContain('$.World.Time');
        expect(m.warnings.join(' ')).not.toContain('drawer is EMPTY');
    });

    it('an unexposed token still names the token — a different author mistake, still reported', () => {
        const tok = { tabs: [{ id: 't', name: 'C', blocks: [{ type: 'fields', fields: [
            { label: 'Cast', path: '{cast@1}.Name' },
        ] }] }] };
        const m = renderSlotModel(tok, {}, { snapshot: {}, exposes: {} });
        expect(m.warnings.join(' ')).toContain('cast@1');
    });

    it('MUTATION TARGET — a drawer WITH state warns per path again: those are real dead bindings', () => {
        // The collapse is only ever right when the drawer explains every miss. One key in it and the
        // paths that still fail are the declaration's own problem, named individually as before.
        const m = renderSlotModel(decl, { RelayTurn: 4 }, {});
        expect(m.warnings.join(' ')).not.toContain('drawer is EMPTY');
        expect(m.warnings.join(' ')).toContain('"RelayAt" resolved to nothing');
        expect(m.warnings.join(' ')).toContain('"PostSaid" resolved to nothing');
    });

    it('a slot that binds nothing to its drawer is never told the drawer is empty', () => {
        const none = { tabs: [{ id: 't', name: 'N', blocks: [{ type: 'fields', fields: [
            { label: 'Fine', path: 'Here' },
        ] }] }] };
        expect(renderSlotModel(none, { Here: 'yes' }, {}).warnings).toEqual([]);
    });

    it('isOwnScopeEmpty reads null, undefined, non-objects and {} the same way', () => {
        for (const v of [null, undefined, {}, 3, 'x']) expect(isOwnScopeEmpty(v)).toBe(true);
        expect(isOwnScopeEmpty({ a: 1 })).toBe(false);
        expect(emptyOwnScopeWarning(2)).toContain('2 path(s)');
    });
});

describe('normalizeRenderedPanel reports what it refuses, the way the bound lane does', () => {
    it('MUTATION TARGET — a paint the hex check refuses is reported, behind renderPanel', () => {
        const out = normalizeRenderedPanel({ tabs: [{ id: 'a', name: 'Lane', blocks: [
            { type: 'fields', rows: [{ label: 'Energy', value: 1, style: { value: { color: 'tomato' } } }] },
        ] }] });
        expect(out.tabs[0].blocks[0].rows[0].style).toEqual({});
        expect(out.warnings).toEqual(['renderPanel tab "Lane" — "Energy": "tomato" is not a hex colour (#rgb, #rgba, #rrggbb or #rrggbbaa)']);
    });
    it('MUTATION TARGET — a computed collection paints groupKey per group; on the block it is reported', () => {
        const out = normalizeRenderedPanel({ tabs: [{ id: 'a', name: 'Lane', blocks: [
            { type: 'collection', heading: 'Cast', style: { groupKey: { color: '#ffffff' } },
                groups: [{ key: 'k', style: { groupKey: { color: '#e08ac0' } }, rows: [] }] },
        ] }] });
        expect(out.tabs[0].blocks[0].groups[0].style).toEqual({ groupKey: { color: '#e08ac0', background: '' } });
        expect(out.warnings).toEqual(['renderPanel tab "Lane" · "Cast": unknown cell "groupKey" (this one paints: heading)']);
    });
    it('MUTATION TARGET — nesting past the depth cap is reported once per block, not once per group', () => {
        const deep = (key) => ({ key, rows: [], blocks: [{ type: 'collection', groups: [{ key: 'x', rows: [] }] }] });
        const out = normalizeRenderedPanel({ tabs: [{ id: 'a', name: 'D', blocks: [
            { type: 'collection', groups: [{ key: 'L1', rows: [], blocks: [
                { type: 'collection', groups: [{ key: 'L2', rows: [], blocks: [
                    { type: 'collection', groups: [deep('L3a'), deep('L3b')] },
                ] }] },
            ] }] },
        ] }] });
        expect(out.warnings).toEqual(['renderPanel tab "D" · L1 · L2: nested blocks below depth ' + PANEL_CAPS.depth + ' are not rendered']);
        expect(out.tabs[0].blocks[0].groups[0].blocks[0].groups[0].blocks[0].groups[0].blocks).toEqual([]);
    });
    it('a clean computed panel reports nothing', () => {
        const out = normalizeRenderedPanel({ tabs: [{ id: 'a', name: 'A', blocks: [
            { type: 'fields', rows: [{ label: 'O', value: 1, style: { value: { color: '#5cb37a' } } }] },
        ] }] });
        expect(out.warnings).toEqual([]);
    });
});

// The triggers live in the host-coupled side-panel.js, so the load-bearing lines are gated as SOURCE.
describe('SOURCE GATE — the panel redraws on every state save, and warns once per chat', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/features/side-panel/side-panel.js'), 'utf8');
    it('MUTATION TARGET — it re-renders on every save the bridge announces', () => {
        expect(src).toMatch(/eventSource\.on\(MVU_STATE_SAVED_EVENT, scheduleRender\)/);
    });
    it('MUTATION TARGET — every slot warning goes through the once-per-chat door', () => {
        expect(src).toMatch(/if \(warnedThisChat\.has\(key\)\) return;/);
        const build = src.slice(src.indexOf('async function buildSlotModel'), src.indexOf('let renderTimer'));
        expect(build).not.toMatch(/log\.warn\(/);
        expect(src).toMatch(/for \(const w of \(model\.warnings \|\| \[\]\)\) warnOnce\(id, w\);/);
    });
});
