// features/small-llm — the Extra LLM Calls relay: the PRE interceptor and the POST pass that move
// lorebook blocks to a cheap model, plus its settings panel.
//
// This feature's CARD-CONFIG SECTION HANDLER (normalize/serialize/merge for extraLlmCalls) lives in
// extra-llm-calls-core.js and is read by features/card-config's registry, deliberately NOT re-exported
// here: this barrel imports the ST host, and the registry must stay host-free to be unit-testable.
//
// enabledCalls is public because the composition root feeds it to the llm-task router as the
// available PRE/POST targets (the router must not import this feature itself).
export { extraLlmCallsDefaults } from './extra-llm-calls-core.js';
// This card's extraLlmCalls block: the one door every reader outside this feature takes.
export { getExtraLlmCallsProfile } from './extra-llm-calls.js';
// The routing check: lorebook entries routed to a call that will not run. The composition root runs it on
// chat load, after the llm-task router has re-applied its targets; this feature's own UI runs it on edits.
export { reportUnrunnableRoutedCalls } from './extra-llm-calls.js';
export { wireExtraLlmCalls, updateExtraLlmCallsUI, refreshExtraLlmCallsUI } from './extra-llm-calls-ui.js';
export { enabledCalls } from './extra-llm-calls-core.js';
