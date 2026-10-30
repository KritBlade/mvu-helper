// card-sync/card-sync.js — the I/O half of the card→save sync (its decisions are in card-sync-core.js): it fetches the
// lorebook, asks MVU to parse the card's [InitVar], syncs the chat's state with it and the registered sync passes,
// writes each state the sync changed, and logs what it did.
//
// WHY: MVU reads a book's [InitVar] once per chat (it stamps `initialized_lorebooks` and never re-reads), so a running
// game never sees data a later card version adds. This lane re-applies the card's own [InitVar] to the running chat;
// its seed, re-seed and force halves are named in card-sync-core.js. Other features ride the same entry fetch and the
// same write through registerSyncPass (event packs, GameLogic Packs and Plugins), so this lane imports none of them.
//
// WHEN IT RUNS (wired in index.js; a pack install and Re-import from card call syncCardData too):
//   • CHAT_CHANGED — the standalone path: every state a new generation can seed from (shared/generation-floor.js) is
//     read, synced, and written back where the sync changed it. The newest state alone is not enough: a regenerate or
//     swipe of the newest reply starts over from the state before it.
//   • mag_variable_initialized — a fresh game: the blob MVU is about to persist is mutated in place, because a separate
//     write would be overwritten by MVU's own save. Normally a no-op, since a fresh seed already carries everything.
//
// EVERY-LOAD COST: one lorebook read, MVU's parse of [InitVar] into a throwaway object, and a create-only walk of each
// state; a state is written only when the sync changed it. replaceMvuData does not fire VARIABLE_UPDATE_ENDED, so a
// sync write never triggers the RES resolver.
//
// THE WATERMARKS (the version this chat has taken for each force list) live in mvu-helper's own chat-metadata
// namespace, never in the card's stat_data: a platform creates no root in a consumer's tree. They are stamped here, and
// only AFTER the writes they certify have landed: stamped first, a failed write would be remembered as done and its
// force never retried.

import { getStandaloneLorebookEntries } from '../../sillytavern/lorebook.js';
// No toast from this lane for a malformed [InitVar]: MVU raises its own, and a second one would report someone else's
// error twice.
import { getMvu, saveMessageMvuData } from '../../sillytavern/mvu-bridge.js';
import { chatMessages } from '../../sillytavern/chat-context.js';
import { readChatRecord, writeChatRecord } from '../../sillytavern/chat-metadata.js';
import { buildSyncPayload, syncFloorStates, watermarksOf, watermarkStamps, planSyncRetry, isRetryableSkip, isAwaitingMvuInit, SYNC_RETRY_MAX_ATTEMPTS, SYNC_RETRY_DELAY_MS, RETIRED_UPDATE_ENTRY_MATCH, WATERMARK_FIELD } from './card-sync-core.js';
import { createSerialQueue } from '../../shared/serial-queue.js';
import { tailMessagesCarryingVariables } from '../../shared/generation-floor.js';
// Locate an entry by a case-insensitive substring of its comment — the entry is found by NAME, never by position.
import { findEntryByNeedle as findEntry } from '../../shared/card-artifact-store.js';
import { createModuleLog } from '../../sillytavern/log.js';

const log = createModuleLog('card-sync');

// EXTRA SYNC PASSES — registered by index.js, never imported from here.
//
// This lane owns one thing: applying the card's [InitVar] to a running chat. A feature with its own card→save work
// registers a pass instead of being imported, so card-sync stays feature-blind and each pass rides the same entry
// fetch, the same state and the same write.
//
// A pass: (statData, entries) -> { changed, ... }. It mutates statData in place; we own persistence.
const syncPasses = [];   // [{ name, run }]

/** Register an extra pass to run against the same stat_data/entries as the payload apply. */
export function registerSyncPass(name, run) {
    if (typeof run !== 'function') { log.warn(`ignoring sync pass "${name}" — run is not a function`); return; }
    syncPasses.push({ name: String(name || 'unnamed'), run });
}

// Run every registered pass. A throwing pass must NOT abort the others or the payload write, so
// each is isolated and surfaced (never silently swallowed).
function runSyncPasses(statData, entries) {
    const out = { changed: false, reports: [] };
    for (const pass of syncPasses) {
        try {
            const res = pass.run(statData, entries) || {};
            if (res.changed) out.changed = true;
            if (Array.isArray(res.reports)) out.reports.push(...res.reports);
        } catch (e) {
            log.error(`sync pass "${pass.name}" threw — its changes are skipped:`, e);
        }
    }
    return out;
}

// Which skips are worth retrying, and which are an ordinary wait, are decisions, so they live in the pure core where a
// test can reach them (L6), next to planSyncRetry which consumes them. A test reads THIS file and checks every
// classifier still matches a reason it produces.
export { isRetryableSkip, isAwaitingMvuInit };

// Session record of the last COMPLETED sync — a run that reached a real verdict (applied, version-skipped, no
// payload…) rather than bailing on a not-ready. The initial-load kick reads it when it runs out of attempts, to tell
// "I lost the race but CHAT_CHANGED already did the work" (nothing wrong) from "nobody has synced at all" (the case
// worth a warning).
let lastCompletedSync = null;   // { reason: string, applied: boolean }
export function getLastCompletedSync() {
    return lastCompletedSync ? { ...lastCompletedSync } : null;
}

// The DURABLE record that a force version has landed in THIS chat — as opposed to getLastCompletedSync, a SESSION
// record wiped by every page reload. The initial-load kick needs the difference: "no sync completed this session" is
// not evidence that the chat is unsynced. '' when this chat has taken no force version.
export function getSyncWatermark() {
    return readChatRecord()[WATERMARK_FIELD] || '';
}

// ONE SYNC AT A TIME (createSerialQueue has the why). Three hooks kick this on a single page load and a
// sync awaits twice between its read and its write, so unserialized they all read a save none of them has
// written yet and all do the job again — same rows merged N times, same blob written N times, and every
// sync pass's toast fired once per racer. Serialized, the first call does the work and the rest re-read
// what it wrote and take their own no-op paths.
const syncQueue = createSerialQueue();

export async function syncCardData(options = {}) {
    return syncQueue(async () => {
        const result = await runCardDataSync(options);
        if (!isRetryableSkip(result)) {
            lastCompletedSync = { reason: (result && result.reason) || '', applied: Boolean(result && result.applied) };
        }
        return result;
    });
}

// ── the not-ready retry chain ─────────────────────────────────────────────────
//
// ONE chain at a time. A chat switch starts a new one, and the older chain stands down at its next
// checkpoint rather than writing into a save it no longer belongs to — the same stale-target hazard
// the mid-sync fence closes inside a single attempt, applied across attempts.
let syncChainGeneration = 0;

/**
 * Sync ONCE, awaited — then, only if the host was not ready, keep retrying IN THE BACKGROUND (bounded — see
 * planSyncRetry). The CHAT_CHANGED and mag_variable_initialized hooks call this, so a chat that lost the race to a slow
 * TavernHelper/MVU still gets its sync, and a give-up says so in the console.
 *
 * AWAIT THE FIRST ATTEMPT, BACKGROUND THE REST. The chat-load handler awaits this and THEN repaints the LLM, Image and
 * Roster tabs; awaiting the whole chain would make those repaints wait out the retry budget on exactly the slow loads
 * that need it. The retries chase the host on their own time and block nothing.
 *
 * THE RETRY DROPS `mvuData` ON PURPOSE. That blob is the one MVU is about to persist during mag_variable_initialized;
 * by the time a retry runs, MVU has already saved it, so mutating it again would write into an object nothing will
 * store. Attempt 2+ takes the standalone path, which reads the chat's states and writes back itself.
 */
export async function syncCardDataWithRetry(options = {}) {
    const mine = ++syncChainGeneration;
    const first = await syncCardData(options);
    if (isAwaitingMvuInit(first)) {
        log.lifecycle(`this chat has no MVU variables yet (${first.reason}) — MVU initialises them at the `
            + 'first generation (it hooks GENERATION_STARTED / MESSAGE_SENT, not chat load), and its init hook '
            + 'syncs the card payload and pack rows then. Nothing to retry.');
        return first;
    }
    if (isRetryableSkip(first)) void retryUntilReady(mine, first, options);
    return first;
}

async function retryUntilReady(mine, firstResult, options) {
    let result = firstResult;
    for (let attempt = 1; ; attempt++) {
        // Checked on EVERY attempt, not only the first: a chain that starts on "lorebook not ready"
        // can land here the moment the book answers, and the explanation belongs to the verdict, not
        // to which attempt produced it.
        if (isAwaitingMvuInit(result)) {
            log.lifecycle(`this chat has no MVU variables yet (${result.reason}) — MVU initialises them at the `
                + 'first generation (it hooks GENERATION_STARTED / MESSAGE_SENT, not chat load), and its init hook '
                + 'syncs the card payload and pack rows then. Nothing to retry.');
            return result;
        }
        const plan = planSyncRetry({ retryable: isRetryableSkip(result), attempt, superseded: mine !== syncChainGeneration });
        if (plan.giveUp) {
            // The ONE transition worth a warning: something the sync needs never came up, and this chat
            // is now playing WITHOUT whatever the payload and the passes would have merged. Naming the
            // reason matters — "lorebook not ready" and "MVU not ready" have different fixes. The
            // duration is spelled out because it is the number to question when this fires on a heavy
            // install that is merely slow, rather than actually broken.
            const seconds = Math.round((attempt * SYNC_RETRY_DELAY_MS) / 1000);
            log.warn(`data-sync stood down after ${attempt} attempts (~${seconds}s) — still "${(result && result.reason) || 'not ready'}". `
                + 'This chat is running WITHOUT its card payload and pack rows; switching chats (or reloading) retries.');
            return result;
        }
        if (!plan.retry) return result;
        await new Promise((res) => setTimeout(res, plan.delayMs));
        if (mine !== syncChainGeneration) {
            // "a newer SYNC", not "a newer chat": both hooks fire for one fresh chat (CHAT_CHANGED,
            // then mag_variable_initialized), so a chain is routinely superseded WITHIN the same chat.
            // Saying "chat" would send someone hunting a switch that never happened.
            log.verbose(`data-sync retry chain #${mine} superseded by a newer sync — standing down (nothing written)`);
            return result;
        }
        log.verbose(`data-sync retry ${attempt}/${SYNC_RETRY_MAX_ATTEMPTS} — previous verdict: ${(result && result.reason) || '?'}`);
        result = await syncCardData({ ...options, mvuData: null });
    }
}

// The FORCE half's source, REGISTERED rather than imported. force lives in the card registry, which a
// pack feature owns; this lane must stay usable on a card with no pack at all (L4), so it cannot import
// one. Same inversion as registerSyncPass, for the same reason.
// The provider returns { version, force, forceFromInitVar } or null.
let forcePayloadProvider = null;
export function registerForcePayloadProvider(fn) {
    if (typeof fn === 'function') forcePayloadProvider = fn;
}

// Ask MVU to read and parse the card's [InitVar] — its format, its parser (see card-sync-core's header) — from the
// card's standalone lorebook. The parsed tree, or null when no [InitVar] exists anywhere (a non-MVU card: nothing to
// seed, and that is not a fault) or MVU cannot parse it (logged). The Roster tab's "Reset to the card's look" reads a
// character's seeded record from it.
export async function readCardSeed() {
    const Mvu = getMvu();
    if (!Mvu || typeof Mvu.reloadInitVar !== 'function') return null;
    // A throwaway MVU blob. `initialized_lorebooks: {}` is what makes MVU read every book rather than
    // skip the ones this chat has already consumed — the one-shot stamp is exactly what this lane exists
    // to work around, so it must NOT be inherited from the live chat.
    const probe = { stat_data: {}, display_data: {}, delta_data: {}, initialized_lorebooks: {} };
    let changed = false;
    try { changed = await Mvu.reloadInitVar(probe); }
    catch (e) {
        // MVU raises its own toast for a malformed [InitVar], so this is the console half only.
        log.warn("the card's [InitVar] could not be parsed by MVU — nothing is seeded from it this time:", e);
        return null;
    }
    return changed && Object.keys(probe.stat_data || {}).length ? probe.stat_data : null;
}

// The assembled payload: the card's [InitVar] and the registered force record. null when there is no [InitVar].
async function readInitVarSeed(entries) {
    const seed = await readCardSeed();
    if (!seed) return null;

    let forceRecord = null;
    if (forcePayloadProvider) {
        try { forceRecord = forcePayloadProvider(entries); }
        catch (e) { log.warn('the force-payload provider threw — force is skipped this load:', e); }
    }
    // The record goes in whole (version, force, forceFromInitVar), so a list the provider adds needs no line here.
    return buildSyncPayload({ ...forceRecord, seed });
}

// One sync: the card's [InitVar] and the registered passes, applied to the chat's state. `mvuData` is the blob
// mag_variable_initialized provides (mutated in place; MVU persists it); without it, the standalone path reads and
// writes the chat's states itself. Returns the newest state's report (plus `eventPacks`, the passes' result), or a
// { skipped, reason } shell when nothing ran.
//
// LOREBOOK SOURCE: the passes read the STANDALONE worldbook only. The embedded character_book is the import-time
// snapshot, so reading it would apply stale entries over the user's live edits; "book not queryable yet" is a
// retryable not-ready, never a fall-back to the snapshot. The seed itself is read by MVU (readCardSeed).
async function runCardDataSync({ mvuData = null } = {}) {
    try {
        const entries = await getStandaloneLorebookEntries();
        if (entries === null) return { skipped: true, reason: 'lorebook not ready' };

        // Nothing reads an [MVU_Update_Data] entry: said once per sync, so nobody hand-edits an entry that governs
        // nothing (it is the user's to delete).
        if (findEntry(entries, RETIRED_UPDATE_ENTRY_MATCH)) {
            log.warn('an [MVU_Update_Data] entry is on this card and is NOT read any more — the seed comes '
                + 'from [InitVar] itself now, and the force lane from the pack registry. It is inert; delete it.');
        }

        // SEED — ask MVU to parse its OWN format rather than re-implementing JSON5 + wrappers + macros
        // + multi-entry merge. Against a THROWAWAY object: measured to read books only and leave the
        // live chat untouched. `changed:false` means no book had an [InitVar] to read.
        const payload = await readInitVarSeed(entries);
        const watermarks = watermarksOf(readChatRecord());
        const runPasses = (statData) => runSyncPasses(statData, entries);
        const stamp = (report) => {
            const stamps = watermarkStamps(report);
            if (Object.keys(stamps).length) writeChatRecord(stamps);
        };

        // PIGGYBACK path (fresh init): apply onto the very blob MVU is about to persist.
        // The stamp rides MVU's own save (chat_metadata is part of the chat file), so there is nothing
        // to await here. If that persist were to fail, the payload simply re-applies next load — its
        // seed is create-only, so a repeat is a no-op on a state that already carries it.
        if (mvuData && typeof mvuData === 'object') {
            const [{ report }] = syncFloorStates([{ id: 0, statData: mvuData.stat_data }], payload, watermarks, runPasses);
            stamp(report);
            if (payload) logReport(report, '(init blob)');
            return report;
        }

        // STANDALONE path (warm open): read every state a new generation can seed from, sync them (syncFloorStates
        // says which half goes where), and write back each one the sync changed. The newest one's report is the
        // verdict; another state's line is logged only when it took something.
        const Mvu = getMvu();
        const chat = chatMessages('card-sync');
        if (!Mvu || typeof Mvu.getMvuData !== 'function' || typeof Mvu.replaceMvuData !== 'function' || !chat.length) {
            return { skipped: true, reason: 'MVU not ready' };
        }
        const length = chat.length;
        const floors = [];
        for (const id of tailMessagesCarryingVariables(chat, 2)) {
            const data = await Mvu.getMvuData({ type: 'message', message_id: id });
            if (data && typeof data === 'object' && data.stat_data) floors.push({ id, data });
        }
        if (!floors.length) return { skipped: true, reason: 'no stat_data on msg ' + (length - 1) };
        const synced = syncFloorStates(floors.map(({ id, data }) => ({ id, statData: data.stat_data })), payload, watermarks, runPasses);
        for (const [index, { id, report, isChanged }] of synced.entries()) {
            if (isChanged) {
                // STALE-TARGET FENCE: a chat that switched or grew since its states were read holds other ones now;
                // writing would land the sync in an old message's snapshot. The attempt stands down, and the retry or
                // the next chat load runs against the chat as it is.
                if (chatMessages('card-sync') !== chat || chat.length !== length) {
                    return { skipped: true, reason: 'chat changed mid-sync (msg ' + id + ' was not written)' };
                }
                await saveMessageMvuData(floors[index].data, id, { writer: 'card-sync' });
            }
            if (payload && (index === 0 || isChanged)) logReport(report, '(msg ' + id + ')');
        }
        const verdict = synced[0].report;
        // AFTER every write, never before — see the watermark note in this file's header.
        stamp(verdict);
        return verdict;
    } catch (e) {
        log.error('data-sync failed (non-fatal — game continues on its current data):', e);
        return { skipped: true, reason: 'error' };
    }
}

// One forceFromInitVar entry as the log names it: how many of the card's rows replaced the chat's, which ones, and how
// many rows only the chat holds (another pack's, kept).
function describeForcedFromInitVar(entry) {
    if (!entry.isTable) return `${entry.path} ${entry.replaced.length ? 'replaced' : "already the card's"}`;
    const which = entry.replaced.length ? ` (${entry.replaced.join(', ')})` : '';
    return `${entry.path} ${entry.replaced.length} of ${entry.cardRows} rows replaced${which}, ${entry.keptRows} not on the card kept`;
}

// Names every half, always, and what each did: a line that printed only what changed would read a skipped force as
// "force ran and found nothing to do". Each force list is gated on its own watermark, so each says SKIPPED on its own.
function logReport(report, where) {
    if (report.applied) {
        const seed = report.added.length ? `${report.added.length} (${report.added.join(', ')})` : 'nothing new';
        const reseed = report.reseeded.length ? `${report.reseeded.length} replaced (${report.reseeded.join(', ')})`
            : (report.didFingerprintsMove ? 'fingerprints recorded, nothing replaced' : 'nothing to replace');
        // 'nothing pushed' when the pack lists no path, or every listed one was blocked — the warn line below names those.
        const fromInitVar = report.forceFromInitVarSkipReason ? `SKIPPED — ${report.forceFromInitVarSkipReason}`
            : (report.forcedFromInitVar.length ? report.forcedFromInitVar.map(describeForcedFromInitVar).join('; ') : 'nothing pushed');
        const map = report.isForceSkipped ? `SKIPPED — ${report.reason}`
            : (report.forced.length ? `${report.forced.length} (${report.forced.join(', ')})` : 'nothing to force');
        log.lifecycle(`sync v${report.version} ${where} — seed: ${seed} · re-seed: ${reseed} · force from [InitVar]: ${fromInitVar} · force map: ${map}`);
        if (report.blocked.length) log.warn('sync blocked paths:', report.blocked.join(', '));
    } else {
        const pushSkip = report.forceFromInitVarSkipReason ? ` · force from [InitVar] skipped: ${report.forceFromInitVarSkipReason}` : '';
        log.lifecycle(`sync nothing applied ${where} — ${report.reason}${pushSkip}`);
    }
}
