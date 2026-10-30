// logic-engine/logic-engine-ui.js — the "LogicEngine" tab, and the Development tab's Engine dev upload.
//
// Per-card controls for the hosted resolver: the enable switch (profile flag), reload, remove, and the status — the page
// header's pill and the Engine card's row, built from the gene builders out of engineStatusView (logic-engine-core.js).
// The Engine dev upload replaces the engine text alone (paste or a .cjs/.js/.txt file → the [MVU_LogicEngine] lorebook
// entry), past any pack. Storage rules live in logic-engine-store.js; execution in logic-engine-loader.js — this file is
// GUI + wiring only. With no chat open there is no bound lorebook: the card gate greys the switch, Remove engine and the
// upload (data-mvuh-needs in settings.html) and shows each page's notice; this file leaves the state empty.
//
// There is no resolver-host picker: mvu-helper is the only host (turn-runner.js header), so the enable
// switch is the whole choice.

import { saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { toast } from '../../sillytavern/mvu-bridge.js';
import { isCardChatActive } from '../../sillytavern/card-access.js';
import { confirmPopup } from '../../sillytavern/popup.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { pickTextFile } from '../../shared/pick-files.js';
import { listRow, statusPill, emptyState } from '../settings-panel/index.js';
import { declaredVersionOf, engineStatusView } from './logic-engine-core.js';
import { getLogicEngineProfile, readEngineCode, writeEngineCode, clearEngineCode } from './logic-engine-store.js';
import { loadLogicEngine, getLogicEngineStatus } from './logic-engine-loader.js';
import { getTurnRunnerCounters } from './turn-runner.js';

const log = createModuleLog('logic-engine');

// isCardChatActive, NOT a bare `latestMsgId() >= 0`: the lobby's placeholder chat has messages, so
// the bare count passed there and let a write proceed with no card at all (card-access.js).
const hasActiveChat = () => isCardChatActive();

export async function refreshLogicEngineUI() {
    if (!$('#mvuh_panel_logic').length) return;
    const profile = getLogicEngineProfile();
    $('#mvuh_le_enabled').prop('checked', profile.enabled);
    if (!hasActiveChat()) {
        // No card, so nothing to report: a Worker still hosting the previous card's engine is not this page's.
        $('#mvuh_le_state').empty();
        $('#mvuh_le_status').empty();
        return;
    }
    // The entry first, then the loader's state, so the state is the fresher of the two.
    const installed = await readEngineCode();
    const s = getLogicEngineStatus();
    const view = engineStatusView({
        status: s.status,
        declared: { name: s.name, version: s.version },
        exports: s.exports,
        error: s.error,
        installed,
        counters: getTurnRunnerCounters(),
        isEnabled: profile.enabled,
    });
    const pill = statusPill(view.pill);
    $('#mvuh_le_state').html(pill);
    $('#mvuh_le_status').html(view.row
        ? listRow({ icon: 'fa-gears', ...view.row.title, sub: view.row.sub, pills: [pill] })
        : emptyState(view.empty));
    void applyHelperLocale();   // the pill and the row are rebuilt — re-translate their [data-i18n] nodes
}

async function onToggleEnabled() {
    const profile = getLogicEngineProfile();
    profile.enabled = $('#mvuh_le_enabled').prop('checked');
    saveSettingsDebounced();
    await loadLogicEngine({ force: true });   // enable → load now; disable → unload now
    await refreshLogicEngineUI();
}

// The chat checks below stay at the write: the card gate greys these buttons without a chat, but a write into the card's
// lorebook must not rest on a repaint having run.
async function onInstall() {
    if (!hasActiveChat()) { toast('warning', 'Open a chat first — installing writes to that card\'s worldbook.'); return; }
    const text = String($('#mvuh_le_text').val() || '');
    if (!text.trim()) { toast('warning', 'Paste or load the engine text first.'); return; }
    const wrote = await writeEngineCode(text);
    if (!wrote) { toast('error', 'Could not write the engine worldbook entry (book unavailable).'); return; }
    $('#mvuh_le_text').val('');
    toast('success', `LogicEngine ${declaredVersionOf(text) || ''} installed to the card's worldbook.`.replace('  ', ' '));
    await loadLogicEngine({ force: true });
    await refreshLogicEngineUI();
}

async function onClear() {
    if (!hasActiveChat()) { toast('warning', 'Open a chat first.'); return; }
    if (!await confirmPopup([
        { text: "Remove this card's LogicEngine entry?" },
        { text: 'The engine unloads; settings and stat_data stay.' },
    ], { okButton: 'Remove', isDestructive: true })) return;
    const n = await clearEngineCode();
    log.lifecycle(`cleared ${n} worldbook entr${n === 1 ? 'y' : 'ies'}`);
    await loadLogicEngine({ force: true });
    await refreshLogicEngineUI();
}

export function wireLogicEngineTab() {
    $('#mvuh_le_enabled').on('change', () => void onToggleEnabled());
    $('#mvuh_le_install').on('click', () => void onInstall());
    $('#mvuh_le_reload').on('click', async () => { await loadLogicEngine({ force: true }); await refreshLogicEngineUI(); });
    $('#mvuh_le_clear').on('click', () => void onClear());
    $('#mvuh_le_load').on('click', async () => {
        const text = await pickTextFile({ accept: '.cjs,.js,.txt' });
        if (text !== null) $('#mvuh_le_text').val(text);
    });
}
