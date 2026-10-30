// gamelogic-pack/artifact-tabs-ui.js — what the two artifact tabs, GameLogic Packs and StatusMenu Packs, share: the
// unreadable-lorebook notice, the Pack library card and the Import card, one tab per row of ARTIFACT_TABS
// (artifact-tabs-core.js). Each tab's card group belongs to the lane that owns its type: the GameLogic Pack
// (gamelogic-pack-ui.js), the plugins (features/gamelogic-plugin), the menu (features/statusmenu-pack).
//
// THE THREE CARDS, IN THIS ORDER — identical to the Event Packs tab:
//   On this card  — only what is INSTALLED here, each row with its state pill, painted by the tab's lanes
//   Pack library  — the tab's types, stored: Install to this card / Remove from library
//   Import        — paste or load a file → Validate → Add to library, or import a source folder or ZIP. Either tab's copy
//                   takes every type, and its toast names the tab that lists what it added (libraryAddedText).
// Installing starts from the library row, the same gesture as on the Event Packs tab, so a card section never lists an
// artifact that is NOT on the card under a heading that says it is.
//
// DELIBERATELY NO in-chat guard on the library half: the library book is ROOT-LEVEL and never bound to a character, so
// importing and removing artifacts needs no chat at all. Gating it would teach users the false rule "packs belong to a
// card". Only the per-card half waits for a chat: the card gate's declarations on On this card, on the unreadable notice
// and on each library row's Install (data-mvuh-needs).
//
// The lanes REGISTER rather than being imported: a plugin's and a menu's activation import this feature's barrel for the
// shared file validator, so importing them here would close a cycle (P5). The decisions are pure (artifact-tabs-core.js,
// gamelogic-pack-core.js); the book plumbing is gamelogic-pack-library.js; this file is GUI only.

import { toast } from '../../sillytavern/mvu-bridge.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { readCardAccess, repairCardBookLink } from '../../sillytavern/card-access.js';
import { cardAccessProblem, cardUnreadableReason, cardBookRepairMessage } from '../../sillytavern/card-access-core.js';
import { libraryRemoveQuestion, LIBRARY_REMOVE_BUTTONS } from '../../shared/card-artifact-store.js';
import { readZip } from '../../shared/stored-zip.js';
import { pickFiles, pickTextFile } from '../../shared/pick-files.js';
import { readMenuEngineExportsInWorker } from '../logic-engine/index.js';
import { listRow, statusPill, iconButton, button, emptyState, notice, groupTitle, resultList } from '../settings-panel/index.js';
import { judgePackFile, buildWorkspaceArtifacts, schemaRemovalToastText } from './gamelogic-pack-core.js';
import { ARTIFACT_TABS, artifactTabOf, cardLoreRepairButton, libraryGroups, libraryAddedText, packFileReportView, sourceReportView } from './artifact-tabs-core.js';
import { installPackToLibrary, listLibraryPacks, deleteLibraryPack } from './gamelogic-pack-library.js';

const log = createModuleLog('gamelogic-pack');

// ── the lanes ────────────────────────────────────────────────────────────────

// One per artifact type, registered at startup:
//   install(id)    — run that type's install-from-library flow
//   installedIds() — paint that type's card group, and return the ids of that type on this card, so its library row can
//                    say so and skip its install
const lanes = new Map();

export function registerArtifactLane(packType, { install, installedIds }) {
    lanes.set(packType, { install, installedIds });
}

// A tab's one repaint: on tab open, on chat change, and after every install, uninstall, library add and Remove.
export async function refreshArtifactTab(name) {
    if (!$(`#mvuh_panel_${name}`).length) return;
    const tab = ARTIFACT_TABS[name];
    paintCardAccess(tab, await readCardAccess());
    const installedIds = new Set();
    for (const packType of tab.packTypes) {
        const lane = lanes.get(packType);
        if (lane) for (const id of await lane.installedIds()) installedIds.add(id);
    }
    await renderLibrary(tab, installedIds);
    void applyHelperLocale();
}

// The schema allow-list's removals get a toast of their own: what they report did NOT install, and a user who reads only
// the green "Added" line has to learn it anyway.
export function toastSchemaRemovals(res, lead) {
    const text = schemaRemovalToastText(res, lead);
    if (text) toast('warning', text);
}

// An unknown section is the other warning with a toast of its own, for the same reason. The rest (absent version, a regex
// that may not compile) stay in the report, where the eye already is. Named with both version numbers so the next
// question ("update what?") is answered in the toast rather than the console.
function toastUnknownSections(res, lead) {
    const unknown = (res && res.unknownSections) || [];
    if (!unknown.length) return;
    toast('warning', lead + ' — unknown section' + (unknown.length > 1 ? 's' : '') + ' '
        + unknown.map((s) => '"' + s + '"').join(', ')
        + ' NOT installed (file format ' + (res.declaredFormat || '?')
        + ', this mvu-helper understands ' + (res.supportedFormat || '?') + '). The report says why.');
}

// ── the unreadable-lorebook notice ───────────────────────────────────────────

// "Open a chat first" is an INSTRUCTION, and the card gate shows it (the page's data-mvuh-notice-for); a lorebook that
// cannot be read is a different problem, and which one is honest is the shared cardAccessProblem ordering, not this
// paint's to re-derive. Its reason is written at paint time: three of the four reasons a book does not answer never
// resolve, so a fixed "retry in a moment" would be a wait that cannot end (cardUnreadableReason). Its fix is a BUTTON,
// never an automatic dialog: this repaint runs on tab open and on every chat change, so a repair (or even the question)
// from here would fire on every card the developer clicks through. The button's words name the actual outcome: linking
// and importing are different things to consent to.
function paintCardAccess(tab, state) {
    const $slot = $(`#${tab.idPrefix}_unreadable`);
    if (cardAccessProblem(state) !== 'card-unreadable') { $slot.empty(); return; }
    const repair = cardLoreRepairButton({ binding: state.bookBinding, canLink: state.canLinkExistingBook });
    $slot.html(notice({
        status: 'warning',
        text: 'Lorebook not readable',
        name: cardUnreadableReason({ binding: state.bookBinding, bookName: state.bookName, canLink: state.canLinkExistingBook }),
        action: repair ? button({ ...repair, icon: 'fa-book', data: { 'library-action': 'repair-lore' } }) : '',
    }));
}

// The notice's button. Same repair the install gestures make, reachable BEFORE the user picks an artifact — a card with no
// worldbook is broken for every artifact type at once, so fixing it should not require choosing one first.
async function onRepairCardBook() {
    const res = await repairCardBookLink();
    if (!res.offered) toast('warning', 'This card\'s worldbook problem is not one this button can fix — see the notice above.');
    else if (res.resolved) toast('success', cardBookRepairMessage(res));
    else if (res.reason !== 'declined') toast('error', res.reason);
    for (const name of Object.keys(ARTIFACT_TABS)) await refreshArtifactTab(name);
}

// ── the library list ─────────────────────────────────────────────────────────

// The tab's library rows. THIS is where installing onto a card starts. "Install to this card" is offered only for a type a
// lane can install and a file that still parses — a button that cannot work is worse than no button, because its refusal
// reads as a bug in the pack (libraryRowView). It waits for a chat behind the card gate (needs); a card whose lorebook
// cannot be read keeps it, since each lane's install offers the repair first.
async function renderLibrary(tab, installedIds) {
    const $list = $(`#${tab.idPrefix}_list`);
    const packs = await listLibraryPacks();
    if (packs === null) {
        // Could not LOOK — not the same as an empty library, and saying "nothing stored" here would be a lie (unavailable
        // is not absent). A library never created reads the same way, so the line names both.
        $list.html(emptyState({ icon: 'fa-box-open', text: 'No library yet. The first import creates it; if you have imported before, Refresh tries again.' }));
        return;
    }
    const groups = libraryGroups(packs, { packTypes: tab.packTypes, installedIds, installableTypes: new Set(lanes.keys()) });
    if (!groups.length) {
        $list.html(emptyState({ icon: 'fa-box-open', text: 'Nothing stored here yet. Import one below.' }));
        return;
    }
    $list.html(groups.map((group) => (group.title ? groupTitle(group.title) : '') + group.rows.map((row) => {
        const data = (action) => ({ 'library-action': action, 'library-type': group.packType, 'library-id': row.id });
        return listRow({
            icon: row.icon,
            name: row.name,
            sub: row.sub,
            pills: row.pills.map(statusPill),
            actions: [
                ...(row.canInstall ? [button({ text: 'Install to this card', icon: 'fa-download', needs: 'chat', data: data('install') })] : []),
                iconButton({ icon: 'fa-trash', title: 'Remove from library', isDanger: true, data: data('delete') }),
            ],
        });
    }).join('')).join(''));
}

async function onDelete(packType, id) {
    if (!await confirmPopup(libraryRemoveQuestion(id), LIBRARY_REMOVE_BUTTONS)) return;
    const removed = await deleteLibraryPack(packType, id);
    if (!removed) { toast('error', 'Nothing was removed — the entry was not found or the lorebook API is unavailable.'); return; }
    toast('success', 'Removed ' + id + ' from the library.');
    await refreshArtifactTab(artifactTabOf(packType));
}

// ── Import: the same card on both tabs ───────────────────────────────────────

// One tab's Import card, under that tab's id prefix. Each copy keeps its own state: the last validated text (Add is offered
// only for text that passed, and any edit voids it — the event-pack tab's idiom: never add what was not the thing
// validated), the last judged source, and the pick being judged.
//
// A source is the folder `npm run dev` watches, imported whole: every artifact in it goes through buildWorkspaceArtifacts —
// the SAME pipeline the dev server runs (the same-assembler invariant) — and only artifacts with zero errors are offered.
// A picked menu's engine is READ in the engine frame's throwaway Worker, never run on the page.
function wireArtifactImport(name) {
    const tab = ARTIFACT_TABS[name];
    const $part = (part) => $(`#${tab.idPrefix}_${part}`);
    let lastValidated = null;
    let lastSourceBuild = null;
    // Judging is async (a menu engine is read in a Worker), so a pick made while an earlier one is still being judged must
    // not have its report overwritten by the earlier one's.
    let sourcePickSeq = 0;

    const renderReport = (view) => {
        $part('report').html(resultList(view));
        void applyHelperLocale();
    };

    async function onValidate() {
        const text = String($part('text').val() || '').trim();
        if (!text) { toast('warning', 'Paste a pack file first.'); return; }
        const res = await judgePackFile(text, { readMenuEngine: readMenuEngineExportsInWorker });
        renderReport(packFileReportView(res));
        lastValidated = res.ok ? text : null;
        lastSourceBuild = null;                         // the report now answers for THIS text
        $part('source_add').hide();
        $part('add').toggle(res.ok);
        if (!res.ok) toast('error', 'Not added — ' + res.errors.length + ' error(s); the report names each rule.');
        else { toastUnknownSections(res, 'Valid'); toastSchemaRemovals(res, 'Valid'); }
    }

    async function onAdd() {
        const text = String($part('text').val() || '').trim();
        if (!lastValidated || text !== lastValidated) { toast('warning', 'Validate first — the text changed since the last validation.'); return; }
        const res = await installPackToLibrary(text);
        renderReport(packFileReportView(res));
        if (!res.ok) { toast('error', 'Not added: ' + res.errors[0]); return; }
        toast('success', libraryAddedText(res, name));
        toastUnknownSections(res, 'Added');
        toastSchemaRemovals(res, 'Added');
        lastValidated = null;
        $part('add').hide();
        await refreshArtifactTab(name);
    }

    async function onSourceFiles(files) {
        const pick = ++sourcePickSeq;
        lastSourceBuild = null;
        $part('source_add').hide();
        let artifacts;
        try {
            artifacts = await buildWorkspaceArtifacts(files, { readMenuEngine: readMenuEngineExportsInWorker });
        } catch (e) {
            log.child('tab').error('the source could not be judged — nothing is offered for the library:', e);
            toast('error', 'The source could not be checked: ' + String(e && e.message));
            return;
        }
        if (pick !== sourcePickSeq) return;
        const clean = artifacts.filter((a) => a.pack && !a.errors.length);
        lastSourceBuild = clean.length ? clean : null;
        renderReport(sourceReportView(artifacts));
        $part('add').hide();                            // the paste flow's Add answers for OTHER bytes
        $part('source_add').toggle(clean.length > 0);
        $part('source_add_count').text('(' + clean.length + ')');   // the count only: the label beside it is translated
        const failed = artifacts.length - clean.length;
        if (failed > 0) toast('warning', failed + ' artifact(s) not addable — the report names each error.');
        for (const a of clean) {
            toastUnknownSections(a, (a.pack.name || a.name || 'artifact'));
            toastSchemaRemovals(a, (a.pack.name || a.name || 'artifact'));
        }
        log.lifecycle('source import judged ' + artifacts.length + ' artifact(s), ' + clean.length + ' clean');
    }

    async function onAddSource() {
        if (!lastSourceBuild) { toast('warning', 'Import a source folder or ZIP first.'); return; }
        const added = [];
        for (const a of lastSourceBuild) {
            const res = await installPackToLibrary(JSON.stringify(a.pack));
            if (!res.ok) { toast('error', 'Not added: ' + res.errors[0]); return; }
            added.push(libraryAddedText(res, name));
        }
        toast('success', added.join(' · '));
        lastSourceBuild = null;
        $part('source_add').hide();
        await refreshArtifactTab(name);
    }

    async function onPickSourceFolder(pickedFiles) {
        const files = await Promise.all(pickedFiles.map(async (f) => ({
            path: f.webkitRelativePath || f.name,
            text: await f.text(),
        })));
        await onSourceFiles(files);
    }

    async function onPickSourceZip(file) {
        try {
            const members = await readZip(new Uint8Array(await file.arrayBuffer()));
            const decode = new TextDecoder();
            await onSourceFiles(members.map((m) => ({ path: m.path, text: decode.decode(m.bytes) })));
        } catch (e) {
            log.child('tab').warn('zip read failed:', e);
            toast('error', 'Could not read the archive: ' + String(e && e.message));
        }
    }

    $part('validate').on('click', () => void onValidate());
    $part('add').on('click', () => void onAdd());
    $part('text').on('input', () => { lastValidated = null; $part('add').hide(); });
    $part('load').on('click', async () => {
        const text = await pickTextFile({ accept: '.json,.txt' });
        if (text === null) return;
        $part('text').val(text);
        lastValidated = null;
        $part('add').hide();
        void onValidate();
    });
    $part('import_folder').on('click', async () => {
        const files = await pickFiles({ isDirectory: true });
        if (files.length) void onPickSourceFolder(files);
    });
    $part('import_zip').on('click', async () => {
        const [file] = await pickFiles({ accept: '.zip' });
        if (file) void onPickSourceZip(file);
    });
    $part('source_add').on('click', () => void onAddSource());
}

// ── wiring ───────────────────────────────────────────────────────────────────

export function wireArtifactTabs() {
    for (const name of Object.keys(ARTIFACT_TABS)) wireArtifactImport(name);
    $('#mvuh_gp_refresh').on('click', () => void refreshArtifactTab('gamelogic'));
    $('#mvuh_smp_refresh').on('click', () => void refreshArtifactTab('statusmenu'));
    $('#mvuh_gp_unreadable, #mvuh_smp_unreadable').on('click', '[data-library-action="repair-lore"]', () => void onRepairCardBook());
    // Library-list buttons (delegated — the lists are rebuilt on every refresh). Only INSTALL needs a chat: the library
    // book is root-level, so removing from it is valid with no card open at all. Install is bound to the declared button
    // only (needs: 'chat'), so the card gate covers it. Its type's lane owns the install flow.
    $('#mvuh_gp_list, #mvuh_smp_list').on('click', '[data-mvuh-needs][data-library-action="install"]', function () {
        void lanes.get($(this).attr('data-library-type')).install($(this).attr('data-library-id'));
    });
    $('#mvuh_gp_list, #mvuh_smp_list').on('click', '[data-library-action="delete"]', function () {
        void onDelete($(this).attr('data-library-type'), $(this).attr('data-library-id'));
    });
}
