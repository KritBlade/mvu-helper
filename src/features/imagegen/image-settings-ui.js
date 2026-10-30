// imagegen/image-settings-ui.js — the Image-tab settings panel (and the imagegen-owned control that
// SITS on the Roster tab, Harvest via). Pure DOM: read a setting into a field, write a changed field
// back, save. No generation logic lives here.
//
// DEPENDENCY DIRECTION is one-way: this file imports the engine's config + its routed-task hooks
// (syncImageTaskRouting / CHARIMG_TASK_ID / PICTURES_TASK_ID); the engine imports NOTHING back. onRouteChange takes
// multiple listeners, so the panel registers its OWN repaint (bottom of this file) and the engine keeps
// only its routing-sync listener.

import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { confirmPopup, inputPopup } from '../../sillytavern/popup.js';
import { applyHelperLocale } from '../../sillytavern/i18n.js';
import { hasActiveCharacter } from '../../sillytavern/lorebook.js';
import { escapeHtmlAttribute } from '../../shared/html-escape.js';
import { getRosterProfile, onRouteChange } from '../character-roster/index.js';
import { renderLlmTaskSelect } from '../llm-task-router/index.js';
import { syncSliders } from '../settings-panel/index.js';
import { DEFAULT_PROMPT, DEFAULT_REGEX } from './default-template.js';
import {
    imageDefaults, getImagegenProfile,
    CHARIMG_TASK_ID, PICTURES_TASK_ID, syncImageTaskRouting,
} from './image-gen.js';
import { INSERT_TYPE, writerPairRuledOut } from './prompt-assembly-core.js';
import { IMAGE_TYPES, imagegenProfileDefaults } from './imagegen-profile-core.js';
import {
    listSdPromptPrefixPresets, findSdPromptPrefixPreset, createSdPromptPrefixPreset,
    renameSdPromptPrefixPreset, setSdPromptPrefixPresetText, deleteSdPromptPrefixPreset,
} from './sd-prompt-prefix-presets.js';
import { seedComfyBustPlaceholder, removeComfyBustPlaceholder } from './comfy-placeholder-seed.js';
import { toast } from '../../sillytavern/mvu-bridge.js';

// The shipped "Max characters per image", for a field left blank or invalid.
const imagegenCeilingDefault = () => imagegenProfileDefaults.imagegen.maxCharactersPerImage;

// The /sd prompt-prefix picker: a GLOBAL named list, a PER-CARD active pick. Options are rebuilt only
// when the list actually changed (data-sig) — the same guard the LLM-task select uses, so a repaint
// never collapses an open dropdown. '' is the "— none —" row: no prefix on this card.
function renderSdPromptPrefixPresets() {
    const $select = $('#mvuh_img_sd_prefix_preset');
    if (!$select.length) return;
    const presets = listSdPromptPrefixPresets();
    const activeId = getImagegenProfile().sdPromptPrefixPresetId;
    const signature = presets.map((p) => `${p.id}:${p.name}`).join('|');
    if ($select.attr('data-sig') !== signature) {
        // Preset NAMES are user text — never data-i18n'd. Only the fixed "— none —" row is translated.
        $select.attr('data-sig', signature).html(
            ['<option value="" data-i18n="No prefix preset">— none —</option>']
                .concat(presets.map((p) => `<option value="${escapeHtmlAttribute(p.id)}">${escapeHtmlAttribute(p.name)}</option>`))
                .join(''));
        void applyHelperLocale();   // options are rebuilt — re-translate their [data-i18n] nodes
    }
    // A dangling id (hand-edited settings — deleting a preset detaches every card that used it) shows
    // as "— none —", which is what drawing will actually do. The engine warns; we don't rewrite the
    // saved value behind the user's back.
    const active = findSdPromptPrefixPreset(activeId);
    $select.val(active ? active.id : '');
    $('#mvuh_img_sd_prefix').val(active ? active.text : '').prop('disabled', !active);
    $('#mvuh_img_sd_prefix_rename, #mvuh_img_sd_prefix_delete').prop('disabled', !active);
}

// Repaints BOTH the Image tab (global machine knobs) and the per-card controls (Image +
// Roster tabs). Called on init, panel-open, AND card switch (index.js CHAT_CHANGED) so the
// per-card values follow the active card. Self-guards until the panel HTML is rendered.
export function updateImageUI() {
    const prof = getImagegenProfile();
    if (!$('#image_generation_insert_type').length) return;
    // The page header's pill says what this card's Insert Type does: draws, writes tags only, or nothing. With no card
    // open there is no card to describe, so none shows, as on the other per-card pages.
    const isCardOpen = hasActiveCharacter();
    const isTagsOnly = prof.insertType === INSERT_TYPE.TAGS_ONLY;
    const isOff = prof.insertType === INSERT_TYPE.DISABLED;
    $('#mvuh_img_on_pill').toggle(isCardOpen && !isTagsOnly && !isOff);
    $('#mvuh_img_tags_pill').toggle(isCardOpen && isTagsOnly);
    $('#mvuh_img_off_pill').toggle(isCardOpen && isOff);
    // GLOBAL (machine)
    const s = getGlobal();
    $('#mvuh_img_streaming').prop('checked', s.streamingPregen !== false);
    $('#mvuh_img_queue_concurrency').val(Math.max(1, Math.min(4, parseInt(s.queueConcurrency) || 1)));
    const presets = s.resolutionPresets || imageDefaults.resolutionPresets;
    for (const t of IMAGE_TYPES) {
        $(`#mvuh_img_res_${t}_w`).val(presets[t]?.width || imageDefaults.resolutionPresets[t].width);
        $(`#mvuh_img_res_${t}_h`).val(presets[t]?.height || imageDefaults.resolutionPresets[t].height);
    }
    // PER-CARD (card behavior) — Image tab
    $('#image_generation_insert_type').val(prof.insertType);
    $('#mvuh_img_strip_tag').prop('checked', prof.stripPicTag !== false);
    $('#mvuh_img_max_per_reply').val(Math.max(1, parseInt(prof.maxImagesPerReply) || 1));
    $('#mvuh_img_max_characters').val(prof.maxCharactersPerImage);
    $('#mvuh_img_mainchar_key').val(prof.maincharRegistryKey || '');
    $('#mvuh_img_default_type').val(prof.defaultImageType || 'portrait');
    // The <pic> contract (per-card): blank shows the built-in one, which is what this card sends.
    $('#prompt_injection_text').val(prof.promptTemplate || DEFAULT_PROMPT);
    $('#prompt_injection_regex').val(prof.promptRegex || DEFAULT_REGEX);
    $('#prompt_injection_position').val(prof.promptPosition || 'deep_system');
    $('#prompt_injection_depth').val(prof.promptDepth);
    // Bust multiplier (GLOBAL — it describes the /sd workflow, not the card).
    const bust = s.bustStrength || imageDefaults.bustStrength;
    $('#mvuh_img_bust_enabled').prop('checked', bust.enabled === true);
    $('#mvuh_img_bust_var').val(bust.variableName || imageDefaults.bustStrength.variableName);
    $('#mvuh_img_bust_default').val(Number.isFinite(bust.defaultValue) ? bust.defaultValue : imageDefaults.bustStrength.defaultValue);
    $('#mvuh_img_bust_shared').val(Number.isFinite(bust.sharedValue) ? bust.sharedValue : imageDefaults.bustStrength.sharedValue);
    $('#mvuh_img_bust_var, #mvuh_img_bust_default, #mvuh_img_bust_shared').prop('disabled', bust.enabled !== true);
    // MIXED SCOPE — the /sd prompt-prefix list is GLOBAL, the active pick is PER-CARD, so this one
    // repaints for both reasons (panel open AND card switch).
    renderSdPromptPrefixPresets();
    // PER-CARD (card behavior) — the imagegen-owned control that SITS on the Roster tab (UI placement ≠
    // ownership). The roster fields (#mvuh_img_route / #mvuh_img_collection / #mvuh_img_present_field)
    // are roster-owned → character-roster/roster-ui.js.
    // Harvest via (LLM-task router) — the STATIC #mvuh_img_charimg_via select, populated in place so a
    // refresh never destroys an open dropdown; the PRE/POST options track the live squad. Disabled on
    // "Predefined only", where nothing is stored.
    renderLlmTaskSelect(CHARIMG_TASK_ID, '#mvuh_img_charimg_via');
    $('#mvuh_img_charimg_via').prop('disabled', getRosterProfile().route !== 'harvest');
    // Pictures written by (LLM-task router, no Off) — the narrator or a POST call; painted like Harvest via. Each of the
    // two pickers leaves out what the other's value rules out, and its hint line says so (prompt-assembly-core R1).
    renderLlmTaskSelect(PICTURES_TASK_ID, '#mvuh_img_pictures_via');
    const ruledOut = writerPairRuledOut({ harvestVia: prof.charimgVia, picturesVia: prof.picturesVia });
    $('#mvuh_img_pictures_via_rule').toggle(ruledOut.arePictureCallsHidden);
    $('#mvuh_img_charimg_via_rule').toggle(ruledOut.isHarvestNarratorHidden);
    $('#mvuh_img_latch_path').val(prof.intimacyLatchPath || '');
    $('#mvuh_img_h_always').prop('checked', prof.hBlockAlwaysOn === true);
    syncSliders();   // the numbers above were set with .val(), which moves no slider
}

export function wireImageSettings() {
    // Insert Type (per-card): the <pic> instruction and the drawing. It also decides whether the narrator
    // describes looks while nothing is stored, and whether a POST call writes pictures at all, so both tasks'
    // routing follows it.
    $('#image_generation_insert_type').on('change', function () {
        getImagegenProfile().insertType = $(this).val();
        updateImageUI();
        saveSettingsDebounced();
        void syncImageTaskRouting();
    });
    // The two writer pickers rule each other's options in or out (R1), so a change to either repaints both. Queued: the
    // router's own change handler stores the new value first, whichever handler was bound first.
    $('#mvuh_img_pictures_via, #mvuh_img_charimg_via').on('change', () => { queueMicrotask(() => updateImageUI()); });
    // The <pic> contract (per-card). Text identical to the built-in one is stored blank, and so is a reset:
    // blank follows the built-in, so a later mvu-helper's improved contract still reaches this card.
    $('#prompt_injection_text').on('input', function () {
        const text = String($(this).val());
        getImagegenProfile().promptTemplate = text === DEFAULT_PROMPT ? '' : text;
        saveSettingsDebounced();
    });
    $('#prompt_injection_regex').on('input', function () {
        const text = String($(this).val());
        getImagegenProfile().promptRegex = text === DEFAULT_REGEX ? '' : text;
        saveSettingsDebounced();
    });
    $('#prompt_injection_position').on('change', function () {
        getImagegenProfile().promptPosition = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#prompt_injection_depth').on('input', function () {
        const value = parseInt(String($(this).val()), 10);
        getImagegenProfile().promptDepth = isNaN(value) ? '' : value;
        saveSettingsDebounced();
    });
    $('#mvuh_img_reset_prompt').on('click', function () {
        getImagegenProfile().promptTemplate = '';
        updateImageUI();
        saveSettingsDebounced();
        toast('success', 'Prompt template reset to default');
    });
    $('#mvuh_img_reset_regex').on('click', function () {
        getImagegenProfile().promptRegex = '';
        updateImageUI();
        saveSettingsDebounced();
        toast('success', 'Detection regex reset to default');
    });
    $('#mvuh_img_strip_tag').on('change', function () {
        getImagegenProfile().stripPicTag = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mvuh_img_streaming').on('change', function () {
        getGlobal().streamingPregen = $(this).prop('checked');
        saveSettingsDebounced();
    });
    // /sd prompt-prefix presets — pick (per-card), edit the picked one's text (global), New/Rename/Delete.
    $('#mvuh_img_sd_prefix_preset').on('change', function () {
        getImagegenProfile().sdPromptPrefixPresetId = String($(this).val() || '');
        renderSdPromptPrefixPresets();   // swap the textarea to the newly-picked preset's text
        saveSettingsDebounced();
    });
    $('#mvuh_img_sd_prefix').on('input', function () {
        const id = getImagegenProfile().sdPromptPrefixPresetId;
        if (!id) return;   // EXPECTED: "— none —" is picked, so the textarea is disabled — nothing to write
        setSdPromptPrefixPresetText(id, String($(this).val() || ''));
    });
    $('#mvuh_img_sd_prefix_new').on('click', async function () {
        const name = await inputPopup([{ text: 'Name the new /sd prompt-prefix preset.' }], { okButton: 'Create' });
        if (!name) return;   // Cancel, an empty name, or a dialog that could not open: create nothing
        const preset = createSdPromptPrefixPreset(name, '');
        getImagegenProfile().sdPromptPrefixPresetId = preset.id;   // new preset becomes THIS card's pick
        saveSettingsDebounced();
        renderSdPromptPrefixPresets();
        $('#mvuh_img_sd_prefix').trigger('focus');
        toast('success', `Prefix preset "${preset.name}" created — type its tags below`);
    });
    $('#mvuh_img_sd_prefix_rename').on('click', async function () {
        const preset = findSdPromptPrefixPreset(getImagegenProfile().sdPromptPrefixPresetId);
        if (!preset) { toast('warning', 'Pick a prefix preset first.'); return; }
        const name = await inputPopup([{ text: 'Rename this /sd prompt-prefix preset.' }], { okButton: 'Rename', defaultValue: preset.name });
        if (!name) return;   // Cancel, an empty name, or a dialog that could not open: keep the name
        renameSdPromptPrefixPreset(preset.id, name);
        renderSdPromptPrefixPresets();
    });
    $('#mvuh_img_sd_prefix_delete').on('click', async function () {
        const preset = findSdPromptPrefixPreset(getImagegenProfile().sdPromptPrefixPresetId);
        if (!preset) { toast('warning', 'Pick a prefix preset first.'); return; }
        // The list is GLOBAL, so a delete reaches every card — say so before it happens, not after.
        if (!await confirmPopup([
            { text: 'Delete this /sd prompt-prefix preset?' },
            { name: preset.name },
            { text: 'The list is shared: every card using it falls back to no prefix.' },
        ], { okButton: 'Delete', isDestructive: true })) return;
        const detached = deleteSdPromptPrefixPreset(preset.id);
        renderSdPromptPrefixPresets();
        toast('success', `Deleted "${preset.name}"${detached > 0 ? ` — ${detached} card(s) now send no prefix` : ''}`);
    });
    $('#mvuh_img_queue_concurrency').on('input', function () {
        const v = parseInt(String($(this).val()));
        getGlobal().queueConcurrency = isNaN(v) ? 1 : Math.max(1, Math.min(4, v));
        saveSettingsDebounced();
    });
    $('#mvuh_img_max_per_reply').on('input', function () {
        const v = parseInt(String($(this).val()));
        getImagegenProfile().maxImagesPerReply = isNaN(v) ? 1 : Math.max(1, Math.min(10, v));
        saveSettingsDebounced();
    });
    $('#mvuh_img_default_type').on('change', function () {
        getImagegenProfile().defaultImageType = String($(this).val());
        saveSettingsDebounced();
    });
    $('#mvuh_img_mainchar_key').on('input', function () {
        getImagegenProfile().maincharRegistryKey = String($(this).val() || '').trim();
        saveSettingsDebounced();
    });
    $('#mvuh_img_max_characters').on('input', function () {
        const v = parseInt(String($(this).val()));
        // Any whole number from 1 up: the ceiling is the card's, with no limit in code.
        getImagegenProfile().maxCharactersPerImage = Number.isInteger(v) && v >= 1 ? v : imagegenCeilingDefault();
        saveSettingsDebounced();   // takes effect on the NEXT injection — the contract's [CAST] is rebuilt from it
    });
    // Bust multiplier (GLOBAL). The variable is written per job right before /sd, so a queue running
    // more than one job at a time would let a later job's value overwrite an earlier job's — warn
    // rather than silently rendering the wrong girl at the wrong size.
    $('#mvuh_img_bust_enabled').on('change', function () {
        const s = getGlobal();
        s.bustStrength = s.bustStrength || structuredClone(imageDefaults.bustStrength);
        s.bustStrength.enabled = $(this).prop('checked');
        if (s.bustStrength.enabled && (parseInt(s.queueConcurrency) || 1) > 1) {
            toast('warning', 'Bust multiplier needs Queue concurrency 1 — with parallel jobs the shared variable races and images get each other\'s value.', 'MVU Helper', { timeOut: 9000 });
        }
        // The checkbox owns SillyTavern's ComfyUI custom placeholder for the variable (comfy-placeholder-seed.js).
        if (s.bustStrength.enabled) seedComfyBustPlaceholder('checkbox ticked');
        else removeComfyBustPlaceholder(s.bustStrength.variableName, 'checkbox unticked');
        updateImageUI();
        saveSettingsDebounced();
    });
    $('#mvuh_img_bust_var').on('input', function () {
        const s = getGlobal();
        s.bustStrength = s.bustStrength || structuredClone(imageDefaults.bustStrength);
        s.bustStrength.variableName = String($(this).val() || '').trim();
        saveSettingsDebounced();
    });
    // A rename moves the seeded placeholder: the old name's entry goes and the new name's comes, once the edit is
    // done ('change' fires on blur) — per keystroke it would seed "b", "bu", "bus"…. The field is disabled while
    // the checkbox is off, so a rename always happens with it ticked.
    $('#mvuh_img_bust_var').on('focus', function () {
        $(this).data('mvuhNameBefore', String($(this).val() || '').trim());
    });
    $('#mvuh_img_bust_var').on('change', function () {
        const before = String($(this).data('mvuhNameBefore') || '');
        const after = String($(this).val() || '').trim();
        if (before === after) return;
        if (before) removeComfyBustPlaceholder(before, `variable renamed to "${after}"`);
        seedComfyBustPlaceholder(`variable renamed from "${before}"`);
        $(this).data('mvuhNameBefore', after);
    });
    for (const [selector, field] of [['#mvuh_img_bust_default', 'defaultValue'], ['#mvuh_img_bust_shared', 'sharedValue']]) {
        $(selector).on('input', function () {
            const s = getGlobal();
            s.bustStrength = s.bustStrength || structuredClone(imageDefaults.bustStrength);
            const v = parseFloat(String($(this).val()));
            s.bustStrength[field] = Number.isFinite(v) ? v : imageDefaults.bustStrength[field];
            saveSettingsDebounced();
        });
    }
    for (const t of IMAGE_TYPES) {
        $(`#mvuh_img_res_${t}_w, #mvuh_img_res_${t}_h`).on('input', function () {
            const s = getGlobal();
            s.resolutionPresets = s.resolutionPresets || structuredClone(imageDefaults.resolutionPresets);
            const w = parseInt(String($(`#mvuh_img_res_${t}_w`).val()));
            const h = parseInt(String($(`#mvuh_img_res_${t}_h`).val()));
            s.resolutionPresets[t] = {
                width: isNaN(w) ? imageDefaults.resolutionPresets[t].width : w,
                height: isNaN(h) ? imageDefaults.resolutionPresets[t].height : h,
            };
            saveSettingsDebounced();
        });
    }
    // NOTE: the roster settings (route, Roster collection, Present flag) are roster-owned and wired in
    // character-roster/roster-ui.js. Drawing REACTS to a route change via the onRouteChange registration
    // at the bottom of image-gen.js (routing sync) and this file (dropdown repaint).
    // <explicit_rules> gate (PER-CARD) — intimacy latch path + always-on override.
    $('#mvuh_img_latch_path').on('input', function () {
        getImagegenProfile().intimacyLatchPath = String($(this).val() || '').trim();
        saveSettingsDebounced();
    });
    $('#mvuh_img_h_always').on('change', function () {
        getImagegenProfile().hBlockAlwaysOn = $(this).prop('checked');
        saveSettingsDebounced();
    });
}

// The panel repaints its OWN registration-target dropdown when the roster route changes (the disabled
// state + option list depend on it). Registered here, NOT called by the engine, so the dependency
// stays one-way. The engine registers a SEPARATE onRouteChange listener for the routing-entry sync.
onRouteChange(() => updateImageUI());
