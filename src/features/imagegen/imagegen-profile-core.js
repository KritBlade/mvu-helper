// imagegen/imagegen-profile-core.js — the PURE half of imagegen's per-card settings: the template every card
// profile starts from, and the repair its accessor runs (image-gen.js getImagegenProfile reads the live profile
// and hands it here). Pure, so a test runs the repair against the lobby's frozen copy.

import { INSERT_TYPE } from './prompt-assembly-core.js';

export const IMAGE_TYPES = ['portrait', 'landscape', 'closeup', 'scene', 'square'];

// The id of the built-in /sd prompt-prefix preset (sd-prompt-prefix-presets.js). New cards start on it, so a
// fresh install draws with sane style tags.
export const DEFAULT_SD_PROMPT_PREFIX_PRESET_ID = 'default';

// PER-CARD defaults (PROFILE scope) — merged into profileDefaults by index.js. CARD BEHAVIOR: whether and
// how this card draws, how many images and people, its main character, its latch.
export const imagegenProfileDefaults = {
    imagegen: {
        // Every CARD-OWNED field here (card-config-sections.js) ships BLANK. A value would make every profile
        // look set up (card-config isFreshProfile), and a card opened for the first time would never install.
        //
        // THE <pic> CONTRACT — card-owned, so a card can ship its own in [Initmvuhelper] and a card upgrade
        // refreshes it. BLANK = the built-in one (default-template.js DEFAULT_PROMPT / DEFAULT_REGEX), so a
        // card that carries none always sends the contract this mvu-helper ships.
        promptTemplate: '',
        promptRegex: '',
        // Where <scene_roster> goes. Blank = deep_system at depth 0 (the end of the prompt).
        promptPosition: '',             // deep_system | deep_user | deep_assistant
        promptDepth: '',                // counted back from the end of the prompt (0-100)
        // 'disabled' sends nothing and draws nothing · 'tags' sends the <pic> instruction and logs + disposes
        // of the tags with no GPU · 'inline' | 'new' | 'replace' send it and draw.
        insertType: INSERT_TYPE.DISABLED,
        // Harvest via — which call writes a NEW character's look while the roster route is auto-harvest
        // (llm-task router): '' (Off, default) | 'narrate' | a POST call name (e.g. 'POST2'). Off BY DEFAULT:
        // harvesting writes looks into the chat's character registry, which is unsolicited on a card the user
        // never configured.
        charimgVia: '',
        // Pictures written by — which call writes the reply's <pic> tags (llm-task router, plans/executed/picture-writer-route.md):
        // 'narrate' (the narrator, as it writes the story) | a POST call name (it reads the finished reply). No Off:
        // Insert Type = Disable turns pictures off. The user's own choice for their models: never carried by a card.
        picturesVia: 'narrate',
        // WHICH global /sd prompt-prefix preset this card prepends (the list itself is global —
        // sd-prompt-prefix-presets.js). '' = the "— none —" pick: this card sends no prefix.
        sdPromptPrefixPresetId: DEFAULT_SD_PROMPT_PREFIX_PRESET_ID,
        // CEILING on how many people with a look one image may hold, the main character included — never a
        // quota: one person alone is a normal shot. Each person's look is copied whole into the /sd prompt,
        // so the text encoder's budget is what bounds it (prompt-assembly-core.js); the number is the
        // card's own, with no limit in code.
        maxCharactersPerImage: 3,
        // WHICH registry entry holds the main character's look ({{user}}): an ordinary entry, same
        // [Body]/[Clothes]/[Clothes:variant] format as anyone's. The narrator draws him with mainchar= and
        // never names or registers him. CARD-DECLARED (imagegen.maincharRegistryKey in [Initmvuhelper]) or
        // typed in the panel; blank ⇒ he is drawn from the scene alone.
        maincharRegistryKey: '',
        maxImagesPerReply: 1,      // hard cap per reply (plain-ST default 1; galgame play typically 2-3)
        defaultImageType: 'landscape',  // EVERY image renders at this type's resolution preset; the narrator never picks one
        stripPicTag: true,    // <pic> DISPOSITION, independent of drawing: true = take the tag out of the visible reply, leaving its invisible trace (image-splice-core buildTagTraceWrap: clean display, galgame-safe, and the record of who was drawn in what clothes); false = keep it raw for troubleshooting. Applies whether or not we draw.
        // ⚠ THE LATCH PATH IS CARD-DECLARED AND DEFAULTS TO BLANK. Which field means "intimate scene" is a
        // fact only the card knows; a platform default naming one consumer's state would resolve to nothing
        // on every other card. The card declares it in [Initmvuhelper]; the user can override in the panel.
        //
        // <explicit_rules> gate: the EXPLICIT/H composition guidance rides on this latch, and decideExplicitBlock
        // (prompt-assembly-core.js) owns the whole decision. FOUR states:
        //   checkbox ON        → inject, the latch is not even read
        //   path BLANK         → inject. A card declaring no latch has claimed nothing about its turns, and
        //                        an adult non-MVU card has no stat_data to gate on — blank must work with zero
        //                        setup. The cost: an unconfigured card that draws carries <explicit_rules> on every reply.
        //   path RESOLVES      → inject unless it reads an explicit `false` (a SFW turn drops it)
        //   path UNRESOLVABLE  → WITHHOLD: a configured path is an author asking for a gate, and keeping the
        //                        injection while dropping the gate is the one reading nobody asked for.
        intimacyLatchPath: '',          // dot-path under stat_data; tuple auto-unwrapped; blank = no gate (always ON)
        hBlockAlwaysOn: false,          // escape hatch: always inject <explicit_rules>, skip the latch gate entirely
    },
};

// This card's imagegen block, its present-but-wrong-typed fields repaired (absent ones are backfilled by the
// settings store). On a valid block, the template included, it writes nothing: in the lobby the profile is
// frozen (sillytavern/settings-store-core.js profileRecordFor).
export function imagegenProfileOf(p) {
    const d = imagegenProfileDefaults.imagegen;
    if (!p.imagegen || typeof p.imagegen !== 'object') p.imagegen = structuredClone(d);
    const ig = p.imagegen;
    if (typeof ig.charimgVia !== 'string') ig.charimgVia = d.charimgVia;
    if (typeof ig.picturesVia !== 'string') ig.picturesVia = d.picturesVia;
    if (!Object.values(INSERT_TYPE).includes(ig.insertType)) ig.insertType = d.insertType;
    if (typeof ig.sdPromptPrefixPresetId !== 'string') ig.sdPromptPrefixPresetId = d.sdPromptPrefixPresetId;
    if (!(Number.isInteger(ig.maxCharactersPerImage) && ig.maxCharactersPerImage >= 1)) ig.maxCharactersPerImage = d.maxCharactersPerImage;
    if (typeof ig.maincharRegistryKey !== 'string') ig.maincharRegistryKey = d.maincharRegistryKey;
    if (!Number.isFinite(ig.maxImagesPerReply)) ig.maxImagesPerReply = d.maxImagesPerReply;
    if (!IMAGE_TYPES.includes(ig.defaultImageType)) ig.defaultImageType = d.defaultImageType;
    // stripTagAfterGenerate → stripPicTag rename (2026-07-27): carry any old persisted value across, then drop the stale key.
    if (typeof ig.stripPicTag !== 'boolean') ig.stripPicTag = (typeof ig.stripTagAfterGenerate === 'boolean') ? ig.stripTagAfterGenerate : d.stripPicTag;
    if ('stripTagAfterGenerate' in ig) delete ig.stripTagAfterGenerate;
    if (typeof ig.intimacyLatchPath !== 'string') ig.intimacyLatchPath = d.intimacyLatchPath;
    if (typeof ig.hBlockAlwaysOn !== 'boolean') ig.hBlockAlwaysOn = d.hBlockAlwaysOn;
    if (typeof ig.promptTemplate !== 'string') ig.promptTemplate = d.promptTemplate;
    if (typeof ig.promptRegex !== 'string') ig.promptRegex = d.promptRegex;
    if (typeof ig.promptPosition !== 'string') ig.promptPosition = d.promptPosition;
    if (ig.promptDepth !== '' && !Number.isFinite(ig.promptDepth)) ig.promptDepth = d.promptDepth;
    return ig;
}
