/**
 * MVU Helper — world info budget overflow advice (worldinfo-budget/worldinfo-budget-core.js).
 *
 * THE RULE THIS LOCKS: the number we put in front of the user has to actually work. A toast that
 * says "raise Context Size to N" and then overflows again at N is worse than saying nothing — the
 * setting now "has been changed", so the next hunt starts by ruling out the real cause.
 *
 * SillyTavern's own formula, which this file inverts:
 *     maxContext = Context Size − Max Response Length      (script.js:5927, getMaxPromptTokens)
 *     budget     = round(Context % × maxContext / 100)     (world-info.js:4624)
 *     budget     = Budget Cap, when the cap is non-zero and smaller
 *
 * Pure — no ST imports — so it loads under vitest.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import {
    roundUpToFriendlyContextSize,
    requiredContextSize,
    analyzeBudgetOverflow,
    formatBudgetOverflowMessage,
} from '../src/features/worldinfo-budget/worldinfo-budget-core.js';

/** SillyTavern's budget math, reproduced here ONLY so the advice can be checked against it. */
const sillyTavernBudget = (contextSize, responseTokens, percent, cap) => {
    let budget = Math.round((percent * (contextSize - responseTokens)) / 100) || 1;
    if (cap > 0 && budget > cap) budget = cap;
    return budget;
};

describe('the suggested Context Size actually fits', () => {
    // The real case that produced this feature: 21 event-body entries pushed a card's world info to
    // ~325k raw tokens against a 188,000 budget (200,000 context − 12,000 response, 100%).
    const CASES = [
        { needed: 324985, response: 12000, percent: 100 },
        { needed: 324985, response: 30000, percent: 100 },
        { needed: 324985, response: 12000, percent: 25 },   // ST's default percentage
        { needed: 50000, response: 4000, percent: 100 },
        { needed: 1, response: 0, percent: 100 },
        { needed: 700000, response: 8000, percent: 80 },
    ];

    it('MUTATION TARGET — round-trip: feeding the advice back through ST\'s formula clears the need', () => {
        for (const { needed, response, percent } of CASES) {
            const { suggestedContextSize } = analyzeBudgetOverflow({
                neededTokens: needed, budgetTokens: 1, contextSize: 200000,
                responseTokens: response, budgetPercent: percent, budgetCap: 0,
            });
            const budgetAtSuggestion = sillyTavernBudget(suggestedContextSize, response, percent, 0);
            expect(budgetAtSuggestion,
                `advice of ${suggestedContextSize} still budgets only ${budgetAtSuggestion} for ${needed} needed`)
                .toBeGreaterThanOrEqual(needed);
        }
    });

    it('the exact minimum is never rounded DOWN', () => {
        for (const { needed, response, percent } of CASES) {
            const exact = requiredContextSize({ neededTokens: needed, responseTokens: response, budgetPercent: percent });
            expect(roundUpToFriendlyContextSize(exact)).toBeGreaterThanOrEqual(exact);
        }
    });

    it('suggests a number a human would type, not an exact remainder', () => {
        expect(roundUpToFriendlyContextSize(336985)).toBe(350000);
        expect(roundUpToFriendlyContextSize(200000)).toBe(200000);
        expect(roundUpToFriendlyContextSize(54321)).toBe(60000);
        expect(roundUpToFriendlyContextSize(4200)).toBe(5000);
    });

    it('a response reserve is added on top, not taken out of the need', () => {
        // The reserve is subtracted BEFORE the percentage is applied, so it is pure addition here.
        expect(requiredContextSize({ neededTokens: 100000, responseTokens: 12000, budgetPercent: 100 })).toBe(112000);
    });
});

describe('it names the setting that is actually holding the budget down', () => {
    const base = { neededTokens: 300000, budgetTokens: 100000, contextSize: 200000, responseTokens: 12000 };

    it('MUTATION TARGET — a Budget Cap below the need blocks it, whatever the context size', () => {
        // The trap this exists for: the cap overrides the percentage outright, so "raise Context
        // Size" would be followed, change nothing, and discredit the diagnosis.
        const a = analyzeBudgetOverflow({ ...base, budgetPercent: 100, budgetCap: 100000 });
        expect(a.blockedBy).toBe('cap');
        expect(formatBudgetOverflowMessage(a)).toContain('Budget Cap');
    });

    it('a cap that is LARGER than the need is not the blocker', () => {
        const a = analyzeBudgetOverflow({ ...base, budgetPercent: 100, budgetCap: 900000 });
        expect(a.blockedBy).toBe('context');
    });

    it('a zero percentage is its own problem — no context size fixes it', () => {
        const a = analyzeBudgetOverflow({ ...base, budgetPercent: 0, budgetCap: 0 });
        expect(a.blockedBy).toBe('percent');
        expect(a.suggestedContextSize).toBe(0);
        expect(formatBudgetOverflowMessage(a)).toContain('Context %');
    });

    it('below 100%, it offers raising the percentage as the cheaper alternative', () => {
        const a = analyzeBudgetOverflow({ ...base, budgetPercent: 25, budgetCap: 0 });
        expect(a.blockedBy).toBe('context');
        expect(formatBudgetOverflowMessage(a)).toContain('Context %');
    });

    it('at 100% it does not suggest raising a percentage that is already at its maximum', () => {
        const a = analyzeBudgetOverflow({ ...base, budgetPercent: 100, budgetCap: 0 });
        expect(formatBudgetOverflowMessage(a)).not.toContain('Context %');
    });
});

describe('the message says what was lost', () => {
    const analysis = analyzeBudgetOverflow({
        neededTokens: 324985, budgetTokens: 188000, contextSize: 200000, responseTokens: 12000,
        budgetPercent: 100, budgetCap: 0, admittedCount: 33, cutCount: 35,
        cutNames: ['Event_Body_Mei', 'Event_Body_Mio'],
    });

    it('counts both halves and names the first casualty', () => {
        const message = formatBudgetOverflowMessage(analysis);
        expect(message).toContain('33 of 68 entries');
        expect(message).toContain('35 were dropped');
        expect(message).toContain('Event_Body_Mei');
    });

    it('MUTATION TARGET — it carries the number to type, and the one to replace', () => {
        const message = formatBudgetOverflowMessage(analysis);
        expect(message).toContain('350,000');   // the advice
        expect(message).toContain('200,000');   // what it is now
    });

    it('omits the current size when it could not be read, rather than claiming zero', () => {
        // Non-chat-completion APIs do not expose it, and "it is 0" sends someone hunting a setting
        // that says no such thing anywhere in the UI.
        const message = formatBudgetOverflowMessage(analyzeBudgetOverflow({
            neededTokens: 300000, budgetTokens: 100000, contextSize: undefined,
            responseTokens: 0, budgetPercent: 100, budgetCap: 0,
        }));
        expect(message).not.toContain('it is 0');
        expect(message).toContain('Raise Context Size to');
    });

    it('junk in, no throw — a malformed payload must never break the turn it is reporting on', () => {
        expect(() => formatBudgetOverflowMessage(undefined)).not.toThrow();
        expect(() => formatBudgetOverflowMessage(analyzeBudgetOverflow({}))).not.toThrow();
    });
});
