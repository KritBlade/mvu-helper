// Extra LLM Calls — extra LLM calls ("tracker" pre-pass).
//
// Generic & genre-agnostic: a user-defined LIST of calls, each bound to an ST
// connection-manager profile and a `[name]`-prefixed slice of the card's lorebook.
// Calls run inside the `generate_interceptor` (a PRE-pass), so the MAIN generation
// blocks until they finish — verified in ST core:
//   script.js:4505  `await runGenerationInterceptors(...)`  (before prompt is sent)
//   extensions.js:2028  `await globalThis[interceptorKey](...)`  (sequential loop)
//   → this interceptor; any awaited work here gates the main call.
// Recursion-safe: ConnectionManagerRequestService.sendRequest calls the completion
// service directly (shared.js:440-478), never re-entering Generate()/the interceptor.
//
// This file is the I/O glue only. All pure logic lives in extra-llm-calls-core.js (unit-tested).

import { eventSource, event_types } from '../../../../../../../script.js';
import {
    selectCallSystemBlock,
    selectCallSystemManifest,
    extractTextContent,
    findLastUserIndex,
    findBaseFloorIndex,
    prependToMessage,
    buildMessages,
    oocCommandBlockFor,
    normalizeMaxTokens,
    buildOverridePayload,
    extractCompletionText, completionCutReason, describeNoTextAnswer,
    emptyResultCause, carriesOnlyTasks, sortEmptyResults, describeEmptyResult,
    enabledCallsForPhase,
    unrunnableRoutedCalls,
    callPhase,
    runCalls,
    callScheduleKey,
    postPhaseTimings,
    buildInjectionBlock,
    postBlocksForReply,
    classifyPostOutput,
    decideResCarry,
    isTurnSettledAtPostEnd,
    stripPatchBlocks,
    toPostWrapper,
    renderEjsBlock,
    applyInputFilter,
    parseInputFilterRegex,
    readSameRoundPick,
    validateSimPatchOutput,
    preHookOutputs,
    renderSimInjectLines,
    splitAndCheckSimOutput,
    splitAndCheckPostOutput,
    simPreApplyDisposition,
    postTargetDisposition,
    callDispatchDisposition,
    SIM_UNDO_EXTRA_KEY,
    stepSimUndo,
    readSimUndoRecord,
    writeSimUndoRecord,
    postOpsRefused,
    placePostRelayBlock,
    extraLlmCallsOf,
} from './extra-llm-calls-core.js';
import { opsOutcomeAfterApply, renderOpOutcome } from '../../shared/json-patch-ops.js';
import {
    blockUsesInputMacros,
    substituteInputMacros,
    formatMacroTrace,
    findSwipeUnsafeMacros,
} from './call-input-macros-core.js';
import { substituteMacrosBlock } from '../../sillytavern/prompt-macros-core.js';
import { getMvu, parseMvuBlock, saveMessageMvuData, toast } from '../../sillytavern/mvu-bridge.js';
import { refusedByPhrase, WRITER_POST } from '../../sillytavern/mvu-bridge-core.js';
import { getProfile, profileKey } from '../../sillytavern/settings-store.js';
import { POST_DONE_EVENT, PRE_DONE_EVENT, taskTargetOf, resolveRoutedTaskInstructions, shapeRoutedCallInput, isTaskRoutingEntryName } from '../llm-task-router/index.js';
import { getPrimaryLorebookEntries } from '../../sillytavern/lorebook.js';
import { findArmedBody, FIRE_INTENT } from '../event-pack/index.js';
import { getLogicEngineApi, getLogicEngineStatus, loadLogicEngine, noteSameRoundEventInjected, awaitTurnWork, withLiveResolveSuppressed, isStoryTurnGenerationType, isTurnResolverActiveNow, TURN_AUDIT_TAG, REPLY_TAIL_ANCHORS, stripLeadAndEndText, readResStaged, readResMarkerDone, awaitResStaged } from '../logic-engine/index.js';
import { beginTurnPhase, endTurnPhase } from './turn-phase-signal.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { composeStatBox, isStatBoxDeclared, stripStatBoxFromText } from '../statbox/index.js';
import { openReplyRedraw, redrawReply, isReplyRedrawLive, noteReplyRedrawEnding, closeReplyRedraw } from '../reply-redraw/index.js';
import { placeAboveFirstAnchor } from '../../shared/reply-block-placement.js';

const log = createModuleLog('small-llm');

// A pipeline STAGE line — PRE · SIM · POST, or one call by its label — on the `pipeline` debug domain:
// `[mvu-helper] [small-llm] [PRE] …`. The stage is a sub-tag, so `[PRE]` / `[POST]` find one stage of
// the turn and `[mvu-helper]` finds all of it. Raw LLM I/O stays on log.domain('smallllm', …).
function logStage(stage, ...args) {
    log.child(stage).domain('pipeline', 'lifecycle', ...args);
}
// Per-call log label: the user's call name, or a stable PHASE#index fallback so MULTIPLE unnamed calls of
// the same phase stay distinguishable (→ [PRE#1] / [PRE#2], [POST#1] / [POST#2]). Used only for the log tag;
// lorebook routing still keys on the real call.name.
export function callLogLabel(call, calls) {
    const n = call && call.name && String(call.name).trim();
    if (n) return n;
    const phase = (call && call.phase === 'post') ? 'POST' : 'PRE';
    const i = Array.isArray(calls) ? calls.indexOf(call) : -1;
    return `${phase}#${i >= 0 ? i + 1 : '?'}`;
}

// This card's Extra LLM Calls settings (the profile's extraLlmCalls block; the template is extra-llm-calls-core.js).
// PER CARD: they live in the active profile, not at the root.
export function getExtraLlmCallsProfile() {
    return extraLlmCallsOf(getProfile());
}

// A call's routing, from the primary lorebook's entries: its system block — each GROUP block it belongs to (a group's
// `[tag]` entries) + the call's own `[name]` block — and the names of the entries in it.
async function collectCallRouting(callName, label = callName) {
    const none = { block: '', entryNames: [] };
    if (!String(callName || '').trim()) return none;
    try {
        const entries = await getPrimaryLorebookEntries();
        if (!entries.length) return none;
        const elc = getExtraLlmCallsProfile();
        const manifest = selectCallSystemManifest(entries, callName, elc.groups);
        // Routing manifest: one line per routed entry NAME (gated on the `pipeline` domain — the per-stage
        // flow toggle). A short list never hits the console's single-string truncation that cuts off the
        // full `system block:` dump (the `smallllm` domain log below).
        if (log.domainEnabled('pipeline')) {
            logStage(label, `routed lorebook entries (${manifest.length}):`);
            for (const m of manifest) logStage(label, `  • ${m.name}${m.via === 'self' ? '' : `  [group ${m.via}]`}`);
        }
        return { block: selectCallSystemBlock(entries, callName, elc.groups), entryNames: manifest.map((m) => m.name) };
    } catch (e) {
        log.error(`collecting the lorebook entries routed to "${callName}" failed:`, e);
        return none;
    }
}

// The call's system block (collectCallRouting).
export async function collectLorebookBlock(callName, label = callName) {
    return (await collectCallRouting(callName, label)).block;
}

// THE ROUTING CHECK: lorebook entries routed to a call that will not run (unrunnableRoutedCalls). Run on chat
// load and after every change to the calls, the groups or the Extra LLM Calls switch. A finding is reported
// once while it lasts: one that clears and comes back is reported again, and a chat load reports afresh.
// Switching calls off is how a narrate-only debugging session runs, so that is a console warning only; a call
// that is ON without a connection profile was meant to run, so it also raises a toast.
const reportedRoutingFindings = new Set();
// Each finding's cause, worded for a call or for a group (whose entries reach whichever of its calls runs).
const ROUTING_FINDING_WORDS = {
    'extra-calls-off': (what, isGroup) => (isGroup ? `Extra LLM Calls is off, so no call reads ${what}` : `Extra LLM Calls is off, so ${what} does not run`),
    'disabled': (what) => `${what} is turned off in Extra LLM Calls`,
    'no-connection': (what) => `${what} is on but has no connection profile, so it cannot run`,
    'no-member-runs': (what) => `no call in ${what} runs`,
};
export async function reportUnrunnableRoutedCalls({ isChatLoad = false } = {}) {
    if (isChatLoad) reportedRoutingFindings.clear();
    const elc = getExtraLlmCallsProfile();
    let entries;
    try { entries = await getPrimaryLorebookEntries(); }
    catch (e) { log.warn('routing check: the lorebook could not be read, so routed entries were not checked against the call list:', e); return; }
    const findings = unrunnableRoutedCalls({ isExtraCallsOn: elc.enabled === true, calls: elc.calls, groups: elc.groups, entries });
    const current = new Set(findings.map((f) => f.reason + ':' + f.name));
    for (const id of [...reportedRoutingFindings]) if (!current.has(id)) reportedRoutingFindings.delete(id);
    for (const f of findings) {
        const id = f.reason + ':' + f.name;
        if (reportedRoutingFindings.has(id)) continue;
        reportedRoutingFindings.add(id);
        const what = (f.isGroup ? 'group "' : 'call "') + f.name + '"';
        const isOne = f.entryNames.length === 1;
        const count = f.entryNames.length + ' lorebook ' + (isOne ? 'entry' : 'entries');
        log.warn(`${ROUTING_FINDING_WORDS[f.reason](what, f.isGroup)} — ${count} routed to it ${isOne ? 'reaches' : 'reach'} no model: ${f.entryNames.join(' · ')}`);
        if (f.reason === 'no-connection') {
            toastDegraded('MVU Helper — call has no connection', `"${f.name}" is on but has no connection profile, so ${count} routed to it never ${isOne ? 'reaches' : 'reach'} a model. Pick a profile in Extra LLM Calls.`);
        }
    }
}

// ASK WHAT EACH CALL HAS TO SAY BEFORE SPENDING IT (shared by both phases, so PRE and POST can never
// drift on this). Returns the calls worth dispatching, the ones with no contract at all, every
// call's block so the dispatch does not re-read the lorebook, and the dispatched calls that carry
// only tasks (carriesOnlyTasks: every entry routed to them is a task's routing entry), whose answer
// with no text their tasks judge (reportEmptyResults).
//
// A contract-less call is SKIPPED, not failed: it never reaches `results`, so it cannot land in the
// phase's empty-result summary and cannot raise a degraded toast. See callDispatchDisposition for why
// the test is the routed-entry count and not "is a GameLogic Pack installed".
async function partitionCallsByContract(calls, phase) {
    const withContract = [];
    const contractless = [];
    const blocks = new Map();
    const taskOnly = new Set();
    for (const call of calls) {
        const label = callLogLabel(call, calls);
        const { block, entryNames } = await collectCallRouting(call.name, label);
        blocks.set(call, block);
        if (callDispatchDisposition({ systemBlock: block }) !== 'run') {
            contractless.push(label);
            continue;
        }
        withContract.push(call);
        if (carriesOnlyTasks(entryNames, isTaskRoutingEntryName)) taskOnly.add(call);
    }
    if (contractless.length) {
        // Routing is by the CALL'S OWN NAME, so the fix names it: an entry reaches a call when its
        // comment carries that call's needle (a call named POST collects `[POST] ...` entries).
        log.child(phase).warn(`not called: ${contractless.join(', ')} — no lorebook entry is routed to `
            + `${contractless.length > 1 ? 'these calls' : 'this call'}, so there is no contract to send and `
            + `nothing the model could answer. Either give an entry the call's needle in its comment `
            + `(${contractless.map((n) => '[' + n + ']').join(' / ')}), or turn the call off in Extra LLM Calls.`);
    }
    return { withContract, contractless, blocks, taskOnly };
}

// ONE output-check decision for BOTH phases (shared helper so PRE/POST can never drift): drop text
// that fails its call's card-declared `outputRegex` (checkCallOutput — the write-side mirror of the
// input filter). A dropped output then flows into the phase's empty-result summary (reportEmptyResults),
// which owns the consequence warn + toast — so this logs only the CAUSE, exactly like a timeout logs in
// runCallBounded and lets the summary do the rest. An INVALID pattern degrades to "no check" (warn,
// mirroring warnIfBadInputFilter) — a config error must never silently discard good output.
//
// WHAT IS CHECKED IS THE PROSE HALF, in BOTH phases — the payload blocks are split out first and are
// never judged by the card's prose pattern. A mixed output has two halves validated by two different
// things, and checking the raw string would couple them: one stray preamble/code-fence/<think>/trailing
// note empties the whole result before the split, so a well-formed patch dies with the prose and the
// turn silently loses its state.
//   · PRE  — splitAndCheckSimOutput takes out the <JSONPatch> blocks.
//   · POST — splitAndCheckPostOutput takes out the <UpdateVariable> blocks.
// The LOGGING half of `decideOutputCheck` (the decision itself is pure, in -core). Both phases route
// their verdict through here so the console reads identically whichever half was checked. The lines
// are about ONE call, so they carry that call's tag.
function reportOutputCheck(call, calls, verdict, checkedText) {
    const callLog = log.child(callLogLabel(call, calls));
    if (verdict.invalid) {
        callLog.warn('the output-check regex is invalid — check skipped, output kept:', String((call && call.outputRegex) || ''));
    } else if (verdict.dropped) {
        callLog.warn('the output FAILED the card\'s output-check regex — dropped as garbage (raw output on the smallllm domain log)');
        callLog.domain('smallllm', 'io', 'dropped output:', checkedText);
    }
    return verdict.text;
}

// POST's enforcement: split the payload out, judge the PROSE, and keep the blocks either way.
//
// When the check PASSES (or no pattern is configured) the raw output is returned UNTOUCHED — not
// reassembled — so every card that works today is byte-identical through this path. Only a FAILED
// check rebuilds, and it rebuilds to the blocks alone: the garbage prose goes, the state write lives.
function enforcePostOutputChecks(calls, results) {
    return results.map((raw, i) => {
        const call = calls[i];
        const split = splitAndCheckPostOutput(raw, call && call.outputRegex);
        reportOutputCheck(call, calls, { text: split.prose, dropped: split.proseDropped, invalid: split.regexInvalid }, split.prose);
        if (!split.proseDropped) return raw;
        if (split.blocks.length) {
            log.child(callLogLabel(call, calls)).warn(`the prose failed the card's output-check regex and was dropped, but ${split.blocks.length} <UpdateVariable> block(s) SURVIVED and will still be applied.`);
            return split.blocks.join('\n');
        }
        return '';
    });
}

// Visible toast for a DEGRADED turn: console warns are easy to miss mid-play, so a PRE/POST pass with a
// degraded call ALSO raises a toastr warning. The message is the same consequence-level summary the
// warn carries (it lists every degraded call, so it's one toast per phase per turn, not one per call).
// `toast` never throws, a missing toastr included.
function toastDegraded(title, message) {
    toast('warning', message, title, { timeOut: 8000 });
}

// THE EMPTY-RESULT SUMMARY of one pass, shared by PRE and POST so the two can never drift. Each call that left
// the pass nothing usable is named with its cause (emptyResultCause): the request failed or timed out, the provider
// answered with no text (and what its answer held, describeNoTextAnswer), or the pass's checks left nothing. An
// answer with no text from a call that carries only tasks goes to those tasks, which judge it (sortEmptyResults);
// every other empty result degrades the pass — one warn and one toast naming each call and its cause.
// `outcome` holds, per call: rawResults (what each returned), keptResults (what the pass kept), taskOnly (the calls
// carrying only tasks), noTextDetails (call → describeNoTextAnswer's line) and quietPatches (PRE: calls whose answer
// was an empty patch alone). `withoutThem` ends the warn and `toastWithoutThem` the toast: what the turn goes without.
function reportEmptyResults(stage, calls, outcome, { withoutThem, toastWithoutThem }) {
    const { rawResults, keptResults, taskOnly, noTextDetails, quietPatches = new Set() } = outcome;
    const rows = calls.map((call, i) => ({
        label: callLogLabel(call, calls),
        cause: emptyResultCause({ raw: rawResults[i], kept: keptResults[i], isQuietPatch: quietPatches.has(call) }),
        isTaskOnly: taskOnly.has(call),
        detail: noTextDetails.get(call) || '',
    }));
    const { degraded, handedToTasks } = sortEmptyResults(rows);
    for (const row of handedToTasks) logStage(stage, `${describeEmptyResult(row)} — it carries only tasks, and each task judges an empty answer`);
    if (!degraded.length) return;
    const names = degraded.map((row) => row.label).join(', ');
    log.child(stage).warn(`${degraded.length}/${calls.length} call(s) left nothing usable — ${degraded.map((row) => describeEmptyResult(row)).join('; ')} — ${withoutThem}: ${names}`);
    toastDegraded(`MVU Helper — ${stage} degraded`, `${degraded.map((row) => describeEmptyResult(row, { withDetail: false })).join('; ')} — ${toastWithoutThem}: ${names}`);
}

// A bad input-filter regex silently sends the FULL input instead of the intended slice —
// a config error only the user can fix. We always log it, and toast ONCE per (call, pattern)
// per session so it's visible without nagging every turn (interceptor runs per reply). The
// toast re-fires if they change the pattern to a different still-bad one.
const _warnedBadFilter = new Set();
function warnIfBadInputFilter(call) {
    const pat = String((call && call.inputRegex) || '').trim();
    if (!pat || !parseInputFilterRegex(pat).invalid) return;
    log.child(callLogLabel(call)).warn('the Input filter is not a valid regex — sending the FULL input:', pat);
    const seen = `${(call && call.id) || call.name}:${pat}`;
    if (_warnedBadFilter.has(seen)) return;
    _warnedBadFilter.add(seen);
    if (typeof toastr !== 'undefined') {
        toast('warning', 
            `Call "${call.name}": its Input filter is not a valid regex, so the full text is being sent. Fix it in Extra LLM Calls → this call's Input filter.`,
            'Invalid input filter', { timeOut: 9000 });
    }
}

// ── EJS render for the assembled system block ────────────────────────────────
// The card's [PRE]/[POST] lorebook entries may contain EJS (e.g. a [POST] <CURRENT_VARIABLE_DATA> that dumps
// current stat_data for the record model). ST-Prompt-Template never sees these — our calls run beneath its
// event hooks — so we render them ourselves via its public engine (globalThis.EjsTemplate). See renderEjsBlock
// in extra-llm-calls-core.js for the rules. `snapshotMsgId` picks the variable snapshot: POST passes the reply's
// mesId (read AFTER RES1 applied narrate's ops → post-narrate state); PRE passes the BASE floor — the last
// assistant floor with state before the last user floor, so a PRE-time state write to the
// user floor can never feed back into PRE's own read on a regenerate.
// Missing EjsTemplate (a broken install — it is a prerequisite of MVU itself) degrades to the raw block +
// a one-time warning; a render error logs and also degrades to raw. Genre-agnostic: only renders when `<%` is
// present, so cards with no EJS in their blocks are untouched and need no ST-Prompt-Template.
let _warnedNoEjs = false;
// EXTRA-CALL RENDER MARKER (card-visible contract). A card's [PRE]/[POST] EJS is evaluated by TWO different
// callers: this function (a real extra-call assembly) and ST-Prompt-Template's page-load world-info preload,
// which re-renders EVERY lorebook entry. From inside the template those are indistinguishable, so a card that
// logs a pipeline trace fires it on a plain browser refresh and reads as a spurious call.
// We publish a DEPTH COUNTER on globalThis for the duration of the render so a card can tell them apart:
//   typeof globalThis.mvuHelperExtraCallRenderDepth === 'number'  → this mvu-helper publishes the marker
//   mvuHelperExtraCallRenderDepth > 0                             → an extra-call render is in progress right now
// A counter (not a boolean) so concurrent/nested renders can't clobber each other's flag. Cards MUST treat
// "property absent" as "unknown → assume in progress", so an older mvu-helper keeps their old behaviour.
export const EXTRA_CALL_RENDER_DEPTH_KEY = 'mvuHelperExtraCallRenderDepth';
if (typeof globalThis !== 'undefined' && typeof globalThis[EXTRA_CALL_RENDER_DEPTH_KEY] !== 'number') {
    globalThis[EXTRA_CALL_RENDER_DEPTH_KEY] = 0;                   // publish the capability at load, even at rest
}
async function renderCallEjs(text, snapshotMsgId, label) {
    const Ejs = (typeof globalThis !== 'undefined' && globalThis.EjsTemplate) || null;
    if (typeof globalThis !== 'undefined') globalThis[EXTRA_CALL_RENDER_DEPTH_KEY]++;
    try {
        return await renderEjsBlock(Ejs, text, {
            snapshotMsgId,
            onMissing: () => {
                if (_warnedNoEjs) return;                      // once per session — don't nag every call
                _warnedNoEjs = true;
                log.warn('ST-Prompt-Template (globalThis.EjsTemplate) not found — card EJS in [PRE]/[POST] blocks is being sent RAW to the small model. ST-Prompt-Template is a prerequisite; install/enable it.');
                if (typeof toastr !== 'undefined') {
                    toast('warning', 'ST-Prompt-Template not found — EJS in extra LLM-call blocks is sent unrendered. Install/enable ST-Prompt-Template.', 'MVU Helper', { timeOut: 9000 });
                }
            },
            onError: (e) => log.child(label).error('EJS render failed — sending the raw block:', e),
        });
    } finally {
        // finally, not a trailing decrement: renderEjsBlock swallows render errors, but prepareContext or an
        // aborted call can still reject — a leaked counter would wedge the marker "on" for the whole session.
        if (typeof globalThis !== 'undefined') globalThis[EXTRA_CALL_RENDER_DEPTH_KEY]--;
    }
}

// ── {{mvuhelper::…}} call-input macros (devdoc/call-input-macros.md) ────────────
// Runs LAST in the assembly chain. Every warn it can produce is a CARD-AUTHORING mistake surfaced
// to the person who can fix it, and none of them block the call: an unresolvable token becomes ''
// (the empty-tolerant contract — one degrade path for first-turn, reload, timeout and typo alike).
const _warnedOncePerSession = new Set();            // once per session per distinct message, not per call
function warnOncePerSession(key, label, message) {
    if (_warnedOncePerSession.has(key)) return;
    _warnedOncePerSession.add(key);
    log.child(label).warn(message);
}

function substituteInputMacrosForCall(text, label, macroContext) {
    // The swipe-unsafe lint fires on what the CARD wrote, whether or not it uses our namespace:
    // ST's {{lastCharMessage}} reads the LIVE chat (swiped-AWAY reply on a swipe) and the RAW .mes
    // (not the prompt-regexed text the narrator read). Two silent bugs; name the replacement.
    for (const { macro, use } of findSwipeUnsafeMacros(text)) {
        warnOncePerSession(`unsafe:${macro}`, label, `uses ${macro} — it reads the LIVE chat (on a swipe: the swiped-AWAY reply) and the RAW message text, not what the narrator actually read. Use ${use} instead.`);
    }
    if (!macroContext || !blockUsesInputMacros(text)) return text;
    const { text: out, resolved, warns } = substituteInputMacros(text, macroContext);
    for (const w of warns) warnOncePerSession(`token:${w}`, label, w);
    // Log-sanity: an EMPTY resolution must still PRINT (`∅`). "history::2=∅" and no line at all
    // mean very different things, and only one of them is "the card asked and got nothing".
    log.child(label).child('macros').domain('pipeline', 'lifecycle', `${formatMacroTrace(resolved)}`);
    return out;
}

// ── the player's out-of-character commands ────────────────────────────────────
// An OOC command is an admin order every model of the turn sees (extra-llm-calls-core oocCommandBlockFor). A call
// whose input leaves one out — POST reads the reply, and an input filter can cut the message — is sent it after its
// rules, appended once every render pass is done, so the player's words are never read as EJS or a macro.
// `macroContext.userLine` is the message the turn answers; a call run without one (the Test button) is sent none.
function withOocCommands(rules, userInput, label, macroContext) {
    const { block, carried, unclosed } = oocCommandBlockFor(macroContext && macroContext.userLine, userInput);
    for (const opening of unclosed) {
        warnOncePerSession(`ooc-unclosed:${opening}`, label, `the player's message opens an OOC command it never closes ("${opening}…") — it is not read as one, so no call whose input leaves it out is sent it`);
    }
    if (!block) return rules;
    logStage(label, `sent ${carried.length} OOC command(s) from the player's message: ${carried.join(' · ')}`);
    return rules ? `${rules}\n\n${block}` : block;
}

// ── full block decode for the assembled system block ──────────────────────────
// Runs AFTER renderCallEjs (native order: EJS first, then macros/regex). Card [PRE]/[POST] blocks — and any EJS
// output — carry THREE decode layers that ST/TavernHelper apply ONLY in the main Generate flow, which our
// ChatCompletion path bypasses (see renderCallEjs): (1) tavern regex scripts, (2) ST `{{...}}` macros
// (`{{user}}`, `{{roll:d20}}`), and (3) TavernHelper "macro-likes" like `{{format_message_variable::stat_data}}`
// / `{{get_message_variable::…}}` (applied by JS-Slash-Runner's demacroOnPrompt on GENERATE_AFTER_DATA — a hook
// we never reach). TavernHelper exposes the WHOLE pipeline as one call: formatAsTavernRegexedString(text,
// 'world_info', 'prompt') = getRegexedString → substituteParams → macro-likes, in native order. Its middle step
// IS ST's substituteParams, so it's a strict SUPERSET of a substituteParams-only pass — we prefer it, and
// PRE/POST ship no raw `{{…}}` (macro-likes included). `snapshotMsgId` pins WHICH message's variables the
// macro-likes read (POST → the reply's post-narrate snapshot, mirroring renderCallEjs); omitted → TavernHelper's
// default (latest message that carries variables). Degrade ladder: no TavernHelper → bare ST substituteParams
// (still does {{user}}/{{roll}}, but NOT macro-likes) → RAW + a one-time warning. See substituteMacrosBlock. Running
// our OWN decode means a card never depends on whether a given ST/TavernHelper version decodes on this path.
let _warnedNoDecoder = false;
function substituteCallMacros(text, label, snapshotMsgId = null) {
    const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
    // Preferred: TavernHelper's full decode (regex + macros + macro-likes) — a superset of substituteParams.
    const TH = (typeof globalThis !== 'undefined' && globalThis.TavernHelper) || null;
    const fmt = TH && typeof TH.formatAsTavernRegexedString === 'function' ? TH.formatAsTavernRegexedString.bind(TH) : null;
    if (fmt) {
        // Pin the message-variable snapshot: TavernHelper maps depth→message_id as chat.length-1-depth, so
        // depth = chat.length-1-snapshotMsgId makes format_*_variable read exactly snapshotMsgId's variables.
        const fmtOpts = {};
        if (snapshotMsgId != null && ctx && Array.isArray(ctx.chat)) {
            const depth = ctx.chat.length - 1 - Number(snapshotMsgId);
            if (Number.isFinite(depth) && depth >= 0) fmtOpts.depth = depth;
        }
        return substituteMacrosBlock((s) => fmt(s, 'world_info', 'prompt', fmtOpts), text, {
            requireDelimiter: false,                           // regex step isn't `{{`-gated → always decode
            onError: (e) => log.child(label).error('block decode (formatAsTavernRegexedString) failed — sending the block raw:', e),
        });
    }
    // Fallback: bare ST substituteParams — expands {{user}}/{{roll}}/{{char}} but NOT TavernHelper macro-likes.
    const fn = ctx && typeof ctx.substituteParams === 'function' ? ctx.substituteParams : null;
    const subFn = fn ? (s) => fn.call(ctx, s) : null;          // bind: substituteParams reads ambient chat/char state
    return substituteMacrosBlock(subFn, text, {
        onMissing: () => {
            if (_warnedNoDecoder) return;                      // once per session — don't nag every call
            _warnedNoDecoder = true;
            log.warn('Neither TavernHelper.formatAsTavernRegexedString nor SillyTavern.substituteParams found — {{...}} macros/macro-likes in [PRE]/[POST] blocks are being sent RAW to the small model.');
        },
        onError: (e) => log.child(label).error('macro substitution failed — sending the block with macros raw:', e),
    });
}

// ── the call itself ──────────────────────────────────────────────────────────
// Silent (no UI flicker), bypasses our own interceptor, targets its own connection profile.
// Mirrors Multihog's sendStateRequest (llm-client.js:307).
//
// READ-ONLY on ST state: we hand `profileId` to ConnectionManagerRequestService and ST does the
// rest — it reads the profile's model/api-url/preset AND resolves the key server-side from
// `secret-id` (shared.js:446/472). mvu-helper never holds a key or a URL, and never writes to a
// profile. Anything we want to differ per call must ride the REQUEST (maxTokens, overridePayload),
// never a mutation of the shared profile object.
//
// That rule is why there is no per-call preset override: ST bundles a preset INTO a profile, so "a
// different preset" is "a different profile", and honouring an override would mean writing `profile.preset`
// on ST's shared object for the length of the request — which a timed-out call could leave mutated
// for good (ST persists that object). Sampling knobs that CAN ride the request stay: maxTokens, temp.
// `onNoText(detail)`, when given, is told what the provider's answer held when it held no text
// (describeNoTextAnswer); the pass that ran the call says what that means (reportEmptyResults). Run ad
// hoc, without it, the call warns it here.
export async function runLlmCall(call, userText, signal = null, label = callLogLabel(call), snapshotMsgId = null, macroContext = null, systemBlock = null, { onNoText = null } = {}) {
    const ctx = SillyTavern.getContext();
    const svc = ctx.ConnectionManagerRequestService;
    if (!svc || typeof svc.sendRequest !== 'function') {
        throw new Error('ConnectionManagerRequestService unavailable (update ST / enable Connection Manager)');
    }
    if (!call || !call.profileId) throw new Error(`call "${call && call.name}" has no profile selected`);

    // The pass already collected this to decide whether the call was worth making (partitionCallsByContract),
    // so it is threaded in rather than re-read: one lorebook read per call per turn, and the routing
    // manifest prints once instead of twice.
    const rawSys = (systemBlock == null) ? await collectLorebookBlock(call.name, label) : systemBlock;
    // Render card-authored EJS, THEN run the full tavern decode (regex + {{...}} macros + TavernHelper
    // macro-likes) — native order (EJS first), and both needed because our ChatCompletion path is beneath ST's
    // EJS hooks AND its regex/macro passes (see the two helpers). snapshotMsgId pins which message's variables
    // the format_*_variable macro-likes read (POST → post-narrate snapshot), mirroring renderCallEjs.
    const rendered = await renderCallEjs(rawSys, snapshotMsgId, label);
    const decoded = substituteCallMacros(rendered, label, snapshotMsgId);
    // {{mvuhelper::…}} resolves LAST — after EJS and after the full tavern decode — so returned
    // prose is never re-interpreted (a reply containing `<%` or `{{` would otherwise break the EJS
    // render or get macro-expanded). Raw text in, raw text out.
    const rules = substituteInputMacrosForCall(decoded, label, macroContext);
    // Per-call input filter (card-supplied regex) — e.g. POST reading only <gametxt>. Keeps the
    // small model focused + cuts tokens; no filter → full input. Generic (pattern lives in the card).
    // A BAD regex degrades to "no filter" (the FULL reply is sent) — surface it so the user fixes it.
    warnIfBadInputFilter(call);
    // Then a task this call carries may shape what it reads (llm-task-router shapeRoutedCallInput): the picture
    // task numbers the reply's lines, after the filter, so the numbers are the lines this call reads, and closes
    // them with its <picture_count>.
    const userInput = shapeRoutedCallInput(call.name, applyInputFilter(userText, call.inputRegex),
        { phase: macroContext ? macroContext.stage : null, messageId: snapshotMsgId });
    const sys = withOocCommands(rules, userInput, label, macroContext);
    const messages = buildMessages(sys, userInput);
    const maxTokens = normalizeMaxTokens(call.maxTokens);
    const overridePayload = buildOverridePayload(call.temperature);

    // Detailed call I/O — gated by the global `smallllm` domain toggle.
    // The preset is the PROFILE's (includePreset: true) — mvu-helper never overrides it.
    // Every line of this call carries the call's own tag, so its input and its output read as one call.
    const callLog = log.child(label);
    if (log.domainEnabled('smallllm')) {
        callLog.domain('smallllm', 'io', `call → profile ${call.profileId}`);
        callLog.domain('smallllm', 'io', 'system block:', sys || '(none)');
        callLog.domain('smallllm', 'io', 'user:', userInput);
        callLog.domain('smallllm', 'io', 'maxTokens:', maxTokens, '| preset: (from profile)',
            '| temp:', overridePayload.temperature);
    }

    // extractData:false — the RAW provider json, because the extracted shape drops `finish_reason`
    // and a provider CUT then reads exactly like "the model wrote nothing more".
    // extractCompletionText handles the raw shapes itself.
    const data = await svc.sendRequest(
        call.profileId,
        messages,
        maxTokens,
        { stream: false, extractData: false, includePreset: true, includeInstruct: true, signal },
        overridePayload,
    );
    const text = extractCompletionText(data);
    const cut = completionCutReason(data);
    if (cut) {
        callLog.warn(`the provider CUT this output: finish_reason="${cut}" — the text ends where the cut landed, `
            + `and every block this call's contracts expected AFTER that point was never generated. `
            + `A missing trailing block on this turn is the cut, not the model declining.`);
    }
    if (!text.trim()) {
        const detail = describeNoTextAnswer(data);
        if (onNoText) onNoText(detail);
        else callLog.warn(`answered with no text — ${detail}`);
    }
    callLog.domain('smallllm', 'io', 'response:', text);
    // Token usage: ST tokenizer estimate, not the provider's billed `usage`.
    // Gated at lifecycle — only count when it'll actually be logged.
    if (log.enabled('lifecycle')) {
        try {
            const count = ctx.getTokenCountAsync || ctx.getTokenCount;
            if (typeof count === 'function') {
                const inText = messages.map((m) => String(m.content || '')).join('\n');
                const [inTok, outTok] = await Promise.all([
                    Promise.resolve(count(inText)),
                    Promise.resolve(count(String(text || ''))),
                ]);
                logStage(label, `estimate (Input: ${inTok} tok , Output ${outTok} tok)`);
            }
        } catch (e) { log.warn(`token estimate failed:`, e); }
    }
    return text;
}

// ── Robustness helpers: per-call timeout + RES staging readiness ──────────────
// Bound every small-LLM call. PRE runs inside the interceptor that GATES the main reply; POST's combined flush
// awaits ALL calls (Promise.all). So a request that STALLS — never resolves OR rejects (dead socket, provider
// holding the connection) — would hang generation (PRE) or the whole turn's record + <RES_Variable> write (POST).
// `.catch` only handles rejection, not a stall, so we add an explicit timeout: a timed-out call resolves to null
// (its block is simply skipped, others proceed) and we abort the request if the provider honors the signal.
// The bound is per-card and GUI-configurable (Extra LLM Calls tab → "Call timeout (s)"), default 60 s; read fresh.
const DEFAULT_CALL_TIMEOUT_SEC = 60;
function callTimeoutMs() {
    try {
        const v = Number(getExtraLlmCallsProfile().timeoutSec);
        if (Number.isFinite(v) && v >= 5) return v * 1000;
    } catch (_e) { /* EXPECTED: settings not ready at early load → fall through to the default */ }
    return DEFAULT_CALL_TIMEOUT_SEC * 1000;
}
function runCallBounded(call, userText, timeoutMs = callTimeoutMs(), label = callLogLabel(call), snapshotMsgId = null, macroContext = null, systemBlock = null, { onNoText = null } = {}) {
    const callLog = log.child(label);
    const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let timer = null;
    const work = Promise.resolve()
        .then(() => runLlmCall(call, userText, ac ? ac.signal : null, label, snapshotMsgId, macroContext, systemBlock, { onNoText }))
        .catch((e) => { callLog.error('the call failed:', e); return null; });
    const guard = new Promise((resolve) => {
        timer = setTimeout(() => {
            callLog.warn(`the call timed out after ${timeoutMs}ms — skipping it`);
            try { if (ac) ac.abort(); } catch (e) { callLog.warn('abort on timeout failed (non-fatal):', e); }
            resolve(null);
        }, timeoutMs);
    });
    return Promise.race([work, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

// RES1 (logic-engine's turn runner) STAGES the turn's <RES_Variable> audit as a marker the post-reply phase
// carries into the reply, beside POST's own blocks or alone (finishWithoutPostCalls); the readers and the wait
// are the turn runner's (readResStaged / readResMarkerDone / awaitResStaged). The post-reply phase waits only
// when a turn resolver runs at all (isTurnResolverActiveNow), and matches the marker against the swipe it FENCED
// at entry (fenceSwipe) — the SAME swipe the degraded-check, turn-fence, and the staging use. The write fence
// (postTurnFenceHolds) still guards a genuine swipe-away.
//
// THE CLOCK IS A BACKSTOP, NOT THE MECHANISM, and it cannot be deleted: a resolver that never stages — a
// resolveTurn that throws, or a card still carrying a baked resolver that stages without emitting the signal —
// would otherwise hang the wait forever. Raising it would be the wrong fix for a late resolve; the signal and
// the write-time re-read already handle that.
const RES_STAGE_TIMEOUT_MS = 4000;

// THE POST-RELAY BLOCK. The engine's RES2 audit block for THIS turn, staged by the turn runner as
// `__mvuPostRelayBlock` when its resolvePostRelay ran on POST's parse. Read only AFTER awaitTurnWork —
// the run that stages it is the very run POST waits for — so there is no signal to wait on and no
// clock to guess with. '' when nothing was staged for this turn (no engine, or one without a relay).
function readPostRelayStaged(ctx, mesId, swipe) {
    const s = ctx && ctx.chat && ctx.chat.__mvuPostRelayBlock;   // plain property access — can't throw
    return (s && s.mid === mesId && s.swipe === swipe && s.done && s.block) ? String(s.block) : '';
}

// ── persistent PRE / SIM calls (PRE-time apply) ──────────────────────────────
// A PRE call that emits a <JSONPatch> is a SIM (beside any ordinary output — mixed output). The
// interceptor splits + validates, APPLIES the patch at PRE time onto the LAST USER floor
// (applySimBlockAtPre — narrate then reads the new value from state, and MVU's Fe carries it onto the
// reply floor), and injects prose RENDERED FROM THE OPS (never the ops themselves — see
// renderSimInjectLines' raw-ops note in core).
//
// A sim evolves its PREVIOUS state, and it reads that state the way every call reads state: EJS in its
// own routed entries. PRE's EJS is pinned to the BASE floor, never the user floor a PRE-time apply
// dirties, so a regenerate's attempt 2 never evolves from attempt 1's output. There is no separate
// per-call feed (the retired `ownedRoot` — RETIRED_CALL_FIELDS in core).

// One place that turns a simPreApplyDisposition verdict into its log line, so the wording cannot
// drift between call sites and no discard is ever silent.
// Levels are deliberate and unequal: a STOPPED turn is the user's own doing (lifecycle — expected,
// not a fault); a stale epoch or a moved turn means the fence caught a real cross-turn write (warn).
// drop-no-user-floor: this write REQUIRES a user floor.
// The lines name no root — a patch is not scoped to one, so "its state" is the honest phrasing.
function logSimPreDrop(verdict, simLog, uReal) {
    if (verdict === 'drop-stopped') {
        simLog.lifecycle(`NOT applied — generation was stopped during the PRE call; its state skips this beat and recomputes next turn`);
    } else if (verdict === 'drop-stale-epoch') {
        simLog.warn(`NOT applied — a newer generation started during the PRE call (stale epoch); its state does not advance this turn`);
    } else if (verdict === 'drop-swiped') {
        simLog.warn(`NOT applied — the turn advanced during the PRE call (user floor #${uReal} is no longer the last); dropped to protect the current turn`);
    } else {
        simLog.lifecycle(`NOT applied — no USER floor at #${uReal} to write into (deleted or replaced mid-call)`);
    }
}

// THE ATTEMPT ID a floor's undo record is stamped with (core: THE FLOOR UNDO RECORD). generationEpoch counts
// from 0 on every page load, so a record saved before a reload would match a new attempt's bare epoch and skip
// its reset; the page-load id keeps attempts from different loads apart.
const PAGE_LOAD_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const simAttemptId = (epoch) => PAGE_LOAD_ID + ':' + epoch;

// THE PRE-TIME APPLY — exactly ONCE, at PRE time. The patch lands on the LAST USER floor:
// narrate reads it from state (MVU's Fe seeds the reply floor from chat[u]), an Intent-rooted
// write reaches RES1 through the same inheritance, and there is NO second apply — Fe carries the
// effect, and a reply-time re-apply after RES1 would ROLL BACK the later stage's value.
// parseMessage applies onto a CLONE it returns and never mutates the vars passed in (verified
// against the bundle); replaceMvuData is the persist. The undo-record restore runs on
// OUR clone BEFORE parseMessage, so a chat floor only ever changes through replaceMvuData — a
// parse failure leaves no half-applied in-memory state.
async function applySimBlockAtPre({ label, block, ops, entryEpoch, uReal }) {
    // `label` is the writer's log tag: the call's (callLogLabel) or the engine rail's.
    const simLog = log.child(label).child('SIM');
    // FENCE: re-read the REAL chat NOW — the PRE call took ~2s and the
    // user can stop, swipe, or advance the turn inside that window.
    const ctx = SillyTavern.getContext();
    const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
    const verdict = simPreApplyDisposition({
        entryEpoch, currentEpoch: generationEpoch, generationStopped, chat, expectedUserIndex: uReal,
    });
    if (verdict !== 'apply') { logSimPreDrop(verdict, simLog, uReal); return false; }
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.parseMessage !== 'function' || typeof Mvu.replaceMvuData !== 'function') {
        simLog.error('Mvu.parseMessage/replaceMvuData unavailable — NOT applied (world state lost this turn)');
        return false;
    }

    const attempt = simAttemptId(entryEpoch);
    const applyToFloor = async (floorId) => {
        const msg = chat[floorId];
        const swipe = (msg.swipe_id != null) ? msg.swipe_id : 0;
        const vars = msg.variables && msg.variables[swipe];
        if (!vars || !vars.stat_data) {
            simLog.error(`msg ${floorId} has no variables[${swipe}] — NOT applied to it (is MVU active on this card?)`);
            return false;
        }
        // Attempt-residue guard: a NEW generation re-applying on this floor (regen/swipe — the previous
        // attempt's writes persist on it) first puts back the paths PRE wrote there, and nothing else; then
        // this apply's own paths join the record, which the message carries (core: stepSimUndo). A second
        // PRE write in the SAME generation stacks without a reset.
        const stored = readSimUndoRecord(msg, swipe);
        if (stored.isMalformed) {
            simLog.warn(`msg ${floorId} holds a ${SIM_UNDO_EXTRA_KEY} entry for swipe ${swipe} that is not an undo record — ignored: this attempt records afresh, so a retry puts back only what it writes from here`);
        }
        const clone = structuredClone(vars);
        const { record, reset } = stepSimUndo(stored.record, attempt, clone.stat_data, ops);
        // SUPPRESSED parse: parseMessage emits VARIABLE_UPDATE_ENDED, and an Intent-rooted write
        // would make the turn runner resolve+clear this very patch MID-TURN, before narrate
        // reads it. See logic-engine/live-resolve-gate.js.
        // Through parseMvuBlock — THE one door (check-mvu-writes.mjs refuses a direct call), which is
        // also what labels these ops 'pre-sim' for the turn's attribution. Same call underneath;
        // null covers the no-data cases (MVU unavailable, nothing to parse, no stat_data back).
        const applied = await withLiveResolveSuppressed(() => parseMvuBlock(block, clone, { writer: 'pre-sim' }));
        if (!applied) {
            simLog.error(`parseMvuBlock returned no data — NOT applied to msg ${floorId}`);
            return false;
        }
        // The record rides the state's own save: replaceMvuData's chat save writes the whole message, `extra` included.
        writeSimUndoRecord(msg, swipe, record);
        await saveMessageMvuData(applied, floorId, { writer: 'pre-sim' });   // THE persist
        // BEFORE and after, together. `clone.stat_data` is still the pre-apply state — parseMessage
        // klona-clones its argument and returns the clone — and the value probe below cannot tell a
        // refusal from a coercion without it. Truthiness is unchanged for both callers: this object
        // on success, `false` on every failure path above. `reset` = the paths a retry put back.
        return { applied, before: clone.stat_data, reset };
    };

    const latest = chat.length - 1;
    const userRun = await applyToFloor(uReal);
    if (!userRun) return false;
    const appliedUser = userRun.applied;
    // The second write — the CACHE floor. On a swipe, narrate's prompt renders from the latest AI
    // floor's variables clone, taken before PRE ran and never refreshed; without this write the
    // injected lines and the Window-A EJS contradict each other on that one path. On a normal
    // generate the latest floor IS the user floor and this is skipped.
    let cacheNote = '';
    if (latest !== uReal && chat[latest] && !chat[latest].is_user) {
        cacheNote = (await applyToFloor(latest))
            ? ` + cache floor #${latest}`
            : ` (cache floor #${latest} write FAILED — this swipe's EJS view may lag the injected lines)`;
    }
    const paths = [...new Set(ops.map((o) => o.path))];
    // A retry names what it put back, so a value that moved on a regenerate is traceable to PRE's own
    // reset — and everything NOT listed is known to have been left as the floor held it.
    const resetNote = userRun.reset.length
        ? ` · retry: reset ${userRun.reset.length} path(s) the last attempt wrote (${userRun.reset.join(', ')})` : '';
    simLog.domain('pipeline', 'lifecycle', `applied ${ops.length} op(s) → user floor #${uReal}${cacheNote} ✓ (${paths.join(', ')})${resetNote}`);
    // Post-apply health checks on the persisted user-floor clone (WARN-ONLY by design).
    // PER-OP: with write-anywhere there is no single root to probe, and the per-op probe is
    // strictly sharper — it names the exact path the card's Zod stripped, not just a subtree.
    const outcomes = opsOutcomeAfterApply(userRun.before, appliedUser.stat_data, ops);
    const notTaken = outcomes.filter((r) => r.state === 'refused' || r.state === 'absent');
    if (notTaken.length) {
        // The strip trap, self-announcing: a strict card Zod schema silently drops
        // unenumerated paths during MVU's parse — detection, not a fallback. By VALUE, because a
        // path that is still THERE holding what it already held is a refusal too, and presence alone
        // reads that as a success (a reverted tuple insert, for one).
        simLog.warn(`${notTaken.length} op(s) did NOT take — ${refusedByPhrase(appliedUser)}: ${notTaken.map(renderOpOutcome).join(' · ')}`);
    }
    return true;
}

// The engine's PRE-rail patches. Asks the HOSTED ENGINE what it wants written, and applies the answer
// through the same rail a sim patch uses — fence, floor snapshot and Zod-strip probe all cover it for
// free. This file never learns what the ops MEAN: the engine computes them from its own state, this rail
// only carries them. What goes in the patch is entirely the card's business — the platform's whole
// contract is "a JSONPatch the card's Zod will judge". Two hooks write on it:
//   · preAssemblyPatch — before any model runs.
//   · preVerdictPatch  — after the PRE calls, handed what each one said and wrote (ctx.preOutputs, built by
//     preHookOutputs: its raw output and the ops it applied), for a write that depends on this turn's PRE
//     verdict and that the narrator must already see. It runs only when PRE calls ran: without them there is
//     no verdict to act on.
//
// CONTRACT: `preAssemblyPatch(statData, { type, mid, swipe, generationAttempt })` → JSONPatch ops, or [].
//           `preVerdictPatch(statData, { type, mid, swipe, generationAttempt, preOutputs })` → the same,
//           with preOutputs = [{ name, output, appliedOps }].
//   · statData — the BASE floor's stat_data (the read/write split is explained below).
//   · type     — ST's generation type for this turn: 'normal' | 'regenerate' | 'swipe'. NEVER
//                'continue' / 'quiet' / 'impersonate': those are not a turn of the story and the
//                interceptor stands down before reaching here (isStoryTurnGenerationType), so an
//                engine counter bumped on every call bumps once per story turn, not once per Continue.
//   · mid      — the USER floor the ops are written to: the turn's identity at PRE time, since the
//                reply does not exist yet. (RES's `mid` is the reply floor, one stage later.)
//   · swipe    — that user floor's swipe_id (0 unless the user swiped their own line).
//   · generationAttempt — a counter that ADVANCES on every regenerate and every swipe, and is stable
//                for the whole of one attempt. It is the ONLY value in this context that changes when
//                the user re-rolls a turn: `type`, `mid` and `swipe` are all identical across
//                attempts at the same turn, and so is anything derived from the BASE floor (which
//                this rail never writes). An engine whose output must differ per attempt — a fresh
//                fight when the player regenerates away from a bad roll — folds this into its seed
//                and persists it; one that must NOT differ simply ignores it. Do not read it as a
//                turn number: a background `quiet` generation advances it too.
// The ENGINE owns the emptiness rule: it returns [] when nothing needs changing this turn, so the
// contract is "called every story turn, writes only when the engine says so" — the platform adds
// no gating of its own. NOT fatal on any failure — a card whose engine lacks the export, or whose
// export throws, keeps a perfectly good turn; only the engine-authored state stands still.
// WHY A PLATFORM CALL AND NOT A LOREBOOK/EJS ENTRY (the first question a reader asks, since a
// card's other pre-turn engine calls are typically invoked from its own EJS blocks). Those RENDER
// TEXT for a model; this one WRITES STATE, and an EJS-driven write is unsafe by MECHANISM, not by
// convention:
//   · EJS renders MORE THAN ONCE per turn, dry runs included, so a write there fires on throwaway
//     renders (the prepareContext write-through trap).
//   · An EJS write gets no apply fence, no floor snapshot, and no Zod-strip probe, and never
//     reaches the [SIM] log.
// So the line is WHICH DIRECTION the engine call runs: engine → text for a model rides the card's
// own EJS; engine → STATE rides this rail, exactly as resolveTurn does.
//
// READS THE BASE FLOOR, WRITES THE USER FLOOR — the same split every PRE read uses. Reading the
// user floor would mean reading whatever a PREVIOUS attempt of this same turn already wrote there,
// so a regenerate would derive from its own output; the base floor is the last clean pre-turn state.
// The engine rail writes through the same SIM apply as a call, so its lines carry a writer tag too —
// the engine export's name, the one thing on this rail that says who wrote.
// The state the PRE calls READ: the base floor, or the user floor when there is no
// base floor yet. Every engine hook on the PRE rail is handed this one, so the engine judges the state
// the PRE calls saw. null when MVU or that floor's state is unavailable.
function readPreFloorStatData(baseFloor, uReal) {
    const Mvu = getMvu();
    const readId = (baseFloor != null && baseFloor >= 0) ? baseFloor : uReal;
    const data = (Mvu && typeof Mvu.getMvuData === 'function')
        ? Mvu.getMvuData({ type: 'message', message_id: readId }) : null;
    return (data && data.stat_data) ? data.stat_data : null;
}

// `hookName` is one of the two hooks above; it also tags the console lines and the apply, the one thing on
// this rail that says who wrote.
async function applyEngineRailPatch(hookName, baseFloor, uReal, entryEpoch, hookContext) {
    const api = getLogicEngineApi();
    if (!api || typeof api[hookName] !== 'function') return;          // engine absent / doesn't use this hook
    if (uReal < 0) return;
    try {
        const statData = readPreFloorStatData(baseFloor, uReal);
        if (!statData) return;
        const ops = await api[hookName](statData, hookContext);
        if (!Array.isArray(ops) || ops.length === 0) return;            // the quiet path — no log, no write
        const v = validateSimPatchOutput(`<JSONPatch>${JSON.stringify(ops)}</JSONPatch>`);
        if (!v.ok) {
            log.child(hookName).child('SIM').warn(`the engine's patch was REJECTED — ${v.reason}. Nothing applied this turn.`);
            return;
        }
        await applySimBlockAtPre({ label: hookName, block: v.block, ops: v.ops, entryEpoch, uReal });
    } catch (e) {
        log.child(hookName).child('SIM').warn('the engine\'s patch failed (non-fatal — the turn continues without it):', e);
    }
}

// ── SAME-ROUND EVENT body inject ─────────────────────────────────────────────
// THE ENGINE PICKS, mvu-helper PLAYS. After the PRE calls, the engine's optional
// `pickSameRoundEvent(statData, ctx)` is handed the state those calls read (the base floor) and their raw
// outputs with the ops each applied (`ctx.preOutputs` = [{ name, output, appliedOps }], preHookOutputs), beside the PRE rail's { type, mid, swipe,
// generationAttempt }), and returns the key of the event to play THIS reply, or ''. mvu-helper then
// hands narrate that event's DO body now, instead of the one-reply lag of arm-then-play.
//
// WHY THE PICK IS THE ENGINE'S. mvu-helper calls no engine-specific function and owns no genre engine
// logic. Which events exist, what the PRE calls were asked, in which field they answer and which keys
// they may name are all the engine's, and it judges them on the state the PRE calls actually read —
// the base floor the card's [PRE] block rendered its list from. A platform-side check reading the
// LATEST floor instead could, on a swipe, refuse the very key PRE had been shown.
//
// mvu-helper keeps what the event-pack FORMAT owns: find the @key-gated body (the official schedule or a
// community [MVU_Event_Pack] entry's prose half, identical gate, format §5), decode it, frame it PLAY-NOW,
// and tell RES which key it played (ctx.sameRoundEventKey — the engine judges its own miss). RES1's
// verify-at-fire stays the precise gate: this only PROPOSES, and PRE writes NO state.
// No hook exported ⇒ no same-round firing: a ripe event arms and plays the reply after.

// Decode the extracted body exactly as a PRE output would be (EJS first if any, then {{user}}/macros),
// so an injected body never reaches narrate with raw `<%…%>` or `{{user}}`.
async function renderAndDecodeEventBody(body, snapshotMsgId, key) {
    let out = String(body || '');
    if (out.includes('<%')) out = await renderCallEjs(out, snapshotMsgId, `event:${key}`);
    return substituteCallMacros(out, `event:${key}`, snapshotMsgId);
}

// The instruction that frames an injected same-round body. GENRE-BLIND BY CONSTRUCTION: it may name
// only what the PACK FORMAT owns — the @key and the commit channel (FIRE_INTENT) — and must not name
// any consumer's cast, roster or outcome vocabulary: one consumer's words here would ship that
// consumer's world to every card that installs the extension.
//
// WHY THE "ONLY THE CAST ALREADY PRESENT" CLAUSE IS OURS TO IMPOSE, and not a story policy smuggled
// into a platform (it reads like one):
// this path PLAYS THE BODY A REPLY EARLY. Normally an event arms and fires on the NEXT reply, and the
// card spends that reply staging the beat — moving people into the scene, setting whatever presence
// its own state tracks. Same-round firing deletes that reply. The author wrote the body expecting the
// staging to have happened, so the one thing WE owe the narrator is notice that it has not: play it
// with the scene as it actually stands. The constraint follows from the LIBERTY THIS FILE TAKES with
// the card's schedule — it is not an opinion about what events may contain.
// The register half is the same argument on our own machinery: an invented character that the harvest
// lane then registers lands in the chat's character registry for somebody their engine never created.
// The clause therefore names no cast and no roster — only "a character", which any card has.
//
// The outcome suffix is deliberately described rather than spelled: the `key[:Outcome]` grammar is the
// CONSUMER's (globalLogic splits `fireStr`), so the header points the narrator at the card's own
// contract for it instead of asserting a tier vocabulary the card may not have.
function sameRoundEventHeader(key) {
    // No {{…}} macros here — only the BODY is macro-decoded; the header is verbatim instruction to narrate.
    return '[SAME_ROUND_EVENT]\n'
        + `# The player's move THIS reply makes this event fire NOW — do not wait a reply. PLAY the @${key} body below,\n`
        + '# using ONLY the cast already present in the scene: never force-spawn a character the body names but the\n'
        + '# scene does not have, and never create or register a new one to satisfy it. When the beat is played, report\n'
        + `# it on /Intent/${FIRE_INTENT} under the key "${key}" (plus whatever outcome suffix that channel's contract\n`
        + '# defines) so the engine applies the consequences and verifies the fire.';
}

// The framed PLAY-NOW block to append to the PRE injection, or '' (no same-round event this turn).
// `snapshotMsgId` = baseFloor: the body decodes against the same pinned floor as the PRE calls.
async function buildSameRoundEventBlock(preOutputs, baseFloor, uReal, turnContext) {
    const api = getLogicEngineApi();
    if (!api || typeof api.pickSameRoundEvent !== 'function') {
        log.child('PRE').child('same-round').verbose('the engine exports no pickSameRoundEvent — nothing plays same-round; a ripe event arms and plays the reply after');
        return '';
    }
    const statData = readPreFloorStatData(baseFloor, uReal);
    if (!statData) {
        log.child('PRE').child('same-round').warn(`no state on the floor the PRE calls read (#${baseFloor >= 0 ? baseFloor : uReal}) — the engine was not asked, nothing plays same-round this reply`);
        return '';
    }
    let picked;
    try {
        picked = await api.pickSameRoundEvent(statData, {
            ...turnContext,
            preOutputs,
        });
    } catch (e) {
        log.child('PRE').child('same-round').warn('the engine\'s pickSameRoundEvent failed — nothing plays same-round this reply (the event arms and plays next reply):', e);
        return '';
    }
    const pick = readSameRoundPick(picked);
    if (pick.problem) {
        log.child('PRE').child('same-round').warn(pick.problem);
        return '';
    }
    const key = pick.key;
    if (!key) return '';
    const hit = findArmedBody(await getPrimaryLorebookEntries(), key);
    if (!hit) {
        log.child('PRE').warn(`the engine picked "${key}" to play same-round, but no lorebook entry carries a gated @${key} body — cannot play it (check whichever entry carries this card's event bodies, or the pack's prose half)`);
        return '';
    }
    const decoded = await renderAndDecodeEventBody(hit.body, baseFloor, key);
    const via = (hit.entry && hit.entry.comment) ? String(hit.entry.comment).trim() : 'body entry';
    logStage('PRE', `same-round event "${key}" → injecting @${key} DO body (from ${via})`);
    log.child('PRE').domain('smallllm', 'inject', `same-round @${key} body injected:\n` + decoded);
    noteSameRoundEventInjected(key);   // RES hands it to the engine as ctx.sameRoundEventKey, which judges a miss
    return `${sameRoundEventHeader(key)}\n${decoded}\n[/SAME_ROUND_EVENT]`;
}

// CLOSE THE CARD-IMPORT RACE before anything renders this generation.
//
// index.js fires loadLogicEngine() UNAWAITED at the end of CHAT_CHANGED, so on a fresh import the
// first generation can assemble while globalThis.LogicEngine is still undefined. The card's [PRE]
// <Initiative_Menu> / <Event_Candidates> entries then report UNAVAILABLE, and narrate loses the
// initiative gate for that reply — for no reason except ordering. This interceptor is the one place
// that sees the whole generation before it starts, so it is where the ordering can be made true.
//
// COST IS THE POINT OF THE STATUS CHECK. loadLogicEngine() is NOT free to call speculatively: its
// cache test lives AFTER the worldbook read, so every call fetches all entries (~7 ms here, one of
// them a 180 KB engine) just to compare and return. getLogicEngineStatus() is synchronous over
// already-cached state, so the steady state costs one property read and no await at all.
//
// Retry ONLY the states that can still become 'loaded':
//   'book-not-ready' — the worldbook was not queryable yet. THE race. Retry.
//   'disabled'       — either "not attempted yet" or "off for this card"; indistinguishable, and the
//                      off case returns after a settings read without touching the worldbook. Retry.
//   'no-engine'      — an ordinary MVU card. Retrying would re-read the worldbook every generation
//                      forever to re-learn the same thing. Installing an engine goes through the
//                      tab, which force-reloads. Skip.
//   'error'          — the engine is present and broken. Re-evaluating it every turn adds nothing;
//                      the turn runner already reports it once per chat. Skip.
// PLUS source==='embedded': status is already 'loaded', but on the card's IMPORT-TIME snapshot, taken
// because the standalone book had not registered during CHAT_CHANGED. This is the retry that performs
// the hot-swap — without it a provisional engine would run for the rest of the session and a
// tab-installed one would never take effect. Costs the ~7 ms once, then source flips to 'standalone'
// and this returns on the property read like every other turn.
async function ensureLogicEngineLoaded() {
    const { status, source } = getLogicEngineStatus();
    const provisional = status === 'loaded' && source === 'embedded';
    if (!provisional && status !== 'book-not-ready' && status !== 'disabled') return;
    try {
        await loadLogicEngine();
    } catch (e) {
        // Never let this block the reply — a missing engine degrades the turn, it does not break it.
        log.child('PRE').warn('the logic engine\'s pre-generation load attempt failed (continuing without it):', e);
    }
}

// Why a configured call is NOT runnable for `wantPhase`, as a printable suffix. Shared by both
// passes: the reasons are identical and enabledCalls()/callPhase() are the same predicates, so a
// second copy would drift the moment one gate changes. `profileId` is the easy one to miss —
// the GUI lets you tick `enabled` without picking a connection.
function whyCallNotRunnable(call, wantPhase) {
    const reasons = [];
    if (!call || call.enabled === false) reasons.push('disabled');
    if (!call || !call.profileId) reasons.push('NO CONNECTION PROFILE — pick one in Extra LLM Calls, or it can never run');
    if (!String((call && call.name) || '').trim()) reasons.push('no name');
    if (callPhase(call) !== wantPhase) reasons.push(`phase is ${callPhase(call)}, not ${wantPhase}`);
    return reasons.length ? ` (${reasons.join('; ')})` : ' (runnable?!)';
}

// ── PRE pass: the interceptor ST awaits before sending the main prompt ───────
// Why THIS type is not a turn of the story — one reason per type, because the skip line is read by
// someone asking why their PRE pass did not run and "not a turn of the story" does not answer that.
const NON_TURN_SKIP_REASON = {
    continue: 'this EXTENDS the reply in progress, whose verdict and dice are already in state',
    quiet: 'an ST-internal generation (Summarize / `/gen`), not a beat of the story',
    impersonate: "this writes {{user}}'s own line, so there is no turn to classify yet",
};

export async function mvuHelperInterceptor(chat, _contextSize, _abort, type) {
    // Declared OUTSIDE the try so the finally can close a phase this body opened, on every exit path
    // it has — and it has many (six early returns, a catch-all, plus a throw from any awaited step).
    // Re-indenting the whole body into its own try/finally would say the same thing with a far larger
    // diff through code that gates the reply; this flag is the same guarantee with two lines.
    let prePhaseOpen = false;
    try {
        // FIRST LINE, before anything can return or throw. Without it the log cannot distinguish
        // "ST never called the interceptor" from "it ran and bailed": both leave no request, no
        // trace and a null `mvuHelper.lastPre`. `type` is here because it is
        // what ST uses to tell a story turn from a swipe/regenerate/quiet generation, and the
        // guard just below acts on it.
        log.child('PRE').verbose(`interceptor entered — type="${type || 'normal'}", ${Array.isArray(chat) ? chat.length : 0} message(s)`);
        // BEFORE the feature gate on purpose: the card's narrate entries call the engine too, and they
        // render whether or not Extra LLM Calls is on.
        await ensureLogicEngineLoaded();

        // NOT A TURN OF THE STORY ⇒ no PRE pass at all: no engine pre-assembly patch, no PRE call, no
        // sim apply. Interceptors are !dryRun-gated, but these are REAL generations that reach here
        // with dryRun=false (script.js Generate → runGenerationInterceptors):
        //   · quiet       — ST-internal (the Summarize extension fires one right after a message).
        //                   Running the pass pays for calls on input that is not a user turn, and
        //                   APPLIES a sim patch off a phantom beat.
        //   · impersonate — writes the USER's line; there is no turn to classify yet.
        //   · continue    — EXTENDS the reply already in progress. Its first half was narrated against
        //                   this turn's PRE verdict, which is already in state. Re-running would
        //                   re-classify the same user line (a small model is not deterministic), rewind
        //                   the user floor and re-patch it, and re-run the engine's own rail — so the
        //                   continuation could be told a different verdict than the prose above it
        //                   already played. The dice dealer stands down on the same three types, from
        //                   the same definition, for the same reason: one reply, one deal, one verdict.
        // The prose half of the PRE output is not re-injected on a continue either — the verdict it
        // carried is in state, and Window-A renders it.
        if (!isStoryTurnGenerationType(type)) {
            log.child('PRE').verbose(`skipped — "${type}": no engine pre-assembly patch, no PRE call, no sim apply — ${NON_TURN_SKIP_REASON[type] || 'not a turn of the story'}`);
            return;
        }

        // The turn's work starts HERE, not at the first LLM call — the engine's PRE-rail patch and the
        // floor reads below are already part of it, and a listener that lit up only for the calls would
        // go dark on a card that runs the engine and no PRE call. Deliberately AFTER the guard above:
        // a background quiet/impersonate generation is not a turn, and must not read as one.
        beginTurnPhase('pre');
        prePhaseOpen = true;

        // THE FLOORS: every PRE-side variables read — EJS getvar, the
        // {{format_*_variable}} macro depth, the sim auto-feed — pins to the last assistant floor
        // WITH state before the last user floor, never the user floor itself (which a PRE-time
        // apply writes, and regenerate would ratchet). Computed from the REAL chat: `chat` (the
        // interceptor argument, and `idx` below) is coreChat — filtered + swipe-popped — so its
        // indices disagree with the real chat's on any chat containing a system message. `idx`
        // stays the INJECT target (coreChat); `baseFloor` is the READ pin (real chat).
        // uReal = the REAL-chat user floor a sim patch writes into. entryEpoch anchors the apply
        // fence: captured BEFORE the ~2s calls run, compared inside applySimBlockAtPre after.
        const realChat = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? (SillyTavern.getContext().chat || []) : [];
        const baseFloor = findBaseFloorIndex(realChat);
        const uReal = findLastUserIndex(realChat);
        const entryEpoch = generationEpoch;
        log.child('PRE').verbose(`base floor = #${baseFloor}, user floor = #${uReal} (real chat ${realChat.length} msg)`);

        // THE ENGINE'S OWN PRE-RAIL PATCH — deliberately ABOVE every gate
        // below, for the same reason ensureLogicEngineLoaded() is: this is the card's LOGIC ENGINE
        // writing deterministic state, and it has nothing to do with whether an LLM call is
        // runnable. Gating it on "is there an enabled pre-phase call with a connection profile"
        // would silently stop it on a card that uses the engine and no PRE call, on a profile where
        // the feature is off, and the moment a user unticks the call. The engine state a turn needs
        // must not depend on the small-LLM feature's configuration (L4: still correct with a stub consumer).
        // What every engine hook on this rail is told about the turn (the two that run after the calls,
        // preVerdictPatch and pickSameRoundEvent, also get their outputs).
        const turnContext = {
            type: type || 'normal',
            mid: uReal,
            swipe: (realChat[uReal] && realChat[uReal].swipe_id != null) ? realChat[uReal].swipe_id : 0,
            generationAttempt: entryEpoch,
        };
        await applyEngineRailPatch('preAssemblyPatch', baseFloor, uReal, entryEpoch, turnContext);

        // EVERY EXIT FROM HERE SAYS WHY. A PRE pass that simply does not happen looks EXACTLY like a
        // PRE pass that had nothing to say: no request, no trace, `mvuHelper.lastPre` null either way,
        // and after the fact every one of these returns reads as satisfied. Verbose, not lifecycle: on
        // a card that legitimately runs no PRE calls this would otherwise print every single turn.
        const elc = getExtraLlmCallsProfile();
        if (!elc.enabled) {
            log.child('PRE').verbose(`skipped — Extra LLM Calls is OFF for this profile (${profileKey()})`);
            return;                                     // feature off → no-op (card uses its full engine)
        }
        if (!Array.isArray(chat) || chat.length === 0) {
            log.child('PRE').verbose(`skipped — the interceptor received no chat to read (${Array.isArray(chat) ? 'empty array' : typeof chat})`);
            return;
        }

        let calls = enabledCallsForPhase(elc.calls, 'pre');
        if (calls.length === 0) {
            // Print the REASON each call is not runnable, not just its name and phase: a PRE call held
            // back by an unset connection profile would otherwise print as a plain, healthy-looking
            // `PRE:pre` directly above "no runnable pre-phase call", which reads as a contradiction and
            // sends the reader hunting the wrong thing. `profileId`
            // is a hard requirement in enabledCalls() — a call with no endpoint cannot be dispatched —
            // and the UI lets you tick `enabled` without choosing one. (The reason builder is shared
            // with POST — whyCallNotRunnable.)
            const configured = (elc.calls || []).map((c) => `${(c && c.name) || '(unnamed)'}${whyCallNotRunnable(c, 'pre')}`);
            log.child('PRE').verbose(`skipped — no runnable pre-phase call in profile ${profileKey()}. Configured: ${configured.join(' · ') || '(none)'}`);
            return;
        }

        // Nothing routed to a call means nothing to ask it — skip it BEFORE it is dispatched, so an
        // empty contract costs no request and cannot reach the degraded summary below.
        const preContracts = await partitionCallsByContract(calls, 'PRE');
        calls = preContracts.withContract;
        if (calls.length === 0) {
            log.child('PRE').verbose(`skipped — every enabled pre-phase call in profile ${profileKey()} has an empty contract (warned above)`);
            return;
        }

        const idx = findLastUserIndex(chat);
        if (idx === -1) {
            log.child('PRE').verbose(`skipped — no user message in the ${chat.length}-message chat to classify (PRE reads the latest user line)`);
            return;
        }
        const userText = extractTextContent(chat[idx]);

        // Run enabled calls — parallel (default) or sequential per the global checkbox.
        // runCallBounded logs + swallows + times out so one bad/stalled call never blocks the reply.
        // PRE macro context: the interceptor's coreChat — swipe-popped AND prompt-regexed, i.e.
        // byte-identical to what the narrator will read. No history bound: the newest assistant
        // message IS the previous turn's reply. `callOutputs` is deliberately absent — PRE calls
        // run in PARALLEL, so callOutput is POST-only and resolves '' + warns here.
        // `taskInstructions` = every task routed to a PRE call, worded for this turn: their routing
        // entries carry `{{mvuhelper::task::<id>}}`, never the text. `userLine` also names the player's
        // OOC commands (withOocCommands): a PRE call reads that line, so only one whose input filter
        // cut a command is sent it.
        const macroContext = {
            stage: 'pre',
            chat,
            userLine: userText,
            historyEndExclusive: null,
            cleanReplyText: stripPatchBlocks,
            taskInstructions: await resolveRoutedTaskInstructions('pre', idx),
        };
        const noTextDetails = new Map();   // call → what its provider's answer held, when it held no text
        const runOne = (c, u) => runCallBounded(c, u, undefined, callLogLabel(c, calls), baseFloor, macroContext, preContracts.blocks.get(c),
            { onNoText: (detail) => noTextDetails.set(c, detail) });
        // Serialize calls that share a profile — one profile is one endpoint, and firing them
        // all at once chokes a single-slot local server. Distinct profiles still run in parallel.
        // NO output-check here: PRE's runs per call on the PROSE half, after the patch split (see the
        // sim loop). POST's runs on its prose half too, after its own split (enforcePostOutputChecks).
        const results = await runCalls(calls, userText, runOne, elc.parallel, callScheduleKey);
        const rawResults = [...results];   // the sim loop below replaces each result with what it keeps
        const quietPatches = new Set();     // calls whose answer was an empty patch alone: no change, nothing lost

        // Expose PRE outputs for genre code + the llm-task router (mirror of POST's lastPost / POST_DONE_EVENT).
        // ALWAYS-FIRE so a PRE-target task capture runs even when a call injected nothing. No reply message exists
        // yet, so we emit the user-message index PRE read. Emitted BEFORE the inject/degraded logic below so an
        // empty-block turn doesn't suppress the capture. Non-fatal if it throws.
        // These carry the RAW output on purpose — the router/debug see what the model actually said,
        // and the engine's pickSameRoundEvent still reads a verdict whose PROSE failed its check.
        const preOutputs = calls.map((c, i) => ({ name: c.name, label: callLogLabel(c, calls), output: results[i] }));
        if (typeof globalThis !== 'undefined') {
            globalThis.mvuHelper = globalThis.mvuHelper || {};
            globalThis.mvuHelper.lastPre = preOutputs;
        }
        try { await eventSource.emit(PRE_DONE_EVENT, idx); } catch (e) { log.warn('PRE-done signal emit failed (non-fatal):', e); }

        // SIM calls (PRE-time apply): any PRE call may carry a <JSONPatch> beside its ordinary
        // output (mixed output). Split, validate STRICTLY, apply at PRE time onto
        // the user floor (+ the cache floor on a swipe), and inject the remainder plus prose
        // RENDERED FROM THE OPS — the raw ops must never reach the narrator's prompt (an echoed
        // block would be re-applied by MVU's native parse, and machine syntax degrades the
        // narrative model). A failed patch drops the patch AND its rendered lines but KEEPS the
        // remainder — the narrator still gets the call's verdict; only state stands still. A failed
        // APPLY likewise injects the remainder alone: never narrate state that did not land.
        // (`lastPre` above deliberately keeps the RAW output, so the router/debug see what the
        // model actually said.)
        // THE SWITCH IS THE PATCH: a PRE call becomes a sim by EMITTING <JSONPatch>, and the
        // patch may write any path the card's Zod validates.
        // ▲ SPLIT FIRST, then check the output regex against the REMAINDER. The
        // two halves of a mixed output are validated by different things — the patch by
        // validateSimPatchOutput (strict JSON), the prose by the card's `outputRegex` — and running
        // the regex on the RAW output would couple them: one stray token (a preamble, a code fence, a
        // <think> block, a trailing note) empties the result before the split, so a perfectly
        // well-formed patch is thrown away with the prose and the turn loses its state. Split first,
        // a bad prose half costs the narrator's injection only, and a bad patch costs the state only.
        const appliedOpsByCall = calls.map(() => []);                   // what each call's patch landed, for the engine hooks below
        for (let i = 0; i < calls.length; i++) {
            const raw = String(results[i] || '');
            if (!raw.trim()) continue;                                   // nothing to split — the empty-result summary below names why
            const label = callLogLabel(calls[i], calls);
            const simLog = log.child(label).child('SIM');
            const split = splitAndCheckSimOutput(raw, calls[i].outputRegex);
            const { patchTexts } = split;
            const prose = reportOutputCheck(calls[i], calls,
                { text: split.prose, dropped: split.proseDropped, invalid: split.regexInvalid }, raw);
            if (patchTexts.length === 0) {
                results[i] = prose;                                      // a prose-only call: nothing to apply
                continue;
            }
            // EVERY block applies. Blocks are how separate lorebook entries routed to one call each
            // ask for their own patch, so one entry's malformed block must cost that block alone.
            const ops = [];
            let blocksRejected = 0;
            let opsDropped = 0;
            for (let b = 0; b < patchTexts.length; b++) {
                const v = validateSimPatchOutput(patchTexts[b]);
                const which = patchTexts.length > 1 ? ` (block #${b + 1}/${patchTexts.length})` : '';
                if (!v.ok) {
                    blocksRejected++;
                    simLog.warn(`patch REJECTED${which} — ${v.reason}. That block's ops + their rendered lines dropped; every other block still applies.`);
                    continue;
                }
                opsDropped += v.dropped.length;
                for (const d of v.dropped) simLog.warn(`dropped ${d.reason}${which} — the rest of the block still applies.`);
                ops.push(...v.ops);
            }
            // COUNT BOTH REFUSAL KINDS, or the "nothing applied" branch below lies. A single block
            // holding one bad-verb op rejects no BLOCK at all — it drops an op — and reporting that
            // as "no changes this turn (empty patch)" would report a refusal as the contract's
            // deliberate quiet turn, which is the one thing that line must never mean.
            const refusals = blocksRejected + opsDropped;
            if (blocksRejected) {
                // "part of" is only true if something else got through — say which it actually was.
                const scope = ops.length ? 'part of its world state does not advance' : 'its world state does not advance';
                toastDegraded('MVU Helper — SIM rejected', `"${label}" emitted ${blocksRejected} invalid patch block(s) — ${scope} this turn.`);
            }
            if (ops.length === 0) {
                results[i] = prose;
                // Two different silences, and they must not read alike: nothing was ASKED for, vs
                // everything asked for was refused. The second is not a quiet turn.
                if (refusals) simLog.warn(`no usable op survived (${blocksRejected} block(s) rejected, ${opsDropped} op(s) dropped) — nothing applied this turn.`);
                else {
                    quietPatches.add(calls[i]);
                    simLog.domain('pipeline', 'lifecycle', 'no changes this turn (empty patch) — nothing applied');
                }
                continue;
            }
            if (refusals) simLog.domain('pipeline', 'lifecycle', `applying ${ops.length} op(s); ${blocksRejected} block(s) rejected, ${opsDropped} op(s) dropped (warned above)`);
            const block = `<JSONPatch>${JSON.stringify(ops)}</JSONPatch>`;
            const ok = await applySimBlockAtPre({ label, block, ops, entryEpoch, uReal });
            if (ok) appliedOpsByCall[i] = ops;
            results[i] = ok ? [prose, renderSimInjectLines(ops)].filter(Boolean).join('\n') : prose;
        }

        // The engine's write on this turn's verdict, after the calls' own patches and before the narrator's
        // prompt is built, so the narrator reads the state it leaves. Both PRE-rail hooks get one shape.
        const hookPreOutputs = preHookOutputs(preOutputs, appliedOpsByCall);
        await applyEngineRailPatch('preVerdictPatch', baseFloor, uReal, entryEpoch, { ...turnContext, preOutputs: hookPreOutputs });

        // The empty-result summary reads what the sim loop kept, so it runs here rather than before the
        // loop: a call whose prose failed its output-check now genuinely has nothing to inject.
        reportEmptyResults('PRE', calls, { rawResults, keptResults: results, taskOnly: preContracts.taskOnly, noTextDetails, quietPatches },
            { withoutThem: 'the narrator runs WITHOUT', toastWithoutThem: 'the reply is generating WITHOUT' });

        // Generic behaviour: inject each PRE call's raw output (wrapped [name]…[/name]) onto
        // the last user message of the PROMPT-BUILDING copy (coreChat) — so the narrator reads
        // it. This is NOT written back to the saved chat, so it only appears in the assembled
        // prompt (use a prompt inspector, or the inject log below, to see it).
        const block = buildInjectionBlock(calls, results);
        // If the engine picks a same-round event, append its DO body so narrate plays it THIS reply.
        let sameRound = '';
        try { sameRound = await buildSameRoundEventBlock(hookPreOutputs, baseFloor, uReal, turnContext); }
        catch (e) { log.child('PRE').warn('same-round event block failed (non-fatal) — event falls back to the 1-reply arm:', e); }
        const fullBlock = [block, sameRound].filter(Boolean).join('\n\n');
        if (fullBlock) {
            if (prependToMessage(chat[idx], fullBlock)) {
                logStage('PRE', `${calls.length} call(s)${sameRound ? ' + same-round event' : ''} → injected onto user msg #${idx}`);
                log.child('PRE').domain('smallllm', 'inject', `injected onto user message #${idx}:\n` + fullBlock);
            } else {
                log.child('PRE').warn('could not inject — unknown message shape:', Object.keys(chat[idx] || {}));
            }
        } else {
            logStage('PRE', `${calls.length} call(s) → no output to inject`);
        }
    } catch (e) {
        // Never block the reply on a tracker failure.
        log.error(`interceptor error (non-fatal):`, e);
        toastDegraded('MVU Helper — PRE failed', 'The PRE pass crashed — the reply is generating without its classification (details in console).');
    } finally {
        if (prePhaseOpen) endTurnPhase('pre');
    }
}

// When the user STOPS the main generation mid-stream, ST still emits MESSAGE_RECEIVED for the partial
// reply (finalizeIntermediaryMessage fires it even when aborted). The post-reply phase does not record a
// half-finished reply, so stops are tracked and that reply is skipped. GENERATION_STOPPED fires before that
// MESSAGE_RECEIVED (stopGeneration aborts THEN emits); GENERATION_STARTED resets the flag per real turn.
let generationStopped = false;

// TURN FENCE identity: bumped on every real (non-dry-run) generation start (next message OR a swipe).
// runPostPass captures it at entry and re-checks it right before it writes (postTurnFenceHolds): the pass
// spends seconds in its LLM calls and the RES wait, during which the user can advance the turn, and applying
// then would relay THIS reply's record onto whatever is current and land RES2's save in the wrong message.
let generationEpoch = 0;

// ST also emits MESSAGE_RECEIVED OUTSIDE generation: a new chat fires it for the static greeting, and
// message imports do the same. The post-reply phase runs only for REAL generated replies, so each real
// (non-dry-run) GENERATION_STARTED arms this flag and the next MESSAGE_RECEIVED consumes it; an unarmed
// fire (greeting / import) skips the pass. Kept in the event listener — a manual runPostPass() call stays
// unguarded.
let awaitingGeneratedReply = false;

// ── the reply's redraw record, opened first ──────────────────────────────────
// The record opens in the FIRST MESSAGE_RECEIVED listener (openTurnRecordFirst, registered with makeFirst
// below), so an edit made by any later listener on this event — MVU's parse and the stat box built at its end
// included — finds it open, whatever order other extensions and scripts registered in. The POST pass stays
// where it registered and adopts the record: its input is still read after the listeners ahead of it.
// It opens for a stopped reply too: the partial reply's own edits are still written once.
const openedTurns = new Map();   // message id → the turn end the first listener opened, until the POST pass takes it

// The reply's redraw record and the clock it runs on (startPostPhaseClock).
function openTurnEnd(msg, mesId, fenceSwipe) {
    const clock = startPostPhaseClock(mesId);
    return { msg, mesId, fenceSwipe, stopWarnings: clock.stopWarnings, redraw: openReplyRedraw(msg, mesId, fenceSwipe, clock.redrawOptions) };
}

function openTurnRecordFirst(messageId) {
    if (!awaitingGeneratedReply) return;               // a greeting or an import: the POST listener says so
    const ctx = SillyTavern.getContext();
    const chat = ctx && ctx.chat;
    const target = postTargetDisposition(messageId, chat);
    if (target.verdict !== 'target' && target.verdict !== 'last') return;   // the POST pass reports why
    const msg = chat[target.mesId];
    openedTurns.set(target.mesId, openTurnEnd(msg, target.mesId, msg.swipe_id != null ? msg.swipe_id : 0));
}

function takeOpenedTurn(messageId) {
    const key = Number(messageId);
    const turnEnd = openedTurns.get(key) || null;
    openedTurns.delete(key);
    return turnEnd;
}

// ── the post-reply phase: the POST calls, and what every reply is owed ───────
// Runs after the main reply. The POST calls read the finished AI reply as their user content (PRE's
// mirror); their outputs are logged and exposed on globalThis.mvuHelper.lastPost. A reply with no POST
// call to run still gets the phase's other two duties (finishWithoutPostCalls): RES1's audit carried into
// the reply, and the POST-done signal the plugin relay waits on. The phase also bounds the reply's redraw:
// every edit the turn hands over while it runs is written once, when it ends (finishPostTurn).
// MUST be invoked fire-and-forget (see the MESSAGE_RECEIVED registration below) so it does NOT block the
// emit chain — MVU's variable-write handler runs on the same event, after ours.
export async function runPostPass(messageId) {
    // Opened before the first gate, and closed in the finally below — see the interceptor's twin. POST
    // is fire-and-forget (`void runPostPass`), so nothing else is holding a handle that could close it:
    // if this function's own finally does not, nothing will.
    beginTurnPhase('post');
    // The reply and its redraw record: the one the first listener opened (taken before any gate, so every exit
    // below closes it), or one opened here for a run nothing opened (a manual runPostPass).
    let turnEnd = takeOpenedTurn(messageId);
    let isTurnSettled = false;   // the pass waited for the turn's own work and the turn is still live
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx && ctx.chat;
        const target = postTargetDisposition(messageId, chat);
        if (target.verdict === 'refuse-no-chat') {
            log.child('POST').verbose(`skipped — no chat to read (${Array.isArray(chat) ? 'empty array' : typeof chat})`);
            return;
        }
        // HARD CUTOFF, never a retarget — see postTargetDisposition. The reply this pass was called
        // for is gone, so there is nothing to record; recording the PREVIOUS one instead would spend
        // an LLM call re-writing record ops a message already applied.
        if (target.verdict === 'refuse-vanished') {
            log.child('POST').warn(`skipped — MESSAGE_RECEIVED named msg ${messageId}, which is not in the chat (${chat.length} message(s)). Its generation died after the message was removed — a chat reload mid-stream, a delete, or a dropped relay. POST does NOT fall back to the last message: that reply already had its turn.`);
            return;
        }
        if (target.verdict === 'refuse-user-message') return;   // only react to AI replies
        const mesId = target.mesId;
        const msg = chat[mesId];
        // Snapshot the turn identity for the fence below (checked right before we write).
        const fenceEpoch = generationEpoch;
        const fenceSwipe = (msg.swipe_id != null ? msg.swipe_id : 0);
        if (!turnEnd) turnEnd = openTurnEnd(msg, mesId, fenceSwipe);
        // The user stopped mid-stream: no POST call records a partial reply. Its own edits (its pictures, the
        // stat box built at MVU's parse, RES1's text) still come, so the record closes after the turn's own work.
        // THE PHASE'S END is marked on the record wherever no LLM call is left before the turn's write — here,
        // in finishWithoutCalls, and once the calls return — so a reader that would redraw something inside the
        // reply waits for the write instead (reply-redraw.js, the write that is due).
        if (generationStopped) {
            log.child('POST').lifecycle('skipped — main generation was stopped/aborted this turn; the partial reply\'s own edits are still written once');
            noteReplyRedrawEnding(turnEnd.redraw);
            await awaitTurnOwnWork(ctx, mesId, fenceSwipe);
            return;
        }
        const finishWithoutCalls = async () => {
            noteReplyRedrawEnding(turnEnd.redraw);
            isTurnSettled = await finishWithoutPostCalls(ctx, msg, mesId, fenceEpoch, fenceSwipe);
        };

        // EVERY REPLY WITHOUT A CALL SAYS WHY: a pass that ran no call and a pass whose calls found nothing must
        // not read alike. Verbose, not lifecycle: on a card that runs no POST calls these print every reply.
        const elc = getExtraLlmCallsProfile();
        if (!elc.enabled) {
            // A routed llm-task target dies here too: the router only knows the call is enabled, not that
            // the feature running it is off.
            log.child('POST').verbose(`no calls — Extra LLM Calls is OFF for this profile (${profileKey()}). Any llm-task routed to a POST call (e.g. character registration) does NOT run either.`);
            return await finishWithoutCalls();
        }
        let calls = enabledCallsForPhase(elc.calls, 'post');
        if (calls.length === 0) {
            const configured = (elc.calls || []).map((c) => `${(c && c.name) || '(unnamed)'}${whyCallNotRunnable(c, 'post')}`);
            log.child('POST').verbose(`no calls — no runnable post-phase call in profile ${profileKey()}. Configured: ${configured.join(' · ') || '(none)'}`);
            return await finishWithoutCalls();
        }
        // Before the RES-stage wait: a call with no contract has nothing to send.
        const postContracts = await partitionCallsByContract(calls, 'POST');
        calls = postContracts.withContract;
        if (calls.length === 0) {
            log.child('POST').verbose(`no calls — every enabled post-phase call in profile ${profileKey()} has an empty contract (warned above)`);
            return await finishWithoutCalls();
        }
        // POST reads the reply but NOT the narrator's own patches (wrapped or bare — stripPatchBlocks) — strip
        // them so the small model can't re-read/echo them (which would risk double-applying). Nor the stat box:
        // it sits inside the story envelope, and a recorder must not read numbers it would record
        // from. Nor the engine's lead and end text, written from state rather than by the narrator. Any per-call
        // inputRegex (e.g. <gametxt>) then narrows it further inside runLlmCall.
        const cleanPostReplyText = (text) => stripLeadAndEndText(stripStatBoxFromText(stripPatchBlocks(text)));
        const replyText = cleanPostReplyText(msg.mes);
        if (!replyText.trim()) {                       // a reply that is ONLY patches / empty — abnormal, surface it
            log.child('POST').warn(`no calls — the reply text is EMPTY after stripping its patch blocks (msg ${mesId}); nothing for the record pass to read`);
            return await finishWithoutCalls();
        }

        // GATE the POST calls behind narrate's applied+resolved state. narrate's ops are applied by MVU (a peer
        // MESSAGE_RECEIVED listener) then RESOLVED by RES1 (on VARIABLE_UPDATE_ENDED), which stages __mvuResBlock.
        // POST's system block may EJS-render a [POST] <CURRENT_VARIABLE_DATA> that must reflect that post-narrate
        // state — so WAIT for the marker BEFORE running the calls (renderCallEjs snapshots stat_data at mesId only
        // once RES1 has resolved). This also hands us the RES display block to carry. Bounded (ends on
        // RES_STAGED_EVENT; RES_STAGE_TIMEOUT_MS is only the liveness backstop). Data-driven → same for 1 or N.
        // The wait runs only when a turn resolver runs at all (isTurnResolverActive in logic-engine's
        // turn-runner-core), never on a guess from the reply's text: MVU applies every <json_?patch> in the
        // message, wrapper or not, and fires mag_variable_update_ended on every reply, so with a game engine RES
        // stages a marker every reply, and on a card with no engine nothing ever stages one.
        const shouldAwaitRes = isTurnResolverActiveNow();
        const narrateBlocks = (String(msg.mes || '').match(/<UpdateVariable>/g) || []).length;   // the summary line's count only
        const resBlock = shouldAwaitRes
            ? await awaitResStaged(ctx, mesId, fenceSwipe, RES_STAGE_TIMEOUT_MS)
            : readResStaged(ctx, mesId, fenceSwipe);
        // UNGATED visibility when the wait ended on the BACKSTOP (marker never reached done). Says only what is
        // true AT THIS POINT: the calls below render pre-resolve state, which is permanent for this turn. The
        // <RES_Variable> itself is re-checked at write time, where a late block is still carried. Distinct from
        // "RES ran, nothing visible changed" (marker done, empty block).
        const resGateTimedOut = shouldAwaitRes && !readResMarkerDone(ctx, mesId, fenceSwipe);
        if (resGateTimedOut) {
            log.child('POST').warn(`RES stage marker not seen within ${RES_STAGE_TIMEOUT_MS}ms (msg ${mesId}) — POST calls will render PRE-resolve state; the <${TURN_AUDIT_TAG}> audit is re-checked at write time`);
        }

        // POST macro context. history is bounded EXCLUSIVE of mesId: THIS turn's reply is already
        // the call's user content, so including it would feed the model the same text twice under
        // two labels. userLine is the user message that PROVOKED this reply (the POST user content
        // is the reply itself, so the user's own line is otherwise unreachable here); its OOC commands
        // are sent to every POST call (withOocCommands). callOutputs
        // is this turn's PRE results — well-defined because the interceptor awaited every PRE call
        // before the reply existed. ⚠ For a SIM call that value is the RAW output (incl. its
        // <JSONPatch>); a POST block wanting a sim's RESULT reads the state the sim wrote, with getvar (the
        // PRE-time apply landed before narrate, so post-reply state already carries it).
        // `taskInstructions` = every task routed to a POST call, worded for THIS reply (the registration
        // text is built from the reply's cast): their routing entries carry `{{mvuhelper::task::<id>}}`.
        const postUserIdx = findLastUserIndex(ctx.chat.slice(0, mesId));
        const macroContext = {
            stage: 'post',
            chat: ctx.chat,
            userLine: postUserIdx >= 0 ? extractTextContent(ctx.chat[postUserIdx]) : '',
            historyEndExclusive: mesId,
            cleanReplyText: cleanPostReplyText,   // raw chat, so earlier replies' boxes are here too
            callOutputs: (globalThis.mvuHelper && globalThis.mvuHelper.lastPre) || [],
            taskInstructions: await resolveRoutedTaskInstructions('post', mesId),
        };
        // POST reads the reply as its USER content; its SYSTEM block is EJS-rendered at mesId (post-narrate state).
        const noTextDetails = new Map();   // call → what its provider's answer held, when it held no text
        const runOne = (c, u) => runCallBounded(c, u, undefined, callLogLabel(c, calls), mesId, macroContext, postContracts.blocks.get(c),
            { onNoText: (detail) => noTextDetails.set(c, detail) });
        // Serialize calls that share a profile — one profile is one endpoint, and firing them
        // all at once chokes a single-slot local server. Distinct profiles still run in parallel.
        const rawResults = await runCalls(calls, replyText, runOne, elc.parallel, callScheduleKey);
        const results = enforcePostOutputChecks(calls, rawResults);
        noteReplyRedrawEnding(turnEnd.redraw);

        // Expose for genre code + live testing.
        const outputs = calls.map((c, i) => ({ name: c.name, label: callLogLabel(c, calls), output: results[i] }));
        if (typeof globalThis !== 'undefined') {
            globalThis.mvuHelper = globalThis.mvuHelper || {};
            globalThis.mvuHelper.lastPost = outputs;
        }
        // POST-DONE fires on every generated reply. Here it tells the llm-task router its call's output is in
        // lastPost (a task-only POST call writes no <UpdateVariable>), and the plugin relay whether a POST PARSE
        // is still coming: computed with the SAME extraction the apply below uses (`blocks` at the apply site),
        // so the hint and the write can never disagree. Emitted BEFORE the write/turn-fence logic so a
        // swiped-away apply-skip does not suppress the capture; the hint is what keeps the relay from running
        // on the strength of this signal when the parse is the reply's trigger. An EMPTY well-formed patch
        // extracts to nothing (the quiet-turn contract) and a block carrying page code is never applied, so
        // both read as "no parse coming".
        const postParseComing = outputs.some((o) => postBlocksForReply(o.output).blocks.length > 0);
        try { await eventSource.emit(POST_DONE_EVENT, mesId, postParseComing, true); } catch (e) { log.warn('POST-done signal emit failed (non-fatal):', e); }
        for (const o of outputs) {
            if (o.output && String(o.output).trim()) log.child(o.label).domain('smallllm', 'post', 'kept for the POST write:', o.output);
        }
        // SURFACE degraded records UNGATED (the same summary as PRE's): a call that left nothing usable → its
        // record pass never ran; non-empty output with NO <UpdateVariable> block → the model broke the output
        // contract, nothing lands.
        reportEmptyResults('POST', calls, { rawResults, keptResults: results, taskOnly: postContracts.taskOnly, noTextDetails },
            { withoutThem: 'nothing recorded from', toastWithoutThem: 'this turn recorded NOTHING from' });
        for (const o of outputs) {
            // classifyPostOutput separates "deliberately nothing to record" (a well-formed EMPTY patch —
            // the contract's quiet-turn answer, which extractUpdateVariableBlocks drops by design) from a
            // REAL problem. Only the two genuinely-broken shapes warn; empty-by-intent stays quiet (the
            // gated [POST] decision line already prints "POST 0 block(s)").
            // A TASK-ROUTED call is exempt from the patch contract entirely: its output is the task's
            // payload (cast records for the registration), delivered via POST_DONE above.
            const ownerTask = taskTargetOf(o.name);
            if (ownerTask) {
                log.child(o.label).domain('smallllm', 'verbose', `this call is the "${ownerTask}" task's target — output is the task's payload, patch classification skipped`);
                continue;
            }
            const cls = classifyPostOutput(o.output);
            if (cls === 'lost-ops') {
                log.child(o.label).warn('this call emitted patch ops OUTSIDE an <UpdateVariable> wrapper — they were NOT applied (data loss; fix the model/output contract)');
            } else if (cls === 'prose') {
                log.child(o.label).warn('this call returned prose with NO patch structure — output contract violated, nothing recorded from it');
            }
        }

        // APPLY: each POST call may emit an <UpdateVariable> block; hand it to MVU so it
        // lands in stat_data this turn (→ VARIABLE_UPDATE_ENDED → the card's resolver). A block carrying page
        // code is neither written nor applied (postBlocksForReply), and the call that wrote it says so.
        const blocks = [];
        let refusedBlockCount = 0;
        for (const o of outputs) {
            const { blocks: kept, refusedTokens } = postBlocksForReply(o.output);
            for (const refusedToken of refusedTokens) {
                log.child(o.label).warn(`this call's <UpdateVariable> block carries "${refusedToken}" — NOT written into the reply and NOT applied. That token makes the page run the reply's text (a TavernHelper render or an ST-Prompt-Template template), and model text never reaches the page as code (the call's prompt or model owns the fix)`);
            }
            refusedBlockCount += refusedTokens.length;
            blocks.push(...kept);
        }
        // RES's staged <RES_Variable> is carried into this same combined edit, so the rendered order stays
        // narrate-UV → POST-UV → RES_Variable. It is RE-READ here: the gate's capture is seconds old (the LLM
        // calls sit between), and a RES that staged inside that window would otherwise be dropped. The write
        // decision depends on the state at WRITE time, the only state that can still be acted on.
        const { block: resBlockNow, late: resLate, willWrite, label: resLabel } =
            decideResCarry(resBlock, readResStaged(ctx, mesId, fenceSwipe), blocks.length);
        // POST write DECISION on the `pipeline` domain (the per-stage flow toggle) — fires every reply POST runs,
        // so "POST chose to write nothing" is visible too. `RES_Variable` reports which of the three it is —
        // carried from the gate, carried but arrived LATE, or absent — so the log never implies the gate
        // succeeded when the write-time re-read is what carried it.
        logStage('POST',
            `${calls.length} call(s) · narrate ${narrateBlocks} UV block(s) · POST ${blocks.length} block(s)${refusedBlockCount ? ` (${refusedBlockCount} refused: page code)` : ''} · ${TURN_AUDIT_TAG} ${resLabel} → ${willWrite ? 'writing' : 'nothing to write'}`);
        // The gate warned that this turn's calls rendered pre-resolve state. Close that thread out loud: the
        // audit block itself was NOT lost, so nobody re-hunts the missing <RES_Variable> half of that warning.
        if (resLate) log.child('POST').warn(`RES stage arrived after the gate (msg ${mesId}) — <${TURN_AUDIT_TAG}> recovered at write time; only the POST calls' own view was pre-resolve`);
        else if (resGateTimedOut) log.child('POST').warn(`RES stage still absent at write time (msg ${mesId}) — ${RES_ABSENT_NOTE}`);
        const isTurnLive = postTurnFenceHolds(ctx, mesId, fenceEpoch, fenceSwipe);
        isTurnSettled = isTurnSettledAtPostEnd({ didPostCallsRun: true, didAwaitTurnResolver: shouldAwaitRes, isTurnLive });
        if (isTurnLive && willWrite) await applyPostBlocks(blocks, msg, mesId, ctx, resBlockNow, fenceSwipe);
    } catch (e) {
        log.error(`post-pass error (non-fatal):`, e);
        toastDegraded('MVU Helper — POST failed', 'The POST record pass crashed — nothing was recorded this turn (details in console).');
    } finally {
        // The reply's one write comes before the phase closes, so whatever waits for the turn to finish (a
        // host's busy indicator, galgame-companion's shaping) finds the reply written.
        try { if (turnEnd) await finishPostTurn(turnEnd, isTurnSettled); }
        catch (e) { log.error(`the turn's end failed for msg ${turnEnd && turnEnd.mesId} — its edits are in memory but not written:`, e); }
        finally {
            if (turnEnd) turnEnd.stopWarnings();
            endTurnPhase('post');
        }
    }
}

// The post-reply phase's clock (postPhaseTimings over this card's runnable POST calls): a warning halfway through
// each call's slot while the phase still runs, and the redraw record's deadline at the end of the last slot.
// Returns the record's options and the stop for the warnings, which the pass calls once its own work is done:
// after that the phase only waits for edits other stages announced, which is not POST being slow.
function startPostPhaseClock(mesId) {
    const elc = getExtraLlmCallsProfile();
    const { warnAtMs, deadlineMs } = postPhaseTimings({
        calls: elc.enabled ? enabledCallsForPhase(elc.calls, 'post') : [],
        isParallel: elc.parallel,
        callTimeoutMs: callTimeoutMs(),
    });
    let isPostWorkDone = false;
    const timers = warnAtMs.map((atMs) => setTimeout(() => warnSlowPostPhase(mesId, atMs, deadlineMs), atMs));
    return {
        redrawOptions: { deadlineMs, onDeadline: (report) => { if (!isPostWorkDone) reportPostDeadline(mesId, report); } },
        stopWarnings: () => {
            isPostWorkDone = true;
            for (const timer of timers) clearTimeout(timer);
        },
    };
}

// Halfway through a call's slot and the phase is still running: POST is slow, and the player hears it before the
// reply is written without it.
function warnSlowPostPhase(mesId, atMs, deadlineMs) {
    const seconds = Math.round(atMs / 1000);
    const deadline = Math.round(deadlineMs / 1000);
    log.child('POST').warn(`msg ${mesId}: the post-reply phase is still running after ${seconds}s — the reply is written at its ${deadline}s deadline (Call timeout × the longest chain of POST calls) if POST has not finished by then. The last [POST] line above shows where it is.`);
    toastDegraded('MVU Helper — POST slow', `The post-reply phase of message ${mesId} has run ${seconds}s. The reply is written at ${deadline}s if POST has not finished.`);
}

// The deadline with POST's own work still running: the reply's held edits are written without POST, and whatever
// POST adds later lands on its own. (Edits other stages announced and are still making are named by the reply
// redraw's own line.) No toast: the slow warning raised one already, and a call cut by its Call timeout raises
// "POST degraded".
function reportPostDeadline(mesId, { held, waitedMs }) {
    const seconds = Math.round(waitedMs / 1000);
    const writes = held.length ? `the reply's held edits (${held.join(', ')}) are written now` : 'no reply edit was waiting on it';
    log.child('POST').warn(`msg ${mesId}: the post-reply phase is still running at its ${seconds}s deadline — ${writes}, and whatever POST adds later is written on its own.`);
}

// The post-reply phase's end for its reply: the stat box refreshed from the turn's final state, then the
// reply redraw's one write for every edit the turn handed over (features/reply-redraw), once the edits other
// stages announced have landed. The box is refreshed only when the pass settled the turn (`isTurnSettled`: it
// waited for the turn's own work, and the turn was still live); otherwise the reply's stored state may not
// hold this turn's numbers yet, and the box RES1 placed, if any, stands.
async function finishPostTurn({ msg, mesId, fenceSwipe, redraw, stopWarnings }, isTurnSettled) {
    stopWarnings();
    if (isTurnSettled && isStatBoxDeclared()) {
        try {
            // RES1's save and a relay still running for this turn land before the box reads the state.
            await awaitTurnWork(mesId, fenceSwipe);
            if (isReplyRedrawLive(redraw)) {
                const before = String(msg.mes || '');
                msg.mes = composeStatBox(before, { mid: mesId, writer: 'turn end' });
                if (msg.mes !== before) await redrawReply(msg, mesId, 'stat box');
            }
        } catch (e) { log.child('POST').warn(`stat box: could not refresh it in msg ${mesId} (the turn's other edits are still written; the box shows RES1's numbers or none):`, e); }
    }
    await closeReplyRedraw(redraw);
}

// What a reply is owed when no POST call runs for it — the same two duties a pass with calls ends on, with
// no POST block beside them: RES1's audit carried into the reply, and the POST-done signal with no parse
// coming, which the plugin relay waits on (logic-engine notePostPhaseDone). When a turn resolver runs, this
// first waits for RES1 — its marker, then its whole run, save and reply-text edit included — because with
// no LLM call in between, this would otherwise reach the reply while RES1 is still editing it.
// Returns whether it settled the turn (isTurnSettledAtPostEnd).
async function finishWithoutPostCalls(ctx, msg, mesId, fenceEpoch, fenceSwipe) {
    const shouldAwaitRes = await awaitTurnOwnWork(ctx, mesId, fenceSwipe);
    // No call ran, so this reply has no POST outputs; the last pass's list would otherwise reach the
    // llm-task capture on the signal below as if it were this reply's.
    if (typeof globalThis !== 'undefined') {
        globalThis.mvuHelper = globalThis.mvuHelper || {};
        globalThis.mvuHelper.lastPost = [];
    }
    try { await eventSource.emit(POST_DONE_EVENT, mesId, false, false); } catch (e) { log.warn('POST-done signal emit failed (non-fatal):', e); }
    const resBlock = readResStaged(ctx, mesId, fenceSwipe);
    if (!resBlock && shouldAwaitRes && !readResMarkerDone(ctx, mesId, fenceSwipe)) {
        log.child('POST').warn(`RES stage marker not seen within ${RES_STAGE_TIMEOUT_MS}ms (msg ${mesId}) — ${RES_ABSENT_NOTE}`);
    }
    if (!resBlock && !shouldAwaitRes) return false;   // nothing to carry and nothing settled: no fence to check
    const isTurnLive = postTurnFenceHolds(ctx, mesId, fenceEpoch, fenceSwipe);
    if (isTurnLive && resBlock) {
        logStage('POST', `no POST call this reply · ${TURN_AUDIT_TAG} carried → writing`);
        await applyPostBlocks([], msg, mesId, ctx, resBlock, fenceSwipe);
    }
    return isTurnSettledAtPostEnd({ didPostCallsRun: false, didAwaitTurnResolver: shouldAwaitRes, isTurnLive });
}

// The turn's own work for a reply, when a turn resolver runs: RES1's marker, then its whole run — its save and
// its reply-text edit included. Returns whether it waited (a resolver runs).
async function awaitTurnOwnWork(ctx, mesId, fenceSwipe) {
    const shouldAwaitRes = isTurnResolverActiveNow();
    if (shouldAwaitRes) {
        await awaitResStaged(ctx, mesId, fenceSwipe, RES_STAGE_TIMEOUT_MS);
        await awaitTurnWork(mesId, fenceSwipe);
    }
    return shouldAwaitRes;
}

// Why a reply on an engine card has no <RES_Variable>: the wait only runs when a turn resolver runs.
const RES_ABSENT_NOTE = `no <${TURN_AUDIT_TAG}> for this turn. A game engine IS active (the wait only runs then), so RES did not finish this reply: look for its error or skip in the [logic-engine] [RES] lines above`;

// TURN FENCE (see generationEpoch), checked right before a POST write: the calls and the RES wait take
// seconds. If a newer generation started (next message → epoch bumped) or THIS reply was swiped away
// meanwhile, writing now would stamp a stale record and mis-target RES2's save into another message.
function postTurnFenceHolds(ctx, mesId, fenceEpoch, fenceSwipe) {
    const cur = ctx.chat[mesId];
    const swipedAway = !cur || cur.is_user || (cur.swipe_id != null ? cur.swipe_id : 0) !== fenceSwipe;
    if (generationEpoch === fenceEpoch && !swipedAway) return true;
    log.child('POST').warn(`turn advanced during POST (msg ${mesId}, swipe ${fenceSwipe}, epoch ${fenceEpoch}→${generationEpoch}) — POST adds nothing more to this reply (no receipt, no stat-box refresh), to avoid polluting another message's state`);
    return false;
}

// RELAY POST's <UpdateVariable> block(s) so the card's resolver (RES) sees them. POST emits RECORD-INTENT
// (e.g. /Intent/armClassmate); MVU must PARSE the block — its message-parse flow fires VARIABLE_UPDATE_ENDED,
// which RES listens to → RES reads the intent, produces the real state, then clears it (so POST's /Intent paths
// are TRANSIENT; the OUTCOME shows under the resolver's own [MVU resolver] log + the field RES writes).
//
// ⚠️ THE APPLY DOES NOT NEED THE MESSAGE. Two different things are easy to conflate here, so both are stated:
//   • APPLYING the ops + firing RES — done by handing MVU's own parse the BLOCK TEXT ALONE
//     (`parseMvuBlock(postBlocks…)` below, i.e. Mvu.parseMessage). That emits VARIABLE_UPDATE_ENDED, which is
//     what RES listens on. The direct variable API (setMvuVariable + replaceMvuData) is what is NOT enough:
//     verified against the bundle and live, it writes stat_data but emits only SINGLE_VARIABLE_UPDATED, so the
//     record sits UNCONSUMED (e.g. armClassmate stuck true).
//   • WRITING the block into msg.mes — a separate decision, and what it buys is: the player's receipt (the
//     card's Minimize* regexes collapse it for DISPLAY only) and MVU being able to rebuild state by re-parsing
//     the chat later. None of those is the apply. ⚠ Whether the block also reaches the narrate PROMPT is the
//     card's call (a prompt-only regex), and a card should hide it: a narrator shown past POST blocks writes
//     its own, and MVU applies a <JSONPatch> wherever it sits — a forged block can carry a POST-owned channel
//     into narrate's reply.
// So the text write is a product choice with three payoffs, not a mechanical requirement — worth knowing before
// anyone tries to make this lane stop touching msg.mes (see devdoc/editing-a-finished-reply.md §MVU1).
async function applyPostBlocks(blocks, msg, mesId, ctx, resBlock = '', fenceSwipe = 0) {
    try {
        const base = String(msg.mes || '');
        // Rename POST's own wrapper <UpdateVariable> → <POSTUpdateVariable> so it's regex-separable from narrate's
        // block in the card's display/context regexes. This is SAFE for MVU: verified against the live bundle, the
        // apply path scans the WHOLE message with matchAll(/<json_?patch>…<\/json_?patch>/gim) — it keys on the inner
        // <JSONPatch> tag, NOT the outer wrapper (only MVU's optional "extra-model" mode requires <UpdateVariable>).
        // The inner <JSONPatch> is untouched, so POST's ops still land (even on a narrate-emitted-nothing turn).
        const postBlocks = blocks.map(toPostWrapper);
        // Order: POST's own block first, then the card resolver's display-only <RES_Variable> LAST
        // (so the rendered order is narrate-UV → POST-UV → RES_Variable, all above the menu). Skip the RES block
        // if it's somehow already present (idempotent re-fire).
        const parts = [...postBlocks];
        if (resBlock && !base.includes(`<${TURN_AUDIT_TAG}>`)) parts.push(resBlock);
        // Do NOT delete the stash: the resolver keeps RES1's rich block there across its later (RES2) fire, the
        // mid-guard means next turn's RES1 replaces it, and the already-present check above makes a re-flush a
        // no-op. Just flag it written for traceability.
        // Guarded property write on the shared object — can't throw, so no catch needed. Match {mid,swipe}.
        if (ctx && ctx.chat && ctx.chat.__mvuResBlock && ctx.chat.__mvuResBlock.mid === mesId && ctx.chat.__mvuResBlock.swipe === fenceSwipe) ctx.chat.__mvuResBlock.written = true;
        const block = parts.join('\n\n');
        if (!block) return;                            // nothing to write (no POST block, RES block already present)
        // POST edits the FINISHED message text, so it can place its block ANYWHERE — running after narrate does NOT
        // force an append. Splice it in right AFTER narrate's own </UpdateVariable> so it sits with narrate's block
        // ABOVE the stat menu (not stranded below it). Without that block: above the reply's tail (the engine's end
        // text, else the menu placeholder), else appended at the end.
        // ⚠ FUNCTION replacement — see placePostRelayBlock: a replacement STRING expands `$&` and
        // friends, and `block` is model-authored. A function's return value is used literally.
        if (base.includes('</UpdateVariable>')) {
            msg.mes = base.replace('</UpdateVariable>', () => '</UpdateVariable>\n\n' + block);   // after narrate's first UV
        } else {
            msg.mes = placeAboveFirstAnchor(base, block, REPLY_TAIL_ANCHORS);
        }
        // APPLY POST's OWN ops to MVU and fire RES2. ⚠ MVU does NOT listen to MESSAGE_EDITED/MESSAGE_UPDATED (it
        // binds MESSAGE_RECEIVED/SENT/DELETED/CHAT_CHANGED/GENERATION_STARTED), so the edit events below only
        // refresh the DISPLAY. To LAND POST's ops AND fire MVU's update event, the block goes through MVU's own
        // parse (parseMvuBlock). Only the POST block(s), never msg.mes: parsing the whole message would re-apply
        // narrate's ops. The parse applies onto a copy, and the turn runner's fence+save persists it
        // (devdoc/dev-helper.md §1.6).
        let mvuApplied = false;
        try {
            const vars = msg.variables && msg.variables[(msg.swipe_id != null ? msg.swipe_id : 0)];
            if (postBlocks.length && vars && vars.stat_data) {
                // parseMvuBlock (sillytavern/mvu-bridge.js) — THE bookkeeper write path, shared with
                // the GameLogic Plugin relay lane. This call exists to APPLY + fire RES2, and the
                // turn runner's fence+save is what persists the clone MVU applied onto (which is how
                // these ops reach disk at all).
                const applied = await parseMvuBlock(postBlocks.join('\n\n'), vars, { writer: WRITER_POST });
                mvuApplied = true;
                // ── THE REFUSAL PROBE: POST's answer to "did my ops actually land".
                //
                // ⚠ THIS LANE STAYS ON PATH PRESENCE, alone among the four. The other three use
                // opsOutcomeAfterApply, which compares the stored VALUE — but this parse FIRES the
                // RES2 relay, and the relay rewrites paths before the clone comes back here. A value
                // comparison would therefore flag the game's own bookkeeper as a refusal on every
                // path it touched. Presence survives that rewrite; value does not. The dispatcher,
                // the plugin relay and the PRE sim all run suppressed, so nothing rewrites behind
                // them and they can afford the sharper check.
                //
                // WHY IT EARNS ITS LINES: the card's Zod refuses a bad op alone and the rest lands, and
                // without this the ONLY signal is mvu_zod's own toast ("可能需要重Roll"), which is not
                // ours, not greppable, and says nothing about which lane wrote it.
                //
                // ⚠ IT DOES NOT CATCH A REVERTED TUPLE INSERT — stated because a probe believed to cover
                // more than it does is worse than none. `add` at a TUPLE index INSERTS (e.g.
                //   {"op":"add","path":"/Intent/armClassmate/0","value":true}
                // where the prompt prints `replace`), the tuple overruns its declared length, and the
                // card's Zod refuses that op alone. This asks "does the path EXIST", so it catches a
                // new key on a closed root; a REVERTED tuple insert leaves the path present (index 0
                // still reads `false`), so it reads as landed. Catching that needs the SENT VALUE
                // compared against the stored one, which is not safe here: the relay fired by this
                // very parse can legitimately overwrite a path afterwards (the lane probe's engine
                // rewrites World.Weather after POST wrote it), and the clone this reads IS the one
                // the relay mutated — so a value check would report the game's own bookkeeper as a
                // refusal. Left undetected and SAID, not guessed at.
                //
                // ⚠ THIS IS THE COMPLEMENT OF ctx.ops, NOT A DUPLICATE OF IT. `ops` is a diff of what
                // LANDED, so a refused op is exactly what it can never contain. Detection of a
                // refusal has to happen here, against the block we sent.
                // DETECTION ONLY — never a repair, never a retry: the op was the model's to get
                // right, and re-issuing it with a verb we guessed would be this host inventing state.
                const probe = postOpsRefused(postBlocks, applied);
                if (probe.allRefused) {
                    log.child('POST').warn(`MVU applied NONE of the ${probe.sent} op(s) in this reply's POST block(s) — every one was refused, or MVU is unavailable`);
                } else if (probe.refused.length) {
                    log.child('POST').warn(`${probe.refused.length}/${probe.sent} op path(s) ABSENT after the apply — the path does not exist, so the card's Zod refused the op (commonest cause: a new key on a closed root). Nothing was retried: ${probe.refused.join(', ')}`);
                }
            }
        } catch (e) { log.error('POST parseMvuBlock (apply + RES2) failed:', e); }
        // WAIT FOR THE RUN THAT PARSE STARTED. The parse emits ENDED; the turn runner's handler runs the
        // RES2/relay half on it VOID, so the parse settles while that half — and its own nested ENDED emit,
        // walking every listener, this reply's iframe included — is still running. The relay's audit block
        // exists only once that half ran, so this wait is what lands the relay's ops and its audit block in
        // the SAME reply, on both lanes. It also keeps the turn's write (the reply redraw, when this pass
        // ends) off that emit: rebuilding this reply's DOM (updateMessageBlock) under it destroys the iframe
        // whose async listener the emit is awaiting, and that parse never settles again — the relay lane
        // hangs, its writer frame and suppression depth leak, and every later parse reads as an echo.
        if (mvuApplied) await awaitTurnWork(mesId, fenceSwipe);
        // THE POST-RELAY AUDIT BLOCK. The parse above is what fires the relay, so only NOW does the
        // engine's second audit block exist — RES1's was written minutes of pipeline earlier, above.
        // Without this the message ends on RES1's numbers while state carries the relay's, which is the
        // worst shape a receipt can take: not absent, but confidently out of date.
        // The block arrives wrapped in mvu-helper's own tag (the turn runner wrapped the engine's body);
        // its contents are the engine's and are never read here.
        let relayAppended = false;
        try {
            if (mvuApplied) {
                const relayBlock = readPostRelayStaged(ctx, mesId, fenceSwipe);
                if (relayBlock) {
                    // Anchor it to the RES1 receipt carried into this same message, so the two land together
                    // and ABOVE the stat menu. That receipt's tag is mvu-helper's own (TURN_AUDIT_TAG).
                    const next = placePostRelayBlock(msg.mes, relayBlock, `</${TURN_AUDIT_TAG}>`, REPLY_TAIL_ANCHORS);
                    relayAppended = next !== String(msg.mes || '');
                    msg.mes = next;
                }
            }
            // Consume the marker — one left standing would be re-appended to the NEXT message that
            // happens to share this {mid,swipe} after a delete/regen.
            const staged = ctx && ctx.chat && ctx.chat.__mvuPostRelayBlock;
            if (staged && staged.mid === mesId && staged.swipe === fenceSwipe) ctx.chat.__mvuPostRelayBlock = null;
        } catch (e) { log.warn(`RES2 audit block: could not append it to msg ${mesId} (state is still resolved; only the receipt is missing):`, e); }
        // The receipt above (and the relay block) moved `mes` only. The reply redraw mirrors it into this
        // swipe's stored copy now (without that, swiping away and back loses the receipt: `mes` carries
        // <RES_Variable>, the swipe's stored text does not) and writes it with the turn's other edits when
        // the pass ends, after the stat box is refreshed (finishPostTurn). That write announces itself with
        // MESSAGE_UPDATED; MESSAGE_EDITED is never emitted, since SillyTavern answers it with a whole-prompt rebuild.
        await redrawReply(msg, mesId, 'POST receipt');
        logStage('POST',
            `applied ${blocks.length} POST block(s)${resBlock ? ` + ${TURN_AUDIT_TAG}` : ''}${mvuApplied ? ' + Mvu.parseMessage→RES2' : ''}${relayAppended ? ' + the relay\'s own audit block' : ''} (msg ${mesId})`);
    } catch (e) {
        log.error(`POST apply (message-edit) failed:`, e);
    }
}

// Fire the POST pass after each received (AI) message. FIRE-AND-FORGET (do NOT return the promise):
// ST's eventSource.emit AWAITS each listener sequentially, and MVU's own MESSAGE_RECEIVED handler (which parses
// the narrator's <UpdateVariable> and writes stat_data) is a peer listener. If we returned runPostPass's promise,
// the emit would block on our ~2s LLM call before MVU could process the message — delaying (and able to
// dead-lock) MVU's native parse. Returning undefined lets the emit advance to MVU immediately; MVU processes
// the narrator's reply natively while POST runs its LLM in the background, then POST's message-edit re-parse
// applies the record-Intent.
if (eventSource && event_types && event_types.MESSAGE_RECEIVED) {
    // The reply's redraw record, first in line (openTurnRecordFirst). Without makeFirst the POST pass opens it
    // in its own listener, and an edit made by a listener ahead of that one is written on its own.
    if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(event_types.MESSAGE_RECEIVED, openTurnRecordFirst);
    else log.child('POST').warn('eventSource.makeFirst is unavailable — the reply\'s redraw record opens in the POST pass\'s own listener, so an edit made by a MESSAGE_RECEIVED listener ahead of it is written on its own.');
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        const armed = awaitingGeneratedReply;
        awaitingGeneratedReply = false;                // consume — one arm covers exactly one received reply
        if (!armed) {                                  // greeting on new-chat / import — nothing was generated
            log.child('POST').lifecycle('skipped — MESSAGE_RECEIVED without a generation this turn (greeting/import)');
            return;
        }
        // (Sim patches apply at PRE time, inside the interceptor — there is nothing state-side to
        // order against here; a [POST] EJS block rendering a sim's state sees post-apply state via
        // normal floor inheritance.) Fire-and-forget: the emit chain (MVU's native parse is a peer
        // listener) must not block on us.
        void runPostPass(messageId);
    });
}
// Track a user STOP so the POST pass skips the partial reply (see `generationStopped`). STOPPED is set
// when the user aborts; STARTED clears it at the top of each real (non-dry-run) generation.
if (eventSource && event_types) {
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, () => { generationStopped = true; });
    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) { generationStopped = false; generationEpoch++; awaitingGeneratedReply = true; } });
    // Undo-store hygiene: message ids restart per chat, so chat A's undo record put back onto
    // chat B's same-numbered floor would be corruption, not drift. Clear wholesale on switch.
    // The POST arm goes with them, for the same reason and a second one: an abort that never reaches
    // MESSAGE_RECEIVED leaves the arm SET, and the next chat's greeting would then consume it and
    // run POST on a greeting — precisely what the arm's own guard exists to prevent. An arm raised
    // in another chat can never be valid here, so it is dropped rather than carried.
    if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, () => { awaitingGeneratedReply = false; });
}

// Register the global named in manifest.json `generate_interceptor`.
if (typeof globalThis !== 'undefined') {
    globalThis.mvuHelperInterceptor = mvuHelperInterceptor;
    // Debug handle for live testing from the browser console / Chrome DevTools MCP. Not read-only:
    // runLlmCall makes a real model call through a connection profile, and runPostPass runs POST, which
    // writes into the reply. As a page global it also reaches ST-Prompt-Template's templates
    // (devdoc/security-hardening.md §6).
    globalThis.mvuHelper = Object.assign(globalThis.mvuHelper || {}, {
        collectLorebookBlock,
        runLlmCall,
        mvuHelperInterceptor,
        runPostPass,
        _getPrimaryLorebookEntries: getPrimaryLorebookEntries,
    });
}
