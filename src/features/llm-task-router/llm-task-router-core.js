// llm-task-router/llm-task-router-core.js — PURE, dependency-free logic for the generic LLM-task router.
// No imports, no ST/globals: unit-tested directly (tests/llm-task-router-core.test.js). The I/O glue
// (lorebook write, capture wiring, the dropdown DOM) lives in llm-task-router/llm-task-router.js and
// delegates here.
//
// A "task" = an instruction some user-chosen call runs, whose output is handed back to the
// registering feature. A PRE*/POST* target is routed by one data-carrier entry per (task, target)
// (enabled:false) whose comment starts with `[callName]`, so extraLlmCalls's collectLorebookBlock pulls
// it into that call's system block; its body wraps taskInstructionToken in the feature-supplied
// `<tag>…</tag>`, and the call resolves the token to the instruction per turn. A narrate target writes
// no entry: the glue pushes the instruction into the main prompt directly.

// The stable, findable marker embedded in EVERY routing entry's comment. Matching on it
// (case-insensitive substring) locates + deletes a task's entry regardless of its current target.
export const TASK_NEEDLE_PREFIX = 'mvu-llm-task:';

// The narrate pseudo-target — not a real extraLlmCalls call, but a valid routing destination
// (the main reply). PRE*/POST* targets are the call's own `name`.
export const NARRATE_TARGET = 'narrate';

// The ALWAYS-FIRE POST-done signal (a custom eventSource event). extraLlmCalls emits it after EVERY POST pass
// once globalThis.mvuHelper.lastPost is populated — unlike MESSAGE_UPDATED, it fires even on a task-only
// POST call that wrote no <UpdateVariable>. The router listens here to capture POST-target task outputs.
export const POST_DONE_EVENT = 'mvuhelper:post-done';

// PRE-done: emitted by the interceptor (mvuHelperInterceptor) after every PRE pass, once
// globalThis.mvuHelper.lastPre holds the calls' raw outputs. Mirrors POST_DONE_EVENT so the router
// captures PRE-target task outputs the same way. Fires every PRE pass, even when a call emitted nothing.
export const PRE_DONE_EVENT = 'mvuhelper:pre-done';

// The findable needle for a task id (case-insensitive substring of the entry comment).
export function taskNeedle(taskId) {
    return `${TASK_NEEDLE_PREFIX}${String(taskId || '').trim()}`;
}

// Is a lorebook entry, by its name (its comment), a task's routing entry? Every one carries TASK_NEEDLE_PREFIX
// (taskEntryComment), matched case-insensitively like the needle searches that find and delete them.
export function isTaskRoutingEntryName(name) {
    return String(name || '').toLowerCase().includes(TASK_NEEDLE_PREFIX);
}

// What a call target's routing entry carries instead of the instruction text: a call-input macro the
// PRE/POST pass resolves when it runs the call (small-llm call-input-macros-core, token `task`). The
// entry is written once, at routing time, so a copy of the text would be frozen there; the token lets a
// task word its instruction per turn, from the message the call is about.
export function taskInstructionToken(taskId) {
    return `{{mvuhelper::task::${String(taskId || '').trim()}}}`;
}

// The routing entry's comment: it starts with `[callName]`, so loreEntryMatchesCall (extra-llm-calls-core)
// routes it to that call. Only a PRE/POST call target has an entry; a narrate target has none (the router
// injects its instruction at prompt-ready), so asking for one is a caller bug and throws.
export function taskEntryComment(taskId, target) {
    const t = String(target || '').trim();
    if (!t || t === NARRATE_TARGET) throw new Error('taskEntryComment: a narrate target has no routing entry');
    return `[${t}] ${taskNeedle(String(taskId || '').trim())}`;
}

// The routing entry's body: the feature's instruction wrapped in its `<tag>…</tag>`.
// Blank tag → the instruction is emitted bare (the feature opted out of a wrapper).
export function taskEntryBody(tag, instruction) {
    const body = String(instruction == null ? '' : instruction).trim();
    const name = String(tag || '').trim();
    if (!name) return body;
    return `<${name}>\n${body}\n</${name}>`;
}

// The lorebook-entry field set that routes a task to a PRE/POST call: a silent data-carrier SillyTavern never
// injects — disabled, `type: 'selective'` (TavernHelper's entry model spells constant-vs-keyword as a `type`
// string, never a boolean) and no keys. extraLlmCalls reads its content by the `[callName]` comment tag,
// whether or not the entry is enabled.
export function buildTaskEntryFields({ taskId, target, tag, instruction }) {
    return {
        comment: taskEntryComment(taskId, target),
        content: taskEntryBody(tag, instruction),
        enabled: false,
        type: 'selective',
        keys: [],
    };
}

// The target a task runs on this turn — PURE. A task that supplies an active target (getActiveTarget)
// runs there, Off included; one that does not runs on its stored preference (getTarget, what the picker
// shows). `active` is undefined when the task supplies none.
export function runTargetOf({ stored = '', active } = {}) {
    return String((active === undefined ? stored : active) || '').trim();
}

// One run at a time per key — PURE: no timers, no globals; the caller owns the queue. A routing run reads its
// task's target when it starts and then awaits a lorebook write, so two runs for one task that overlap can finish
// in either order, and the run that read the older setting can write last: a route change followed at once by a
// Harvest via change then leaves a POST data-carrier in the book while the setting says narrate. Queued, a run
// starts only after the previous run for its key has settled, so the last run reads the last setting and its
// write is the one that stays. A run that throws still frees its key; the rejection goes to that run's caller.
export function createKeyedQueue() {
    const tails = new Map();   // key → settles once the latest run queued for that key has settled
    return function enqueue(key, run) {
        const queued = (tails.get(key) || Promise.resolve()).then(() => run());
        // EXPECTED: the rejection reaches the caller through `queued`; the tail only has to know it settled.
        tails.set(key, queued.then(() => {}, () => {}));
        return queued;
    };
}

// The routing destination's PHASE, resolved against the live call list.
// 'narrate' | 'pre' | 'post' | null (null = a stored target whose call no longer exists).
export function resolveTargetPhase(target, enabledCalls) {
    const t = String(target || '').trim();
    if (!t || t === NARRATE_TARGET) return t === NARRATE_TARGET ? NARRATE_TARGET : null;
    const call = (Array.isArray(enabledCalls) ? enabledCalls : []).find((c) => String(c && c.name || '').trim() === t);
    if (!call) return null;
    return call.phase === 'post' ? 'post' : 'pre';
}

// The selectable targets for a task, filtered by its `allow` phase list. Returns
// [{ value, label, phase }] — Off first (value ''), then narrate (if allowed), then each enabled, named call
// whose phase is allowed. `allow` entries: 'narrate' | 'pre' | 'post'. A task that is never off (`offersOff`
// false: its feature has its own off switch) lists no Off.
export function listTaskTargets(allow, enabledCalls, { offersOff = true } = {}) {
    const allowed = new Set((Array.isArray(allow) ? allow : []).map((a) => String(a || '').toLowerCase()));
    const out = offersOff ? [{ value: '', label: 'Off', phase: null }] : [];
    if (allowed.has(NARRATE_TARGET)) out.push({ value: NARRATE_TARGET, label: 'narrate (main reply)', phase: NARRATE_TARGET });
    for (const c of (Array.isArray(enabledCalls) ? enabledCalls : [])) {
        const name = String(c && c.name || '').trim();
        if (!name) continue;
        const phase = c.phase === 'post' ? 'post' : 'pre';
        if (!allowed.has(phase)) continue;
        out.push({ value: name, label: `${name} (${phase.toUpperCase()})`, phase });
    }
    return out;
}

// Is a stored target still a valid destination for this task? (call deleted / disabled / phase
// no longer allowed → false, so the UI can flag it and routing can no-op.)
export function isTargetAvailable(target, allow, enabledCalls) {
    const t = String(target || '').trim();
    if (!t) return true;   // Off is always "valid" (nothing routed)
    return listTaskTargets(allow, enabledCalls).some((o) => o.value === t);
}
