// shared/pack-install-warning.js — the install warning: before an install writes a pack, read what its template code
// and macros reach (shared/template-reach.js) and, when they reach SillyTavern's settings or outside this chat, ask
// the user (plans/pack-install-warning.md §4). Every install of a library pack asks it first, through gamelogic-pack's
// confirmLibraryPackReach; the dev loop's lanes never do. The words are pack-install-warning-core.js's.

import { createModuleLog } from '../sillytavern/log.js';
import { confirmPopup, noticePopup } from '../sillytavern/popup.js';
import { templateReachIn } from './template-reach.js';
import { hasPackReach, packReachLogLine, packReachQuestion, PACK_REACH_QUESTION_BUTTONS } from './pack-install-warning-core.js';

const log = createModuleLog('pack-install-warning');

/**
 * The answer for a pack that could not be checked: no, with the reason in the console and a notice naming the pack.
 * An install that cannot be checked is not written, as a popup that cannot open answers no (confirmPopup).
 *
 * @param {string} packName
 * @param {Error|string} reason
 * @returns {Promise<boolean>}  false
 */
export async function refuseUncheckedPack(packName, reason) {
    log.error('the install scan failed on ' + String(packName || '?') + ', so it is not installed:', reason);
    await noticePopup([
        { text: 'The pack could not be checked, so it was not installed. The console says why.' },
        { name: String(packName || '?') },
    ]);
    return false;
}

/**
 * Whether the install may write the pack: true when its texts reach nothing the warning names, or when the user
 * answers Install anyway. Every asked install leaves one warn line with the answer. A scan that fails answers no
 * (refuseUncheckedPack).
 *
 * @param {object} pack
 * @param {string} pack.packName   the pack as the library names it
 * @param {string} [pack.version]
 * @param {{ entries?: string[], regexReplacements?: string[], macroTexts?: string[] }} pack.texts  what the install is
 *   about to write (installReachTexts)
 * @returns {Promise<boolean>}
 */
export async function confirmPackReach({ packName, version, texts } = {}) {
    let reach;
    try {
        reach = templateReachIn(texts);
    } catch (e) {
        return refuseUncheckedPack(packName, e);
    }
    if (!hasPackReach(reach)) return true;
    const isInstalled = !!(await confirmPopup(packReachQuestion({ packName, version, reach }), PACK_REACH_QUESTION_BUTTONS));
    log.warn(packReachLogLine({ packName, version, reach, isInstalled }));
    return isInstalled;
}
