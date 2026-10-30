// card-config/card-config-sections.js — THE REGISTRY. One entry per card-carryable section.
//
// This file is the SPEC, not a lookup table: normalize, serialize, install, merge and the fresh-profile
// check all read it, so a field cannot be card-owned in one pass and user-owned in another. Hardcoding
// `extraLlmCalls` at each of those sites would mean parallel switch statements whose ownership rules
// drift apart — the same duplication P6 removed from the WHEN-DSL.
//
// ADDING A SECTION (a new tab, later) — plans/executed/card-config-sections-plan.md §7.1:
//   1. Decide it is PER-CARD, not per-machine. Global settings get no section at all — imagegen's
//      resolutionPresets / queueConcurrency describe YOUR GPU, and a card shipping them would resize
//      images to fit a stranger's VRAM.
//   2. Place EVERY field in one of the three categories (see card-config-flat-section.js).
//   3. Add one entry below.
// No format change, no version bump, no migration — for this section or any other. That one manual
// entry is a CHECKPOINT, not a limitation: auto-accepting any key that matched a profile key would
// default everything to card-owned, and the first field pointing at a local resource would ship inside
// somebody's card. You can fix the exporter; you cannot recall the copies.
//
// ⚠ DEEP IMPORT, deliberate. This reaches past features/small-llm/index.js because that barrel pulls in
// SillyTavern host modules (script.js / extensions.js), which cannot load under vitest — ending at the
// barrel would make the entire card-config feature untestable. `-core.js` is the feature's PURE half by
// the repo's own filename convention, and a config-section handler must be exactly that.
import {
    normalizeExtraLlmCallsSection,
    serializeExtraLlmCallsSection,
    mergeExtraLlmCallsSection,
} from '../small-llm/extra-llm-calls-core.js';
// Same deliberate DEEP IMPORT, same reason: the statbox and logic-engine barrels import the ST host.
import {
    normalizeStatBoxSection,
    serializeStatBoxSection,
    isStatBoxConfigured,
} from '../statbox/statbox-core.js';
import {
    normalizeLeadTextSection,
    serializeLeadTextSection,
    isLeadTextConfigured,
} from '../logic-engine/turn-runner-core.js';
import { flatSection } from './card-config-flat-section.js';
import { wholeCardOwnedSection } from './card-config-whole-section.js';

// Top-level keys the config format reserves for ITSELF. A section may never be named one of these —
// locked pre-ship (§6.1 #3) so a feature can never collide with the meta channel.
export const RESERVED_CONFIG_KEYS = ['version'];

export const CARD_CONFIG_SECTIONS = [
    {
        // CUSTOM handler: arrays merged by identity (calls by name, groups by tag), which a flat field
        // list cannot express — it has no notion of "which row is the same row". §7.2.
        key: 'extraLlmCalls',
        normalize: normalizeExtraLlmCallsSection,
        serialize: serializeExtraLlmCallsSection,
        install: (current, incoming) => incoming,       // install runs only on a fresh profile
        merge: mergeExtraLlmCallsSection,
        // Its summary shape predates the registry and is reported by the caller in full (it names the
        // calls it restored), so there is nothing generic to say here.
        describe: () => '',
        // "Holds something the card would own" = the profile has calls.
        isConfigured: (v) => (((v && v.calls) || []).length > 0),
        // Every call field is normalized to a value and a call the card drops is kept (it may be the
        // user's own), so no field of this section is ever cleared for being dropped.
        carriedCardOwnedFields: () => [],
        clearCardOwnedField: (current) => current,
    },

    // The imagegen fields the CARD owns: the paths into its own schema and registry, and the <pic> contract
    // it teaches the narrator. The paths and the template ship blank (plans/platform-genre-blindness.md §3.3):
    // a platform default naming one consumer's state tree or outfits would resolve to nothing on every other
    // card. A blank template or regex means the built-in one (default-template.js), so a card that carries
    // none always sends the contract this mvu-helper ships.
    //
    // The seeded fields are the user's preferences: what the card ships is where a new user starts.
    flatSection({
        key: 'imagegen',
        cardOwned: {
            intimacyLatchPath: 'string',     // stat_data dot-path: the bool that is true during an intimate scene
            maincharRegistryKey: 'string',   // registry key of the entry holding the main character's look
            promptTemplate: 'string',        // the <pic> contract text ('' = DEFAULT_PROMPT)
            promptRegex: 'string',           // finds the <pic> tags in a reply ('' = DEFAULT_REGEX)
            promptPosition: 'string',        // the role <scene_roster> is sent as: deep_system | deep_user | deep_assistant
            promptDepth: 'number',           // where <scene_roster> goes, counted back from the end of the prompt
        },
        cardSeeded: {
            insertType: 'string',
            defaultImageType: 'string',
            maxImagesPerReply: 'number',
            maxCharactersPerImage: 'number',
            stripPicTag: 'boolean',
            hBlockAlwaysOn: 'boolean',
            charimgVia: 'string',
        },
        neverTravels: ['sdPromptPrefixPresetId'],       // an id into this machine's own prefix-preset list
        retired: {
            forceImageTypePath: "every image is drawn at the card's Image type now, so there is no latch to set — remove it from the card",
            storyDatePath: 'every picture names what each person wears, so no story day limits what someone wears — remove it from the card',
            defaultOutfits: 'every picture names what each person wears, so no outfit stands in as a default — remove it from the card',
            maleRegistryKey: 'renamed maincharRegistryKey — rename it in the card',
            maxGirlsPerImage: 'renamed maxCharactersPerImage — rename it in the card',
            teachNarrator: 'Image Insert Type decides whether the <pic> contract is sent — remove it from the card',
        },
    }),

    // The roster's settings are all the user's preferences: where a new user starts is the card's call.
    flatSection({
        key: 'roster',
        cardSeeded: {
            route: 'string',            // 'predefined' | 'harvest'
            charCollection: 'string',   // stat_data path of the character collection ('' = found by its presence field)
            presenceField: 'string',    // the per-member field that says who is on screen ('' = Is_present)
        },
        retired: {
            keepHarvestBlocks: 'the harvest leaves no block in the reply to keep — remove it from the card',
        },
    }),

    flatSection({
        key: 'logicEngine',
        cardSeeded: { enabled: 'boolean' },
        retired: {
            resolverHost: 'mvu-helper is the only host that runs the logic engine, so there is no host to pick — remove it from the card',
        },
    }),

    // WHOLE sections: their payload nests arrays, which a flat field list cannot express, and every key is
    // card-owned, so the card's normalized section is taken whole (card-config-whole-section.js); a card that
    // drops one stops its feature. Config this mvu-helper does not recognise is dropped piece by piece in
    // normalize and named in the import's warns (devdoc/statbox-guide.md "When the config is wrong").
    wholeCardOwnedSection({ key: 'statBox', normalize: normalizeStatBoxSection, serialize: serializeStatBoxSection, isConfigured: isStatBoxConfigured }),
    // The opening tags of the card's story block: the engine's lead text goes at the top of the story
    // (devdoc/gamelogic-pack-format.md §4.2).
    wholeCardOwnedSection({ key: 'leadText', normalize: normalizeLeadTextSection, serialize: serializeLeadTextSection, isConfigured: isLeadTextConfigured }),

    // event-pack needs NO section: its whole state is lorebook entries, so a card already ships packs
    // natively (plans/executed/card-config-sections-plan.md §2.5).
];

// Every top-level key the importer understands — meta + sections. Derived, never hand-listed, so a
// section added above is understood by the unknown-key sweep in the same commit.
export const KNOWN_TOP_LEVEL = [...RESERVED_CONFIG_KEYS, ...CARD_CONFIG_SECTIONS.map((s) => s.key)];
