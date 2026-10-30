// shared/mvu-parse-disposition.js — is this MVU parse the live chat's, or MVU replaying old messages?
//
// Ownerless primitive (P3): the turn runner resolves a turn only on a parse of the live chat, and the stat box
// builds the latest reply's box only from one. MVU fires its update event (VARIABLE_UPDATE_ENDED) for EVERY
// parse. Its floor replay (restoreVariables, 2 s after a MESSAGE_DELETED, or its replay button) re-reads old
// messages one by one from a copy ~20 messages back and fires once per message. A reader that took such a
// parse for the latest reply's would act on an old message's state: the turn runner would resolve old
// intents onto the latest reply, and the stat box would print an old message's numbers in it.
//
// What tells them apart is where the parse STARTED. MVU copies the caller's variables as its first
// step and hands that copy to the event (variables_before_update), and every parse of the live turn
// starts from a message as stored: narrate's reply from the message before it, POST's block and a
// card script from the reply itself, a user message from the reply before it, MVU's function-call
// mode from the newest message holding variables. Those are always among the newest TURN_BASE_COUNT
// messages whose shown swipe holds stat_data. A replay starts from a message far older, then carries
// a state rebuilt from old <UpdateVariable> text that no stored message holds.
//
// 'turn'    — the start matches one of those messages (`matched`), or no message holds any state yet
//             (the chat's initialization: MVU has nothing to replay from, so no replay exists).
// 'foreign' — the start matches none of them (`compared`), or the event carried no start at all:
//             the published signature always has one, so that is a broken sender, never a turn.
// Whole-object comparison, no path named (L1). Parses mvu-helper runs itself (PRE sim, relay, menu
// actions) are exempt at the call site: they start from whichever message they write.

import { deepEqual } from './deep-equal.js';

export const TURN_BASE_COUNT = 2;

// The newest messages whose SHOWN swipe holds stat_data — MVU's own "valid message" rule (a swipe
// being generated has no state yet, and another swipe's state is not what this parse started from).
export function turnBaseMessageIds(chat, count = TURN_BASE_COUNT) {
    const ids = [];
    if (!Array.isArray(chat)) return ids;
    for (let i = chat.length - 1; i >= 0 && ids.length < count; i--) {
        const m = chat[i];
        const slot = m && m.variables && m.variables[m.swipe_id != null ? m.swipe_id : 0];
        if (slot && slot.stat_data && typeof slot.stat_data === 'object') ids.push(i);
    }
    return ids;
}

export function endedEventDisposition(startStat, chat) {
    if (!startStat || typeof startStat !== 'object') return { disposition: 'foreign', reason: 'no-start-state', matched: null, compared: [] };
    const compared = turnBaseMessageIds(chat);
    if (!compared.length) return { disposition: 'turn', reason: 'first-state', matched: null, compared };
    for (const id of compared) {
        const m = chat[id];
        if (deepEqual(startStat, m.variables[m.swipe_id != null ? m.swipe_id : 0].stat_data)) {
            return { disposition: 'turn', reason: 'matches', matched: id, compared };
        }
    }
    return { disposition: 'foreign', reason: 'no-match', matched: null, compared };
}
