// features/card-sync — the [InitVar] card→save sync: re-applies the card's OWN [InitVar] to a RUNNING chat, because
// MVU reads it only once per chat — create-only everywhere, plus the re-seed under mvu-helper's own root, where a value
// the chat never changed follows the card (card-sync-core.js names the halves). It reaches every state a new
// generation can seed from, so a regenerate or swipe of the newest reply keeps it.
//
// registerForcePayloadProvider supplies the FORCE half — the only thing [InitVar] and Zod cannot do (overwrite a value
// that is already present and wrong): the pack's literal map, and the paths that take the card's own [InitVar] value.
// It is registered, not imported, so this lane works unchanged on a card with no pack installed (L4).
//
// registerSyncPass lets another feature ride the same entry fetch, the same state and the same write, without this
// lane importing that feature (event packs, GameLogic Packs and Plugins do).
// isRetryableSkip / getLastCompletedSync exist so the initial-load kick can grade its own give-up: which skips are
// worth another attempt, and whether ANY sync has completed by some other path.
// seedPassSummary turns one sync's report into the sentence Re-import from card shows. readCardSeed, SEED_FINGERPRINTS_PART
// and differsFromSeedPrints let the Roster tab tell a seeded character the chat changed, and put the card's record back.
// syncCardDataWithRetry is what the CHAT_CHANGED / mag_variable_initialized hooks call: a NOT-READY verdict schedules
// its own next attempt, so a chat that lost the race to a slow MVU still gets its sync.
export { syncCardData, syncCardDataWithRetry, registerSyncPass, registerForcePayloadProvider, isRetryableSkip, getLastCompletedSync, getSyncWatermark, readCardSeed } from './card-sync.js';
export { SYNC_RETRY_MAX_ATTEMPTS, SYNC_RETRY_DELAY_MS, seedPassSummary, SEED_FINGERPRINTS_PART, differsFromSeedPrints } from './card-sync-core.js';
