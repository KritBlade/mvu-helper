// tests/tavern-script-core.test.js — the TavernHelper script-tree decisions.
// These matter because the tree NESTS: a folder contains scripts, so every operation is recursive, and a
// missed branch is invisible from the host file (L6 — that is why the decisions live in a core at all).

import { describe, it, expect } from 'vitest';
import {
    flattenScriptTree,
    flattenScriptTreeWithEnablement,
    findScriptByName,
    upsertScriptInTree,
    removeScriptFromTree,
    setScriptsEnabledById,
} from '../src/sillytavern/tavern-script-core.js';

const script = (name, content = '', extra = {}) => ({
    type: 'script', enabled: true, name, id: 'id-' + name, content,
    info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false },
    ...extra,
});
const folder = (name, scripts) => ({ type: 'folder', enabled: true, name, id: 'f-' + name, icon: '', color: '', scripts });

// The live School v4 shape, verified from ArtificKoi-lore-only.json.
const MVU_URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
const liveTrees = () => [
    script('mvu', `import '${MVU_URL}';`),
    script('Scheme', "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';"),
];

describe('flattenScriptTree', () => {
    it('returns scripts in tree order and unwraps folders', () => {
        const trees = [script('a'), folder('F', [script('b'), script('c')]), script('d')];
        expect(flattenScriptTree(trees).map((s) => s.name)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('walks folders nested more than one deep', () => {
        const trees = [folder('outer', [folder('inner', [script('deep')])])];
        expect(flattenScriptTree(trees).map((s) => s.name)).toEqual(['deep']);
    });

    it('returns folders themselves NEVER — callers want scripts', () => {
        expect(flattenScriptTree([folder('F', [])])).toEqual([]);
    });

    it('skips unknown node kinds instead of throwing (another extension may add some)', () => {
        expect(flattenScriptTree([{ type: 'something-new' }, null, 'nonsense', script('ok')]).map((s) => s.name)).toEqual(['ok']);
    });

    it('a non-array input yields []', () => {
        expect(flattenScriptTree(undefined)).toEqual([]);
        expect(flattenScriptTree(null)).toEqual([]);
    });
});

describe('flattenScriptTreeWithEnablement — what TavernHelper runs', () => {
    it('a top-level script runs when its own flag is on, and not when it is off', () => {
        const rows = flattenScriptTreeWithEnablement([script('a'), script('b', '', { enabled: false })]);
        expect(rows.map((r) => [r.script.name, r.isEnabled])).toEqual([['a', true], ['b', false]]);
    });

    it('a disabled folder stops every script inside it, whatever their own flags say', () => {
        const trees = [{ ...folder('off', [script('a'), script('b')]), enabled: false }];
        expect(flattenScriptTreeWithEnablement(trees).map((r) => r.isEnabled)).toEqual([false, false]);
    });

    it('inside an enabled folder, each script follows its own flag', () => {
        const trees = [folder('on', [script('a'), script('b', '', { enabled: false })])];
        expect(flattenScriptTreeWithEnablement(trees).map((r) => r.isEnabled)).toEqual([true, false]);
    });

    it('returns scripts only, in tree order, and skips junk', () => {
        const trees = [script('a'), folder('f', [script('b')]), null, { type: 'mystery' }];
        expect(flattenScriptTreeWithEnablement(trees).map((r) => r.script.name)).toEqual(['a', 'b']);
        expect(flattenScriptTreeWithEnablement(null)).toEqual([]);
    });
});

describe('findScriptByName', () => {
    it('finds the live mvu and Scheme scripts', () => {
        expect(findScriptByName(liveTrees(), 'Scheme').content).toContain('registerMvuSchema');
    });

    it('is CASE-SENSITIVE — "MVU" must not claim the "mvu" script', () => {
        expect(findScriptByName(liveTrees(), 'MVU')).toBeNull();
    });

    it('finds a script inside a folder', () => {
        expect(findScriptByName([folder('F', [script('buried')])], 'buried')).not.toBeNull();
    });

    it('absent name / empty name → null', () => {
        expect(findScriptByName(liveTrees(), 'nope')).toBeNull();
        expect(findScriptByName(liveTrees(), '')).toBeNull();
    });
});

describe('upsertScriptInTree', () => {
    it('creates at top level when absent', () => {
        const { trees, created } = upsertScriptInTree([], { name: 'Scheme', content: 'x' }, 'new-id');
        expect(created).toBe(true);
        expect(trees).toHaveLength(1);
        expect(trees[0]).toMatchObject({ type: 'script', name: 'Scheme', content: 'x', id: 'new-id' });
    });

    it('a created script carries the fields TavernHelper expects', () => {
        const { trees } = upsertScriptInTree([], { name: 'Scheme', content: 'x' }, 'new-id');
        expect(trees[0]).toHaveProperty('button.buttons');
        expect(trees[0]).toHaveProperty('export_with.data');
        expect(trees[0].enabled).toBe(true);
    });

    it('updates in place without appending a duplicate', () => {
        const { trees, created } = upsertScriptInTree(liveTrees(), { name: 'Scheme', content: 'rewritten' }, 'ignored');
        expect(created).toBe(false);
        expect(findScriptByName(trees, 'Scheme').content).toBe('rewritten');
        expect(trees).toHaveLength(2);
    });

    // The node's id is its identity. A caller handing us `fields` that CARRY an id (copying a script object
    // around is the obvious way to end up there) must not be able to rename the node out from under
    // TavernHelper. The id in `fields` is what makes this a real test: without one, the node keeps its id
    // whether or not the guard (`id: node.id`) exists.
    it('an id arriving in `fields` is IGNORED — the node keeps its own', () => {
        const { trees } = upsertScriptInTree(liveTrees(), { name: 'Scheme', content: 'rewritten', id: 'hijacked' }, 'ignored');
        expect(findScriptByName(trees, 'Scheme').id).toBe('id-Scheme');
    });

    it('an id arriving in `fields` is ignored for a script inside a folder too', () => {
        const trees = [folder('F', [script('Scheme', 'old')])];
        const res = upsertScriptInTree(trees, { name: 'Scheme', content: 'new', id: 'hijacked' }, 'x');
        expect(res.trees[0].scripts[0].id).toBe('id-Scheme');
    });

    it('preserves fields the update does not set — a content write must not delete script buttons', () => {
        const withButton = [script('Scheme', 'old', { button: { enabled: true, buttons: [{ name: 'Go', visible: true }] }, data: { keep: 1 } })];
        const { trees } = upsertScriptInTree(withButton, { name: 'Scheme', content: 'new' }, 'x');
        const found = findScriptByName(trees, 'Scheme');
        expect(found.content).toBe('new');
        expect(found.button.buttons).toEqual([{ name: 'Go', visible: true }]);
        expect(found.data).toEqual({ keep: 1 });
    });

    it('updates a script that lives inside a folder, in place', () => {
        const trees = [folder('F', [script('Scheme', 'old')])];
        const res = upsertScriptInTree(trees, { name: 'Scheme', content: 'new' }, 'x');
        expect(res.created).toBe(false);
        expect(res.trees[0].scripts[0].content).toBe('new');
        expect(res.trees).toHaveLength(1);              // not also appended at top level
    });

    it('NEVER mutates the input tree (updateScriptTreesWith hands us the live array)', () => {
        const trees = liveTrees();
        const snapshot = JSON.parse(JSON.stringify(trees));
        upsertScriptInTree(trees, { name: 'Scheme', content: 'rewritten' }, 'x');
        expect(trees).toEqual(snapshot);
    });

    it('an empty name is refused rather than creating a nameless script', () => {
        const { trees, created } = upsertScriptInTree(liveTrees(), { name: '', content: 'x' }, 'x');
        expect(created).toBe(false);
        expect(trees).toHaveLength(2);
    });
});

describe('removeScriptFromTree', () => {
    it('removes by exact name and reports the count', () => {
        const { trees, removed } = removeScriptFromTree(liveTrees(), 'Scheme');
        expect(removed).toBe(1);
        expect(flattenScriptTree(trees).map((s) => s.name)).toEqual(['mvu']);
    });

    it('removes inside folders but keeps the (now empty) folder — the user owns their organisation', () => {
        const { trees, removed } = removeScriptFromTree([folder('F', [script('gone')])], 'gone');
        expect(removed).toBe(1);
        expect(trees).toHaveLength(1);
        expect(trees[0].type).toBe('folder');
        expect(trees[0].scripts).toEqual([]);
    });

    it('an absent name removes nothing', () => {
        expect(removeScriptFromTree(liveTrees(), 'nope').removed).toBe(0);
    });
});

describe('setScriptsEnabledById (the disable/bounce write)', () => {
    it('disables exactly the identified script, reaching inside folders, and names what changed', () => {
        const trees = [folder('stuff', [script('mvu', `import '${MVU_URL}';`)]), script('Scheme', 'schema')];
        const res = setScriptsEnabledById(trees, ['id-mvu'], false);
        expect(res.changed).toEqual(['mvu']);
        expect(res.trees[0].scripts[0].enabled).toBe(false);
        expect(res.trees[1].enabled).toBe(true);              // untouched sibling
        expect(trees[0].scripts[0].enabled).toBe(true);       // input never mutated
    });

    it('an already-at-value script is not counted as changed — the log must name real changes only', () => {
        const trees = [script('mvu', `import '${MVU_URL}';`, { enabled: false })];
        expect(setScriptsEnabledById(trees, ['id-mvu'], false).changed).toEqual([]);
    });

    it('re-enables for the bounce half', () => {
        const trees = [script('mvu', `import '${MVU_URL}';`, { enabled: false })];
        const res = setScriptsEnabledById(trees, ['id-mvu'], true);
        expect(res.changed).toEqual(['mvu']);
        expect(res.trees[0].enabled).toBe(true);
    });

    it('never touches a folder\'s own enabled flag — that is the user\'s organisation', () => {
        const trees = [folder('stuff', [script('mvu', `import '${MVU_URL}';`)])];
        const res = setScriptsEnabledById(trees, ['f-stuff', 'id-mvu'], false);
        expect(res.trees[0].enabled).toBe(true);
        expect(res.trees[0].scripts[0].enabled).toBe(false);
    });

    it('unknown ids and junk inputs change nothing and throw nothing', () => {
        expect(setScriptsEnabledById(null, ['x'], false).changed).toEqual([]);
        expect(setScriptsEnabledById([script('a')], null, false).changed).toEqual([]);
        expect(setScriptsEnabledById([script('a')], ['nope'], false).changed).toEqual([]);
    });
});
