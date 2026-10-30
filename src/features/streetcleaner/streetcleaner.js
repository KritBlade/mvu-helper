// streetcleaner/streetcleaner.js — the streetcleaner's place in mvu-helper's end-of-reply pass (own-state): after
// mvu-helper's own writes, on every copy of the reply's state that is saved, each mission sweeps the part of
// mvu-helper's root it owns and drops what has gone stale (plans/executed/streetcleaner.md). It cleans nothing else: the card's
// own state, Roster entries and settings are never touched, and a sweep inside the reply's state is undone by a swipe,
// a regenerate or a branch like anything else the reply changed. The decisions are streetcleaner-core's and each
// mission's own; this file holds the registry, the clock's chat and the log.

import { getContext } from '../../../../../../extensions.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { repliesSince, sweepOwnState } from './streetcleaner-core.js';

const log = createModuleLog('streetcleaner');
const missions = [];
const warnedInChat = new Map();   // chat id → the mission warnings already given in that chat

/**
 * Add a mission: `{ name, part, sweep(value, clock) }` — the feature that owns `part` of mvu-helper's root says when
 * an item of it has gone stale (plans/executed/streetcleaner.md §4). Missions are registered in src/index.js.
 */
export function registerCleaningMission(mission) {
    if (!mission || typeof mission.sweep !== 'function' || !String(mission.name || '').trim() || !String(mission.part || '').trim()) {
        log.warn("a cleaning mission needs a name, the part of mvu-helper's root it cleans, and a sweep function — ignored");
        return;
    }
    missions.push(mission);
}

// A mission's warning, once per chat: the same cause repeats on every reply until someone fixes it.
function warnOncePerChat(warning) {
    const chatId = String(getContext().chatId || '');
    if (!warnedInChat.has(chatId)) warnedInChat.set(chatId, new Set());
    const given = warnedInChat.get(chatId);
    if (given.has(warning)) return;
    given.add(warning);
    log.warn(warning);
}

// The streetcleaner as a task of the end-of-reply pass (own-state registerOwnStateTask), registered after every write.
export const streetcleanerTask = {
    name: 'streetcleaner',
    run(statData, { mid, copyLabel }) {
        const chat = getContext().chat;
        const clock = { replyIndex: mid, repliesSince: (stampedIndex) => repliesSince(chat, stampedIndex, mid) };
        const report = sweepOwnState(statData, missions, clock, (mission, e) => {
            log.warn(`msg ${mid} (${copyLabel}): the ${mission.name} mission failed — its part is left as it was:`, e);
        });
        for (const { part, dropped, warnings } of report) {
            if (dropped.length) log.lifecycle(`msg ${mid} (${copyLabel}): ${part} dropped ${dropped.map((d) => `${d.key} (${d.why})`).join(', ')}`);
            for (const warning of warnings) warnOncePerChat(warning);
        }
    },
};
