// tests/roll-pool.test.js — the §9c rollPool dealer (LOGIC_ENGINE_PLAN §9c).
//
// Everything here runs against createRollPoolDealer from logic-engine-core.js — the pure factory —
// with deterministic injected rollers where the CACHE semantics are under test, and the real
// rollers where the DICE themselves are. roll-pool.js (the live instance + its GENERATION_STARTED
// wiring) imports ST's script.js and is exercised live; it contains no logic of its own.
//
// The one property that can actually bite (the "point 1" risk from the design review): the epoch
// bump is load-bearing. Cache outliving a generation = a swipe silently reuses the old pool —
// killing the exact freshness School v4 hand-wrote crypto to get when it rejected {{roll:d20}}.

import { describe, it, expect } from 'vitest';
import { cryptoDicePool, seededDicePool, diceRequestProblem, createRollPoolDealer, isStoryTurnGenerationType } from '../src/features/logic-engine/logic-engine-core.js';

describe('cryptoDicePool — the crypto roller, any face count', () => {
    it('deals the requested count, every die an integer 1..20 by default', () => {
        const dice = cryptoDicePool(100);
        expect(dice).toHaveLength(100);
        for (const d of dice) {
            expect(Number.isInteger(d)).toBe(true);
            expect(d).toBeGreaterThanOrEqual(1);
            expect(d).toBeLessThanOrEqual(20);
        }
    });
    it('covers the full face range over a large sample (reject-sampling sanity, not a stats test)', () => {
        const seen = new Set(cryptoDicePool(5000, 20));
        for (let face = 1; face <= 20; face++) expect(seen.has(face), `face ${face} never rolled in 5000`).toBe(true);
    });
    it.each([2, 6, 100])('a d%i stays in range and shows every face over a large sample', (sides) => {
        const dice = cryptoDicePool(sides * 60, sides);
        for (const d of dice) {
            expect(Number.isInteger(d)).toBe(true);
            expect(d).toBeGreaterThanOrEqual(1);
            expect(d).toBeLessThanOrEqual(sides);
        }
        const seen = new Set(dice);
        for (let face = 1; face <= sides; face++) expect(seen.has(face), `face ${face} of d${sides} never rolled`).toBe(true);
    });
});

describe('seededDicePool — the hash path (swipe-stable dice)', () => {
    it('same (count, hash) → the identical pool, forever', () => {
        expect(seededDicePool(6, 'chat42|mid7|abc')).toEqual(seededDicePool(6, 'chat42|mid7|abc'));
    });
    // A seeded d20 must deal exactly what it dealt before `sides` existed — a saved boss fight's dice
    // depend on it. The vector was taken from the d20-only build and matched by this one (2026-10-03).
    it('a d20 deals the same sequence as the d20-only dealer did', () => {
        expect(seededDicePool(8, 'golden-vector')).toEqual([16, 14, 20, 15, 19, 18, 7, 8]);
        expect(seededDicePool(8, 'golden-vector', 20)).toEqual([16, 14, 20, 15, 19, 18, 7, 8]);
    });
    it('a different hash → a different pool (fixed seeds chosen to differ)', () => {
        expect(seededDicePool(8, 'boss-fight-1')).not.toEqual(seededDicePool(8, 'boss-fight-2'));
    });
    it('range holds on the seeded path too, for any face count', () => {
        for (const sides of [20, 6, 100]) {
            for (const d of seededDicePool(200, 'range-check', sides)) {
                expect(d).toBeGreaterThanOrEqual(1);
                expect(d).toBeLessThanOrEqual(sides);
            }
        }
    });
    it('growing the count keeps the shorter pool as a prefix (same seed, same sequence)', () => {
        expect(seededDicePool(8, 'prefix').slice(0, 4)).toEqual(seededDicePool(4, 'prefix'));
        expect(seededDicePool(8, 'prefix', 6).slice(0, 4)).toEqual(seededDicePool(4, 'prefix', 6));
    });
});

// A deterministic roller that stamps which call dealt each die: call #1 deals 101, 102…; call #2
// deals 201, 202… — so "same pool" vs "fresh pool" vs "extended pool" is readable off the values.
function stampedRoller() {
    let call = 0;
    return (count) => { call += 1; return Array.from({ length: count }, (_, i) => call * 100 + i + 1); };
}

describe('createRollPoolDealer — epoch cache + receipt', () => {
    const newDealer = () => createRollPoolDealer({ rollFresh: stampedRoller(), rollSeeded: (n, h) => Array.from({ length: n }, (_, i) => `${h}:${i}`) });
    const start = (dealer) => dealer.noteGenerationStarted('normal', false);

    it('idempotent within a generation: repeated renders (dry runs, token counts) see ONE deal', () => {
        const dealer = newDealer();
        start(dealer);
        const first = dealer.rollPool(4);
        expect(dealer.rollPool(4)).toEqual(first);
        expect(dealer.rollPool(4)).toEqual(first);
        expect(first).toEqual([101, 102, 103, 104]);   // exactly one rollFresh call
    });
    it('fresh per generation: the epoch bump re-deals — a swipe NEVER reuses the old pool', () => {
        const dealer = newDealer();
        start(dealer);
        const gen1 = dealer.rollPool(4);
        start(dealer);                                  // the swipe/regen
        const gen2 = dealer.rollPool(4);
        expect(gen2).not.toEqual(gen1);
        expect(gen2).toEqual([201, 202, 203, 204]);
    });
    it('a dry run does NOT advance the epoch (prompt assembly is not a generation)', () => {
        const dealer = newDealer();
        start(dealer);
        const real = dealer.rollPool(4);
        expect(dealer.noteGenerationStarted('normal', true)).toBe(false);
        expect(dealer.rollPool(4)).toEqual(real);
    });
    it('`continue` does NOT advance the epoch — the reply keeps the pool its prose already consumed', () => {
        const dealer = newDealer();
        start(dealer);
        const original = dealer.rollPool(4);
        expect(dealer.noteGenerationStarted('continue', false)).toBe(false);
        expect(dealer.rollPool(4)).toEqual(original);
    });
    // `quiet` is NOT a dry run — ST fires GENERATION_STARTED with dryRun=false and runs interceptors
    // (script.js:4240 / 4503-4505). The Summarize extension fires one right after a message, i.e.
    // squarely between the narrate prompt build and RES. Without this guard the receipt is replaced
    // and RES emits a FALSE "CHECK DIE NOT FROM POOL" against the pool the narrator actually read.
    it.each(['quiet', 'impersonate'])('a `%s` generation does NOT re-deal — it is not a turn of the story', (type) => {
        const dealer = newDealer();
        start(dealer);
        const turnPool = dealer.rollPool(8);
        expect(dealer.noteGenerationStarted(type, false)).toBe(false);
        expect(dealer.rollPool(8)).toEqual(turnPool);
        expect(dealer.currentDealtPool()).toEqual(turnPool);   // the receipt RES will verify against
    });
    it('a real turn AFTER a quiet interruption still re-deals (the guard skips, it does not latch)', () => {
        const dealer = newDealer();
        start(dealer);
        const first = dealer.rollPool(4);
        dealer.noteGenerationStarted('quiet', false);
        start(dealer);                                          // the next real turn
        expect(dealer.rollPool(4)).not.toEqual(first);
    });
    it('growth appends, shrink slices — the prefix (①) never moves within an epoch', () => {
        const dealer = newDealer();
        start(dealer);
        const four = dealer.rollPool(4);
        const eight = dealer.rollPool(8);
        expect(eight.slice(0, 4)).toEqual(four);        // ① is still ①
        expect(eight.slice(4)).toEqual([201, 202, 203, 204]);   // the extension was a fresh roll
        expect(dealer.rollPool(2)).toEqual(four.slice(0, 2));
    });
    // No-fallback rule: a bad ask deals NOTHING and says which argument was wrong. Until 2026-10-03 a
    // missing count silently dealt School v4's classic 4 and an oversized one was clamped to 20.
    it.each([undefined, 'x', '4', 0, -3, 2.5, 21, 9999])('count %s is refused — no dice, nothing coerced', (count) => {
        const dealer = newDealer();
        start(dealer);
        expect(dealer.rollPool(count)).toEqual([]);
        expect(dealer.currentDealtPool()).toBe(null);           // nothing entered the receipt either
    });
    it('the refusal names its cause and is said once per generation per reason', () => {
        const reasons = [];
        const dealer = createRollPoolDealer({ rollFresh: stampedRoller(), onRefused: (reason) => reasons.push(reason) });
        start(dealer);
        dealer.rollPool(25);
        dealer.rollPool(25);                                    // a re-render repeats the bad ask
        dealer.rollPool(4, null, 'X', 1);
        expect(reasons).toHaveLength(2);
        expect(reasons[0]).toMatch(/count must be a whole number from 1 to 20 \(got 25\)/);
        expect(reasons[1]).toMatch(/sides must be a whole number from 2 to 1000 \(got 1\)/);
        start(dealer);                                          // next generation: said again
        dealer.rollPool(25);
        expect(reasons).toHaveLength(3);
    });
    it('the hash path bypasses the POOL cache but ENTERS the receipt (R3/D-R2: boss dice are verifiable)', () => {
        const dealer = newDealer();
        start(dealer);
        const fresh = dealer.rollPool(4);
        expect(dealer.rollPool(3, 'boss')).toEqual(['boss:0', 'boss:1', 'boss:2']);
        expect(dealer.rollPool(4)).toEqual(fresh);              // pool cache untouched — fresh dice unchanged
        expect(dealer.currentDealtPool()).toEqual([...fresh, 'boss:0', 'boss:1', 'boss:2']);
    });

    it('seeded receipt is idempotent per hash, keeps the LONGEST deal, and dies with the epoch', () => {
        const dealer = newDealer();
        start(dealer);
        dealer.rollPool(2, 'boss');
        dealer.rollPool(2, 'boss');                             // same ask twice → recorded once
        expect(dealer.currentDealtPool()).toEqual(['boss:0', 'boss:1']);
        dealer.rollPool(3, 'boss');                             // growth: the longer deal replaces (same prefix)
        dealer.rollPool(1, 'boss');                             // a shorter re-ask must NOT shrink the record
        expect(dealer.currentDealtPool()).toEqual(['boss:0', 'boss:1', 'boss:2']);
        start(dealer);                                          // new generation
        expect(dealer.currentDealtPool()).toBe(null);           // seeded records do not survive the bump either
    });

    it('a generation dealing ONLY seeded dice has a receipt — it is no longer invisible to resolvers', () => {
        const dealer = newDealer();
        start(dealer);
        dealer.rollPool(2, 'boss');
        expect(dealer.currentDealtPool()).toEqual(['boss:0', 'boss:1']);
    });
    it('the receipt: current epoch\'s deal as a COPY; null before any deal and after an undealt bump', () => {
        const dealer = newDealer();
        expect(dealer.currentDealtPool()).toBe(null);           // nothing ever dealt
        start(dealer);
        const dealtPool = dealer.rollPool(4);
        const receipt = dealer.currentDealtPool();
        expect(receipt).toEqual(dealtPool);
        receipt.push(999);                                      // a caller mutating its copy…
        expect(dealer.currentDealtPool()).toEqual(dealtPool);   // …cannot corrupt the receipt
        start(dealer);                                          // new generation, nothing dealt yet
        expect(dealer.currentDealtPool()).toBe(null);           // stale receipt must NOT accuse the new turn
    });
    it('a page-load preload deal (epoch 0, before any generation) is discarded by the first real bump', () => {
        const dealer = newDealer();
        const preload = dealer.rollPool(4);                     // ST-Prompt-Template's WI preload path
        start(dealer);
        expect(dealer.rollPool(4)).not.toEqual(preload);        // the real generation never eats a preload pool
    });
});

// Faces: the caller's choice, never the dealer's. A pool is a NAME and a FACE COUNT.
describe('createRollPoolDealer — die faces', () => {
    // A roller that stamps the face count it was asked for, so pool identity is readable off the values.
    const facedRoller = () => {
        let call = 0;
        return (count, sides) => { call += 1; return Array.from({ length: count }, (_, i) => `d${sides}#${call}.${i + 1}`); };
    };
    const newDealer = () => createRollPoolDealer({ rollFresh: facedRoller(), rollSeeded: (n, h, sides) => Array.from({ length: n }, (_, i) => `${h}:d${sides}:${i}`) });
    const start = (dealer) => dealer.noteGenerationStarted('normal', false);

    it('omitted and null sides both mean a d20 — every call written before `sides` is unchanged', () => {
        const dealer = newDealer();
        start(dealer);
        const legacy = dealer.rollPool(2, null, 'PRE');
        expect(legacy).toEqual(['d20#1.1', 'd20#1.2']);
        expect(dealer.rollPool(2, null, 'PRE', null)).toEqual(legacy);
        expect(dealer.rollPool(2, null, 'PRE', 20)).toEqual(legacy);
    });
    it('the roller is asked for the requested faces', () => {
        const dealer = newDealer();
        start(dealer);
        expect(dealer.rollPool(2, null, 'MOVE', 6)).toEqual(['d6#1.1', 'd6#1.2']);
        expect(dealer.rollPool(1, 'boss', null, 100)).toEqual(['boss:d100:0']);
    });
    it('MOVE in d6 and MOVE in d20 are two pools — they never share a slot', () => {
        const dealer = newDealer();
        start(dealer);
        const six = dealer.rollPool(2, null, 'MOVE', 6);
        const twenty = dealer.rollPool(2, null, 'MOVE', 20);
        expect(twenty).toEqual(['d20#2.1', 'd20#2.2']);
        expect(dealer.rollPool(2, null, 'MOVE', 6)).toEqual(six);
    });
    it.each([1, 0, -6, 6.5, '6', 1001])('sides %s is refused — no dice', (sides) => {
        const dealer = newDealer();
        start(dealer);
        expect(dealer.rollPool(2, null, 'MOVE', sides)).toEqual([]);
    });
    it('currentDealtPools keeps each pool\'s identity; currentDealtPool stays the flat union', () => {
        const dealer = newDealer();
        expect(dealer.currentDealtPools()).toBe(null);           // nothing dealt yet
        start(dealer);
        dealer.rollPool(2, null, 'MOVE', 6);
        dealer.rollPool(1);
        dealer.rollPool(1, 'boss', null, 100);
        expect(dealer.currentDealtPools()).toEqual([
            { pool: 'MOVE', sides: 6, dice: ['d6#1.1', 'd6#1.2'] },
            { pool: 'default', sides: 20, dice: ['d20#2.1'] },
            { hash: 'boss', sides: 100, dice: ['boss:d100:0'] },
        ]);
        expect(dealer.currentDealtPool()).toEqual(['d6#1.1', 'd6#1.2', 'd20#2.1', 'boss:d100:0']);
        const receipt = dealer.currentDealtPools();
        receipt[0].dice.push('forged');                         // a caller mutating its copy…
        expect(dealer.currentDealtPools()[0].dice).toEqual(['d6#1.1', 'd6#1.2']);   // …cannot corrupt the receipt
        start(dealer);
        expect(dealer.currentDealtPools()).toBe(null);           // dies with the epoch, like the flat receipt
    });
});

// diceRequestProblem is the dealer's whole input check — one sentence per cause.
describe('diceRequestProblem', () => {
    it('is empty for a valid ask, and names the argument at fault otherwise', () => {
        expect(diceRequestProblem(4, 20)).toBe('');
        expect(diceRequestProblem(20, 2)).toBe('');
        expect(diceRequestProblem(1, 1000)).toBe('');
        expect(diceRequestProblem(0, 20)).toMatch(/^count /);
        expect(diceRequestProblem(4, 1001)).toMatch(/^sides /);
        expect(diceRequestProblem('4', 20)).toMatch(/got "4"/);   // a string says it is a string
    });
});

// Named pools: independent consumers (a PRE call vs the narrator window) hold their OWN dice under
// ONE epoch — slot collisions impossible by construction, receipt = the union (§9c is membership-only).
describe('createRollPoolDealer — named pools', () => {
    const newDealer = () => createRollPoolDealer({ rollFresh: stampedRoller(), rollSeeded: (n, h) => Array.from({ length: n }, (_, i) => `${h}:${i}`) });
    const start = (dealer) => dealer.noteGenerationStarted('normal', false);

    it('a named pool deals its OWN dice, independent of the default pool, and is idempotent like it', () => {
        const dealer = newDealer();
        start(dealer);
        const narrator = dealer.rollPool(4);                    // default pool
        const pre = dealer.rollPool(3, null, 'PRE');            // the call's own pool
        expect(narrator).toEqual([101, 102, 103, 104]);
        expect(pre).toEqual([201, 202, 203]);                   // a SECOND rollFresh — not a slice of the first
        expect(dealer.rollPool(3, null, 'PRE')).toEqual(pre);   // re-render sees the same deal
        expect(dealer.rollPool(4)).toEqual(narrator);           // and never disturbs the other pool
    });
    it('the epoch bump re-deals EVERY pool — no pool survives into the next turn', () => {
        const dealer = newDealer();
        start(dealer);
        const narrator1 = dealer.rollPool(4);
        const pre1 = dealer.rollPool(3, null, 'PRE');
        start(dealer);                                          // swipe/regen
        expect(dealer.rollPool(3, null, 'PRE')).not.toEqual(pre1);
        expect(dealer.rollPool(4)).not.toEqual(narrator1);
    });
    it('growth appends PER POOL — a named pool\'s prefix never moves, the default pool untouched', () => {
        const dealer = newDealer();
        start(dealer);
        const narrator = dealer.rollPool(4);
        const preThree = dealer.rollPool(3, null, 'PRE');
        const preFive = dealer.rollPool(5, null, 'PRE');
        expect(preFive.slice(0, 3)).toEqual(preThree);          // ① is still ① inside the pool
        expect(dealer.rollPool(4)).toEqual(narrator);
    });
    it('the receipt is the UNION of every dealt pool (membership check needs no pool identity)', () => {
        const dealer = newDealer();
        start(dealer);
        const narrator = dealer.rollPool(4);
        const pre = dealer.rollPool(3, null, 'PRE');
        const receipt = dealer.currentDealtPool();
        for (const d of [...narrator, ...pre]) expect(receipt).toContain(d);
        expect(receipt).toHaveLength(narrator.length + pre.length);
    });
    it('no name, null, empty and whitespace names all mean the DEFAULT pool (legacy calls unchanged)', () => {
        const dealer = newDealer();
        start(dealer);
        const unnamed = dealer.rollPool(4);
        expect(dealer.rollPool(4, null, null)).toEqual(unnamed);
        expect(dealer.rollPool(4, null, '')).toEqual(unnamed);
        expect(dealer.rollPool(4, null, '   ')).toEqual(unnamed);
    });
    it('the hash path still bypasses the POOL cache even when a pool is named — and a name colliding with a hash string cannot clobber it', () => {
        const dealer = newDealer();
        start(dealer);
        const pre = dealer.rollPool(3, null, 'PRE');
        expect(dealer.rollPool(3, 'boss', 'PRE')).toEqual(['boss:0', 'boss:1', 'boss:2']);
        expect(dealer.rollPool(3, null, 'PRE')).toEqual(pre);   // pool cache untouched
        const named = dealer.rollPool(2, null, 'boss');         // a FRESH pool literally named 'boss'
        expect(dealer.rollPool(2, null, 'boss')).toEqual(named); // …keeps its prefix despite the seeded record
        expect(dealer.currentDealtPool()).toEqual([...pre, ...named, 'boss:0', 'boss:1', 'boss:2']);
    });
});

// The PRE interceptor's skip guard decides on this same predicate (extra-llm-calls.js). It lives in
// the pure half so the decision is reachable from a test at all (L6): the interceptor itself is
// host-coupled and cannot be opened here.
describe('isStoryTurnGenerationType — the ONE definition the dealer and the PRE interceptor share', () => {
    it.each(['continue', 'quiet', 'impersonate'])('`%s` is NOT a turn of the story', (type) => {
        expect(isStoryTurnGenerationType(type)).toBe(false);
    });
    it.each([undefined, '', 'normal', 'regenerate', 'swipe'])('%s IS a turn of the story', (type) => {
        expect(isStoryTurnGenerationType(type)).toBe(true);
    });
    it('the dealer advances its epoch exactly when the predicate says the generation is a turn', () => {
        const dealer = createRollPoolDealer({ rollFresh: (n) => Array.from({ length: n }, (_, i) => i + 1) });
        dealer.noteGenerationStarted('normal', false);
        for (const type of ['continue', 'quiet', 'impersonate', 'regenerate', 'swipe']) {
            expect(dealer.noteGenerationStarted(type, false)).toBe(isStoryTurnGenerationType(type));
        }
    });
});
