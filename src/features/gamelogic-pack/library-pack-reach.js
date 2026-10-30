// gamelogic-pack/library-pack-reach.js — the install warning, asked of a pack in the library before an install writes
// it (shared/pack-install-warning.js; plans/pack-install-warning.md §4). Every install, repair and upgrade of the three
// lanes asks it first, before any other question or write: onInstallFromLibrary (this lane), onInstallPluginFromLibrary
// and onInstallMenuFromLibrary, each passing its lane's reading of the pack (packReachTexts, pluginReachTexts,
// menuReachTexts). The dev loop's lanes call the activations directly and never ask.

import { parsePackFile } from './gamelogic-pack-core.js';
import { readLibraryPack } from './gamelogic-pack-library.js';
import { confirmPackReach, refuseUncheckedPack } from '../../shared/pack-install-warning.js';

/**
 * Whether the install may go on: true when what the pack writes reaches nothing the warning names, or when the user
 * answers Install anyway. A pack that cannot be read from the library, or read into texts, answers no, as a scan that
 * fails does.
 *
 * @param {string} packType  the library's type for it: 'gamelogic', 'plugin' or 'statusmenu'
 * @param {string} id
 * @param {(pack: object) => { entries: string[], regexReplacements: string[], macroTexts: string[] }} reachTextsOf
 *   the lane's reading of its pack (installReachTexts)
 * @returns {Promise<boolean>}
 */
export async function confirmLibraryPackReach(packType, id, reachTextsOf) {
    const text = await readLibraryPack(packType, id);
    const { pack, error } = parsePackFile(text);
    if (!pack) return refuseUncheckedPack(id, text === null ? 'the library does not hold it, or its book is not readable' : error);
    let texts;
    try {
        texts = reachTextsOf(pack);
    } catch (e) {
        return refuseUncheckedPack(id, e);
    }
    return confirmPackReach({ packName: String(pack.name || id), version: String(pack.version || ''), texts });
}
