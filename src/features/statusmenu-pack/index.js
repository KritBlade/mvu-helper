// features/statusmenu-pack — public API (P6: cross-feature imports stop here).
// The StatusMenu Pack lane (GameLogic Pack plan §9–§10a, phase G3): install/upgrade/switch/uninstall
// of a `packType:"statusmenu"` file onto the current card, the [MVU_StatusMenuEngine] store, the
// [MVU_StatusMenuBody:<row>] store the containment lift fills, the contained frame that mounts what it
// holds (plans/executed/statusmenu-containment.md M2–M8), the StatusMenu Packs tab's menu row, and the
// Development tab's StatusMenu Engine dev upload.
// The file format itself is the shared §3 validator's (gamelogic-pack); the renderer that consumes the
// installed layout is builder work (Track B phase B2).

export {
    STATUSMENU_TYPE,
    menuRegistryComment,
    parseMenuRegistry,
} from './statusmenu-pack-core.js';
export {
    MENU_IMAGE_SOURCES_SETTING, MENU_FRAME_IMAGE_SOURCES_DEFAULT, parseMenuImageSources,
} from './statusmenu-frame-core.js';
export { wireStatusMenuFrame, statusMenuFrameSource } from './statusmenu-frame.js';
export {
    readCardMenuState, activateMenu,
} from './statusmenu-pack-activation.js';
export {
    readMenuEngineTexts,
} from './statusmenu-engine-runtime.js';
export {
    refreshStatusMenuUI, refreshMenuEngineUpload, onInstallMenuFromLibrary, wireStatusMenuHandlers, setStatusMenuTabRepaint,
} from './statusmenu-pack-ui.js';
export { wireStatusMenuDispatcher } from './statusmenu-dispatcher.js';
