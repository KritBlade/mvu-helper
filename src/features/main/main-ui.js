// main/main-ui.js — the "Main" tab.
//
// Its settings are GLOBAL (shared across every card), stored at the settings root via getGlobal(): the GUI
// language, console logging (the `debug_verbosity` level and the `debug_domain` switches sillytavern/log.js
// reads) and the StatusMenu frame's image sources. Its Card config actions are the exception: they act on
// the open card's profile.
//
// i18n: `language` is applied by sillytavern/i18n.js (applyHelperLocale) — our OWN
// applier over `[data-i18n]` nodes in our panels, independent of ST's global locale.
// Convention: every GUI string carries data-i18n + a matching i18n/<lang>.json key.

import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { LOG_DOMAINS } from '../../sillytavern/log.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { exportCardConfig, importCardConfig, resetCardConfig } from '../card-config/index.js';
import { syncCardData, seedPassSummary, isRetryableSkip } from '../card-sync/index.js';
import { toast } from '../../sillytavern/mvu-bridge.js';
import { refreshExtraLlmCallsUI } from '../small-llm/index.js';
import { updateImageUI } from '../imagegen/index.js';
import { refreshRosterUI } from '../character-roster/index.js';
import { MENU_IMAGE_SOURCES_SETTING, MENU_FRAME_IMAGE_SOURCES_DEFAULT, parseMenuImageSources } from '../statusmenu-pack/index.js';
import { createModuleLog } from '../../sillytavern/log.js';

const log = createModuleLog('main');

// GLOBAL defaults contributed by the Main tab — merged at the settings root by index.js.
export const mainDefaults = {
    language: 'en',           // 'en' | 'zh-cn'  (GUI language — applied live by sillytavern/i18n.js)
    debug_verbosity: 'lifecycle',   // 'off' | 'lifecycle' | 'verbose' | 'trace'  (see sillytavern/log.js).
                                    // lifecycle is O(1)/run — major state changes only, so it stays quiet
                                    // during play while giving a usable trail when something goes wrong.
    debug_domain: {},         // { imagegen?, roster?, smallllm?, pipeline? } — checkbox ids = mvuh_dom_<name>; `pipeline` is read by card-carried EJS/RES and `imagegen` by the galgame-companion script (see log.js LOG_DOMAINS)
    // Where a contained StatusMenu may load images from — CSP source expressions, space-separated
    // (plans/executed/statusmenu-containment.md D1/M6). Global and user-owned; the pack never sets it.
    [MENU_IMAGE_SOURCES_SETTING]: MENU_FRAME_IMAGE_SOURCES_DEFAULT,
};

export function updateMainUI() {
    const s = getGlobal();
    if ($('#mvuh_language').length) $('#mvuh_language').val(s.language || 'en');
    if ($('#mvuh_debug_verbosity').length) $('#mvuh_debug_verbosity').val(s.debug_verbosity || 'off');
    if ($('#mvuh_statusmenu_image_sources').length) {
        $('#mvuh_statusmenu_image_sources').val(typeof s[MENU_IMAGE_SOURCES_SETTING] === 'string' ? s[MENU_IMAGE_SOURCES_SETTING] : MENU_FRAME_IMAGE_SOURCES_DEFAULT);
    }
    const dom = s.debug_domain || {};
    for (const name of LOG_DOMAINS) {
        const $cb = $('#mvuh_dom_' + name);
        if ($cb.length) $cb.prop('checked', dom[name] === true);
    }
}

export function wireMain() {
    $('#mvuh_language').on('change', function () {
        getGlobal().language = $(this).val();
        saveSettingsDebounced();
        void applyHelperLocale();
    });
    $('#mvuh_debug_verbosity').on('change', function () {
        getGlobal().debug_verbosity = $(this).val();
        saveSettingsDebounced();
    });
    // The StatusMenu frame's image sources. Saved as typed; what the CSP cannot carry is named here,
    // once, at the moment it is typed — the frame builder drops it silently by design (a source can
    // never smuggle a directive). Mounted frames keep their CSP; the next mount reads the new value.
    $('#mvuh_statusmenu_image_sources').on('change', function () {
        const value = String($(this).val() || '').trim();
        getGlobal()[MENU_IMAGE_SOURCES_SETTING] = value;
        saveSettingsDebounced();
        const { sources, rejected } = parseMenuImageSources(value);
        if (rejected.length) {
            log.child('statusmenu-frame').warn('image sources: ' + rejected.length + ' token(s) are not CSP image sources and will not be in the frame\'s policy: '
                + rejected.join(', ') + ' — kept: ' + (sources.join(' ') || '(none beyond SillyTavern\'s own origin)'));
        }
    });
    for (const name of LOG_DOMAINS) {
        $('#mvuh_dom_' + name).on('change', function () {
            const g = getGlobal();
            g.debug_domain = g.debug_domain || {};
            g.debug_domain[name] = $(this).prop('checked');
            saveSettingsDebounced();
        });
    }

    // Card config: export the open card's MVU Helper setup into its [Initmvuhelper] lorebook entry, or re-import what the
    // card owns — its [InitVar] re-seeded into this chat's state (features/card-sync) and its settings MERGED into the
    // current profile (features/card-config) — and repaint the tabs that show them. The seed pass runs first, so the
    // settings toast knows whether anything else changed.
    $('#mvuh_export_config').on('click', function () { void exportCardConfig(); });
    $('#mvuh_reimport_config').on('click', async function () {
        const sync = await syncCardData();
        const seeded = seedPassSummary(sync);
        if (seeded) toast('success', `${seeded}. What this chat changed was kept.`);
        else if (isRetryableSkip(sync)) toast('warning', `The card's starting data could not be read yet (${sync.reason}) — press Re-import again in a moment.`);
        await importCardConfig({ force: true, isSeedChanged: Boolean(seeded) });
        refreshExtraLlmCallsUI();
        await refreshRosterUI();
    });
    // RESET — discards the stored setup, then re-imports (card-config.js explains why it is one action
    // and why it does not merge). Both paths confirm first; both repaint EVERY tab that reads the
    // profile, not just the LLM one, because a reset changes image + roster settings too. The panel
    // showing stale values after a reset would look exactly like the reset not working.
    $('#mvuh_reset_config').on('click', async function () {
        if (await resetCardConfig() !== 'cancelled') refreshProfileTabs();
    });
    $('#mvuh_reset_all_config').on('click', async function () {
        if (await resetCardConfig({ allCards: true }) !== 'cancelled') refreshProfileTabs();
    });
}

// Repaint every tab whose contents come from the per-card profile.
function refreshProfileTabs() {
    refreshExtraLlmCallsUI();
    updateImageUI();
    refreshRosterUI();
}
