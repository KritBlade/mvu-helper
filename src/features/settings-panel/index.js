// features/settings-panel — the panel's shell: the nav that switches tabs, the card scope (chips and gate), the
// behaviours every gene shares, and the dialog the panel opens in. Each tab's content is painted by
// its own feature, which builds its rows from the gene builders here. Styles: settings-panel.css (loaded by
// manifest.json), which pulls in palette.css and gui-dna.css.
export {
    SETTINGS_PANEL_HTML_URL, panelDefaults, applyPanelTheme, wireSettingsPanel, showPanelTab, paintCardScope, openSettingsPanel, syncSliders,
} from './settings-panel.js';
export {
    iconButton, button, statusPill, listRow, recordCard, grid, stack, field, fieldLabel, controlRow, hint, detail, codeChip, input,
    textarea, select, selectOption, switchInput, checkList, emptyState, notice, groupTitle, resultList, pager,
} from './gui-dna-core.js';
