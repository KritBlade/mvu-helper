// logic-engine/roll-pool.js — the ONE live dealer instance + its generation wiring (§9c rollPool).
//
// All semantics live in createRollPoolDealer (logic-engine-core.js, table-tested); this file only
// instantiates it, listens for GENERATION_STARTED (fires at Generate() entry, BEFORE world-info /
// EJS assembly — verified against ST 1.18 script.js — so the bump always lands before the deal),
// gives a refused deal its log line, and exports the handles:
//   • rollPool(count, hash, poolName, sides) — exposed on globalThis.MvuHelper (and LogicEngine).
//     Window A calls it unnamed (the default pool); an extra-LLM call's entry passes its own CALL
//     NAME as poolName to hold dice independent of the narrator's (zero slot collisions by
//     construction). `sides` is the die's face count, 20 when omitted.
//   • currentDealtPool()  — the receipt (union of all pools); the turn runner passes it into
//     resolveTurn as ctx.dice.
//   • currentDealtPools() — the same receipt per pool ({ pool | hash, sides, dice }), ctx.dicePools.
//
// Registered at import like the turn runner's listeners (the feature barrel pulls this in). The
// dealer itself decides what counts as a new deal (skips dry runs and `continue` — see core).

import { eventSource, event_types } from '../../../../../../../script.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { createRollPoolDealer } from './logic-engine-core.js';

const log = createModuleLog('logic-engine');

const dealer = createRollPoolDealer({ onRefused: (reason) => log.warn(reason) });

export function rollPool(count, hash, poolName, sides) { return dealer.rollPool(count, hash, poolName, sides); }
export function currentDealtPool() { return dealer.currentDealtPool(); }
export function currentDealtPools() { return dealer.currentDealtPools(); }

if (eventSource && event_types && event_types.GENERATION_STARTED) {
    eventSource.on(event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
        dealer.noteGenerationStarted(type, dryRun);
    });
}
