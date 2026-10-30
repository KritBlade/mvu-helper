// features/logic-engine — host a card's game engine (stored in its [MVU_LogicEngine] entry) in a
// sandboxed Worker, publish async proxies of its function exports as `globalThis.LogicEngine`, and run
// the turn: the turn runner calls resolveTurn (RES1) and resolvePostRelay (RES2) on MVU's update event.
// Per-card profile flags and the LogicEngine tab live here too.
export { logicEngineProfileDefaults } from './logic-engine-core.js';
// The card's leadText section (the opening tags of its story block) is per-card profile state; its card-config
// handler lives in turn-runner-core.js and is read by features/card-config's registry, not re-exported here.
export { leadTextProfileDefaults } from './turn-runner-core.js';
// getLogicEngineApi is the TAMPER-RESISTANT handle (the loader's own module.exports), as opposed to
// globalThis.LogicEngine, which the uploaded engine could shadow. Anything that ACTS on an engine
// answer — the turn runner, the [PRE] same-round candidate guard — must use this one.
// engineIdentity is engineInfo without the interface map: the ctx.engine every plugin hook receives.
export { loadLogicEngine, getLogicEngineStatus, getLogicEngineApi, engineInfo, engineIdentity, getScopeDeclared, registerActivePackIdSource, registerActiveExposesSource } from './logic-engine-loader.js';
export { GAME_ENGINE_SCOPE } from './logic-engine-core.js';
// The REGISTRATION seams the artifact lanes fill at composition time (P5 — this feature never imports
// an artifact feature): a lane feeds the shared Worker a text (registerPluginEngineSource for the
// plugins, registerEngineTextSource for any lane) and reaches its hosted scope (getEngineScopeApi,
// callEngineScopeBatch); registerRelayParticipantsProvider supplies who runs on the relay fire.
export { registerPluginEngineSource, registerEngineTextSource, getEngineScopeApi, callEngineScopeBatch } from './logic-engine-loader.js';
export { registerRelayParticipantsProvider } from './turn-runner.js';
// The dice dealer is mvu-helper's, not the pack's, so it exists with or without an engine: the
// composition root hangs it on globalThis.MvuHelper, the platform surface every card has.
export { rollPool } from './roll-pool.js';
// The one definition of "is this generation a turn of the story". The dealer and the PRE interceptor both
// decide on it, so `continue`/`quiet`/`impersonate` skip BOTH the re-deal and the PRE pass — never one
// without the other.
export { isStoryTurnGenerationType } from './logic-engine-core.js';
// The engine states, in its own exports, which event-pack format level it can execute, where it keeps
// that state (triggerRoot | armedPath), where a pack may write, what it pays and which scopes it knows.
// readEventContract turns the LOADED engine's declared record (getScopeDeclared) into the verdicts every
// event-pack site acts on — with no engine loaded, every verdict refuses.
export { readEventContract } from './logic-engine-core.js';
// The engine entry's write/clear: a GameLogic Pack's install writes its engine text into the SAME
// [MVU_LogicEngine] entry, inheriting the whole loader stack.
export { writeEngineCode, clearEngineCode } from './logic-engine-store.js';
export { wireLogicEngineTab, refreshLogicEngineUI } from './logic-engine-ui.js';
// Importing the turn runner REGISTERS its VARIABLE_UPDATE_ENDED / fence listeners — all dormant behind
// profile.logicEngine.enabled, except the save of POST's parse.
// RES_STAGED_EVENT: fired the moment __mvuResBlock is staged, so a waiter waits on a SIGNAL, not a clock; its
// payload says whether the engine saves this resolve (own-state writes only into a copy that is saved);
// readResStaged / readResMarkerDone / awaitResStaged read and wait for that marker (POST carries its block).
// awaitTurnWork: POST waits for the handler run its own parse started before it writes the reply back —
// the relay's ops land in the same reply, and the reply's iframe is never rebuilt under a live emit.
// isTurnResolverActiveNow: whether RES1 will run (and stage that marker) at all — the waiters wait only then.
// isGenerationInFlight: a real generation is running (GENERATION_STARTED until it ends or is stopped).
// notePostPhaseDone: the post-reply phase is done; the plugin relay for a reply no POST parse fired it for.
export { noteSameRoundEventInjected, isTurnResolverActiveNow, isGenerationInFlight, RES_STAGED_EVENT, awaitTurnWork, notePostPhaseDone, readResStaged, readResMarkerDone, awaitResStaged } from './turn-runner.js';
// The audit-block tag the turn runner wraps an engine's resBlock BODY in: POST finds the turn's block by
// it and places the relay's block straight after it.
// REPLY_TAIL_ANCHORS: where a block another writer puts above the menu goes — above the engine's end text, so
// that text stays the last block above the menu. stripLeadAndEndText: the reply without the engine's lead and
// end text, for a reader that must not take them for the reply's own words.
export { TURN_AUDIT_TAG, REPLY_TAIL_ANCHORS, stripLeadAndEndText } from './turn-runner-core.js';
// The suppression gate: a writer that parses its own patch (the PRE-time sim apply, a plugin relay, a
// menu action) wraps the parse in withLiveResolveSuppressed, so its VARIABLE_UPDATE_ENDED echo cannot
// trigger a resolve that would consume the freshly written intent before narrate reads it.
export { withLiveResolveSuppressed } from './live-resolve-gate.js';
export { readMenuEngineExportsInWorker } from './engine-worker-host.js';
