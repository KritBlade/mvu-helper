// MVU Helper — extension entry point / composition root.
//
// This file wires modules together; it holds no feature logic of its own:
//   • imagegen/image-gen.js   — image auto-generation (per-card behavior + global machine knobs)
//   • small-llm/extra-llm-calls.js   — extra LLM calls: PRE interceptor + POST pass (PER-CARD)
//   • small-llm/extra-llm-calls-ui.js— the "Extra LLM Calls" settings panel
//   • sillytavern/settings-store.js— GLOBAL (machine/contract) vs PER-CARD (behavior) settings store
//
// Settings scope: image-gen CARD BEHAVIOR (teach, draw mode, route, …) + Extra LLM Calls live
// per character card under settings.profiles[<handleId>_<charName>]; only machine/app knobs
// (contract text, GPU concurrency, VRAM presets, logging) stay at the root. Switching card
// → CHAT_CHANGED repaints the LLM, Image, and Roster tabs for that card's profile.

import { eventSource, event_types } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { SETTINGS_PANEL_HTML_URL, panelDefaults, applyPanelTheme, wireSettingsPanel, showPanelTab, paintCardScope, openSettingsPanel } from './features/settings-panel/index.js';
import { loadSettings } from './sillytavern/settings-store.js';
import { createModuleLog } from './sillytavern/log.js';
import { checkLorebookApiAvailable } from './sillytavern/lorebook.js';

// Main tab: general, extension-wide options (debug-log verbosity, …).
import { mainDefaults, wireMain, updateMainUI } from './features/main/index.js';
import { applyHelperLocale } from './sillytavern/i18n.js';

// Image-gen: importing registers its runtime event listeners (prompt-inject,
// streaming pre-gen, MESSAGE_RECEIVED → harvest + /sd, regen button).
import { imageDefaults, imagegenProfileDefaults, wireImageSettings, updateImageUI, auditRenderedImagesAfterForeignWrites, wornOutfitWriteTask, deleteGlobalPromptInjection, seedComfyBustPlaceholder } from './features/imagegen/index.js';
import { wireRoster, refreshRosterUI, updateRosterUI, wornOutfitCleaningMission, characterRegistryJournalTask, resetCharacterRegistryForChat, wornOutfitEditJournalTask, resetWornOutfitEditsForChat } from './features/character-roster/index.js';
import { registerOwnStateTask } from './features/own-state/index.js';
import { registerCleaningMission, streetcleanerTask } from './features/streetcleaner/index.js';
import { rosterProfileDefaults } from './features/character-roster/index.js';

// Extra LLM Calls: importing registers globalThis.mvuHelperInterceptor (manifest
// generate_interceptor) + the MESSAGE_RECEIVED POST pass.
import { extraLlmCallsDefaults } from './features/small-llm/index.js';
import { wireExtraLlmCalls, updateExtraLlmCallsUI, refreshExtraLlmCallsUI } from './features/small-llm/index.js';
import { importCardConfig } from './features/card-config/index.js';
import { statBoxProfileDefaults } from './features/statbox/index.js';
import { wireReplyIntegrity } from './sillytavern/reply-integrity.js';
import { wireFinishReasonTap } from './sillytavern/finish-reason-tap.js';
import { wireRenderVisibility } from './sillytavern/render-visibility.js';
import { wireRenderedRegionPlacement } from './sillytavern/rendered-region-placement.js';
import { wireSidePanel, sidePanelProfileDefaults } from './features/side-panel/index.js';
import { enabledCalls, reportUnrunnableRoutedCalls, getExtraLlmCallsProfile } from './features/small-llm/index.js';
import { syncCardData, syncCardDataWithRetry, registerSyncPass, registerForcePayloadProvider, isRetryableSkip, getLastCompletedSync, getSyncWatermark, SYNC_RETRY_MAX_ATTEMPTS, SYNC_RETRY_DELAY_MS } from './features/card-sync/index.js';
import { setTaskTargetSource, refreshTaskTargets, POST_DONE_EVENT } from './features/llm-task-router/index.js';
import { scanEventPacks, ensureEventPackRowsOnGenerationFloor } from './features/event-pack/index.js';
import { ensureGlobalMvuImport, ensureGlobalMvuImportAtLoad, neutralizeCardMvuDuplicates, wireMvuInstallOffer } from './features/mvu-bootstrap/index.js';
import { initWorldInfoBudgetWarning } from './features/worldinfo-budget/index.js';

// The registrations the library layers must NOT make themselves: a lower layer never imports up into a
// feature, so each one is wired here, in the composition root — the one place allowed to know both
// sides (CLAUDE.md, Directory structure, P5).
//
// The llm-task router offers "route this task to a PRE/POST call"; only small-llm knows what the
// active card's enabled calls ARE. Registered here so the router imports no feature.
//
// THE MASTER SWITCH GATES THE LIST: enabledCalls() checks each call's OWN enabled flag, not the
// feature's, and a call that can never RUN is not a routable target. With Extra LLM Calls off this
// returns [], the stored preference shows as "(unavailable)" in the picker, and applyTaskRouting
// clears the routing entry. The preference itself persists, so turning the switch back on restores
// the routing untouched.
setTaskTargetSource(() => {
    const elc = getExtraLlmCallsProfile();
    return elc.enabled ? enabledCalls(elc.calls) : [];
});

// The [InitVar] sync owns re-applying the card's own seed; reconciling installed event packs is
// event-pack's own logic. Registered here so card-sync imports no feature — both ride the same
// entry fetch, the same blob, and the same single write.
registerSyncPass('event-pack', scanEventPacks);

// GameLogic Pack: refreshes the synchronous exposes cache and reports a malformed registry. It writes no
// state — the card's own [InitVar] is the seed, and card-sync applies it. Registered after event-pack,
// which keeps event-pack's pass first.
registerSyncPass('gamelogic-pack', gameLogicPackSyncPass);

// The FORCE half's source. card-sync must stay usable on a card with no pack at all (L4), so it
// cannot import the pack feature to find `force` and `forceFromInitVar` — the pack lane supplies them here
// instead, the same inversion as registerSyncPass. Returns null when no pack is active on this card.
registerForcePayloadProvider(readActiveForcePayload);

// GameLogic Plugin: seeds each installed plugin's own root create-only, and WARNS when a
// binding has drifted — a call the user renamed leaves that plugin's entries routed to nothing, and
// no other part of the system would ever say so.
registerSyncPass('gamelogic-plugin', gameLogicPluginSyncPass);

// mvu-helper's own end-of-reply pass (own-state): on every saved copy of a reply's state, these tasks run in THIS order —
// the reply's character registry changes are written, then the worn-outfit store worked out from the reply's pictures,
// then the reply's edits of that store (an outfit its harvest saved, held by name; a "Wearing now" edit), then the
// streetcleaner sweeps what the writes left. The order is this list's, never the order SillyTavern added listeners in
// (plans/executed/streetcleaner.md §2, plans/reply-cast.md §11).
registerOwnStateTask(characterRegistryJournalTask);
registerOwnStateTask(wornOutfitWriteTask);
registerOwnStateTask(wornOutfitEditJournalTask);
registerOwnStateTask(streetcleanerTask);
// The streetcleaner's missions: the feature that owns a part of mvu-helper's root says when its items are stale.
registerCleaningMission(wornOutfitCleaningMission);
// THE GENERATION FLOOR. Both chat-load passes write into the LATEST message only; a regenerate
// seeds from the message BEFORE it and a delete-then-send from an older floor still — so state a
// turn must START from is re-ensured at every real generation start, into the last two
// variable-carrying messages (shared/generation-floor.js has the case table).
//
// TWO ensures, one hook, because both features have state a turn must start from: a plugin's state
// drawer and an event pack's trigger rows (a pack installed at page load merges its rows into the
// latest message, and when the next gesture is a regenerate nothing ever arms). Both are idempotent
// and cost nothing on a floor that already carries their state.
//
// Awaited: emit waits its listeners, so the floor is whole before the prompt builds. dryRun fires
// constantly (every token count) and writes nothing anyway — skipped before it costs a read.
// Sequential rather than parallel: both write the SAME message through Mvu.replaceMvuData, and two
// read-modify-writes in flight over one blob is how one of them loses its merge.
if (typeof eventSource !== 'undefined' && event_types && event_types.GENERATION_STARTED) {
    eventSource.on(event_types.GENERATION_STARTED, async (_type, _opts, dryRun) => {
        if (dryRun) return;
        await ensurePluginDrawersOnGenerationFloor();
        await ensureEventPackRowsOnGenerationFloor();
    });
}

// The plugin lane fills logic-engine's two registration seams (P5 — logic-engine imports no plugin
// feature). Engine texts join the shared Worker's N-text boot; the relay participants run once per reply,
// after its last write — after the game's own resolvePostRelay when POST wrote a block (turn-runner).
registerPluginEngineSource(readInstalledPluginEngines);
// The StatusMenu Engine text rides the same N-text boot — one more scope in the shared Worker.
registerEngineTextSource(readMenuEngineTexts);
registerRelayParticipantsProvider(readRelayParticipants);

// Which pack owns this card is the gamelogic-pack feature's fact, and the loader caches it at load
// so engineInfo() can stay synchronous — same P5 inversion as the two seams above.
registerActivePackIdSource(async () => readActivePackIdFrom(await getStandaloneLorebookEntries()));
// The same inversion for the active pack's `exposes` map, so ONE call answers "which engine is this
// and what does the game expose" — on the page and inside the Worker alike. The gamelogic-pack
// feature owns the fact; the loader is a lower layer and may not import it.
registerActiveExposesSource(getActiveExposes);

// The NARROW main-page identity surface — the whole public contract for "which engine is this and
// what does the game expose", for EJS branching inside card/plugin entries. Deliberately not the raw
// globalThis.LogicEngine API, and frozen so an entry cannot grow it. EJS renders BEFORE macros
// expand, so branching code uses THIS global; the {{mvuhelperEngineName}}/{{mvuhelperEngineVersion}}
// macros below are for plain-text entries only.
//
// `rollPool`: the dealer, platform-owned and present on EVERY card. It lives here, not on
// globalThis.LogicEngine, which is DELETED on an engine-less card and during every engine reload —
// there a standalone plugin's window would have no dealer, and a pack card's prompt assembly could
// land in a reload gap and fall back to inline crypto. THIS global is assigned at module load and
// never deleted, so the dealer is reachable whenever mvu-helper is. LogicEngine's absence remains the
// no-engine signal.
// `packInfo` (pack-info): the read-only "what is actually installed?" report, across ALL FOUR
// artifact types. Here rather than in a tab because the question is asked from OUTSIDE the GUI — a
// console, an MCP session, a bug report — and the hand-rolled answer reads the card's embedded
// character_book, which ST ignores whenever a standalone world is bound. One call, and it names the
// store it read.
// `statusMenuFrameSource`: the ONE composition of the contained menu frame —
// sandbox tokens + srcdoc (CSP, prelude, the lifted document) — so a second host (galgame-companion)
// sets both on a frame it owns and never handles the document or a copy of the containment itself.
// `log`: a card's own page scripts (its EJS entries, its TavernHelper scripts) log through mvu-helper's
// gates and print as `[mvu-helper] [card] …` — `MvuHelper.log.child('EJS').warn(…)` adds a stage tag.
// The same methods as the Worker's `MvuHelper.log`, so card and engine code log the same way. Optional
// for any card: nothing is forced, and `console` still works.
// `settings` (public-settings): mvu-helper's settings by name — `get('debug.pipeline')`, `names()`, and
// `set` for the debug switches — so a card's code never reads SillyTavern's settings object, which a
// pack's templates are warned about at install. The Worker's `MvuHelper.settings` answers the same names.
globalThis.MvuHelper = Object.freeze({ engineInfo, exposes: getActiveExposes, rollPool, packInfo, statusMenuFrameSource, log: createModuleLog('card'), settings: publicSettings });

import { publicSettings } from './features/public-settings/index.js';

// Event Packs: the community-event install lane ([MVU_Event_Pack] entries).
import { wireEventPackTab, refreshEventPackUI } from './features/event-pack/index.js';
// The dev loop's eventpack lane — the install without the tab.
import { installEventPackArtifact, eventPackIdsIn, eventPacksOnCard, eventPackArtifactTexts } from './features/event-pack/index.js';
import { packInfo } from './features/pack-info/index.js';
import { wireGameLogicPackTab, wireArtifactTabs, refreshArtifactTab, wireBlankPackCard, gameLogicPackSyncPass, readActiveForcePayload, registerArtifactLane, readActivePackIdFrom, getActiveExposes, installPackToLibrary, listLibraryPacks, activatePack, packAdoptionPending } from './features/gamelogic-pack/index.js';
import { getStandaloneLorebookEntries } from './sillytavern/lorebook.js';
import {
    PLUGIN_TYPE, gameLogicPluginSyncPass, ensurePluginDrawersOnGenerationFloor, readInstalledPluginEngines, readRelayParticipants,
    wireGameLogicPluginHandlers, refreshGameLogicPluginUI, onInstallPluginFromLibrary, setPluginTabRepaint,
    readCardPluginState, installPlugin, SCHEMA_ANSWER_REPLACE,
} from './features/gamelogic-plugin/index.js';

// StatusMenu Packs: the menu install lane — its own tab, registry and lifecycle, on the artifact tabs' shared library.
import {
    STATUSMENU_TYPE, wireStatusMenuHandlers, refreshStatusMenuUI, refreshMenuEngineUpload, onInstallMenuFromLibrary, setStatusMenuTabRepaint,
    readMenuEngineTexts, wireStatusMenuDispatcher, wireStatusMenuFrame, statusMenuFrameSource, activateMenu, readCardMenuState,
} from './features/statusmenu-pack/index.js';

// Artifact dev loop: watches `npm run dev` and re-applies changed artifacts
// through the SAME lanes a library install uses. Lanes registered HERE, not imported there (P5).
import { devLoopDefaults, registerDevLane, wireArtifactDevLoopUI, devLoopChatChanged, refreshDevLoopStatus } from './features/artifact-dev-loop/index.js';

// LogicEngine: the card's hosted game engine, and the turn runner that calls it on every reply.
import {
    logicEngineProfileDefaults, leadTextProfileDefaults, wireLogicEngineTab, refreshLogicEngineUI, loadLogicEngine,
    registerPluginEngineSource, registerEngineTextSource, registerRelayParticipantsProvider,
    engineInfo, registerActivePackIdSource, registerActiveExposesSource, rollPool,
    notePostPhaseDone,
} from './features/logic-engine/index.js';

const log = createModuleLog('startup');

// Repaint every panel from current settings.
function updateUI() {
    updateMainUI();
    updateImageUI();
    updateRosterUI();
    updateExtraLlmCallsUI();
}

// The tab table is composed here because each row wires another feature's repaint; the shell
// (features/settings-panel) switches tabs from it, and each feature renders its own page content.
//
// ONE TABLE PER TAB, BOTH REPAINT PATHS DERIVED FROM IT: the shell's per-tab click handlers and the
// CHAT_CHANGED repaint both read this table. Two hand-maintained lists that must agree eventually will
// not, and a tab missing from the CHAT_CHANGED half keeps a verdict painted for the whole session (an
// installed, running pack reported as not installed). A tab declares its repaints ONCE here; forgetting
// a tab entirely means its button opens a panel that never paints — loud in the first minute of dev,
// not latent for a session.
//
//   onOpen       — repaint when the tab is CLICKED. For tabs reading the lorebook/save, so they never
//                  show a stale list (and the logic tab also retries a book-not-ready engine load, so
//                  opening it after a slow chat load self-heals).
//   onChatChange — repaint when the CHAT changes. Superset question: settings-driven panels (image,
//                  llm) live here too, because a card switch changes what their per-card fields show.
//   (main has neither: global options only, painted by updateUI at build time.)
// Display order is the nav's, in settings.html.
const TABS = [
    { name: 'main' },
    { name: 'image', onChatChange: () => updateImageUI() },
    { name: 'roster', onOpen: () => refreshRosterUI(), onChatChange: () => refreshRosterUI() },
    { name: 'llm', onChatChange: () => refreshExtraLlmCallsUI() },
    {
        name: 'logic',
        onOpen: async () => { await loadLogicEngine(); await refreshLogicEngineUI(); },
        onChatChange: () => refreshLogicEngineUI(),   // loadLogicEngine runs earlier in the CHAT_CHANGED chain
    },
    // An artifact tab's refresh repaints each of its lanes' card groups, then its library.
    { name: 'gamelogic', onOpen: () => refreshArtifactTab('gamelogic'), onChatChange: () => refreshArtifactTab('gamelogic') },
    { name: 'statusmenu', onOpen: () => refreshArtifactTab('statusmenu'), onChatChange: () => refreshArtifactTab('statusmenu') },
    { name: 'events', onOpen: () => refreshEventPackUI(), onChatChange: () => refreshEventPackUI() },
    { name: 'development', onOpen: () => repaintDevelopmentTab(), onChatChange: () => repaintDevelopmentTab() },
];
// The Development tab's two painted blocks, each its own feature's. The dev loop's setup line is re-asked here because
// every gesture that can change its answer (an install, an uninstall, a library Remove) happens on another tab.
function repaintDevelopmentTab() {
    void refreshDevLoopStatus();
    void refreshMenuEngineUpload();
}
// The CHAT_CHANGED half of the table. void per tab, not one shared await chain: the repaints are
// independent, and one tab's slow read must not hold back another's.
function repaintTabsOnChatChange() {
    for (const t of TABS) { if (t.onChatChange) void t.onChatChange(); }
}

// Build the settings page and bind every feature's handlers.
async function createSettings(settingsHtml) {
    // EVERY id this extension puts in the page is `mvuh_`-prefixed, and must stay that way: the page is
    // shared with every other installed extension, and a duplicate id is not an error anyone sees —
    // jQuery silently takes whichever node is first, so two extensions end up driving one panel.
    if (!$('#mvuh_settings_container').length) {
        $('#extensions_settings2').append(
            '<div id="mvuh_settings_container" class="extension_container"></div>',
        );
    }
    $('#mvuh_settings_container').empty().append(settingsHtml);

    // The drawer's launcher, the nav (tab switching + repaint-on-open from the ONE table above) and the
    // behaviours every gene shares.
    wireSettingsPanel(TABS);

    wireMain();            // general options (global)
    wireMvuInstallOffer(); // Main tab's "Install MVU" row (shown only while MVU is not installed)
    wireImageSettings();   // image-gen (global) settings handlers
    wireRoster();          // character-DNA roster panel (per-card route, unified list)
    refreshRosterUI();     // first paint (async fire-and-forget; it logs its own failures)
    wireExtraLlmCalls();        // extra-LLM-calls (per-card) panel — also renders the lists
    wireEventPackTab();    // event-pack install lane (per-card worldbook; list paints on tab open)
    wireArtifactTabs();    // the GameLogic Packs and StatusMenu Packs tabs' library and Import (ROOT-LEVEL worldbook — no chat)
    wireGameLogicPackTab(); // the GameLogic Pack's lane on its tab
    wireBlankPackCard();   // the Development tab's Add New Blank Packs
    // GameLogic Plugins render into the GameLogic Packs tab but own their own lifecycle and registry.
    // Registered here rather than imported by the artifact tabs: the plugin's activation already imports
    // that feature's barrel for the shared file validator, so a direct import would close a cycle (P5).
    wireGameLogicPluginHandlers();
    setPluginTabRepaint(() => refreshArtifactTab('gamelogic'));   // a plugin action repaints the LIBRARY list too

    registerArtifactLane(PLUGIN_TYPE, {
        install: (id) => onInstallPluginFromLibrary(id),
        installedIds: () => refreshGameLogicPluginUI(),
    });
    // The StatusMenu lane, on its own tab, wired the same way and for the same cycle-avoidance reason (P5).
    wireStatusMenuHandlers();
    setStatusMenuTabRepaint(() => refreshArtifactTab('statusmenu'));
    registerArtifactLane(STATUSMENU_TYPE, {
        install: (id) => onInstallMenuFromLibrary(id),
        installedIds: () => refreshStatusMenuUI(),
    });
    // The menu's WRITE lane: one window listener for action requests posted by the menu
    // iframe. Wired here rather than from the tab, because it must answer whether or not the settings
    // panel was ever opened — a player clicks menu buttons without ever visiting mvu-helper's UI.
    wireStatusMenuDispatcher();
    // The menu's FRAME: mounts the sandboxed frame into the marker-form region the
    // lift left on the card, on the page's own render events. Same reason it lives here: a player
    // reads the menu without ever opening mvu-helper's UI.
    wireStatusMenuFrame();
    // The dev loop's activation lanes — each is the EXACT flow the tab's own install runs, with the
    // confirm flags a dev cycle answers for you (development overwrites the card freely).
    // `sections` is the loop's per-sink plan: null = full activation, a list = only
    // those blocks. The two pack lanes forward it into the SAME write path an install uses, masked.
    registerDevLane('gamelogic', {
        install: (text) => installPackToLibrary(text),
        activate: (pack, { sections = null } = {}) => activatePack(pack.id, { confirmDowngrade: true, sections }),
        // The SAME activation with adoption allowed. A separate entry point rather than a
        // flag on `activate`, so the overwrite of a card-owned surface can only happen where someone
        // answered for it: nothing the loop does on its own can reach this.
        adopt: (pack, { sections = null } = {}) => activatePack(pack.id, { confirmDowngrade: true, sections, adopt: true }),
        // The standing question when the developer declined: the artifact is not applied, nothing is
        // broken, and one Adopt clears it. Read-only — it re-reads the card, never re-activates.
        // The fence's read: is THIS pack the one active on the card? Only then is a save an update
        // rather than an install.
        onCard: async (pack) => readActivePackIdFrom(await getStandaloneLorebookEntries()) === pack.id,
        needsSetup: async (pack) => {
            const verdict = await packAdoptionPending(pack.id);
            return verdict ? verdict + " — use this pack's Install button on the GameLogic Packs tab to replace them" : '';
        },
    });
    registerDevLane(STATUSMENU_TYPE, {
        install: (text) => installPackToLibrary(text),
        activate: (pack, { sections = null } = {}) => activateMenu(pack.id, { confirmDowngrade: true, confirmSwitch: true, sections }),
        onCard: async (pack) => (await readCardMenuState()).registry?.activeMenuId === pack.id,
    });
    // One reader for "is this plugin on the open card, and with which bindings?" — the activate arm
    // needs the bindings, the setup probe needs only the yes/no, and two spellings of the same lookup
    // is how they drift apart.
    const pluginCardRecord = async (id) => {
        const state = await readCardPluginState();
        return ((state.registry && state.registry.activePlugins) || []).find((r) => r.id === id) || null;
    };
    registerDevLane(PLUGIN_TYPE, {
        install: (text) => installPackToLibrary(text),
        onCard: async (pack) => Boolean(await pluginCardRecord(pack.id)),
        // A plugin's call bindings are the user's own first-install answers; the dev loop REUSES
        // them and never invents them. Not installed yet -> a named refusal, not a guess.
        // No `sections` here — always the full install. A mask nobody can live-verify would be a
        // guard never seen to fail (L6); the first genre that ships a plugin artifact earns it.
        activate: async (pack) => {
            const rec = await pluginCardRecord(pack.id);
            if (!rec) return { ok: false, action: 'not-installed', reasons: ['plugin "' + pack.id + '" is not on this card yet — install it once from the Packs tab so its call bindings exist; the dev loop reuses them from then on'] };
            return installPlugin(pack.id, { stateName: rec.stateName, preCall: rec.boundCalls.pre, postCall: rec.boundCalls.post, confirmDowngrade: true });
        },
        // The yes to the adopt question: the card's own schema (one no GameLogic Pack installed, and not
        // this plugin's earlier one) is replaced with the plugin's — the same answer the GameLogic Packs tab records.
        adopt: async (pack) => {
            const rec = await pluginCardRecord(pack.id);
            if (!rec) return { ok: false, action: 'not-installed', reasons: ['plugin "' + pack.id + '" is not on this card yet'] };
            return installPlugin(pack.id, { stateName: rec.stateName, preCall: rec.boundCalls.pre, postCall: rec.boundCalls.post, confirmDowngrade: true, schemaAnswer: SCHEMA_ANSWER_REPLACE });
        },
        // The standing setup question, READ-ONLY — the dev loop re-asks it on every packs-tab repaint,
        // because installing, uninstalling and removing the library copy all happen in THAT tab, and
        // no dev-server event will ever mention them. Two states, two instructions: with a library
        // copy there is a button to press, without one there is not.
        needsSetup: async (pack) => {
            const library = await listLibraryPacks();
            // COULD NOT LOOK is not AN ANSWER. At extension load the lorebook API is not attached
            // yet, so an empty read here means nothing — asserting "not installed" from a book that
            // never opened is the bootstrap lie the artifact tabs already refuse to tell. The loop is in
            // its boot-order wait at that moment, and that is what the status line should say.
            if (library === null) return '';
            if (await pluginCardRecord(pack.id)) return '';
            // BOTH exits, always. The library copy is the loop's OWN write, so "Remove" cannot end
            // this — deleting the folder can, and so can installing once. A message that names only
            // the install reads as a demand, and the developer goes hunting for a delete button that
            // does nothing.
            return library.some((p) => p.packType === PLUGIN_TYPE && p.id === pack.id)
                ? "needs a one-time install from the Pack library — a plugin’s call bindings are yours to choose — or delete the folder to stop applying it"
                : 'is not on this card, and Remove cannot end this: the library copy is the loop’s own write and the next save puts it back. Install it once, or delete the folder.';
        },
    });
    // An EVENTPACK artifact is its events/ directory — one upload file per member, each declaring its
    // own packs. The lane hands those texts to the event-pack feature and reads back the same verdict
    // every other lane returns; nothing here knows what is inside one.
    //
    // No `needsSetup`: an event pack has nothing for a person to answer. Its entries and registry
    // record are derived from the file, so the first save installs it outright — where a plugin has to
    // wait for call bindings only its owner can choose.
    registerDevLane('eventpack', {
        // The library add is the same door as the other three lanes: installPackToLibrary stores an event
        // pack in the EVENT-PACK library (one entry per packId), the book the Event Packs tab lists and
        // reinstalls from. This is the write the card fence deliberately lets through.
        install: (text) => installPackToLibrary(text),
        onCard: (pack) => eventPacksOnCard(eventPackIdsIn(eventPackArtifactTexts(pack))),
        // No `sections` arm: an event pack has ONE sink — the card's entries plus its registry record,
        // written together. A mask over a single sink would be a guard that can never be seen to fail.
        activate: (pack) => installEventPackArtifact(eventPackArtifactTexts(pack)),
    });
    wireArtifactDevLoopUI();   // resumes watching if the toggle was left on last session
    wireLogicEngineTab();  // hosted-resolver tab (per-card; status paints on tab open)
    wireSidePanel();       // one slot per installed artifact carrying a panel entry;
                           // hidden entirely on a card with none, so ordinary cards see nothing.
    wireReplyIntegrity();  // truncated-reply watchdog — NO panel, no settings, deliberately ungated:
                           // a reply cut off mid-<UpdateVariable> loses its writes silently, and a
                           // card's own GUI shows that as an empty panel rather than an error.
    wireFinishReasonTap(); // feeds the watchdog the finish reason ST drops (observation-only fetch
                           // clone — the user-decided doctrine exception, see the tap's header).
    wireRenderedRegionPlacement(); // our region got adopted by an unclosed tag - move it back, nothing else
    wireRenderVisibility(); // hidden-render watchdog — NO panel, no settings, same doctrine as
                           // reply-integrity: a menu that built fine inside a display:none ancestor
                           // shows as "missing" with a healthy console; this names the ancestor.

    // The plain-text half of engine identity — {{mvuhelperEngineName}} and {{mvuhelperEngineVersion}}
    // for entries that are not EJS. Function values, so every expansion reads the CURRENT engine. Empty
    // string when no engine: a plain-text entry cannot branch anyway, and branching code uses
    // globalThis.MvuHelper.engineInfo(). EJS renders FIRST, then macros expand, so a macro read INSIDE
    // <% %> yields the literal token.
    // Plain camelCase keys: with ST's experimental macro engine on, a `::` key registers without error and
    // never expands, while a plain key expands under both engines.
    try {
        const ctx = getContext();
        if (typeof ctx.registerMacro === 'function') {
            ctx.registerMacro('mvuhelperEngineName', () => engineInfo().name || '', 'The active game engine\'s name (its ENGINE_NAME export), or empty');
            ctx.registerMacro('mvuhelperEngineVersion', () => engineInfo().version || '', 'The active game engine\'s version (its ENGINE_VERSION export), or empty');
        } else {
            log.child('macros').warn('context.registerMacro unavailable — {{mvuhelperEngineName}}/{{mvuhelperEngineVersion}} will reach prompts unexpanded');
        }
    } catch (e) {
        log.child('macros').warn('registering the mvuhelper macros failed — they will reach prompts unexpanded:', e);
    }

    showPanelTab('main');  // default landing tab
    updateUI();
    await applyHelperLocale();   // translate the freshly-built panel (saved Language setting)
}

// SillyTavern lifecycle hook (manifest `hooks.update`). ST calls this named export after
// it successfully updates the extension, then toasts "Reload the page to apply updates".
// A full reload is REQUIRED because ST loads extension JS as a plain `<script type=module
// src=/scripts/extensions/.../index.js>` with no cache-busting — nothing re-fetches the
// module mid-session. The reload works because ST serves public/ via express.static with
// max-age=0 + ETag, so the browser revalidates and gets the new file (verified in ST 1.18).
// Mirrors VectFox's onUpdate — automates the manual reload ST would otherwise ask for.
export async function onUpdate() {
    log.lifecycle('update detected — reloading page to clear the module cache');
    location.reload();
}

// Initialize the extension.
//
// NOTHING HERE MAY BE FETCH-GATED. Everything below this line runs in ONE async function, so the first
// statement that throws ends the boot right there and every later registration silently never happens —
// while the module-top-level half (globalThis.MvuHelper at the head of this file, the eventSource.on
// calls in imagegen/roll-pool/turn-runner) is already live. That combination is the dangerous one: the
// page answers "installed: yes" and fires our listeners with no settings loaded and no UI built.
// So a fetch belongs BESIDE the one thing that needs it, inside its own try, and never at the top.
$(function () {
    (async function () {
        // The wand entry first: it needs nothing fetched. Its click path reports its own missing panel
        // (openSettingsPanel), so it stays honest even if the settings markup never arrives.
        $('#extensionsMenu')
            .append(`<div id="mvuh_wand_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-robot"></div>
            <span data-i18n="MVU Helper">MVU Helper</span>
        </div>`);
        $('#mvuh_wand_button').off('click').on('click', () => void openSettingsPanel());

        loadSettings({ ...panelDefaults, ...mainDefaults, ...imageDefaults, ...devLoopDefaults }, { ...extraLlmCallsDefaults, ...imagegenProfileDefaults, ...rosterProfileDefaults, ...logicEngineProfileDefaults, ...leadTextProfileDefaults, ...statBoxProfileDefaults, ...sidePanelProfileDefaults });
        applyPanelTheme();   // themes any dialog shown before the panel is built; the switch is marked once it exists
        deleteGlobalPromptInjection();
        seedComfyBustPlaceholder('load');   // the bust checkbox is ON by default, so a new install never ticks it

        // The settings PANEL is the only thing that needs this file, so the fetch lives here and its
        // failure is contained here: the engine, the MVU bootstrap and every listener below wire up
        // without a panel. The URL is in the message because the overwhelmingly likely cause is that
        // it is not being served, and a jqXHR rejection does not name what it was fetching.
        try {
            const settingsHtml = await $.get(SETTINGS_PANEL_HTML_URL);
            await createSettings(settingsHtml);
        } catch (e) {
            // The STATUS goes in the sentence, not just the object. jQuery rejects with a jqXHR, which
            // renders as `[object Object]` in a console line and in any captured log — the one fact that
            // tells you whether the file is missing, forbidden or the server is down would be a click away.
            const status = (e && typeof e.status === 'number') ? ` — HTTP ${e.status} ${e.statusText || ''}`.trimEnd() : '';
            log.error(`the settings panel could not be built, so the extension has NO UI this `
                + `session (everything else is still running). Fetching ${SETTINGS_PANEL_HTML_URL} `
                + `failed${status}:`, e);
        }

        // MVU is THIS extension's dependency, not a pack's: every state feature here is built on it, so an
        // install without it is a broken install. Offered ONCE with consent, asked AFTER loadSettings so the
        // remembered answer is readable. Deliberately not awaited into the boot path — a modal at load must
        // not block the rest of the UI from wiring up.
        //
        // TavernHelper's script API attaches after this point (measured ~14 s), so the check waits for it —
        // 30 s at most, then an error toast — rather than for a chat to open.
        void ensureGlobalMvuImportAtLoad();

        // SillyTavern drops world info entries once the token budget is reached and says nothing in the
        // reply — a card whose rules live in world info then runs with half of them missing, and the
        // symptom reads as a model that stopped following instructions. ST already decides and announces
        // this; we only listen, and name the Context Size that would have fitted.
        initWorldInfoBudgetWarning();

        // Keep values fresh when the settings panel becomes visible.
        $('#extensions-settings-button').on('click', function () {
            setTimeout(updateUI, 200);
        });

        // The mvu-helper setup is per-card: import the card's [Initmvuhelper] config — installed on a fresh
        // profile, re-imported when the card's config changed since this profile imported it, otherwise left
        // alone (card-config.js) — then repaint the tabs from the now-active profile.
        // CHAT_CHANGED = card/chat switch. Handles WARM opens + card switches; a fresh load is covered by the
        // init-event handler and the initial-load retry below. A read that reaches only the card's embedded
        // lorebook snapshot (sillytavern/lorebook.js's fallback) installs a fresh profile but re-imports nothing.
        // The card→save sync rides the SAME two hooks (card-sync/card-sync.js): it re-applies the card's own
        // [InitVar] create-only, so a RUNNING game receives data a later card version added (MVU reads
        // [InitVar] only when a chat is created), and applies the GameLogic Pack's `force` corrections and
        // `forceFromInitVar` paths once per state version — recorded in mvu-helper's own chat-metadata
        // namespace, never in the card's stat_data.
        // checkLorebookApiAvailable runs LAST on purpose. The reads above can fire before ST has populated
        // characterId, and the API-missing report grades itself by whether a character is selected — so a
        // report made that early is treated as startup noise and stays quiet. By here the awaits have
        // settled and a card is demonstrably open, which is the only moment a missing JS-Slash-Runner can
        // be told apart from one that simply had not attached yet.
        // ENGINE FIRST — a SEPARATE listener, promoted to the head of the CHAT_CHANGED queue.
        //
        // ST-Prompt-Template evaluates every world-info entry during chat load ("*** EVALUATING 46 WORLD
        // INFO ***"), and the card's [PRE] <Initiative_Menu> / <Event_Candidates> entries plus narrate's
        // ## INITIATIVE panel call globalThis.LogicEngine while it does. Both extensions listen to the
        // SAME event (event_types.CHAT_CHANGED === 'chat_id_changed'), and eventSource.emit awaits
        // listeners IN REGISTRATION ORDER — ST-Prompt-Template activates before us (it is earlier in ST's
        // extension list), so a load inside our main handler runs after its evaluation no matter how
        // early in that handler it sits.
        //
        // makeFirst moves this listener to the FRONT of that queue, and because emit AWAITS each one, the
        // engine is hosted before the first template renders. This is ordering, not a timer or a poll.
        // (Caveat worth knowing: "first" is only true against listeners registered so far — another
        // extension calling makeFirst later would take the lead.)
        //
        // Deliberately MINIMAL and separate from the main handler below: it must not wait on card config,
        // data sync, or UI work. The main handler calls loadLogicEngine() again after importCardConfig,
        // which is what applies the card's per-card enabled flag — including unloading an engine a card
        // disables. That second call is idempotent (same bytes = no re-eval).
        const loadEngineBeforeTemplates = async () => {
            try { await loadLogicEngine(); } catch (e) { log.child('logic-engine').warn('pre-template load failed:', e); }
        };
        eventSource.on(event_types.CHAT_CHANGED, loadEngineBeforeTemplates);
        if (typeof eventSource.makeFirst === 'function') {
            eventSource.makeFirst(event_types.CHAT_CHANGED, loadEngineBeforeTemplates);
        } else {
            log.warn('eventSource.makeFirst unavailable — the LogicEngine may load after ST-Prompt-Template '
                + 'evaluates the card\'s [PRE] entries, so that render sees no globalThis.LogicEngine and any '
                + 'entry calling it degrades.');
        }

        // refreshTaskTargets LAST, and here rather than only on call-list edits: a PRE/POST-routed task's
        // data-carrier entry lives in the CARD's lorebook while its target is the user's setting, so each
        // chat load re-applies it — the card that just opened gets its entry in the current shape, or loses
        // one whose call no longer runs. The routing check runs after it, so an entry the router is about to
        // remove is never reported. Tab repaints come from the ONE table (TABS.onChatChange). Position
        // matters: after the awaited syncCardDataWithRetry, which does not return until the standalone book
        // is queryable, so every repaint reads a card that actually answers. The card scope (the chips and the
        // card gate) paints FIRST: it reads only SillyTavern's context, which already names the new chat, and a
        // control left open across the awaits would edit a card that has gone. The MVU install check goes next
        // and unawaited: it needs only TavernHelper, never the card sync, so nothing in the chain may hold it
        // up. The duplicate neutralizer stays LAST: its restart of the global MVU must not overlap the sync.
        eventSource.on(event_types.CHAT_CHANGED, async () => { paintCardScope(); resetCharacterRegistryForChat(); resetWornOutfitEditsForChat(); void ensureGlobalMvuImport(); await importCardConfig(); await loadLogicEngine(); await syncCardDataWithRetry(); repaintTabsOnChatChange(); devLoopChatChanged(); checkLorebookApiAvailable(); void refreshTaskTargets().then(() => reportUnrunnableRoutedCalls({ isChatLoad: true })).catch((e) => log.warn('chat load: re-applying llm-task routing or the routing check failed:', e)); void neutralizeCardMvuDuplicates(); });
        // 'mag_variable_initialized' = MVU's OWN init signal (MagVarUpdate bundle; === Mvu.events.VARIABLE_INITIALIZED).
        // MVU emits it with the variable blob (`s`) it is ABOUT to persist to msg 0 (via updateMessages, AFTER this
        // event). syncCardData gets that blob so its writes land in MVU's own persist, instead of a separate
        // replaceMvuData that MVU's later write would clobber. importCardConfig writes only the per-card profile,
        // so it needs no blob.
        // ...and it RETRIES on a not-ready verdict: this shot can find the standalone book un-queryable
        // a moment after a page load. Attempt 2+ drops the blob and takes the standalone path — by then
        // MVU has persisted it.
        // loadLogicEngine FIRST, exactly as CHAT_CHANGED does above, and for a reason that only shows
        // up on this path: syncCardDataWithRetry runs the event-pack scan, which reads the contract the
        // LOADED engine declares. With no engine running yet, a card installing its packs for the very
        // first time would have them stood down for "no engine" a moment before one loaded. The scan
        // pass is synchronous (card-sync's runner is), so the await belongs at the entry point — both
        // entry points have it.
        eventSource.on('mag_variable_initialized', async (mvuData) => { await importCardConfig(); await loadLogicEngine(); await syncCardDataWithRetry({ mvuData }); refreshExtraLlmCallsUI(); });

        // A WRITER THAT REWRITES THE REPLY FROM AN OLDER COPY. Whatever was spliced into the reply after
        // that copy was read is lost with NOTHING logged, because from the writer's side nothing failed.
        // MVU needs no help here (v0.189.0+ writes the reply's current text — devdoc/editing-a-finished-
        // reply.md §MVU1), so nothing edits the message_content of its mag_before_message_update payload.
        // The audit below is what NAMES the next writer that does this.
        //
        // CHARACTER_MESSAGE_RENDERED is the hook because TavernHelper's setChatMessages ends in
        // refreshOneMessage, which emits it after EVERY write — MVU's announced ones and its silent
        // ones alike. Not GENERATION_ENDED: a turn runs several generations, and the early ones land
        // while the picture is still there.
        //
        if (event_types && event_types.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => auditRenderedImagesAfterForeignWrites());
        }

        // The post-reply phase signals POST-done on every generated reply, whether or not a POST call ran
        // (small-llm runPostPass). A reply that no POST parse fires the plugin relay for gets it from here,
        // once its own parse is done too (logic-engine notePostPhaseDone). Wired at the composition root
        // because the signal is small-llm's and the work is logic-engine's, and logic-engine never imports
        // small-llm (small-llm imports logic-engine, so the reverse would close a cycle).
        eventSource.on(POST_DONE_EVENT, (_mesId, postParseComing, postCallsRan) => notePostPhaseDone(Boolean(postParseComing), Boolean(postCallsRan)));

        // INITIAL-LOAD RACE (live-verified, both sides): on a page refresh (a) ST emits its first
        // CHAT_CHANGED while this init is still awaiting settingsHtml — the listeners above attach too
        // late — and (b) window.Mvu (exposed by the JS-Slash-Runner script iframe) comes up AFTER
        // extension init, so a single immediate kick hits "MVU not ready". No event reliably orders
        // either for us → bounded retry. Every attempt is idempotent (config: the stored fingerprint ·
        // sync: DataSyncVer version gate); the loop stops at the first attempt whose sync finds MVU + a
        // chat and applies (or version-skips), and whose config read reached the standalone lorebook
        // rather than the card's embedded snapshot. Fire-and-forget — never blocks the rest of init.
        //
        // It keeps its OWN loop rather than calling syncCardDataWithRetry, because the thing being
        // retried here is BOTH halves — importCardConfig has its own init race (the script API) and the
        // sync's retryer would leave it at one attempt. The attempt count and delay come from card-sync
        // so the two lanes cannot drift into different ideas of "long enough".
        (async () => {
            for (let i = 0; i < SYNC_RETRY_MAX_ATTEMPTS; i++) {
                try {
                    const configDecision = await importCardConfig();
                    const r = await syncCardData();
                    refreshExtraLlmCallsUI();
                    // Done once the sync is (applied / version-skip / no entry / parse error) AND the card config
                    // was compared against the standalone book, not the embedded snapshot.
                    if (!isRetryableSkip(r) && configDecision !== 'skip-snapshot') return;
                } catch (e) { log.warn('initial-load kick attempt failed (retrying):', e); }
                await new Promise((res) => setTimeout(res, SYNC_RETRY_DELAY_MS));
            }
            // OUT OF ATTEMPTS — say which of three very different things happened. The window here is
            // SYNC_RETRY_MAX_ATTEMPTS x SYNC_RETRY_DELAY_MS from extension init, and a heavy install can
            // take longer than that just to open the chat, so CHAT_CHANGED may well have synced since. One
            // unconditional claim ("sync will run on the next chat switch") is false on a slow ST, and a
            // warning that cries wolf on every load hides the one case that matters — so grade it.
            const retryWindow = `${Math.round(SYNC_RETRY_MAX_ATTEMPTS * SYNC_RETRY_DELAY_MS / 1000)}s`;
            const synced = getLastCompletedSync();
            if (synced) {
                log.child('initial-load').lifecycle(`gave up after ${retryWindow}, but a sync has since completed (${synced.reason || 'applied'}) `
                    + '— the CHAT_CHANGED path handled it. Nothing to do.');
                return;
            }
            // Nothing synced. Is there even a chat to sync INTO? No chat = ST was still loading and the
            // CHAT_CHANGED listener above will do the work when it arrives; that is not a fault.
            let chatOpen = false;
            try {
                const c = getContext();
                chatOpen = Boolean(c && Array.isArray(c.chat) && c.chat.length > 0
                    && (c.characterId != null || c.groupId != null));
            } catch (e) {
                log.child('initial-load').lifecycle('context unreadable while grading the give-up:', e);
                chatOpen = true;   // unknown beats wrong — fall through to the loud branch
            }
            if (!chatOpen) {
                log.child('initial-load').lifecycle(`gave up after ${retryWindow} — no chat was open yet, so there was nothing `
                    + 'to sync. CHAT_CHANGED will run it when a chat loads.');
                return;
            }
            // STILL not the real thing. getLastCompletedSync is a SESSION record — a page reload wipes it —
            // so its absence says nothing about this SAVE. The watermark is the durable answer: a save that
            // took its state corrections in an earlier session, and was merely slow to open, has nothing
            // missing. It is deliberately NOT compared to the card's declared version: reading the card entry
            // is the very thing that was not ready, so a "newer version?" claim here would be a guess.
            // A card whose pack declares no `state.version` never carries a watermark, so its absence proves
            // nothing either — the warning below says only what is known: no sync completed in this load.
            const appliedVersion = getSyncWatermark();
            if (appliedVersion) {
                log.child('initial-load').lifecycle(`gave up after ${retryWindow}, but this save already took state version `
                    + `v${appliedVersion} in an earlier session — nothing is known to be missing. The next chat `
                    + 'switch syncs again.');
                return;
            }
            log.child('initial-load').warn(`a chat is open but the card→save sync never completed in ${retryWindow}, so this `
                + 'load\'s [InitVar] re-apply is not known to have run. Switch chats to retry; if it persists, check '
                + 'that MVU (window.Mvu) is loading and that the standalone worldbook is queryable.');
        })();
    })().catch((e) => log.error('initialization threw and stopped partway — whatever is registered '
        + 'below the failure point is NOT wired up, even though the page still reports the extension as present:', e));
});
