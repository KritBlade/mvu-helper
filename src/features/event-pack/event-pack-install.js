// event-pack/event-pack-install.js — validating and INSTALLING an event pack, with no GUI attached.
//
// WHY IT IS ITS OWN FILE: the artifact dev loop needs the same install the Event Packs tab runs — the
// whole point of the loop is that a developer debugs the install a player runs — so the install reads
// no textarea and knows no tab. The tab's button validates, calls in here, and reports what comes back.
//
// This is host I/O, not GUI: lorebook reads and writes, the chat's stat_data, the card-sync merge.
// Every DECISION it leans on is pure and already lives in event-pack-core.js — what a valid pack is,
// which action a version comparison implies, which fx a card can apply. Nothing here re-decides any
// of that.
//
// The two entry points differ only in WHAT they write, which is the fence the dev loop enforces:
// storeEventPacksInLibrary touches the root-level library book alone (no card), installValidatedPacks
// writes the card's entries and registry. A developer who answered "no" for a card still gets the
// library copy, and the Event Packs tab's Install button is then one click away.

import { getStandaloneLorebookEntries, upsertLorebookEntry, upsertLorebookEntryFields, flushLorebookWrites } from '../../sillytavern/lorebook.js';
import { getMvu, latestMsgId } from '../../sillytavern/mvu-bridge.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { syncCardData } from '../card-sync/index.js';
import {
    REGISTRY_ENTRY_MATCH, REGISTRY_COMMENT,
    parseRegistry, parseUploadFile, duplicatePackIds, duplicateTriggerKeys,
    validateEventPack, installedRootOf, unallowedWritePaths, unstampedWritePaths, unallowedRewardKinds, mismatchedRewardShapes, undeclaredScopeRows, lintPackEjs, decideInstall,
    armedPointerShapeProblem,
    buildRegistryContent, packEntryComment, packEntryWrite,
} from './event-pack-core.js';
import { findEntryByNeedle } from '../../shared/card-artifact-store.js';
import { getPath } from '../../shared/object-path.js';
import { readEventContract, getScopeDeclared, loadLogicEngine, GAME_ENGINE_SCOPE } from '../logic-engine/index.js';
import { mirrorInstalledPacks } from './event-pack-library.js';

const log = createModuleLog('event-pack');

// What THIS card's engine declares about events: where it keeps event state, where a pack may write,
// what it pays, which scopes it knows. From the LOADED engine's own exports, so there is no copy of
// any of it to fall out of step with the engine that reads them.
//
// ONE gather for install, the tab and packInfo — three readings of one fact drift apart from the
// engine they describe.
//
// The caller must have awaited loadLogicEngine(). Not loaded ⇒ every verdict refuses with that said
// plainly, which is correct: an event pack is written for one engine and cannot run without it.
export function readCardEventContract() {
    return readEventContract(getScopeDeclared(GAME_ENGINE_SCOPE));
}

export async function readChatStatData() {
    const Mvu = getMvu();
    const id = latestMsgId();
    if (!Mvu || typeof Mvu.getMvuData !== 'function' || id < 0) return null;
    try {
        const data = await Mvu.getMvuData({ type: 'message', message_id: id });
        return (data && typeof data === 'object' && data.stat_data) ? data.stat_data : null;
    } catch (e) { log.warn('could not read stat_data:', e); return null; }
}

// Registry from the standalone worldbook. { registry, entryFound } — registry null on a parse error
// (surfaced; every caller then refuses writes rather than clobbering a half-broken registry).
export function readRegistry(entries) {
    const entry = findEntryByNeedle(entries, REGISTRY_ENTRY_MATCH);
    if (!entry) return { registry: {}, entryFound: false };
    try { return { registry: parseRegistry(entry.content), entryFound: true }; }
    catch (e) {
        log.error('registry entry is malformed:', e);
        return { registry: null, entryFound: true };
    }
}

// Validate one upload file end-to-end. An upload FILE may declare SEVERAL packs: a long chain is
// naturally written as one file, and so are two heroines. Each block is its OWN pack — own packId, own
// entry, own registry record; only the parse loops.
// Returns { packs: [{ pack, action, installedVer, errors, warnings }], errors, warnings } where
// `errors` is FILE-level.
//
// ALL-OR-NOTHING (user decision): one bad block refuses the whole file. A chain is the reason — pack 3
// gating on pack 2 must never land without it, which would leave an event that silently never fires.
export async function validateUploadFile(text, { allowReinstall = false } = {}) {
    const out = { packs: [], errors: [], warnings: [] };
    const parsed = parseUploadFile(text);
    if (parsed.errors.length) {
        out.errors = parsed.errors.map((e) => `block #${e.index + 1}: ${e.error}`);
        return out;
    }
    // A duplicate packId is not a "second pack": decideInstall compares versions on packId, so the
    // later block would read as an UPGRADE of the earlier one and overwrite its entry. Name both.
    for (const d of duplicatePackIds(parsed.packs)) {
        out.errors.push(`blocks #${d.first + 1} and #${d.second + 1} are both "${d.packId}" — give each its own "event" name (e.g. Leila1 / Leila2); they may still share the same "series"`);
    }
    // Cross-block key collision — file-level, and phrased against the BLOCKS, because neither pack is
    // installed yet (the collision fence below handles the against-installed case and says so differently).
    for (const d of duplicateTriggerKeys(parsed.packs)) {
        out.errors.push(`key "${d.key}" is claimed by BOTH block #${d.first + 1} and block #${d.second + 1} — one key belongs to exactly one pack, or the later pack silently overwrites the earlier one's row`);
    }

    const entries = await getStandaloneLorebookEntries();
    const { registry } = readRegistry(entries || []);
    if (registry === null) { out.errors.push('registry entry is malformed — fix or delete [MVU_Event_Pack_Registry] first'); return out; }

    // The engine must be RUNNING before its contract can be read, and this is a user-initiated upload
    // that may be the first thing to touch the engine on this card. Awaiting here chains behind any
    // in-flight load and re-reads the entry, so the contract below is the one the engine will actually
    // resolve with — not a snapshot that a later load moves out from under us.
    await loadLogicEngine();
    const contract = readCardEventContract();

    // No declared paths ⇒ REFUSE the file. Validating a pack we cannot place is theatre: the collision
    // fence below reads the trigger table, and against the wrong root every key looks unclaimed.
    // The verdict's own reason is passed through verbatim so the message names the ACTUAL fault (no
    // engine loaded · engine declares no adapter · a malformed path), each of which has a different fix.
    const cfg = contract.paths;
    if (!cfg.ok) { out.errors.push(cfg.reason); return out; }
    // The allowed write paths are read once for the whole file. NOT fatal: an engine that declares no
    // write list still installs packs correctly — we just cannot pre-check the writes, and the engine's
    // fire-time "WRITE REFUSED" line remains the backstop. Surfaced as a file-level WARNING, never silence.
    const cardWrites = contract.writes;
    if (!cardWrites.ok) out.warnings.push(`write-path compatibility not checked — ${cardWrites.reason}`);
    // WHAT the engine pays. Absent is NOT a failure here — the verdict is an empty list, meaning a
    // card that pays nothing, and a pack asking for a payout is then refused with that said plainly.
    const cardRewards = contract.rewards;
    if (!cardRewards.ok) out.warnings.push(`reward compatibility not checked — ${cardRewards.reason}`);
    // The scope VALUES the engine distinguishes — same lane and same standing as fx: absent ⇒ a
    // file-level warning and no check, never a guess at what this genre calls its scopes.
    const cardScopes = contract.scopes;
    if (!cardScopes.ok) out.warnings.push(`scope compatibility not checked — ${cardScopes.reason}`);
    // WHERE the card puts a pack's entry. A malformed slot refuses the file — the card's own gap, named —
    // because installing it anyway would put every beat somewhere the card never meant. An undeclared slot
    // is a real answer: the entry keeps the host's default.
    const bodyEntry = contract.bodyEntry;
    if (!bodyEntry.ok) { out.errors.push(`${bodyEntry.reason}. This is the CARD's gap, not the pack's.`); return out; }
    out.entryPlacement = { armedPath: cfg.armedPath, bodyEntry: bodyEntry.entry };

    // The collision fence needs the CURRENT chat's trigger table (keys a pack doesn't own).
    const statData = await readChatStatData();
    // The armed pointer has ONE shape (armedPointerShapeProblem). On any other, every body this file
    // carries would arm and never play, so the whole file is refused, and the message says the fix is
    // the CARD's engine: no edit to the pack can make its gate open.
    const armedProblem = armedPointerShapeProblem(statData, cfg.armedPath);
    if (armedProblem) {
        out.errors.push(`${armedProblem}. This is the CARD's gap, not the pack's: its engine must store the armed event as a [value, label] pair.`);
        return out;
    }
    const readPath = (path) => getPath(statData || {}, path) || {};
    const triggers = readPath(cfg.triggerRoot);
    // The per-chat installed record lives BESIDE the trigger table — derived, never spelled again: a
    // hardcoded copy of its path silently survives a moved root.
    const installedAll = readPath(installedRootOf(cfg.triggerRoot));

    for (const pack of parsed.packs) {
        const per = { pack, action: '', installedVer: '', errors: [], warnings: [] };
        const dec = decideInstall(pack, registry);
        per.action = dec.action; per.installedVer = dec.installedVer;
        // `allowReinstall` is the DEV LOOP's arm, and only its. A person installing a pack is told to
        // bump the version, because on a card they play the installed copy is the one that matters and
        // a silent re-write of it hides which version is live. A developer saving a file is the exact
        // opposite: the workspace IS the truth, the version rarely moves between saves, and refusing
        // every save after the first would make the loop useless for this artifact type. The same
        // asymmetry the other lanes already carry as `confirmDowngrade` (applying overwrites the card
        // freely — the release path is the export button, not this).
        if (!allowReinstall) {
            // Both rejections name the WAY OUT: "already installed" alone leaves an author who just
            // edited their pack with no idea that the version field is what the installer compares.
            if (dec.action === 'reject-same') per.errors.push(`already installed at v${dec.installedVer} — bump this pack's "version" to install an update, or Uninstall it first to re-install the same version`);
            if (dec.action === 'reject-downgrade') per.errors.push(`v${pack.version} is older than the installed v${dec.installedVer}, and there is no downgrade path — Uninstall the installed one first, then install this`);
        }

        const ownKeys = Array.isArray((installedAll[pack.packId] || {}).keys) ? installedAll[pack.packId].keys : [];
        const foreign = Object.keys(triggers).filter((k) => !ownKeys.includes(k));
        const v = validateEventPack(pack, foreign);
        per.errors.push(...v.errors);
        per.warnings.push(...v.warnings);
        per.errors.push(...lintPackEjs(pack.entryContent, cfg).errors);
        // The WRITE-PATH gate, catch point 1 of 3, and the only one that can refuse BEFORE anything is
        // written. Names what this card DOES allow, so the author can see whether they grabbed a pack for
        // another genre or simply mistyped a path.
        if (cardWrites.ok) {
            const unallowed = unallowedWritePaths(pack, cardWrites.writes);
            if (unallowed.length) {
                per.errors.push(`this card's engine allows no writes into ${unallowed.join(', ')} — it allows: ${cardWrites.writes.map((e) => e.path).join(', ') || 'no writes at all'}. ` +
                    `Installed as-is, those events would play and those writes would be refused.`);
            }
            // The OWNERSHIP gate, card-aware because the card decides where ownership is recorded: a
            // `fillOnly` path is a SHARED registry (first capture wins, so a pack can only fill blanks
            // there) and needs none; everywhere else the path must name an `ownerStamp` field or the
            // engine refuses every keyed pack write on it, however the key is spelled.
            for (const r of unstampedWritePaths(pack, cardWrites.writes)) {
                per.errors.push(`row "${r.key}": this card's engine declares no ownerStamp on ${r.path} and does not share it, so no record there can ` +
                    `say which pack made it and every keyed write is refused at fire. This is the CARD's gap, not the pack's — renaming the key cannot fix it.`);
            }
        }
        // The REWARD gate, the payout twin of the write-path gate and refused for the same reason: the
        // engine would play the beat and pay nothing, which reads as a broken event rather than a
        // rejected one. Names what this card DOES pay, including when that is nothing at all.
        if (cardRewards.ok) {
            const unallowed = unallowedRewardKinds(pack, cardRewards.rewards);
            if (unallowed.length) {
                per.errors.push(`this card's engine pays no reward of kind ${unallowed.join(', ')} — it pays: ${cardRewards.rewards.map((k) => k.name).join(', ') || 'nothing at all'}. ` +
                    `Installed as-is, those events would play and pay nothing.`);
            }
            // A kind the card DOES pay, asked for in the wrong shape: the same silent nothing at fire.
            for (const r of mismatchedRewardShapes(pack, cardRewards.rewards)) {
                per.errors.push(`row "${r.key}": reward "${r.kind}" ${r.problem}.`);
            }
        }
        // The scope half — a WARNING, not a refusal: the row fires and applies its fx either way. What the
        // engine makes of a scope it never declared is the engine's call; this only says it was never spelled.
        if (cardScopes.ok) {
            for (const r of undeclaredScopeRows(pack, cardScopes.scopes)) {
                per.warnings.push(`row "${r.key}": scope "${r.scope}" is not one this card's engine declares (it declares: ${cardScopes.scopes.join(', ') || 'none'}) — the engine decides what an undeclared scope means; check the spelling`);
            }
        }
        out.packs.push(per);
    }
    return out;
}

/**
 * The CARD write for an already-validated file: one worldbook entry per pack, the registry records,
 * the library mirror, then the merge into the current chat. The caller owns the validation and the
 * user-facing report — this refuses on a bad write and says which one, and never re-decides whether
 * the packs were installable.
 *
 * @param {{ packs: Array<{ pack: object }> }} validated the result of validateUploadFile
 * @returns {Promise<{ ok: boolean, reasons: string[], warnings: string[], installedIds: string[] }>}
 */
export async function installValidatedPacks(validated) {
    const per = (validated && Array.isArray(validated.packs)) ? validated.packs : [];
    const out = { ok: false, reasons: [], warnings: [], installedIds: [] };
    if (!per.length) { out.reasons.push('nothing to install — the file declares no packs'); return out; }

    // 1. one entry per pack, carrying ONLY that pack's block + its own gated bodies (pack.entryContent).
    //    Writing the whole file into each entry would give every entry the others' JSON as prose, which
    //    ST then injects into the prompt as story text. packEntryWrite builds it: the @@if on the pack's
    //    keys, the slot the card declares, and `type:'constant'`.
    if (!validated.entryPlacement) { out.reasons.push('the validation carries no entry placement — validate the file with validateUploadFile first'); return out; }
    for (const p of per) {
        const id = p.pack.packId;
        const wrote = await upsertLorebookEntryFields(packEntryComment(id).toLowerCase(), packEntryWrite(p.pack, validated.entryPlacement));
        if (!wrote) { out.reasons.push(`could not write the worldbook entry for ${id} (book unavailable)`); return out; }
    }

    // 2. the registry records (cross-chat install markers) — one write for all of them.
    const entries = await getStandaloneLorebookEntries();
    const { registry } = readRegistry(entries || []);
    if (registry === null) { out.reasons.push('registry entry is malformed — not overwriting it'); return out; }
    for (const p of per) registry[p.pack.packId] = { ver: String(p.pack.version) };
    await upsertLorebookEntry(REGISTRY_ENTRY_MATCH, REGISTRY_COMMENT, buildRegistryContent(registry));

    // 2b. the LIBRARY copy, which is what survives a card rebuild. Never fatal to the install:
    //     the card entries above are what make the pack PLAY, and a pack that plays but has no
    //     recoverable copy is strictly better than no pack. Reported because the user is the one who
    //     then has to keep the source file.
    const mirror = await mirrorInstalledPacks(per.map((p) => p.pack));
    if (mirror.failed.length) {
        out.warnings.push(`${mirror.failed.length} pack(s) could not be stored in the library — keep the source file; a card rebuild would lose them. See the console.`);
    }

    // 2c. the install spans TWO books (card, then library), and ST's world-info save shares ONE
    //     debounce across every book, so the last write out is the only one still riding it. The
    //     book-switch flush in lorebook.js already forced the card book to disk when the mirror above
    //     switched books; this closes the tail, so nothing else's save can drop the library copy.
    await flushLorebookWrites();

    out.installedIds = per.map((p) => p.pack.packId);
    if (out.installedIds.length > 1) {
        log.lifecycle(`installed ${out.installedIds.length} packs from one file: ${out.installedIds.join(', ')}`);
    }

    // 3. merge into the CURRENT chat (the scan toasts per-pack install success/failure itself)
    await syncCardData();
    out.ok = true;
    return out;
}

/**
 * The LIBRARY-only write: every pack in every file, stored under its own packId. No card is touched,
 * which is why the dev loop runs this even for a card it was told not to install onto.
 *
 * @param {string[]} texts one event-pack upload file per element
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export async function storeEventPacksInLibrary(texts) {
    const list = Array.isArray(texts) ? texts : [];
    const packs = [];
    const errors = [];
    for (const [i, text] of list.entries()) {
        const parsed = parseUploadFile(text);
        // Named by POSITION, because a file that does not parse has no identity to name it by.
        for (const e of parsed.errors) errors.push(`file #${i + 1}, block #${e.index + 1}: ${e.error}`);
        packs.push(...parsed.packs);
    }
    if (errors.length) return { ok: false, errors };
    if (!packs.length) return { ok: false, errors: ['no event packs found in these files'] };

    const mirror = await mirrorInstalledPacks(packs);
    if (mirror.failed.length) {
        return { ok: false, errors: [`${mirror.failed.length} of ${packs.length} pack(s) could not be written to the library book — see the console`], stored: mirror.stored };
    }
    await flushLorebookWrites();
    return { ok: true, errors: [], stored: mirror.stored };
}

// An assembled eventpack ARTIFACT (`events` = its events/ files) as the upload texts the lane reads: one
// text per file, each declaring its own packs.
export function eventPackArtifactTexts(pack) {
    return ((pack && Array.isArray(pack.events)) ? pack.events : []).map((file) => String((file && file.text) || ''));
}

/**
 * Every packId these files declare, in file order. Pure apart from the parse — used to ask what an
 * artifact would install and whether the card already carries it.
 *
 * @param {string[]} texts
 * @returns {string[]}
 */
export function eventPackIdsIn(texts) {
    const ids = [];
    for (const text of Array.isArray(texts) ? texts : []) {
        for (const pack of parseUploadFile(text).packs) ids.push(pack.packId);
    }
    return ids;
}

/**
 * Are ALL of these packs recorded on the open card? Partly-installed answers false: the dev loop's
 * fence asks "does this card already carry this artifact", and half of one is not it.
 *
 * @param {string[]} ids
 * @returns {Promise<boolean>}
 */
export async function eventPacksOnCard(ids) {
    const wanted = Array.isArray(ids) ? ids : [];
    if (!wanted.length) return false;
    const { registry } = readRegistry(await getStandaloneLorebookEntries() || []);
    if (registry === null) return false;
    return wanted.every((id) => registry[id] !== undefined);
}

/**
 * The dev loop's activate arm: every file in one eventpack ARTIFACT, validated together and then
 * installed together. All-or-nothing across the whole artifact for the same reason it is
 * all-or-nothing within one file — a pack whose prereq names a sibling must never land without it,
 * because the failure is silence rather than an error.
 *
 * Returns the shape every activation lane returns, so the loop's own reporting needs no special case.
 *
 * @param {string[]} texts one event-pack upload file per element
 * @returns {Promise<{ ok: boolean, action: string, reasons: string[] }>}
 */
export async function installEventPackArtifact(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (!list.length) return { ok: false, action: 'invalid', reasons: ['this artifact carries no files in events/'] };

    const validated = [];
    const reasons = [];
    for (const [i, text] of list.entries()) {
        // allowReinstall: a save that did not move the version is the loop's NORMAL case (see the arm
        // in validateUploadFile for why a person's install refuses exactly what this permits).
        const res = await validateUploadFile(text, { allowReinstall: true });
        const fileErrors = res.errors.concat(...res.packs.map((p) => p.errors.map((e) => `${p.pack.packId}: ${e}`)));
        // Named by POSITION as well as identity: file #2 is what a developer looks at, and a file that
        // failed to parse has no packId to be named by.
        for (const e of fileErrors) reasons.push(`events file #${i + 1}: ${e}`);
        validated.push(res);
    }
    if (reasons.length) return { ok: false, action: 'invalid', reasons };

    const installedIds = [];
    for (const res of validated) {
        const done = await installValidatedPacks(res);
        if (!done.ok) {
            return {
                ok: false,
                action: 'write-refused',
                // PARTIAL, and it says so: earlier files in this artifact are already on the card. The
                // loop cannot roll a lorebook write back, so the honest report is what landed.
                reasons: done.reasons.concat(installedIds.length
                    ? [`${installedIds.length} pack(s) from this artifact were already written (${installedIds.join(', ')}) — the artifact is PARTIALLY installed`]
                    : []),
            };
        }
        installedIds.push(...done.installedIds);
    }
    return { ok: true, action: 'installed ' + installedIds.length + ' pack(s): ' + installedIds.join(', '), reasons: [] };
}
