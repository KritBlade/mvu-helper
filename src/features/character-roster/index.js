// features/character-roster — THE ROSTER: the character registry (kept in the chat's state), roster
// discovery in stat_data, the Roster tab, its per-card settings, and the reply cast (who is in each
// reply, from the narrator's cast records — plans/reply-cast.md).
//
// The roster owns the narrator's <reply_cast> block; a feature that reads <cast> records asks for it
// with requestReplyCast. The imagegen surface below is real coupling, stated honestly rather than
// hidden: drawing needs each person's look, the presence scan to anchor char=, the reply cast to ask for
// registrations, and the harvest entry point to store them. onRouteChange lets drawing REACT to a route
// change without this feature importing imagegen back.
export { wireRoster, refreshRosterUI, updateRosterUI } from './roster-ui.js';
export { getRosterProfile, onRouteChange } from './roster-settings.js';
export { rosterProfileDefaults } from './roster-settings-core.js';
export { readCharLook, listCharEntries, listOutfitVariants, listAliases, resolveCharEntry, registerPlaceholderCharDna, characterRegistryJournalTask, resetCharacterRegistryForChat } from './character-registry.js';
export { RESERVED_OUTFIT_NAMES, OUTFIT_NEW_CLOTHES, hasStoredAppearance, lookSourceFor, lookWaitsForReply, lookWaitsForRegistration, wornReportsOf, drawnOneOffClothesOf, nextWornOutfit, WORN_OUTFIT_PART, LAST_PICTURE_MESSAGE, wornOutfitCleaningMission, shownForRegen, pickCharEntry } from './dna-core.js';
export { harvestCastRegistrations, keepFirstClothesFromReply } from './harvest.js';
export { wornOutfitEditJournalTask, resetWornOutfitEditsForChat } from './worn-outfit-edits.js';
export { readCastRecords } from './cast-record-format-core.js';
export { replyCastNames, classifyReplyCast } from './reply-cast-core.js';
export { requestReplyCast, readSceneRoster, informedNamesOfLastPrompt, uncastNamesFor, onFileListForPictureCall } from './reply-cast-prompt.js';
