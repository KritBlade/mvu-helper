// gamelogic-pack/gamelogic-pack-activation.js — the per-CARD half of the pack lifecycle:
// activate / repair / upgrade / switch / uninstall, and the per-chat-load cache-rebuild pass.
//
// Every DECISION is pure and lives in gamelogic-pack-core.js (decideActivation, planInstallEntries,
// packStateRecord) or, shared with the other artifact types, in shared/card-artifact-store.js
// (uninstallExactness, deriveArtifactLed); this file reads state, calls the decision, and performs the
// writes it dictates — the event-pack-ui ↔ event-pack-core split, kept deliberately: event-pack runs
// its lifecycle on the same shared helper, so the seams must match.
//
// SCRIPT-API PRECONDITION: a pack that ships a `schema` needs the TavernHelper script API for BOTH
// the conflict check and the write. When the API is not attached, activation of such a pack REFUSES
// — "could not look" must never be read as "no Scheme script here": mvu-helper initialises before
// TavernHelper attaches, so an early read finds nothing. Packs without a schema don't touch scripts
// and skip the precondition.

import {
    upsertLorebookEntryFields,
    deleteLorebookEntriesByNeedle,
    flushLorebookWrites,
    getPrimaryLorebookName,
} from '../../sillytavern/lorebook.js';
import { readCardAccess } from '../../sillytavern/card-access.js';
import { cardAccessProblem, cardUnreadableReason } from '../../sillytavern/card-access-core.js';
import { toast, getMvu } from '../../sillytavern/mvu-bridge.js';
import {
    SCRIPT_SCOPE_CHARACTER,
    getScriptTrees,
    upsertScript,
    deleteScript,
    isScriptApiAvailable,
} from '../../sillytavern/tavern-script.js';
import { findScriptByName } from '../../sillytavern/tavern-script-core.js';
import {
    REGEX_SCOPE_CHARACTER,
    isRegexApiAvailable,
    listRegexNames,
    getRegexes,
    persistedCharacterRegexNames,
    unchangedCharacterRegexNames,
    syncRegexes,
    deleteRegexesByName,
    refreshRegexUi,
} from '../../sillytavern/tavern-regex.js';
import { regexUninstallExactness } from '../../sillytavern/tavern-regex-core.js';
import { dialogLineText } from '../../sillytavern/popup-core.js';
import { writeEngineCode, clearEngineCode, loadLogicEngine, readMenuEngineExportsInWorker } from '../logic-engine/index.js';
import { syncCardData } from '../card-sync/index.js';
import { createModuleLog } from '../../sillytavern/log.js';
import {
    SCHEMA_SCRIPT_NAME,
    packRegistryComment, packRegistryMatch, parsePackRegistry, buildPackRegistryContent,
    decideActivation, planInstallEntries, packStateRecord, packForcePayload,
    judgePackFile, decideMvuSchemaLag, buildPackExportFile, finishArtifactExport,
} from './gamelogic-pack-core.js';
import {
    findEntryByNeedle, commentsMatchingNeedle,
    installedSweepNeedle, preDeleteNeedles, uninstallExactness, registryRemovalOutcome,
    artifactIdentityRecord, slotFingerprint,
} from '../../shared/card-artifact-store.js';
import { readLibraryPack } from './gamelogic-pack-library.js';

const log = createModuleLog('gamelogic-pack');

const PACK_TYPE = 'gamelogic';   // this lifecycle's artifact type; every other type runs its own lifecycle.

// ── card-state reads ─────────────────────────────────────────────────────────

// The card's registry record, or null when none / not readable. `entries` is passed in when the
// caller already fetched them (one read per operation, not one per question).
// Throws ONLY through the malformed path? No — malformed parses are reported and returned as
// { error } so callers stand down without a try/catch at every site.
export function readPackRegistryFrom(entries) {
    const entry = findEntryByNeedle(entries, packRegistryMatch(PACK_TYPE));
    if (!entry) return { registry: null, error: '' };
    try { return { registry: parsePackRegistry(entry.content), error: '' }; }
    catch (e) {
        // A broken registry must never read as "no pack active" — a sweep or init off that misreading
        // would be destructive off a typo (same stance as event-pack's malformed-registry path).
        log.error('the ' + packRegistryComment(PACK_TYPE) + ' entry is malformed — pack operations stand down:', e);
        return { registry: null, error: 'the ' + packRegistryComment(PACK_TYPE) + ' entry is malformed (see console) — fix or delete it first' };
    }
}

// Everything decideActivation needs, read in one pass. scriptApiUp says whether the script API is
// attached; cardSchemeText is only meaningful when it is (the SCRIPT-API PRECONDITION made explicit).
//
// The three unowned surfaces are read as CONTENT, not as booleans, because engine/schema/regex
// ownership has three answers and not two: a card carrying bytes identical to the pack's is a card the
// pack can adopt without overwriting anything (unownedSurfaceVerdict). Presence alone cannot tell
// those apart.
//
// `pack` is optional and only used to answer the regex half — which of THIS pack's regexes the card
// already matches. Callers with no pack in hand (the tab's status read) pass nothing and get null,
// which counts every clash as differing: the direction that asks rather than claims.
export async function readCardPackState(pack = null) {
    // The three access facts come from the ONE shared read (card-access.js) — lanes that derive them
    // locally each conflate them differently, and every such conflation is a bug.
    const { entries, isCardOpen, isChatStarted, areEntriesReadable, canOperateOnCard, bookBinding, bookName, canLinkExistingBook } = await readCardAccess();
    const { registry, error } = entries === null ? { registry: null, error: '' } : readPackRegistryFrom(entries);
    // The entry's CONTENT, from the same `entries` read as the registry — writeEngineCode stores the
    // pack's engine text verbatim, so this compares like for like. readEngineCode() would be a SECOND
    // read, and two reads that can disagree is exactly how an adoption check claims a surface it never
    // actually looked at.
    const engineEntry = findEntryByNeedle(entries, '[mvu_logicengine]');
    const cardEngineText = engineEntry ? String(engineEntry.content || '') : null;
    const scriptApiUp = isScriptApiAvailable();
    const cardSchemeScript = scriptApiUp
        ? findScriptByName(await getScriptTrees(SCRIPT_SCOPE_CHARACTER), SCHEMA_SCRIPT_NAME)
        : null;
    const cardSchemeText = cardSchemeScript ? String(cardSchemeScript.content || '') : null;
    // Same "could not look ≠ nothing there" rule as the script surface: an empty list from a detached
    // API would read as "no colliding regex on this card" and let an overwrite through, so the availability
    // is reported separately and the conflict check is only trusted when it is true.
    const regexApiUp = isRegexApiAvailable();
    // READ THE CARD, NOT THE COPY OF IT. listRegexNames goes through TavernHelper, which reads
    // `characters[id].data.extensions.regex_scripts` — the IN-MEMORY object. A write that never reached
    // disk still reads back from there as installed, so the pack tab would say Installed and offer no Repair
    // button for a card whose regexes are gone the moment it reloads. The state this panel reports has
    // to be the state that survives a reload. Falls back to the in-memory read ONLY when the card itself
    // cannot be read — "could not look" must not turn into "the card has none", which would report every
    // regex as missing and offer a Repair that repairs nothing. With no card open (the lobby) there is no card to
    // read: it has no regexes, and nothing is read.
    const persisted = (regexApiUp && isCardOpen) ? await persistedCharacterRegexNames() : [];
    const cardRegexNames = persisted !== null ? persisted : await listRegexNames(REGEX_SCOPE_CHARACTER);
    // The regex adoption half — only askable with a pack in hand, since the question is "which of THESE".
    const wantsRegex = Boolean(pack && Array.isArray(pack.regex) && pack.regex.length);
    const unchangedRegexNames = (regexApiUp && wantsRegex) ? await unchangedCharacterRegexNames(pack.regex) : null;
    return {
        isCardOpen, isChatStarted, areEntriesReadable, canOperateOnCard, bookBinding, bookName, canLinkExistingBook,
        entries, registry, registryError: error, cardEngineText,
        scriptApiUp, cardSchemeText, regexApiUp, cardRegexNames, unchangedRegexNames,
    };
}

// ── the lifecycle operations ─────────────────────────────────────────────────

// Activate a library pack on the current card. `confirmDowngrade` acknowledges a downgrade.
// Returns { ok, action, reasons } — reasons carry the named refusal(s) on ok:false.
export async function activatePack(id, { confirmDowngrade = false, sections = null, adopt = false } = {}) {
    const text = await readLibraryPack(PACK_TYPE, id);
    if (text === null) return { ok: false, action: 'missing', reasons: ['"' + id + '" is not in the library (or the library book is not readable)'] };

    // Judged AGAIN — the library entry is hand-editable, so trusting the import-time judgement
    // would let an edit skip every rule.
    const file = await judgePackFile(text, { readMenuEngine: readMenuEngineExportsInWorker });
    if (!file.ok) return { ok: false, action: 'invalid', reasons: file.errors };
    const pack = file.pack;

    const state = await readCardPackState(pack);
    if (state.registryError) return { ok: false, action: 'registry-malformed', reasons: [state.registryError] };

    // A schema-shipping pack cannot be activated while the script surface is invisible: the Scheme
    // conflict check would be a guess, and the write would land in nothing.
    if (pack.schema !== undefined && !state.scriptApiUp) {
        return { ok: false, action: 'script-api-unavailable', reasons: ['this pack ships a schema, and the TavernHelper script API is not attached yet — cannot check for a card-owned "Scheme" script or write ours. Retry in a moment.'] };
    }

    // The same precondition for the regex surface — and it is NOT covered by the script one: the two
    // APIs attach independently, so a pack shipping regexes must ask about regexes.
    if (Array.isArray(pack.regex) && pack.regex.length && !state.regexApiUp) {
        return { ok: false, action: 'regex-api-unavailable', reasons: ['this pack ships ' + pack.regex.length + ' regex(es), and the TavernHelper regex API is not attached yet — cannot check for card-owned regexes of the same name or write ours. Retry in a moment.'] };
    }

    const decision = decideActivation({
        isCardOpen: state.isCardOpen, isChatStarted: state.isChatStarted,
        areEntriesReadable: state.areEntriesReadable, bookBinding: state.bookBinding, bookName: state.bookName,
        pack, registry: state.registry,
        cardEngineText: state.cardEngineText, cardSchemeText: state.cardSchemeText,
        cardRegexNames: state.cardRegexNames, unchangedRegexNames: state.unchangedRegexNames,
        allowAdopt: adopt,
    });
    if (decision.action === 'no-chat' || decision.action === 'card-unreadable'
        || decision.action === 'needs-adopt' || decision.action === 'switch-needed') {
        return {
            ok: false, action: decision.action, reasons: decision.reasons, adoptable: decision.adoptable || [],
            version: String(pack.version || ''), active: decision.active,
        };
    }
    if (decision.action === 'downgrade' && !confirmDowngrade) {
        return {
            ok: false, action: 'downgrade', reasons: decision.reasons,
            installedVersion: decision.installedVersion, libraryVersion: decision.libraryVersion,
        };
    }
    // ON THE RECORD, always — adoption is not bookkeeping. Claiming a surface makes it pack-owned, and
    // uninstall deletes what it owns, so a card that ARRIVED carrying a `Scheme` will lose that script
    // when this pack is uninstalled. Identical bytes make the claim lossless; they do not make the
    // consequence invisible, so it is never a silent registry write.
    if (decision.claimed && decision.claimed.length) {
        log.lifecycle('"' + pack.id + '" ADOPTED ' + decision.claimed.length
            + ' unowned surface(s) already identical to what it ships — ' + decision.claimed.join(' · ')
            + '. They are pack-owned from now on, which means this pack\'s uninstall removes them.');
    }
    if (adopt && decision.adoptable && decision.adoptable.length) {
        log.lifecycle('"' + pack.id + '" ADOPTED ' + decision.adoptable.length
            + ' unowned surface(s) that DIFFERED, on an explicit Adopt — ' + decision.adoptable.map(dialogLineText).join(' · ')
            + '. The card\'s versions are replaced by the pack\'s.');
    }

    // What the schema allow-list removed is written nowhere, so it is said here, line by line, and the
    // result carries it for the install toast.
    for (const r of file.schemaRemovals) {
        log.warn('"' + pack.id + '" schema line ' + r.line + ' removed (not on the schema allow-list): ' + r.what + ' — ' + r.why);
    }
    const written = await writeActivation(pack, state, decision.action, sections);
    return { ...written, schemaRemovals: file.schemaRemovals };
}

// Is this pack waiting on an ADOPT, and for what? READ-ONLY — the standing question the dev loop's
// status line asks on every packs-tab repaint, so it may not write, activate, or reload anything.
//
// Returns the one-line summary, or '' when there is nothing to adopt (including every reason the pack
// could not be read at all — an unreadable library or a card mid-load is not an adoption question, and
// answering one with the other is how a status line ends up naming a fix that fixes nothing).
export async function packAdoptionPending(id) {
    const text = await readLibraryPack(PACK_TYPE, id);
    if (text === null) return '';
    const file = await judgePackFile(text, { readMenuEngine: readMenuEngineExportsInWorker });
    if (!file.ok) return '';
    const pack = file.pack;
    const state = await readCardPackState(pack);
    if (state.registryError) return '';
    const decision = decideActivation({
        isCardOpen: state.isCardOpen, isChatStarted: state.isChatStarted,
        areEntriesReadable: state.areEntriesReadable, bookBinding: state.bookBinding, bookName: state.bookName,
        pack, registry: state.registry,
        cardEngineText: state.cardEngineText, cardSchemeText: state.cardSchemeText,
        cardRegexNames: state.cardRegexNames, unchangedRegexNames: state.unchangedRegexNames,
    });
    if (decision.action !== 'needs-adopt') return '';
    return 'this card owns ' + decision.adoptable.length + ' surface(s) the pack writes differently';
}

// The shared write path for activate / repair / upgrade / downgrade / switch-arrival. One function,
// because upgrade is NEVER uninstall+install — it is "delete the recorded entries, write the new
// pieces, bump ver", which is exactly this with a pre-delete.
//
// `sections` (the dev loop's per-sink apply): null/undefined = write everything — every non-dev
// caller. A Set/array of section names ('entries', 'engine', 'schema', 'regex') writes ONLY those
// blocks; the registry is still written, inheriting the untouched sections' prior record, so
// uninstall/export stay exact. The masking exists because the regex block's apply ends in a chat
// reload, and an engine-only dev save that paid for that reload would kill in-flight turns. Same
// write path masked, never a second one.
async function writeActivation(pack, state, action, sections = null) {
    const doSection = (name) => !sections || (Array.isArray(sections) ? sections.includes(name) : sections.has(name));
    // `panel/` and `entries/` share ONE sink, because the panel declaration IS installed as an entry
    // (planInstallEntries). Two source directories, one write path — so a panel-only save must open
    // the entry block or it would apply nothing and report success, and the pre-delete must run with
    // it so a renamed declaration cannot survive under its old comment.
    const writesEntries = doSection('entries') || doSection('panel');
    const summary = [];   // the one-line enumeration the closing log prints, built as we write

    // Replacing entries starts by deleting the OLD set — BOTH ways uninstall counts it, so an upgrade
    // cannot leave behind what an uninstall would have removed:
    //   • every comment the registry RECORDED — stale names from a previous version must not survive
    //     an entry rename;
    //   • plus the same needle sweep uninstall runs. Without it, an entry whose comment was edited by
    //     hand has fallen out of the recorded list and escapes the upgrade while uninstall still
    //     catches it, which would make "uninstall, then install" safer than Upgrade.
    // Both are needle deletes over the same book, so the union is exactly the uninstall set — see
    // preDeleteNeedles, where that pairing is decided and tested.
    if (state.registry && writesEntries) {
        const needles = preDeleteNeedles(state.registry, PACK_TYPE, pack.id);
        let removed = 0;
        for (const comment of needles.recorded) {
            removed += await deleteLorebookEntriesByNeedle(comment);
        }
        const strays = await deleteLorebookEntriesByNeedle(needles.sweep);
        if (strays) {
            log.warn('upgrade swept ' + strays + ' entr' + (strays === 1 ? 'y' : 'ies')
                + ' carrying this pack\'s prefix that the registry never recorded — a hand-edited comment, or a'
                + ' crashed earlier install. They were replaced, not kept.');
        }
        removed += strays;
        if (removed) summary.push('replaced ' + removed + ' prior entr' + (removed === 1 ? 'y' : 'ies'));
    }

    // Entries — the pure plan decides comments and field passthrough (byte-fidelity lives there).
    const plan = planInstallEntries(pack);
    if (writesEntries) {
        for (const entry of plan.entries) {
            const wrote = await upsertLorebookEntryFields(String(entry.comment).toLowerCase(), entry);
            if (!wrote) {
                return { ok: false, action, reasons: ['entry "' + entry.comment + '" could not be written — the card book is unavailable; the pack is PARTIALLY installed (re-activate to repair)'] };
            }
        }
        summary.push(plan.entries.length + ' entr' + (plan.entries.length === 1 ? 'y' : 'ies'));
    }

    // Engine — the conflict rule already passed in decideActivation; ownership, and the fingerprint of the text written,
    // are recorded below. A section this apply leaves alone keeps the previous record of both.
    let engineOwned = Boolean(state.registry && state.registry.engineOwned);
    let engineFingerprint = state.registry ? state.registry.engineFingerprint : '';
    if (pack.engine !== undefined && doSection('engine')) {
        const wrote = await writeEngineCode(pack.engine);
        if (!wrote) return { ok: false, action, reasons: ['the [MVU_LogicEngine] entry could not be written — the pack is PARTIALLY installed (re-activate to repair)'] };
        engineOwned = true;
        engineFingerprint = slotFingerprint(pack.engine);
        summary.push('engine ' + pack.engine.length + ' B');
    }

    // Schema — character-scoped `Scheme` script, ownership and fingerprint recorded the same way: uninstall deletes it
    // only when owned.
    let schemaOwned = Boolean(state.registry && state.registry.schemaOwned);
    let schemaFingerprint = state.registry ? state.registry.schemaFingerprint : '';
    if (pack.schema !== undefined && doSection('schema')) {
        const wrote = await upsertScript(SCRIPT_SCOPE_CHARACTER, SCHEMA_SCRIPT_NAME, {
            content: pack.schema,
            enabled: true,
            info: 'Installed by MVU Helper — GameLogic Pack "' + pack.id + '" v' + (pack.version || '?') + ' schema.',
        });
        if (!wrote) return { ok: false, action, reasons: ['the "' + SCHEMA_SCRIPT_NAME + '" script could not be written — the pack is PARTIALLY installed (re-activate to repair)'] };
        schemaOwned = true;
        schemaFingerprint = slotFingerprint(pack.schema);
        summary.push('schema ' + pack.schema.length + ' B');
    }

    // Regexes — character-scoped, ONE host write. Placed here, after the other pieces and before the
    // registry, on purpose: this write reloads the chat (~1s, debounced) and that reload re-runs every
    // card-sync pass, so everything those passes read must already be on the card when it fires.
    //
    // An upgrade also drops what the PREVIOUS version installed and this one no longer ships — otherwise a
    // renamed regex is orphaned on the card, still firing, owned by nobody and invisible to uninstall.
    let installedRegexNames = Array.isArray(state.registry && state.registry.installedRegexNames)
        ? state.registry.installedRegexNames : [];
    // Whether the CARD's regexes changed at all — which is not the same as "this version ships some".
    // A version that ships NONE still removes the previous version's, and that removal needs the screen
    // refreshed just as much: keying the refresh off installedRegexNames would skip exactly that case.
    let regexesChanged = false;
    if (Array.isArray(pack.regex) && pack.regex.length && doSection('regex')) {
        const stale = installedRegexNames;
        const res = await syncRegexes(REGEX_SCOPE_CHARACTER, pack.regex, stale, { declaredOrder: pack.regexOrder });
        if (!res) return { ok: false, action, reasons: ['the pack\'s regexes could not be written — the pack is PARTIALLY installed (re-activate to repair)'] };
        installedRegexNames = pack.regex.map((r) => String((r && r.script_name) || '')).filter(Boolean);
        // Changed means the CARD changed — a re-apply that finds every regex already there byte for byte
        // writes nothing and must not pay the chat reload either.
        regexesChanged = Boolean(res.created || res.updated || res.removed || res.reordered);
        summary.push(installedRegexNames.length + ' regex' + (installedRegexNames.length === 1 ? '' : 'es')
            + (regexesChanged ? (res.removed ? ' (' + res.removed + ' stale removed)' : '') : ' (unchanged)'));
    } else if (installedRegexNames.length && doSection('regex')) {
        // The new version ships NONE and the old one shipped some: they are still ours, so they go. Silence
        // here would leave the card running regexes from a version that no longer exists.
        const removed = await deleteRegexesByName(REGEX_SCOPE_CHARACTER, installedRegexNames);
        if (removed) summary.push(removed + ' regex(es) removed (this version ships none)');
        regexesChanged = Boolean(removed);
        installedRegexNames = [];
    }

    // Registry — LAST among the book writes, so a crash mid-install leaves a sweep-recoverable
    // card rather than a registry claiming pieces that were never written.
    const registry = {
        activePackId: pack.id,
        ver: String(pack.version || '0'),
        installedComments: writesEntries ? plan.installedComments
            : (state.registry && Array.isArray(state.registry.installedComments) ? state.registry.installedComments : plan.installedComments),
        engineOwned,
        engineFingerprint,
        schemaOwned,
        schemaFingerprint,
        installedRegexNames,
        // `state` is RECORDED here, not written as an entry (packStateRecord): the registry is already
        // the card-level record that outlives the library file, and it is already swept on uninstall.
        ...packStateRecord(pack),
        // The pack's interface map, VERBATIM. Recorded here rather than read from the library
        // at match time because the registry outlives the library file (the amber state): a plugin's
        // `requires` must still resolve after the pack file is deleted, exactly like `force` above.
        exposes: (pack.exposes && typeof pack.exposes === 'object' && !Array.isArray(pack.exposes)) ? pack.exposes : {},
        // Identity beside ownership, because the export reads THIS record after the library file is
        // gone: name, description, format, builtWith when declared.
        ...artifactIdentityRecord(pack),
        // The declared apply order, verbatim when the pack states one, so the export can re-emit the
        // section instead of inventing or dropping it.
        ...(Array.isArray(pack.regexOrder) ? { regexOrder: pack.regexOrder.map(String) } : {}),
        installedAt: new Date().toISOString().slice(0, 10),
    };
    const wroteReg = await upsertLorebookEntryFields(packRegistryMatch(PACK_TYPE), {
        comment: packRegistryComment(PACK_TYPE),
        content: buildPackRegistryContent(PACK_TYPE, registry),
        enabled: false, type: 'constant', keys: [],
    });
    if (!wroteReg) return { ok: false, action, reasons: ['the registry entry could not be written — the pack is PARTIALLY installed (re-activate to repair)'] };

    // Init the CURRENT chat immediately (activating mid-chat must not read as "the pack did nothing").
    // Rides the same sync pass every later chat load uses, so install-time and load-time init cannot
    // drift.
    await syncCardData();

    // Say it, don't fix it (L7): MVU may have derived its schema before this pack existed. Checked HERE,
    // after the sync above, so the seed has already landed and the schema reading is the settled one.
    await warnIfMvuSchemaLagged(pack);

    // The loader inherits the new engine text (idempotent when unchanged).
    if (pack.engine !== undefined && doSection('engine')) await loadLogicEngine();

    // This operation spans the card book and (via the library the pack came FROM) potentially
    // another, and ST's world-info save shares one debounce across every book, so whichever wrote last
    // is the only one still riding it. lorebook.js flushes on a book SWITCH; this closes the tail.
    await flushLorebookWrites();

    // The regex list and the rendered messages are refreshed LAST, once the pack is completely in
    // place: this emits CHAT_CHANGED, which re-runs the passes above, and they must see the finished state.
    if (regexesChanged) await refreshRegexUi();

    log.lifecycle('' + action + ' "' + pack.id + '" v' + (pack.version || '?') + ' — ' + summary.join(' · '));
    return { ok: true, action, reasons: [] };
}

// Read what decideMvuSchemaLag needs and log its verdict. NO TOAST: nothing the player can see is
// broken (such a chat is more permissive, not less), and a toast for a hazard that shows up only in
// some LATER chat would cry wolf on every single install. Console is where this belongs.
async function warnIfMvuSchemaLagged(pack) {
    const mvu = getMvu();
    if (!mvu) return;                                    // MVU absent — its schema is nobody's concern
    let variables = null;
    try {
        const chat = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext().chat : null;
        const msg = (Array.isArray(chat) && chat.length) ? chat[0] : null;
        variables = (msg && msg.variables) ? msg.variables[msg.swipe_id || 0] : null;
    } catch (e) {
        log.warn('could not read MVU variables to check whether its schema pre-dates this pack:', e);
        return;
    }
    if (!variables) return;

    const verdict = decideMvuSchemaLag({
        pack,
        bookName: await getPrimaryLorebookName(),
        initializedBooks: variables.initialized_lorebooks,
        schemaPropertyCount: (variables.schema && variables.schema.properties && typeof variables.schema.properties === 'object')
            ? Object.keys(variables.schema.properties).length : undefined,
    });
    if (!verdict.lagged) return;

    log.warn('' + verdict.reason + '. MVU reads a book\'s [InitVar] ONCE per chat and never '
        + 'again, and a pack can only be installed onto a character that is already open — so this is the '
        + 'normal outcome of importing a card and then installing its pack, not a failed install. '
        + 'stat_data IS seeded (card-sync applied this card\'s [InitVar] during the install); what is missing is MVU\'s derived SCHEMA, which '
        + 'it consults only to REFUSE a write. This chat therefore enforces nothing, while one created from '
        + 'now on — with the pack already in the book — enforces the real one, so a write this chat accepts '
        + 'may be refused in a player\'s. This pack ships NO schema section; a pack that does would register '
        + 'Zod, which disables MVU\'s schema outright and makes the difference moot.');
}

// Uninstall the active pack. Removes ONLY what this pack added — its prefixed entries, the engine
// and `Scheme` script it owns, its recorded regexes, and the registry. It NEVER touches `stat_data`,
// and takes no option to: a GameLogic Pack is the game engine, not the save (L7 — deciding a card's
// state is not this button's job, and a pack that spans all of stat_data could only ever purge
// everything). Anything else in the card's book is the user's own and is left alone.
// Returns { ok, removedEntries, removedRegexes, exactness, reasons }.
export async function uninstallActivePack() {
    const state = await readCardPackState();
    const access = cardAccessProblem(state);
    if (access === 'card-unreadable') return { ok: false, reasons: [cardUnreadableReason({ binding: state.bookBinding, bookName: state.bookName, suffix: '(Removing what cannot be listed is how residue is left behind.)' })] };
    if (access) return { ok: false, reasons: ['open a chat first — uninstall edits that card\'s worldbook'] };
    if (state.registryError) return { ok: false, reasons: [state.registryError] };
    if (!state.registry) return { ok: false, reasons: ['no GameLogic Pack is active on this card'] };
    const reg = state.registry;

    // Deleting the Scheme script needs the script API — refuse the whole uninstall rather than
    // leave a schema-owned script behind while claiming a clean removal.
    if (reg.schemaOwned && !isScriptApiAvailable()) {
        return { ok: false, reasons: ['this pack owns the "' + SCHEMA_SCRIPT_NAME + '" script, and the TavernHelper script API is not attached yet — retry in a moment so the uninstall can be exact'] };
    }
    // Same rule: refuse the whole uninstall rather than leave pack-owned regexes behind while reporting
    // a clean removal. They would keep firing on every reply with nothing on the card explaining why.
    if (reg.installedRegexNames.length && !isRegexApiAvailable()) {
        return { ok: false, reasons: ['this pack owns ' + reg.installedRegexNames.length + ' regex(es), and the TavernHelper regex API is not attached yet — retry in a moment so the uninstall can be exact'] };
    }

    // Exactness: what the registry recorded vs what the sweep actually finds, compared BEFORE
    // deleting so both sides of a mismatch can be named.
    // The sweep READ matches the needle ANYWHERE, exactly like the delete that follows it — otherwise a
    // hand-edited comment carrying the prefix mid-string would escape this count and be deleted anyway,
    // leaving the "counts agree" report silent about the one case it exists to catch.
    const sweep = installedSweepNeedle(PACK_TYPE, reg.activePackId);
    const swept = commentsMatchingNeedle(state.entries, sweep);
    const exactness = uninstallExactness(reg.installedComments, swept);
    if (!exactness.agree) {
        log.warn('uninstall count mismatch: recorded-but-missing: ['
            + exactness.onlyInRecord.join(', ') + '] · found-but-unrecorded: [' + exactness.onlyInSweep.join(', ') + ']'
            + ' — deleting the union; nothing is silently kept');
    }

    const removedEntries = await deleteLorebookEntriesByNeedle(sweep);

    let clearedEngine = 0;
    if (reg.engineOwned) clearedEngine = await clearEngineCode();

    let removedSchema = 0;
    if (reg.schemaOwned) removedSchema = await deleteScript(SCRIPT_SCOPE_CHARACTER, SCHEMA_SCRIPT_NAME);
    // The `mvu` script is NEVER removed — deliberately no code path here can reach it.

    // Remove ONLY the recorded names. There is no needle sweep on this surface (a regex carries no
    // comment we own), so the record is the whole handle, and its exactness is reported the same way the
    // entry sweep's is: a name we recorded and cannot find is named rather than passed over in silence.
    let removedRegexes = 0;
    if (reg.installedRegexNames.length) {
        const regexExactness = regexUninstallExactness(reg.installedRegexNames, state.cardRegexNames);
        if (!regexExactness.agree) {
            log.warn('regex uninstall: recorded-but-missing: [' + regexExactness.onlyInRecord.join(', ') + ']'
                + ' — already gone (deleted by hand, or a failed earlier write). Removing the rest.');
        }
        removedRegexes = await deleteRegexesByName(REGEX_SCOPE_CHARACTER, reg.installedRegexNames);
    }

    // The registry is not part of the sweep above, so this is a second delete, and the log reports what
    // it OBSERVED rather than claiming "registry removed": a delete that returns 0 (lorebook API away)
    // leaves the entry on the card naming a pack whose entries are gone. Read presence BEFORE deleting
    // so "0 removed" and "nothing to remove" stay distinguishable.
    const registryNeedle = packRegistryMatch(PACK_TYPE);
    const registryWasPresent = commentsMatchingNeedle(state.entries, registryNeedle).length > 0;
    const registryOutcome = registryRemovalOutcome({
        wasPresent: registryWasPresent,
        removedCount: await deleteLorebookEntriesByNeedle(registryNeedle),
    });
    if (registryOutcome === 'failed') {
        log.warn('the pack registry entry could NOT be removed — it is still on this card,'
            + ' naming "' + reg.activePackId + '" whose entries have just been deleted. The tab will read this card as'
            + ' having a broken install until it goes. Remove "' + packRegistryComment(PACK_TYPE) + '" by hand, or retry'
            + ' the uninstall once the lorebook API is back.');
    }
    await flushLorebookWrites();          // the same tail flush as activate()

    // Same last-step rule as activate(): the removed regexes are still on SCREEN (the list, and the
    // markdown they hid in every rendered message) until the UI is told. Done here, after the registry is
    // gone, so the CHAT_CHANGED this emits sees a fully uninstalled pack rather than a half-removed one.
    if (removedRegexes) await refreshRegexUi();

    // stat_data is NOT touched here, and there is no branch that could — see this function's header.
    log.lifecycle('uninstalled "' + reg.activePackId + '" v' + reg.ver + ' — '
        + removedEntries + ' entries' + (clearedEngine ? ' · engine cleared' : '')
        + (removedSchema ? ' · schema script removed' : '')
        + (removedRegexes ? ' · ' + removedRegexes + ' regex(es) removed' : ' · 0 regexes')
        + (registryOutcome === 'removed' ? ' · registry removed'
            : registryOutcome === 'failed' ? ' · REGISTRY NOT REMOVED (warned above)' : '')
        + ' · stat_data untouched');
    return { ok: true, removedEntries, removedRegexes, exactness, reasons: [] };
}

// Switch: exact-uninstall the outgoing pack, then activate the incoming one. Composition, not a
// third lifecycle — if either half refuses, its reasons surface. The old game's state stays put: the
// [InitVar] seed is applied create-only, so it fills what is missing, and only the incoming pack's
// `state.force` and `state.forceFromInitVar` paths overwrite.
export async function switchToPack(incomingId) {
    const un = await uninstallActivePack();
    if (!un.ok) return { ok: false, action: 'switch-uninstall-failed', reasons: un.reasons };
    const act = await activatePack(incomingId);
    if (!act.ok) {
        // The outgoing pack is GONE and the incoming one refused — the card is packless. Say exactly
        // that; pretending the switch "failed atomically" would hide that state.
        return { ok: false, action: act.action, reasons: [...act.reasons, 'NOTE: the previous pack was already uninstalled — the card currently has NO active GameLogic Pack'] };
    }
    return { ok: true, action: 'switched', reasons: [] };
}

// ── the per-chat-load rebuild pass ───────────────────────────────────────────

// The pack's state reaches the save through card-sync alone: card-sync seeds from the card's own
// [InitVar] (create-only), and applies the registry's `force` map and `forceFromInitVar` paths through
// readActiveForcePayload below. Nothing in this lane merges into stat_data, so two lanes can never seed one
// save from one source.
//
// The FORCE half's source, handed to card-sync by registration (index.js). It takes the entries
// card-sync ALREADY fetched rather than fetching again — one read per sync is the standing rule for this
// pass family. card-sync owns applying and watermarking; this only says WHAT this card's pack asks to be
// forced (packForcePayload). Returns null when no pack is active.
export function readActiveForcePayload(entries) {
    if (!Array.isArray(entries)) return null;
    return packForcePayload(readPackRegistryFrom(entries).registry);
}

// The active pack's id for the turn relay ctx's engine identity (`engine.packId`) — same entries-in
// shape as readActiveForcePayload, same reason. null when no pack is active, which callers pass
// through as-is: "unknown" is an honest value there.
export function readActivePackIdFrom(entries) {
    if (!Array.isArray(entries)) return null;
    const { registry } = readPackRegistryFrom(entries);
    return (registry && registry.activePackId) ? registry.activePackId : null;
}

// Does the ACTIVE pack own this card's "Scheme" script? Asked by the PLUGIN lane, which ships a
// schema of its own and must never overwrite a game's — rule 7 already guarantees a pack's schema
// keeps the platform roots (declared open, or passed through by an open top level), so on such a card
// the plugin's copy would add nothing and discard every path the game declares. False is the honest
// answer for "no pack" and for "the pack did not bring one": in both, whatever schema is on the card
// is unowned, and unowned is a question to ASK.
export function packOwnsCardSchema(entries) {
    if (!Array.isArray(entries)) return false;
    const { registry } = readPackRegistryFrom(entries);
    return Boolean(registry && registry.schemaOwned);
}

// The ACTIVE pack's interface map, from the same registry read. {} when no pack is active or the
// registry records no `exposes` (both honestly "nothing exposed").
export function readActiveExposesFrom(entries) {
    if (!Array.isArray(entries)) return {};
    const { registry } = readPackRegistryFrom(entries);
    return (registry && registry.exposes) ? registry.exposes : {};
}

// The SYNCHRONOUS copy of that map, for consumers that render and cannot await a lorebook read —
// EJS via globalThis.MvuHelper.exposes() (composition, src/index.js). Refreshed where the answer can
// change: the chat-load sync pass below (every CHAT_CHANGED + variable-init) and every lifecycle
// operation (activate/upgrade/switch/uninstall re-run the sync pass or land on a chat load). Starts
// {} — a render before the first chat load sees "nothing exposed", which is also what a no-pack card
// sees, and a plugin entry is told to handle that by rendering nothing.
let activeExposesCache = {};
export function getActiveExposes() {
    return activeExposesCache;
}

// Registered with card-sync (index.js), so it rides the same two hooks as every other pass
// (CHAT_CHANGED + mag_variable_initialized). It writes NO state. It refreshes the synchronous exposes
// cache above, and reports a malformed registry, the one fault a silent return would hide.
export function gameLogicPackSyncPass(statData, entries) {
    const { registry, error } = readPackRegistryFrom(entries);
    if (error) { toast('error', 'GameLogic Pack registry is malformed (see console).'); return { changed: false, reports: [] }; }
    // The exposes sync-read cache follows the registry on EVERY pass — including to {} when no pack is
    // active any more, or the malformed-registry stand-down above never reaches here. A cache that
    // only ever grew would keep advertising a pack after its uninstall.
    activeExposesCache = (registry && registry.exposes) ? registry.exposes : {};
    if (registry) {
        log.verbose('"' + registry.activePackId + '" v' + registry.ver
            + ' — force v' + (registry.stateVersion || '?') + ' with '
            + Object.keys(registry.force || {}).length + ' map path(s) and '
            + (registry.forceFromInitVar || []).length + ' [InitVar] path(s) is applied by the [InitVar] sync lane, not here');
    }
    return { changed: false, reports: [] };
}

// ── release export — the active pack back off the card, as a file ────────────

// The registry's record is the only list walked; the card's copies are the bytes shipped. Inherits
// uninstall's API-availability guards — refuse wholesale, never half-complete — and re-validates +
// re-gates the result before offering it (an export is not gate-free). Caveat shared with every
// regex read here: getRegexes is the in-memory surface install itself writes through; the regex
// lost-write race (readCardPackState) is a WRITE-verification concern, and an export taken mid-race
// ships what the session is actually running.
export async function exportActivePack() {
    const state = await readCardPackState();
    if (state.registryError) return { ok: false, errors: [state.registryError] };
    const reg = state.registry;
    if (!reg) return { ok: false, errors: ['no pack is active on this card — nothing to export'] };
    if (reg.schemaOwned && !state.scriptApiUp) {
        return { ok: false, errors: ['the script API is not attached — the owned "Scheme" script cannot be read, and a partial export is a broken artifact'] };
    }
    const wantsRegexes = Array.isArray(reg.installedRegexNames) && reg.installedRegexNames.length > 0;
    if (wantsRegexes && !isRegexApiAvailable()) {
        return { ok: false, errors: ['the regex API is not attached — the recorded regexes cannot be read, and a partial export is a broken artifact'] };
    }
    const cardRegexes = wantsRegexes ? await getRegexes(REGEX_SCOPE_CHARACTER) : [];
    const built = buildPackExportFile({
        registry: reg, entries: state.entries,
        engineText: state.cardEngineText, schemaText: state.cardSchemeText, cardRegexes,
    });
    const done = finishArtifactExport(built);
    if (done.ok) {
        log.lifecycle('exported "' + done.pack.id + '" v' + done.pack.version
            + ' — ' + (done.pack.entries || []).length + ' entries · engine ' + (done.pack.engine || '').length
            + 'ch · ' + (done.pack.regex || []).length + ' regex (' + done.fileName + ')');
    }
    return done;
}
