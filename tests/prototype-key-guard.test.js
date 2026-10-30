// The shared walkers refuse prototype keys — every path they take comes from card-supplied text (an
// engine's declared roots, a pack's `state.force`, a card's [InitVar]), and `obj.__proto__` IS
// Object.prototype: a create on `__proto__.x` writes `x` onto every object in the realm. The same rule
// holds at every edge a path crosses into the page: the op check each lane passes before MVU (model
// output, the engine's pre-assembly rail, a plugin's relay), plugin state names, and the readers that
// walk a declared path.
//
// Each test checks a FRESH `{}` afterwards, because pollution never shows on the object written to.
// afterEach strips the probe names, so a regression fails its own test instead of leaking into others.
import { describe, it, expect, afterEach } from 'vitest';
import { getPath, ensurePath, isPrototypeKey, deepClone } from '../src/shared/object-path.js';
import { mergeInitSubtree } from '../src/shared/create-only-merge.js';
import { patchOpShapeProblem, salvagePatchOps, getAtPointer } from '../src/shared/json-patch-ops.js';
import { isValidStateName, decideStateName, suggestStateName, reconcilePluginExposes } from '../src/features/gamelogic-plugin/gamelogic-plugin-core.js';
import { resolveStatePath } from '../src/features/side-panel/side-panel-core.js';
import { resolveStatPath } from '../src/features/imagegen/prompt-assembly-core.js';
import { menuFormatterCalls } from '../src/features/statusmenu-pack/statusmenu-pack-core.js';

const PROBES = ['pgTriggers', 'pgDeep', 'pgSeedRoot', 'pgSeedNested'];
afterEach(() => { for (const k of PROBES) delete Object.prototype[k]; });
const polluted = () => PROBES.filter((k) => ({})[k] !== undefined);

describe('isPrototypeKey', () => {
    it('names exactly the three prototype keys, not look-alikes', () => {
        for (const k of ['__proto__', 'constructor', 'prototype']) expect(isPrototypeKey(k), k).toBe(true);
        for (const k of ['__protocol__', 'Constructor', 'prototypes', 'proto', '']) expect(isPrototypeKey(k), k).toBe(false);
    });
});

describe('ensurePath — never creates through a prototype key', () => {
    it('refuses __proto__ and constructor.prototype, and pollutes nothing', () => {
        expect(ensurePath({}, '__proto__.pgTriggers')).toBe(null);
        expect(ensurePath({}, 'constructor.prototype.pgDeep')).toBe(null);
        expect(polluted()).toEqual([]);
    });

    it('checks the WHOLE path first — a refused path leaves no half-built chain behind', () => {
        const sd = {};
        expect(ensurePath(sd, 'Fresh.__proto__.pgDeep')).toBe(null);
        expect(sd).toEqual({});
    });

    it('still builds an ordinary chain', () => {
        const sd = {};
        expect(ensurePath(sd, 'A.b')).toEqual({});
        expect(sd).toEqual({ A: { b: {} } });
    });
});

describe('getPath — never reads through a prototype key', () => {
    it('answers undefined for prototype plumbing instead of Object.prototype', () => {
        expect(getPath({}, '__proto__')).toBe(undefined);
        expect(getPath({}, 'constructor')).toBe(undefined);
        expect(getPath({ A: {} }, 'A.constructor.prototype')).toBe(undefined);
    });

    it('still reads an ordinary path', () => {
        expect(getPath({ A: { b: 3 } }, 'A.b')).toBe(3);
    });
});

describe('deepClone — a copy carries no __proto__ key', () => {
    it('drops an own "__proto__" at any depth, keeps every other key', () => {
        const src = JSON.parse('{"a":1,"__proto__":{"x":1},"n":{"__proto__":{"y":1},"b":[1,{"c":2}]},"constructor":"kept"}');
        const copy = deepClone(src);
        expect(Object.keys(copy)).toEqual(['a', 'n', 'constructor']);
        expect(Object.keys(copy.n)).toEqual(['b']);
        expect(copy.n.b).toEqual([1, { c: 2 }]);
        expect(copy.constructor).toBe('kept');
    });

    it('passes primitives through untouched', () => {
        expect(deepClone(5)).toBe(5);
        expect(deepClone(null)).toBe(null);
    });
});

describe('mergeInitSubtree — a seed never merges into a prototype', () => {
    // JSON.parse makes "__proto__" an OWN key, so Object.keys hands it to the merge — the shape a
    // card's [InitVar] really arrives in. An object literal would not reproduce it.
    it('skips a prototype key at the root and at depth, and seeds the rest', () => {
        const init = JSON.parse('{"__proto__":{"pgSeedRoot":1},"World":{"__proto__":{"pgSeedNested":1},"Day":1}}');
        const sd = {};
        const res = mergeInitSubtree(sd, init);
        expect(polluted()).toEqual([]);
        expect(sd).toEqual({ World: { Day: 1 } });
        expect(res.written).toEqual(['World']);
    });

    it('skips it when merging into a root the save already has', () => {
        const sd = { World: { Day: 4 } };
        mergeInitSubtree(sd, JSON.parse('{"World":{"__proto__":{"pgSeedNested":1},"Weather":"Clear"}}'));
        expect(polluted()).toEqual([]);
        expect(sd.World).toEqual({ Day: 4, Weather: 'Clear' });
    });
});

// The sandbox's edge: MVU reads an op's parent with lodash `_.get`, which answers Object.prototype for a
// `__proto__` segment, then assigns into it. PRE and POST ops are model output; the pre-assembly rail's and
// a plugin relay's come from the engine Worker. All four pass this one check before MVU sees them.
describe('patchOpShapeProblem — no op through a prototype key reaches MVU', () => {
    it('MUTATION TARGET — refuses a prototype key at the root, at depth, and as constructor/prototype', () => {
        for (const path of ['/__proto__/x', '/World/__proto__/x', '/GameLogicPlugin/constructor/prototype/x', '/World/prototype']) {
            expect(patchOpShapeProblem({ op: 'add', path, value: 1 }, 0), path).toContain('prototype key');
            expect(patchOpShapeProblem({ op: 'remove', path }, 0), path).toContain('prototype key');
        }
    });

    it('passes an ordinary path, and a key that only looks like one', () => {
        expect(patchOpShapeProblem({ op: 'replace', path: '/World/Day', value: 2 }, 0)).toBe('');
        expect(patchOpShapeProblem({ op: 'add', path: '/World/__protocol__', value: 1 }, 0)).toBe('');
        expect(patchOpShapeProblem({ op: 'add', path: '/World/Constructor', value: 1 }, 0)).toBe('');
    });

    it('salvage drops the offender by index, names why, and keeps its neighbours', () => {
        const { ops, dropped } = salvagePatchOps([
            { op: 'replace', path: '/World/Day', value: 2 },
            { op: 'add', path: '/World/__proto__/isAdmin', value: true },
        ]);
        expect(ops).toEqual([{ op: 'replace', path: '/World/Day', value: 2 }]);
        expect(dropped).toHaveLength(1);
        expect(dropped[0].index).toBe(1);
        expect(dropped[0].reason).toContain('"__proto__"');
    });
});

describe('getAtPointer — never reads through a prototype key', () => {
    it('answers undefined instead of Object.prototype, and still reads an ordinary pointer', () => {
        expect(getAtPointer({}, '/__proto__')).toBe(undefined);
        expect(getAtPointer({ A: {} }, '/A/constructor/prototype')).toBe(undefined);
        expect(getAtPointer({ A: { b: [5, 'Gold'] } }, '/A/b/0')).toBe(5);
    });
});

// A plugin's own root is GameLogicPlugin.<stateName>, and its relay writes under it: a state name of
// `constructor` would put `/GameLogicPlugin/constructor/prototype/…` inside its own fence.
describe('plugin state names — a prototype key is no state root', () => {
    it('MUTATION TARGET — constructor and prototype are refused, look-alikes are not', () => {
        for (const name of ['constructor', 'prototype', '__proto__']) expect(isValidStateName(name), name).toBe(false);
        for (const name of ['Constructor', 'prototypes', 'Cast']) expect(isValidStateName(name), name).toBe(true);
        expect(decideStateName({ requested: 'constructor', registry: { activePlugins: [] } })).toMatchObject({ ok: false, problem: 'invalid' });
    });

    it('the install form never suggests one', () => {
        expect(suggestStateName('constructor')).toBe('Plugin_constructor');
        expect(suggestStateName('prototype')).toBe('Plugin_prototype');
        expect(isValidStateName(suggestStateName('constructor'))).toBe(true);
        expect(suggestStateName('lane-probe')).toBe('lane_probe');
    });
});

// Readers walk a path a pack or card declared. A prototype key reads as nothing, the same answer getPath gives,
// instead of handing back Object.prototype or a constructor function.
describe('path readers — a prototype key reads as nothing', () => {
    it('the side panel finds nothing there', () => {
        expect(resolveStatePath({}, '__proto__')).toEqual({ found: false, value: undefined });
        expect(resolveStatePath({ A: {} }, 'A.constructor')).toEqual({ found: false, value: undefined });
        expect(resolveStatePath({ A: { b: 1 } }, 'A.b')).toEqual({ found: true, value: 1 });
    });

    it('MUTATION TARGET — a card-declared image path reads nothing there', () => {
        expect(resolveStatPath({}, '__proto__')).toBe(undefined);
        expect(resolveStatPath({ World: {} }, 'World.constructor')).toBe(undefined);
        expect(resolveStatPath({ World: { Day: 3 } }, 'stat_data.World.Day')).toBe(3);
    });

    it('a menu formatter scoped at one is handed nothing', () => {
        const [call] = menuFormatterCalls({ A: {} }, [{ formatterName: 'f', scopePath: 'A.__proto__' }]);
        expect(call.args[0]).toBe(undefined);
    });

    it('MUTATION TARGET — a plugin interface exposed at one reads as ABSENT, not as present', () => {
        const registry = { activePlugins: [{ id: 'p', requires: ['cast@1'], optionalUses: [] }] };
        const findings = reconcilePluginExposes(registry, { 'cast@1': 'Cast.constructor' }, { Cast: {} });
        expect(findings.map((f) => f.reason).join(' ')).toContain('ABSENT');
    });
});
