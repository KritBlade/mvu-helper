// features/public-settings — `MvuHelper.settings` on the page: a card's EJS entries and page scripts
// read mvu-helper's settings by name, and set the few a card may set, without reaching SillyTavern's
// settings object. The rows, and every decision about a read or a write, are in
// shared/public-settings-core.js; this file applies them to the live settings. The engine's copy is
// read in the Worker (logic-engine-core.js buildEngineSettings).

import { getGlobal, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { updateMainUI } from '../main/index.js';
import { publicSettingRow, publicSettingNames, readPublicSetting, publicSettingWriteProblem, writePublicSetting } from '../../shared/public-settings-core.js';

const log = createModuleLog('public-settings');

// One warning per name and problem: a template asks again on every render, and one line says it.
const warnedProblems = new Set();
function warnOnce(problem) {
    if (warnedProblems.has(problem)) return;
    warnedProblems.add(problem);
    log.warn(problem);
}

function get(name) {
    const row = publicSettingRow(String(name));
    if (!row) {
        warnOnce('MvuHelper.settings was asked for "' + name + '", which is not a setting — the settings are ' + publicSettingNames().join(', '));
        return undefined;
    }
    return readPublicSetting(getGlobal(), row);
}

// A write lands in the global settings (every card shares them), is saved, and shows on the Main tab.
function set(name, value) {
    const problem = publicSettingWriteProblem(String(name), value);
    if (problem) {
        warnOnce('a write through MvuHelper.settings was refused: ' + problem);
        return false;
    }
    if (!writePublicSetting(getGlobal(), publicSettingRow(String(name)), value)) {
        warnOnce('a write to "' + name + '" through MvuHelper.settings was refused: mvu-helper\'s saved settings hold something other than an object where its parent belongs, and it was left as it is');
        return false;
    }
    saveSettingsDebounced();
    updateMainUI();
    log.lifecycle('"' + name + '" was set to ' + JSON.stringify(value) + ' through MvuHelper.settings');
    return true;
}

/** `MvuHelper.settings` on the page: `get(name)`, `set(name, value)`, `names()`. */
export const publicSettings = Object.freeze({ get, set, names: publicSettingNames });
