// shared/generation-floor.js — which message a new generation will seed its variables from.
//
// A fact about SillyTavern's chat array, owned by no feature: MVU seeds a new reply's variables from
// a NEIGHBOURING message, and which neighbour depends on the gesture. Anything that must be present
// in the state a turn starts from has to be written to those floors, not only to the latest message,
// and anything read from that state has to be read from the floor the gesture starts from.
//
// Features depend on the same answer — the card's [InitVar] sync, Roster-tab edits, plugin state drawers and
// event-pack trigger rows write to those floors, the roster's ON FILE list reads from one — so the answer lives
// here once rather than being spelled several times.

import { stateBefore } from '../sillytavern/mvu-bridge-core.js';

// The stored state a generation starts from — PURE: { index, statData }, or null when the chat holds none.
// `generationType` is SillyTavern's GENERATION_STARTED type. A swipe generates a new take of the last message, so it
// starts from the state before that message, never from the take it replaces. Every other generation starts from
// the newest state the chat holds: a regenerate has removed the message it replaces before its prompt is built, and
// a continue extends the last message, so that message's own state is where it starts.
export function generationStartingState(chat, generationType) {
    const length = Array.isArray(chat) ? chat.length : 0;
    return stateBefore(chat, generationType === 'swipe' ? length - 1 : length);
}

// The message ids a NEW generation can seed its variables from — the tail messages that actually
// carry a `variables` object, newest first, capped. Pure so the choice is provable (L6): the defects
// this feeds were precisely a wrong answer to "which message will the reply inherit from" — a write
// that lands on the LATEST message only, while a regenerate re-seeds that message from the one
// before it, and a delete-then-send seeds from a floor that never had it. Covering the last TWO
// variable-carrying messages covers every seed source without per-gesture arithmetic: fresh send
// (latest), regenerate and swipe (the message before the one being replaced), delete-then-send
// (whatever survived the delete).
export function tailMessagesCarryingVariables(chat, count = 2) {
    const ids = [];
    if (!Array.isArray(chat)) return ids;
    for (let i = chat.length - 1; i >= 0 && ids.length < count; i--) {
        const m = chat[i];
        if (m && m.variables && typeof m.variables === 'object') ids.push(i);
    }
    return ids;
}
