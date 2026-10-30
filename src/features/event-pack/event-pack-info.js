// event-pack/event-pack-info.js — the read-only diagnostic lane: ONE call that reports every event
// pack in the library and every pack installed on the current card, from the stores that actually
// decide behaviour.
//
// WHY IT IS ITS OWN LANE. The install lane (event-pack-install.js) and the tab (event-pack-ui.js)
// already read these stores, but they read them to ACT and to RENDER. Answering "what is installed?"
// from outside — a console, an MCP session, a bug report — meant re-deriving the reads by hand, and
// the hand-derivation reaches for the wrong store: a card's embedded `data.character_book` is a
// build-time snapshot that ST ignores whenever the character is bound to a standalone world. This
// file is the one place that resolves the question, and it names its source in the answer.
//
// It writes NOTHING and asks nothing of the UI, so it is safe to call at any time.

import { getStandaloneLorebookEntries, getPrimaryLorebookName } from '../../sillytavern/lorebook.js';
import { readRegistry, readCardEventContract, readChatStatData } from './event-pack-install.js';
import { listStoredEventPacks } from './event-pack-library.js';
import { buildPackInfo } from './event-pack-core.js';

/**
 * Every event pack in the library and on this card, with the disagreements between the four stores
 * (worldbook entry · registry · stat_data watermark · library copy) already computed.
 *
 * Read `disagreements` first: an empty array means the four stores agree and the tab's state pills
 * are trustworthy. Everything else is detail behind that verdict.
 *
 * @returns {Promise<object>} see buildPackInfo — { source, card, library, chat, disagreements }
 */
export async function eventPackInfo() {
    const entries = await getStandaloneLorebookEntries();
    const { registry } = entries === null ? { registry: null } : readRegistry(entries);
    const stored = await listStoredEventPacks();
    const statData = await readChatStatData();
    // The contract comes from the LOADED engine, not the worldbook, so an unreadable book no longer
    // decides this: a hosted engine answers even while the book is momentarily unqueryable, and no
    // engine at all is reported as exactly that.
    const enginePaths = readCardEventContract().paths;
    return buildPackInfo({ boundWorld: await getPrimaryLorebookName(), entries, registry, stored, statData, enginePaths });
}
