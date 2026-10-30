// worldinfo-budget/worldinfo-budget-core.js — what to TELL the user when SillyTavern cut world info
// at the budget, and which number to give them.
//
// WHY THIS EXISTS. SillyTavern admits world info entries highest-`order` first and stops the moment
// the running total reaches the budget; everything below that point is silently absent from the
// prompt. Nothing in the reply says so. A card whose engine contract lives in world info then runs
// with half its rules missing and reads as a model that has stopped following instructions — the
// symptom points at the prose, and the cause is a number in the connection preset.
//
// The budget is NOT a setting of its own. It is derived:
//     maxContext = Context Size − Max Response Length          (script.js, getMaxPromptTokens)
//     budget     = round(Context % × maxContext / 100)          (world-info.js)
//     budget     = min(budget, Budget Cap)   when the cap is non-zero
// So the fix the user needs is almost always "raise Context Size to N" — and N is solvable, which is
// the whole point of this file. Telling someone the budget overflowed without the number just moves
// the guessing.
//
// PURE — no host imports, so the arithmetic is reachable by a test without a browser (L6). The
// caller reads the live numbers and passes them in.
//
// THIS MODULE DECIDES NOTHING ABOUT THE CARD. It never looks at what an entry means, only at what it
// cost. A platform cannot know whether a dropped entry mattered (L1), so it reports the fact and
// names the entries, and the person reading the toast decides.

/**
 * Rounds a token figure up to a number a human would actually type into the Context Size box.
 * Exact minimums like 336,985 invite being typed as 336,000 — one thousand short, same bug, and the
 * second hunt is worse than the first because the setting "was already changed".
 */
export function roundUpToFriendlyContextSize(tokens) {
    const value = Number(tokens);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const step = value >= 100000 ? 50000
        : value >= 10000 ? 10000
            : 1000;
    return Math.ceil(value / step) * step;
}

/**
 * The Context Size at which the world info a card actually wants would fit.
 *
 * Inverts SillyTavern's own budget formula: budget = pct × (context − response) / 100, solved for
 * the context that makes budget >= neededTokens. Returns 0 when the percentage cannot produce a
 * budget at all, which the caller reports as a different problem — no context size fixes 0%.
 */
export function requiredContextSize({ neededTokens, responseTokens, budgetPercent }) {
    const needed = Number(neededTokens);
    const response = Number(responseTokens) || 0;
    const percent = Number(budgetPercent);
    if (!Number.isFinite(needed) || needed <= 0) return 0;
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    return Math.ceil((needed * 100) / percent) + response;
}

/**
 * Works out WHICH setting is actually holding the budget down, because the obvious advice is wrong
 * in two real configurations:
 *
 *   • a non-zero Budget Cap overrides the percentage entirely, so raising Context Size moves nothing
 *     until the cap is raised too — the user would change the number, see no improvement, and
 *     reasonably conclude the diagnosis was wrong.
 *   • Context % below 100 means the context has to be raised further than the tokens alone suggest,
 *     and saying so gives them the cheaper fix as an alternative.
 *
 * `blockedBy` is one of 'cap' | 'percent' | 'context'.
 */
export function analyzeBudgetOverflow({
    neededTokens, budgetTokens, contextSize, responseTokens,
    budgetPercent, budgetCap, admittedCount, cutCount, cutNames = [],
}) {
    const needed = Math.max(0, Number(neededTokens) || 0);
    const budget = Math.max(0, Number(budgetTokens) || 0);
    const percent = Number(budgetPercent);
    const cap = Math.max(0, Number(budgetCap) || 0);

    const required = requiredContextSize({ neededTokens: needed, responseTokens, budgetPercent: percent });

    // The cap wins whenever it is set and smaller than what the card needs — no context size gets
    // past it, so that is the sentence the user needs first.
    const blockedBy = (cap > 0 && cap < needed) ? 'cap'
        : (!Number.isFinite(percent) || percent <= 0) ? 'percent'
            : 'context';

    return {
        blockedBy,
        neededTokens: needed,
        budgetTokens: budget,
        shortfallTokens: Math.max(0, needed - budget),
        contextSize: Number(contextSize) || 0,
        responseTokens: Number(responseTokens) || 0,
        budgetPercent: percent,
        budgetCap: cap,
        requiredContextSize: required,
        suggestedContextSize: roundUpToFriendlyContextSize(required),
        admittedCount: Number(admittedCount) || 0,
        cutCount: Number(cutCount) || 0,
        cutNames: Array.isArray(cutNames) ? cutNames : [],
    };
}

const thousands = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * The toast text. One paragraph, because a toast that needs scrolling gets dismissed unread: what
 * was lost, what it cost, and the exact number to type.
 */
export function formatBudgetOverflowMessage(analysis) {
    const a = analysis || {};
    const total = (a.admittedCount || 0) + (a.cutCount || 0);
    const first = a.cutNames && a.cutNames.length ? ` starting with "${a.cutNames[0]}"` : '';

    const lost = `World info was truncated — ${thousands(a.admittedCount)} of ${thousands(total)} entries were sent, `
        + `${thousands(a.cutCount)} were dropped${first}. `
        + `Your books need ${thousands(a.neededTokens)} tokens and the budget is ${thousands(a.budgetTokens)}.`;

    if (a.blockedBy === 'cap') {
        return `${lost} World Info "Budget Cap" is set to ${thousands(a.budgetCap)}, and a cap overrides Context Size — `
            + 'raise it or set it to 0 first, otherwise a bigger context changes nothing.';
    }
    if (a.blockedBy === 'percent') {
        return `${lost} World Info "Context %" is ${a.budgetPercent}%, so there is no budget to fill — raise it.`;
    }

    const percentHint = (Number.isFinite(a.budgetPercent) && a.budgetPercent < 100)
        ? ` (or raise World Info "Context %" from ${a.budgetPercent}%, which costs nothing)`
        : '';
    // The current size is only quoted when it was actually read. A confident "it is 0" would send
    // someone looking for a setting that does not say 0 anywhere.
    const current = a.contextSize > 0 ? ` — it is ${thousands(a.contextSize)}` : '';
    return `${lost} Raise Context Size to ${thousands(a.suggestedContextSize)} or more${current}${percentHint}.`;
}
