// when-dsl-grammar.test.js — the grammar's own tests PLUS the drift guard that makes vendoring safe.
//
// P6 (event-pack-plan.md §6.5.1) collapsed three hand-written copies of the WHEN-DSL token grammar
// into one, living in the engine (`_engine/eventpack.cjs` → `parseToken`). `src/features/event-pack/
// when-dsl-grammar.js` is a COPY of it, because mvu-helper ships to users and may not read the game
// repo at runtime. A copy with nothing enforcing it is just the drift we removed, re-introduced with
// extra steps — so the second describe block below loads the REAL engine file and asserts the two
// agree token for token. If the engine's grammar changes and the copy doesn't, this fails BY NAME.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseToken, isTokenShapeOk, formatToken, formatTokenChain, formatWhenAny } from '../src/features/event-pack/when-dsl-grammar.js';
import { fileURLToPath } from 'node:url';
import { schoolv4Dir, haveSchoolv4 } from './schoolv4-artifact.mjs';

// The corpus is shared by BOTH blocks on purpose: every case that documents a rule below is also a
// case the engine must agree on. Real shapes, the three P6 precedence decisions, and junk.
const CORPUS = [
    // no constraint
    '', '-', '   ', '  -  ',
    // comparisons (the common case) — including the §6.5a raw dotted path a builder emits
    'Aff(Mitsuki)>=30', 'Affection >= 40', 'gf>=0', 'T>=16:00', 'Loc=Outskirts.AncientRuins',
    'Mainchar.Money >= 100', 'Quest(Leila).Step==1', 'DaysSince(Mainchar.Quests.Leila.LastUpdated)>=1', 'x==y', 'A>=B>=C', 'Stage<Lover',
    // set membership
    'Mood in {Happy,Excited}', 'Quest(Leila).Step in {1,2}', 'Some Long LHS in {a,b}',
    'Mood in {}', 'Mood in { Happy , Excited }',
    // presence
    'Present(Mitsuki)', 'Present( Mitsuki )',
    // event flags
    'flag:leila_1', 'flag:leila_1=done', 'flag:leila_1=failed', 'flag:LEILA_1',
    // the P6 precedence cases — each must land the SAME way on both sides
    'flag:leila-1',      // lint used to accept; engine could never fire it
    '>=40',              // engine used to parse as a compare against '>'
    'Present(a(b)',      // engine used to accept the inner '('
    'Mood in {a,{b}}',   // nested braces
    // format 2.0 negation — must reject IDENTICALLY on all four forms until P7 (see the rule below)
    '!Present(Mitsuki)', '!flag:leila_1', '!Loc=Home', '!aff>10', '!',
    // junk
    'garbage', 'in {a,b}', 'flag:', 'Present()', '=', '&',
];

describe('parseToken — the vendored WHEN-DSL grammar', () => {
    it('reads an empty / dash token as NO CONSTRAINT (trimmed)', () => {
        for (const t of ['', '-', '   ', '  -  ']) expect(parseToken(t)).toEqual({ kind: 'none' });
    });

    it('parses a comparison, trimming both sides and keeping the operator verbatim', () => {
        expect(parseToken('Affection >= 40')).toEqual({ kind: 'cmp', lhs: 'Affection', op: '>=', rhs: '40' });
        expect(parseToken('Loc=Outskirts.AncientRuins')).toEqual({ kind: 'cmp', lhs: 'Loc', op: '=', rhs: 'Outskirts.AncientRuins' });
    });

    // ▲ REVERSED IN 2.0, and it is a NEGATION safety fix rather than tidiness. The lazy LHS match let
    // a second operator ride along in the RHS, so `A>=B>=C` compared against the literal 'B>=C' —
    // harmlessly always FALSE in 1.0. Under `!` that flips to always TRUE: a typo silently UN-GATING an
    // event, which §4a's negation rule exists to forbid. formatToken ALREADY refused to emit it, so the
    // parser accepting what the emitter rejects was the real asymmetry. Costs no live behaviour (false
    // either way) and buys the §4.7 warning.
    it('REJECTS a compound RHS — a second operator means malformed, not a comparison', () => {
        for (const t of ['A>=B>=C', 'Loc=Home=School', 'a>b<c']) {
            expect(parseToken(t), `expected ${t} to be rejected`).toBeNull();
        }
    });

    it('parses a §6.5a raw dotted path as an ordinary comparison LHS (the builder emits these)', () => {
        expect(parseToken('Mainchar.Money >= 100')).toEqual({ kind: 'cmp', lhs: 'Mainchar.Money', op: '>=', rhs: '100' });
    });

    it('parses set membership, trimming each element', () => {
        expect(parseToken('Mood in { Happy , Excited }')).toEqual({ kind: 'in', lhs: 'Mood', set: ['Happy', 'Excited'] });
    });

    it('allows a spaced LHS in a set token — the ENGINE accepts it, so the lint must not warn', () => {
        expect(parseToken('Some Long LHS in {a,b}')).toMatchObject({ kind: 'in', lhs: 'Some Long LHS' });
    });

    it('parses Present() and flag:, defaulting a flag with no state to "done"', () => {
        expect(parseToken('Present( Mitsuki )')).toEqual({ kind: 'present', name: 'Mitsuki' });
        expect(parseToken('flag:leila_1')).toEqual({ kind: 'flag', flag: 'leila_1', state: 'done' });
        expect(parseToken('flag:leila_1=failed')).toEqual({ kind: 'flag', flag: 'leila_1', state: 'failed' });
    });

    // ── the three P6 precedence decisions, each asserted as a RULE not a snapshot ──
    it('REJECTS flag: with a non-word key — the old lint accepted it and such a pack could NEVER fire', () => {
        expect(parseToken('flag:leila-1')).toBeNull();
        expect(isTokenShapeOk('flag:leila-1')).toBe(false);
    });

    it('REJECTS an operator character inside the LHS — ">=40" is malformed, not a compare against ">"', () => {
        expect(parseToken('>=40')).toBeNull();
    });

    it('REJECTS a nested paren inside Present() and a nested brace inside a set', () => {
        expect(parseToken('Present(a(b)')).toBeNull();
        expect(parseToken('Mood in {a,{b}}')).toBeNull();
    });

    // `!` is format 2.0. What makes this worth a test rather than a comment: WITHOUT the explicit
    // reject, the four forms fail in two DIFFERENT ways. `!Present(X)`/`!flag:x` match nothing and are
    // rejected anyway, but `!Loc=Home` matches the COMPARISON branch with '!' glued to the LHS — it
    // parses clean, no warning, and is permanently false because nothing resolves '!Loc'. A dead event
    // with nothing to search for. All four must reject the same way, so P7 has ONE place to invert.
    // ▲ LANDED IN 2.0 (P7). 1.0 rejected all four identically so that P7 had ONE place to invert.
    it('NEGATES any token with a leading `!`, flagging the descriptor rather than wrapping it', () => {
        expect(parseToken('!Present(Mitsuki)')).toEqual({ kind: 'present', name: 'Mitsuki', neg: true });
        expect(parseToken('!flag:leila_1')).toEqual({ kind: 'flag', flag: 'leila_1', state: 'done', neg: true });
        expect(parseToken('!Loc=Home')).toEqual({ kind: 'cmp', lhs: 'Loc', op: '=', rhs: 'Home', neg: true });
        expect(parseToken('!aff>10')).toEqual({ kind: 'cmp', lhs: 'aff', op: '>', rhs: '10', neg: true });
    });

    // THE RULE THAT MAKES NEGATION SAFE. `!` + garbage is garbage, not "not garbage": if an unparseable
    // inner token flipped to TRUE, a typo would silently UN-GATE the event — strictly worse than the
    // dead-event trap 1.0's blanket rejection replaced.
    it('refuses `!` on anything that does not parse, so a typo can only ever fail CLOSED', () => {
        for (const t of ['!', '!-', '!!Loc=Home', '!>=40', '!garbage(', '!Loc=Home=School']) {
            expect(parseToken(t), `expected ${t} to be rejected`).toBeNull();
            expect(isTokenShapeOk(t)).toBe(false);
        }
    });

    // contains()/has() — the argument is ALWAYS quoted, WITH escapes, so a value carrying a quote,
    // comma or paren is expressible today rather than being an edge case an author cannot spell.
    it('parses contains()/has() with a quoted argument, honouring \\" and \\ escapes', () => {
        expect(parseToken('contains(Mainchar.Notes, "beach")')).toEqual({ kind: 'contains', lhs: 'Mainchar.Notes', arg: 'beach' });
        expect(parseToken('has(Classmate.*.Equipment, "camera")')).toEqual({ kind: 'has', lhs: 'Classmate.*.Equipment', arg: 'camera' });
        expect(parseToken(String.raw`contains(Notes, "hello, world")`).arg).toBe('hello, world');
        expect(parseToken(String.raw`contains(Notes, "a(b)")`).arg).toBe('a(b)');
        expect(parseToken(String.raw`contains(Notes, "say \"hi\"")`).arg).toBe('say "hi"');
        expect(parseToken(String.raw`has(Bag, "a\"b,c)d")`).arg).toBe('a"b,c)d');
        expect(parseToken('!has(Bag, "x")')).toEqual({ kind: 'has', lhs: 'Bag', arg: 'x', neg: true });
    });

    it('REJECTS an unquoted argument — one spelling only, so the round-trip is exact', () => {
        for (const t of ['has(X.Y, unquoted)', 'contains(X.Y, )', 'has(X.Y)', 'contains()']) {
            expect(parseToken(t), `expected ${t} to be rejected`).toBeNull();
        }
    });

    it('does not reject a `!` that is not the token PREFIX (only a leading one is 2.0 syntax)', () => {
        expect(parseToken('Name=a!b')).toEqual({ kind: 'cmp', lhs: 'Name', op: '=', rhs: 'a!b' });
    });

    it('returns null on junk, and never throws on junk INPUT', () => {
        for (const t of ['garbage', 'in {a,b}', 'flag:', 'Present()', '=', '&']) expect(parseToken(t)).toBeNull();
        for (const v of [null, undefined, 0, {}, []]) expect(() => parseToken(v)).not.toThrow();
    });

    it('isTokenShapeOk is exactly "did it parse"', () => {
        expect(isTokenShapeOk('Affection >= 40')).toBe(true);
        expect(isTokenShapeOk('')).toBe(true);           // no constraint is a legal token
        expect(isTokenShapeOk('garbage')).toBe(false);
    });
});

// ── P6b: the EMIT direction ─────────────────────────────────────────────────

describe('formatToken — canonical spelling', () => {
    // This block is what PINS the canonical form. Change a string here and you are changing what every
    // builder-authored pack looks like, so it should be a deliberate edit, not a drive-by.
    it('emits the spelling shipped content actually uses — no spaces around operators', () => {
        expect(formatToken({ kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' })).toBe('gf>=0');
        expect(formatToken({ kind: 'cmp', lhs: 'Loc', op: '=', rhs: 'Outskirts.AncientRuins' })).toBe('Loc=Outskirts.AncientRuins');
        expect(formatToken({ kind: 'cmp', lhs: 'Quest(Leila).Step', op: '==', rhs: '0' })).toBe('Quest(Leila).Step==0');
    });

    it('keeps the spaces around `in`, because the grammar requires them', () => {
        expect(formatToken({ kind: 'in', lhs: 'Mood', set: ['Happy', 'Excited'] })).toBe('Mood in {Happy,Excited}');
    });

    it('OMITS the default flag state — parseToken restores it, and shorter is cheaper in the prompt', () => {
        expect(formatToken({ kind: 'flag', flag: 'leila_1', state: 'done' })).toBe('flag:leila_1');
        expect(formatToken({ kind: 'flag', flag: 'leila_1', state: 'failed' })).toBe('flag:leila_1=failed');
    });

    it('emits Present() and the empty token', () => {
        expect(formatToken({ kind: 'present', name: 'Mitsuki' })).toBe('Present(Mitsuki)');
        expect(formatToken({ kind: 'none' })).toBe('');
    });
});

describe('formatToken — the REFUSAL contract (null, never a token that would be misread)', () => {
    const REFUSALS = [
        ['set element containing a comma', { kind: 'in', lhs: 'Mood', set: ['a,b'] }],
        ['set element containing a brace', { kind: 'in', lhs: 'Mood', set: ['a}b'] }],
        ['EMPTY set — `X in {}` parses back as a ONE-element set holding the empty string', { kind: 'in', lhs: 'Mood', set: [] }],
        ['LHS containing an operator', { kind: 'cmp', lhs: 'a>=b', op: '=', rhs: '1' }],
        ['LHS containing the `in` keyword', { kind: 'cmp', lhs: 'a in b', op: '=', rhs: '1' }],
        ['LHS containing a brace', { kind: 'cmp', lhs: 'a{b', op: '=', rhs: '1' }],
        ['RHS containing a second operator', { kind: 'cmp', lhs: 'a', op: '=', rhs: 'b>=c' }],
        ['empty LHS', { kind: 'cmp', lhs: '', op: '=', rhs: '1' }],
        ['empty RHS', { kind: 'cmp', lhs: 'a', op: '=', rhs: '' }],
        ['unknown operator', { kind: 'cmp', lhs: 'a', op: '~=', rhs: '1' }],
        ['Present name with a paren', { kind: 'present', name: 'a(b' }],
        ['flag key outside [A-Za-z0-9_]', { kind: 'flag', flag: 'leila-1', state: 'done' }],
        ['flag state that is not a word', { kind: 'flag', flag: 'x', state: 'a b' }],
        ['flag state missing entirely (pass "done" explicitly)', { kind: 'flag', flag: 'x' }],
        ['a leading ! — format 2.0', { kind: 'cmp', lhs: '!a', op: '=', rhs: '1' }],
        ['untrimmed value — parseToken would trim it, so it cannot round-trip', { kind: 'present', name: ' Mitsuki ' }],
        ['a newline — a predicate is one line', { kind: 'cmp', lhs: 'a', op: '=', rhs: 'b\nc' }],
        ['unknown kind', { kind: 'wat', lhs: 'a' }],
        ['not an object', 'Affection>=40'],
    ];
    for (const [why, descriptor] of REFUSALS) {
        it(`refuses: ${why}`, () => expect(formatToken(descriptor)).toBeNull());
    }

    // '&' is the one refusal a token-level round-trip CANNOT justify — the token parses fine on its
    // own and only breaks once joined into a chain. Without this the builder could emit a condition
    // that silently becomes two.
    it("refuses '&' anywhere, because it SPLITS the token once joined into a chain", () => {
        expect(formatToken({ kind: 'cmp', lhs: 'a&b', op: '=', rhs: '1' })).toBeNull();
        expect(formatToken({ kind: 'cmp', lhs: 'a', op: '=', rhs: 'b&c' })).toBeNull();
        expect(formatToken({ kind: 'present', name: 'a&b' })).toBeNull();
        expect(formatToken({ kind: 'in', lhs: 'Mood', set: ['a&b'] })).toBeNull();
    });
});

describe('THE ROUND-TRIP PROPERTY — parseToken(formatToken(d)) deep-equals d', () => {
    // Layer 1: every descriptor the fixed tables above produce.
    const CANONICAL = [
        { kind: 'none' },
        { kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' },
        { kind: 'cmp', lhs: 'Loc', op: '=', rhs: 'Outskirts.AncientRuins' },
        { kind: 'cmp', lhs: 'T', op: '>=', rhs: '16:00' },
        { kind: 'cmp', lhs: 'Mainchar.Money', op: '>=', rhs: '100' },
        { kind: 'cmp', lhs: 'Quest(Leila).Step', op: '==', rhs: '0' },
        { kind: 'in', lhs: 'Mood', set: ['Happy', 'Excited'] },
        { kind: 'in', lhs: 'Mood', set: ['Happy'] },
        { kind: 'present', name: 'Mitsuki' },
        { kind: 'present', name: '橘美月' },
        { kind: 'flag', flag: 'leila_1', state: 'done' },
        { kind: 'flag', flag: 'leila_1', state: 'failed' },
    ];
    it('round-trips every canonical descriptor', () => {
        for (const d of CANONICAL) {
            const text = formatToken(d);
            expect(text, `formatToken refused ${JSON.stringify(d)}`).not.toBeNull();
            expect(parseToken(text), `round-trip broke on ${JSON.stringify(d)} → ${text}`).toEqual(d);
        }
    });

    // The SECOND property: an already-canonical STRING survives text → descriptor → text. This is what
    // catches an accidental change to the canonical spelling (the general
    // formatToken(parseToken(s)) === s is NOT achievable — 'A>=1' / 'A >= 1' / ' A >= 1 ' all parse to
    // one descriptor — so it is asserted only on strings already in canonical form).
    it('a canonical STRING survives text → descriptor → text unchanged', () => {
        for (const s of ['gf>=0', 'Loc=Outskirts.AncientRuins', 'T>=16:00', 'Mood in {Happy,Excited}',
            'Present(Mitsuki)', 'flag:leila_1', 'flag:leila_1=failed', '']) {
            expect(formatToken(parseToken(s)), `canonical spelling changed for ${s}`).toBe(s);
        }
    });

    // Layer 2: the deterministic cross-product. This is where the value is — it reaches combinations
    // nobody thinks to hand-write. The assertion is deliberately weak-but-total: EITHER refuse, OR
    // round-trip exactly. What it forbids is the third outcome — emitting something that reads back
    // as a DIFFERENT condition, which is the only failure that reaches a pack silently.
    const HOSTILE = [
        'a', 'Aff(Mitsuki)', 'Mainchar.Money', '橘美月', '0', '16:00', 'a b',
        'a,b', 'a}b', 'a{b', 'a>=b', 'a in b', 'a&b', '!a', '', '   ', ' a ', 'a(b', 'a)b', 'a=b',
        'a\nb', '((', 'done', '_x', 'x-y',
    ];
    it('cross-product: every descriptor either REFUSES or round-trips exactly — never a third answer', () => {
        const lies = [];
        const check = (d) => {
            const text = formatToken(d);
            if (text === null) return;                       // refusing is always allowed
            const back = parseToken(text);
            if (JSON.stringify(back) !== JSON.stringify(d)) lies.push({ d, text, back });
        };
        for (const v of HOSTILE) {
            check({ kind: 'present', name: v });
            check({ kind: 'flag', flag: v, state: 'done' });
            check({ kind: 'flag', flag: 'x', state: v });
            check({ kind: 'in', lhs: v, set: ['a'] });
            check({ kind: 'in', lhs: 'Mood', set: [v] });
            check({ kind: 'in', lhs: 'Mood', set: ['a', v] });
            for (const op of ['>=', '<=', '==', '=', '>', '<']) {
                check({ kind: 'cmp', lhs: v, op, rhs: '1' });
                check({ kind: 'cmp', lhs: 'a', op, rhs: v });
            }
        }
        // Reported as data: a failure names the descriptor, what was emitted, and how it read back.
        expect(lies).toEqual([]);
    });
});

describe('formatTokenChain — descriptors → one &-joined predicate', () => {
    it('joins with " & ", matching shipped content', () => {
        expect(formatTokenChain([
            { kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' },
            { kind: 'cmp', lhs: 'Loc', op: '=', rhs: 'Outskirts.AncientRuins' },
            { kind: 'cmp', lhs: 'T', op: '>=', rhs: '16:00' },
        ])).toBe('gf>=0 & Loc=Outskirts.AncientRuins & T>=16:00');
    });

    it('DROPS none-tokens rather than leaving a blank slot in the chain', () => {
        expect(formatTokenChain([{ kind: 'none' }, { kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' }])).toBe('gf>=0');
        expect(formatTokenChain([{ kind: 'none' }])).toBe('');
        expect(formatTokenChain([])).toBe('');
    });

    // The important one: a partial chain is a DIFFERENT predicate. Dropping the condition that failed
    // to serialize is how an event fires when it should not.
    it('refuses the WHOLE chain if any token is unemittable — never emits a partial predicate', () => {
        expect(formatTokenChain([
            { kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' },
            { kind: 'flag', flag: 'bad-key', state: 'done' },
        ])).toBeNull();
        expect(formatTokenChain('nope')).toBeNull();
    });

    it('every chain it emits parses back to the same tokens', () => {
        const ds = [
            { kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' },
            { kind: 'in', lhs: 'Mood', set: ['Happy', 'Excited'] },
            { kind: 'present', name: 'Mitsuki' },
            { kind: 'flag', flag: 'leila_1', state: 'done' },
        ];
        const chain = formatTokenChain(ds);
        expect(chain.split('&').map((t) => parseToken(t))).toEqual(ds);
    });
});

// ── THE DRIFT GUARD ─────────────────────────────────────────────────────────
// Skips ONLY when no sibling game repo is checked out (a contributor without it still gets a green
// suite). A checkout whose engine is not where the three-file sync header says FAILS here: a guard that
// skips on a moved file is a green suite not running the test it claims. schoolv4Dir() carries the
// MVU_GAME_MAKER_DIR override for a differently-named checkout.
const haveRepo = haveSchoolv4();
const ENGINE = path.join(schoolv4Dir(), '..', '_engine', 'eventpack.cjs');

describe.skipIf(!haveRepo)('DRIFT GUARD — the vendored copy vs the REAL engine parseToken', () => {
    it('the engine source is where the three-file sync header says (a moved file must FAIL, not skip)', () => {
        expect(existsSync(ENGINE), `missing: ${ENGINE}`).toBe(true);
    });
    const engine = existsSync(ENGINE) ? createRequire(import.meta.url)(ENGINE) : null;

    it('the engine still EXPORTS parseToken + formatToken (renaming must fail loudly, not silently skip)', () => {
        expect(typeof engine.parseToken).toBe('function');
        expect(typeof engine.formatToken).toBe('function');
        expect(typeof engine.formatTokenChain).toBe('function');
    });

    // The emit direction needs its OWN drift check: a vendored formatToken that disagreed with the
    // engine's would produce packs the runtime reads differently — the P6 defect, arriving through
    // the writer instead of the lint.
    it('agrees with the engine on formatToken over the descriptor corpus, refusals included', () => {
        const DESCRIPTORS = [
            { kind: 'none' },
            { kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' },
            { kind: 'cmp', lhs: 'Loc', op: '=', rhs: 'Outskirts.AncientRuins' },
            { kind: 'in', lhs: 'Mood', set: ['Happy', 'Excited'] },
            { kind: 'in', lhs: 'Mood', set: [] },
            { kind: 'present', name: 'Mitsuki' },
            { kind: 'flag', flag: 'leila_1', state: 'done' },
            { kind: 'flag', flag: 'leila_1', state: 'failed' },
            { kind: 'flag', flag: 'leila-1', state: 'done' },
            { kind: 'cmp', lhs: 'a&b', op: '=', rhs: '1' },
            { kind: 'cmp', lhs: '!a', op: '=', rhs: '1' },
            { kind: 'present', name: ' Mitsuki ' },
            { kind: 'wat' },
        ];
        const disagreements = [];
        for (const d of DESCRIPTORS) {
            const mine = formatToken(d);
            const theirs = engine.formatToken(d);
            if (mine !== theirs) disagreements.push({ d, vendored: mine, engine: theirs });
        }
        expect(disagreements).toEqual([]);
    });

    it('agrees with the engine on formatWhenAny — the OR writer is vendored too', () => {
        const groups = [[{ kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' }], [{ kind: 'present', name: 'Mitsuki' }, { kind: 'flag', flag: 'leila_1', state: 'done' }]];
        const refused = [[{ kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' }], [{ kind: 'flag', flag: 'bad-key', state: 'done' }]];
        expect(formatWhenAny(groups)).toEqual(engine.formatWhenAny(groups));
        expect(formatWhenAny(refused)).toBe(engine.formatWhenAny(refused));
        expect(formatWhenAny([])).toBe(engine.formatWhenAny([]));
    });

    it('agrees with the engine on formatTokenChain, including the all-or-nothing refusal', () => {
        const chain = [{ kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' }, { kind: 'present', name: 'Mitsuki' }];
        const bad = [{ kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' }, { kind: 'flag', flag: 'bad-key', state: 'done' }];
        expect(formatTokenChain(chain)).toBe(engine.formatTokenChain(chain));
        expect(formatTokenChain(bad)).toBe(engine.formatTokenChain(bad));
    });

    // Cross-check the round-trip through BOTH sides: the vendored writer's output must be readable by
    // the REAL engine parser, which is the pairing that actually happens in production (builder emits,
    // engine evaluates).
    it('the vendored writer emits what the ENGINE parser reads back identically', () => {
        for (const d of [
            { kind: 'cmp', lhs: 'gf', op: '>=', rhs: '0' },
            { kind: 'in', lhs: 'Mood', set: ['Happy', 'Excited'] },
            { kind: 'present', name: '橘美月' },
            { kind: 'flag', flag: 'leila_1', state: 'done' },
        ]) {
            const text = formatToken(d);
            expect(engine.parseToken(text), `engine misread the vendored writer's "${text}"`).toEqual(d);
        }
    });

    it('agrees with the engine on every token in the corpus', () => {
        const disagreements = [];
        for (const tok of CORPUS) {
            const mine = parseToken(tok);
            const theirs = engine.parseToken(tok);
            if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
                disagreements.push({ tok, vendored: mine, engine: theirs });
            }
        }
        // Reported as data, not a bare boolean: on failure the diff names the token and both readings.
        expect(disagreements).toEqual([]);
    });

    // eventpack_revisit rows 16-17: a BARE adapter — declarations only — resolves an alias, DaysSince(),
    // Present() and flag: inside the engine. No resolver code, no applier, nothing genre-side but data.
    it('a bare adapter of declarations resolves aliases, DaysSince, Present and flag in the engine', () => {
        const get = (t, d) => (Array.isArray(t) && t.length === 2 && typeof t[1] === 'string') ? t[0] : (t === undefined ? d : t);
        const warned = [];
        const adapter = {
            get, warn: (m) => warned.push(m), triggerRoot: 'Story.triggers',
            aliases: { 'Aff(*)': 'Cast.*.Affection', Loc: 'World.Location' }, presence: 'Cast.*.Here',
            daysSince: (sd, stamp) => engine.civilDaysSince('2026-04-10 12:00', stamp),
        };
        const sd = {
            World: { Location: ['Ruins', 'L'] },
            Cast: { Mitsuki: { Affection: [35, 'A'], Here: [true, 'H'], Seen: '2026-04-07' } },
            Story: { triggers: {}, fired: { met: { state: 'done', scope: 'save' } } },   // the library's own root, beside the declared trigger table
        };
        expect(engine.evalTokens(sd, 'Aff(Mitsuki)>=30 & Loc=Ruins & Present(Mitsuki) & DaysSince(Cast.Mitsuki.Seen)>=3 & flag:met & !Present(Nobody)', adapter)).toBe(true);
        expect(engine.evalOne(sd, 'DaysSince(Cast.Mitsuki.Seen)>=4', adapter)).toBe(false);
        expect(warned).toEqual([]);
    });

    it('the engine file still names when-dsl-grammar.js as its consumer, so a future editor is warned', () => {
        const src = readFileSync(ENGINE, 'utf8');
        expect(src).toMatch(/parseToken/);
        expect(src).toMatch(/ONE GRAMMAR SOURCE|§6\.5\.1|mvu-helper/);
    });
});

// ── THE TWIN GUARD — copy 2 (this repo) vs copy 3 (MvuStatMenuBuilder) ─────────────────────
// The two vendored grammar files are byte-identical by contract (the sync header in each). The
// builder's tools/check-grammar-drift.mjs proves the pair from its side; this proves it from ours on
// every `npm test`. Same skip rule as above: no builder checkout ⇒ skip; a checkout without the file
// ⇒ FAIL. MVU_STATUSMENU_BUILDER_DIR overrides the sibling lookup for a differently-named checkout.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINE = path.resolve(HERE, '..', 'src', 'features', 'event-pack', 'when-dsl-grammar.js');
const BUILDER_NAMES = ['MVU_Zod_StatusMenuBuilder-dev', 'MVU_Zod_StatusMenuBuilder', 'MvuStatMenuBuilder'];
function builderRepoRoot() {
    const override = process.env.MVU_STATUSMENU_BUILDER_DIR;
    if (override) return existsSync(override) ? override : null;
    for (const name of BUILDER_NAMES) {
        const dir = path.resolve(HERE, '..', '..', name);
        if (existsSync(dir)) return dir;
    }
    return null;
}
const BUILDER_ROOT = builderRepoRoot();
const TWIN = BUILDER_ROOT ? path.join(BUILDER_ROOT, 'landing-app', 'src', 'utils', 'when-dsl-grammar.js') : null;

describe.skipIf(!BUILDER_ROOT)('TWIN GUARD — this vendored grammar vs MvuStatMenuBuilder\'s copy', () => {
    it('the builder checkout carries the twin where the sync header says (a moved file must FAIL, not skip)', () => {
        expect(existsSync(TWIN), `missing: ${TWIN}`).toBe(true);
    });

    it('the two copies are byte-identical (line endings normalised)', () => {
        const mine = readFileSync(MINE, 'utf8').replace(/\r\n/g, '\n').split('\n');
        const theirs = readFileSync(TWIN, 'utf8').replace(/\r\n/g, '\n').split('\n');
        let first = 0;
        while (first < Math.max(mine.length, theirs.length) && mine[first] === theirs[first]) first++;
        // Reported as the first differing LINE, so the failure says where to look, not just that they differ.
        const diff = first < Math.max(mine.length, theirs.length)
            ? { line: first + 1, mvuHelper: mine[first], builder: theirs[first] }
            : null;
        expect(diff).toBeNull();
    });
});
