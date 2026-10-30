// tests/plugin-relay-core.test.js — what is true of the §23 relay lane AND NOT of the PRE sim lane.
//
// The op-shape contract itself (verbs, the four checks, per-op salvage, the after-apply strip probe)
// is shared/json-patch-ops.js and is proved ONCE, in tests/json-patch-ops.test.js. This suite used
// to re-prove all of it against a private copy — the duplication that made two lanes able to drift.
// What remains here is genuinely lane-local: where relay ops come from (a Worker, by structured
// clone), what may not ride along with them, and the wrapper MVU needs.

import { describe, it, expect } from 'vitest';
import {
    planRelayPatch, buildRelayBlock, ownRootPointer, RELAY_EXPORT_NAME,
} from '../src/features/gamelogic-plugin/plugin-relay-core.js';

describe('planRelayPatch — the Worker-sourced hazards, on top of the shared shape check', () => {
    it('forwards well-formed ops in order, untouched', () => {
        const { ops, dropped } = planRelayPatch([
            { op: 'replace', path: '/GameLogicPlugin/LaneProbe/RelayTurn', value: 3 },
            { op: 'remove', path: '/GameLogicPlugin/LaneProbe/Old' },
        ]);
        expect(dropped).toEqual([]);
        expect(ops).toEqual([
            { op: 'replace', path: '/GameLogicPlugin/LaneProbe/RelayTurn', value: 3 },
            { op: 'remove', path: '/GameLogicPlugin/LaneProbe/Old' },
        ]);
    });

    // THE POINT OF THE RAIL SWAP: a path outside the plugin's own root is forwarded, not rewritten
    // and not refused. Zod decides, exactly as it does for the card's own POST ops.
    it('forwards a path into the GAME\'s state unchanged — no prefixing, no fence', () => {
        const { ops } = planRelayPatch([{ op: 'replace', path: '/World/Weather/0', value: 'Storm' }]);
        expect(ops[0].path).toBe('/World/Weather/0');
    });

    // Structured clone preserves cycles; JSON.parse (the PRE lane's op source) cannot make one. So
    // this check exists HERE and only here — and it must drop the one op, not the whole block.
    it('drops an unserialisable value by name instead of throwing the whole block away', () => {
        const cyclic = {}; cyclic.self = cyclic;
        const { ops, dropped } = planRelayPatch([
            { op: 'replace', path: '/A/bad', value: cyclic },
            { op: 'replace', path: '/A/good', value: 1 },
        ]);
        expect(ops.map((o) => o.path)).toEqual(['/A/good']);
        expect(dropped).toHaveLength(1);
        expect(dropped[0].index).toBe(0);
        expect(dropped[0].reason).toContain('serialis');
    });

    it('carries only op/path/value — a resolver cannot smuggle its bookkeeping fields into MVU\'s input', () => {
        const { ops } = planRelayPatch([{ op: 'replace', path: '/A/x', value: 1, reason: 'sneaky', from: '/B' }]);
        expect(Object.keys(ops[0]).sort()).toEqual(['op', 'path', 'value']);
    });

    it('a remove carries no value key at all', () => {
        expect(planRelayPatch([{ op: 'remove', path: '/A/x' }]).ops[0]).toEqual({ op: 'remove', path: '/A/x' });
    });

    // A resolver returning `{}` (no patches) is a quiet turn; returning a non-array is an authoring
    // error the host must NAME, not throw on — the Worker's return value is not trusted input.
    it('no patches is quiet; a non-array patches field is reported, not thrown', () => {
        expect(planRelayPatch(undefined)).toEqual({ ops: [], dropped: [] });
        expect(planRelayPatch(null)).toEqual({ ops: [], dropped: [] });
        const { ops, dropped } = planRelayPatch({ op: 'replace' });
        expect(ops).toEqual([]);
        expect(dropped).toEqual([{ index: -1, reason: '"patches" must be an ARRAY of JSON Patch ops — got object' }]);
    });

    it('exports the §23 resolver name the host looks up', () => {
        expect(RELAY_EXPORT_NAME).toBe('resolveRelay');
    });
});

describe('buildRelayBlock — the same input the card\'s POST bookkeeper produces', () => {
    it('wraps in <UpdateVariable>, because a bare <JSONPatch> is classified as lost ops', () => {
        const text = buildRelayBlock([{ op: 'replace', path: '/A/x', value: 1 }]);
        expect(text).toContain('<UpdateVariable>');
        expect(text).toContain('</UpdateVariable>');
        const body = text.slice(text.indexOf('<JSONPatch>') + 11, text.indexOf('</JSONPatch>'));
        expect(JSON.parse(body)).toEqual([{ op: 'replace', path: '/A/x', value: 1 }]);
    });
});

describe('ownRootPointer', () => {
    it('turns the dotted own root into the pointer a resolver builds paths from', () => {
        expect(ownRootPointer('GameLogicPlugin.LaneProbe')).toBe('/GameLogicPlugin/LaneProbe');
        expect(ownRootPointer('')).toBe('/');
    });
});
