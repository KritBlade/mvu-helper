// small-llm/extra-llm-calls-core.js — PURE, host-free logic for the Extra LLM Calls feature.
//
// Everything here is a plain function with no ST/globals (it imports only pure `shared/`
// primitives), so it can be unit-tested directly (tests/extra-llm-calls-core.test.js). The I/O glue
// (lorebook fetch, ConnectionManagerRequestService, the registered interceptor) lives in
// extra-llm-calls.js and delegates to these.

import { unknownKeysOf } from '../../shared/unknown-keys.js';
import { salvagePatchOps, opsMissingAfterApply, getAtPointer } from '../../shared/json-patch-ops.js';
import { isPrototypeKey } from '../../shared/object-path.js';
import { completionFinishReason } from '../../shared/completion-finish.js';
import { pageCodeTokenIn } from '../../shared/rendered-region.js';
import { placeAboveFirstAnchor } from '../../shared/reply-block-placement.js';

// PER-CARD defaults (PROFILE scope) — merged into profileDefaults by index.js.
export const extraLlmCallsDefaults = {
    // groups: [{ id, tag, members:[callName,…] }] — a group's `[tag]` lorebook entries are read
    // by every member call (before its own `[name]` block). Shared content (roster/schema) lives
    // once under a group tag; calls mix & match across groups.
    extraLlmCalls: {
        enabled: true, parallel: true, timeoutSec: 60, groups: [],
        // calls: [{ id, name, profileId, phase, maxTokens, temperature, inputRegex, outputRegex, enabled }]
        //   a PRE call becomes a sim by emitting a <JSONPatch>, and its ops may write any path the
        //   card's Zod validates. It reads state the way every call does: EJS in its own entries.
        //   no `preset`, no `ownedRoot`: both retired — RETIRED_CALL_FIELDS has the why
        calls: [],
    },
};

// This card's extraLlmCalls block. settings-store's getProfile repairs it (both lists arrays, the switches booleans)
// before any reader sees it, so this only reads.
export function extraLlmCallsOf(p) {
    return p.extraLlmCalls;
}

// ── lorebook routing ─────────────────────────────────────────────────────────

// Does a lorebook entry belong to the call named `callName`?
// Match = the exact token "[callName]" appearing ANYWHERE in entry.comment or any entry.keys
// (case-insensitive).
//
// ANYWHERE, not at the start. A GameLogic Pack installs its entries with an ownership prefix on the
// comment, so School's PRE entry reads `[GameLogicPack:school-v4] [PRE] Check_DC_Dice`; a startsWith
// test would route none of a pack-installed card's entries, leaving every extra call with no contract.
// Position 0 is not the tag's home: a comment carries the entry's OWN tag plus whatever else the card
// or an installer wrote around it.
//
// BOTH BRACKETS are load-bearing and give exactness for free: "[llm22]" does not contain the
// substring "[llm2]", so a name is never matched by a longer one. Substring, not regex — a call name
// is user text and may hold regex metacharacters.
export function loreEntryMatchesCall(entry, callName) {
    const name = String(callName || '').trim();
    if (!name || !entry) return false;
    const token = `[${name}]`.toLowerCase();
    const has = (s) => String(s || '').toLowerCase().includes(token);
    if (has(entry.comment)) return true;
    if (Array.isArray(entry.keys) && entry.keys.some(has)) return true;
    return false;
}

// The matching entries for a call/tag — the shared primitive behind both the joined block and the
// per-entry manifest, so the two can never disagree about what's routed. Sorted by the entry's
// `order` (SillyTavern insertion_order, exposed as `.order` by TavernHelper — verified live): the
// card author positions routed blocks with the SAME numbers that position narrator entries, and
// higher order = LATER in the assembled system block = closer to the model's recency (so an
// output-contract/index entry given the highest order lands last, mirroring the narrator prompt).
// Entries without a numeric order sort as 0; ties keep lorebook order (stable).
export function selectLorebookEntries(entries, callName) {
    if (!Array.isArray(entries)) return [];
    return entries
        .map((e, i) => [e, i])
        .filter(([e]) => loreEntryMatchesCall(e, callName))
        .sort((a, b) => ((Number(a[0].order) || 0) - (Number(b[0].order) || 0)) || (a[1] - b[1]))
        .map(([e]) => e);
}

// Join the content of all matching entries (in order-sorted lorebook order) into one system block.
export function selectLorebookBlock(entries, callName) {
    return selectLorebookEntries(entries, callName)
        .map((e) => String((e && e.content) || '').trim())
        .filter(Boolean)
        .join('\n\n');
}

// A call's FULL system block = each GROUP block it belongs to (in group order) FIRST, then
// the call's own `[callName]` block. A group = { tag, members:[callName,…] }; its `[tag]`
// entries are read by every member call. Lets shared content (roster, schema) live ONCE under
// a group's tag, and lets calls mix & match — e.g. llm2 in both [llm1and2] and [llm2and3]
// reads [llm1and2] + [llm2and3] + [llm2]. Blank tags / non-member calls are skipped.
export function selectCallSystemBlock(entries, callName, groups) {
    const blocks = [];
    const gs = Array.isArray(groups) ? groups : [];
    for (const g of gs) {
        const tag = String((g && g.tag) || '').trim();
        const members = Array.isArray(g && g.members) ? g.members : [];
        if (tag && members.includes(callName)) {
            const b = selectLorebookBlock(entries, tag);
            if (b) blocks.push(b);
        }
    }
    const own = selectLorebookBlock(entries, callName);
    if (own) blocks.push(own);
    return blocks.join('\n\n');
}

// Per-entry manifest of a call's system block — each routed entry's NAME (its lorebook comment), in the
// SAME order selectCallSystemBlock assembles them (group blocks first, then the call's own [callName] block).
// Returns [{ name, via }] (via = the group tag the entry came through, or 'self'); only entries that actually
// contribute content are listed, so it mirrors exactly what's sent. Lets the runtime log routing one line per
// entry — the console truncates a single mega-string of the joined CONTENT, but never a short list of names.
export function selectCallSystemManifest(entries, callName, groups) {
    const out = [];
    const gs = Array.isArray(groups) ? groups : [];
    const add = (e, via) => {
        if (String((e && e.content) || '').trim() === '') return;     // empty → not actually sent
        out.push({ name: String((e && e.comment) || '').trim() || '(unnamed)', via });
    };
    for (const g of gs) {
        const tag = String((g && g.tag) || '').trim();
        const members = Array.isArray(g && g.members) ? g.members : [];
        if (tag && members.includes(callName)) {
            for (const e of selectLorebookEntries(entries, tag)) add(e, tag);
        }
    }
    for (const e of selectLorebookEntries(entries, callName)) add(e, 'self');
    return out;
}

// ── coreChat message helpers (element shapes vary by API) ────────────────────
// content = chat-completion (string OR [{type:'text',text}] parts); mes = text-completion.

export function extractTextContent(msg) {
    const raw = (msg && (msg.content ?? msg.mes)) ?? '';
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
    return String(raw);
}

// Index of the last user message: explicit user flag/role first, then "not
// system/assistant", then the very last message as a desperation fallback.
export function findLastUserIndex(chat) {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const role = String((chat[i] && chat[i].role) || '').toLowerCase().trim();
        if ((chat[i] && chat[i].is_user) || role === 'user' || role === 'human' || role === 'player') return i;
    }
    for (let i = chat.length - 1; i >= 0; i--) {
        const role = String((chat[i] && chat[i].role) || '').toLowerCase().trim();
        if (role && role !== 'system' && role !== 'assistant' && role !== 'ai' && role !== 'model') return i;
    }
    return chat.length > 0 ? chat.length - 1 : -1;
}

// The BASE floor a PRE-phase render pins to: the last assistant message
// carrying MVU state BEFORE the last user message. Reading the user floor itself is unsafe the
// moment a PRE call can WRITE it — regenerate re-reads the dirtied floor and ratchets (11→12→13).
// MUST be called with the REAL chat (SillyTavern.getContext().chat), never the interceptor's
// filtered/swipe-popped coreChat argument — their indices disagree on any chat with a system message.
//   - `-1` from a naive findLastIndex is NOT "none", it is "last": the variables cache resolves
//     negative ids as chat.length+id, silently pointing the pin at the dirty floor. A chat whose
//     first message is the user's therefore falls back to the user floor EXPLICITLY.
//   - hasState skips system messages and floors MVU never wrote, so the engine never receives {}.
export function findBaseFloorIndex(realChat) {
    if (!Array.isArray(realChat) || realChat.length === 0) return -1;
    const hasState = (m) => !!(m && m.variables && m.variables[m.swipe_id ?? 0]
        && m.variables[m.swipe_id ?? 0].stat_data);
    let u = -1;
    for (let i = realChat.length - 1; i >= 0; i--) {
        if (realChat[i] && realChat[i].is_user) { u = i; break; }
    }
    let b = -1;
    for (let i = (u < 0 ? realChat.length : u) - 1; i >= 0; i--) {
        const m = realChat[i];
        if (m && !m.is_user && hasState(m)) { b = i; break; }
    }
    return b >= 0 ? b : (u >= 0 ? u : realChat.length - 1);   // NEVER leave it negative on a non-empty chat
}

// Prepend a text block to a coreChat message, handling all three content shapes.
// Returns false (no mutation) for an unknown shape. Mutates `msg` in place.
export function prependToMessage(msg, block) {
    if (!msg) return false;
    if (typeof msg.content === 'string') {
        msg.content = block + msg.content;
    } else if (Array.isArray(msg.content)) {
        const nonText = msg.content.filter((p) => p && p.type !== 'text');
        const existing = msg.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
        msg.content = [{ type: 'text', text: block + existing }, ...nonText];
    } else if (typeof msg.mes === 'string') {
        msg.mes = block + msg.mes;
    } else {
        return false;
    }
    return true;
}

// ── call request/response shaping ────────────────────────────────────────────

// Build the [{role,content}] messages array for one call.
export function buildMessages(systemBlock, userText) {
    const messages = [];
    if (systemBlock) messages.push({ role: 'system', content: systemBlock });
    messages.push({ role: 'user', content: String(userText == null ? '' : userText) });
    return messages;
}

// ── out-of-character commands ────────────────────────────────────────────────
// An OOC command is the player stepping outside the story to give the game an order: `[ooc: …]` or `(ooc: …)` in
// their message, "ooc" in any case. It is an admin command, so every model of the turn sees it, whatever it says:
// the narrator reads the message itself and a PRE call reads it as its user content, but a POST call reads the reply
// instead, and a call's input filter can cut the message. Such a call is sent the commands beside its rules.

// Every OOC command in `text`, in order, each from its opening bracket to the bracket that closes it (brackets of the
// same kind nest). An opening never closed is no command: everything after it lies inside it, and `unclosed` holds
// its first 40 characters for the caller's warning. Returns { commands, unclosed }.
export function readOocCommands(text) {
    const source = String(text == null ? '' : text);
    const closerOf = { '[': ']', '(': ')' };
    const opening = /[[(]\s*ooc\s*:/gi;
    const commands = [];
    const unclosed = [];
    let match;
    while ((match = opening.exec(source)) !== null) {
        const open = match[0][0];
        let depth = 1;
        let end = opening.lastIndex;
        while (end < source.length && depth > 0) {
            if (source[end] === open) depth++;
            else if (source[end] === closerOf[open]) depth--;
            end++;
        }
        if (depth > 0) {
            unclosed.push(source.slice(match.index, match.index + 40));
            break;
        }
        commands.push(source.slice(match.index, end));
        opening.lastIndex = end;
    }
    return { commands, unclosed };
}

// The block that hands a call the player's OOC commands, word for word; '' when there are none.
export function buildOocCommandBlock(commands) {
    const list = (Array.isArray(commands) ? commands : []).map((c) => String(c == null ? '' : c).trim()).filter(Boolean);
    if (!list.length) return '';
    return [
        '<ooc_commands>',
        'An out-of-character command is the player\'s admin order from outside the story, and every model of the game is shown the ones in the player\'s message this turn. Your input leaves them out, so they are copied here, word for word:',
        ...list,
        'Follow each one wherever it concerns your task, even over your other instructions; ignore any that does not.',
        '</ooc_commands>',
    ].join('\n');
}

// What one call is sent for the turn's OOC commands. `userLine` is the player's message the turn answers, `callInput`
// the call's user content after its input filter: a command that input already carries word for word is not sent
// twice. Returns { block, carried, unclosed }: `block` '' when nothing is sent, `carried` the commands it holds,
// `unclosed` as readOocCommands gives it.
export function oocCommandBlockFor(userLine, callInput) {
    const { commands, unclosed } = readOocCommands(userLine);
    const input = String(callInput == null ? '' : callInput);
    const carried = commands.filter((command) => !input.includes(command));
    return { block: buildOocCommandBlock(carried), carried, unclosed };
}

// sendRequest max-tokens: a positive number, else undefined (let the preset decide).
export function normalizeMaxTokens(v) {
    return Number(v) > 0 ? Number(v) : undefined;
}

// temperature → overridePayload, only when a real number was actually provided.
export function buildOverridePayload(temperature) {
    const payload = {};
    const t = Number(temperature);
    if (String(temperature).trim() !== '' && !Number.isNaN(t)) payload.temperature = t;
    return payload;
}

// Normalise a completion response to plain text. Handles BOTH shapes sendRequest can hand back:
// the extracted `{content}`/`{text}` object (extractData:true) and the provider's RAW json
// (extractData:false — what runLlmCall requests, so the finish reason survives, see
// completionCutReason). The raw arms mirror ST's own extractMessageFromData switch without needing
// to know which API class served the call: chat completions (`choices[0].message.content`), text
// completions (`choices[0].text`), kobold (`results[0].text`), novel (`output`).
export function extractCompletionText(data) {
    if (typeof data === 'string') return data;
    if (!data) return '';
    const t = data.content
        ?? data.choices?.[0]?.message?.content
        ?? data.choices?.[0]?.text
        ?? data.results?.[0]?.text
        ?? data.output
        ?? data.text;
    return String(t || '');
}

// completionCutReason lives in shared/completion-finish.js (P3: the MAIN-generation finish-reason tap
// reads the same wire shapes). Re-exported so this feature's callers import it from here.
export { completionCutReason } from '../../shared/completion-finish.js';

// WHAT AN ANSWER WITH NO TEXT HELD. The request worked and the provider answered, but extractCompletionText found no
// text in it. The response says why: its finish reason, a refusal the provider sent in place of text (OpenAI's
// `message.refusal`), and how many output tokens it spent, how many of them on reasoning (a model that thought and
// wrote nothing). One line for the log; a part the response does not carry is left out.
export function describeNoTextAnswer(data) {
    const parts = [];
    const reason = completionFinishReason(data);
    const choice = data && typeof data === 'object' && Array.isArray(data.choices) ? data.choices[0] : null;
    const native = String((choice && choice.native_finish_reason) || '').trim();
    if (reason) parts.push(`finish_reason "${reason}"${native && native.toLowerCase() !== reason.toLowerCase() ? ` (native: ${native})` : ''}`);
    const refusal = String((choice && choice.message && choice.message.refusal) || '').trim();
    if (refusal) parts.push(`refusal "${refusal}"`);
    const count = (v) => (v == null || v === '' ? NaN : Number(v));
    const usage = data && typeof data === 'object' ? data.usage : null;
    const output = count(usage && usage.completion_tokens);
    const reasoning = count(usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens);
    if (Number.isFinite(output)) parts.push(reasoning > 0 ? `${output} output token(s), ${reasoning} of them reasoning` : `${output} output token(s)`);
    return parts.length ? parts.join(' · ') : 'the response carries no finish reason and no token counts';
}

// ── a call that leaves its pass nothing to use ───────────────────────────────
// WHY, one cause per call, so the pass's summary never names a cause that did not happen. `raw` is what the call
// returned (runCallBounded resolves a call that threw or timed out to null, and logs which), `kept` what the pass
// kept of it after its checks, `isQuietPatch` (PRE) that its answer was an empty patch and nothing else.
//   'failed'  — the request threw or timed out;
//   'no-text' — the provider answered, and the answer held no text (describeNoTextAnswer says what it held);
//   'refused' — it answered, and the pass's own checks left nothing usable: the card's output check or, on PRE, a
//               patch refused or not applied (each logs its own line);
//   'quiet'   — the contract's "no change this turn": nothing to use, and nothing lost;
//   ''        — it left something usable.
export function emptyResultCause({ raw, kept, isQuietPatch = false } = {}) {
    if (raw == null) return 'failed';
    if (!String(raw).trim()) return 'no-text';
    if (String(kept == null ? '' : kept).trim()) return '';
    return isQuietPatch ? 'quiet' : 'refused';
}

// Does a call carry only tasks? True when every lorebook entry routed to it is a task's routing entry
// (`isTaskEntryName`, llm-task-router's isTaskRoutingEntryName): the call has no duty of its own. False for a call
// routed nothing.
export function carriesOnlyTasks(entryNames, isTaskEntryName) {
    const names = Array.isArray(entryNames) ? entryNames : [];
    return names.length > 0 && typeof isTaskEntryName === 'function' && names.every((name) => isTaskEntryName(name));
}

// WHO ANSWERS FOR AN EMPTY RESULT. An answer with no text from a call that carries only tasks is its tasks' to judge:
// each task's output handler knows whether it asked for anything (the registration task warns when someone it asked
// to register stays unregistered). Every other empty result degrades the pass: a failed call, an answer that breaks
// the call's own contract, an output its checks refused. A quiet result is neither.
// `rows` is [{ label, cause, isTaskOnly, detail }], `detail` describeNoTextAnswer's line for a 'no-text' one.
export function sortEmptyResults(rows) {
    const degraded = [];
    const handedToTasks = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.cause || row.cause === 'quiet') continue;
        if (row.cause === 'no-text' && row.isTaskOnly) handedToTasks.push(row);
        else degraded.push(row);
    }
    return { degraded, handedToTasks };
}

const EMPTY_RESULT_WORDS = {
    failed: 'failed or timed out',
    'no-text': 'answered with no text',
    refused: 'left nothing usable after the checks',
};

// One empty result in words, e.g. `POST answered with no text: finish_reason "stop" · 125 output token(s), 119 of
// them reasoning`. `withDetail: false` leaves the provider's detail out, for a toast.
export function describeEmptyResult(row, { withDetail = true } = {}) {
    const detail = withDetail && row.detail ? `: ${row.detail}` : '';
    return `${row.label} ${EMPTY_RESULT_WORDS[row.cause] || row.cause}${detail}`;
}

// ── interceptor orchestration ────────────────────────────────────────────────

// The configured calls that are actually runnable (enabled + named + has a profile).
export function enabledCalls(calls) {
    return (calls || []).filter(
        (c) => c && c.enabled && c.profileId && String(c.name || '').trim());
}

// What keeps a call from running, in the settings tab's words — enabledCalls' rule, so what a call's card says
// and what the runtime does cannot drift apart:
//   'no-name'       — an unnamed call is routed no lorebook entries, switched on or not;
//   'no-connection' — the call is on, but with no connection profile it has no endpoint;
//   ''              — it runs, or it is off on purpose.
export function callRunBlocker(call) {
    if (!String((call && call.name) || '').trim()) return 'no-name';
    if (!call.enabled) return '';
    if (!call.profileId) return 'no-connection';
    return '';
}

// A call's phase: 'pre' (runs in the interceptor, before the main reply) or 'post'
// (runs after the main reply, over the AI's prose). Default 'pre': a stored call may
// carry no `phase` field at all.
export function callPhase(call) {
    return call && call.phase === 'post' ? 'post' : 'pre';
}

// Runnable calls for a given phase.
export function enabledCallsForPhase(calls, phase) {
    const want = phase === 'post' ? 'post' : 'pre';
    return enabledCalls(calls).filter((c) => callPhase(c) === want);
}

// Lorebook entries routed to a call that will not run, and why. Routing reads a call's tag and never an
// entry's own `enabled`: a PRE/POST entry is often disabled on purpose, so the narrator never reads it.
// Whether its text reaches a model is decided by Extra LLM Calls alone:
//   'extra-calls-off' — the Extra LLM Calls switch is off, so no call runs;
//   'disabled'        — the call itself is switched off;
//   'no-connection'   — the call is on but has no connection profile, so it cannot run.
// A group tag counts only when none of its member calls runs ('no-member-runs'): while one member runs, the
// group's entries still reach a model. Returns [{ name, isGroup, reason, entryNames }]: calls in list order,
// then groups.
export function unrunnableRoutedCalls({ isExtraCallsOn = false, calls = [], groups = [], entries = [] } = {}) {
    const callList = Array.isArray(calls) ? calls : [];
    const book = Array.isArray(entries) ? entries : [];
    const isRunnable = (call) => isExtraCallsOn === true && enabledCalls([call]).length === 1;
    const routedEntryNames = (tag) => selectLorebookEntries(book, tag)
        .map((entry) => String((entry && entry.comment) || '').trim() || '(an entry with no comment)');
    const findings = [];
    for (const call of callList) {
        const name = String((call && call.name) || '').trim();
        if (!name || isRunnable(call)) continue;
        const entryNames = routedEntryNames(name);
        if (!entryNames.length) continue;
        const reason = isExtraCallsOn !== true ? 'extra-calls-off' : (!call.enabled ? 'disabled' : 'no-connection');
        findings.push({ name, isGroup: false, reason, entryNames });
    }
    for (const group of (Array.isArray(groups) ? groups : [])) {
        const tag = String((group && group.tag) || '').trim();
        if (!tag) continue;
        const memberNames = Array.isArray(group.members) ? group.members : [];
        if (callList.some((call) => call && memberNames.includes(call.name) && isRunnable(call))) continue;
        const entryNames = routedEntryNames(tag);
        if (!entryNames.length) continue;
        findings.push({ name: tag, isGroup: true, reason: isExtraCallsOn !== true ? 'extra-calls-off' : 'no-member-runs', entryNames });
    }
    return findings;
}

// Run each call through `runOne(call, userText) -> Promise<string|null>`, either all
// at once (parallel, default) or in declared order (sequential). `runOne` is expected
// not to reject (callers wrap it to log + return null); a stray rejection still maps
// to null so one bad call never sinks the batch. Results are always aligned to `calls`.
//
// `keyOf` (optional, parallel mode only): distinct keys run in PARALLEL, same-key calls run
// SEQUENTIALLY. No keyOf → full parallel. The call sites pass callScheduleKey (the connection
// profile): calls sharing a profile share one ENDPOINT, and firing them all at once chokes a
// single-slot local server. This is a THROUGHPUT choice, not a race guard — nothing shared is
// mutated (runLlmCall is read-only on ST state), so dropping `keyOf` would still be correct, just
// less polite.
// A failed `runOne` maps to `null` here so ONE bad call never sinks the batch (deliberate isolation). This
// is NOT a hidden swallow: `runOne` is CONTRACTED to log its own failures (the runtime passes runCallBounded,
// which log.errors + returns null). This pure file has no logger, so it must not be the thing that surfaces
// errors — that's the caller's job.
export async function runCalls(calls, userText, runOne, parallel, keyOf) {
    if (parallel !== false) {
        if (typeof keyOf === 'function') {
            const groups = new Map();                       // key → [{ idx, call }] (declared order within a key)
            calls.forEach((call, idx) => {
                const k = keyOf(call);
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push({ idx, call });
            });
            const results = new Array(calls.length).fill(null);
            await Promise.all([...groups.values()].map(async (group) => {
                for (const { idx, call } of group) {
                    try { results[idx] = await runOne(call, userText); }
                    // EXPECTED: runOne is contracted to log its own failure (see the note above this
                    // function). null is the batch-isolation value, not a lost error.
                    catch { results[idx] = null; }
                }
            }));
            return results;
        }
        return Promise.all(
            // EXPECTED: same contract as the keyed branch — runOne logs, null isolates.
            calls.map((c) => Promise.resolve().then(() => runOne(c, userText)).catch(() => null)));
    }
    const results = [];
    for (const c of calls) {
        try { results.push(await runOne(c, userText)); }
        // EXPECTED: same contract as the parallel branches — runOne logs, null isolates.
        catch { results.push(null); }
    }
    return results;
}

// The key the call sites hand runCalls: calls on one connection profile run one after another.
export const callScheduleKey = (call) => (call ? call.profileId : undefined);

// The post-reply phase's clock, from the Call timeout. runCalls runs POST calls in chains: with `parallel` on,
// the calls that share a connection profile one after another (callScheduleKey) and the profiles at once; with
// it off, every call one after another. Each call in the longest chain gets one Call timeout of the phase's
// time — a slot: a warning halfway through each slot while the phase still runs, and the phase's deadline at
// the end of the last slot. A phase with no POST call still gets one slot: it waits for RES1, runs POST-done
// and writes the reply.
export function postPhaseTimings({ calls, isParallel, callTimeoutMs }) {
    const list = Array.isArray(calls) ? calls : [];
    let longestChain = list.length;
    if (isParallel !== false) {
        const chains = new Map();   // schedule key → calls in that chain
        for (const call of list) {
            const key = callScheduleKey(call);
            chains.set(key, (chains.get(key) || 0) + 1);
        }
        longestChain = Math.max(0, ...chains.values());
    }
    const slots = Math.max(1, longestChain);
    return {
        warnAtMs: Array.from({ length: slots }, (_, slot) => (slot + 0.5) * callTimeoutMs),
        deadlineMs: slots * callTimeoutMs,
    };
}

// Assemble the labelled injection block from calls + their (aligned) outputs.
// Empty/null outputs are skipped.
export function buildInjectionBlock(calls, results) {
    let block = '';
    for (let i = 0; i < calls.length; i++) {
        const out = results[i];
        if (out && String(out).trim()) {
            block += `[${calls[i].name}]\n${String(out).trim()}\n[/${calls[i].name}]\n\n`;
        }
    }
    return block;
}

// Extract each <UpdateVariable>…</UpdateVariable> block from a POST call's output so the
// runtime can hand them to MVU (Mvu.parseMessage / message append). Stray prose around a block
// is tolerated, and so is more than one block: each entry routed to the call may ask for its own.
// Blocks whose <JSONPatch> body is empty ([] / whitespace) are dropped — nothing to apply.
export function extractUpdateVariableBlocks(text) {
    const s = String(text == null ? '' : text);
    const re = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi;
    const blocks = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        const block = m[0];
        const jp = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(block);
        const body = (jp ? jp[1] : block.replace(/<\/?UpdateVariable>/gi, '')).trim();
        if (body === '' || body === '[]') continue;     // empty patch — nothing to apply
        blocks.push(block);
    }
    return blocks;
}

// The <UpdateVariable> blocks of one POST call's output that may go into the reply: `{ blocks, refusedTokens }`.
// The reply is page text — TavernHelper renders an html document in it and ST-Prompt-Template runs a `<%` in
// it — so a block carrying a page-code token (pageCodeTokenIn) is refused whole, the rule engine text follows
// (auditBlockFromBody), and `refusedTokens` names each refused block's token for the caller's warning. A
// refused block is not applied either: MVU applies the same blocks the reply shows, so its ops never land.
export function postBlocksForReply(text) {
    const blocks = [];
    const refusedTokens = [];
    for (const block of extractUpdateVariableBlocks(text)) {
        const refusedToken = pageCodeTokenIn(block);
        if (refusedToken) refusedTokens.push(refusedToken);
        else blocks.push(block);
    }
    return { blocks, refusedTokens };
}

// Card-supplied OUTPUT shape check — the write-side mirror of applyInputFilter, and THE single
// verdict both PRE and POST enforcement go through (one helper so the two phases can never drift).
// `outputRegex` (per-call, optional, same `/pattern/flags`-or-bare syntax as inputRegex via
// parseInputFilterRegex) declares what a VALID output looks like — e.g. School's PRE sets a JSON-object
// shape. Returns:
//   { ok:true }                 — no pattern configured, or the output matches
//   { ok:false, invalid:true }  — the pattern itself doesn't compile (config error — caller warns, keeps output)
//   { ok:false }                — output does NOT match the declared shape (caller drops it as garbage)
export function checkCallOutput(output, outputRegex) {
    const { re, invalid } = parseInputFilterRegex(outputRegex);
    if (invalid) return { ok: false, invalid: true };
    if (!re) return { ok: true };
    return { ok: re.test(String(output == null ? '' : output)) };
}

// Classify a POST call's raw output so the runtime can tell "deliberately nothing to record" (the
// contract's EMPTY patch — extractUpdateVariableBlocks drops it by design, so block-count alone can't
// distinguish) from a REAL problem. Returns:
//   'empty'      — no output at all (the pass's empty-result summary covers this)
//   'ok'         — ≥1 wrapper block with a non-empty patch (something to apply)
//   'ok-empty'   — well-formed <UpdateVariable> wrapper, all patches empty/[] — the contract's "nothing to record"
//   'bare-empty' — a bare [] / empty <JSONPatch> WITHOUT the wrapper — off-contract but unambiguously "nothing"
//   'lost-ops'   — patch content present but NOT inside an <UpdateVariable> wrapper → the extractor DROPS it (data loss!)
//   'prose'      — text with no recognizable patch structure at all (contract violation)
export function classifyPostOutput(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return 'empty';
    if (extractUpdateVariableBlocks(s).length > 0) return 'ok';
    if (/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i.test(s)) return 'ok-empty';
    const jp = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(s);
    if (jp) { const b = jp[1].trim(); return (b === '' || b === '[]') ? 'bare-empty' : 'lost-ops'; }
    if (s === '[]') return 'bare-empty';
    try { const arr = JSON.parse(s); if (Array.isArray(arr)) return arr.length ? 'lost-ops' : 'bare-empty'; } catch { /* EXPECTED: not JSON → fall through to prose */ }
    return 'prose';
}

// Parse a POST block's <JSONPatch> body into an ops array [{op,path,value}, …] for logging /
// inspection. Tolerant: missing/!array/invalid JSON → []. The block may be a bare JSON array too.
export function parsePatchOps(block) {
    const s = String(block == null ? '' : block);
    const jp = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(s);
    const body = (jp ? jp[1] : s).trim();
    if (!body) return [];
    try {
        const arr = JSON.parse(body);
        return Array.isArray(arr) ? arr.filter((o) => o && typeof o === 'object') : [];
    // EXPECTED: this parse is TOLERANT by contract (see above) — a POST block that carries no valid
    // patch has no ops, and the block's own text is what gets logged and inspected upstream.
    } catch { return []; }
}

// (getAtPointer is shared/json-patch-ops.js's — the plugin relay reads applied paths the same way,
// and two copies of "what does this pointer address" is how two lanes drift.)

/**
 * THE POST REFUSAL PROBE, as a decision (L6): which of the ops POST actually SENT are absent from
 * the state MVU handed back. Pure, so the check is testable even though its caller is host-coupled.
 *
 * ⚠ It reads the SENT blocks, not a diff of what changed — because a refused op is precisely what a
 * diff can never contain. This is the complement of the turn's `ops` receipt, not a second copy.
 *
 * Without it a refused op is silent: the card's Zod refuses that op alone, the rest of the patch
 * lands, and nothing of ours says a write the model sent never happened.
 *
 * `applied` null (MVU unavailable, or it changed nothing) with ops sent = every op refused; that is
 * reported as refused:[] with allRefused:true, because naming paths we cannot prove landed nowhere
 * would be a guess, while the COUNT is a fact.
 * @returns {{ sent: number, refused: string[], allRefused: boolean }}
 */
export function postOpsRefused(postBlocks, applied) {
    const ops = (Array.isArray(postBlocks) ? postBlocks : []).flatMap((b) => parsePatchOps(b));
    if (!applied || !applied.stat_data) return { sent: ops.length, refused: [], allRefused: ops.length > 0 };
    return { sent: ops.length, refused: opsMissingAfterApply(applied.stat_data, ops), allRefused: false };
}

// Rewrap a POST <UpdateVariable> block as <POSTUpdateVariable> so it's regex-separable from the narrator's
// block in the card's display regexes. ONLY the wrapper tag changes — the inner <JSONPatch> is untouched, so
// MVU's op extractor (a global matchAll on <json_?patch>, wrapper-agnostic) still applies the ops.
export function toPostWrapper(block) {
    return String(block == null ? '' : block).replace(/<(\/?)UpdateVariable>/gi, '<$1POSTUpdateVariable>');
}

// WHICH <RES_Variable> does POST carry, and does it write at all? Pure so the decision is testable —
// it lives in a file no test can open otherwise (the POST pass imports ST's script.js).
//
// `gateBlock` is what the pre-calls RES gate captured; `stagedAtWrite` is the marker re-read AFTER the
// LLM calls, seconds later. The second one exists because the first can legitimately be empty on a turn
// where RES simply resolved late (cold engine load), and deciding from the stale capture alone would
// write nothing and drop an audit block that is, by then, sitting staged and complete.
//
// ⚠ THE FRESHER READ WINS, not the gate. RES can resolve a turn MORE THAN ONCE as the narrator's patch
// lands progressively: the first pass sees only what PRE already wrote (the check), a later one sees the
// full set (the clock report, the spine step). Every pass restages, so the LAST marker is the complete
// one — preferring the gate would publish the FIRST pass's half-finished audit while the staged marker
// holds the real answer. The staged read cannot belong to another turn — readResStaged
// filters it to THIS {mid,swipe}, a cross-generation corpse is dropped when the generation starts
// (isStagedBlockStale), and POST abandons the write entirely at its own turn fence if the epoch moved.
// So "fresher" here can only ever mean "the same turn, more complete".
//
// `late` drives the log: a recovered block must never be reported as if the gate had succeeded, and a
// gate hit that was SUPERSEDED must not read as if the gate's block is what got written.
export function decideResCarry(gateBlock, stagedAtWrite, postBlockCount) {
    const gate = String(gateBlock || '');
    const staged = String(stagedAtWrite || '');
    const block = staged || gate;
    const late = !gate && !!staged;
    const refreshed = !!gate && !!staged && staged !== gate;
    return {
        block,
        late,
        refreshed,
        willWrite: !!(Number(postBlockCount) || block),
        label: late ? 'carried (arrived late)'
            : refreshed ? 'carried (refreshed at write time — RES resolved again after the gate)'
                : (block ? 'carried' : 'none'),
    };
}

// Did the post-reply phase SETTLE the turn, so that its end refreshes the stat box from the reply's stored
// state? Only when the pass waited for the turn's own work and the turn was still live at that point: POST
// calls ran (seconds, behind the RES gate when a resolver runs, with POST's own parse awaited), or, with no
// call, the pass waited for RES1's whole run. Otherwise the stored state may not hold this reply's numbers
// yet — with no resolver and no call the pass ends before MVU has stored narrate's parse — and the box RES1
// placed, if any, stands.
export function isTurnSettledAtPostEnd({ didPostCallsRun, didAwaitTurnResolver, isTurnLive }) {
    return !!isTurnLive && (!!didPostCallsRun || !!didAwaitTurnResolver);
}

// Remove every WRAPPED patch block: narrate's <UpdateVariable> and POST's relayed <POSTUpdateVariable>.
// POST's own output is split with this one, because there a bare <JSONPatch> is not a patch POST may
// write: classifyPostOutput names it 'lost-ops', so it has to stay where that check can see it.
export function stripUpdateVariableBlocks(text) {
    return String(text == null ? '' : text)
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
        .replace(/<POSTUpdateVariable>[\s\S]*?<\/POSTUpdateVariable>/gi, '')   // POST's own relayed block (renamed wrapper)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Remove every block MVU would apply as a state change from a REPLY: both wrappers above, and a <JSONPatch>
// standing on its own. Applied to a POST call's input and to the reply history a call's macros read, so a
// small model never re-reads (and re-emits) patches that already landed.
// THE BARE <JSONPatch> COUNTS. MVU's extractor matches <json_?patch> anywhere in the message, wrapped or
// not, so a narrator that drops the <UpdateVariable> wrapper still writes state, and a wrapper-only strip
// would hand that patch to POST to echo back. MVU's `_.set(…);` commands outside a wrapper also
// apply, and are NOT stripped here: matching them takes MVU's bracket-aware parser, not a regex.
export function stripPatchBlocks(text) {
    return stripUpdateVariableBlocks(text)
        .replace(/<(json_?patch)>[\s\S]*?<\/\1>/gi, '')   // a bare patch, as MVU's own extractor finds it
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── persistent PRE ("sim" calls) ─────────────────────────────────────────────────────────────────
// A PRE call becomes a SIM by EMITTING a <JSONPatch> — patch presence is the switch.
// The patch may write ANY path the card's Zod validates: PRE is the card's own call, same author and
// same trust level as narrate and POST, whose patches are gated by the Zod alone. Strict-strip is the
// real containment; instruction is the real discipline. A sim reads its own earlier state the way every
// call reads state: EJS in its routed entries, pinned to the base floor. There is no per-call state
// feed (the retired `ownedRoot` — RETIRED_CALL_FIELDS has the why). The runtime validates the patch
// STRUCTURALLY (here), renders prose FROM the ops for the narrator (here), and applies at PRE time
// via Mvu.parseMessage + replaceMvuData (host side — parseMessage alone applies to a clone it
// returns and persists NOTHING). These helpers are the decision-shaped halves: pure, no host imports.

// (the sim's legal verbs are shared/json-patch-ops.js PATCH_VERBS — the plugin relay emits the same
// three, for the same reason, into the same parser.)

// MIXED OUTPUT split: a sim call may emit ordinary call output (e.g. a JSON
// verdict the narrator reads off the inject) PLUS <JSONPatch> blocks. The patch half feeds
// validateSimPatchOutput → the PRE-time apply; the remainder stays ordinary output. Rules:
//   - EVERY <JSONPatch>…</JSONPatch> found → patchTexts, in order; remainder = everything around
//     them (stray <UpdateVariable> wrapper tags stripped, trimmed).
//   - no block: strip <UpdateVariable> wrappers, and if the WHOLE remaining text parses as a JSON
//     ARRAY it IS the patch — the naked-array tolerance, for a patch-only sim that emits a bare array.
//     A JSON OBJECT (a verdict) must NEVER be eaten by that fallback.
//   - neither → { patchTexts: [], remainder: trimmed raw }: the caller warns (a sim call whose
//     output carries no patch) but keeps the remainder — the verdict must survive a missing patch.
//
// ▲ ALL blocks, not the first: one call's system block is the CONCATENATION of every lorebook entry
// routed to it, and an entry is entitled to ask for its own patch — so several blocks in one output
// is a supported shape, not a malformed one. Taking only the first would silently drop every later
// entry's state AND leave its raw ops in the remainder, injected into the narrator's prompt verbatim
// (breaking both halves of renderSimInjectLines' raw-ops rule: MVU's native parse becomes a second
// writer, and machine syntax degrades the narrative model).
export function splitSimOutput(raw) {
    const s = String(raw == null ? '' : raw);
    const wrapper = /<\/?(?:POST)?UpdateVariable>/gi;
    const blocks = /<JSONPatch>[\s\S]*?<\/JSONPatch>/gi;
    const patchTexts = s.match(blocks) || [];
    if (patchTexts.length) {
        const remainder = s.replace(blocks, '').replace(wrapper, '').trim();
        return { patchTexts, remainder };
    }
    const unwrapped = s.replace(wrapper, '').trim();
    if (unwrapped.startsWith('[')) {
        // EXPECTED throw: arbitrary model text may open with '[' without being JSON — that is the
        // "no patch" case, not an error; validateSimPatchOutput is where a MALFORMED patch warns.
        try { if (Array.isArray(JSON.parse(unwrapped))) return { patchTexts: [unwrapped], remainder: '' }; } catch { /* EXPECTED: not JSON → no patch */ }
    }
    return { patchTexts: [], remainder: s.trim() };
}

// The card's `outputRegex` verdict on ONE piece of text — the single decision behind both phases'
// enforcement, so PRE and POST can never drift on what a failure means. Returns the text to keep
// plus WHY, and never throws: an invalid pattern is a config error that must degrade to "no check"
// rather than silently discard good output.
//   { text, dropped:false, invalid:false } — passed, or no pattern configured, or nothing to check
//   { text, dropped:false, invalid:true }  — the pattern itself is broken; output KEPT, caller warns
//   { text:'', dropped:true, invalid:false } — failed the card's contract; caller warns the cause
export function decideOutputCheck(text, outputRegex) {
    const s = String(text == null ? '' : text);
    const pat = String(outputRegex == null ? '' : outputRegex).trim();
    if (!pat || !s.trim()) return { text: s, dropped: false, invalid: false };
    const v = checkCallOutput(s, pat);
    if (v.invalid) return { text: s, dropped: false, invalid: true };
    return v.ok ? { text: s, dropped: false, invalid: false } : { text: '', dropped: true, invalid: false };
}

// ▲ THE PROSE-ONLY CHECK FOR **POST** — the same rule as splitAndCheckSimOutput, in a different lane.
// Checking the RAW output lets one stray token — a preamble, a ```json fence, a <think>, a trailing
// note — empty the result before anything looks for the <UpdateVariable> block. It costs MORE here
// than on PRE: a dropped PRE output loses a verdict, a dropped POST block loses the whole turn's state
// write, silently. A card with no POST `outputRegex` never meets it, but that is an unset trap, not a
// safeguard: the natural reaction to a chatty POST model is to set exactly that regex.
//
// Same shape as splitAndCheckSimOutput, different splitter: POST's payload is the <UpdateVariable>
// wrapper (a bare <JSONPatch> is 'lost-ops' and is dropped downstream by design), so the blocks are
// taken out by the wrapper and the card's pattern judges the PROSE ONLY.
//
// EMPTY blocks are KEPT here, unlike extractUpdateVariableBlocks which drops them: `[]` is the
// contract's deliberate quiet-turn answer, and classifyPostOutput needs to still be able to tell it
// apart from a model that broke the contract entirely.
//
// Returns { blocks, prose, proseDropped, regexInvalid }. The caller rebuilds only when prose was
// dropped — a passing check leaves the raw output byte-identical.
export function splitAndCheckPostOutput(raw, outputRegex) {
    const s = String(raw == null ? '' : raw);
    const blocks = s.match(/<(?:POST)?UpdateVariable>[\s\S]*?<\/(?:POST)?UpdateVariable>/gi) || [];
    const prose = stripUpdateVariableBlocks(s);
    const verdict = decideOutputCheck(prose, outputRegex);
    return { blocks, prose: verdict.text, proseDropped: verdict.dropped, regexInvalid: verdict.invalid };
}

// ▲ THE PROSE-ONLY CHECK, extracted so it is reachable from a test (L6): a mixed PRE output has TWO
// halves validated by two different things — the patch blocks by validateSimPatchOutput (strict
// JSON), the prose by the card's `outputRegex` — so the split must happen FIRST and the check must
// see the PROSE ONLY.
//
// Checking the RAW output would couple them, and the coupling is total: one stray token anywhere (a
// preamble, a ```json fence, a <think> block, a trailing note) empties the whole result before the
// split, so a perfectly well-formed patch is discarded with the prose and the turn loses its state
// without ever being looked at. On School's PRE that means `/Intent/check/0` — the dice report —
// dies to a stray word, and the check never resolves.
//
// Split first, a bad prose half costs the narrator's injection ONLY, and a bad patch costs the state ONLY.
export function splitAndCheckSimOutput(raw, outputRegex) {
    const { patchTexts, remainder } = splitSimOutput(raw);
    const verdict = decideOutputCheck(remainder, outputRegex);
    return { patchTexts, prose: verdict.text, proseDropped: verdict.dropped, regexInvalid: verdict.invalid };
}

// (the per-op shape check is shared/json-patch-ops.js patchOpShapeProblem, and the salvage loop
// below is salvagePatchOps — shared because the plugin relay runs the same checks, the "no
// path-scope check" reasoning included.)

// What the PRE-rail engine hooks (preVerdictPatch, pickSameRoundEvent) are handed about each PRE call: its `name`, its
// RAW `output`, and `appliedOps` — the JSON Patch ops this rail validated (validateSimPatchOutput) and applied from that
// call's <JSONPatch> blocks this attempt, [] when it wrote none or its patch was rejected or failed to apply. An engine
// reads a call's writes from `appliedOps` instead of parsing the raw output again: one parser, so what the engine judges
// is exactly what landed in state. `appliedOpsByCall` lines up with `preOutputs` by index.
export function preHookOutputs(preOutputs, appliedOpsByCall) {
    const applied = Array.isArray(appliedOpsByCall) ? appliedOpsByCall : [];
    return (Array.isArray(preOutputs) ? preOutputs : []).map((o, i) => ({
        name: o.name,
        output: o.output,
        appliedOps: Array.isArray(applied[i]) ? [...applied[i]] : [],
    }));
}

// Validate one sim patch block into the canonical block the PRE-time apply writes. Returns:
//   { ok:true, ops, block, dropped } — `ops` = every op that SURVIVED; `block` = canonical
//                                 '<JSONPatch>…</JSONPatch>' rebuilt from those parsed ops (never
//                                 the raw text, so stray prose can't ride into the apply); `dropped`
//                                 = [{ index, reason }] the caller warns, one line each.
//   { ok:false, reason }        — the block is unusable AS A WHOLE: no body, unparseable JSON
//                                 (the truncation case this must DETECT, not swallow — the tolerant
//                                 parsePatchOps above returns [] there), or not an array.
//
// PER-OP SALVAGE, not all-or-nothing — the rule and its reasoning live with salvagePatchOps.
// `ok:true` with `ops:[]` and `dropped:[]` is the contract's EMPTY patch (a quiet turn); `ops:[]`
// with a non-empty `dropped` is every op rejected, which the caller must NOT report as "no changes".
export function validateSimPatchOutput(text) {
    const s = String(text == null ? '' : text);
    // Accept the bare <JSONPatch> block the prompt asks for, an <UpdateVariable> wrapper around it
    // (models copy the narrate contract), or a naked JSON array. MVU itself keys on the inner
    // <JSONPatch>, so the canonical block always uses that form.
    const jp = /<JSONPatch>([\s\S]*?)<\/JSONPatch>/i.exec(s);
    const body = (jp ? jp[1] : s.replace(/<\/?(?:POST)?UpdateVariable>/gi, '')).trim();
    const fail = (reason) => ({ ok: false, reason, ops: [], block: '', dropped: [] });
    if (!body) return fail('no <JSONPatch> block in the output');
    let parsed;
    try { parsed = JSON.parse(body); }
    catch (e) { return fail(`patch body is not valid JSON (truncated output? token cap?): ${e.message}`); }
    if (!Array.isArray(parsed)) return fail('patch body is not an array of ops');
    const { ops, dropped } = salvagePatchOps(parsed);
    return { ok: true, ops, block: ops.length ? `<JSONPatch>${JSON.stringify(ops)}</JSONPatch>` : '', dropped };
}

// Render the narrator-facing prose lines FROM the validated ops (the inject is DERIVED so
// prose and state cannot drift; the VALUE carries the human phrase, so rendering is mechanical).
// One line per op: the FULL path, segments dot-joined > value.
//
// THE RAW OPS NEVER REACH THE NARRATOR — two INDEPENDENT reasons, and only
// the first is mechanical:
//   1. Correctness: an echoed <JSONPatch> in the narrator's own <UpdateVariable> is applied by
//      MVU's native parse — a second writer.
//   2. Comprehension: machine syntax in a narrative prompt degrades the model (same hazard family
//      as nested {} in EJS and forced verbatim re-emission of long blocks — both known to halt the
//      roleplay model). Smaller models degrade worst.
// Reason 1 is WEAK under PRE-time apply (absolute replace ops make a double-apply idempotent) —
// an auditor will correctly observe the echo is harmless and conclude this rule can go. It
// cannot: reason 2 is doing the work, and it does not weaken at all.
// Path display: ALWAYS the full path. The path is the line's only label: the narrator's own rules name
// state by its path (/Intent/check), so a shortened one is a value the narrator cannot place. The
// retired owned root printed "0 > target:…" for an op on /Intent/check/0, beside "Intent.fwb.0 > …"
// for an op outside it. A few tokens buy the meaning back.
export function renderSimInjectLines(ops) {
    const full = (p) => String(p).split('/').filter(Boolean).join('.');
    return (Array.isArray(ops) ? ops : []).map((o) => {
        if (o.op === 'remove') return `${full(o.path)} > (no longer tracked)`;
        const v = (typeof o.value === 'string') ? o.value : JSON.stringify(o.value);
        return `${full(o.path)} > ${v}`;
    }).join('\n');
}

/**
 * Decide whether a sim patch may be applied at PRE time. PURE, table-testable, mutation-verified:
 * guards a live session almost never reaches must be unit-proven, not taken on faith.
 *
 * The danger window is "the chat moved during the ~2s PRE call". The write REQUIRES a user floor
 * and refuses anything else.
 *
 * ORDER IS THE SAFETY ORDER, most-decisive first:
 *   1. stopped        — the user aborted the turn while the PRE call ran
 *   2. stale epoch    — a NEWER generation started under us
 *   3. no user floor  — chat[expectedUserIndex] is gone, or is not a user message
 *   4. swiped/moved   — expectedUserIndex is no longer the LAST user floor (the turn advanced)
 * A patch is only ever written on 'apply'; every other verdict means drop it (and log WHY).
 *
 * @param {number} entryEpoch          generationEpoch captured at interceptor entry
 * @param {number} currentEpoch        generationEpoch as of NOW
 * @param {boolean} generationStopped  the user aborted this turn
 * @param {Array} chat                 the REAL chat (SillyTavern.getContext().chat), re-read NOW
 * @param {number} expectedUserIndex   the user floor index captured before the calls ran
 * @returns {'apply'|'drop-stopped'|'drop-stale-epoch'|'drop-no-user-floor'|'drop-swiped'}
 */
export function simPreApplyDisposition({ entryEpoch, currentEpoch, generationStopped, chat, expectedUserIndex }) {
    if (generationStopped) return 'drop-stopped';
    if (entryEpoch !== currentEpoch) return 'drop-stale-epoch';
    const msg = Array.isArray(chat) ? chat[expectedUserIndex] : null;
    if (!msg || !msg.is_user) return 'drop-no-user-floor';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) {
            if (i !== expectedUserIndex) return 'drop-swiped';
            break;
        }
    }
    return 'apply';
}

// THE FLOOR UNDO RECORD (the attempt-residue guard). A regenerate or swipe re-fires PRE onto the same
// user floor, which still holds the previous attempt's writes (they persist via replaceMvuData). So each
// floor carries, per swipe, an UNDO RECORD: every path a PRE write touched, with the value it held
// before PRE's FIRST write there. A retry puts those paths back, then applies.
//
// ONLY those paths. The floor is not PRE's alone between attempts: the player edits stat_data in
// TavernHelper's variable manager — which emits no event — and deletes a turn to re-send at the same
// index. A whole-floor copy would restore those edits away on every PRE write: an edited value would
// snap back on each re-send whose PRE wrote anything, and hold on each re-send whose PRE wrote nothing.
// A path PRE wrote is PRE's to reset; nothing else on the floor is.
//
// The record is saved ON the message it guards (its `extra`, under SIM_UNDO_EXTRA_KEY, one per swipe),
// so it lasts exactly as long as the message: a retry after a page reload, a chat switch, or the later
// turns' deletion finds it, and a message deleted and sent again starts with none. A record kept apart
// from its message is rebuilt from a floor that already holds an attempt's writes, and the retry then
// "resets" to them. `attempt` names the generation that wrote it: a page-load id plus that load's
// generation counter, so two attempts never share one across a reload.
//
// simSnapshotDisposition decides, per apply:
//   'capture' — no record on this floor's swipe: start an empty one, then apply.
//   'restore' — a record from ANOTHER attempt: put every recorded path back, then apply.
//   'stack'   — a record from THIS attempt: a SECOND PRE write in one generation. No reset — it would
//               erase the first write; two writes in one turn compose, they don't race.
// Every apply adds its own ops' paths to the record (recordSimUndo — the first write wins). Pure, so the
// branch table is testable (L6); the host reads and saves the record (readSimUndoRecord / writeSimUndoRecord).
export const SIM_UNDO_EXTRA_KEY = 'mvuhelper_pre_undo';
export function simSnapshotDisposition(entry, attempt) {
    if (!entry) return 'capture';
    if (entry.attempt !== attempt) return 'restore';
    return 'stack';
}

// One PRE write's undo step on `stat`, the floor clone it applies to (mutated): when the stored record is
// another attempt's, its paths are put back first; then this write's paths join the record. Returns the
// record to save with the write, as a NEW object (the stored one is left as it was, so a write that fails
// to land never advances it), and the paths put back.
export function stepSimUndo(stored, attempt, stat, ops) {
    const disposition = simSnapshotDisposition(stored, attempt);
    const reset = disposition === 'restore' ? restoreSimUndo(stat, stored.undo) : [];
    const undo = disposition === 'capture' ? [] : stored.undo.map((u) => ({ ...u }));
    recordSimUndo(undo, stat, ops);
    return { record: { attempt, undo }, reset };
}

// The undo record a message carries for `swipe`: { record } (undefined when it carries none), or
// { isMalformed: true } when what sits under the key is not a record (a hand-edited chat file) — the host
// says so and records afresh.
export function readSimUndoRecord(message, swipe) {
    const store = (message && message.extra && typeof message.extra === 'object') ? message.extra[SIM_UNDO_EXTRA_KEY] : undefined;
    if (store === undefined) return { record: undefined };
    const record = (store && typeof store === 'object' && !Array.isArray(store)) ? store[String(swipe)] : store;
    if (record === undefined) return { record: undefined };
    const isRecord = !!record && typeof record === 'object' && typeof record.attempt === 'string' && Array.isArray(record.undo)
        && record.undo.every((u) => !!u && typeof u === 'object' && typeof u.path === 'string' && typeof u.had === 'boolean');
    return isRecord ? { record } : { isMalformed: true };
}

// Saves `record` as the message's undo record for `swipe`, in place: the message's other `extra` keys and
// its other swipes' records stay as they are.
export function writeSimUndoRecord(message, swipe, record) {
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    const store = message.extra[SIM_UNDO_EXTRA_KEY];
    const records = (store && typeof store === 'object' && !Array.isArray(store)) ? store : {};
    records[String(swipe)] = record;
    message.extra[SIM_UNDO_EXTRA_KEY] = records;
}

// The path whose value an op disturbs. `add` and `remove` into an array SHIFT its items, so an index
// names a different element before and after the write — those record the whole array. A `replace` at
// an index shifts nothing and records just that element (an MVU tuple's /Field/0).
export function simUndoPath(op, before) {
    const segs = String(op.path).split('/').filter((x) => x !== '');
    const last = segs[segs.length - 1];
    if ((op.op === 'add' || op.op === 'remove') && segs.length > 1 && (last === '-' || /^\d+$/.test(last))) {
        const parent = '/' + segs.slice(0, -1).join('/');
        if (Array.isArray(getAtPointer(before, parent))) return parent;
    }
    return op.path;
}

// Adds each op's undo path to `undo` with the value it holds in `before` — the floor state this write
// starts from. A path already in the record keeps its value from before PRE's FIRST write on the slot.
// Returns `undo` (the same array, grown).
export function recordSimUndo(undo, before, ops) {
    for (const op of (Array.isArray(ops) ? ops : [])) {
        if (!op || typeof op.path !== 'string') continue;
        const path = simUndoPath(op, before);
        if (undo.some((u) => u.path === path)) continue;
        const value = getAtPointer(before, path);
        undo.push({ path, had: value !== undefined, value: value === undefined ? undefined : structuredClone(value) });
    }
    return undo;
}

// Puts every recorded path back onto `stat` (mutated). A path that did not exist is removed again.
// NEWEST record first, so when records nest the older one — taken before any PRE write reached it —
// is applied last and wins, whichever of parent and child was recorded first. Returns the paths reset.
export function restoreSimUndo(stat, undo) {
    const reset = [];
    for (let i = undo.length - 1; i >= 0; i--) {
        const u = undo[i];
        if (u.had) setAtPointer(stat, u.path, structuredClone(u.value));
        else removeAtPointer(stat, u.path);
        reset.push(u.path);
    }
    return reset;
}

// Pointer writers for the undo record, pointer-ISH exactly as getAtPointer reads (no ~0/~1 decoding).
// A segment that names an object's prototype plumbing (isPrototypeKey) is refused: these paths come from
// model output.
function pointerSegments(pointer) {
    const segs = String(pointer == null ? '' : pointer).split('/').filter((x) => x !== '');
    return segs.some(isPrototypeKey) ? [] : segs;
}
function setAtPointer(obj, pointer, value) {
    const segs = pointerSegments(pointer);
    if (!segs.length || obj == null || typeof obj !== 'object') return;
    let cur = obj;
    for (const seg of segs.slice(0, -1)) {
        if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {};
        cur = cur[seg];
    }
    cur[segs[segs.length - 1]] = value;
}
function removeAtPointer(obj, pointer) {
    const segs = pointerSegments(pointer);
    let cur = obj;
    for (const seg of segs.slice(0, -1)) {
        if (cur == null || typeof cur !== 'object') return;
        cur = cur[seg];
    }
    if (!segs.length || cur == null || typeof cur !== 'object') return;
    const key = segs[segs.length - 1];
    if (Array.isArray(cur) && /^\d+$/.test(key)) cur.splice(Number(key), 1);
    else delete cur[key];
}

// THE POST TARGET DISPOSITION — which message a POST pass records, or that it must not run at all.
//
// MESSAGE_RECEIVED hands POST a message id. Two different things can be wrong with it, and the
// difference decides the whole pass:
//
//   'last'    — no id was named, so POST records the last AI message.
//   'target'  — the named id is a real message. The normal path.
//   'refuse-vanished' — an id WAS named and that message is NOT in the chat. The world changed
//               between the emit and this read, so POST has nothing to record and must stop.
//   'refuse-no-chat'  — no chat to read at all.
//   'refuse-user-message' — the named floor is the user's; POST only reacts to AI replies.
//
// HARD CUTOFF ON 'refuse-vanished', NOT a fallback to the last message. A fallback treats "the message
// you named is gone" as "you named no message" and silently RETARGETS the pass onto a different, older
// reply. A chat reload mid-stream truncates the streaming placeholder away, and ST's onErrorStreaming
// (script.js) emits MESSAGE_RECEIVED for the dead stream anyway — with no GENERATION_STOPPED, so the
// stopped-gate does not catch it either. A retargeted POST would spend a real LLM call on the previous
// reply, and RES2 would write its record ops a SECOND time. That message has already had its turn; a
// pass that re-records it is not recovery.
//
// Any path that removes the named message between the emit and this read reaches the same branch (a
// reload mid-stream, a fast delete, a chat switch mid-stream, a dropped relay + reload).
//
// @param {number|null} messageId  the id MESSAGE_RECEIVED named, or null/undefined for none
// @param {Array} chat             the REAL chat (SillyTavern.getContext().chat), read NOW
// @returns {{ verdict: string, mesId: number }} — mesId is -1 on every refusal
export function postTargetDisposition(messageId, chat) {
    if (!Array.isArray(chat) || chat.length === 0) return { verdict: 'refuse-no-chat', mesId: -1 };
    const named = messageId != null;
    if (named && !chat[messageId]) return { verdict: 'refuse-vanished', mesId: -1 };
    const mesId = named ? Number(messageId) : chat.length - 1;
    const msg = chat[mesId];
    if (!msg) return { verdict: 'refuse-vanished', mesId: -1 };
    if (msg.is_user) return { verdict: 'refuse-user-message', mesId: -1 };
    return { verdict: named ? 'target' : 'last', mesId };
}

// Compile a per-call input-filter pattern. THE single parse, shared by applyInputFilter
// and the I/O layer, so the two never disagree about what "valid" means. Accepts a bare
// pattern or `/pattern/flags`; default flag `s` so `.` spans newlines. Returns:
//   { re: RegExp }             — usable filter
//   { re: null }               — empty pattern (no filtering requested)
//   { re: null, invalid:true } — a BAD regex the user should fix (caller warns/toasts)
export function parseInputFilterRegex(regexStr) {
    const pat = String(regexStr == null ? '' : regexStr).trim();
    if (!pat) return { re: null };
    let body = pat, flags = 's';
    const m = /^\/([\s\S]*)\/([a-z]*)$/i.exec(pat);
    if (m) { body = m[1]; flags = m[2] || 's'; }
    try { return { re: new RegExp(body, flags) }; }
    // EXPECTED: the pattern is user text and may not compile. `invalid: true` IS the surfacing —
    // the caller reports the bad regex to the user, which a message about this throw could not.
    catch { return { re: null, invalid: true }; }
}

// Optional per-call input filter: a card-supplied regex that narrows what a call actually
// sees (e.g. POST reading only `<gametxt>…</gametxt>`). Returns capture group 1 if present,
// else the whole match. No regex / no match / bad regex → the text is returned unchanged
// (never send an empty input). A BAD regex is a user error — it degrades to "no filter"
// here, and the runtime surfaces it via parseInputFilterRegex().invalid (toast). Genre
// lives in the card's pattern; the code stays generic.
export function applyInputFilter(text, regexStr) {
    const s = String(text == null ? '' : text);
    const { re } = parseInputFilterRegex(regexStr);
    if (!re) return s;                                          // empty OR invalid → unchanged
    const hit = re.exec(s);
    if (!hit) return s;                                          // no match → unfiltered
    return String(hit[1] != null ? hit[1] : hit[0]).trim();
}

// ── EJS render for extra-LLM (PRE/POST) system blocks ────────────────────────
// mvu-helper's PRE/POST calls run through ConnectionManagerRequestService → ChatCompletionService, a path that
// fires NONE of the events ST-Prompt-Template hooks (CHAT_COMPLETION_SETTINGS_READY et al. come only from the
// main Generate flow — verified in ST core + ST-Prompt-Template/src). So the card's [PRE]/[POST] lorebook
// entries would otherwise reach the small model as RAW EJS. This renders them with ST-Prompt-Template's OWN
// public engine, INJECTED as `ejsApi` (globalThis.EjsTemplate at runtime; a fake in tests). Pure: no globals,
// side-effects deferred to the onMissing/onError hooks. Rules:
//   - no `<%` in the block             → returned unchanged (never touches the engine; a card with no EJS in
//                                         its blocks works even without ST-Prompt-Template, and stays silent).
//   - `<%` present but ejsApi missing  → onMissing() then RAW (graceful degrade; ST-Prompt-Template is a prereq).
//   - snapshotMsgId != null            → the pin (see below); null → engine builds its own context
//                                         (latest floor — only right for a caller that WANTS latest).
//   - render throws                    → onError(e) then RAW.
//
// A BARE PIN DOES NOT PIN: prepareContext(env, id)'s id only builds the cache
// ONCE. Inside the template EVERY getvar re-caches — variables.ts re-runs precacheVariables(
// this?.message_id) whenever runID is undefined, and runID is set only by ST-Prompt-Template's own
// render hooks, never by prepareContext. So a bare `prepareContext({}, id)` is discarded by the
// first getvar, which re-reads the LATEST floor. The pin has two parts, and BOTH are needed:
//   - `message_id` in the env: env is spread LAST into the context, and EJS compiles `_with: true`,
//     so a `with(locals)` lookup calls the resolved getvar as a METHOD — `this === context` — and
//     precacheVariables(this.message_id) re-caches to the PINNED floor on every call. Covers every
//     variables helper at once.
//   - the getvar override: with_context_disabled (a user-toggleable ST-Prompt-Template setting)
//     switches evalTemplate to destructured locals — getvar is then called BARE, `this` is
//     undefined, and the env pin silently reverts to latest. Rebinding `this` survives both modes.
// runID is deliberately left undefined: re-caching per call from a stable message_id is MORE robust
// under parallel PRE renders than a one-shot pin (the vars cache is a module singleton — two
// concurrent renders re-deriving the same floor agree; a one-shot pin can be clobbered).
export async function renderEjsBlock(ejsApi, text, opts = {}) {
    const src = String(text == null ? '' : text);
    const { snapshotMsgId = null, onMissing = null, onError = null } = opts || {};
    if (!src.includes('<%')) return src;                        // no EJS delimiter → nothing to render
    if (!ejsApi || typeof ejsApi.evalTemplate !== 'function') {
        if (typeof onMissing === 'function') onMissing(src);
        return src;
    }
    try {
        let ctx = null;
        if (snapshotMsgId != null && typeof ejsApi.prepareContext === 'function') {
            const id = Number(snapshotMsgId);
            ctx = await ejsApi.prepareContext({ message_id: id }, id);
            const origGetvar = ctx && ctx.getvar;
            if (typeof origGetvar === 'function') {
                ctx.getvar = (key, options) => origGetvar.call({ message_id: id }, key, options);
            }
        }
        const out = await ejsApi.evalTemplate(src, ctx);
        return out == null ? src : String(out);
    } catch (e) {
        if (typeof onError === 'function') onError(e, src);
        return src;                                             // degrade to the raw block on render error
    }
}

// ── Card-carried mvu-helper config — the [Initmvuhelper] import (mirrors MVU's [InitVar]) ────
// A card can ship its whole PRE/POST setup (call names, phases, input-filter regexes, groups,
// timeout) in a lorebook entry whose COMMENT contains `[initmvuhelper]` (case-insensitive), so the
// user does not hand-build every call. Parsing mirrors MVU's [InitVar] unwrap: strip an optional
// <initmvuhelper>…</initmvuhelper> wrapper, then an optional ``` fence, then JSON.parse. The result
// is NORMALIZED into the per-card profile shape, with every `profileId` forced EMPTY — a connection
// profile is a local UUID the card can't know, so the user assigns the small-LLM connection once.
const CFG_SLUG = (s, fallback) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || fallback;

// Per-call fields this extension does not honour, though a card written for an earlier mvu-helper
// may still carry them. Dropping one silently means the author sets it, sees no effect, and has
// nothing to search for. Listed here so the importer can NAME what it ignored (card-config.js
// logs it) — the same reasoning as the schema-version gate, at field granularity.
//   preset — ST bundles a preset INTO a connection profile, so "another preset" is "another
//            profile"; honouring one would mean mutating ST's shared profile object.
//   ownedRoot — fed one stat_data subtree into a PRE call's input, and shortened the narrator's lines
//            for ops under it. EJS in the call's own entries reads any number of paths, from the same
//            floor, and the shortened line ("0 > …") dropped the only label the narrator had. It never
//            limited where a patch may write (user 2026-10-17).
export const RETIRED_CALL_FIELDS = [
    { field: 'preset', why: 'the preset comes from the connection profile — pick or make another profile in ST\'s Connection Manager' },
    { field: 'ownedRoot', why: 'a call reads state with EJS in its own lorebook entries (<%- getvar(\'stat_data.<path>\') %>), and the field never limited where a patch may write — remove it from the card' },
];

// Everything the importer UNDERSTANDS about THIS section, listed so it can name what it does NOT.
// These lists live beside the feature whose shape they describe: whoever adds a per-call field is
// editing this file already, so the list cannot silently fall behind. (The list of card-carryable
// SECTIONS is the registry's — features/card-config/card-config-sections.js.)
const KNOWN_ELC_FIELDS = ['enabled', 'parallel', 'timeoutSec', 'groups', 'calls'];
const KNOWN_CALL_FIELDS = ['id', 'name', 'profileId', 'phase', 'maxTokens', 'temperature', 'inputRegex', 'outputRegex', 'enabled'];
const KNOWN_GROUP_FIELDS = ['id', 'tag', 'members'];

// ── the extraLlmCalls SECTION handler (a CUSTOM one — see the registry) ──────────────────────
// Flat sections are declared as field lists and get a generic handler; this section cannot be, because
// its payload is ARRAYS MERGED BY IDENTITY (calls by name, groups by tag) and a flat field list has no
// notion of "which row is the same row". So the four operations are written out here.
//
// Pure + deterministic (ids derived from name/index, no Math.random) so it's unit-testable.
// profileId is always '' (the card can't carry the user's local connection).
//
// `report` is the shared collector the whole import fills in — { retired, unknown, blocked } — and it
// exists because a setting dropped in SILENCE is the worst outcome for the person who set it. The card
// AUTHOR is the only one who can fix what the card carries, and they need something to search for.
export function normalizeExtraLlmCallsSection(raw, report) {
    const elc = (raw && typeof raw === 'object') ? raw : {};
    report.unknown.push(...unknownKeysOf(elc, KNOWN_ELC_FIELDS, 'extraLlmCalls'));
    const retiredFieldNames = RETIRED_CALL_FIELDS.map((r) => r.field);
    const calls = (Array.isArray(elc.calls) ? elc.calls : []).map((c, i) => {
        const o = (c && typeof c === 'object') ? c : {};
        const name = String(o.name || '').trim();
        const label = `call "${name || `#${i}`}"`;
        for (const r of RETIRED_CALL_FIELDS) {
            if (o[r.field] !== undefined && o[r.field] !== '') report.retired.push({ call: name || `#${i}`, ...r });
        }
        // A connection UUID is the textbook never-travels field, and a hand-written card CAN carry one
        // (export always drops it). Forcing it to '' is right; doing so in silence is not.
        if (o.profileId) {
            report.blocked.push({ path: `${label}.profileId`, why: 'a connection is a local profile UUID that means nothing on another machine — assign it per call in Extra LLM Calls' });
        }
        // A RETIRED field is skipped here — it already gets its own, more useful message, and being
        // told the same field is both "no longer honoured" and "unrecognised" reads as two problems.
        report.unknown.push(...unknownKeysOf(o, KNOWN_CALL_FIELDS, label, retiredFieldNames));
        return {
            id: 'call_' + CFG_SLUG(name, 'c' + i),
            name,
            profileId: '',                                      // card CANNOT carry the local connection UUID — user assigns
            phase: o.phase === 'post' ? 'post' : 'pre',
            // NOTE: no `preset`. ST bundles a preset INTO a connection profile, so "another preset"
            // is "another profile" — and honouring one here would mean mutating ST's shared profile
            // object at request time. mvu-helper is READ-ONLY on ST state (see runLlmCall). A card
            // carrying the field has it dropped and named as retired (RETIRED_CALL_FIELDS above).
            maxTokens: (o.maxTokens == null || o.maxTokens === '') ? '' : Number(o.maxTokens),
            temperature: (o.temperature == null || o.temperature === '') ? '' : Number(o.temperature),
            inputRegex: String(o.inputRegex || ''),
            outputRegex: String(o.outputRegex || ''),
            enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
        };
    });
    return {
        enabled: typeof elc.enabled === 'boolean' ? elc.enabled : true,
        parallel: typeof elc.parallel === 'boolean' ? elc.parallel : true,
        timeoutSec: Number.isFinite(Number(elc.timeoutSec)) && Number(elc.timeoutSec) >= 5
            ? Number(elc.timeoutSec) : 60,
        groups: (Array.isArray(elc.groups) ? elc.groups : []).map((g, i) => {
            const tag = String((g && g.tag) || '').trim();
            report.unknown.push(...unknownKeysOf(g, KNOWN_GROUP_FIELDS, `group "${tag || `#${i}`}"`));
            return {
                id: 'grp_' + CFG_SLUG(g && g.tag, 'g' + i),
                tag,
                members: Array.isArray(g && g.members) ? g.members.map((m) => String(m)) : [],
            };
        }),
        calls,
    };
}

// ── MERGE this section into an existing profile (a re-import: the "Re-import from card" button, or a
// chat load that finds the card's [Initmvuhelper] changed — card-config's decideCardImport) ──────────
// WHY A MERGE, not a replace: `calls` is ONE array inside ONE per-card settings object, so swapping
// the container to get a deleted call back would also destroy every OTHER call's connection
// assignment and any hand-added call. The user deleting PRE wants PRE back — not a factory reset.
//
// WHAT EACH SIDE OWNS — the whole decision, in one place:
//   CARD-OWNED (refreshed from the card, so an author can ship a corrected regex):
//     phase · maxTokens · temperature · inputRegex · outputRegex · a group's members
//   USER-OWNED (NEVER touched — these are not in the card and cannot be):
//     profileId — the card literally cannot carry a local connection UUID (normalizeCardConfig
//                 always writes ''), so refreshing it would mean CLEARING it. That is the exact
//                 damage this function exists to prevent.
//     enabled   — a runtime switch, not shape. Re-enabling a call the user deliberately turned off
//                 would change BEHAVIOUR, not just configuration.
//     id        — kept so open DOM rows keep their identity across a re-import.
//   HAND-ADDED calls/groups (absent from the card) are KEPT, never pruned. The card is not the
//   authority on what else the user runs.
//   RETIRED fields (RETIRED_CALL_FIELDS) a profile saved before mvu-helper stopped reading them are
//   DELETED from every call, card's or hand-added — the flat sections delete theirs on a re-import too.
//
// TOP-LEVEL flags (enabled/parallel/timeoutSec) are preserved too — runtime preferences the user tunes,
// not per-call shape. A profile with no calls at all keeps them as well: the card seeds them only on an
// install (a fresh profile), never on a merge.
//
// A call the user DELETED comes back on a merge, since the card still declares it. A chat load merges
// only when the card's config changed, so the user's deletion stands until the next card upgrade —
// never on an ordinary chat switch.
//
// Pure: takes the current profile's extraLlmCalls + a normalized card config, returns the merged
// object and a SUMMARY of what happened. The summary is not decoration — a merge that silently did
// nothing and a merge that restored three calls must not look the same (log-sanity).
const MERGE_CARD_OWNED_CALL_FIELDS = ['phase', 'maxTokens', 'temperature', 'inputRegex', 'outputRegex'];

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// The call with every retired field removed. Returns the SAME object when there is nothing to remove,
// so an untouched call stays untouched. Only a field that HELD a value is named in `deleted`: the old
// importer wrote `ownedRoot: ''` onto every call, and naming those would report work on calls whose
// setting never existed (log-sanity — the same rule the import's retired report follows).
const RETIRED_CALL_FIELD_NAMES = RETIRED_CALL_FIELDS.map((r) => r.field);
function withoutRetiredFields(call, deleted) {
    const dead = RETIRED_CALL_FIELD_NAMES.filter((f) => f in call);
    if (!dead.length) return call;
    const next = { ...call };
    for (const f of dead) delete next[f];
    const held = dead.filter((f) => call[f] !== '' && call[f] != null);
    if (held.length) deleted.push(`${call.name} (${held.join(', ')})`);
    return next;
}

export function mergeExtraLlmCallsSection(current, incoming) {
    const cur = (current && typeof current === 'object') ? current : {};
    const inc = (incoming && typeof incoming === 'object') ? incoming : {};
    const curCalls = Array.isArray(cur.calls) ? cur.calls : [];
    const incCalls = Array.isArray(inc.calls) ? inc.calls : [];
    const curGroups = Array.isArray(cur.groups) ? cur.groups : [];
    const incGroups = Array.isArray(inc.groups) ? inc.groups : [];

    const added = [], updated = [], kept = [], deleted = [], groupsAdded = [], groupsUpdated = [];

    // Existing calls keep their POSITION (a re-import must not reshuffle the user's list); restored
    // ones are appended.
    const calls = curCalls.map((saved) => {
        const c = withoutRetiredFields(saved, deleted);
        const fromCard = incCalls.find((x) => sameName(x.name, c.name));
        if (!fromCard) { kept.push(c.name); return c; }
        const next = { ...c };
        const changed = [];
        for (const f of MERGE_CARD_OWNED_CALL_FIELDS) {
            if (fromCard[f] === undefined || fromCard[f] === next[f]) continue;
            // A field the profile NEVER HAD, filled with the card's own empty default, is not a
            // refresh — nothing about the call changes. Reporting it would make a re-import claim it
            // touched a call it did not (log-sanity: a no-op must not look like work): a stored call
            // with no `inputRegex` key would announce "refreshed POST (inputRegex)" on every merge, for
            // undefined → ''. The key is still WRITTEN, so the shape converges; only the report stays honest.
            const isFillingAnAbsentFieldWithEmpty = !(f in next) && fromCard[f] === '';
            next[f] = fromCard[f];
            if (!isFillingAnAbsentFieldWithEmpty) changed.push(f);
        }
        if (changed.length) updated.push(`${c.name} (${changed.join(', ')})`);
        return next;                                   // profileId / enabled / id deliberately untouched
    });
    for (const c of incCalls) {
        if (curCalls.some((x) => sameName(x.name, c.name))) continue;
        calls.push(c);
        added.push(c.name);
    }

    const groups = curGroups.map((g) => {
        const fromCard = incGroups.find((x) => sameName(x.tag, g.tag));
        if (!fromCard) return g;
        const a = JSON.stringify(g.members || []), b = JSON.stringify(fromCard.members || []);
        if (a === b) return g;
        groupsUpdated.push(g.tag);
        return { ...g, members: fromCard.members };
    });
    for (const g of incGroups) {
        if (curGroups.some((x) => sameName(x.tag, g.tag))) continue;
        groups.push(g);
        groupsAdded.push(g.tag);
    }

    return {
        merged: {
            enabled: cur.enabled,                      // top-level flags are the user's tuning
            parallel: cur.parallel,
            timeoutSec: cur.timeoutSec,
            groups,
            calls,
        },
        summary: { added, updated, kept, deleted, groupsAdded, groupsUpdated },
    };
}

// EXPORT half of the section handler — the round-trip of normalizeExtraLlmCallsSection: turn the
// per-card profile's extraLlmCalls into the JSON the card carries, so an author configures in the GUI
// then ships the card. Drops each call's local `id` (regenerated on import) and `profileId` (a
// connection UUID meaningless to another user — the never-travels rule, and export is the half that
// matters most: a card that leaks the author's ids cannot be recalled). Omits unset optional fields to
// keep the JSON lean. Pure + deterministic.
export function serializeExtraLlmCallsSection(current) {
    const elc = (current && typeof current === 'object') ? current : {};
    return {
        enabled: !!elc.enabled,
        parallel: elc.parallel !== false,
        timeoutSec: Number.isFinite(Number(elc.timeoutSec)) ? Number(elc.timeoutSec) : 60,
        groups: (Array.isArray(elc.groups) ? elc.groups : []).map((g) => ({
            tag: String((g && g.tag) || '').trim(),
            members: Array.isArray(g && g.members) ? g.members.map((m) => String(m)) : [],
        })),
        calls: (Array.isArray(elc.calls) ? elc.calls : []).map((c) => {
            const o = (c && typeof c === 'object') ? c : {};
            const call = { name: String(o.name || '').trim(), phase: o.phase === 'post' ? 'post' : 'pre', enabled: o.enabled !== false };
            if (o.maxTokens != null && o.maxTokens !== '') call.maxTokens = Number(o.maxTokens);   // omit unset optional fields
            if (o.temperature != null && o.temperature !== '') call.temperature = Number(o.temperature);
            if (o.inputRegex) call.inputRegex = String(o.inputRegex);
            if (o.outputRegex) call.outputRegex = String(o.outputRegex);
            return call;                                        // id + profileId deliberately dropped (local/non-portable)
        }),
    };
}

// ── SAME-ROUND EVENT firing (PRE→narrate seam) ────────────────────────────────
// The ENGINE picks the event; mvu-helper only plays it. What the PRE calls said, in which field, and
// whether the key is one of the events the card offered them are the engine's to judge — see
// buildSameRoundEventBlock in extra-llm-calls.js and devdoc/event-pack-engine.md.

// What the engine's pickSameRoundEvent returned, read strictly: a string is the key ('' = play nothing),
// null/undefined = nothing. Anything else is a broken hook. It plays nothing, and `problem` says what came
// back, because guessing a key out of an object would play a beat nobody picked.
export function readSameRoundPick(value) {
    if (value === undefined || value === null) return { key: '', problem: '' };
    if (typeof value !== 'string') {
        const what = Array.isArray(value) ? 'an array' : (typeof value === 'object' ? 'an object' : `a ${typeof value}`);
        return { key: '', problem: `the engine's pickSameRoundEvent returned ${what}, not an event key string — nothing plays same-round this reply` };
    }
    return { key: value.trim(), problem: '' };
}

// WHERE RES2's audit block goes in the finished message. Pure, because the naive placement is
// wrong in a way only a human eye catches: appending puts it AFTER
// <StatusPlaceHolderImpl/>, i.e. below the stat menu, which both strands the receipt away from its
// sibling and re-flows every block above it (the placeholder stops being the message's last element,
// so the markdown pass starts wrapping the preceding blocks in paragraphs and the spacing blows out).
// The same trap the POST-block placement in applyPostBlocks documents — "not stranded below it".
//
// Anchors, in order of preference:
//   1. straight after the RES1 receipt — the two audit blocks are one story, read in pipeline order;
//   2. else above the reply's tail — the engine's end text, else the stat-menu placeholder — the rule every
//      other block here follows (shared/reply-block-placement placeAboveFirstAnchor);
//   3. else append, which is correct precisely when no anchor exists (no menu, no RES1 block).
// `resTagClose` is the turn audit block's closing tag — mvu-helper's own (TURN_AUDIT_TAG) — and `tailAnchors`
// the reply's tail (logic-engine's REPLY_TAIL_ANCHORS). Both are passed in by the caller, so neither is spelled
// here a second time.
export function placePostRelayBlock(messageText, block, resTagClose, tailAnchors) {
    const base = String(messageText == null ? '' : messageText);
    const blk = String(block == null ? '' : block);
    if (!blk) return base;
    if (base.includes(blk)) return base;                    // idempotent: never append the same receipt twice
    const close = String(resTagClose || '');
// ⚠ FUNCTION replacement, never a string one. `String.replace` expands `$&`, `$\u0060`, `$'` and `$1` in the
// REPLACEMENT even when the search is a plain string, and `blk` is model- or engine-authored text this
// module never inspects: a block containing `$&` would splice a copy of the anchor tag into the message.
// A function's return value is used literally, which is the only form safe for untrusted content.
    if (close && base.includes(close)) {
        return base.replace(close, () => close + '\n\n' + blk);   // first occurrence — RES1's block
    }
    return placeAboveFirstAnchor(base, blk, tailAnchors);
}

// A CALL WITH NOTHING TO ASK IS NOT A DEGRADED CALL.
//
// A call's SYSTEM BLOCK is its contract: it is assembled from the lorebook entries routed to that
// call's name, and it holds every instruction the small model gets. With zero entries routed the
// block is empty, so the request would carry the user's text and no task at all — the model answers
// with prose, the phase drops it as unusable, and the turn ends on a "PRE degraded / POST degraded"
// toast naming a model that was never asked anything. A pack uninstalled with the profile's PRE call
// still enabled takes its [PRE] entries with it, and would spend a real LLM call EVERY turn to
// produce a warn and a toast.
//
// GATED ON THE ENTRY COUNT, NOT ON A PACK. "No GameLogic Pack installed" is the wrong test twice
// over: a card WITH a pack whose pack ships no [PRE] entry burns the same call, and a plugin on a
// pack-less card that DOES route a [PRE] entry must still run
// (L5 — never gate genre-neutral behaviour on a consumer-specific condition).
//
// @param {{systemBlock?: string}} args  the RAW routed block, before EJS/macro rendering
// @returns {'run'|'no-contract'}
export function callDispatchDisposition({ systemBlock } = {}) {
    return String(systemBlock == null ? '' : systemBlock).trim() ? 'run' : 'no-contract';
}
