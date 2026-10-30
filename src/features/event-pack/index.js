// features/event-pack — the community [MVU_Event_Pack] install lane: the Event Packs tab plus the
// reconciler that merges installed packs into a chat's stat_data.EventPack.
//
// scanEventPacks is exported for the composition root to hand to card-sync's registerSyncPass —
// event-pack owns the logic, card-sync owns the write.
export { wireEventPackTab, refreshEventPackUI } from './event-pack-ui.js';
export { scanEventPacks } from './event-pack-sync-pass.js';
// The before-generation half of the same reconcile: the chat-load pass writes to ONE message, and a
// regenerate or delete-then-send seeds the reply from a floor that predates the install. Registered
// on GENERATION_STARTED beside the plugin drawer ensure, which exists for the identical reason.
export { ensureEventPackRowsOnGenerationFloor } from './event-pack-sync-pass.js';
// Same-round body delivery: the PRE→narrate seam (small-llm interceptor) pulls the
// @key-gated DO body from a body entry (official event_schedule OR a community pack's prose half).
export { findArmedBody } from './event-pack-core.js';
// FIRE_INTENT is the pack FORMAT's commit channel (see its header) — exported so the one instruction
// that tells a narrator to emit it is spelled from the same constant the format defines, rather than
// carrying a second literal that can drift.
export { FIRE_INTENT } from './event-pack-core.js';
// The install lane WITHOUT the tab: what the artifact dev loop registers so a developer's save runs
// the same install a person's paste runs. The dev loop learns nothing about the
// event-pack format — it hands over an artifact's events/ texts and reads back the standard verdict.
export { installEventPackArtifact, storeEventPacksInLibrary, eventPackIdsIn, eventPacksOnCard, eventPackArtifactTexts } from './event-pack-install.js';
// This lane's half of the all-artifact report (features/pack-info): what is in the library, what is
// on this card, and whether the four event-pack stores agree. Richer than a registry read, because
// an event pack's rows and fired state live in the chat, not in its registry record.
export { eventPackInfo } from './event-pack-info.js';
// The registry entry's comment and its parser, for the pack-info lane's ONE table of registry
// readers. Event-pack's registry comment is its own, not the shared [<Prefix>:Registry] convention.
export { REGISTRY_COMMENT, parseRegistry } from './event-pack-core.js';
