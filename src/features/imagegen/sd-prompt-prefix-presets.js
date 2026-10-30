// imagegen/sd-prompt-prefix-presets.js — the NAMED list of `/sd` prompt prefixes.
//
// A prefix is the quality / LoRA-trigger / style tag block prepended to EVERY image before the
// composition and each person's look. A named list, so each checkpoint (Pony, Illustrious, Flux) or art
// style (anime, realistic) keeps its own tags without copy-paste.
//
// SCOPE SPLIT:
//   • the LIST is GLOBAL   — `settings.sdPromptPrefixPresets` — you write your checkpoint's tags once
//   • the ACTIVE PICK is PER-CARD — `profile.imagegen.sdPromptPrefixPresetId` (image-gen.js) — School
//     stays on anime tags while an RPG card stays on realistic ones, with no re-picking on card switch.
//     `''` = the "— none —" choice: that card sends no prefix at all.
//
// This module owns the preset LIFECYCLE, including referential integrity: deleting a preset detaches
// EVERY card that pointed at it (see deleteSdPromptPrefixPreset) rather than leaving dangling ids that
// would silently resolve to no-prefix. It imports nothing from image-gen.js — image-gen imports THIS
// (defaults + lookup), so the dependency stays one-way and there is no cycle.

import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { DEFAULT_SD_PROMPT_PREFIX_PRESET_ID } from './imagegen-profile-core.js';

const log = createModuleLog('imagegen');


// GLOBAL defaults fragment — spread into imageDefaults by image-gen.js, merged by loadSettings.
// An Array value is only ever set when ABSENT (loadSettings never merges into arrays), so an install
// that already has presets keeps them untouched.
export const sdPromptPrefixDefaults = {
    sdPromptPrefixPresets: [{
        id: DEFAULT_SD_PROMPT_PREFIX_PRESET_ID,
        name: 'Default',
        // EVERY standard tag lives here: quality, detail and style alike. They all
        // vary by checkpoint, and this is the one GUI field a user edits per checkpoint. The composition
        // contract (default-template.js) emits none of them — it names what is IN the picture, never how
        // it is rendered — so nothing here can reach the model twice.
        text: 'masterpiece, best quality, highly detailed, 2D anime style, clean cel-shading, sharp line art, anime screencap, very aesthetic',
    }],
};

// One-time carry-over from the pre-2026-08-01 single-string `sdPromptPrefix` key (user-approved
// migration, not a permanent fallback): the old text becomes the text of the built-in "Default"
// preset — which every card already points at — so nobody's quality tags disappear on upgrade.
// The old key is DELETED, leaving exactly one source of truth. An old value of '' carries across as
// an empty Default, which reproduces the old behaviour (no prefix) rather than silently re-adding one.
function migrateLegacySinglePrefix(root, presets) {
    if (typeof root.sdPromptPrefix !== 'string') return;
    const carried = root.sdPromptPrefix;
    delete root.sdPromptPrefix;
    const builtIn = presets.find((p) => p.id === DEFAULT_SD_PROMPT_PREFIX_PRESET_ID);
    if (builtIn) builtIn.text = carried;
    else presets.unshift({ id: DEFAULT_SD_PROMPT_PREFIX_PRESET_ID, name: 'Default', text: carried });
    log.lifecycle(`/sd prompt prefix: migrated the old single-string setting into the "Default" preset (${carried.length} chars) — the sdPromptPrefix key is gone`);
    saveSettingsDebounced();
}

// The live preset array (created from defaults on first read). Every other function goes through this,
// so the legacy migration runs exactly once no matter which entry point touches presets first.
export function listSdPromptPrefixPresets() {
    const root = getGlobal();
    if (!Array.isArray(root.sdPromptPrefixPresets)) {
        root.sdPromptPrefixPresets = structuredClone(sdPromptPrefixDefaults.sdPromptPrefixPresets);
    }
    migrateLegacySinglePrefix(root, root.sdPromptPrefixPresets);
    return root.sdPromptPrefixPresets;
}

// Lookup by id. '' (the "— none —" pick) and unknown ids return null — callers decide what that means;
// nobody substitutes another preset behind the user's back.
export function findSdPromptPrefixPreset(id) {
    if (!id) return null;
    return listSdPromptPrefixPresets().find((p) => p.id === id) || null;
}

// Readable, collision-free, and stable in settings.json (no random ids to eyeball).
function nextPresetId(presets) {
    const used = new Set(presets.map((p) => p.id));
    for (let n = presets.length + 1; ; n++) {
        const id = `preset${n}`;
        if (!used.has(id)) return id;
    }
}

export function createSdPromptPrefixPreset(name, text = '') {
    const presets = listSdPromptPrefixPresets();
    const preset = { id: nextPresetId(presets), name: String(name || '').trim() || 'Untitled', text: String(text || '') };
    presets.push(preset);
    saveSettingsDebounced();
    return preset;
}

export function renameSdPromptPrefixPreset(id, name) {
    const preset = findSdPromptPrefixPreset(id);
    if (!preset) return false;
    preset.name = String(name || '').trim() || preset.name;
    saveSettingsDebounced();
    return true;
}

export function setSdPromptPrefixPresetText(id, text) {
    const preset = findSdPromptPrefixPreset(id);
    if (!preset) return false;
    preset.text = String(text || '');
    saveSettingsDebounced();
    return true;
}

// Deletes the preset AND detaches every card that used it (id → '' = "— none —"). The sweep is the
// point: profiles live in the same settings root, so a delete that skipped it would leave other cards
// pointing at nothing and quietly drawing without their style tags. Returns how many cards were
// detached (-1 = no such preset) so the caller can say so out loud.
export function deleteSdPromptPrefixPreset(id) {
    const presets = listSdPromptPrefixPresets();
    const index = presets.findIndex((p) => p.id === id);
    if (index < 0) return -1;
    presets.splice(index, 1);
    let detached = 0;
    const profiles = getGlobal().profiles || {};
    for (const key of Object.keys(profiles)) {
        const imagegenProfile = profiles[key] && profiles[key].imagegen;
        if (imagegenProfile && imagegenProfile.sdPromptPrefixPresetId === id) {
            imagegenProfile.sdPromptPrefixPresetId = '';
            detached++;
        }
    }
    saveSettingsDebounced();
    return detached;
}
