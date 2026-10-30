// gamelogic-pack/artifact-tabs-core.js — what the two artifact tabs, GameLogic Packs and StatusMenu Packs, show, pure:
// which types each lists, and the words and values their header pills, notices, library rows and import reports are
// built from (artifact-tabs-ui.js and the lanes build the genes), plus the Development tab's blank-pack report. Fixed
// words come as { text }, values as { name }, code as { code }; a { text } is written first in its object, where the G1
// guard reads it as a key zh-cn must hold. What an installed row says about its state is shared/card-artifact-store.js's
// artifactRowStatus, the one rule the pack, plugin and menu rows share.

import { ARTIFACT_ROLES, artifactIdLine, pluginFlavorLine } from '../../shared/card-artifact-store.js';
import { PACK_TYPES } from './gamelogic-pack-core.js';

// Each artifact type's icon: on its library group and rows, and on its import report line.
const TYPE_ICONS = { gamelogic: 'fa-cube', plugin: 'fa-puzzle-piece', statusmenu: 'fa-table-list', eventpack: 'fa-calendar-days' };

// A type's label is ARTIFACT_ROLES' frozen term, which is also its translation key.
const typeLabel = (packType) => (ARTIFACT_ROLES[packType] ? { text: ARTIFACT_ROLES[packType].label } : { name: String(packType || '?') });

/**
 * The two artifact tabs: each lists its own types, on the card and in the library, and carries the same Import card under
 * its own id prefix. That Import accepts every type, so an artifact may land on the other tab (libraryAddedText). A plugin
 * sits with the game it extends.
 */
export const ARTIFACT_TABS = {
    gamelogic: { title: 'GameLogic Packs', packTypes: ['gamelogic', 'plugin'], idPrefix: 'mvuh_gp' },
    statusmenu: { title: 'StatusMenu Packs', packTypes: ['statusmenu'], idPrefix: 'mvuh_smp' },
};

/** The tab that lists a type, or '' for a type neither lists (an event pack has a tab of its own). */
export function artifactTabOf(packType) {
    return Object.keys(ARTIFACT_TABS).find((name) => ARTIFACT_TABS[name].packTypes.includes(packType)) || '';
}

// A tab's header pill for a card that runs none of its artifacts.
const NO_ARTIFACT_PILLS = {
    gamelogic: { text: 'No GameLogic Pack', status: 'neutral' },
    statusmenu: { text: 'No StatusMenu Pack', status: 'neutral' },
};

/**
 * A tab's header pill: the GameLogic Pack this card runs, or the StatusMenu it shows, by name in its row's status, or
 * "No GameLogic Pack" / "No StatusMenu Pack". Null while the card cannot be read or its registry is broken: the notices
 * say why.
 */
export function activeArtifactPill({ packType, isReadable = false, hasRegistryError = false, artifact = null } = {}) {
    if (!isReadable || hasRegistryError) return null;
    if (!artifact) return NO_ARTIFACT_PILLS[packType] || null;
    return { name: artifact.name, status: artifact.status };
}

/**
 * The fix the tab offers a card whose lorebook cannot be read, as its button's words: create a lorebook for a card with
 * no lore, link the card's existing book, or run SillyTavern's own Import Card Lore for embedded lore. Null where no
 * button fixes it (a renamed book, a book still loading).
 */
export function cardLoreRepairButton({ binding, canLink = false } = {}) {
    if (binding === 'no-book-bound') return { text: 'Create Card Lorebook' };
    if (binding !== 'embedded-not-imported') return null;
    return canLink ? { text: 'Link Card Lore' } : { text: 'Import Card Lore' };
}

/**
 * One stored artifact's library row. A file that no longer parses is listed so it can be removed, and offers no install;
 * an artifact already on this card offers none either, since its card row runs the install again.
 */
export function libraryRowView(stored, { isOnThisCard = false, isInstallable = false } = {}) {
    if (stored.parseError) {
        return { name: stored.id, pills: [{ text: 'Does not parse', status: 'danger' }], sub: [{ name: stored.parseError }], canInstall: false };
    }
    const sub = [artifactIdLine({ id: stored.id, version: stored.version })];
    if (stored.packType === 'plugin') sub.push(pluginFlavorLine(stored));
    if (stored.description) sub.push({ name: stored.description });
    return {
        name: stored.name || stored.id,
        pills: isOnThisCard ? [{ text: 'Installed here', status: 'accent' }] : [],
        sub,
        canInstall: isInstallable && !isOnThisCard,
    };
}

/**
 * A tab's library list: one group per type the tab lists (`packTypes`) that holds stored files, in PACK_TYPES order — its
 * rows, and a title (icon, label, count) only on a tab listing more than one type. `installedIds` are the ids on this
 * card; `installableTypes` the types that can install.
 */
export function libraryGroups(packs, { packTypes = PACK_TYPES, installedIds = new Set(), installableTypes = new Set() } = {}) {
    return PACK_TYPES.filter((packType) => packTypes.includes(packType)).flatMap((packType) => {
        const stored = packs.filter((pack) => pack.packType === packType);
        if (!stored.length) return [];
        return [{
            packType,
            title: packTypes.length > 1 ? { icon: TYPE_ICONS[packType], parts: [typeLabel(packType), { name: ` (${stored.length})` }] } : null,
            rows: stored.map((pack) => ({
                id: pack.id,
                icon: TYPE_ICONS[packType],
                ...libraryRowView(pack, { isOnThisCard: installedIds.has(pack.id), isInstallable: installableTypes.has(packType) }),
            })),
        }];
    });
}

// The report line naming one artifact: its name, type, id and version, and the source folder it was assembled from.
function artifactLine(pack, folder = '') {
    return {
        icon: TYPE_ICONS[pack.packType] || 'fa-box',
        parts: [
            { name: `${pack.name || '?'} · ` }, typeLabel(pack.packType), { name: ' · ' }, { code: pack.id || '?' }, { name: ` · v${pack.version || '?'}` },
            ...(folder ? [{ name: ' · ' }, { code: `${folder}/` }] : []),
        ],
    };
}

/** A pasted pack file's report (judgePackFile, installPackToLibrary): the artifact, every error and warning, then "Pack file is valid". */
export function packFileReportView(result) {
    const lines = result.pack ? [artifactLine(result.pack)] : [];
    for (const error of result.errors) lines.push({ status: 'danger', name: error });
    for (const warning of result.warnings) lines.push({ status: 'warning', name: warning });
    if (result.ok) lines.push({ text: 'Pack file is valid', status: 'success' });
    return { lines };
}

/**
 * The toast for one artifact the library took (installPackToLibrary's result), from the Import card on `tabName`'s tab. An
 * artifact another tab lists names that tab, since nothing on this one shows it; an event pack names its own library.
 */
export function libraryAddedText(result, tabName) {
    if (result.eventPackIds) return `Event Packs library: ${result.eventPackIds.join(', ') || result.pack.name}`;
    const added = `${result.created ? 'Added to the library: ' : 'Library copy updated: '}${result.pack.name} v${result.pack.version || '?'}`;
    const home = artifactTabOf(result.pack.packType);
    return home && home !== tabName ? `${added} (${ARTIFACT_TABS[home].title} tab)` : added;
}

/** A picked source folder or ZIP's report (buildWorkspaceArtifacts): each artifact, its errors and warnings, and whether it is ready. */
export function sourceReportView(artifacts) {
    if (!artifacts.length) {
        return { lines: [{ text: 'No pack.json found: pick the artifact folder itself, or a workspace whose subfolders each carry one.', status: 'danger' }] };
    }
    const lines = [];
    for (const artifact of artifacts) {
        if (artifact.pack) lines.push(artifactLine(artifact.pack, artifact.name));
        else lines.push(artifact.name ? { icon: 'fa-folder', name: `${artifact.name}/` } : { text: 'Picked folder', icon: 'fa-folder' });
        for (const error of artifact.errors) lines.push({ status: 'danger', name: error });
        for (const warning of artifact.warnings) lines.push({ status: 'warning', name: warning });
        if (!artifact.errors.length) lines.push({ text: 'Ready for the library', status: 'success' });
    }
    return { lines };
}

/** The blank-pack report: what kept the archive from being made, or the archive's name and what to do with it. */
export function blankPackReportView({ errors = [], fileName = '' } = {}) {
    if (errors.length) return { lines: errors.map((error) => ({ status: 'danger', name: error })) };
    return { lines: [{ status: 'success', parts: [{ code: fileName }, { name: ' ' }, { text: 'Extract it at your workspace root, then point npm run dev at it.' }] }] };
}
