// sillytavern/mvu-bridge.js — mvu-helper's doors into MVU (MagVarUpdate): reach it (getMvu), apply a block
// through it (parseMvuBlock), and save a message's state (saveMessageMvuData) — or one part of mvu-helper's own root
// in it (rewriteOwnStatPart, through the save door). Every host-initiated write goes through one of the two doors;
// tools/check-mvu-writes.mjs refuses a direct call anywhere else. The details every caller would otherwise have to
// rediscover:
//   • Mvu lives on globalThis/window (JS-Slash-Runner exposes it on the MAIN page).
//   • ALWAYS target an EXPLICIT message id — the Mvu.getCurrent* variants call getCurrentMessageId(),
//     which THROWS in the global extension context ("Don't call getMessageId on a global script iframe!").
//   • toast is best-effort (toastr may be absent in headless contexts).

import { eventSource } from '../../../../../../script.js';
import { createModuleLog } from './log.js';
import { withWriter, WRITER_UNLABELED, MVU_STATE_SAVED_EVENT, ownStatPart, setOwnStatPart, toastOptions } from './mvu-bridge-core.js';

const log = createModuleLog('mvu-bridge');

export function getMvu() {
    return (typeof globalThis !== 'undefined' && globalThis.Mvu) || (typeof window !== 'undefined' && window.Mvu) || null;
}

export function latestMsgId() {
    try {
        const chat = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext().chat : null;
        return (Array.isArray(chat) && chat.length) ? chat.length - 1 : -1;
    } catch (e) { log.child('latestMsgId').warn('could not read chat context:', e); return -1; }
}

// Every mvu-helper toast, in toastr's own argument order after the kind. Shown as TEXT whatever the caller
// passes (toastOptions): toastr renders its message and title as HTML unless `escapeHtml` is on, and
// SillyTavern's global setting for it is one any other extension can flip.
export function toast(kind, msg, title = 'MVU Helper', options = { timeOut: 6000 }) {
    try {
        if (typeof toastr !== 'undefined' && toastr[kind]) return toastr[kind](msg, title, toastOptions(options));
    } catch (e) { log.warn('toast failed (non-fatal):', e); }
    return undefined;
}

// THE PARSE DOOR — one function, every writer: a plugin's relay and the card's own POST record are the
// same kind of write, whoever produced it.
//
// Hand MVU an `<UpdateVariable><JSONPatch>` block and let IT apply the ops: the card's Zod judges
// every one, a refused op is dropped alone without voiding its siblings, and the parse fires
// VARIABLE_UPDATE_ENDED — which is the ONLY way the resolver chain runs at all. The direct API
// (setMvuVariable / replaceMvuData) writes the value but emits no such event, so a record lands and is
// never consumed.
//
// ⚠ IT APPLIES ONTO A CLONE AND PERSISTS NOTHING (MVU's bundle:
// `parseMessage:async function(t,n){const a=e(n);return await je(t,a),a}`). The returned object IS
// the result; somebody downstream must save it (saveMessageMvuData). In the turn pipeline that somebody
// is the turn runner's fence+save, which is why POST's own ops reach disk without POST ever writing them.
//
// ⚠ CALLING THIS FROM INSIDE A VARIABLE_UPDATE_ENDED HANDLER RE-ENTERS THAT HANDLER. Wrap the call
// in `withLiveResolveSuppressed` when that would be a loop rather than the intended relay.
//
// `writer` NAMES THE LANE for the turn's op attribution ('pre-sim' · 'post' · 'plugin:<id>'): it is
// pushed for the duration of the parse, and the op collector reads it when the parse's
// VARIABLE_UPDATE_ENDED fires. It is a PARAMETER of the door rather than a wrapper at the call site
// so a writer cannot go through the door unlabeled by accident — an omitted writer degrades to
// 'host', never to 'message' (see mvu-bridge-core.js for why that direction is load-bearing).
export async function parseMvuBlock(blockText, mvuData, { writer } = {}) {
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.parseMessage !== 'function') {
        log.child('parseMvuBlock').error('Mvu.parseMessage is unavailable — the block was NOT applied (is MVU installed?)');
        return null;
    }
    if (!blockText || !mvuData || !mvuData.stat_data) return null;
    const applied = await withWriter(writer, () => Mvu.parseMessage(blockText, mvuData));
    // undefined = MVU changed nothing (its documented "no variable updated" answer), not a failure.
    return (applied && applied.stat_data) ? applied : null;
}

// THE SAVE DOOR — every write of a message's MVU state that is not a parse. Mvu.replaceMvuData stores the
// state at an explicit message and announces nothing: no VARIABLE_UPDATE_ENDED (so a save never re-enters
// the turn runner) and no other event. A reader that shows state (the side panel, the StatusMenu frames)
// would learn of a save only when some later event happened to follow it, so this door announces every
// save (MVU_STATE_SAVED_EVENT, payload { mid, writer }), fire and forget: a listener never holds the
// writer. `writer` names who saved, in parseMvuBlock's vocabulary ('RES', 'pre-sim', 'plugin:<id>', …);
// an omitted one is 'host'. Returns false when MVU is unavailable (logged), true once the state is stored;
// a save that throws throws to its caller.
export async function saveMessageMvuData(data, messageId, { writer } = {}) {
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.replaceMvuData !== 'function') {
        log.child('saveMessageMvuData').error(`Mvu.replaceMvuData is unavailable — msg ${messageId} was NOT saved (is MVU installed?)`);
        return false;
    }
    await Mvu.replaceMvuData(data, { type: 'message', message_id: messageId });
    announceStateSaved(messageId, String(writer || WRITER_UNLABELED));
    return true;
}

// One part of mvu-helper's own root (stat_data.$mvuhelper.<part>) rewritten in message `messageId`'s saved state and
// saved through the save door: `nextValue(current)` is handed the part as stored (undefined when absent) and returns
// its new value. A value equal to the stored one saves nothing. Returns true when the state holds the new value, false
// when the message holds no state or MVU is unavailable (logged); a read or save that throws throws to its caller.
export async function rewriteOwnStatPart(messageId, part, nextValue, { writer } = {}) {
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function') {
        log.child('rewriteOwnStatPart').error(`MVU is not available — msg ${messageId}'s state was not written (is MVU installed?)`);
        return false;
    }
    const data = await Mvu.getMvuData({ type: 'message', message_id: messageId });
    if (!data || !data.stat_data || typeof data.stat_data !== 'object') return false;
    const current = ownStatPart(data.stat_data, part);
    const next = nextValue(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return true;
    setOwnStatPart(data.stat_data, part, next);
    return saveMessageMvuData(data, messageId, { writer });
}

function announceStateSaved(mid, writer) {
    try {
        void Promise.resolve(eventSource.emit(MVU_STATE_SAVED_EVENT, { mid, writer }))
            .catch((e) => log.warn(`state-saved signal (${writer} msg ${mid}) — a listener threw:`, e));
    } catch (e) {
        log.warn(`state-saved signal (${writer} msg ${mid}) could not be emitted:`, e);
    }
}
