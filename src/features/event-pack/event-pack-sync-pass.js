// event-pack/event-pack-sync-pass.js — the event-pack half of the on-load card→save sync.
//
// WHY IT LIVES HERE, NOT IN card-sync/: this is registry parsing, pack reconciliation and
// event-pack-specific toasts — event-pack knowledge, top to bottom. It used to sit inside
// card-sync/card-sync.js, which made the generic [MVU_Update_Data] sync import the event-pack
// feature: a lower/shared lane reaching UP into a feature, the dependency direction the folder
// rules exist to prevent. card-sync now exposes registerSyncPass() and index.js registers this,
// so card-sync knows only its own payload format and event-pack owns its own logic.
//
// The pass MUTATES statData in place and returns { changed, reports }; card-sync owns persistence,
// so the pack merge still shares ONE write with the payload apply (unchanged behaviour).
//
// It has a SECOND entry point below — ensureEventPackRowsOnGenerationFloor — for the floors a new
// generation seeds from, which the on-load pass alone cannot reach. Its header has the why.

import { parseRegistry, reconcileEventPacks, planScanRefusalNotice, packSyncToasts, REGISTRY_ENTRY_MATCH, parseEventPacks, applyEventPacks, installedPacksToEnsure, armedPointerShapeProblem } from './event-pack-core.js';
import { loadLogicEngine } from '../logic-engine/index.js';
import { readCardEventContract } from './event-pack-install.js';
import { findEntryByNeedle as findEntry } from '../../shared/card-artifact-store.js';
import { tailMessagesCarryingVariables } from '../../shared/generation-floor.js';
import { getStandaloneLorebookEntries } from '../../sillytavern/lorebook.js';
import { getMvu, toast, saveMessageMvuData } from '../../sillytavern/mvu-bridge.js';
import { createModuleLog } from '../../sillytavern/log.js';

const log = createModuleLog('event-pack');

// The engine refusal already announced, so an unchanged one does not re-toast on every pass. Module
// scope, not per-chat: the fault is the CARD's, and the packs it names travel with the card, so the
// same news across two chats of one card is still one piece of news. See planScanRefusalNotice.
let lastAnnouncedRefusal = null;

// [MVU_Event_Pack] scan (§5.5, plans/event-pack-plan.md): registry-driven reconciliation of
// tab-installed community packs into stat_data.EventPack. No registry entry ⇒ inert — only the
// P3 tab creates registry records, so hand-pasted pack entries never reach the trigger table.
export function scanEventPacks(statData, entries) {
    const regEntry = findEntry(entries, REGISTRY_ENTRY_MATCH);
    if (!regEntry) return { changed: false, reports: [] };
    let registry;
    try { registry = parseRegistry(regEntry.content); }
    catch (e) {
        // A broken registry must never be destructive (pruning on a typo would wipe live rows) — report and stand down.
        log.child('registry').error('entry is malformed — pack scan skipped:', e);
        toast('error', 'Event-pack registry is malformed — pack scan skipped (see console).');
        return { changed: false, reports: [] };
    }
    // §3.1a P4a — the COMPAT GATE's card side. `cardFormat` must never default to mvu-helper's own
    // SUPPORTED_FORMAT, which answers the wrong question: mvu-helper updates independently of a card
    // carrying an older engine, so "can mvu-helper parse this pack" is not "can this card's engine
    // RUN it". The engine declares its own level. ABSENT ⇒ "1.0" LITERALLY: an engine that declares
    // no format predates the marker, so it is 1.0 by definition. After P7 bumps SUPPORTED_FORMAT to
    // "2.0", defaulting to it instead would tell every pre-P7 card it can run 2.0 packs — the failure
    // this gate exists to stop, and it would fail SILENTLY (pack installs, event never fires).
    const contract = readCardEventContract();
    const cardFormat = contract.format || '1.0';
    // §4.8 P4b — WHERE this card's engine keeps event state. NO FALLBACK (decision 2026-08-05): these
    // used to be a constant inside event-pack-core, a third spelling of what globalLogic's adapter
    // already owns, and a disagreement is SILENT — rows merged into a table the engine never reads,
    // pack "installed", nothing ever fires. Unlike the format above there is no honest default to
    // reach for: an engine that declares no paths tells us nothing about where its state lives, so
    // guessing would re-open the exact hole. Stand down instead, and name the fix.
    //
    // The refusal QUOTES the verdict's own reason rather than a generic "missing paths": the three
    // ways this fails (no engine loaded · engine declares no adapter · a malformed path) have three
    // different fixes, and telling someone with a typo to install an engine sends them at the wrong one.
    const paths = contract.paths;
    // WHAT the refusal is worth SAYING is a separate decision from the refusal itself — see
    // planScanRefusalNotice for the two situations this used to shout in wrongly (zero packs · every pass).
    const ids = Object.keys(registry).sort();
    const packCount = ids.length;
    const notice = planScanRefusalNotice({
        packCount,
        refusal: paths.ok ? null : `${ids.join(',')}\n${paths.reason}`,
        lastAnnounced: lastAnnouncedRefusal,
    });
    lastAnnouncedRefusal = notice.lastAnnounced;
    if (!paths.ok) {
        const packs = `${packCount} event pack${packCount === 1 ? '' : 's'}`;
        if (notice.level === 'error') {
            log.error(`${packs} NOT placed — ${paths.reason}. They stay installed and merge again once this card has a readable engine; uninstall them in the EventPack tab if that is not coming.`);
        } else if (notice.level === 'verbose') {
            log.verbose(`scan stood down (nothing installed) — ${paths.reason}`);
        }
        if (notice.toast) toast('error', `${packs} not placed: ${paths.reason}`);
        return { changed: false, reports: [] };
    }
    // The armed pointer's ONE shape (armedPointerShapeProblem). An install onto the wrong shape is
    // refused, so this catches what install cannot: the card's engine changed AFTER its packs landed.
    // The rows still merge — a same-reply pick plays a body without its gate — but nothing armed for
    // the next reply can ever open, so it is an error on every pass that has packs to play.
    const armedProblem = armedPointerShapeProblem(statData, paths.armedPath);
    if (armedProblem && packCount) {
        log.error(`${packCount} installed event pack${packCount === 1 ? '' : 's'} cannot play an armed event — ${armedProblem}. The fix is the card's engine: it must store the armed event as a [value, label] pair.`);
    }
    // The paths this card lets a pack WRITE. Unlike the event-state paths this is NOT fatal: without it
    // we simply cannot answer "may this pack write there", and refusing every pack over a question we
    // could not ask would be worse than the fire-time "WRITE REFUSED" line the engine logs.
    // `undefined` ⇒ the check stands down; a declared list ⇒ per-pack warnings on the mismatch.
    const writes = contract.writes;
    if (!writes.ok) log.warn(`write-path check skipped — ${writes.reason}`);
    // The scope values the card distinguishes, same standing: a declared list ⇒ per-row warnings on a
    // value the card never spelled; none declared ⇒ said once here, and the check stands down.
    const scopes = contract.scopes;
    if (!scopes.ok) log.warn(`scope check skipped — ${scopes.reason}`);
    const result = reconcileEventPacks(statData, registry, entries, {
        cardFormat, triggerRoot: paths.triggerRoot, armedPath: paths.armedPath,
        cardWrites: writes.ok ? writes.writes : undefined,
        cardScopes: scopes.ok ? scopes.scopes : undefined,
    });
    for (const r of result.reports) {
        if (r.action === 'merged') {
            log.lifecycle(`${r.packId} v${r.version} installed — rows: ${r.added.join(', ')}` +
                (r.removed.length ? ` · removed: ${r.removed.join(', ')}` : ''));
        } else if (r.action === 'error') {
            log.warn(`${r.packId} skipped:`, r.errors.join(' · '));
        } else if (r.action === 'incompatible') {
            log.warn(`${r.packId} NOT installed — ${r.reason}`);
        } else if (r.action === 'malformed') {
            log.warn(`${r.packId} entry did not parse:`, r.error);
        } else if (r.changed) {                                // disabled / missing / uninstalled — log only on the pruning transition
            log.lifecycle(`${r.packId} ${r.action} — pruned: ${r.removed.length ? r.removed.join(', ') : '(no rows in this chat)'}` +
                (r.clearedArmed ? ` · cleared armed "${r.clearedArmed}"` : ''));
            if (r.action === 'missing') log.warn(`${r.packId}: entry not found — reinstall or remove it in the EventPack tab`);
        }
        if (r.warnings && r.warnings.length) log.warn(`${r.packId} warnings:`, r.warnings.join(' · '));
    }
    for (const t of packSyncToasts(result.reports)) toast(t.level, t.message);
    return result;
}

// ── the before-generation row ensure (live 2026-09-05) ───────────────────────
//
// The pass above merges into whatever message card-sync happens to be holding — in practice the
// LATEST one. That is enough for a pack installed mid-chat and then PLAYED, because the next reply
// inherits from the message the rows landed on. It is not enough for any gesture that seeds a reply
// from an EARLIER floor: a regenerate re-seeds the message being replaced from the one before it,
// and a delete-then-send seeds from whatever survived. Those floors predate the install, so the rows
// are simply gone, and nothing re-runs the scan until the next chat load.
//
// Measured: a pack installed at page load merged its four rows ("test.series v1.1 installed — rows:
// …"), the very next gesture was a regenerate, and the rows were absent from every message
// afterwards. The engine can only arm a key it can see in the trigger table, so nothing armed,
// the EJS gate on the armed key never opened, and the pack's prose never reached the narrator —
// with no error anywhere, because nothing had failed. The rows had been correct and were rebuilt away.
//
// Same shape and same hook as the plugin drawer ensure beside it, for the same reason: create the
// state on every floor a new generation can seed from (tailMessagesCarryingVariables has the case
// table). Deliberately NARROWER than the chat-load pass — merge only, no prune, no toasts, no
// refusal notices. Pruning answers "was this uninstalled elsewhere", which cannot become true
// between two replies of one chat; the toasts and refusals are chat-load news and repeating them
// every turn is noise. A card with no packs pays one lorebook read and stops at the registry.
//
// EVERY installed pack, not the newest one: a card can carry several (a long route is authored as
// several chained packs), they all merge from the one registry, and applyEventPacks already takes
// the whole list — so one call covers the lot and its per-pack version compare keeps each one a
// no-op once its rows are present.
export async function ensureEventPackRowsOnGenerationFloor() {
    try {
        const entries = await getStandaloneLorebookEntries();
        if (entries === null) return;                        // lorebook not up yet — chat load will do it
        const regEntry = findEntry(entries, REGISTRY_ENTRY_MATCH);
        if (!regEntry) return;                               // no packs were ever installed on this card
        let registry;
        try { registry = parseRegistry(regEntry.content); }
        catch (e) {
            // The chat-load pass toasts this and stands down; here it is the same standing fault, so
            // it is logged (never swallowed) and nothing is written on a registry we cannot read.
            log.warn('registry unreadable — before-generation ensure skipped:', e);
            return;
        }
        if (!Object.keys(registry).length) return;

        // THIS AWAIT IS LOAD-BEARING, and it is what makes the read below correct BY CONSTRUCTION
        // rather than by timing. loadLogicEngine chains behind any in-flight load and settles on both
        // outcomes, and it re-reads the engine entry on every call before its same-bytes skip — so
        // after it there are exactly three cases and no fourth:
        //   1. a load was in flight     ⇒ we waited, and read the settled one
        //   2. no load, bytes unchanged ⇒ the skip returns at once, the contract is already correct
        //   3. genuinely no engine      ⇒ the contract refuses, which is RIGHT: resolveTurn does not
        //                                 run either (the turn runner gates on the same load status)
        // "The engine finished loading just after we stood down" is thereby eliminated, not merely
        // made unlikely. Cost when nothing is in flight is a resolved promise and a byte comparison —
        // no worker call, no re-evaluation — which is what lets it sit inside the turn.
        //
        // SAME-REPLY: seeding now reads the SAME state resolveTurn will resolve from, where the old
        // header parse read the STORED entry while resolveTurn called the LOADED engine. Two sources
        // that could disagree became one that cannot.
        await loadLogicEngine();
        const contract = readCardEventContract();
        const paths = contract.paths;
        // NO FALLBACK and NO NOISE: without a declared path we do not know where this engine keeps
        // event state, and guessing merges rows into a table nothing reads. The chat-load pass already
        // said so loudly — this one is a per-turn hook and must not repeat it every generation.
        if (!paths.ok) return;
        const cardFormat = contract.format || '1.0';
        const writes = contract.writes;
        const scopes = contract.scopes;
        const packs = installedPacksToEnsure(registry, parseEventPacks(entries).packs);
        if (!packs.length) return;

        const Mvu = getMvu();
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        const chat = ctx && ctx.chat;
        if (!Mvu || typeof Mvu.getMvuData !== 'function' || typeof Mvu.replaceMvuData !== 'function' || !Array.isArray(chat)) return;

        const floorLength = chat.length;
        for (const id of tailMessagesCarryingVariables(chat, 2)) {
            const data = await Mvu.getMvuData({ type: 'message', message_id: id });
            if (!data || typeof data !== 'object' || !data.stat_data) continue;
            const res = applyEventPacks(data.stat_data, packs, {
                cardFormat, triggerRoot: paths.triggerRoot, armedPath: paths.armedPath,
                cardWrites: writes.ok ? writes.writes : undefined,
                cardScopes: scopes.ok ? scopes.scopes : undefined,
            });
            if (!res.changed) continue;                      // the floor already carries them — the common case
            // STALE-TARGET FENCE: a chat that grew or switched between the read and this write would
            // land the rows in history instead of on the floor this reply seeds from.
            if (ctx.chat.length !== floorLength) return;
            await saveMessageMvuData(data, id, { writer: 'event-pack' });
            const merged = res.reports.filter((r) => r.applied);
            log.lifecycle('refreshed ' + merged.length + ' pack'
                + (merged.length === 1 ? '' : 's') + ' on msg ' + id + ' before generation ('
                + merged.map((r) => r.packId + ': ' + r.added.join(', ')).join(' · ')
                + ') — this floor did not carry the rows the installed pack declares');
        }
    } catch (e) {
        log.warn('before-generation row ensure failed (non-fatal — the turn continues):', e);
    }
}
