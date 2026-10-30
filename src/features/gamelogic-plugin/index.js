// features/gamelogic-plugin — public API (P6: cross-feature imports stop here).
// The GameLogic Plugin lifecycle on a card: its own registry (separate from the pack's, so uninstalling
// the game leaves plugins bookkept), install with call and own-root binding, upgrade that reuses the
// recorded answers, keep-or-purge uninstall, and the chat-load pass that creates each plugin's drawer
// and warns when a binding or an interface has drifted.
//
// The plugin FILE format is not here: one JSON format covers every packType and lives with
// features/gamelogic-pack, which this imports through that barrel.

export {
    PLUGIN_TYPE,
    pluginRegistryComment, parsePluginRegistry,
    pluginOwnRoot,
    SCHEMA_ANSWER_REPLACE,
    planExposesMatch,
} from './gamelogic-plugin-core.js';
export {
    readCardPluginState, readPluginRegistryFrom,
    installPlugin,
    gameLogicPluginSyncPass, ensurePluginDrawersOnGenerationFloor, readLatestStatData,
} from './gamelogic-plugin-activation.js';
// What the logic-engine feature is HANDED at composition time (P5): the plugin engine texts for the
// shared Worker's boot, and the relay participants for the relay fire.
export { readInstalledPluginEngines, readRelayParticipants, pluginEngineScope } from './plugin-relay.js';
export { wireGameLogicPluginHandlers, refreshGameLogicPluginUI, onInstallPluginFromLibrary, setPluginTabRepaint } from './gamelogic-plugin-ui.js';
