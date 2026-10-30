// shared/pick-files.js — ask the user for files through the browser's picker, and read a picked text file.
//
// The input is created for each pick and never joins the page, as SillyTavern's own pickers do (promptForAvatarFile in
// its utils.js). An input inside the settings panel would sit in a SillyTavern popup: dismissing its picker fires a
// `cancel` event that bubbles from the input to the popup's <dialog>, the popup takes any `cancel` for Escape, and the
// whole panel closes. tests/file-picker-boundary.test.js refuses a file input anywhere else in src.

import { createModuleLog } from '../sillytavern/log.js';
import { toast } from '../sillytavern/mvu-bridge.js';

const log = createModuleLog('pick-files');

// Call it straight from a click handler: a browser opens a picker only during the user's gesture. Resolves with the
// picked files, or [] when the picker is dismissed; a browser that fires no `cancel` on a file input leaves the promise
// pending, which holds nothing.
export function pickFiles({ accept = '', isMultiple = false, isDirectory = false } = {}) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.multiple = isMultiple;
        input.webkitdirectory = isDirectory;
        input.onchange = () => resolve([...(input.files || [])]);
        input.oncancel = () => resolve([]);
        input.click();
    });
}

// One picked file's text, for a tab's paste box: null when the picker is dismissed, or when the file cannot be read.
// The read failure is this function's own, so it is logged and toasted here, once for every caller.
export async function pickTextFile({ accept = '' } = {}) {
    const [file] = await pickFiles({ accept });
    if (!file) return null;
    try {
        return await file.text();
    } catch (e) {
        log.warn(`could not read "${file.name}":`, e);
        toast('error', 'Could not read the file.');
        return null;
    }
}
