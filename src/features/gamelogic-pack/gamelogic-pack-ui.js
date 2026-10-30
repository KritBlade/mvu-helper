// gamelogic-pack/gamelogic-pack-ui.js — the GameLogic Pack's half of the "GameLogic Packs" tab: its row in On this card,
// the page header's pill, and its install, repair, upgrade, switch, export and uninstall. The tab's library, Import and
// unreadable-lorebook notice are artifact-tabs-ui.js's, shared with the StatusMenu Packs tab; this file is the
// 'gamelogic' lane there.
//
// All decision logic is pure (gamelogic-pack-core.js, and artifact-tabs-core.js for what the tab shows); the writes are
// gamelogic-pack-activation.js; this file is GUI only.

import { toast } from '../../sillytavern/mvu-bridge.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { activeArtifactPill } from './artifact-tabs-core.js';
import { cardAccessProblem, cardUnreadableReason, cardBookRepairMessage } from '../../sillytavern/card-access-core.js';
import { repairCardBookLink } from '../../sillytavern/card-access.js';
import {
    deriveArtifactLed, installedSweepNeedle, commentsMatchingNeedle, installActionDone, decideCardRow, artifactIdLine,
    adoptQuestion, ADOPT_QUESTION_BUTTONS, downgradeQuestion, DOWNGRADE_QUESTION_BUTTONS, cardGroupStop,
} from '../../shared/card-artifact-store.js';
import { listLibraryPacks } from './gamelogic-pack-library.js';
import { packOwnedSlots, packReachTexts } from './gamelogic-pack-core.js';
import { readCardPackState, activatePack, switchToPack, uninstallActivePack, exportActivePack } from './gamelogic-pack-activation.js';
import { confirmLibraryPackReach } from './library-pack-reach.js';
import { registerArtifactLane, refreshArtifactTab, toastSchemaRemovals } from './artifact-tabs-ui.js';
import { saveGeneratedFile } from '../../shared/save-file.js';
import { listRow, statusPill, iconButton, button, emptyState, notice } from '../settings-panel/index.js';

const log = createModuleLog('gamelogic-pack');

// One toast-and-save shape for the export result, per lane caller.
async function runExport(label, exporter) {
    const res = await exporter();
    if (!res.ok) {
        for (const e of res.errors) log.warn('[' + label + '] export refused: ' + e);
        toast('error', 'Not exported — ' + res.errors[0]);
        return;
    }
    for (const w of (res.warnings || [])) log.warn('[' + label + '] export warning: ' + w);
    saveGeneratedFile(res.fileName, res.text, 'application/json');
    toast('success', 'Exported ' + res.fileName + ((res.warnings || []).length ? ' — ' + res.warnings.length + ' warning(s), see console' : ''));
}

// ── On this card: the GameLogic Pack ─────────────────────────────────────────

// The page header's pill: the pack this card runs (activeArtifactPill).
function paintActivePack(pill) {
    $('#mvuh_gp_state').html(pill ? statusPill(pill) : '');
}

// The card section: WHAT IS INSTALLED HERE, and nothing else — a row for a pack NOT on this card would
// sit under a heading that says "On this card", and the heading and its contents would disagree.
// Installing starts from the LIBRARY row below, exactly as it does on the Event Packs tab.
//
// An installed pack whose library copy is GONE still gets a row (No library copy) — it is real and
// running, and hiding it would make it un-uninstallable from the UI. The row names the INSTALLED
// version; a newer library copy shows as its Upgrade button. The engine and the schema are checked like
// every other piece (packOwnedSlots): one removed is a missing piece, one another writer replaced is Drift.
// Returns the ids installed on this card, so the library list can mark and skip them (the lane contract,
// artifact-tabs-ui.js).
async function refreshCardSection() {
    const $card = $('#mvuh_gp_card').empty();
    const installedIds = new Set();
    const state = await readCardPackState();
    const stop = cardGroupStop(state);
    if (stop) {
        if (stop.notice) $card.html(notice(stop.notice));
        paintActivePack(null);
        return installedIds;
    }
    const reg = state.registry;
    if (!reg) {
        $card.html(emptyState({ icon: 'fa-cube', text: 'No GameLogic Pack on this card. Install one from the library below.' }));
        paintActivePack(activeArtifactPill({ packType: 'gamelogic', isReadable: true }));
        return installedIds;
    }
    installedIds.add(reg.activePackId);
    const libraryCopy = (await listLibraryPacks() || []).find((p) => p.packType === 'gamelogic' && p.id === reg.activePackId) || null;
    const led = deriveArtifactLed({
        inLibrary: Boolean(libraryCopy), isActive: true,
        recordedComments: reg.installedComments,
        presentComments: commentsMatchingNeedle(state.entries, installedSweepNeedle('gamelogic', reg.activePackId)),
        recordedRegexNames: reg.installedRegexNames,
        presentRegexNames: state.cardRegexNames,
        regexReadable: state.regexApiUp,
        ownedSlots: packOwnedSlots(reg, state),
    });
    const { status, offer } = decideCardRow({ led, libraryCopy, installedVersion: reg.ver });
    const name = (libraryCopy && libraryCopy.name) || reg.activePackId;
    // No "Install" here: every row in this section IS installed, so the only actions are repair, upgrade,
    // export and uninstall. Putting the first install on the LIBRARY row is what makes the two tabs read
    // the same, and what stops this heading from listing packs it does not describe.
    const reinstall = { 'gp-card': 'install', 'gp-id': reg.activePackId };
    $card.html(listRow({
        icon: 'fa-cube',
        name,
        sub: [artifactIdLine({ id: reg.activePackId, version: reg.ver }), ...status.sub],
        pills: status.pills.map((pill) => statusPill(pill)),
        actions: [
            ...(offer.repair ? [button({ text: 'Repair', icon: 'fa-screwdriver-wrench', data: reinstall })] : []),
            ...(offer.upgrade ? [button({ text: 'Upgrade', icon: 'fa-circle-up', data: reinstall })] : []),
            iconButton({ icon: 'fa-file-export', title: 'Export', data: { 'gp-card': 'export' } }),
            iconButton({ icon: 'fa-trash', title: 'Uninstall', isDanger: true, data: { 'gp-card': 'uninstall' } }),
        ],
    }));
    paintActivePack(activeArtifactPill({ packType: 'gamelogic', isReadable: true, artifact: { name, status: status.pill.status } }));
    return installedIds;
}

// ── the GameLogic Pack on a card: install, repair, upgrade, uninstall ─────────

// NO keep/purge question. Uninstall and switch never delete stat_data, so there is nothing to ask —
// see uninstallActivePack's header for why a GameLogic Pack has no business deciding that (L7).

// What the success toast says each activation action did is installActionDone's table
// (shared/card-artifact-store.js): `activate` reads as INSTALLED, the tab's user-facing verb (installToCard).

// The USER-FACING verb is INSTALL (paired with Uninstall, as on the Event Packs tab). The module
// underneath calls it ACTIVATION, because the lane has more states than one label carries — activate /
// repair / upgrade / downgrade / switch.
async function installToCard(id) {
    const res = await activatePack(id);
    if (res.ok) { toast('success', 'Pack "' + id + '" ' + installActionDone(res.action) + ' on this card.'); toastSchemaRemovals(res, 'Pack "' + id + '"'); await refreshArtifactTab('gamelogic'); return; }
    if (res.action === 'switch-needed') {
        const active = res.active || {};
        if (!await confirmPopup([
            { text: 'Switch this card to another GameLogic Pack?' },
            { text: 'Active now:', name: String(active.id || '?') + ' v' + String(active.version || '?') },
            { text: 'Installs:', name: id },
            { text: 'Switch uninstalls the active pack first, then installs this one.' },
            { text: "The chat's stat_data is untouched." },
        ], { okButton: 'Switch', isDestructive: true })) return;
        const sw = await switchToPack(id);
        if (sw.ok) toast('success', 'Switched to "' + id + '".');
        else toast('error', sw.reasons.join(' — '));
        await refreshArtifactTab('gamelogic');
        return;
    }
    if (res.action === 'downgrade') {
        if (!await confirmPopup(downgradeQuestion({ artifactName: id, installedVersion: res.installedVersion, libraryVersion: res.libraryVersion }), DOWNGRADE_QUESTION_BUTTONS)) return;
        const again = await activatePack(id, { confirmDowngrade: true });
        if (again.ok) { toast('success', 'Pack "' + id + '" downgraded.'); toastSchemaRemovals(again, 'Pack "' + id + '"'); await refreshArtifactTab('gamelogic'); }
        else toast('error', again.reasons.join(' — '));
        return;
    }
    // ADOPT — the card owns a surface this pack writes differently. THIS button is the adopt gesture:
    // "install it here" is already the thing being asked. Surfaces whose bytes already match were adopted
    // without reaching here, so everything the question lists is a real replacement.
    if (res.action === 'needs-adopt') {
        if (!await confirmPopup(adoptQuestion({
            artifactName: id, version: res.version, surfaces: res.adoptable,
            answers: [
                { text: 'Replace: the pack owns them from then on, and its uninstall removes them. Saved state (stat_data) is untouched.' },
                { text: 'Cancel: nothing is installed or changed.' },
            ],
        }), ADOPT_QUESTION_BUTTONS)) return;
        const adopted = await activatePack(id, { confirmDowngrade: true, adopt: true });
        if (adopted.ok) { toast('success', 'Pack "' + id + '" ' + installActionDone(adopted.action) + ' — the card\'s own copies were replaced.'); toastSchemaRemovals(adopted, 'Pack "' + id + '"'); await refreshArtifactTab('gamelogic'); }
        else toast('error', adopted.reasons.join(' — '));
        return;
    }
    toast('error', res.reasons.join(' — '));
}

// The library's "Install to this card", and the card row's Repair and Upgrade: the library copy, written onto this
// card. The install warning is asked first, before any other question or write (library-pack-reach.js); then the
// in-chat guard the library section itself does not have (the library book is root-level and needs no chat;
// installing does).
async function onInstallFromLibrary(id) {
    if (!await confirmLibraryPackReach('gamelogic', id, packReachTexts)) return;
    const state = await readCardPackState();
    const access = cardAccessProblem(state);
    if (access === 'card-unreadable') {
        // The unreadable states mvu-helper can fix from here are offered rather than merely described:
        // repairCardBookLink links the card's existing book, imports its embedded lore through
        // SillyTavern's own Import Card Lore, or creates an empty book, so the install continues after
        // at most a single yes instead of ending in instructions.
        const repair = await repairCardBookLink();
        if (!repair.resolved) {
            toast('warning', repair.offered
                ? (repair.reason === 'declined' ? 'Not installed — this card still has no worldbook to write to.' : repair.reason)
                : cardUnreadableReason({ binding: state.bookBinding, bookName: state.bookName }));
            return;
        }
        toast('success', cardBookRepairMessage(repair) + ' Continuing the install.');
    } else if (access) { toast('warning', 'Open a chat first — installing writes to that card.'); return; }
    await installToCard(id);
}

async function onUninstall() {
    const state = await readCardPackState();
    if (!state.registry) { toast('warning', 'No GameLogic Pack is active on this card.'); return; }
    // Whether a library copy survives is the difference between "undo" and "one-way", so the dialog
    // must not claim one that is not there — the amber state (deleted from the library while active)
    // is exactly when a user is most likely to be counting on it.
    const inLibrary = (await listLibraryPacks() || []).some(
        (p) => p.packType === 'gamelogic' && p.id === state.registry.activePackId);
    if (!await confirmPopup([
        { text: 'Uninstall this GameLogic Pack from the card?' },
        { name: state.registry.activePackId + ' v' + state.registry.ver },
        { text: 'Its entries, owned engine and owned schema are removed.' },
        inLibrary
            ? { text: 'The library copy stays, so you can install it again later.' }
            : { text: 'No library copy is left to install it again from. Import the pack file first if you may want it back.' },
        { text: 'Your saved state (stat_data) is not touched.' },
    ], { okButton: 'Uninstall', isDestructive: true })) return;
    const res = await uninstallActivePack();
    if (res.ok) toast('success', 'Uninstalled — ' + res.removedEntries + ' entries removed.');
    else toast('error', res.reasons.join(' — '));
    await refreshArtifactTab('gamelogic');
}

// ── wiring ───────────────────────────────────────────────────────────────────

export function wireGameLogicPackTab() {
    // This type's lane, registered like the plugin's and the menu's (artifact-tabs-ui.js), so the tab repaints and installs
    // every type the same way.
    registerArtifactLane('gamelogic', { install: (id) => onInstallFromLibrary(id), installedIds: () => refreshCardSection() });
    // Card-section buttons (delegated — the list is rebuilt on every refresh).
    $('#mvuh_gp_card').on('click', '[data-gp-card]', function () {
        const action = $(this).attr('data-gp-card');
        if (action === 'install') void onInstallFromLibrary($(this).attr('data-gp-id'));
        else if (action === 'export') void runExport('gamelogic-pack', exportActivePack);
        else if (action === 'uninstall') void onUninstall();
    });
}
