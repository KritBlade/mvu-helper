// imagegen/comfy-placeholder-seed.js — SillyTavern's ComfyUI custom placeholder for the bust multiplier
// (find `<variable>`, replace `{{getvar::<variable>}}`), owned by the "Send bust multiplier to the backend"
// checkbox: ticking it seeds the entry, unticking it removes it. Nobody types it into the Workflow Editor by hand.
// The decisions are pure (comfy-placeholder-core.js); this file only reads the settings and writes the list.
//
// COPIES SILLYTAVERN'S OWN EDITOR (stable-diffusion/index.js, the Workflow Editor): "+" creates the list when
// absent, pushes { find, replace } and calls saveSettingsDebounced; "⊘" splices the entry out of the same list.
// Both mutate extension_settings.sd.comfy_placeholders IN PLACE, as SillyTavern does, and the editor rebuilds its
// rows from that list every time it opens, so the seeded entry shows there like one the user added.
//
// WHEN: on load while the box is ticked (it is ON by default, so a new install would otherwise never tick it),
// when it is ticked, and when the variable name changes while it is ticked (the old name's seeded entry goes,
// the new one comes). Unticking removes only an exact copy of the seeded entry: a user's own entry under the
// same find, with a replace of their own, is never touched — it is named once per session instead. The WORKFLOW
// side ("%<variable>%" on a typed FLOAT input of the LoRA node) is the user's own file and is never touched.

import { extension_settings } from '../../../../../../extensions.js';
import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { imageDefaults } from './image-gen.js';
import { planBustPlaceholderSeed, seededBustPlaceholderIndexes } from './comfy-placeholder-core.js';

const log = createModuleLog('imagegen');
const differsWarned = new Set();

// SillyTavern's Image Generation settings, or null. EXPECTED on an install without them: nothing to write into.
function sdSettings() {
    const sd = extension_settings.sd;
    return sd && typeof sd === 'object' ? sd : null;
}

function bustSettings() {
    return getGlobal().bustStrength || imageDefaults.bustStrength;
}

// Seed the entry for the configured variable, while the checkbox is ticked.
export function seedComfyBustPlaceholder(reason) {
    try {
        const bust = bustSettings();
        if (bust.enabled !== true) return;
        const sd = sdSettings();
        if (!sd) return;
        const plan = planBustPlaceholderSeed(sd.comfy_placeholders, bust.variableName);
        if (plan.action === 'skip' || plan.action === 'present') return;
        if (plan.action === 'differs') {
            if (differsWarned.has(plan.entry.find)) return;
            differsWarned.add(plan.entry.find);
            log.warn(`SillyTavern's ComfyUI custom placeholder "%${plan.entry.find}%" replaces with "${plan.existing.replace}", `
                + `not "${plan.entry.replace}" — left as you set it. The bust multiplier writes the chat variable "${plan.entry.find}", `
                + 'so a placeholder that reads anything else never hands its value to the workflow.');
            return;
        }
        if (!Array.isArray(sd.comfy_placeholders)) sd.comfy_placeholders = [];
        sd.comfy_placeholders.push({ ...plan.entry });
        saveSettingsDebounced();
        log.lifecycle(`added the ComfyUI custom placeholder "%${plan.entry.find}%" → ${plan.entry.replace} to SillyTavern's Image Generation `
            + `settings (${reason}), so the bust multiplier reaches the workflow. The workflow still needs "%${plan.entry.find}%" on its LoRA's typed FLOAT strength input.`);
    } catch (e) {
        log.warn('could not add the ComfyUI bust placeholder to SillyTavern\'s Image Generation settings:', e);
    }
}

// Remove the seeded entry for `variableName` (an exact copy only), whatever the checkbox says: the caller is
// the untick, or a variable rename dropping the old name.
export function removeComfyBustPlaceholder(variableName, reason) {
    try {
        const sd = sdSettings();
        if (!sd) return;
        const indexes = seededBustPlaceholderIndexes(sd.comfy_placeholders, variableName);
        if (!indexes.length) return;
        for (const i of indexes) sd.comfy_placeholders.splice(i, 1);
        saveSettingsDebounced();
        log.lifecycle(`removed the ComfyUI custom placeholder "%${String(variableName).trim()}%" from SillyTavern's Image Generation settings (${reason})`);
    } catch (e) {
        log.warn('could not remove the ComfyUI bust placeholder from SillyTavern\'s Image Generation settings:', e);
    }
}
