// sillytavern/i18n.js — per-extension GUI locale applier.
//
// ST has ONE global UI locale; our Language setting is per-extension, so we apply
// our own: load i18n/<lang>.json and swap the text of every [data-i18n] node inside
// OUR panels (settings container + wand-menu item) and our dialogs. Convention: every user-facing
// string in settings.html / JS-built rows carries data-i18n="<Key>" with a matching
// JSON key (see memory/plan; keys are the English strings themselves).
//
// THREE ATTRIBUTES, ONE DICT: data-i18n (text), data-i18n-placeholder, data-i18n-title.
// A form row's wording lives mostly in placeholders and tooltips, so text-only translation
// leaves it half-English; all three read the same dictionary with the same fallback.
//
// Mechanics:
//   • The node's ORIGINAL html is stashed once in jQuery data ('i18nOrig') so
//     switching back to English restores markup exactly (help texts contain <b>/<code>).
//   • Translations are applied with .text() — locale values are plain strings, and
//     .text() can never inject HTML.
//   • A missing key falls back to the original English (logged at lifecycle level,
//     counted — never silent, never breaks the panel).
//   • JS-rebuilt DOM (roster rows) re-applies after each render.
//
// REPAINT NO-OP (live 2026-07-23): every panel repaint calls this — roster render, event-pack
// list, each of the event-pack early-return hints — so a chat switch alone fired it 4x and each
// one logged "i18n: restored English". With the language on 'en' and no translation ever written,
// there is nothing to restore: JS-built rows come out of source in English already. So that case
// now returns before the DOM walk and says nothing. `localeApplied` is what makes it safe — it
// tracks whether a translation is actually sitting in our DOM, which is the only state a restore
// pass can undo.

import { extensionFolderPath } from './extension-paths.js';
import { getGlobal } from './settings-store.js';
import { createModuleLog } from './log.js';

const log = createModuleLog('i18n');

const dicts = {};   // lang → { key: translation } (en needs no dict — originals restore)

async function loadDict(lang) {
    if (dicts[lang]) return dicts[lang];
    try {
        const d = await $.getJSON(`${extensionFolderPath}/i18n/${lang}.json`);
        dicts[lang] = d && typeof d === 'object' ? d : {};
    } catch (e) {
        log.warn(`could not load i18n/${lang}.json — staying English:`, e);
        dicts[lang] = {};
    }
    return dicts[lang];
}

let localeApplied = false;   // is a non-English translation currently written into our DOM?
let lastOutcome = '';        // lang/translated/missing signature of the previous apply

// Apply the saved language to all our [data-i18n] nodes — the panel's, or with `root` one dialog's body
// (sillytavern/popup.js translates each dialog before it shows). Safe to call repeatedly.
export async function applyHelperLocale(root = null) {
    const lang = getGlobal().language || 'en';
    if (root) return translateDialog(root, lang);
    // Nothing translated, nothing to restore — see REPAINT NO-OP above.
    if (lang === 'en' && !localeApplied) return;
    const dict = lang === 'en' ? {} : await loadDict(lang);
    // ⚠ `#mvuh_panel_root` IS THE POINT. The settings panel is MOVED between #mvuh_panel_holder and the
    // ST popup — never cloned, so handlers survive (see settings.html) — which means it is NOT inside
    // #mvuh_settings_container whenever the popup is open, i.e. every moment a user can actually
    // reach the Language dropdown. Searching only the containers found 3 stray nodes out of 143 and
    // reported "applied zh-cn — 3 translated" quite happily: switching language did nothing visible, and
    // the log agreed with the code instead of with the screen. Target the panel by its own id and it is
    // found in either home. (jQuery `.find()` returns a unique set, so the overlap while the panel sits
    // in the holder cannot double-apply.) While the panel is open, its dialog's button bar (Close) sits outside
    // #mvuh_panel_root, so a language switched from inside the panel reaches it only by name.
    const $panelDialogButtons = $('#mvuh_panel_root').closest('dialog.mvuh-popup').find('.popup-controls');
    const $scope = $('#mvuh_settings_container, #mvuh_wand_button, #mvuh_panel_root').add($panelDialogButtons);
    const { translated, missing } = translateWithin($scope, dict, lang);
    localeApplied = translated > 0;

    // A repaint that produces the SAME outcome is not news — only the first apply and any real
    // change (locale switched, row count moved, a key started/stopped resolving) reach lifecycle.
    const outcome = `${lang}/${translated}/${missing.length}`;
    const isNews = outcome !== lastOutcome;
    lastOutcome = outcome;
    const at = isNews ? log.lifecycle : log.verbose;
    if (lang === 'en') {
        at('i18n: restored English');
    } else {
        at(`i18n: applied "${lang}" — ${translated} translated, ${missing.length} missing (fell back to English)`);
        if (missing.length && log.enabled('verbose')) log.verbose('missing keys:', missing);
    }
}

// A dialog is built in English and lives only until it closes, so English needs no pass. Its outcome is logged on
// its own, apart from the panel's repaint signature. A translation written here marks the locale applied, so the
// next English pass restores whatever it reached (the settings panel's own dialog holds the panel).
async function translateDialog(root, lang) {
    if (lang === 'en') return;
    const dict = await loadDict(lang);
    const { translated, missing } = translateWithin($(root), dict, lang);
    if (translated) localeApplied = true;
    log.verbose(`a dialog was translated — ${translated} words, ${missing.length} missing`);
    if (missing.length) log.lifecycle(`a dialog shows English where "${lang}" has no translation:`, missing);
}

// Translate every keyed node under $scope — text, placeholders and tooltips — or restore its English when `lang`
// is 'en'. Returns how many were translated and the keys the dictionary lacks.
function translateWithin($scope, dict, lang) {
    let translated = 0;
    const missing = [];
    $scope.find('[data-i18n]').each(function () {
        const $el = $(this);
        const key = $el.attr('data-i18n');
        if ($el.data('i18nOrig') === undefined) $el.data('i18nOrig', $el.html());
        if (lang === 'en') { $el.html($el.data('i18nOrig')); return; }
        const val = dict[key];
        if (typeof val === 'string' && val) {
            $el.text(val);
            translated++;
        } else {
            $el.html($el.data('i18nOrig'));   // fallback: original English
            missing.push(key);
        }
    });
    // ATTRIBUTE STRINGS. `data-i18n` swaps a node's TEXT, which reaches nothing inside an
    // `<input placeholder>` or a `title=` tooltip — and in a form-heavy panel that is most of the
    // user-facing wording (the Extra LLM Calls row is 7 placeholders and 4 tooltips against 4 text
    // nodes). Translating only the text left rows visibly half-Chinese. Same dict, same
    // English-key convention, same fallback: a missing key restores the original attribute.
    const applyAttr = (attr, dataKey) => {
        $scope.find(`[data-i18n-${dataKey}]`).each(function () {
            const $el = $(this);
            const key = $el.attr(`data-i18n-${dataKey}`);
            const stash = `i18nOrig-${attr}`;
            if ($el.data(stash) === undefined) $el.data(stash, $el.attr(attr) || '');
            if (lang === 'en') { $el.attr(attr, $el.data(stash)); return; }
            const val = dict[key];
            if (typeof val === 'string' && val) {
                $el.attr(attr, val);
                translated++;
            } else {
                $el.attr(attr, $el.data(stash));
                missing.push(key);
            }
        });
    };
    applyAttr('placeholder', 'placeholder');
    applyAttr('title', 'title');
    return { translated, missing };
}
