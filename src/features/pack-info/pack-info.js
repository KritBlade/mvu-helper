// pack-info/pack-info.js — the read-only "what is installed on this card?" lane, ALL FOUR packTypes.
//
// WHY IT IS ITS OWN FEATURE. Each artifact lane already reports its own state to its own tab, and the
// composition root is the only other place that knows all four exist — but a report is feature logic,
// not composition, so it does not belong in src/index.js. This feature owns one capability: answering
// the question across lanes. It imports the others through their BARRELS only (P6) and calls their
// exported, PURE registry parsers — never their tab refreshers, which repaint the GUI as a side
// effect and would make a read-only question redraw the screen.
//
// It writes NOTHING, so it is safe to call at any time.

import { getStandaloneLorebookEntries, getPrimaryLorebookName } from '../../sillytavern/lorebook.js';
import { ARTIFACT_TYPES } from '../../shared/card-artifact-store.js';
import { packRegistryComment, parsePackRegistry, listLibraryPacks } from '../gamelogic-pack/index.js';
import { menuRegistryComment, parseMenuRegistry } from '../statusmenu-pack/index.js';
import { pluginRegistryComment, parsePluginRegistry } from '../gamelogic-plugin/index.js';
import { REGISTRY_COMMENT, parseRegistry, eventPackInfo } from '../event-pack/index.js';
import { buildAllPackInfo } from './pack-info-core.js';

// Each type's registry: where its entry lives and how to read it. ONE table, so adding a fifth
// artifact type is one row here rather than a new branch in the report builder.
const REGISTRY_READERS = {
    gamelogic: { comment: () => packRegistryComment('gamelogic'), parse: parsePackRegistry },
    statusmenu: { comment: menuRegistryComment, parse: parseMenuRegistry },
    plugin: { comment: pluginRegistryComment, parse: parsePluginRegistry },
    // event-pack predates the shared `[<Prefix>:Registry]` convention and keeps its own comment and
    // its own MAP shape. Named here rather than migrated: the entry is on every card that ever
    // installed a pack, and renaming it would orphan them.
    eventpack: { comment: () => REGISTRY_COMMENT, parse: parseRegistry },
};

const findByComment = (entries, comment) => {
    const needle = String(comment || '').toLowerCase();
    return (entries || []).find((e) => String(e.comment || '').toLowerCase() === needle) || null;
};

/**
 * Every artifact in the library and on the current card — GameLogic Pack, GameLogic Plugin,
 * StatusMenu Pack and Event Pack — with the card-vs-library disagreements already computed.
 *
 * Read `disagreements` first: empty means every lane agrees with the library and the tabs are
 * trustworthy. `types.<packType>.installed` is the same row shape for all four.
 *
 * @returns {Promise<object>} { source, types, library, eventPackDetail, disagreements }
 */
export async function packInfo() {
    const entries = await getStandaloneLorebookEntries();
    const byType = {};
    for (const packType of ARTIFACT_TYPES) {
        const reader = REGISTRY_READERS[packType];
        if (!reader) { byType[packType] = { state: 'unreadable', problem: 'no registry reader', parsed: null }; continue; }
        if (entries === null) { byType[packType] = { state: 'unreadable', problem: 'no readable worldbook on this card', parsed: null }; continue; }
        const entry = findByComment(entries, reader.comment());
        if (!entry) { byType[packType] = { state: 'missing', problem: '', parsed: null }; continue; }
        try {
            byType[packType] = { state: 'ok', problem: '', parsed: reader.parse(String(entry.content || '')) };
        } catch (e) {
            // NOT swallowed: a registry that will not parse is reported as malformed and named, because
            // reading it as "nothing installed" is how a sweep deletes a live install off a typo.
            byType[packType] = { state: 'malformed', problem: (e && e.message) || String(e), parsed: null };
        }
    }
    // The two library listers between them cover all four types: listLibraryPacks skips event packs
    // (they share the book, not the file FORMAT) and the event-pack lane lists its own.
    const packRows = await listLibraryPacks();
    const detail = await eventPackInfo();
    const eventRows = detail.library.readable
        ? detail.library.packs.map((p) => ({ packType: 'eventpack', id: p.id, name: '', version: p.version, parseError: p.parseError }))
        : null;
    const library = (packRows === null && eventRows === null) ? null : [...(packRows || []), ...(eventRows || [])];

    return buildAllPackInfo({
        boundWorld: await getPrimaryLorebookName(),
        worldbookReadable: entries !== null,
        byType,
        library,
        eventPackDetail: detail,
    });
}
