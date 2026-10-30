// turn-phase-signal-core unit tests — the PRE/POST busy signal's counting. v0.1
//
// Everything here is about a listener that latches UI on the two edges. Both ways of getting the
// count wrong are silent to us and loud to the player: emit too often and the indicator flickers per
// call; drop to zero early and it disappears while the pass is still running — the exact failure the
// signal was added to end.
import { describe, it, expect } from 'vitest';
import {
  createPhaseLedger, openPhase, closePhase, phasesOpen,
} from '../src/features/small-llm/turn-phase-signal-core.js';

describe('turn phase ledger', () => {
  it('announces on the idle→busy edge and on the busy→idle edge, and nowhere else', () => {
    const ledger = createPhaseLedger();
    expect(openPhase(ledger, 'pre').announce).toBe(true);
    expect(closePhase(ledger, 'pre').announce).toBe(true);
  });

  it('MORE THAN ONE PRE: a pass of five calls still looks like one open and one close', () => {
    const ledger = createPhaseLedger();
    const opens = [1, 2, 3, 4, 5].map(() => openPhase(ledger, 'pre').announce);
    expect(opens).toEqual([true, false, false, false, false]);
    const closes = [1, 2, 3, 4, 5].map(() => closePhase(ledger, 'pre').announce);
    expect(closes).toEqual([false, false, false, false, true]);
  });

  it('PRE AND POST are one busy window when they overlap — the close of the FIRST is not idle', () => {
    const ledger = createPhaseLedger();
    expect(openPhase(ledger, 'pre').announce).toBe(true);
    expect(openPhase(ledger, 'post').announce).toBe(false);
    expect(closePhase(ledger, 'pre').announce).toBe(false); // post is still running
    expect(closePhase(ledger, 'post').announce).toBe(true);
  });

  it('a normal turn (PRE closes, main generation, POST opens) announces both edges twice', () => {
    const ledger = createPhaseLedger();
    expect(openPhase(ledger, 'pre').announce).toBe(true);
    expect(closePhase(ledger, 'pre').announce).toBe(true);   // ST's own generation covers the gap
    expect(openPhase(ledger, 'post').announce).toBe(true);
    expect(closePhase(ledger, 'post').announce).toBe(true);
  });

  it('REFUSES a close of a phase that was never opened — it must not cancel a live one', () => {
    const ledger = createPhaseLedger();
    openPhase(ledger, 'pre');
    const stray = closePhase(ledger, 'post');
    expect(stray).toMatchObject({ unbalanced: true, announce: false });
    expect(phasesOpen(ledger)).toBe(1);                       // pre survived the stray close
    expect(closePhase(ledger, 'pre').announce).toBe(true);    // and its own close still announces
  });

  it('cannot be driven negative by repeated closes — a later open still reaches the busy edge', () => {
    const ledger = createPhaseLedger();
    openPhase(ledger, 'pre');
    closePhase(ledger, 'pre');
    closePhase(ledger, 'pre');
    closePhase(ledger, 'pre');
    expect(phasesOpen(ledger)).toBe(0);
    expect(openPhase(ledger, 'pre').announce).toBe(true);
  });

  it('counts every phase together, and an unnamed phase is still a phase', () => {
    const ledger = createPhaseLedger();
    openPhase(ledger, 'pre');
    openPhase(ledger, undefined);
    expect(phasesOpen(ledger)).toBe(2);
    expect(closePhase(ledger, 'pre').announce).toBe(false);
    expect(closePhase(ledger, undefined).announce).toBe(true);
  });
});
