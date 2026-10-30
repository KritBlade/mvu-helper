// llm-task-router/llm-task-router.js — the generic LLM-task router (glue half; the pure logic lives in
// llm-task-router-core.js). Developer API: devdoc/dev-helper.md §6.3.
//
// A FEATURE registers a task: "run this instruction on a user-chosen call, hand me its output." The
// router owns ROUTING (which call), INJECTION and CAPTURE (read the chosen call's output on its
// done-signal). The feature owns its instruction text, its `<tag>` NAME, and its output parser
// (onOutput). Image generation's look task (`imagegen-charimg`) is its client; the router itself is
// feature-agnostic.
//
// Injection per target:
//   • narrate → no lorebook entry: the instruction is pushed into the main prompt at
//     CHAT_COMPLETION_PROMPT_READY (onPromptReady).
//   • PRE*/POST* → a disabled data-carrier entry whose comment starts with `[callName]`, so
//     extraLlmCalls.collectLorebookBlock pulls it into that call's system block.
// Capture reads the matching output on the phase's done-signal (MESSAGE_RECEIVED for narrate,
// POST_DONE_EVENT for POST, PRE_DONE_EVENT for PRE).

import { eventSource, event_types } from '../../../../../../../script.js';
import { getContext } from '../../../../../../extensions.js';
import { createModuleLog } from '../../sillytavern/log.js';
import {
    NARRATE_TARGET, POST_DONE_EVENT, PRE_DONE_EVENT, taskNeedle, taskEntryBody, buildTaskEntryFields,
    taskInstructionToken, resolveTargetPhase, listTaskTargets, isTargetAvailable, runTargetOf, createKeyedQueue,
} from './llm-task-router-core.js';
import { upsertLorebookEntryFields, deleteLorebookEntriesByNeedle, hasActiveCharacter } from '../../sillytavern/lorebook.js';
import { expandPromptMacros } from '../../sillytavern/prompt-macros.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { selectOption } from '../settings-panel/index.js';
import { announceReplyEdit } from '../reply-redraw/index.js';

const log = createModuleLog('llm-task-router');

// taskId → spec. A spec: { id, label, tag, allow:[phase…], instruction:str|fn({phase, messageId}), getTarget,
// setTarget, getActiveTarget?, onOutput, isActive?, offersOff?, shapeInput? }. A function instruction is given the phase of the call that
// will carry it and the message that call is about (null for narrate, whose reply does not exist yet), so a
// task can word its duty for that call and that turn. getTarget returns the STORED preference (what the
// dropdown shows). getActiveTarget, when given, is the target the task runs on this turn — a feature whose
// task runs on a target the user did not pick (a default) supplies it; without it the stored preference is
// the target. isActive() is the feature's own gate — when false the task is dormant: no entry is injected and
// captures are ignored, but the preference persists so re-enabling restores it. offersOff: false for a task its
// feature turns off with a setting of its own; its picker then lists no Off. shapeInput({ text, phase, messageId,
// callName }), when given, returns the text the call carrying the task reads instead (shapeRoutedCallInput).
// offers(target), when given, says whether the picker lists that target this time — a feature rule about which of its
// settings go together; the stored value is always listed, and routing is never affected.
const REGISTRY = new Map();

// taskId → the mount renderLlmTaskSelect was last given (a selector string or an element), so
// refreshTaskTargets can repaint a task's picker without the router being told where it lives twice.
// The mount is stored AS PASSED and re-resolved through jQuery on every render, so a selector keeps
// working across a panel rebuild that replaced the original node.
const MOUNTS = new Map();

// WHERE THE PRE/POST TARGET LIST COMES FROM — injected, not imported.
//
// This router is feature-agnostic: it knows a task wants "some PRE/POST call", not which feature
// defines calls. Importing the call list from the feature that owns it would be a library reaching
// UP into a feature — the direction the folder rules forbid, and a blocker on reusing this router.
// The composition root (index.js) knows both sides, so it supplies the list.
//
// The default returns [], so a router used before wiring degrades to "Off is the only option".
let taskTargetSource = () => [];

/** Provide the ENABLED squad calls the dropdown/routing may choose from. Called once, at init. */
export function setTaskTargetSource(fn) {
    if (typeof fn === 'function') taskTargetSource = fn;
}

// The active card's ENABLED squad calls (the dropdown's PRE/POST options + capture routing).
function activeEnabledCalls() {
    try { return taskTargetSource() || []; }
    catch (e) { log.warn('the task-target source threw — treating as no targets:', e); return []; }
}

// The task's own gate; a throwing isActive is treated as inactive (fail-safe: no injection/capture).
function safeIsActive(task) {
    try { return task.isActive() !== false; }
    catch (e) { log.warn(`llm-task "${task.id}" isActive() threw — treating as inactive:`, e); return false; }
}

// The target a task runs on this turn ('' = nowhere) — runTargetOf decides. Every routing decision reads
// this; only the picker shows getTarget. A throwing target reads as Off.
function activeTargetOf(task) {
    try { return runTargetOf({ stored: task.getTarget(), active: task.getActiveTarget ? task.getActiveTarget() : undefined }); }
    catch (e) { log.warn(`llm-task "${task.id}": its target could not be read — treated as Off:`, e); return ''; }
}

// Resolve a task's instruction (string or sync/async fn) to its final text for the call of `phase`,
// about message `messageId`, its SillyTavern macros ({{user}} …) expanded: neither of the router's ways in (the narrate
// push at prompt-ready, a PRE/POST call's {{mvuhelper::task::<id>}} token) passes through SillyTavern's own expansion.
async function resolveInstruction(task, phase, messageId = null) {
    const v = typeof task.instruction === 'function' ? task.instruction({ phase, messageId }) : task.instruction;
    return expandPromptMacros(String((await Promise.resolve(v)) || '').trim(), 'llm-task-router');
}

// The instruction text of every ACTIVE task routed to a call of `phase` ('pre' | 'post'), keyed by task id,
// for the call-input macro `{{mvuhelper::task::<id>}}` its routing entry carries. The PRE/POST pass calls
// this once per pass, before its calls run. A task whose instruction throws is left out and warned — its
// token then resolves empty, which the macro trace prints.
export async function resolveRoutedTaskInstructions(phase, messageId = null) {
    const calls = activeEnabledCalls();
    const out = {};
    for (const task of REGISTRY.values()) {
        if (!safeIsActive(task)) continue;
        const target = activeTargetOf(task);
        if (!target || resolveTargetPhase(target, calls) !== phase) continue;
        try { out[task.id] = await resolveInstruction(task, phase, messageId); }
        catch (e) { log.warn(`llm-task "${task.id}": instruction for ${phase} msg ${messageId} failed — its token resolves empty:`, e); }
    }
    return out;
}

// Does the task's target answer now: narrate, or a call in the target list (enabled, with a connection profile, while
// Extra LLM Calls is on)? A feature asks this to say why its task's output never comes. False for an unknown task and
// for Off.
export function isTaskTargetAvailable(taskId) {
    const task = REGISTRY.get(String(taskId || '').trim());
    if (!task) return false;
    const target = activeTargetOf(task);
    return !!target && isTargetAvailable(target, task.allow, activeEnabledCalls());
}

// The text a PRE/POST call reads, shaped by every ACTIVE task routed to that call that shapes its input (spec
// shapeInput) — the picture task numbers the reply's lines and closes them with its <picture_count>. The call
// applies this right after its own input filter, for that call only. A shaping that throws is warned, and the call
// reads the text as it was.
export function shapeRoutedCallInput(callName, text, { phase, messageId = null } = {}) {
    let out = String(text == null ? '' : text);
    const name = String(callName || '').trim();
    if (!name || (phase !== 'pre' && phase !== 'post')) return out;
    const calls = activeEnabledCalls();
    for (const task of REGISTRY.values()) {
        if (!task.shapeInput || !safeIsActive(task)) continue;
        const target = activeTargetOf(task);
        if (target !== name || resolveTargetPhase(target, calls) !== phase) continue;
        try { out = String(task.shapeInput({ text: out, phase, messageId, callName: name })); }
        catch (e) { log.warn(`llm-task "${task.id}": shaping what ${name} reads failed — it reads the text unshaped:`, e); }
    }
    return out;
}

// Register (or replace) a task. Idempotent — safe to call on every extension init; does NOT
// write to the lorebook (the book may not be ready at init). Call applyTaskRouting to sync the
// entry once a card/book is live (on dropdown change and when the settings panel refreshes).
export function registerLlmTask(spec) {
    const id = String(spec && spec.id || '').trim();
    if (!id) { log.child('registerLlmTask').warn('missing id — ignored'); return; }
    if (typeof spec.getTarget !== 'function' || typeof spec.setTarget !== 'function') {
        log.warn(`registerLlmTask("${id}"): getTarget/setTarget required — ignored`); return;
    }
    REGISTRY.set(id, {
        id,
        label: String(spec.label || id),
        tag: String(spec.tag || '').trim(),
        allow: Array.isArray(spec.allow) ? spec.allow.slice() : [NARRATE_TARGET],
        instruction: spec.instruction,
        getTarget: spec.getTarget,
        setTarget: spec.setTarget,
        getActiveTarget: typeof spec.getActiveTarget === 'function' ? spec.getActiveTarget : null,
        onOutput: typeof spec.onOutput === 'function' ? spec.onOutput : () => {},
        isActive: typeof spec.isActive === 'function' ? spec.isActive : () => true,
        offersOff: spec.offersOff !== false,
        shapeInput: typeof spec.shapeInput === 'function' ? spec.shapeInput : null,
        offers: typeof spec.offers === 'function' ? spec.offers : () => true,
    });
    log.domain('smallllm', 'lifecycle', `registered "${id}" (tag=${spec.tag || 'none'}, allow=[${(spec.allow || []).join(', ')}])`);
}

// Reconcile the lorebook routing for a task with the target it runs on this turn. Runs for one task are
// queued, one at a time (createKeyedQueue says why); the promise resolves to the applied target ('' when cleared).
const enqueueRouting = createKeyedQueue();
export function applyTaskRouting(taskId) {
    const id = String(taskId || '').trim();
    return enqueueRouting(id, () => syncRoutingEntry(id));
}

// One routing write. The two phases differ:
//   • narrate → NO WI entry. The contract is injected programmatically into the main reply at
//     CHAT_COMPLETION_PROMPT_READY (see onPromptReady). An enabled/constant WI entry would change
//     *active* World Info, making SillyTavern refresh WI and re-run the card's EJS pipeline on every
//     write/turn (a settings click alone would start the squad out-of-band). A programmatic push
//     touches only the narrator's prompt and writes nothing, so no churn.
//   • PRE*/POST* → a single disabled data-carrier entry (enabled:false → inactive, no WI refresh),
//     read by extraLlmCalls via its `[callName]` comment tag.
// Off / unavailable / narrate all ensure NO entry exists (delete any prior one). Keyed by the task's
// `mvu-llm-task:<id>` needle. Returns the applied target ('' when cleared). With no card open (the lobby) there is no
// card book to route into, so nothing is written; the next card's chat load re-applies every task.
async function syncRoutingEntry(taskId) {
    const task = REGISTRY.get(String(taskId || '').trim());
    if (!task) { log.child('applyTaskRouting').warn(`unknown task "${taskId}"`); return ''; }
    if (!hasActiveCharacter()) return '';
    const active = safeIsActive(task);
    const target = active ? activeTargetOf(task) : '';
    const needle = taskNeedle(task.id);
    const phase = resolveTargetPhase(target, activeEnabledCalls());
    const available = target && isTargetAvailable(target, task.allow, activeEnabledCalls());

    // narrate (programmatic), Off, or an unavailable target → make sure no WI entry lingers.
    if (!available || phase === NARRATE_TARGET) {
        const removed = await deleteLorebookEntriesByNeedle(needle);
        if (phase === NARRATE_TARGET) log.lifecycle(`llm-task "${task.id}": routed to narrate (programmatic inject at prompt-ready; no WI entry)`);
        else if (target && !available) log.lifecycle(`llm-task "${task.id}": target "${target}" unavailable — routing cleared`);
        else if (removed) log.domain('smallllm', 'lifecycle', `llm-task "${task.id}": routing entry removed (Off)`);
        return phase === NARRATE_TARGET ? NARRATE_TARGET : '';
    }

    // PRE/POST → the disabled data-carrier entry. It carries the task's TOKEN, never its text: the entry is
    // written here, once, so a copy of the text would be frozen at routing time; the call resolves the token
    // to this turn's instruction (resolveRoutedTaskInstructions).
    const fields = buildTaskEntryFields({ taskId: task.id, target, tag: task.tag, instruction: taskInstructionToken(task.id) });
    const res = await upsertLorebookEntryFields(needle, fields);
    if (!res) { log.warn(`llm-task "${task.id}": routing entry write failed (no primary lorebook?) — target "${target}" not wired`); return ''; }
    log.lifecycle(`llm-task "${task.id}": routed to ${target} (${res.created ? 'created' : 'updated'} data-carrier "${fields.comment}")`);
    return target;
}

// ── capture ──────────────────────────────────────────────────────────────────
// Hand a chosen call's raw output to the task's onOutput. Guarded per-task so one bad parser
// never breaks another task's capture (or the host event handler).
async function deliver(task, rawText, meta) {
    try { await Promise.resolve(task.onOutput(String(rawText || ''), meta)); }
    catch (e) { log.error(`llm-task "${task.id}" onOutput failed:`, e); }
}

// narrate INJECTION: push each narrate-routed task's contract into the main reply's prompt as a
// system message — the programmatic path used instead of a WI entry (no World Info churn). Fires only
// for the main chat completion; extraLlmCalls's PRE/POST calls use their own request path and don't emit
// this event, so the contract reaches only the narrator.
async function onPromptReady(eventData) {
    if (!eventData || !Array.isArray(eventData.chat)) return;
    const calls = activeEnabledCalls();
    for (const task of REGISTRY.values()) {
        if (!safeIsActive(task)) continue;
        const target = activeTargetOf(task);
        if (resolveTargetPhase(target, calls) !== NARRATE_TARGET) continue;
        const body = taskEntryBody(task.tag, await resolveInstruction(task, NARRATE_TARGET));
        if (!body) continue;
        eventData.chat.push({ role: 'system', content: body });
        log.domain('smallllm', 'verbose', `llm-task "${task.id}": injected narrate contract (${body.length} chars)`);
    }
}

// narrate capture: the reply text is the output. Fires for every task currently routed to narrate.
// A task's onOutput may edit the reply, so the capture is announced to the reply redraw before its first
// await: the turn's one write waits for it.
async function onMessageReceived(messageId) {
    const calls = activeEnabledCalls();
    let msg;
    // EXPECTED: the message can be gone by the time this fires (deleted or swiped mid-generation) and
    // `chat` is not guaranteed to exist yet on a cold load. null is exactly what the guard below wants.
    try { msg = getContext().chat[messageId]; } catch (_e) { msg = null; }
    if (!msg || msg.is_user) return;
    const routed = [...REGISTRY.values()]
        .filter((task) => safeIsActive(task))
        .map((task) => ({ task, target: activeTargetOf(task) }))
        .filter(({ target }) => resolveTargetPhase(target, calls) === NARRATE_TARGET);
    if (!routed.length) return;
    const capture = (async () => {
        for (const { task, target } of routed) await deliver(task, msg.mes, { phase: NARRATE_TARGET, target, messageId });
    })();
    announceReplyEdit(msg, Number(messageId), { label: `llm-task narrate capture (${routed.map(({ task }) => task.id).join(', ')})`, work: capture, allowanceMs: NARRATE_CAPTURE_WAIT_MS });
    await capture;
}

// How long the turn's write waits for the narrate capture: a task's onOutput stores what the reply says
// (registry writes), which takes moments.
const NARRATE_CAPTURE_WAIT_MS = 10_000;

// POST capture: read the chosen call's output from lastPost (populated just before POST_DONE_EVENT).
async function onPostDone(messageId) {
    const calls = activeEnabledCalls();
    const outputs = (typeof globalThis !== 'undefined' && globalThis.mvuHelper && globalThis.mvuHelper.lastPost) || [];
    for (const task of REGISTRY.values()) {
        if (!safeIsActive(task)) continue;
        const target = activeTargetOf(task);
        if (resolveTargetPhase(target, calls) !== 'post') continue;
        const rec = outputs.find((o) => String(o && o.name || '') === target);
        if (!rec) { log.domain('smallllm', 'verbose', `llm-task "${task.id}": POST target "${target}" produced no output record this turn`); continue; }
        await deliver(task, rec.output, { phase: 'post', target, messageId });
    }
}

// PRE capture: read the chosen call's output from lastPre (populated just before PRE_DONE_EVENT).
// Mirrors onPostDone; `messageId` here is the user-message index PRE read (no reply exists yet).
async function onPreDone(messageId) {
    const calls = activeEnabledCalls();
    const outputs = (typeof globalThis !== 'undefined' && globalThis.mvuHelper && globalThis.mvuHelper.lastPre) || [];
    for (const task of REGISTRY.values()) {
        if (!safeIsActive(task)) continue;
        const target = activeTargetOf(task);
        if (resolveTargetPhase(target, calls) !== 'pre') continue;
        const rec = outputs.find((o) => String(o && o.name || '') === target);
        if (!rec) { log.domain('smallllm', 'verbose', `llm-task "${task.id}": PRE target "${target}" produced no output record this turn`); continue; }
        await deliver(task, rec.output, { phase: 'pre', target, messageId });
    }
}

let wired = false;
// Subscribe the capture handlers ONCE (idempotent). Call from extension init.
export function initLlmTaskRouter() {
    if (wired) return;
    wired = true;
    if (eventSource && event_types && event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);   // narrate injection
    }
    if (eventSource && event_types && event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);           // narrate capture
    }
    if (eventSource) eventSource.on(POST_DONE_EVENT, onPostDone);                  // POST capture
    if (eventSource) eventSource.on(PRE_DONE_EVENT, onPreDone);                    // PRE capture
    log.domain('smallllm', 'lifecycle', 'handlers wired (narrate inject + narrate/PRE/POST capture)');
}

// ── dropdown ─────────────────────────────────────────────────────────────────
// Populate a task's target picker: `mountEl` is a static <select> in the panel (a selector or the element),
// like Harvest via on the Roster tab. Options are refreshed in place ONLY when the set actually changes (a POST
// call added/removed), and the value is set only when it differs. That is what stops an OPEN native dropdown
// from snapping shut — a call from updateImageUI (card change / save) that changes nothing touches no DOM. The
// `change` handler is bound ONCE. On change it persists via setTarget + re-applies routing; a stored-but-invalid
// target shows as an "unavailable" option so the user sees + can correct it.
export function renderLlmTaskSelect(taskId, mountEl) {
    const task = REGISTRY.get(String(taskId || '').trim());
    const $ = (typeof globalThis !== 'undefined' && globalThis.jQuery) || (typeof window !== 'undefined' && window.jQuery);
    if (!task || !$ || !mountEl) return;
    MOUNTS.set(task.id, mountEl);   // remembered for refreshTaskTargets (see below)
    const $sel = $(mountEl);
    if (!$sel.length) return;
    if (!$sel.is('select')) {
        log.warn(`llm-task "${task.id}": its picker must be a <select> — nothing painted`);
        return;
    }
    // Bind the change handler exactly once (survives every later in-place refresh).
    if (!$sel.data('mvuhTaskBound')) {
        $sel.data('mvuhTaskBound', true).data('mvuhTaskId', task.id);
        $sel.on('change', async function () {
            const t = REGISTRY.get($(this).data('mvuhTaskId'));
            if (!t) return;
            const val = String($(this).val() || '');
            try { t.setTarget(val); } catch (e) { log.error(`llm-task "${t.id}" setTarget failed:`, e); }
            await applyTaskRouting(t.id);
        });
    }

    const current = String(task.getTarget() || '').trim();
    const opts = listTaskTargets(task.allow, activeEnabledCalls(), { offersOff: task.offersOff })
        .filter((o) => o.value === current || isOfferedByTask(task, o.value));
    const stale = current && !opts.some((o) => o.value === current);
    const all = opts.concat(stale ? [{ value: current, label: `${current} (unavailable)` }] : []);
    const sig = all.map((o) => `${o.value}${o.label}`).join('');

    // Refresh <option>s IN PLACE only when the set changed (rebuilding options can close an open list), then
    // translate the new options' fixed words.
    if ($sel.attr('data-sig') !== sig) {
        $sel.attr('data-sig', sig).html(all.map(taskTargetOption).join(''));
        void applyHelperLocale();
    }
    if (String($sel.val()) !== current) $sel.val(current);
}

// The task's own rule for which targets its picker lists (spec offers); a throwing rule lists the target.
function isOfferedByTask(task, target) {
    try { return task.offers(target) !== false; }
    catch (e) { log.warn(`llm-task "${task.id}": its offers() rule threw — "${target}" is listed:`, e); return true; }
}

// Off (phase null) and narrate are fixed words, keyed for translation; a call's option — and a stored target that
// no longer answers (no phase) — shows its label as written.
function taskTargetOption(target) {
    if (target.phase === null) return selectOption({ value: '', text: 'Off' });
    if (target.phase === NARRATE_TARGET) return selectOption({ value: NARRATE_TARGET, text: 'narrate (main reply)' });
    return selectOption({ value: target.value, name: target.label });
}

// Re-sync EVERY registered task after the available targets changed (a call added, deleted,
// renamed, enabled/disabled, or switched PRE↔POST). The call list lives in another feature, so the
// router cannot observe those edits itself — that feature calls this.
//
// BOTH HALVES: the picker must list the new set at once (its owner's tab refresh, updateImageUI, runs
// on no call-list edit), and the routing must follow — a target is stored by call NAME, so renaming,
// deleting or disabling the chosen call leaves `getTarget()` pointing at a call that no longer
// answers, with its `[oldName]` data-carrier entry still in the book and the task delivering its
// contract nowhere.
//
// Routing FIRST, then the repaint: applyTaskRouting is what clears a now-unavailable target and
// deletes its stale entry, and the select must paint the state that survived that, not the one
// before it. renderLlmTaskSelect is a no-op when the option set and value are unchanged (data-sig),
// so calling this on every list edit is cheap.
export async function refreshTaskTargets() {
    for (const task of REGISTRY.values()) {
        await applyTaskRouting(task.id);
        const mount = MOUNTS.get(task.id);
        if (mount) renderLlmTaskSelect(task.id, mount);
    }
}

// The ACTIVE task (id) currently routed to `callName`, or '' when no task claims it. The POST/PRE
// passes use this to keep their output-contract diagnostics honest: a task-routed call's output is
// the TASK's payload (e.g. the registration's cast records), not an <UpdateVariable> patch, so a
// "contract violated, nothing recorded" warning on it would be a false alarm every turn — printed
// beside the harvest storing characters from that very output. Known trade: a call serving BOTH a
// task and variable updates loses the prose warning; the gated decision line ("POST n block(s)")
// still reports what landed.
export function taskTargetOf(callName) {
    const name = String(callName || '').trim();
    if (!name) return '';
    for (const task of REGISTRY.values()) {
        if (safeIsActive(task) && activeTargetOf(task) === name) return task.id;
    }
    return '';
}

