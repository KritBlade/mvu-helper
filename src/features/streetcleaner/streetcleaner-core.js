// streetcleaner/streetcleaner-core.js — PURE: the reply clock and one sweep over mvu-helper's own root in one copy of a
// reply's state (plans/executed/streetcleaner.md). Tested by tests/streetcleaner-core.test.js.

import { ownStatPart, setOwnStatPart } from '../../sillytavern/mvu-bridge-core.js';

// How many replies came after message `stampedIndex`, up to and including message `replyIndex`: the messages in
// between that are not the user's (the test latestAiMessageId uses). Counting replies rather than messages keeps a
// count true whether the user writes one message between replies or several. A stamp at or past the reply — the
// chat was cut back, or branched — is 0 replies old. PURE.
export function repliesSince(chat, stampedIndex, replyIndex) {
    if (!Number.isInteger(stampedIndex) || !Number.isInteger(replyIndex)) return 0;
    const messages = Array.isArray(chat) ? chat : [];
    const last = Math.min(replyIndex, messages.length - 1);
    let count = 0;
    for (let id = Math.max(0, stampedIndex + 1); id <= last; id++) {
        if (messages[id] && !messages[id].is_user) count++;
    }
    return count;
}

// One sweep of one copy of a reply's state: every mission sweeps the part of mvu-helper's root it owns, and a part it
// dropped anything from is written back with what it kept — the copy is the one thing changed. `missions` are
// [{ name, part, sweep(value, clock) → { kept, dropped: [{ key, why }], warnings: [] } }]; `clock` is
// { replyIndex, repliesSince(stampedIndex) }. A part the state does not hold is skipped. A mission that throws is
// handed to `onError` and its part is left as it was; every other mission still runs.
// Returns [{ part, dropped, warnings }] for each mission that dropped something or has something to say.
export function sweepOwnState(statData, missions, clock, onError) {
    const report = [];
    for (const mission of Array.isArray(missions) ? missions : []) {
        const value = ownStatPart(statData, mission.part);
        if (value === undefined) continue;
        let result;
        try {
            result = mission.sweep(value, clock);
        } catch (e) {
            onError(mission, e);
            continue;
        }
        const dropped = Array.isArray(result && result.dropped) ? result.dropped : [];
        const warnings = Array.isArray(result && result.warnings) ? result.warnings : [];
        if (dropped.length) setOwnStatPart(statData, mission.part, result.kept);
        if (dropped.length || warnings.length) report.push({ part: mission.part, dropped, warnings });
    }
    return report;
}
