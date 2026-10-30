// statusmenu-pack/statusmenu-pack-ui.js — the menu's row in the "StatusMenu Packs" tab's On this card, the page header's
// pill, and the Development tab's StatusMenu Engine dev upload. The tab's library, Import and unreadable-lorebook notice
// are the half both artifact tabs share (gamelogic-pack's artifact-tabs-ui.js), and this file is the 'statusmenu' lane
// there. A card renders ONE menu, so On this card holds one row or says there is none.
//
// No install dialog: unlike a plugin, a menu declares no bindings and owns no state root, so there is
// nothing to ask. The only questions are the install warning, asked first of every install
// (gamelogic-pack's library-pack-reach.js), and the two confirmations the activation decision can raise —
// replacing a different active menu (switch), and installing an older version over a newer one
// (downgrade) — both asked with the decision's own reason text, never a re-worded copy.
//
// All decisions are pure (statusmenu-pack-core.js); the writes are statusmenu-pack-activation.js.
// This file is GUI only.

import { toast } from '../../sillytavern/mvu-bridge.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { readCardAccess, repairCardBookLink } from '../../sillytavern/card-access.js';
import { cardBookRepairMessage } from '../../sillytavern/card-access-core.js';
import { installActionDone, decideCardRow, artifactIdLine, downgradeQuestion, DOWNGRADE_QUESTION_BUTTONS, cardGroupStop } from '../../shared/card-artifact-store.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { listLibraryPacks, activeArtifactPill, confirmLibraryPackReach } from '../gamelogic-pack/index.js';
import { loadLogicEngine } from '../logic-engine/index.js';
import { declaredVersionOf } from '../../shared/engine-header.js';
import { STATUSMENU_TYPE, menuEngineStatusView, menuReachTexts } from './statusmenu-pack-core.js';
import { activateMenu, uninstallActiveMenu, readMenuLed, readCardMenuState, exportActiveMenu } from './statusmenu-pack-activation.js';
import { saveGeneratedFile } from '../../shared/save-file.js';
import { pickTextFile } from '../../shared/pick-files.js';
import { readMenuEngineCode, writeMenuEngineCode, clearMenuEngineCode } from './statusmenu-engine-store.js';
import { checkMenuFormatterCoverage } from './statusmenu-engine-runtime.js';
import { listRow, statusPill, button, iconButton, emptyState, notice } from '../settings-panel/index.js';

const log = createModuleLog('statusmenu-pack');

// The whole-tab repaint, supplied by the composition root (same inversion as the plugin block, same reason:
// an install must also repaint the LIBRARY list below this row, or its row keeps offering
// "Install to this card" for a menu that is now installed).
let repaintTab = async () => {};

export function setStatusMenuTabRepaint(fn) {
    if (typeof fn === 'function') repaintTab = fn;
}

// ── install (the registerArtifactLane entry point) ───────────────────────────

export async function onInstallMenuFromLibrary(id) {
    // The install warning first, before any other question or write (gamelogic-pack's library-pack-reach.js).
    if (!await confirmLibraryPackReach(STATUSMENU_TYPE, id, menuReachTexts)) return;
    let res = await activateMenu(id);
    // A THIRD confirmable refusal, and the only one whose fix is not a flag: a card whose lore is
    // embedded has no worldbook to write to, and SillyTavern's own Import Card Lore makes one. One
    // yes, then the same install runs again (user, 2026-08-31).
    if (!res.ok && res.action === 'card-unreadable') {
        const repair = await repairCardBookLink();
        if (!repair.offered) { toast('error', res.reasons.join(' — ')); return; }
        if (!repair.resolved) {
            if (repair.reason !== 'declined') toast('error', repair.reason);
            return;
        }
        toast('success', cardBookRepairMessage(repair) + ' Continuing.');
        res = await activateMenu(id);
    }
    // The two confirmable refusals loop back with the flag set; every other refusal is final and
    // already carries its named reasons.
    if (!res.ok && res.action === 'switch') {
        if (!await confirmPopup([
            { text: 'Replace the active StatusMenu?' },
            { text: 'Active now:', name: String(res.activeMenuId || '?') },
            { text: 'Installs:', name: id },
            { text: 'A card shows one menu, so this one takes its place.' },
        ], { okButton: 'Replace', isDestructive: true })) return;
        res = await activateMenu(id, { confirmSwitch: true });
    }
    if (!res.ok && res.action === 'downgrade') {
        if (!await confirmPopup(downgradeQuestion({ artifactName: id, installedVersion: res.installedVersion, libraryVersion: res.libraryVersion }), DOWNGRADE_QUESTION_BUTTONS)) return;
        res = await activateMenu(id, { confirmDowngrade: true, confirmSwitch: true });
    }
    if (res.ok) {
        toast('success', 'StatusMenu "' + id + '" ' + installActionDone(res.action) + '.');
        await repaintTab();
    } else if (res.reasons.length) {
        toast('error', res.reasons.join(' — '));
    }
}

// W6: the active menu back off the card, as a file — refusals name themselves.
async function onExportMenu() {
    const res = await exportActiveMenu();
    if (!res.ok) {
        for (const e of res.errors) log.warn('export refused: ' + e);
        toast('error', 'Not exported — ' + res.errors[0]);
        return;
    }
    for (const w of (res.warnings || [])) log.warn('export warning: ' + w);
    saveGeneratedFile(res.fileName, res.text, 'application/json');
    toast('success', 'Exported ' + res.fileName);
}

async function onUninstallMenu() {
    const state = await readCardMenuState();
    if (!state.registry) { toast('warning', 'No StatusMenu Pack is active on this card.'); return; }
    const inLibrary = (await listLibraryPacks() || []).some(
        (p) => p.packType === STATUSMENU_TYPE && p.id === state.registry.activeMenuId);
    if (!await confirmPopup([
        { text: 'Uninstall this StatusMenu from the card?' },
        { name: state.registry.activeMenuId + ' v' + state.registry.ver },
        { text: 'Its layout entry, owned engine entry and regexes are removed.' },
        inLibrary
            ? { text: 'The library copy stays, so you can install it again later.' }
            : { text: 'No library copy is left to install it again from. Import the pack file first if you may want it back.' },
    ], { okButton: 'Uninstall', isDestructive: true })) return;
    const res = await uninstallActiveMenu();
    if (res.ok) toast('success', 'Menu uninstalled — ' + res.removedEntries + ' entries removed.');
    else toast('error', res.reasons.join(' — '));
    await repaintTab();
}

// ── rendering ────────────────────────────────────────────────────────────────

// The page header's pill: the menu this card shows (activeArtifactPill).
function paintActiveMenu(pill) {
    $('#mvuh_smp_state').html(pill ? statusPill(pill) : '');
}

// The card's one menu row, or an empty state saying there is none. Returns the set of installed ids — the
// registerArtifactLane contract, so the library list can mark the installed menu and skip its install button.
export async function refreshStatusMenuUI() {
    const $box = $('#mvuh_smp_card');
    if (!$box.length) return new Set();
    $box.empty();
    const installedIds = new Set();
    const state = await readCardMenuState();
    const stop = cardGroupStop(state);
    if (stop) {
        if (stop.notice) { $box.html(notice(stop.notice)); void applyHelperLocale(); }
        paintActiveMenu(null);
        return installedIds;
    }
    if (!state.registry) {
        $box.html(emptyState({ icon: 'fa-table-list', text: 'No StatusMenu Pack on this card. Install one from the library below.' }));
        paintActiveMenu(activeArtifactPill({ packType: STATUSMENU_TYPE, isReadable: true }));
        void applyHelperLocale();
        return installedIds;
    }
    const id = state.registry.activeMenuId;
    installedIds.add(id);

    const led = await readMenuLed();
    const library = await listLibraryPacks() || [];
    const libraryCopy = library.find((p) => p.packType === STATUSMENU_TYPE && p.id === id) || null;
    const { status, offer } = decideCardRow({ led, libraryCopy, installedVersion: state.registry.ver });
    const data = (action) => ({ 'smp-action': action, 'smp-id': id });
    const name = (libraryCopy && libraryCopy.name) || id;
    $box.html(listRow({
        icon: 'fa-table-list',
        name,
        sub: [artifactIdLine({ id, version: state.registry.ver }), ...status.sub],
        pills: status.pills.map((pill) => statusPill(pill)),
        actions: [
            ...(offer.repair ? [button({ text: 'Repair', icon: 'fa-screwdriver-wrench', data: data('install') })] : []),
            ...(offer.upgrade ? [button({ text: 'Upgrade', icon: 'fa-circle-up', data: data('install') })] : []),
            iconButton({ icon: 'fa-file-export', title: 'Export', data: data('export') }),
            iconButton({ icon: 'fa-trash', title: 'Uninstall', isDanger: true, data: data('uninstall') }),
        ],
    }));
    paintActiveMenu(activeArtifactPill({ packType: STATUSMENU_TYPE, isReadable: true, artifact: { name, status: status.pill.status } }));
    void applyHelperLocale();     // rebuilt markup carries data-i18n keys that were never translated
    return installedIds;
}

// ── the §9.3 dev lane — [MVU_StatusMenuEngine] alone, nothing else touched ───

// The Development tab's StatusMenu Engine dev upload: its status (menuEngineStatusView) and its buttons. Load file, Install
// engine and Clear engine work on the card's lorebook, so they wait, disabled, for a card this lane can write to — a
// readable lorebook as well as the chat the card gate waits for. Repainted on that tab's open, on every chat change and
// after its own install or clear.
export async function refreshMenuEngineUpload() {
    const $status = $('#mvuh_sme_status');
    if (!$status.length) return;
    const { canOperateOnCard } = await readCardAccess();
    $('#mvuh_sme_load, #mvuh_sme_install, #mvuh_sme_clear').prop('disabled', !canOperateOnCard);
    const view = menuEngineStatusView({ isCardReadable: canOperateOnCard, read: canOperateOnCard ? await readMenuEngineCode() : null });
    $status.html(!view ? '' : view.row ? listRow(view.row) : emptyState(view.empty));
    void applyHelperLocale();
}

async function onInstallDevEngine() {
    const text = String($('#mvuh_sme_text').val() || '').trim();
    if (!text) { toast('warning', 'Paste the engine JS first.'); return; }
    if (!declaredVersionOf(text)) {
        // The same rule 3 the pack file faces — an engine that declares no version makes the reload
        // line and every future upgrade unreadable, so it is refused here too, with the same
        // instruction. A PRESENCE check only: nothing here ever compares one version to another.
        toast('error', 'The engine text declares no version — add `const ENGINE_VERSION = "v<major>.<minor>"` near the top and export it.');
        return;
    }
    const wrote = await writeMenuEngineCode(text);
    if (!wrote) { toast('error', 'Could not write [MVU_StatusMenuEngine] — the card book is unavailable.'); return; }
    await loadLogicEngine({ force: true });        // the text set changed — reboot, all scopes reload (§9.2)
    const missing = await checkMenuFormatterCoverage();
    toast('success', 'StatusMenu Engine installed and the Worker reloaded.'
        + (missing.length ? ' ⚠ ' + missing.length + ' formatter(s) the layout names are missing — see console.' : ''));
    await refreshMenuEngineUpload();
}

async function onClearDevEngine() {
    if (!await confirmPopup([
        { text: 'Remove the [MVU_StatusMenuEngine] entry from this card?' },
        { text: 'Every formatter-driven cell shows raw values until an engine is installed again.' },
        { text: 'Installing a StatusMenu Pack again restores its copy.' },
    ], { okButton: 'Remove', isDestructive: true })) return;
    const removed = await clearMenuEngineCode();
    if (!removed) { toast('warning', 'Nothing to remove — no engine entry on this card.'); return; }
    await loadLogicEngine({ force: true });
    toast('success', 'StatusMenu Engine removed and the Worker reloaded.');
    await refreshMenuEngineUpload();
}

// Delegated from the menu row this file paints (#mvuh_smp_card, inside On this card), wired once by the composition root.
export function wireStatusMenuHandlers() {
    $('#mvuh_smp_card').on('click', '[data-smp-action]', async function onClick(ev) {
        ev.preventDefault();
        const $el = $(this);
        const action = $el.data('smp-action');
        try {
            if (action === 'install') await onInstallMenuFromLibrary(String($el.data('smp-id') || ''));
            else if (action === 'export') await onExportMenu();
            else if (action === 'uninstall') await onUninstallMenu();
        } catch (e) {
            log.error('' + action + ' failed:', e);
            toast('error', 'StatusMenu ' + action + ' failed — see console.');
        }
    });
    $('#mvuh_sme_install').on('click', () => void onInstallDevEngine().catch((e) => { log.error('dev install failed:', e); toast('error', 'Engine install failed — see console.'); }));
    $('#mvuh_sme_clear').on('click', () => void onClearDevEngine().catch((e) => { log.error('dev clear failed:', e); toast('error', 'Engine clear failed — see console.'); }));
    $('#mvuh_sme_load').on('click', async () => {
        const text = await pickTextFile({ accept: '.js,.cjs,.txt' });
        if (text !== null) $('#mvuh_sme_text').val(text);
    });
}
