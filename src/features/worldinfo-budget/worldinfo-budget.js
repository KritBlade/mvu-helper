// worldinfo-budget/worldinfo-budget.js — say it out loud when SillyTavern cut world info at the
// budget, and name the Context Size that would have fitted.
//
// LISTEN ONLY. SillyTavern already decides this and already announces it; nothing here re-derives
// the verdict, re-scans, or counts what ST counted. Two events carry everything:
//
//   WORLDINFO_SCAN_DONE   (world-info.js) — fired after every scan loop for extensions to hook.
//                         `args.budget.overflowed` IS the flag; `args.new.all` is what activated
//                         this loop and `args.activated.entries` is what fitted, so the difference
//                         is the dropped set, by name, with no inference.
//   WORLD_INFO_ACTIVATED  — fired only on a REAL generation (`if (!isDryRun && …)`), which is the
//                         filter we need: SCAN_DONE has no dry-run marker and fires on prompt
//                         itemization and swipes too, so a toast per fire would cry wolf.
//
// THE PAYLOAD IS READ-ONLY, and that is not a style preference. Immediately after emitting,
// SillyTavern reads the flag BACK (`token_budget_overflowed = args.budget.overflowed`), so a
// listener that writes to `args` changes what ST does next. Clearing it would make the scan carry
// on past its budget — this extension covering for a misconfigured preset instead of reporting it.
// We copy values out and touch nothing.
//
// WHY THE TWO-STAGE LATCH. The overflow is known during the scan; whether the scan was real is
// known only after it. So SCAN_DONE records the verdict and WORLD_INFO_ACTIVATED releases it. A dry
// run records a verdict that is simply overwritten by the next scan and never shown.
//
// The SCAN_DONE handler is awaited by SillyTavern inside its own scan loop, so it stays synchronous
// and does no work beyond copying references. The token counting waits for release.

import { eventSource, event_types } from '../../../../../../../script.js';
import { getContext } from '../../../../../../extensions.js';
import { world_info_budget, world_info_budget_cap } from '../../../../../../world-info.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { analyzeBudgetOverflow, formatBudgetOverflowMessage } from './worldinfo-budget-core.js';
import { toast } from '../../sillytavern/mvu-bridge.js';

const log = createModuleLog('worldinfo-budget');

// The verdict of the most recent scan, waiting to learn whether that scan was real. Null means the
// last scan finished inside its budget, or its verdict has already been shown.
let pendingOverflow = null;
let registered = false;

/** A world info entry's identity, spelled the way SillyTavern keys its own activated map. */
const entryId = (entry) => `${entry && entry.world}.${entry && entry.uid}`;

/** Entries arrive as a Map in one field and an Array in another; both answer to this. */
function toEntryArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.values === 'function') return Array.from(value.values());
    return [];
}

/** What to call an entry in a message the user reads — its own label, never its uid if it has one. */
function entryLabel(entry) {
    if (!entry) return 'an entry';
    const comment = String(entry.comment || '').trim();
    if (comment) return comment;
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    if (keys.length) return keys.join(', ');
    return `uid ${entry.uid}`;
}

// ── stage 1: record the verdict ──────────────────────────────────────────────
// Synchronous and cheap: ST awaits this inside its scan loop. Strings are immutable, so mapping the
// contents out costs references, not copies.
function onScanDone(args) {
    if (!args || !args.budget) return;

    if (!args.budget.overflowed) {
        // Only a scan that ENDED cleanly clears a verdict. A mid-scan loop that has not yet
        // overflowed says nothing about the loop after it.
        if (!args.state || !args.state.next) pendingOverflow = null;
        return;
    }

    const admitted = toEntryArray(args.activated && args.activated.entries);
    const admittedIds = new Set(admitted.map(entryId));
    const cut = toEntryArray(args.new && args.new.all).filter((e) => !admittedIds.has(entryId(e)));

    pendingOverflow = {
        budgetTokens: Number(args.budget.current) || 0,
        admittedCount: admitted.length,
        admittedText: admitted.map((e) => String(e.content || '')).join('\n'),
        cutCount: cut.length,
        cutText: cut.map((e) => String(e.content || '')).join('\n'),
        cutNames: cut.map(entryLabel),
    };
}

// ── stage 2: the scan was real — count what it cost and say so ───────────────
async function onWorldInfoActivated() {
    const pending = pendingOverflow;
    pendingOverflow = null;
    if (!pending) return;

    try {
        const context = getContext();
        const countTokens = context.getTokenCountAsync || context.getTokenCount;
        if (typeof countTokens !== 'function') {
            log.warn('world info was cut at the budget, but SillyTavern exposes no token '
                + 'counter, so the Context Size to raise it to cannot be worked out. Entries dropped:', pending.cutNames);
            return;
        }

        const [admittedTokens, cutTokens] = await Promise.all([
            countTokens(pending.admittedText),
            countTokens(pending.cutText),
        ]);

        const settings = context.chatCompletionSettings || {};
        const analysis = analyzeBudgetOverflow({
            neededTokens: Number(admittedTokens) + Number(cutTokens),
            budgetTokens: pending.budgetTokens,
            contextSize: settings.openai_max_context,
            responseTokens: settings.openai_max_tokens,
            budgetPercent: world_info_budget,
            budgetCap: world_info_budget_cap,
            admittedCount: pending.admittedCount,
            cutCount: pending.cutCount,
            cutNames: pending.cutNames,
        });

        const message = formatBudgetOverflowMessage(analysis);
        // Both surfaces on purpose: the toast is seen, the log is searchable and carries the full
        // list of what went missing, which is the part a toast has no room for.
        log.warn(`${message} Dropped:`, pending.cutNames);
        if (typeof toastr !== 'undefined') {
            toast('warning', message, 'MVU Helper — world info truncated', { timeOut: 15000, extendedTimeOut: 15000 });
        }
    } catch (e) {
        log.warn('world info was cut at the budget, but working out the Context Size to '
            + 'suggest failed — the entries below are missing from this reply:', pending.cutNames, e);
    }
}

/**
 * Starts listening. Safe to call twice — SillyTavern's event bus has no de-duplication, so a second
 * registration would toast twice for one overflow.
 */
export function initWorldInfoBudgetWarning() {
    if (registered) return;
    if (!eventSource || !event_types || !event_types.WORLDINFO_SCAN_DONE || !event_types.WORLD_INFO_ACTIVATED) {
        log.warn('this SillyTavern does not emit WORLDINFO_SCAN_DONE / WORLD_INFO_ACTIVATED, '
            + 'so a world info budget overflow will pass unreported (it will still happen).');
        return;
    }
    registered = true;
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, onScanDone);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    log.lifecycle('watching for world info budget overflow');
}
