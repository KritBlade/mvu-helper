// features/streetcleaner — drops mvu-helper's own stale state at the end of every reply (plans/executed/streetcleaner.md).
// The feature that owns a part of mvu-helper's root registers a mission for it; the streetcleaner runs every mission
// last in the end-of-reply pass (own-state), on each saved copy of the reply's state, and logs what each one dropped.
export { registerCleaningMission, streetcleanerTask } from './streetcleaner.js';
