// logic-engine/turn-runner.js — the turn runner: mvu-helper resolves every turn with the loaded game
// engine. Importing this module registers its listeners. Everything is gated on the per-card logic
// engine profile, except the save of POST's parse (postRelayPlan in turn-runner-core).
//
// On VARIABLE_UPDATE_ENDED:
//   • narrate's parse → RES1 (runLive): the engine's resolveTurn on the live payload, the audit marker
//     staged for POST (__mvuResBlock, keyed {mid, swipe, epoch}), then fence + save;
//   • a RELAY — POST's parse, or a second parse of a turn RES1 already resolved → runPostRelay: the
//     engine's resolvePostRelay when it exports one, the installed plugins' resolveRelay, then the save;
//   • a parse that did not start from one of the newest stored states (MVU's floor replay after a
//     delete) → nothing (shared/mvu-parse-disposition endedEventDisposition).
// Fence = this module's generationEpoch captured at entry, plus "mid is still the latest non-user reply
// and its swipe_id is unchanged", re-checked right before the write. Save = saveMessageMvuData
// (sillytavern/mvu-bridge.js): Mvu.replaceMvuData with an explicit message target, which emits no
// VARIABLE_UPDATE_ENDED, so a save never re-enters the handler; the door announces it instead.
// Turn identity: mid = the latest non-user chat index, swipe = that message's swipe_id.
// mvu-helper is the only resolver host: a card that still bakes its own iframe resolver is refused by
// name (runLive's epoch-less marker check).
import { eventSource, event_types } from '../../../../../../../script.js';
import { getMvu, toast, saveMessageMvuData } from '../../sillytavern/mvu-bridge.js';
import { currentWriter, WRITER_POST, MVU_VARIABLE_UPDATE_ENDED, withoutMvuTransientKey } from '../../sillytavern/mvu-bridge-core.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { chatContext } from '../../sillytavern/chat-context.js';
import { composeStatBox, isStatBoxDeclared } from '../statbox/index.js';
import { redrawReply } from '../reply-redraw/index.js';
import { getLogicEngineProfile, getStoryEnvelope } from './logic-engine-store.js';
import { getLogicEngineApi, getLogicEngineStatus } from './logic-engine-loader.js';
import { currentDealtPool, currentDealtPools } from './roll-pool.js';
import { latestAiMessageId, swipeOf } from '../../shared/latest-reply.js';
import { turnKeyOf, pendingIntentSummary, isTurnResolverActive, postRelayPlan, postSilentRelayPlan, noteReplySettled, turnSavePlan, droppedIntentWrites, createTurnOpsCollector, diffStatOps, planRelayParticipants, applyTextReplacements, resolverWritesReplyText, placeLeadAndEndText, isStagedBlockStale, TURN_AUDIT_TAG, RELAY_AUDIT_TAG, auditBlockFromBody, auditBodyCarriesTag } from './turn-runner-core.js';
import { isLiveResolveSuppressed } from './live-resolve-gate.js';
import { endedEventDisposition } from '../../shared/mvu-parse-disposition.js';

const log = createModuleLog('logic-engine');

// RES-STAGED SIGNAL. POST carries the staged <RES_Variable> into the message, so it must know WHEN the marker
// below is ready. This event says "look again now": the marker stays the single source of truth, and a
// listener re-reads it rather than learning the block from the payload, so any number of waiters compose
// without counting fires; a waiter matches on its own fenced turn identity and keeps a timeout only as its
// backstop (awaitResStaged). Payload {mid, swipe, epoch, willSave}: the turn staged, and whether the engine
// saves this resolve's copy once its listeners return — mvu-helper's end-of-reply pass writes its own root only
// into a copy that is saved (own-state). An idle resolve (already resolved, nothing applied) saves nothing.
export const RES_STAGED_EVENT = 'mvu_helper_res_staged';

// GENERATION IN-FLIGHT MARKER — a card-visible contract, sibling of EXTRA_CALL_RENDER_DEPTH_KEY in
// small-llm/extra-llm-calls.js. ST-Prompt-Template re-renders every lorebook entry on page load, and from
// inside a template that render is indistinguishable from a real turn. This global is true from a real
// GENERATION_STARTED until GENERATION_ENDED or GENERATION_STOPPED, so a card's template can tell them
// apart. A global rather than a DOM probe: under ST-Prompt-Template's environmental isolation a template
// runs in a sandbox iframe whose `document` is its own, while page globals are copied in.
// Contract, matching the depth marker: an absent property (an mvu-helper without this marker) means the
// card must assume "in flight" — fail-open on both sides, so a missed GENERATION_ENDED leaves a trace ON
// rather than silently suppressing it.
export const GENERATION_IN_FLIGHT_KEY = 'mvuHelperIsGenerationInFlight';
if (typeof globalThis !== 'undefined' && typeof globalThis[GENERATION_IN_FLIGHT_KEY] !== 'boolean') {
    globalThis[GENERATION_IN_FLIGHT_KEY] = false;   // publish the capability at load, even at rest
}
const setGenerationInFlight = (value) => {
    if (typeof globalThis !== 'undefined') globalThis[GENERATION_IN_FLIGHT_KEY] = value;
};
// The same marker, for mvu-helper's own readers: true from a real GENERATION_STARTED until it ends or is stopped.
export function isGenerationInFlight() {
    return typeof globalThis !== 'undefined' && globalThis[GENERATION_IN_FLIGHT_KEY] === true;
}

let generationEpoch = 0;   // bumped on every real (non-dry-run) generation start — the fence identity
let lastHandled = '';      // turnKey already processed this chat (skips the RES2 re-fire); reset on CHAT_CHANGED
let loadFailureToasted = false;   // "installed but not loaded" already announced this chat; reset on CHAT_CHANGED

const counters = { refire: 0, liveResolved: 0, liveSaved: 0, fenceTripped: 0, foreignSkipped: 0 };
export function getTurnRunnerCounters() { return { ...counters }; }

// A parse that is not this turn's (shared/mvu-parse-disposition endedEventDisposition). A replay fires once per
// re-read message, ~20 in one second, so the first of a burst warns and the rest log at verbose; a
// burst ends after FOREIGN_BURST_MS without one. A missing start state is a broken sender, never a
// burst, so it is an error every time.
const FOREIGN_BURST_MS = 5000;
let foreignBurst = { lastAt: 0, count: 0 };
function reportForeignParse(verdict) {
    counters.foreignSkipped++;
    if (verdict.reason === 'no-start-state') {
        log.error('RES skipped a variable update that arrived WITHOUT its starting state (variables_before_update, part of MVU\'s published event signature) — it cannot tell a turn from a floor replay, so nothing was resolved');
        return;
    }
    const now = Date.now();
    const fresh = now - foreignBurst.lastAt > FOREIGN_BURST_MS;
    foreignBurst = { lastAt: now, count: fresh ? 1 : foreignBurst.count + 1 };
    const line = `RES skipped a variable update that is not this turn's — it started from a state none of the newest messages (${verdict.compared.join(', ') || 'none'}) holds. Expected cause: MVU's floor replay after a delete (restoreVariables), which re-reads old messages one by one; another extension parsing an older message reads the same. Nothing resolved, saved or collected`;
    if (fresh) log.warn(line + ' (further ones in this burst log at verbose)');
    else log.verbose(`${line} (#${foreignBurst.count} in this burst)`);
}

// The event key whose DO body the [PRE] seam injected for THIS reply (small-llm calls this when it
// injects). Read once and handed to resolveTurn as ctx.sameRoundEventKey, so the ENGINE can tell a beat
// that was played but never fired (its verdict, not ours) — then cleared, so a stale key never reaches
// the NEXT turn's resolve.
let sameRoundInjectedKey = '';
export function noteSameRoundEventInjected(key) { sameRoundInjectedKey = String(key || ''); }

// Will RES1 run on a reply MVU parses, right now? Read for small-llm's POST gate, which waits for the turn
// audit marker only when something will stage one (the decision and why it ignores the reply's text:
// isTurnResolverActive in turn-runner-core). The same two facts onVariableUpdateEnded gates on.
export function isTurnResolverActiveNow() {
    return isTurnResolverActive({ isProfileEnabled: getLogicEngineProfile().enabled, engineApi: getLogicEngineApi() });
}

// Say what the reply TRIED to write and lost. Sits beside the `pending:` line because that line is
// where the loss is invisible: a channel MVU refused reads there as `-`, identical to a channel the
// narrator never touched. WARN ONLY — never repaired, never rewritten to the `/0` path (L7): the
// spelling is taught by the CARD's prompt, and repairing here would hide the defect from the only
// layer that can actually fix it.
function warnDroppedIntentWrites(chat, mid, swipe, statData, key) {
    try {
        const m = Array.isArray(chat) ? chat[mid] : null;
        if (!m) return;
        // The SWIPE's text, not `mes`, when they differ — a regen leaves `mes` behind the active swipe.
        const text = (Array.isArray(m.swipes) && m.swipes[swipe] != null) ? m.swipes[swipe] : m.mes;
        const dropped = droppedIntentWrites(text, statData && statData.Intent);
        for (const channel of dropped) {
            log.warn(`${key}: the reply wrote /Intent/${channel} WITHOUT its /0 — MVU refused the op ` +
                `(it would clobber the [value,"Label"] tuple), so "${channel}" is still empty and THIS TURN'S ${channel} WRITE IS LOST. ` +
                `The prose was already narrated, so whatever it described did not happen mechanically. ` +
                `The correct path is /Intent/${channel}/0 — fix the wording in the card prompt that teaches it, not here.`);
        }
    } catch (e) {
        // NOT swallowed: a diagnostic that throws would take the resolve down with it, so it is caught —
        // but it still says so, because a guard that silently stops guarding is worse than none.
        log.warn('dropped-Intent-write check failed (resolve continues):', e);
    }
}

// ── fence + save ─────────────────────────────────────────────────────────────
// The liveness half of the fence, alone: the turn must not have advanced or swiped since the event
// fired. The reply-text write uses it without the save (an idle resolve can still carry text for the reply).
function turnStillLive(chat, mid, swipe, fenceEpoch, key, what) {
    const liveMid = latestAiMessageId(chat);
    const liveSwipe = swipeOf(chat, mid);
    if (generationEpoch !== fenceEpoch || liveMid !== mid || liveSwipe !== swipe) {
        counters.fenceTripped++;
        log.warn(`LIVE ${key}: turn advanced before the ${what} (epoch ${fenceEpoch}→${generationEpoch}, latest now ${liveMid}:${liveSwipe}) — ${what} SKIPPED to protect that message's snapshot`);
        return false;
    }
    return true;
}

// Fence + save, shared by the two writers in this file: runLive (RES1) and runPostRelay (RES2). `stage`
// prints as the line's tag; `what` lists what the save carries (turnSavePlan's label). Returns true only
// when the save happened.
async function fenceAndSaveTurn(mvuData, chat, mid, swipe, key, fenceEpoch, stage, what = '') {
    const stageLog = log.child(stage);
    const carries = what ? ` (${what})` : '';
    if (!turnStillLive(chat, mid, swipe, fenceEpoch, key, `${stage} save${carries}`)) return false;
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.replaceMvuData !== 'function') {
        stageLog.error(`LIVE ${key}: Mvu.replaceMvuData unavailable — state NOT persisted${carries} (the next reply would recompute from stale data)`);
        return false;
    }
    // Explicit target; no VARIABLE_UPDATE_ENDED, so no self-loop; the door announces the save.
    if (!(await saveMessageMvuData(mvuData, mid, { writer: stage }))) return false;
    counters.liveSaved++;
    stageLog.domain('pipeline', 'lifecycle', `saved ✓ -> msg ${mid}${carries}`);
    return true;
}

// ── the resolved reply's text: engine replacements, lead and end text, the stat box ──
// The resolver may return `textReplacements` — opaque {findLiteral: putLiteral} pairs applied to the
// resolved message's text verbatim (turn-runner-core applyTextReplacements). This host never learns what
// a pair means, names no tag, and writes nothing when the engine sent none; a find with 0 occurrences is
// reported in the count line, never invented.
//
// It may return `leadText` and `endText` too: the engine's own text, written into the reply whatever the model
// wrote — at the top of the story the card names in its [Initmvuhelper] leadText section, and directly above the
// menu — each in a tag of mvu-helper's own and refreshed in place by a later resolve of the same reply
// (turn-runner-core placeLeadAndEndText).
//
// The stat box is placed in the same edit when `statData` is passed (RES1 only): the card declares it, and
// features/statbox renders it from the resolved state. RES2 passes none: the post-reply phase refreshes the
// box from the turn's final state when it ends.
//
// Callers run this only after the fence said the turn is still live: writing a resolved reply's text onto
// a newer reply is the same corruption as writing its state. The edit goes to the reply redraw, which
// writes it together with the turn's other edits when the post-reply phase ends (features/reply-redraw).
async function writeResolvedReplyText(chat, mid, r, key, what, statData = null) {
    const pairs = r && r.textReplacements;
    if (!resolverWritesReplyText(r) && !statData) return;
    const message = Array.isArray(chat) ? chat[mid] : null;
    if (!message) { log.warn(`${key}: the ${what} reply-text write found msg ${mid} gone — nothing written`); return; }
    let text = message.mes;
    if (pairs != null) {
        const res = applyTextReplacements(text, pairs);
        for (const bad of res.skipped) log.warn(`${key}: textReplacements[${JSON.stringify(bad)}] is not a string→string pair — SKIPPED (the engine owns the fix)`);
        for (const { find, token } of res.refused) log.warn(`${key}: textReplacements[${JSON.stringify(find)}] would add "${token}" to the reply — NOT applied. That token makes the page run the reply's text (a TavernHelper render or an ST-Prompt-Template template), and engine text never reaches the page (the engine owns the fix)`);
        const names = Object.keys(res.counts);
        const refused = res.refused.map((r) => r.find);
        const zero = names.filter((k) => res.counts[k] === 0);
        const total = names.filter((k) => !refused.includes(k)).reduce((a, k) => a + res.counts[k], 0);
        log.child(what).domain('pipeline', 'lifecycle', `${key}: textReplacements — ${total} swap(s), ${names.length} key(s)${zero.length ? ` · 0 hits: ${zero.join(' ')}` : ''}${refused.length ? ` · refused: ${refused.join(' ')}` : ''}`);
        text = res.text;
    }
    if (r && (r.leadText != null || r.endText != null)) text = withLeadAndEndText(text, r, key, what);
    if (statData) text = composeStatBox(text, { mid, statData, writer: `logic-engine ${what}` });
    if (text === message.mes) return;
    message.mes = text;
    await redrawReply(message, mid, `logic-engine ${what} reply text`);
}

// The reply's text with the engine's lead and end text written, every block left unwritten said so.
function withLeadAndEndText(text, r, key, what) {
    const res = placeLeadAndEndText(text, { leadText: r.leadText, endText: r.endText }, { storyEnvelope: getStoryEnvelope() });
    for (const field of res.skipped) log.warn(`${key}: the engine's ${field} is not a string — SKIPPED (the engine owns the fix)`);
    for (const field of res.undeclared) log.warn(`${key}: the engine returned ${field}, but the card's [Initmvuhelper] names no story block (leadText.storyEnvelope) — NOT written. The lead text goes at the top of the story, and only the card knows which block holds it (the card owns the fix)`);
    for (const { field, token, isOwnTag } of res.refused) {
        log.warn(isOwnTag
            ? `${key}: the engine's ${field} carries "${token}" — NOT written. An engine returns the text alone: mvu-helper adds the tag, and finds the block again by it (the engine owns the fix)`
            : `${key}: the engine's ${field} carries "${token}" — NOT written. That token makes the page run the reply's text (a TavernHelper render or an ST-Prompt-Template template), and engine text never reaches the page (the engine owns the fix)`);
    }
    for (const { field, tag } of res.unpaired) log.warn(`${key}: the reply carries <${tag}> or </${tag}> without its partner — the engine's ${field} is NOT written, because neither the old block nor the place for a new one can be found (the reply was cut off or edited by hand)`);
    log.child(what).domain('pipeline', 'lifecycle', `${key}: lead text ${res.actions.leadText} · end text ${res.actions.endText}`);
    return res.text;
}

// ── the plugin half ──────────────────────────────────────────────────────────
// The installed plugins' resolveRelay, run by runPostRelay. The participants come from a REGISTERED
// provider (P5: this file names no plugin vocabulary; gamelogic-plugin registers itself in src/index.js),
// run in install order, each behind a host-side once-guard per {generation epoch, turnKey}, so a plugin
// never guards against a duplicate fire itself. One participant throwing drops its own writes only.
let relayParticipantsProvider = null;
export function registerRelayParticipantsProvider(fn) {
    if (typeof fn === 'function') relayParticipantsProvider = fn;
}
const relayGuard = new Map();          // participant id → last guard key; cleared on CHAT_CHANGED
let lastRelayFireKey = '';             // `epoch:mid:swipe` the plugin half last ran for; cleared on CHAT_CHANGED

// The turn's applied-op receipt: every {path, old, new, by} a parse landed this generation, collected by
// diffing VARIABLE_UPDATE_ENDED's two arguments (in the handler below).
const turnOps = createTurnOpsCollector();

// `mode` is the plan's words for a fire without the game half ('' after the game's own relay), so the
// console never shows a plugin write without saying whether a game resolver ran before it.
// Returns true when at least one participant applied ops.
async function runPluginRelayHalf(mvuData, mid, swipe, key, fenceEpoch, mode = '') {
    if (!relayParticipantsProvider) return false;
    let bundle = null;
    try { bundle = await relayParticipantsProvider(); }
    catch (e) { log.child('RES2').warn(`plugin ${key}: the participants provider threw — plugin RES2 resolvers skipped this fire:`, e); return false; }
    const participants = (bundle && Array.isArray(bundle.participants)) ? bundle.participants : [];
    if (!participants.length) return false;
    const guardKey = fenceEpoch + ':' + key;
    const { run, skipped } = planRelayParticipants(participants, relayGuard, guardKey);
    if (skipped.length) log.child('RES2').domain('pipeline', 'lifecycle', `plugin ${key}: once-guard skip for ${skipped.join(', ')} — already resolved this fire`);
    if (!run.length) return false;
    // Stamped where the participants actually run, so the POST-done trigger (postSilentRelayPlan) and the
    // parse trigger share one fact about whether this turn was served.
    lastRelayFireKey = guardKey;
    const { ops, capped } = turnOps.snapshot(fenceEpoch);
    if (capped) log.child('RES2').warn(`plugin ${key}: the turn's op list hit its cap — resolvers see a TRUNCATED ops list this turn`);
    // The dice receipt, snapshotted once so every participant on this fire sees the same pool. Verify-only:
    // a plugin deals the dice its prose reports in its own entry (MvuHelper.rollPool, its own pool name)
    // and finds them here; a resolver never rolls. null = nothing was dealt this generation.
    const dice = currentDealtPool();
    const dicePools = currentDealtPools();   // the same receipt per pool: { pool | hash, sides, dice }
    let applied = false;
    for (const participant of run) {
        // Guarded BEFORE the call: the once-guard is about the fire, not about success, so a throwing
        // resolver gets no second run off a duplicate fire.
        relayGuard.set(participant.id, guardKey);
        try {
            // `mvuData` is threaded, not `stat_data`: each participant's ops go through MVU's parse, which
            // applies onto a copy, so the next participant and the save must see the copy the last one made.
            const r = await participant.resolve({ mvuData, ops, dice, dicePools, mid, swipe, epoch: fenceEpoch });
            if (r && r.statData && r.statData !== mvuData.stat_data) mvuData.stat_data = r.statData;
            if (r && r.applied) applied = true;
            log.child('RES2').domain('pipeline', 'lifecycle', `plugin ${key}${mode ? ' ' + mode : ''}: "${participant.id}" ${(r && r.summary) || (r && r.applied ? 'wrote state' : 'wrote nothing')}`);
        } catch (e) {
            log.child('RES2').error(`plugin ${key}: plugin "${participant.id}" resolver threw — ITS writes are dropped, the other plugins and the turn continue:`, e);
        }
    }
    return applied;
}

// ── the game half ────────────────────────────────────────────────────────────
// The engine's resolvePostRelay, with the same verify-only receipts as RES1 (ctx.ops now also holds
// POST's own parse, by 'post'); sameRoundEventKey belongs to the turn's own resolve and is not passed. Like RES1, it
// is handed the state without MVU's transient key.
// It stages the relay's audit block for POST on every exit, `done` meaning "the relay ran", never "it
// succeeded" — POST reads the marker after awaiting this run (awaitTurnWork), so it never waits on it.
// The block's content is the engine's; its tag is mvu-helper's (auditBlockOf).
// Returns the engine's result, or null when it threw.
async function runGameRelayHalf(api, mvuData, chat, mid, swipe, key, fenceEpoch) {
    const statData = mvuData.stat_data;
    log.child('RES2').domain('pipeline', 'lifecycle', `${key} — pending: ${pendingIntentSummary(statData.Intent)}`);
    warnDroppedIntentWrites(chat, mid, swipe, statData, key);
    const receipt = turnOps.snapshot(fenceEpoch);
    if (receipt.capped) log.child('RES2').warn(`${key}: the turn's op list hit its cap — resolvePostRelay's ctx.ops is TRUNCATED this turn`);
    let r = null;
    try { r = await api.resolvePostRelay(withoutMvuTransientKey(statData), { mid, swipe, dice: currentDealtPool(), dicePools: currentDealtPools(), ops: receipt.ops }); }
    catch (e) {
        // The plugin half and the save still run: one resolver's failure never starves the others.
        log.error(`LIVE ${key}: resolvePostRelay threw — the engine's relay changes are NOT applied (POST's own ops are still saved):`, e);
        toast('error', 'LogicEngine RES2 failed — the engine\'s relay was not applied (see console).');
    }
    // The engine mutates the Worker's structured clone, so the returned object is the result.
    if (r && r.statData && r.statData !== statData) mvuData.stat_data = r.statData;
    log.child('RES2').domain('pipeline', 'lifecycle', `${key}: applied=${!!(r && r.applied)} → ${(((r && r.log) || []).join('  |  ')) || '(nothing pending)'}`);
    if (chat) chat.__mvuPostRelayBlock = { mid, swipe, done: true, block: auditBlockOf(r, RELAY_AUDIT_TAG, key) || '', epoch: fenceEpoch };
    return r;
}

// ── the relay executor ───────────────────────────────────────────────────────
// THE ONE PATH for every relay fire on every card kind, planned by postRelayPlan (a parse) or
// postSilentRelayPlan (POST wrote nothing): the game half when the plan runs it, then the plugin half,
// then turnSavePlan's save — which always includes POST's parse when the fire carries one.
async function runPostRelay({ plan, api, mvuData, chat, mid, swipe, key, isPostParse }) {
    const fenceEpoch = generationEpoch;
    const stageLog = log.child('RES2');
    if (!plan.runsGameHalf && !plan.runsPluginHalf) stageLog.domain('pipeline', 'lifecycle', `${key}: ${plan.mode}`);
    const r = plan.runsGameHalf ? await runGameRelayHalf(api, mvuData, chat, mid, swipe, key, fenceEpoch) : null;
    const didPluginsApply = plan.runsPluginHalf ? await runPluginRelayHalf(mvuData, mid, swipe, key, fenceEpoch, plan.mode) : false;
    const save = turnSavePlan({ isPostParse, didGameApply: !!(r && r.applied), didPluginsApply });
    if (!save.shouldSave) {
        stageLog.verbose(`${key}${plan.mode ? ' ' + plan.mode : ''}: nothing was written — nothing to save`);
        return;
    }
    if (await fenceAndSaveTurn(mvuData, chat, mid, swipe, key, fenceEpoch, 'RES2', save.label)) {
        // A relay resolver may return text for the reply too (textReplacements, leadText, endText). No stat box
        // here: the post-reply phase refreshes it when it ends.
        if (r) await writeResolvedReplyText(chat, mid, r, key, 'RES2');
    }
}

// ── the relay for a reply no POST parse fired it for ─────────────────────────
// postSilentRelayPlan's trigger. It needs both of these, in either order: this handler finished narrate's
// parse (RES1 included: its save and its reply-text write), and the post-reply phase is done with no POST
// parse coming (notePostPhaseDone). One record, keyed `epoch:mid:swipe`; a new key is a new reply.
// The state the relay runs on: when the parse completes the pair, that parse's own `mvuData` — MVU may not
// have stored it yet, and RES1 resolved onto it; when POST-done completes it, the parse ended earlier, so
// the message's stored variables are current.
let replySettle = null;

async function settleReply({ chat, mid, swipe, key, isParsed = false, postOutcome = '', parsedMvuData = null }) {
    const fireKey = generationEpoch + ':' + key;
    const settled = noteReplySettled(replySettle, { fireKey, isParsed, postOutcome });
    replySettle = settled.record;
    if (!settled.isReady) return;
    const plan = postSilentRelayPlan({
        gameStatus: getLogicEngineStatus().status,
        engineApi: getLogicEngineApi(),
        lastFiredKey: lastRelayFireKey,
        turnFireKey: fireKey,
        postOutcome: replySettle.postOutcome,
    });
    if (!plan) return;
    let mvuData = parsedMvuData;
    if (!mvuData) {
        const Mvu = getMvu();
        if (!Mvu || typeof Mvu.getMvuData !== 'function') return;
        try { mvuData = Mvu.getMvuData({ type: 'message', message_id: mid }); }
        catch (e) { log.child('RES2').warn(`plugin ${key}: could not read this message's variables, so the relay is skipped for this reply:`, e); return; }
    }
    if (!mvuData || !mvuData.stat_data || typeof mvuData.stat_data !== 'object') return;
    await runPostRelay({ plan, api: null, mvuData, chat, mid, swipe, key, isPostParse: false });
}

// The post-reply phase is done for the latest reply (small-llm's POST_DONE_EVENT, wired in src/index.js).
// `isPostParseComing` — POST's block is about to be parsed, and that parse fires the relay itself.
// `didPostCallsRun` — whether any POST call ran, which the relay's log line names.
export async function notePostPhaseDone(isPostParseComing = false, didPostCallsRun = false) {
    if (!getLogicEngineProfile().enabled) return;
    if (isPostParseComing) return;
    const ctx = chatContext('logic-engine');
    const chat = ctx && ctx.chat;
    const mid = latestAiMessageId(chat);
    if (mid < 0) return;
    const swipe = swipeOf(chat, mid);
    await settleReply({ chat, mid, swipe, key: turnKeyOf(mid, swipe), postOutcome: didPostCallsRun ? 'no-block' : 'no-calls' });
}

// The engine's audit BODY in the tag mvu-helper owns (turn-runner-core auditBlockFromBody). An engine that
// adds its own tag is told, never repaired: the reply then shows the tag twice until the engine stops. A body
// carrying a page-code token writes no block at all, and the warning names the token.
function auditBlockOf(r, tag, key) {
    const body = (r && r.resBlock) ? String(r.resBlock) : '';
    if (auditBodyCarriesTag(body)) {
        log.warn(`${key}: the engine's resBlock already carries an audit tag — an engine returns the block BODY only and mvu-helper adds <${tag}>. Wrapped as given, so the reply shows the tag twice until the engine stops adding its own.`);
    }
    const { block, refusedToken } = auditBlockFromBody(body, tag);
    if (refusedToken) {
        log.warn(`${key}: the engine's resBlock carries "${refusedToken}" — NO <${tag}> written. That token makes the page run the reply's text (a TavernHelper render or an ST-Prompt-Template template), and engine text never reaches the page (the engine owns the fix)`);
    }
    return block;
}

// ── RES1: resolve the turn ───────────────────────────────────────────────────
// `isPostParse` — this resolve runs on POST's parse (the engine had not resolved the turn yet), so the
// save happens even when the engine applied nothing: it is that parse's only persist (turnSavePlan).
async function runLive(api, mvuData, statData, chat, mid, swipe, key, sameRoundEventKey, isPostParse) {
    const fenceEpoch = generationEpoch;
    // A done-marker for this {mid,swipe} from THIS generation means the turn was already resolved in this
    // cycle (a duplicate event). An epoch-less marker comes from a card that still bakes its own iframe
    // resolver. A marker from an older epoch belongs to a regenerated take of the same message, and the
    // staging below replaces it.
    const marker = chat.__mvuResBlock;
    if (marker && marker.mid === mid && marker.swipe === swipe && marker.done && marker.epoch === undefined) {
        lastHandled = key;
        log.warn(`LIVE ${key}: an epoch-less RES marker is already staged for this turn — this card still carries a BAKED iframe resolver, which would resolve it twice. Strip the baked resolver from the card. Skipping.`);
        return;
    }
    if (marker && marker.mid === mid && marker.swipe === swipe && marker.done && marker.epoch === fenceEpoch) {
        lastHandled = key;
        log.warn(`LIVE ${key}: this turn was already resolved in this generation cycle — duplicate event, skipping.`);
        return;
    }
    // The "[RES] fired — pending:" line enumerates the card's Intent channels: the turn-debugging source of truth.
    log.child('RES').domain('pipeline', 'lifecycle', `fired — pending: ${pendingIntentSummary(statData.Intent)}`);
    warnDroppedIntentWrites(chat, mid, swipe, statData, key);
    // The engine's ctx — all verify-only; the engine resolves ON statData:
    //   dice / dicePools — what the dealer dealt this generation, flat and per pool (null when nothing was);
    //   ops — every {path, old, new, by} a parse landed this generation: narrate's block ('message') and any
    //         PRE-time sim apply ('pre-sim'). The engine's own mutations never appear;
    //   sameRoundEventKey — the event whose body the [PRE] seam injected into this reply ('' when none);
    //         whether the beat then fired is the engine's verdict and log.
    // Awaited: the engine runs in a Worker, so this is a postMessage round trip, and the fence below
    // re-reads the live turn identity because time passes here. The engine is handed statData without MVU's
    // transient key (withoutMvuTransientKey): this runs inside MVU's update, before MVU removes `$internal`, and
    // the engine's copy comes back as the reply's state.
    const turnReceipt = turnOps.snapshot(generationEpoch);
    if (turnReceipt.capped) log.warn(`LIVE ${key}: the turn's op list hit its cap — resolveTurn's ctx.ops is TRUNCATED this turn`);
    let r;
    try { r = await api.resolveTurn(withoutMvuTransientKey(statData), { mid, swipe, dice: currentDealtPool(), dicePools: currentDealtPools(), ops: turnReceipt.ops, sameRoundEventKey }); }
    catch (e) { log.error(`LIVE ${key}: resolveTurn threw — turn NOT resolved:`, e); toast('error', 'LogicEngine resolve failed — this turn was not resolved (see console).'); return; }
    lastHandled = key;
    counters.liveResolved++;
    // The engine mutates the Worker's structured clone, so the returned object is the result.
    if (r && r.statData && r.statData !== statData) mvuData.stat_data = r.statData;

    // Stage the done-marker + audit block for POST, keyed {mid, swipe, epoch}. A marker from an older epoch
    // describes a superseded generation of this message and is replaced whole.
    const blk = auditBlockOf(r, TURN_AUDIT_TAG, key);
    const prev = chat.__mvuResBlock;
    if (!prev || prev.mid !== mid || prev.swipe !== swipe || prev.epoch !== fenceEpoch) {
        chat.__mvuResBlock = { mid, swipe, done: true, block: blk, epoch: fenceEpoch };
    } else { prev.done = true; if (blk && !prev.block) prev.block = blk; }
    // Announce readiness the instant it is ready (RES_STAGED_EVENT), for every resolve — an empty block
    // included, so a waiter can stop waiting — with whether this resolve is saved. A throwing listener must not
    // cost the turn its save, which is why the save comes after this.
    const save = turnSavePlan({ isPostParse, didGameApply: !!(r && r.applied) });
    try { await eventSource.emit(RES_STAGED_EVENT, { mid, swipe, epoch: fenceEpoch, willSave: save.shouldSave }); }
    catch (e) { log.warn('RES-staged signal emit failed (non-fatal — POST falls back to its timeout):', e); }

    log.child('RES').domain('pipeline', 'lifecycle', `${key}: applied=${!!(r && r.applied)} → ${(((r && r.log) || []).join('  |  ')) || '(nothing pending)'}`);
    // Nothing to save: the reply's text (the engine's text + stat box) is still written — an idle resolve can
    // return text for the reply (textReplacements, leadText, endText), and narrate's own writes still move the
    // box. It rides the same fence as the save, so a turn that advanced gets neither write.
    if (!save.shouldSave) {
        const wantsText = resolverWritesReplyText(r) || isStatBoxDeclared();
        if (wantsText && turnStillLive(chat, mid, swipe, fenceEpoch, key, 'reply-text write')) {
            await writeResolvedReplyText(chat, mid, r, key, 'RES', mvuData.stat_data);
        }
        return;
    }
    if (await fenceAndSaveTurn(mvuData, chat, mid, swipe, key, fenceEpoch, 'RES', save.label)) {
        await writeResolvedReplyText(chat, mid, r, key, 'RES', mvuData.stat_data);
    }
}

// ── the event handler ────────────────────────────────────────────────────────
async function onVariableUpdateEnded(mvuData, variablesBefore) {
    try {
        // Read before any await: the parse that fired this event has its frame on the writer stack only
        // while the handler's synchronous part runs.
        const writer = currentWriter();
        const isProfileEnabled = getLogicEngineProfile().enabled === true;
        // With the logic engine off nothing resolves; POST's parse still needs its save (postRelayPlan).
        if (!isProfileEnabled && writer !== WRITER_POST) return;
        const suppressed = isLiveResolveSuppressed();
        const ctx = chatContext('logic-engine');
        const chat = ctx && ctx.chat;
        // NOT EVERY PARSE IS A TURN (shared/mvu-parse-disposition endedEventDisposition): MVU's floor replay after a
        // delete fires this event once per re-read message. A parse that started from none of the newest
        // stored states is not this turn's — nothing is resolved, saved or collected from it. The
        // suppressed writers below are exempt: they are mvu-helper's own parses, and a menu action starts
        // from whichever message it writes, however old.
        if (!suppressed) {
            const verdict = endedEventDisposition(variablesBefore && variablesBefore.stat_data, chat);
            if (verdict.disposition === 'foreign') { reportForeignParse(verdict); return; }
        }
        // The applied-op receipt — a DIFF of this event's two arguments, noted before the suppression
        // return, because the PRE-time sim apply's ops are exactly what a relay resolver reads back.
        // `writer` names the lane: an un-initiated parse (narrate's own block) reads as 'message'.
        try {
            const beforeStat = variablesBefore && variablesBefore.stat_data;
            if (beforeStat && mvuData && mvuData.stat_data) {
                const diff = diffStatOps(beforeStat, mvuData.stat_data);
                for (const op of diff.ops) turnOps.note(generationEpoch, op.path, op.old, op.new, writer);
                if (diff.capped) log.warn('op collection: this parse changed more paths than the cap — every ops receipt this turn (plugin RES2 + engine ctx) is TRUNCATED');
            }
        } catch (e) {
            log.warn('op collection failed for this parse (the relay sees fewer ops, the turn continues):', e);
        }
        // A SUPPRESSED WRITER is parsing its own patch right now (live-resolve-gate.js): this event is that
        // parse's echo, not a finished turn, and resolving here would consume the freshly written intent
        // before narrate renders it. The writers that suppress: 'pre-sim' (a PRE-time sim apply),
        // 'plugin:<id>' (a relay resolver persisting its ops) and 'statusmenu:<id>' (a menu action — a
        // user gesture, never a turn). The line prints the writer's own label.
        if (suppressed) {
            log.domain('pipeline', 'lifecycle', `LIVE resolve suppressed — writer "${writer}" is parsing its own patch; the intent stays for narrate + the turn resolve`);
            return;
        }
        const statData = mvuData && mvuData.stat_data;
        if (!statData || typeof statData !== 'object') return;
        const mid = latestAiMessageId(chat);
        if (mid < 0) return;
        const swipe = swipeOf(chat, mid);
        const key = turnKeyOf(mid, swipe);
        const isRefire = key === lastHandled;
        const api = getLogicEngineApi();
        // A RELAY — POST's parse, or a second parse of a turn RES1 already resolved — takes the one
        // relay path on every card kind (postRelayPlan); everything else is narrate's parse.
        const plan = postRelayPlan({ isProfileEnabled, isRefire, writer, gameStatus: getLogicEngineStatus().status, engineApi: api });
        if (plan) {
            if (isRefire) counters.refire++;
            await runPostRelay({ plan, api, mvuData, chat, mid, swipe, key, isPostParse: writer === WRITER_POST });
            return;
        }
        await resolveNarrateParse(api, mvuData, statData, chat, mid, swipe, key, writer);
        // This reply's own parse is done. When it was POST's parse (the engine resolved it here, having
        // not resolved narrate's), it was the post-reply phase's write as well.
        await settleReply({ chat, mid, swipe, key, isParsed: true, postOutcome: writer === WRITER_POST ? 'resolved-by-res1' : '', parsedMvuData: mvuData });
    } catch (e) {
        log.error('turn runner error (non-fatal):', e);
    }
}

// Narrate's parse: RES1 when a usable engine resolves turns, otherwise the engine-status arms.
async function resolveNarrateParse(api, mvuData, statData, chat, mid, swipe, key, writer) {
    if (!api || typeof api.resolveTurn !== 'function') {
        // No usable engine for narrate's parse. The loader knows which state this is, and each deserves
        // its own volume:
        //   'no-engine'      → a card with no game engine: an ordinary MVU card. Silent, because the
        //                      profile is on by default and this runs on every reply.
        //   'book-not-ready' → the worldbook is still loading (a card import fires this event before the
        //                      chat's engine load finishes). Transient; the next turn resolves.
        //   'disabled'       → no load attempted for this card yet.
        //   'error'/'loaded' → the engine is there and broken (it threw at load, or loaded with no usable
        //                      API). Nothing else resolves the turn, so this is loud — once per chat.
        const { status, error } = getLogicEngineStatus();
        if (status === 'no-engine') {
            log.verbose(`${key}: no game engine on this card — nothing to resolve`);
            return;
        }
        const genuinelyBroken = status === 'error' || status === 'loaded';
        if (!genuinelyBroken) {
            log.verbose(`${key}: the engine is not loaded yet (status=${status}) — this turn is not resolved`);
            return;
        }
        log.error(`LIVE ${key}: engine present but unusable (status=${status}${error ? `: ${error}` : ''}) — turn NOT resolved`);
        if (!loadFailureToasted) {
            loadFailureToasted = true;
            toast('error', 'LogicEngine failed to load — this turn was not resolved.');
        }
        return;
    }
    // Consume the [PRE] same-round key: read once and cleared, so a stale key never reaches the next
    // turn (including on runLive's paths that return before using it).
    const injectedSameRound = sameRoundInjectedKey;
    sameRoundInjectedKey = '';
    await runLive(api, mvuData, statData, chat, mid, swipe, key, injectedSameRound, writer === WRITER_POST);
}

// ── in-flight handler runs, by turn ──────────────────────────────────────────
// POST's parse emits VARIABLE_UPDATE_ENDED, this handler runs the relay on it, and the relay's own parse
// emits the event again — to every listener, this reply's TavernHelper iframe (the status menu) included,
// whose listener is async; ST's emit awaits each listener in turn. Rebuilding the reply's DOM while that
// emit is still walking destroys the iframe mid-await: the emit never returns, the parse never settles,
// and the writer frame and suppression depth leak. So the caller that rebuilds the reply (POST) waits for
// the run its own parse started. The handler is registered VOID below (an emit must never block on a
// resolve), which is why the run is tracked here instead of awaited there. Keyed by turn, so nobody waits
// on an unrelated turn's run.
const turnWorkInFlight = new Map();   // turnKey → Set<Promise<void>>

function trackTurnWork(key, run) {
    let runs = turnWorkInFlight.get(key);
    if (!runs) { runs = new Set(); turnWorkInFlight.set(key, runs); }
    runs.add(run);
    // onVariableUpdateEnded never rejects (it catches and logs), so this is release only.
    run.finally(() => {
        runs.delete(run);
        if (!runs.size && turnWorkInFlight.get(key) === runs) turnWorkInFlight.delete(key);
    });
}

/**
 * Resolves once every VARIABLE_UPDATE_ENDED handler run in flight for this turn has finished — the
 * RES2/relay half and its parse included. POST awaits it between applying its block and writing the
 * reply back. Resolves at once when nothing is running (no parse fired, or the run already ended).
 */
export function awaitTurnWork(mid, swipe) {
    const runs = turnWorkInFlight.get(turnKeyOf(mid, swipe));
    return (runs && runs.size) ? Promise.all([...runs]).then(() => undefined) : Promise.resolve();
}

// ── the staged RES marker, read ──────────────────────────────────────────────
// RES1 stages the turn's audit on the SHARED chat array as `__mvuResBlock` { mid, swipe, epoch, done, block }
// (runLive) — block '' when nothing visible changed — after the engine's resolve is written onto the parse's
// variables, and before the save. READINESS IS THE DATA MARKER, never a fire count: every reader re-reads it,
// and RES_STAGED_EVENT only says when to look, so a wait ends on a signal rather than a clock and composes with
// any number of waiters (the post-reply phase). A reader matches the marker against the
// swipe IT fenced at entry, never the message's live swipe_id: on a regenerate the live one can transiently
// differ, and matching on it would drop a validly-staged block with no warning. A swipe stages a fresh marker.

// The staged audit block for THIS {mid, swipe}; '' when none is staged or it is empty.
export function readResStaged(ctx, mesId, swipe) {
    const s = ctx && ctx.chat && ctx.chat.__mvuResBlock;       // plain property access — can't throw, so nothing to hide
    if (s && s.mid === mesId && s.swipe === swipe && s.block) return String(s.block);
    return '';
}
// The RES marker for THIS {mid, swipe} once it reads done, else null.
export function readResMarkerDone(ctx, mesId, swipe) {
    const s = ctx && ctx.chat && ctx.chat.__mvuResBlock;       // plain property access — can't throw
    return (s && s.mid === mesId && s.swipe === swipe && s.done) ? s : null;
}
// Resolve with the staged block ('' when empty) as soon as the marker for THIS {mid, swipe} reads done — on the
// signal, or at once if it already does. `timeoutMs` only bounds the no-signal-will-ever-come case: a resolver that
// never stages (a resolveTurn that throws, a card still carrying a baked resolver) would otherwise hang the wait;
// the caller tells a timeout apart by re-reading readResMarkerDone. The listener is removed on EVERY exit path,
// the timeout included: waits run once per reply, so a leaked listener would accumulate one per turn for the life
// of the tab.
export function awaitResStaged(ctx, mesId, swipe, timeoutMs) {
    const readDone = () => readResMarkerDone(ctx, mesId, swipe);
    const already = readDone();
    if (already) return Promise.resolve(already.block ? String(already.block) : '');
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (s) => {
            if (settled) return;                               // timer and signal can both land in one tick
            settled = true;
            if (timer) clearTimeout(timer);
            try { eventSource.removeListener(RES_STAGED_EVENT, onStaged); }
            catch (e) { log.child('RES-staged').warn('could not detach the RES-staged listener (it will fire harmlessly next turn):', e); }
            resolve(s && s.block ? String(s.block) : '');
        };
        // Re-read the marker rather than trusting the payload — the marker is the contract, the event is
        // only the nudge. A signal for ANOTHER turn (a fence trip mid-wait) simply doesn't match and we
        // keep waiting, which is why the match is on our own fenced identity and not on the payload.
        const onStaged = () => { const s = readDone(); if (s) finish(s); };
        eventSource.on(RES_STAGED_EVENT, onStaged);
        // Race the marker once more AFTER attaching: it could have staged between the check above and
        // the listener going on, and that window is exactly where a lost wakeup lives.
        const raced = readDone();
        if (raced) { finish(raced); return; }
        timer = setTimeout(() => finish(readDone()), timeoutMs);
    });
}

// Register at import (composition root pulls the feature barrel).
if (eventSource) {
    // The SECOND argument (variables_before_update) is passed through — the op diff needs it.
    // The wrapper returns undefined so eventSource.emit never blocks on this handler; the run is
    // tracked by turn for the one caller that must not outrun it (awaitTurnWork above).
    eventSource.on(MVU_VARIABLE_UPDATE_ENDED, (mvuData, variablesBefore) => {
        const run = onVariableUpdateEnded(mvuData, variablesBefore);
        const ctx = chatContext('logic-engine');
        const chat = ctx && ctx.chat;
        const mid = latestAiMessageId(chat);
        if (mid >= 0) trackTurnWork(turnKeyOf(mid, swipeOf(chat, mid)), run);
    });
    if (event_types && event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => {
            if (dryRun) return;
            generationEpoch++;
            setGenerationInFlight(true);
            // A new generation cycle invalidates the turn dedup: a regenerate replaces the latest message in
            // place (same mid, same swipe 0), so a lastHandled hit across cycles is a regenerate that must
            // resolve again, not a relay. Within one cycle the dedup holds.
            lastHandled = '';
            // The staged <RES_Variable> marker is keyed {mid, swipe}, which a regenerate preserves, so the
            // previous take's marker is dropped here (isStagedBlockStale); otherwise the next POST would carry
            // a dead generation's audit into the new reply. A POST still in flight abandons its write at its
            // own turn fence the moment this epoch moves, so nothing it could use is lost.
            const startCtx = chatContext('logic-engine');
            const startChat = startCtx && startCtx.chat;
            if (startChat && isStagedBlockStale(startChat.__mvuResBlock, generationEpoch)) {
                const dead = startChat.__mvuResBlock;
                delete startChat.__mvuResBlock;
                log.domain('pipeline', 'lifecycle', `dropped the staged <${TURN_AUDIT_TAG}> from generation ${dead.epoch} (msg ${dead.mid}:${dead.swipe}) — a new generation starts, so that audit can no longer describe this reply`);
            }
        });
    }
    // Both endings clear it. GENERATION_STOPPED is the user hitting stop — ST does not follow it with
    // GENERATION_ENDED, so listening for ENDED alone would wedge the marker "on" for the rest of the
    // session and the card would trace every page-load preload from then on.
    if (event_types && event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => setGenerationInFlight(false));
    }
    if (event_types && event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, () => setGenerationInFlight(false));
    }
    if (event_types && event_types.CHAT_CHANGED) {
        // mid:swipe keys collide across chats; the load-failure toast is once PER CHAT, so a new
        // card gets told about its own broken engine rather than inheriting the previous card's silence.
        eventSource.on(event_types.CHAT_CHANGED, () => {
            lastHandled = '';
            loadFailureToasted = false;
            relayGuard.clear();   // guard keys carry mid:swipe, which collide across chats
            lastRelayFireKey = '';           // same collision: another chat's msg 3 must not read as served
            replySettle = null;              // and another chat's half-settled reply must not complete here
        });
    }
}
