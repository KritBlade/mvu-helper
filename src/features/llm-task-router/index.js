// features/llm-task-router — the feature-agnostic task router: register a task and get a routing
// dropdown (Off / narrate / a PRE-POST call), lorebook entry management, and output capture.
//
// It knows nothing about who defines calls: setTaskTargetSource injects the available targets from
// the composition root, which is what keeps this reusable rather than welded to small-llm.
export {
    registerLlmTask, applyTaskRouting, renderLlmTaskSelect, initLlmTaskRouter,
    refreshTaskTargets, taskTargetOf, setTaskTargetSource,
    resolveRoutedTaskInstructions, shapeRoutedCallInput, isTaskTargetAvailable,
} from './llm-task-router.js';
export { POST_DONE_EVENT, PRE_DONE_EVENT, isTaskRoutingEntryName } from './llm-task-router-core.js';
