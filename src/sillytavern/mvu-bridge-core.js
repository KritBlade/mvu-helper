// sillytavern/mvu-bridge-core.js — PURE decisions of the bookkeeper write path (the L6 split, same
// shape as tavern-regex-core.js): the WRITE-ATTRIBUTION stack. No host imports; every branch is
// reachable from a test.
//
// WHO wrote this op? Every host-initiated write reaches MVU through ONE door — parseMvuBlock in
// mvu-bridge.js, enforced by tools/check-mvu-writes.mjs — and that door pushes its caller's label
// here for the duration of the parse. The turn runner's op collector reads `currentWriter()` when
// VARIABLE_UPDATE_ENDED fires, which happens INSIDE the awaited parse, so the label is still on the
// stack (the same in-flight property the live-resolve suppression gate already relies on).
//
// The default answers are the whole design:
//   • stack EMPTY → 'message' — a parse the host did NOT initiate, i.e. MVU parsing a chat
//     message's own <UpdateVariable> block. In every ordinary turn that is narrate's reply — the
//     one writer whose ops nothing requested and nothing can vouch for.
//   • label OMITTED at the door → 'host', never 'message'. A future parseMvuBlock caller that
//     forgets to name itself must degrade to "some host lane", because inheriting 'message' would
//     read as a MODEL write — a false accusation, which is worse than a vague one.
//
// A STACK, not a boolean, for the same reason the suppression gate is depth-counted: parses nest
// (POST's parse fires the ENDED handler that runs the plugin relay, whose own parse happens while
// POST's frame is still open) and the innermost writer is the true author of the inner ops.
// Parses DO overlap: the relay's parse runs inside POST's (POST's emit reaches the ENDED handler,
// which is registered void, so POST's own promise settles while the relay's frame is still open).
// Each frame therefore leaves BY IDENTITY, never by position — a positional pop on the outer parse's
// return took the inner writer's label with it and left the outer label standing over the inner ops.

// The labels more than one module reads, ONE spelling each — the writer and the turn runner import
// these rather than re-typing them (a re-spelled copy of a sentinel is how two readers drift).
//   WRITER_MESSAGE   — no host parse in flight: MVU parsing a chat message's own block
//   WRITER_UNLABELED — a host parse whose caller named no label
//   WRITER_POST      — the POST pass's record parse; the turn runner persists it (postRelayPlan)
export const WRITER_MESSAGE = 'message';
export const WRITER_UNLABELED = 'host';
export const WRITER_POST = 'post';

// MVU's update event (Mvu.events.VARIABLE_UPDATE_ENDED), fired after every parse with
// (variables, variables_before_update). One spelling for every module that listens to it.
export const MVU_VARIABLE_UPDATE_ENDED = 'mag_variable_update_ended';

// MVU's last event before it saves a reply it parsed (Mvu.events.BEFORE_MESSAGE_UPDATE), payload
// { variables, message_content }: MVU stores `variables.stat_data` into the reply right after its listeners
// return, and the card's Zod schema has already run. Fired only for MVU's own parse of the chat's last message
// when that message is not the user's — never for a Mvu.parseMessage a module runs — and it carries no message id.
export const MVU_BEFORE_MESSAGE_UPDATE = 'mag_before_message_update';

// MVU's status-bar placeholder. MVU appends it to a reply it parsed when the reply does not carry it yet (after its
// VARIABLE_UPDATE_ENDED listeners return, so below anything they wrote) and strips it from the prompt; a StatusMenu
// pack's regex renders the menu where it stands. One spelling for every module that places text around it.
export const MENU_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

// MVU's transient key on stat_data. MVU sets `$internal` ({ display_data, delta_data }) before an update starts and
// removes it after VARIABLE_UPDATE_ENDED returns, so a listener of that event sees it; MVU's own save comes after the
// removal. It is MVU's alone: mvu-helper never writes or removes it, and never hands it on, because a copy taken
// while it is there carries it past MVU's removal into a saved state.
export const MVU_TRANSIENT_KEY = '$internal';

// `statData` as an engine is handed it: without MVU's transient key at the top level, the one place MVU puts it (a
// key of that name deeper in a consumer's tree is the consumer's). MVU's own object is left as it is: the result is
// a shallow copy without the key, every other key the same value. A state without the key is returned as it is.
export function withoutMvuTransientKey(statData) {
    if (!statData || typeof statData !== 'object' || !Object.prototype.hasOwnProperty.call(statData, MVU_TRANSIENT_KEY)) return statData;
    const copy = { ...statData };
    delete copy[MVU_TRANSIENT_KEY];
    return copy;
}

// mvu-helper's own root inside stat_data. A feature that keeps state per reply keeps it under one part of this
// root (`worn_outfit` …), so MVU stores it with every message and swipe like the card's own state, and a swipe,
// a regenerate, a deleted reply and a reload are right by construction. mvu-helper is its only writer, and it writes
// the root directly, never through an <UpdateVariable> command. The leading `$` keeps it out of prompts:
// TavernHelper's {{get_message_variable}} / {{format_message_variable}} drop every `$` key inside what they print,
// while a path that names the root still reads it. A card with a Zod schema declares the root open
// (`z.record(z.string(), z.any())`); a closed declaration strips every part it does not name.
export const MVUHELPER_STAT_ROOT = '$mvuhelper';

// One part of mvu-helper's root in a state, read in place; undefined when the state holds none.
export function ownStatPart(statData, part) {
    const root = statData && typeof statData === 'object' ? statData[MVUHELPER_STAT_ROOT] : undefined;
    if (!root || typeof root !== 'object' || !Object.prototype.hasOwnProperty.call(root, part)) return undefined;
    return root[part];
}

// Set one part of mvu-helper's root in a state, creating the root when the state has none. The rest of the
// state, and every other part of the root, is left as it is.
export function setOwnStatPart(statData, part, value) {
    if (!statData || typeof statData !== 'object') return;
    const root = statData[MVUHELPER_STAT_ROOT];
    if (!root || typeof root !== 'object' || Array.isArray(root)) statData[MVUHELPER_STAT_ROOT] = {};
    statData[MVUHELPER_STAT_ROOT][part] = value;
}

// mvu-helper's own announcement of a save (mvu-bridge.js saveMessageMvuData), payload { mid, writer }:
// Mvu.replaceMvuData stores a message's state and announces nothing.
export const MVU_STATE_SAVED_EVENT = 'mvu_helper_state_saved';

// The game state a message stores for the swipe it shows: MVU keeps one variables object per swipe, and its
// stat_data is the state as that message left it. null when it holds none — a reply still streaming, a swipe
// not generated yet, a card without MVU. Read in place, never copied, so a caller only reads it.
export function storedStatDataOf(message) {
    const slot = message && message.variables && message.variables[message.swipe_id != null ? message.swipe_id : 0];
    const statData = slot && slot.stat_data;
    return statData && typeof statData === 'object' ? statData : null;
}

// The stored state a reply at `index` starts from: the newest message before it whose shown swipe holds one — where
// MVU's own parse of it starts. { index, statData }, or null when no message before it holds a state.
export function stateBefore(chat, index) {
    const messages = Array.isArray(chat) ? chat : [];
    for (let id = Math.min(index, messages.length) - 1; id >= 0; id--) {
        const statData = storedStatDataOf(messages[id]);
        if (statData) return { index: id, statData };
    }
    return null;
}

const writerStack = [];   // frames, innermost last

export function currentWriter() {
    return writerStack.length ? writerStack[writerStack.length - 1].label : WRITER_MESSAGE;
}

export async function withWriter(label, callback) {
    const frame = { label: String(label || WRITER_UNLABELED) };
    writerStack.push(frame);
    try {
        return await callback();
    } finally {
        // Own frame only, wherever it sits — and in a finally, so a throw never wedges a stale label
        // onto every later parse.
        const at = writerStack.lastIndexOf(frame);
        if (at !== -1) writerStack.splice(at, 1);
    }
}

// ── WHO JUDGED A REFUSED WRITE (§22) ─────────────────────────────────────────
//
// TWO different gatekeepers can turn an op down, they fail in different ways, and only ONE of them
// is fixable by whoever authored the thing that got refused:
//   • the card's ZOD SCHEMA — refuses a path it does not enumerate. The author declares the path (or
//     opens the root) and the write lands. Every refusal message in this repo used to name this one
//     unconditionally, including on cards where it never ran.
//   • MVU's OWN SHAPE-DERIVED SCHEMA, which governs whenever no Zod registration is running. It
//     freezes every object to the keys it held when MVU derived it, so a drawer that was empty then
//     accepts NOTHING, ever. No declaration anywhere reopens it — the card itself is the problem.
// Naming the first when it was the second is what sends someone editing a schema that was never
// consulted (live 2026-09-04: a standalone plugin's 15 relay ops, all refused, all reported as Zod).
//
// TELLING THEM APART FROM THE BLOB ALONE: mvu_zod overwrites MVU's `schema` field with a disable
// sentinel on every update it handles — read out of the shipped bundle 2026-09-04:
//     eventOn('mag_variable_update_ended_for_zod', t => { _.set(t,'schema','没有用别管这个'), … })
// so a blob that still carries a real derived schema object is a blob no Zod touched.
//
// ⚠ READ THE POST-PARSE BLOB, NEVER THE PRE-PARSE ONE. The sentinel is stamped BY the parse, so on a
// Zod card's first turn the pre-parse blob still holds MVU's derived schema — judging from it would
// accuse the wrong gatekeeper on exactly the card that is working correctly. Same direction as the
// writer stack's defaults above: a vague answer beats a false accusation.
export const ZOD_DISABLE_SENTINEL = '没有用别管这个';

export const JUDGE_ZOD = 'zod';
export const JUDGE_MVU_DERIVED = 'mvu-derived';
export const JUDGE_UNKNOWN = 'unknown';

/** Which gatekeeper judged the writes in this (post-parse) MVU blob. */
export function writeJudgeOf(variables) {
    const schema = variables && variables.schema;
    if (typeof schema === 'string') return schema === ZOD_DISABLE_SENTINEL ? JUDGE_ZOD : JUDGE_UNKNOWN;
    if (schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object') {
        return JUDGE_MVU_DERIVED;
    }
    return JUDGE_UNKNOWN;
}

/**
 * The clause a refusal warning uses to name its cause. One spelling, shared by every lane that can
 * be refused (plugin relay · menu action · SIM), because three lanes describing the same MVU
 * behaviour three ways is how a reader learns to trust the wrong half of the console.
 */
export function refusedByPhrase(variables) {
    switch (writeJudgeOf(variables)) {
    case JUDGE_ZOD:
        return "the card's Zod schema refused them — it does not enumerate these paths (declare them, or open the root they sit under)";
    case JUDGE_MVU_DERIVED:
        return 'NO Zod schema is running on this card, so MVU\'s own derived schema judged them — it freezes every object to the'
            + ' keys it held when MVU derived it, and nothing an artifact declares can reopen one. Install the card\'s Zod schema';
    default:
        return 'the card carries no readable schema, so which gatekeeper turned them down cannot be named from here';
    }
}

// The options every mvu-helper toast is shown with: the caller's, then `escapeHtml: true` past them. toastr
// renders a toast's message and title as HTML without it, and a toast often quotes a pack's name, a
// validation error or the model's output (mvu-bridge.js toast).
export function toastOptions(options) {
    return { ...(options && typeof options === 'object' ? options : {}), escapeHtml: true };
}
