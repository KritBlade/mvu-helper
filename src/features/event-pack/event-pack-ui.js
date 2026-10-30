// event-pack/event-pack-ui.js — the "Event Packs" tab (plans/event-pack-plan.md P3b, §5.5).
//
// THE install lane for community [MVU_Event_Pack] entries — the ONLY path that keeps the three
// stores consistent (worldbook entry = prose · EventPack.triggers = rows · the card-declared armed slot):
//   • Install (paste/upload): validate (§4) + EJS lint (§5) + duplicate guard (§3.3) → create/update
//     the pack's worldbook entry + the tab-owned [MVU_Event_Pack_Registry] record → syncCardData()
//     merges the rows into the CURRENT chat; every other chat under the card picks the pack up on
//     its next load (shared standalone worldbook — ST design).
//   • On this card: one row per installed pack, read from buildPackInfo (the same read MvuHelper.packInfo
//     reports) — its state as a pill, version, event count and fired state; Disable/Enable and Uninstall.
//   • Pack library: one row per stored pack — Install to this card, Remove.
// What each row and the import preview show is decided in event-pack-tab-core.js; this file builds the genes and
// does the lorebook/MVU I/O. In-chat guard (§5.5): with no active chat there is no card to write to, so the card gate
// greys On this card, Import and each library row's Install to this card (data-mvuh-needs) and shows the page's notice.

import { getStandaloneLorebookEntries, upsertLorebookEntry, upsertLorebookEntryFields, deleteLorebookEntriesByNeedle, flushLorebookWrites } from '../../sillytavern/lorebook.js';
import { toast } from '../../sillytavern/mvu-bridge.js';
import { isCardChatActive } from '../../sillytavern/card-access.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { syncCardData } from '../card-sync/index.js';
import { REGISTRY_ENTRY_MATCH, REGISTRY_COMMENT, buildRegistryContent, packEntryComment, buildPackInfo } from './event-pack-core.js';
import { installedPackRowView, libraryPackRowView, fileErrors, packPreviewView } from './event-pack-tab-core.js';
import { libraryRemoveQuestion, LIBRARY_REMOVE_BUTTONS } from '../../shared/card-artifact-store.js';
import { listStoredEventPacks, readStoredEventPack, deleteStoredEventPack } from './event-pack-library.js';
import { pickTextFile } from '../../shared/pick-files.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { listRow, statusPill, iconButton, button, emptyState, notice, resultList } from '../settings-panel/index.js';
// The install itself, and the reads it shares with this tab. It lives beside this file rather than in
// it so the artifact dev loop can run the SAME install a person runs (workflow plan §4.1).
import { validateUploadFile, installValidatedPacks, readRegistry, readCardEventContract, readChatStatData } from './event-pack-install.js';

const log = createModuleLog('event-pack');

// The §5.5 in-chat guard: install/uninstall/disable need a bound card + worldbook + save.
// isCardChatActive, NOT a bare `latestMsgId() >= 0`: the lobby's placeholder chat has messages, so
// the bare count passed there and let an install proceed with no card at all (card-access.js).
const hasActiveChat = () => isCardChatActive();

// ── Import: validate + install ───────────────────────────────────────────────

function renderPreview(res) {
    $('#mvuh_ep_preview').html(res ? resultList(packPreviewView(res)) : '');
    void applyHelperLocale();
}

// A REFUSAL MUST BE LOUD (user, 2026-08-05). The preview panel lists every error, but it scrolls and
// the author may be looking at the textarea — a file that quietly doesn't install reads as installed,
// which is the failure mode this whole feature keeps closing. So: red toast, the count, and the FIRST
// error spelled out, with the rest pointed at the preview rather than stacked into an unreadable wall.
function toastRefusal(res) {
    const all = fileErrors(res);
    if (!all.length) return;
    const more = all.length > 1 ? `  (+${all.length - 1} more — see the preview below)` : '';
    toast('error', `Nothing installed — ${all.length} error${all.length > 1 ? 's' : ''} in this file. ${all[0]}${more}`);
}

let lastValidated = null;   // { text, res } — Install re-checks the text hasn't changed since Validate

async function onValidate() {
    const text = String($('#mvuh_ep_text').val() || '');
    if (!text.trim()) { renderPreview(null); return; }
    const res = await validateUploadFile(text);
    lastValidated = { text, res };
    renderPreview(res);
    const installable = res.packs.length && !fileErrors(res).length
        && res.packs.every((p) => p.action === 'install' || p.action === 'upgrade');
    $('#mvuh_ep_install').toggle(!!installable);
    toastRefusal(res);
}

async function onInstall() {
    if (!hasActiveChat()) { toast('warning', 'Open a chat first — installing needs an active card.'); return; }
    const text = String($('#mvuh_ep_text').val() || '');
    if (!lastValidated || lastValidated.text !== text) { await onValidate(); return; }   // text changed → re-validate instead
    const { res } = lastValidated;
    // ALL-OR-NOTHING. Re-checked here and not only at Validate, because this is the last gate before a
    // write: a half-installed chain leaves a pack whose prereq names an absent one, and it fails by
    // never firing — the silent mode this project keeps closing.
    if (!res.packs.length || fileErrors(res).length) { toastRefusal(res); return; }

    // The writes themselves are event-pack-install.js's — the same call the dev loop makes, so a
    // developer's loop and a player's paste cannot drift apart.
    const done = await installValidatedPacks(res);
    for (const w of done.warnings) toast('warning', `Installed, but ${w}`);
    if (!done.ok) { toast('error', done.reasons[0] || 'The install refused.'); return; }
    if (done.installedIds.length > 1) {
        toast('success', `Installing ${done.installedIds.length} packs from this file: ${done.installedIds.join(', ')}`);
    }

    lastValidated = null;
    $('#mvuh_ep_install').hide();
    await refreshEventPackUI();
}

// ── On this card ─────────────────────────────────────────────────────────────

async function setPackEnabled(id, enabled) {
    const res = await upsertLorebookEntryFields(packEntryComment(id).toLowerCase(), { enabled });
    if (!res) { toast('error', 'Could not update the worldbook entry.'); return; }
    await flushLorebookWrites();   // §12a.2 — never leave a write riding ST's cross-book save debounce
    await syncCardData();          // prune (disable) / re-merge (enable) — §5.5
    await refreshEventPackUI();
}

async function uninstallPack(id) {
    // The LIBRARY copy is deliberately NOT touched — uninstall is a per-card operation, and the stored
    // copy is what puts the pack back (§4b). Removing both would make "uninstall" quietly mean "throw
    // the file away", which is the Remove button in the library section and nowhere else.
    if (!await confirmPopup([
        { text: 'Uninstall this event pack from the card?' },
        { name: id },
        { text: 'Its entry and events are removed.' },
        { text: 'Fired history, quests and the library copy stay.' },
    ], { okButton: 'Uninstall', isDestructive: true })) return;
    await deleteLorebookEntriesByNeedle(packEntryComment(id).toLowerCase());
    const entries = await getStandaloneLorebookEntries();
    const { registry } = readRegistry(entries || []);
    if (registry && registry[id] !== undefined) {
        delete registry[id];
        await upsertLorebookEntry(REGISTRY_ENTRY_MATCH, REGISTRY_COMMENT, buildRegistryContent(registry));
    }
    await flushLorebookWrites();   // §12a.2
    await syncCardData();          // inverse-prune drops the rows + per-chat record (§5.5)
    await refreshEventPackUI();
}

// One installed pack's row, from its packInfo row: Disable or Enable while its entry exists, then Uninstall.
function installedRowHtml(row) {
    const view = installedPackRowView(row);
    const data = (action) => ({ 'ep-action': action, 'ep-id': row.id });
    const actions = [];
    if (view.toggle === 'disable') actions.push(iconButton({ icon: 'fa-pause', title: 'Disable', data: data('disable') }));
    if (view.toggle === 'enable') actions.push(iconButton({ icon: 'fa-play', title: 'Enable', data: data('enable') }));
    actions.push(iconButton({ icon: 'fa-trash', title: 'Uninstall', isDanger: true, data: data('uninstall') }));
    return listRow({ icon: 'fa-calendar-days', name: row.id, sub: view.sub, pills: [statusPill(view.pill)], actions });
}

// The page header's "Installed: N", hidden while the card's packs cannot be counted.
function paintInstalledCount(count) {
    $('#mvuh_ep_count').text(String(count ?? ''));
    $('#mvuh_ep_count_pill').toggle(count !== null);
}

export async function refreshEventPackUI() {
    if (!$('#mvuh_panel_events').length) return;
    const chatReady = hasActiveChat();

    const $list = $('#mvuh_ep_list');
    const entries = chatReady ? await getStandaloneLorebookEntries() : null;
    // THE LIBRARY IS RENDERED ON EVERY PATH, including the ones below that give up on the installed
    // list. It is a ROOT-LEVEL book with no card in it: "this card has no worldbook yet" says nothing
    // about what is stored, and blanking the section there would hide the packs at exactly the moment
    // a user is recovering a rebuilt card (§4b).
    const { registry } = entries === null ? { registry: {} } : readRegistry(entries);
    // ONE read of the library book per refresh, shared by both sections below.
    const stored = await listStoredEventPacks();
    renderEventPackLibrary(stored, new Set(Object.keys(registry || {})));

    if (!chatReady) { paintInstalledCount(null); $list.empty(); return; }   // the card gate's notice says why
    if (entries === null) {
        paintInstalledCount(null);
        $list.html(emptyState({ icon: 'fa-hourglass-half', text: "The card's lorebook is not ready yet. Refresh tries again." }));
        void applyHelperLocale();
        return;
    }
    if (registry === null) {
        paintInstalledCount(null);
        $list.html(notice({ status: 'danger', text: 'The [MVU_Event_Pack_Registry] entry is malformed: fix or delete it, then refresh.' }));
        void applyHelperLocale();
        return;
    }
    const ids = Object.keys(registry);
    paintInstalledCount(ids.length);
    if (!ids.length) {
        $list.html(emptyState({ icon: 'fa-calendar-xmark', text: 'No event packs on this card yet.' }));
        void applyHelperLocale();
        return;
    }

    // The LIST is still worth rendering without engine paths — the packs and their versions are real,
    // and hiding them would leave a user with installed packs staring at an empty tab. Only the fired
    // COUNT needs the trigger root, so the notice says why that count is unknown.
    const enginePaths = readCardEventContract().paths;
    const statData = await readChatStatData();
    const info = buildPackInfo({ entries, registry, stored, statData, enginePaths });
    const rows = enginePaths.ok ? [] : [notice({ status: 'warning', text: 'Fired counts are unknown', name: enginePaths.reason })];
    for (const row of info.card.packs) rows.push(installedRowHtml(row));
    $list.html(rows.join(''));
    void applyHelperLocale();   // rows are rebuilt — re-translate their [data-i18n] nodes
}

// ── Pack library (§4b) — what survives a card rebuild ────────────────────────

// Install a stored pack onto THIS card, through the exact same gate a paste goes through: the stored
// text is hand-editable (it is a lorebook entry), so trusting the install-time validation would let an
// edit skip every rule. Reusing onValidate/onInstall is deliberate — a second install path is a second
// place for the three stores to fall out of step.
async function installFromLibrary(id) {
    const text = await readStoredEventPack(id);
    if (text === null) { toast('error', `"${id}" is not in the library (or the library book is not readable).`); return; }
    $('#mvuh_ep_text').val(text);
    await onValidate();                                     // renders the preview and toasts any refusal
    if (!lastValidated || fileErrors(lastValidated.res).length) return;
    await onInstall();
}

async function removeFromLibrary(id) {
    if (!await confirmPopup(libraryRemoveQuestion(id), LIBRARY_REMOVE_BUTTONS)) return;
    const removed = await deleteStoredEventPack(id);
    if (removed) log.lifecycle(`library copy removed: ${id}`);
    await flushLorebookWrites();   // §12a.2
    await refreshEventPackUI();
}

// One stored pack's row: Install to this card (needs an open chat), then Remove.
function libraryRowHtml(stored, installedIds) {
    const view = libraryPackRowView(stored, { isOnThisCard: installedIds.has(stored.id) });
    const data = (action) => ({ 'ep-action': action, 'ep-id': stored.id });
    const actions = [];
    if (view.canInstall) actions.push(button({ text: 'Install to this card', icon: 'fa-download', needs: 'chat', data: data('library-install') }));
    actions.push(iconButton({ icon: 'fa-trash', title: 'Remove from library', isDanger: true, data: data('library-remove') }));
    return listRow({ icon: 'fa-box-archive', name: stored.id, sub: view.sub, pills: view.pills.map(statusPill), actions });
}

// `stored` is passed IN, not fetched here: the installed list needs the same read to decide amber, and
// two fetches of one book per refresh would be two chances to disagree with each other.
function renderEventPackLibrary(stored, installedIds) {
    const $lib = $('#mvuh_ep_library');
    if (!$lib.length) return;
    // "Could not look" and "nothing stored" are different sentences, because one is a problem and the
    // other is a normal empty state (the §4 rule the pack library already follows). A library book never
    // created reads as "could not look" too, so that line names both — the GameLogic library says the same.
    if (stored === null) $lib.html(emptyState({ icon: 'fa-box-open', text: 'No library yet. The first import creates it; if you have imported before, Refresh tries again.' }));
    else if (!stored.length) $lib.html(emptyState({ icon: 'fa-box-open', text: 'No event packs stored yet. Installing one keeps a copy here.' }));
    else $lib.html(stored.map((s) => libraryRowHtml(s, installedIds)).join(''));
    void applyHelperLocale();
}

// ── wiring ───────────────────────────────────────────────────────────────────

export function wireEventPackTab() {
    $('#mvuh_ep_validate').on('click', () => void onValidate());
    $('#mvuh_ep_install').on('click', () => void onInstall());
    $('#mvuh_ep_refresh').on('click', () => void refreshEventPackUI());
    $('#mvuh_ep_text').on('input', () => { lastValidated = null; $('#mvuh_ep_install').hide(); });
    $('#mvuh_ep_load').on('click', async () => {
        const text = await pickTextFile({ accept: '.txt,.json' });
        if (text === null) return;
        $('#mvuh_ep_text').val(text);
        lastValidated = null;
        $('#mvuh_ep_install').hide();
        void onValidate();
    });
    // Delegated buttons on the (rebuilt) installed list.
    $('#mvuh_ep_list').on('click', '[data-ep-action]', function () {
        if (!hasActiveChat()) { toast('warning', 'Open a chat first.'); return; }
        const id = $(this).attr('data-ep-id');
        const action = $(this).attr('data-ep-action');
        if (action === 'disable') void setPackEnabled(id, false);
        else if (action === 'enable') void setPackEnabled(id, true);
        else if (action === 'uninstall') void uninstallPack(id);
    });
    // ...and on the library list. Only INSTALL needs a chat: the library book is root-level, so removing from it is a
    // valid thing to do with no card open at all (§4b). Install is bound to the declared button only (needs: 'chat'),
    // so the card gate covers it; the chat check stays at the write.
    $('#mvuh_ep_library').on('click', '[data-mvuh-needs][data-ep-action="library-install"]', function () {
        if (!hasActiveChat()) { toast('warning', 'Open a chat first — installing writes to that card.'); return; }
        void installFromLibrary($(this).attr('data-ep-id'));
    });
    $('#mvuh_ep_library').on('click', '[data-ep-action="library-remove"]', function () {
        void removeFromLibrary($(this).attr('data-ep-id'));
    });
}
