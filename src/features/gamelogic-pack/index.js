// features/gamelogic-pack — public API (P6: cross-feature imports stop here).
// The artifact library: the pack-file validator, the root-level library worldbook, and the half the GameLogic
// Packs and StatusMenu Packs tabs share (library, Import, unreadable notice) — plus the GameLogic Pack's own
// lifecycle on a card: install, repair, upgrade, switch, uninstall and export — and the Development tab's
// Add New Blank Packs.

export {
    judgePackFile,
    // The end every export button shares: re-validate, re-gate, name the file.
    finishArtifactExport,
    // The plugin lane toasts its install with the same line the pack lane uses.
    schemaRemovalToastText,
    // declaredCallBindings is the plugin lifecycle's read of a plugin FILE (token presence IS the
    // binding declaration). The file format lives here, so the reader does too.
    declaredCallBindings,
    // SCHEMA_SCRIPT_NAME is the ONE card-level Zod script every artifact type competes for; the plugin
    // lane needs the name to read what is there before deciding whether to write its own (rule 7).
    SCHEMA_SCRIPT_NAME,
    // The registry entry's comment and its PURE parser — what the pack-info lane reads to report
    // this type's install state without going near the tab (which repaints as a side effect).
    packRegistryComment, parsePackRegistry,
} from './gamelogic-pack-core.js';
export { installPackToLibrary, listLibraryPacks, readLibraryPack } from './gamelogic-pack-library.js';
// The install warning every lane's install asks first, of the pack in the library.
export { confirmLibraryPackReach } from './library-pack-reach.js';
export { activatePack, packAdoptionPending, gameLogicPackSyncPass, readActiveForcePayload, readActivePackIdFrom, readActiveExposesFrom, getActiveExposes, packOwnsCardSchema } from './gamelogic-pack-activation.js';
export { wireGameLogicPackTab } from './gamelogic-pack-ui.js';
export { wireArtifactTabs, refreshArtifactTab, registerArtifactLane } from './artifact-tabs-ui.js';
// The StatusMenu lane paints its tab's header pill from the same rule as the GameLogic Pack's.
export { activeArtifactPill } from './artifact-tabs-core.js';
export { wireBlankPackCard } from './blank-pack-ui.js';
