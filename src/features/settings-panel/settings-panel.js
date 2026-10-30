// settings-panel/settings-panel.js — the panel's shell: switching tabs from the nav, the card scope (the chips and the
// card gate), the behaviours the genes share (a field's (?) detail, collapsing a card, a slider following its number
// box), and opening the panel in its dialog. Each tab's CONTENT is painted by its own feature; the tab table (which
// tabs exist and what repaints them) is composed in src/index.js and handed in through wireSettingsPanel.
//
// THE DIALOG. The extensions drawer gives an extension roughly half the window — too narrow for this
// panel — so the drawer holds only a launcher, and the panel opens in a near-fullscreen dialog. The panel
// is MOVED into it, never cloned: DOM listeners belong to the node, so every handler wired at startup keeps
// working inside the dialog with no re-binding, and on close it moves back to its hidden holder.
//
// THE CARD GATE. Per-card settings live in the card's profile, and in SillyTavern's lobby there is no card to save
// them to. Each region says what it needs (data-mvuh-needs, gui-dna-core.js), and paintCardScope makes every region
// whose need is unmet `inert` — no click, no keystroke, no focus — and shows its page's notice. Inert, not disabled:
// many controls are disabled for a reason of their own (Harvest via on Predefined, an install its lane refuses), and
// the gate leaves that state untouched underneath.
//
// THE THEME. The rail's foot switches the palette between Night Slate (dark, the default) and Soft Silver (light).
// The choice is GLOBAL (`panelTheme` at the settings root) and is written as data-mvuh-theme on <html>, which
// palette.css reads, so one write themes the panel and every dialog mvu-helper opens.

import { openPanelPopup } from '../../sillytavern/popup.js';
import { openCardName, isCardChatActive } from '../../sillytavern/card-access.js';
import { hasActiveCharacter } from '../../sillytavern/lorebook.js';
import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { isNeedUnmet, panelThemeOf } from './gui-dna-core.js';

const log = createModuleLog('settings-panel');

// The panel's markup, beside this module — module-relative, so it carries no install-folder name.
export const SETTINGS_PANEL_HTML_URL = new URL('./settings.html', import.meta.url).href;

// GLOBAL defaults contributed by the shell — merged at the settings root by index.js.
export const panelDefaults = {
    panelTheme: 'dark',   // 'dark' | 'light' — the palette the panel and its dialogs wear
};

let panelTabs = [];        // [{ name, onOpen? }] — the TABS table from src/index.js
let isPanelOpen = false;   // a second open would move the panel out from under the first

export function showPanelTab(which) {
    for (const tab of panelTabs) {
        const isShown = tab.name === which;
        $(`#mvuh_panel_${tab.name}`).toggle(isShown);
        $(`#mvuh_tab_${tab.name}`).toggleClass('is-active', isShown).attr('aria-current', isShown ? 'page' : null);
    }
}

// A slider mirrors the number box it is paired with (data-mvuh-slider-for), which owns the value. A repaint
// sets numbers with .val(), which fires no event, so whatever repaints a page with sliders calls this after.
export function syncSliders() {
    $('#mvuh_panel_root .mvuh-range[data-mvuh-slider-for]').each(function () {
        const number = document.getElementById(this.dataset.mvuhSliderFor);
        if (number) this.value = number.value;
    });
}

const cardFacts = () => ({ isCardOpen: hasActiveCharacter(), isChatStarted: isCardChatActive() });

// Gate every declared region at or under `node`.
function gateRegions(node, facts) {
    const regions = node.matches('[data-mvuh-needs]') ? [node] : [];
    regions.push(...node.querySelectorAll('[data-mvuh-needs]'));
    for (const region of regions) region.inert = isNeedUnmet(region.dataset.mvuhNeeds, facts);
}

// The card scope, painted on panel open, on every tab open and on CHAT_CHANGED: every card chip (a page header's, or a
// per-card card's on a global page) names the card those settings belong to or says no chat is open; every declared
// region is gated; each page's notice shows while the need it names is unmet.
export function paintCardScope() {
    const panel = document.getElementById('mvuh_panel_root');
    if (!panel) return;
    const name = openCardName();
    $(panel).find('[data-mvuh-card-chip="name"]').text(name);
    $(panel).find('[data-mvuh-card-chip="open"]').toggle(Boolean(name));
    $(panel).find('[data-mvuh-card-chip="none"]').toggle(!name);
    const facts = cardFacts();
    gateRegions(panel, facts);
    $(panel).find('[data-mvuh-notice-for]').each(function () {
        $(this).toggle(isNeedUnmet(this.dataset.mvuhNoticeFor, facts));
    });
}

// Rows a renderer paints after paintCardScope ran (a library list, a record) are gated as they arrive. Inside a gated
// card they are inert already; a button that declares its own need is gated here.
function gateRegionsAsPainted(panel) {
    new MutationObserver((mutations) => {
        let facts = null;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                facts = facts || cardFacts();
                gateRegions(node, facts);
            }
        }
    }).observe(panel, { childList: true, subtree: true });
}

export async function openSettingsPanel() {
    const panel = document.getElementById('mvuh_panel_root');
    const holder = document.getElementById('mvuh_panel_holder');
    if (!panel || !holder) {
        log.error('panel root/holder missing from settings.html — cannot open');
        return;
    }
    if (isPanelOpen) return;
    isPanelOpen = true;
    paintCardScope();
    try {
        await openPanelPopup(panel);   // logs its own failure and returns; never throws
    } finally {
        // ALWAYS put the panel back, on every exit path — otherwise it stays inside a removed dialog
        // and the launcher opens an empty one from then on.
        holder.appendChild(panel);
        isPanelOpen = false;
    }
}

// Write the saved theme onto <html> and mark its option in the rail's switch. Runs at startup, before the panel is
// built (so a dialog shown first is themed too), again once the switch exists, and on every pick.
export function applyPanelTheme() {
    const theme = panelThemeOf(getGlobal().panelTheme);
    document.documentElement.dataset.mvuhTheme = theme;
    $('[data-mvuh-theme-option]').each(function () {
        const isChosen = this.dataset.mvuhThemeOption === theme;
        $(this).toggleClass('is-active', isChosen).attr('aria-pressed', String(isChosen));
    });
}

// Bind the shell once, at startup. `tabs` is the TABS table: each tab's button and page are found by
// id (mvuh_tab_<name>, mvuh_panel_<name>), and its onOpen repaint runs when its button is clicked.
export function wireSettingsPanel(tabs) {
    panelTabs = tabs;
    for (const tab of panelTabs) {
        $(`#mvuh_tab_${tab.name}`).on('click', () => {
            showPanelTab(tab.name);
            paintCardScope();   // a chat can start with no CHAT_CHANGED (a card's first message), so each tab looks again
            if (tab.onOpen) void tab.onOpen();
        });
    }
    $('#mvuh_open_panel').on('click', () => void openSettingsPanel());
    $('[data-mvuh-theme-option]').on('click', function () {
        getGlobal().panelTheme = panelThemeOf(this.dataset.mvuhThemeOption);
        saveSettingsDebounced();
        applyPanelTheme();
    });
    applyPanelTheme();

    // Delegated, so rows a feature builds later behave the same without binding anything.
    const $root = $('#mvuh_panel_root');
    if ($root.length) gateRegionsAsPainted($root[0]);
    // The (?) beside a label opens its field's longer explanation in place — a tap, never a hover. Delegated from the
    // document, so a (?) in one of mvu-helper's dialogs (they carry .mvuh-ui, sillytavern/popup.js) opens too.
    $(document).on('click', '.mvuh-ui .mvuh-help-toggle', function () {
        const $field = $(this).closest('.mvuh-field');
        const isOpen = !$field.hasClass('is-help-open');
        $field.toggleClass('is-help-open', isOpen);
        $(this).attr('aria-expanded', String(isOpen));
    });
    // A card or record collapses from its chevron; an advanced row's whole header is that button.
    $root.on('click', '.mvuh-collapse', function () {
        const $box = $(this).closest('.mvuh-card, .mvuh-record');
        const isCollapsed = !$box.hasClass('is-collapsed');
        $box.toggleClass('is-collapsed', isCollapsed);
        $(this).attr('aria-expanded', String(!isCollapsed));
    });
    // Dragging a slider writes its number box and fires the box's own input and change, so the field's
    // handler saves exactly as if the number had been typed; typing a number moves its slider.
    $root.on('input', '.mvuh-range[data-mvuh-slider-for]', function () {
        $(document.getElementById(this.dataset.mvuhSliderFor)).val(this.value).trigger('input').trigger('change');
    });
    $root.on('input change', 'input[type="number"]', function () {
        $root.find(`.mvuh-range[data-mvuh-slider-for="${this.id}"]`).val(this.value);
    });
}
