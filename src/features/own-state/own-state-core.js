// own-state/own-state-core.js — PURE: the order mvu-helper's own end-of-reply tasks run in (plans/executed/streetcleaner.md
// §2), and which parts of its root a reply's starting state lost. Tested by tests/own-state-core.test.js.

import { MVUHELPER_STAT_ROOT } from '../../sillytavern/mvu-bridge-core.js';

//
// The tasks change one copy of a reply's state, one after another, each awaited before the next, in the order they
// were registered (src/index.js). A task that reads what an earlier one wrote — the streetcleaner sweeping the
// worn-outfit store imagegen just wrote — therefore sees it, whatever order SillyTavern added any listener in. A task
// that throws is handed to `onError` and the next one still runs: the copy keeps what that task would have changed.
// The engine's staged copy the pass runs on, or null. Only a copy the engine saves (`staged.willSave`): an idle
// resolve — the user's own message parsed at the start of a turn, already resolved — saves nothing, so a write or a
// sweep there would change, and log, a copy that is dropped. And only the reply's own parse, captured for the swipe
// that was staged. `staged` is RES_STAGED_EVENT's payload; `parse` is { swipe, mvuData } or null.
export function stagedCopyToRun(staged, parse) {
    if (!staged || staged.willSave !== true) return null;
    if (!parse || parse.swipe !== staged.swipe) return null;
    const statData = parse.mvuData && parse.mvuData.stat_data;
    return statData && typeof statData === 'object' ? statData : null;
}

// The parts of mvu-helper's root an earlier stored state held that the state a reply starts from does not: what something
// between them dropped — the card's Zod schema stripping the root, or MVU rebuilding the state from the card's initial
// variables. [] when nothing was lost.
export function droppedOwnParts(startStatData, earlierStatData) {
    const rootOf = (statData) => {
        const root = statData && typeof statData === 'object' ? statData[MVUHELPER_STAT_ROOT] : null;
        return root && typeof root === 'object' && !Array.isArray(root) ? root : null;
    };
    const earlier = rootOf(earlierStatData);
    if (!earlier) return [];
    const start = rootOf(startStatData) || {};
    return Object.keys(earlier).filter((part) => !Object.prototype.hasOwnProperty.call(start, part));
}

export async function runOwnStateTasks(tasks, statData, reply, onError) {
    for (const task of Array.isArray(tasks) ? tasks : []) {
        try {
            await task.run(statData, reply);
        } catch (e) {
            onError(task, e);
        }
    }
}
