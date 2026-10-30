// small-llm/call-input-macros-core.js — the `{{mvuhelper::…}}` read surface for PRE/POST call
// blocks (plans/call-input-macros-plan.md). Pure: no ST imports, unit-testable.
//
// WHAT THIS SOLVES: a call sees ONLY its system block + one user line (buildMessages). It cannot
// see the story. EJS over stat_data lets a sim remember what IT decided; nothing lets it know what
// the STORY did — prose exists in no other channel. `history::N` is that channel.
//
// THE DESIGN PRINCIPLE — this surface is USER-FACING, not coder-facing. The audience writes
// lorebook prompts, not JavaScript. Every token is (a) one copy-pasteable string with no
// expression/property access/indexing, (b) incapable of throwing — unresolvable becomes '' plus a
// warn, never an exception, (c) meaningful without knowing mvu-helper's internals.
//
// That principle is the WHOLE justification for `callOutput` in particular: the data is already
// reachable from any EJS block (`globalThis.mvuHelper.lastPre` is an array of every pre-phase
// call), but telling a card author to write a `.find()` in a lorebook entry is the worst failure
// mode in this codebase — if that EJS throws, ST-Prompt-Template ships the ENTIRE block to the
// model as raw text that still reads like prose (the documented cause of a live [PRE] outage), and
// the readable multi-line version walks into the scan_ejs_scope depth-0 collision. A macro cannot
// throw.
//
// MACROS NEVER WRITE. This is a read surface, full stop — persistence already has a path
// (<JSONPatch> → mvu-helper writes it). A second authoring route to the same destination costs the
// only thing that matters when a save goes wrong: being able to name who wrote it.

// Recognises `{{mvuhelper::token}}` and `{{mvuhelper::token::arg}}`. Case-insensitive on the
// namespace + token so a card author is not punished for `{{MvuHelper::History}}`; the ARG (a call
// name) keeps its case and is compared case-insensitively at lookup.
const RE_MACRO = /\{\{\s*mvuhelper\s*::\s*([a-z][a-z0-9_]*)\s*(?:::\s*([^}]*?)\s*)?\}\}/gi;

// The reply separator. Named + numbered so a small model can tell turns apart, and so the NEWEST
// reply is unambiguous when N > 1 (oldest→newest order, -1 = most recent).
const replyHeader = (offsetFromNewest) => `--- reply -${offsetFromNewest} ---`;

export const KNOWN_TOKENS = ['history', 'userline', 'calloutput', 'task'];

// Does any enabled call's block use our namespace at all? Lets the caller skip building a context
// (a chat walk + strip per call) when no card uses macros — and keeps the io log honest: no
// phantom inputs listed for blocks that asked for none.
export function blockUsesInputMacros(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    RE_MACRO.lastIndex = 0;
    return RE_MACRO.test(text);
}

// Assistant replies from a chat array, oldest→newest, each reduced by the caller's `cleanReplyText`
// (`<UpdateVariable>` blocks off; on POST, whose chat is the raw one, the stat box too).
//
// `endExclusive` is what keeps the two passes honest about "what just happened":
//   • PRE  — coreChat, no bound: the newest assistant message IS the previous turn's reply.
//   • POST — ctx.chat bounded at mesId: THIS turn's reply is already the call's user content, so
//            including it would feed the model the same text twice under two different labels.
//
// SOURCE MATTERS: callers pass the interceptor's coreChat (swipe-popped AND prompt-regexed —
// byte-identical to what the narrator read). ST's own {{lastCharMessage}} reads the LIVE chat, so
// on a swipe it returns the swiped-AWAY reply, and returns raw `.mes` rather than the regexed text.
// Both wrong, both silent. That is the trap this token exists to replace.
export function collectAssistantHistory(chat, count, { endExclusive = null, cleanReplyText = (s) => s } = {}) {
    if (!Array.isArray(chat) || !(count > 0)) return [];
    const end = (endExclusive == null) ? chat.length : Math.max(0, Math.min(endExclusive, chat.length));
    const out = [];
    for (let i = end - 1; i >= 0 && out.length < count; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user === true) continue;
        const role = String(msg.role || '').toLowerCase().trim();
        if (role === 'user' || role === 'system') continue;
        if (msg.is_system === true) continue;
        const text = String(cleanReplyText(msg.content ?? msg.mes ?? '') || '').trim();
        if (!text) continue;                      // an empty/stripped-to-nothing reply is not a turn
        out.push(text);
    }
    return out.reverse();                          // oldest→newest
}

// Join collected replies with numbered headers. One reply → no header (a lone block needs no
// scaffolding, and the common case should read like prose, not like a data dump).
export function formatHistory(replies) {
    if (!Array.isArray(replies) || replies.length === 0) return '';
    if (replies.length === 1) return replies[0];
    const newest = replies.length;
    return replies.map((text, i) => `${replyHeader(newest - i)}\n${text}`).join('\n\n');
}

// A call's output from a [{name, label, output}] array, matched case-insensitively on name.
// Returns '' for absent/failed/empty — the empty-tolerant contract, one degrade path for
// first-turn, reload, timeout, dead call and typo'd name alike.
export function findCallOutput(callOutputs, name) {
    if (!Array.isArray(callOutputs)) return '';
    const want = String(name || '').trim().toLowerCase();
    if (!want) return '';
    const hit = callOutputs.find((o) => o && String(o.name || '').trim().toLowerCase() === want);
    return hit && hit.output != null ? String(hit.output) : '';
}

const clampCount = (raw) => {
    if (raw === '' || raw == null) return 1;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return null;      // null = malformed, caller warns
    return Math.min(n, 20);                              // a sane ceiling; 20 replies is already a huge prompt
};

/**
 * Resolve one token to its text. Returns { value, warn } — `warn` is a human-readable reason the
 * caller logs; a warn NEVER blocks substitution (the value is still '' and the call still runs).
 *
 * `stage` is enforcement, not documentation: `callOutput` is POST-only because PRE calls run in
 * PARALLEL by default, so no PRE call may read another PRE call's output this turn. POST runs on
 * MESSAGE_RECEIVED, strictly after the interceptor awaited EVERY PRE call, so there the read is
 * well-defined.
 */
export function resolveInputMacro({ token, arg }, context) {
    const ctx = context || {};
    switch (token) {
        case 'history': {
            const count = clampCount(arg);
            if (count === null) {
                return { value: '', warn: `{{mvuhelper::history::${arg}}} — "${arg}" is not a positive whole number; resolved empty` };
            }
            const replies = collectAssistantHistory(ctx.chat, count, {
                endExclusive: ctx.historyEndExclusive,
                cleanReplyText: ctx.cleanReplyText,
            });
            return { value: formatHistory(replies), warn: '' };
        }
        case 'userline':
            return { value: String(ctx.userLine == null ? '' : ctx.userLine), warn: '' };
        case 'calloutput': {
            const name = String(arg || '').trim();
            if (!name) return { value: '', warn: '{{mvuhelper::callOutput}} needs a call name — e.g. {{mvuhelper::callOutput::PRE2}}; resolved empty' };
            if (ctx.stage !== 'post') {
                return {
                    value: '',
                    warn: `{{mvuhelper::callOutput::${name}}} is POST-only — PRE calls run in PARALLEL, so no PRE call can read another PRE call's output this turn; resolved empty`,
                };
            }
            const value = findCallOutput(ctx.callOutputs, name);
            if (!value) {
                return { value: '', warn: `{{mvuhelper::callOutput::${name}}} — no call named "${name}" produced output this turn (disabled / failed / not configured); resolved empty` };
            }
            return { value, warn: '' };
        }
        case 'task': {
            // A routed task's instruction for THIS call and THIS turn (llm-task-router taskInstructionToken).
            // The router writes this token into the task's routing entry instead of the text, and the pass
            // resolves every routed task's text before its calls run — so this read is a lookup, never I/O.
            const id = String(arg || '').trim();
            if (!id) return { value: '', warn: '{{mvuhelper::task}} needs a task id — the router writes it, e.g. {{mvuhelper::task::imagegen-charimg}}; resolved empty' };
            const instructions = ctx.taskInstructions || {};
            const value = Object.prototype.hasOwnProperty.call(instructions, id) ? String(instructions[id] || '') : '';
            if (!value) {
                return { value: '', warn: `{{mvuhelper::task::${id}}} — no active task "${id}" is routed to a ${ctx.stage || 'PRE/POST'} call this turn, or its instruction came back empty; resolved empty` };
            }
            return { value, warn: '' };
        }
        default:
            return { value: '', warn: `{{mvuhelper::${token}}} is not a known token (known: ${KNOWN_TOKENS.join(', ')}); resolved empty` };
    }
}

/**
 * Replace every `{{mvuhelper::…}}` token in `text`.
 *
 * Runs LAST — after the EJS render AND after the full tavern decode — so returned prose is NEVER
 * re-interpreted: a reply containing `<%` or `{{` would otherwise break the EJS render or get
 * macro-expanded. Raw text in, raw text out.
 *
 * Returns { text, resolved, warns }. `resolved` is [{token, arg, length}] in source order, for the
 * pipeline trace: a token that silently resolved empty must still be VISIBLE as `∅`, or an empty
 * history reads exactly like a history that was never requested.
 */
export function substituteInputMacros(text, context) {
    const resolved = [];
    const warns = [];
    if (typeof text !== 'string' || text.length === 0) return { text: typeof text === 'string' ? text : '', resolved, warns };
    const out = text.replace(RE_MACRO, (raw, tokenRaw, argRaw) => {
        const token = String(tokenRaw).toLowerCase();
        const arg = argRaw === undefined ? '' : String(argRaw);
        const { value, warn } = resolveInputMacro({ token, arg }, context);
        if (warn) warns.push(warn);
        resolved.push({ token, arg, length: value.length });
        return value;
    });
    return { text: out, resolved, warns };
}

// One trace line per call: token → resolved length, `∅` when empty. Per the log-sanity rule the
// EMPTY case must print — "history::2=∅" and no line at all mean very different things, and only
// one of them is "the card asked and got nothing".
export function formatMacroTrace(resolved) {
    if (!Array.isArray(resolved) || resolved.length === 0) return '';
    return resolved
        .map(({ token, arg, length }) => `${token}${arg ? `::${arg}` : ''}=${length ? `${length}ch` : '∅'}`)
        .join(' ');
}

// ── the swipe-unsafe-macro lint ──────────────────────────────────────────────
// ST's own chat macros read the LIVE chat array and the RAW .mes. In a call block that is two bugs
// at once (swiped-away reply · un-regexed text) and both are silent. Warn once per session per
// token and name the replacement — a trap you can see is a teachable moment.
const SWIPE_UNSAFE_MACROS = [
    { macro: '{{lastCharMessage}}', use: '{{mvuhelper::history}}' },
    { macro: '{{lastUserMessage}}', use: '{{mvuhelper::userLine}}' },
];

export function findSwipeUnsafeMacros(text) {
    if (typeof text !== 'string' || !text) return [];
    return SWIPE_UNSAFE_MACROS.filter(({ macro }) => text.includes(macro));
}
