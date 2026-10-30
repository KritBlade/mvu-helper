// artifact-dev-loop/index.js — public barrel (P6). The dev loop watches a local dev server and
// re-applies changed artifacts through the SAME install lanes a library install uses; the lanes
// are registered from src/index.js so this feature imports no sibling feature.
export { devLoopDefaults, registerDevLane, wireArtifactDevLoopUI, devLoopChatChanged, refreshDevLoopStatus } from './artifact-dev-loop.js';
