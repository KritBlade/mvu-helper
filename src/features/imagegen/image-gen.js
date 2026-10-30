// imagegen/image-gen.js — the image auto-generation feature: the <pic> contract in the narrator's
// prompt, streaming pre-generation, the MESSAGE_RECEIVED draw pass, the REPLACE-mode regenerate button,
// and the look task (who describes a character's look, routed by the LLM-task router).
//
// Settings scope:
//   GLOBAL  (getGlobal())            — machine/app: queue concurrency (GPU), resolution presets (VRAM),
//                                       streaming, the bust LoRA, the /sd prompt-prefix list.
//   PER-CARD (getImagegenProfile())  — card behavior: the <pic> contract (promptTemplate, promptRegex,
//                                       promptPosition, promptDepth), insertType, maxImagesPerReply,
//                                       maxCharactersPerImage, maincharRegistryKey, defaultImageType,
//                                       stripPicTag, charimgVia, the intimacy latch.
//   The roster settings (route, charCollection, presenceField) belong to the roster feature
//   (character-roster/roster-settings.js, profile.roster.*).
// What the settings make the pipeline do is decided in one pure place, imageDuties (prompt-assembly-core).
// Image generation and harvest are independent: Insert Type owns the <pic> instruction and the drawing;
// the roster's route and Harvest via own whether looks are stored.
//
// Each drawn person's look is their stored look, else the look their <cast> record in the same reply gives
// them, else nothing — they are then drawn from the scene alone, and the log names them.

import { extension_settings, getContext } from '../../../../../../extensions.js';
import {
    eventSource,
    event_types,
    appendMediaToMessage,
} from '../../../../../../../script.js';
import { regexFromString } from '../../../../../../utils.js';
import { SlashCommandParser } from '../../../../../../slash-commands/SlashCommandParser.js';
import { escapeHtmlAttribute, unescapeHtmlAttribute } from '../../shared/html-escape.js';
import { EXTENSION_NAMESPACE } from '../../sillytavern/extension-paths.js';
import { getGlobal, getProfile, saveSettingsDebounced } from '../../sillytavern/settings-store.js';
import { getMvu, latestMsgId, toast } from '../../sillytavern/mvu-bridge.js';
import { stateBefore, ownStatPart, setOwnStatPart, storedStatDataOf } from '../../sillytavern/mvu-bridge-core.js';
import { swipeOf } from '../../shared/latest-reply.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { expandPromptMacros } from '../../sillytavern/prompt-macros.js';
import { breakTemplateOpeners } from '../../shared/rendered-region.js';
import { DEFAULT_PROMPT, MAINCHAR_NOT_IN_PICTURE, castRecordAsks, narratorPictureRules, readerPictureContract, readerPictureInput, pictureCountRules, narrateRegistrationContract, readerRegistrationContract, DEFAULT_REGEX, tagAttr } from './default-template.js';
import {
    INSERT_TYPE, HISTORY_PICTURES, NARRATOR_TAG_ACTION, imageDuties, isPictureWriterOffered, isHarvestTargetOffered, placeNarratorPictureParts, picSlots, maincharOf, fitPeopleToCeiling, bustValueFor, composeImagePrompt, sceneRosterText,
    validateCharSlots, decideExplicitBlock, classifyDeclaredPathRead, declaredPathWarning, oneOffNamesOf, drawnPeopleOf,
    resolveStatPath, maincharNamedButNotDrawn, cameraOf, withCamera, isLastPictureOf, withoutMacroBraces,
} from './prompt-assembly-core.js';
import { imagegenProfileOf } from './imagegen-profile-core.js';
import { spliceTagIntoMessage, buildRenderedImageWrap, revertRenderedImagesToPicTags, removeTagsPinpoint, replaceTagsWithTraces, disposeLeftoverPicTags, partitionDetectedTags, partitionByReasoning, planImageSrcSwap, auditRenderedImages, recordsAfterImageSwap } from './image-splice-core.js';
import { numberReplyLines, placePictures, oneOffClothesRecords } from './picture-placement-core.js';
import { redrawReply, saveRedrawnReply, announceReplyEdit } from '../reply-redraw/index.js';
import {
    getRosterProfile, onRouteChange, readSceneRoster, requestReplyCast, informedNamesOfLastPrompt, uncastNamesFor, onFileListForPictureCall,
    readCharLook, listCharEntries, listOutfitVariants, listAliases, resolveCharEntry,
    RESERVED_OUTFIT_NAMES, hasStoredAppearance, lookSourceFor, lookWaitsForReply, lookWaitsForRegistration,
    harvestCastRegistrations, keepFirstClothesFromReply, registerPlaceholderCharDna, readCastRecords, replyCastNames, classifyReplyCast,
    OUTFIT_NEW_CLOTHES, wornReportsOf, drawnOneOffClothesOf, nextWornOutfit, WORN_OUTFIT_PART, LAST_PICTURE_MESSAGE, shownForRegen, pickCharEntry,
} from '../character-roster/index.js';
import { registerLlmTask, applyTaskRouting, initLlmTaskRouter, isTaskTargetAvailable } from '../llm-task-router/index.js';
import {
    sdPromptPrefixDefaults, findSdPromptPrefixPreset,
} from './sd-prompt-prefix-presets.js';

const log = createModuleLog('imagegen');

// GLOBAL image-gen defaults — merged at the settings root by index.js.
// These are MACHINE / APP-level: GPU concurrency, VRAM-bound resolution presets, streaming, the /sd
// workflow's bust LoRA. They're the same for every card, so they stay global.
export const imageDefaults = {
    ...sdPromptPrefixDefaults,     // sdPromptPrefixPresets: the NAMED style/quality prefix list prepended to EVERY /sd prompt (before composition + looks); separate from ST's own SD prompt-prefix. The list is global; WHICH preset a card uses is per-card (imagegen.sdPromptPrefixPresetId). See sd-prompt-prefix-presets.js.
    // Bust multiplier — MACHINE-level because it describes YOUR /sd workflow, not a card: the backend
    // loads a bust LoRA whose strength reads a custom placeholder. ON by default: the cost on a workflow
    // that ignores the variable is one chat-variable write per image, so the safe-by-default reading is
    // the one where a configured LoRA receives its value. `variableName` is the ST chat variable we /setvar
    // (the workflow's placeholder maps it, e.g. `bust_strength` → `{{getvar::bust_strength}}`).
    bustStrength: {
        enabled: true,
        variableName: 'bust_strength',
        defaultValue: 1,      // nobody in the picture declares [Bust] — neutral, changes nothing
        sharedValue: 1.5,     // two or more declare one: the LoRA is one model-wide strength, so one shared middle value covers them all
    },
    streamingPregen: true,         // start generating the moment a complete tag appears mid-stream
    queueConcurrency: 1,           // serialize /sd calls (ComfyUI stability); 1-4 — a property of YOUR GPU
    resolutionPresets: {           // image type → width/height — ~1MP SDXL/Qwen-native (VRAM-bound; edit per your GPU)
        portrait: { width: 768, height: 1152 },
        landscape: { width: 1152, height: 768 },
        closeup: { width: 768, height: 960 },
        scene: { width: 1152, height: 672 },
        square: { width: 1024, height: 1024 },
    },
};

// This card's imagegen settings (imagegen-profile-core.js imagegenProfileOf).
export function getImagegenProfile() {
    return imagegenProfileOf(getProfile());
}

// `promptInjection` at the settings root is the one shared <pic> contract copy older versions saved for every
// card, frozen at whatever DEFAULT_PROMPT was the day it was saved. Each card has its own now (the
// promptTemplate fields above) and nothing reads the shared copy, so it is deleted on load. Its text is
// printed when it differed from the built-in one, so nothing is lost silently.
export function deleteGlobalPromptInjection() {
    const root = getGlobal();
    if (root.promptInjection === undefined) return;
    const old = root.promptInjection;
    delete root.promptInjection;
    saveSettingsDebounced();
    const wasEdited = !!old && typeof old === 'object' && ((old.prompt && old.prompt !== DEFAULT_PROMPT) || (old.regex && old.regex !== DEFAULT_REGEX));
    if (!wasEdited) {
        log.lifecycle('deleted the global Prompt Template / Regex copy: each card now sends its own, or the built-in one');
        return;
    }
    log.warn('deleted the global Prompt Template / Regex copy, which differed from the built-in one. Each card now sends '
        + 'its own (Image tab, or the card\'s [Initmvuhelper]) or the built-in one. The deleted copy:', old);
    toast('info', 'The image Prompt Template is per card now. The old shared copy was removed; its text is in the console.');
}

// What this card's settings make the pipeline do right now (prompt-assembly-core imageDuties).
function currentDuties() {
    const prof = getImagegenProfile();
    return imageDuties({ insertType: prof.insertType, route: getRosterProfile().route, via: prof.charimgVia, picturesVia: prof.picturesVia });
}

// ── declared-path breakage detector ──────────────────────────────────────────
// EVERY card-declared stat_data path shares one failure: the path is not in the card's state — a root
// renamed while the card's [Initmvuhelper] kept the old path, or a path typed in the panel — and the
// read silently returns undefined, so the feature just quietly stops working. A declared latch path
// went unnoticed through a full state-root split for exactly this reason.
//
// So the detector is generic and lives at the READ, not at either feature: any future declared path
// gets it by calling readDeclaredFlag instead of readStatFlag. A read that found NO state at all
// (MVU not started, no chat) is not the path's fault and is worded as such; which reads warn is
// decided in declaredPathWarning (prompt-assembly-core, tested). `dryRun` marks a practice build
// nobody sends. Deduped per kind+subject+path because these read once per generated image — a warn
// that repeats every image is noise — and per KIND so a no-state warn never uses up the path-missing one.
const declaredPathWarned = new Set();
function readDeclaredFlag(path, subject, consequence, { dryRun = false } = {}) {
    const { value, hasState } = readStatFlag(path);
    const read = classifyDeclaredPathRead({ path, value, hasState });
    const warning = declaredPathWarning({ read, dryRun });
    const dedupeKey = `${warning}|${subject}|${path}`;
    if (warning && !declaredPathWarned.has(dedupeKey)) {
        declaredPathWarned.add(dedupeKey);
        if (warning === 'path-missing') {
            log.warn(`${subject} "${path}" does not resolve in stat_data — ${consequence}. `
                + "Fix the path in the imagegen settings, or click \"Re-import from card\" to re-pull it "
                + 'from the card config; a stale path survives a state-root rename silently.');
        } else {
            log.warn(`${subject} "${path}" could not be read — no game state is loaded (MVU not started, `
                + `no chat open, or no message holds stat_data), so ${consequence} for this reply. The path itself was not checked.`);
        }
    }
    return { value, hasState };
}

// Read a boolean-ish stat_data flag at `path` (the intimacy latch, …).
// Returns { value, hasState }: `value` is the resolved value (a #tuple is auto-unwrapped) or undefined;
// `hasState` says whether any stat_data was found to read it from — false for a non-MVU card, MVU not
// started yet, no chat, no populated floor, a blank path, or a failed read. Each caller applies its
// OWN fallback semantics to undefined (<explicit_rules> withholds — see decideExplicitBlock).
function readStatFlag(path) {
    const none = { value: undefined, hasState: false };
    if (!String(path || '').trim()) return none;   // blank path = no flag
    try {
        const Mvu = getMvu();
        const top = latestMsgId();
        if (!Mvu || typeof Mvu.getMvuData !== 'function' || top < 0) return none;
        // Scan back to the newest floor that actually HOLDS stat_data. With streaming pre-generation
        // the brand-new reply message at latestMsgId() has no stat_data yet (RES writes it AFTER the
        // draw), so reading it blindly returns undefined — the latch, carried on the prior floor, is
        // missed and (e.g.) the intimacy latch never fires. Fall back to the newest populated floor.
        for (let id = top, seen = 0; id >= 0 && seen < 30; id--, seen++) {
            const data = Mvu.getMvuData({ type: 'message', message_id: id });
            const sd = data && data.stat_data;
            if (sd && typeof sd === 'object') return { value: resolveStatPath(sd, path), hasState: true };
        }
        return none;
    } catch (e) {
        log.child('readStatFlag').warn(`could not read stat flag (path=${path}):`, e);
        return none;
    }
}

// The /sd prompt-prefix preset THIS card draws with, or null for the "— none —" pick. A non-empty id
// that resolves to nothing means the settings were hand-edited (delete detaches every card that used
// a preset), so it's a real misconfiguration: warn instead of silently drawing without style tags.
export function getActiveSdPromptPrefixPreset() {
    const id = getImagegenProfile().sdPromptPrefixPresetId;
    if (!id) return null;
    const preset = findSdPromptPrefixPreset(id);
    if (!preset) log.warn(`this card points at /sd prompt-prefix preset "${id}", which no longer exists — drawing with NO prefix. Pick one on the Image tab.`);
    return preset;
}

// ── prompt assembly: composition + each drawn person's look ──────────────────
// The <cast> records of reply `mesId` as it reads now ([] when it is gone, or mid-stream before the records
// are written). Each drawn person's look may come from them.
function replyCastRecordsOf(mesId) {
    const message = getContext().chat[mesId];
    return message ? readCastRecords(String(message.mes || '')).records : [];
}

// ── what each character wears now: the worn-outfit store ─────────────────────
// What each drawn character wears is kept in the card's state, under mvu-helper's own root:
// stat_data.$mvuhelper.worn_outfit (character-roster nextWornOutfit). MVU stores the state with every message and
// swipe, so a swipe, a regenerate, a deleted reply and a reload are right by construction, and no reply text is
// read back as a record. A picture that names "same-as-last-picture", or slips, is drawn in what the store says she
// wears.
//
// WORKED OUT ONCE PER REPLY, AND WRITTEN INTO EVERY COPY OF ITS STATE THAT IS SAVED. The value is the state before
// the reply, carried through the reply's own pictures (wornOutfitAfterReply). wornOutfitWriteTask writes it, as a task
// of mvu-helper's end-of-reply pass (own-state): on MVU's save and on a turn engine's staged copy, before the
// streetcleaner sweeps the store. It writes only while pictures are drawn; a reply written with pictures off keeps the
// store it started from.
const wornOutfitAfterReplies = new WeakMap();   // reply message → { swipe, mes, value }: the store it leaves

// What each person `tags` — <pic> tags of reply `mesId`, in text order — draw is drawn in, by the reply's own records
// (character-roster wornReportsOf): the store's reports, and what the harvest saves for a one-off (D40).
async function wornReportsThrough(mesId, tags) {
    const maincharKey = String(getImagegenProfile().maincharRegistryKey || '').trim();
    return wornReportsOf(drawnPeopleOf(tags, maincharKey), replyCastRecordsOf(mesId), await listCharEntries());
}

// The store after `tags` — <pic> tags of reply `mesId`, in text order — starting from the state before the reply:
// what each person they draw now wears, keyed by registry entry, each one drawn stamped with the reply's message
// (character-roster nextWornOutfit).
async function wornOutfitThrough(mesId, tags) {
    const before = stateBefore(getContext().chat, mesId);
    const previous = before ? ownStatPart(before.statData, WORN_OUTFIT_PART) : undefined;
    if (!tags.length) return nextWornOutfit(previous, { replyIndex: mesId });
    return nextWornOutfit(previous, { reports: await wornReportsThrough(mesId, tags), replyIndex: mesId });
}

// The store tag `rawTag` of reply `mesId` is drawn from: the state before the reply, through the reply's pictures
// ahead of the tag. The reply's text keeps every tag, rendered or as a trace (replyTextWithPicTags).
function wornOutfitBefore(mesId, rawTag) {
    const tags = allTagStrings(replyTextWithPicTags(mesId));
    const at = tags.indexOf(rawTag);
    return wornOutfitThrough(mesId, at > 0 ? tags.slice(0, at) : []);
}

// The store reply `mesId` leaves, through all of its pictures — worked out once per swipe and text, so MVU's save
// and the engine's staged state are handed the same value, and a continue works it out again.
function wornOutfitAfterReply(mesId) {
    const chat = getContext().chat;
    const message = chat[mesId];
    const swipe = swipeOf(chat, mesId);
    const mes = String(message.mes || '');
    const known = wornOutfitAfterReplies.get(message);
    if (known && known.swipe === swipe && known.mes === mes) return known.value;
    const value = wornOutfitThrough(mesId, allTagStrings(replyTextWithPicTags(mesId)));
    wornOutfitAfterReplies.set(message, { swipe, mes, value });
    return value;
}

// The store as one log line: who wears what, and the message of her last picture.
function describeWornOutfit(worn) {
    const entries = Object.entries(worn || {});
    if (!entries.length) return '(nobody)';
    const stampOf = (w) => (Number.isInteger(w[LAST_PICTURE_MESSAGE]) ? `last picture msg ${w[LAST_PICTURE_MESSAGE]}` : 'no stamp');
    return entries.map(([key, w]) => `${key} ${w.outfit === OUTFIT_NEW_CLOTHES ? `one-off "${w.clothes}"` : w.outfit} (${stampOf(w)})`).join(', ');
}

// The store's write — a task of mvu-helper's end-of-reply pass (own-state registerOwnStateTask, src/index.js), run on
// every copy of the reply's state that is saved. The pass itself names a store the card's schema dropped.
export const wornOutfitWriteTask = {
    name: 'worn-outfit store',
    async run(statData, { mid, isEngineCopy }) {
        if (!currentDuties().draws) return;
        const worn = await wornOutfitAfterReply(mid);
        setOwnStatPart(statData, WORN_OUTFIT_PART, worn);
        log.domain('imagegen', 'verbose', isEngineCopy
            ? `msg ${mid}: ${WORN_OUTFIT_PART} written into the engine's state before it saves`
            : `msg ${mid}: ${WORN_OUTFIT_PART} → ${describeWornOutfit(worn)}`);
    },
};

// The regen's saved entries (D39, plans/reply-cast.md §11.3): a function of a person's entry key giving what the
// worn-outfit store saved with reply `mesId` holds for her, when tag `rawTag` is her last picture in the reply and the
// entry is stamped with it (shownForRegen, isLastPictureOf); null otherwise.
async function shownInReplyFor(mesId, rawTag) {
    const saved = ownStatPart(storedStatDataOf(getContext().chat[mesId]), WORN_OUTFIT_PART);
    const tags = allTagStrings(replyTextWithPicTags(mesId));
    const maincharKey = String(getImagegenProfile().maincharRegistryKey || '').trim();
    const entries = await listCharEntries();
    const keyOf = (name) => { const { entry } = pickCharEntry(entries, name); return (entry ? entry.key : String(name || '')).toLowerCase(); };
    return (key) => {
        const wanted = String(key || '').toLowerCase();
        const isLastPicture = isLastPictureOf(tags, rawTag, (name) => keyOf(name) === wanted, maincharKey);
        return shownForRegen(saved, key, { replyIndex: mesId, isLastPicture });
    };
}

// Who a <pic> draws and each one's look: its slots in order, plus the main character when the tag's
// mainchar= draws him (maincharOf), cut to the card's ceiling (fitPeopleToCeiling). `replyRecords` are the <cast> records
// of the reply the tag belongs to; `worn` the worn-outfit store as the tag sees it (wornOutfitBefore); `shownFor`, on a
// regen only, the reply's saved entries (shownInReplyFor). Returns { people, mainchar, hasEveryoneALook }: `people`
// holds every slot, each with `source` ('stored' | 'reply' | 'none'); `mainchar` is null when he is not drawn.
async function resolveDrawnPeople(rawTag, replyRecords, worn, shownFor) {
    const prof = getImagegenProfile();
    const fit = fitPeopleToCeiling({ slots: picSlots(rawTag), mainchar: maincharOf(rawTag), ceiling: prof.maxCharactersPerImage });
    if (fit.repeated.length) log.warn(`<pic> names ${fit.repeated.map((n) => `"${n}"`).join(', ')} in two slots — drawing each once`);
    if (fit.dropped.length) {
        log.warn(`<pic> draws more people than this card allows (${prof.maxCharactersPerImage}, "Max characters per image" on the Image tab) — `
            + `left out: ${fit.dropped.map((n) => (n === 'mainchar' ? 'the main character' : `"${n}"`)).join(', ')}; anyone the composition still describes is drawn from the scene alone`);
    }
    const people = [];
    for (const slot of fit.slots) {
        const look = await readCharLook(slot.key, slot.outfit, { replyRecords, worn, shownFor });
        people.push({ name: slot.key, outfit: slot.outfit, ...look });
    }
    let mainchar = null;
    if (fit.mainchar.drawn) {
        const key = String(prof.maincharRegistryKey || '').trim();
        // He never has a <cast> record, so only his entry can give him a look — and the store the outfit he
        // last wore. Blank key ⇒ the card has none.
        const look = key ? await readCharLook(key, fit.mainchar.outfit, { worn, shownFor }) : { source: 'none', key: '', body: '', clothes: '', clothesSource: '', wornEntry: null, bust: null };
        mainchar = { name: key, outfit: fit.mainchar.outfit, ...look };
    }
    const hasEveryoneALook = people.every((p) => p.source !== 'none') && (!mainchar || mainchar.source !== 'none');
    return { people, mainchar, hasEveryoneALook };
}

// The exact /sd prompt for one tag. A person with no look anywhere is drawn from the scene alone, and
// said so: that is the one way a picture of a named character comes out as a stranger.
async function assemblePrompt(rawTag, composition, replyRecords, worn, shownFor) {
    // User prefix — the card's chosen preset from the GLOBAL list — prepended to every /sd prompt.
    const prefix = getActiveSdPromptPrefixPreset()?.text || '';
    const drawn = await resolveDrawnPeople(rawTag, replyRecords, worn, shownFor);
    for (const person of drawn.people) {
        if (person.source === 'none') log.warn(`"${person.name}" has no look on file and none in this reply's <cast> record — drawn from the scene alone`);
    }
    if (drawn.mainchar && drawn.mainchar.source === 'none') {
        if (drawn.mainchar.name) log.warn(`the main character's entry "${drawn.mainchar.name}" holds no look — drawn from the scene alone`);
        else log.domain('imagegen', 'verbose', 'the main character is in the shot, but this card names no main-character entry — drawn from the scene alone');
    }
    // The cleanup runs only when everyone in the shot has a look; otherwise the composition may be
    // someone's only description. Each tag it drops is named, so a repeat offender is visible.
    const onRemoved = (removed) => log.warn(`dropped ${removed.length} appearance word(s) the narrator `
        + `wrote into the composition — each person's look already states these and the copy fights it: `
        + `${removed.map((r) => `"${r.tag}" (${r.why})`).join(', ')}`);
    const prompt = composeImagePrompt({
        prefix,
        composition,
        people: drawn.people.filter((p) => p.source !== 'none'),
        mainchar: drawn.mainchar && drawn.mainchar.source !== 'none' ? drawn.mainchar : null,
        cleanup: drawn.hasEveryoneALook,
        onRemoved,
    });
    return { prompt, drawn };
}

// The /sd prompt for tag `rawTag` of reply `mesId`: that reply's <cast> records and the worn-outfit store as the tag
// sees it, with the camera its camera= names added to the composition (withCamera); a regen also hands `shownFor`, the
// reply's saved entries (shownInReplyFor, D39), which a first draw never has. Returns { prompt, drawn, camera,
// mainchar }: `camera` is cameraOf's answer plus `wasAdded` — false when the composition already said those words, so
// nothing was added; `mainchar` is maincharOf's answer, what the tag wrote. Every <pic> carries mainchar=: a missing
// one is warned and draws nobody, and a composition that names the main character on a tag whose mainchar= draws
// nobody is warned (maincharNamedButNotDrawn) and drawn as written: his mainchar= is the narrator's to write. A missing
// or unknown camera= is warned the same way, and the picture keeps whatever camera words the composition has.
async function assembleForReply(mesId, rawTag, composition, { shownFor = null } = {}) {
    const mainchar = maincharOf(rawTag);
    if (mainchar.problem === 'missing') {
        log.warn(`msg ${mesId}: the <pic> names no mainchar= — the main character is not drawn, and anyone its count tag counts for him gets no look`);
    }
    const named = maincharNamedButNotDrawn(rawTag, composition, [getContext().name1, getImagegenProfile().maincharRegistryKey]);
    if (named) {
        log.warn(`msg ${mesId}: the composition names the main character ("${named}") outside a pov shot, but the <pic> `
            + `${mainchar.problem === 'missing' ? 'has no mainchar=' : `says mainchar="${MAINCHAR_NOT_IN_PICTURE}"`} — his look is not attached, `
            + 'so the image model builds his body from the looks it was given');
    }
    const camera = cameraOf(rawTag);
    if (camera.problem === 'missing') log.warn(`msg ${mesId}: the <pic> names no camera= — drawn with whatever camera words its composition has`);
    else if (camera.problem === 'unknown') log.warn(`msg ${mesId}: the <pic> names camera="${camera.value}", which is not one of the choices <camera> lists — drawn with whatever camera words its composition has`);
    if (camera.value === 'pov' && mainchar.drawn) {
        log.warn(`msg ${mesId}: a pov shot names an outfit in mainchar= — the camera is the main character's eyes, yet his look is attached to the picture`);
    }
    const scene = withCamera(composition, camera.words);
    const worn = await wornOutfitBefore(mesId, rawTag);
    const assembled = await assemblePrompt(rawTag, scene, replyCastRecordsOf(mesId), worn, shownFor);
    return { ...assembled, camera: { ...camera, wasAdded: scene !== withCamera(composition, '') }, mainchar };
}

// The bust value for one picture (bustValueFor): only people whose entry declares [Bust] count.
function resolveBustStrength(drawn) {
    const settings = getGlobal().bustStrength || imageDefaults.bustStrength;
    return bustValueFor([...drawn.people, ...(drawn.mainchar ? [drawn.mainchar] : [])], settings);
}

// Hand the multiplier to the /sd backend through a ST chat variable, which the ComfyUI workflow
// reads via a custom placeholder (`bust_strength` → `{{getvar::bust_strength}}` → a typed FLOAT
// input on a LoraLoader node; a raw rgthree widget will NOT work — it takes no typed input, so
// ComfyUI never coerces the string and the LoRA silently no-ops). Set PER JOB immediately before
// the call, never once per reply: streaming pre-generation queues jobs, so a value written when
// the tag was detected would be stale by the time that job runs.
async function applyBustStrength(value) {
    if (value === null) return;
    const name = String((getGlobal().bustStrength || imageDefaults.bustStrength).variableName || '').trim();
    if (!name) { log.warn('bust strength is enabled but its variable name is blank — skipping'); return; }
    try {
        const ctx = getContext();
        await ctx.executeSlashCommandsWithOptions(`/setvar key=${name} ${value}`, { handleExecutionErrors: true });
    } catch (e) {
        log.warn(`could not set the bust-strength variable (${name}=${value}) — this image renders at whatever value the workflow already held:`, e);
    }
}

// The card's image type → {width, height} from the configured presets. Every image renders at the
// card's defaultImageType; a type= the narrator writes on a <pic> is ignored, so every picture on a
// card (and every galgame backdrop) shares one aspect.
function resolveResolution() {
    const presets = getGlobal().resolutionPresets || imageDefaults.resolutionPresets;
    const type = getImagegenProfile().defaultImageType;
    const dims = presets[type] || imageDefaults.resolutionPresets[type];
    return { type, width: dims.width, height: dims.height };
}

// ── the /sd queue ─────────────────────────────────────────────────────────────
// Serializes ComfyUI calls. jobs: { key, mesId, prompt, rawTag, quiet, resolve }, plus fullPrompt once they run.
// tracker dedupes streaming pre-gen vs the final MESSAGE_RECEIVED pass: the first
// path to see a tag creates the job; the second awaits the same promise.
const genQueue = [];
const genTracker = new Map();   // key → { promise: Promise<imageUrl|null>, job } — job shared so a JOINER also sees fullPrompt
// Keys whose job resolved NULL this stream. THIRD pre-gen guard, and it exists because the other two
// deliberately let go of the key on failure: genTracker EVICTS it (see NEVER CACHE A FAILURE below) and
// maybePregen has already dropped it from pregenChecking, handing dedup to the tracker. So a failure empties
// BOTH — and STREAM_TOKEN_RECEIVED, which rescans every token, re-enqueues the same tag on the very next one.
// With a backend that fails FAST (ComfyUI down → ECONNREFUSED in ~1 ms) that is an unbounded re-fire loop for
// the rest of the stream: dozens of /sd calls and one error toast each. Invisible while the backend works,
// because a SUCCESS stays in the tracker and dedupes.
// This set is pre-gen ONLY: the final MESSAGE_RECEIVED pass never consults it, so every tag still gets its
// one final-pass retry, and a later generation can retry it too.
const pregenFailedThisStream = new Set();
let genRunning = 0;

function jobKey(mesId, rawTag, prompt) {
    // Everyone drawn, with what they wear, and the camera are part of the identity: two beats can share a
    // composition and a left-hand person while pairing them with someone else, in other clothes, or from another
    // angle, and those are not the same image.
    const people = picSlots(rawTag).map((slot) => `${slot.key}[${slot.outfit}]`).join('+');
    const mainchar = maincharOf(rawTag);
    return `${mesId}::${people}::${mainchar.drawn ? `mainchar[${mainchar.outfit}]` : ''}::camera[${cameraOf(rawTag).value}]::${String(prompt).replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

function processQueue() {
    const s = getGlobal();
    const max = Math.max(1, Math.min(4, parseInt(s.queueConcurrency) || 1));
    while (genRunning < max && genQueue.length > 0) {
        const job = genQueue.shift();
        genRunning++;
        runGeneration(job).finally(() => {
            genRunning = Math.max(0, genRunning - 1);
            processQueue();
        });
    }
}

// The picture log line, one for every picture sent to /sd: `gen` for a first draw, `regen` for the regenerate button.
// Full, untruncated — the composition the narrator wrote vs. the exact string sent to /sd, so you can verify what was
// added. `prefix=` names the /sd prompt-prefix preset whose text heads the sent string (`none` = the card picked
// "— none —", `MISSING:<id>` = a dangling id). `drawn=` is who was actually RESOLVED, in slot order, each as
// [outfit|body <from>|clothes <from>]: the outfit= the tag wrote ("left out" = none written), where their body and
// where their clothes came from (stored · reply · carried from the worn-outfit store as the picture sees it · saved,
// on a regen, in the store saved with the reply — each of the last two with the outfit or "one-off" and the message
// of her last picture; clothes none = no clothes described), which differ when a stored look wears a one-off, or
// [outfit|NO LOOK] — not what the tag asked for, so a dropped or repeated slot is visible here. `mainchar=` is the main
// character the same way when drawn; otherwise what the tag wrote: "not-in-picture", "none written" (warned), or
// "dropped" when the card's ceiling left him out (warned). `camera=` is the camera= the tag wrote and what became of
// it: "added" (its words now close the composition), "already in the composition" (the narrator wrote them itself),
// "none written" or "not a choice" (warned). `bust=` is the multiplier actually sent (`off` = the feature is
// disabled, so the workflow keeps its own).
function logDrawnPicture(kind, { resolution, drawn, camera, mainchar, bust, composition, sentPrompt }) {
    const prefixId = getImagegenProfile().sdPromptPrefixPresetId;
    const prefixLabel = prefixId ? (findSdPromptPrefixPreset(prefixId)?.name || `MISSING:${prefixId}`) : 'none';
    const clothesLabel = (person) => {
        if ((person.clothesSource === 'carried' || person.clothesSource === 'saved') && person.wornEntry) {
            const stamp = person.wornEntry.lastPictureMessage;
            return `clothes ${person.clothesSource} (${person.wornEntry.outfit || 'one-off'}${Number.isInteger(stamp) ? `, last picture msg ${stamp}` : ''})`;
        }
        return `clothes ${person.clothesSource || 'none'}`;
    };
    const lookLabel = (person) => (person.source === 'none' ? 'NO LOOK' : `body ${person.source}|${clothesLabel(person)}`);
    const drawnLabel = drawn.people.length
        ? drawn.people.map((p, i) => `${i + 1}:"${p.name}"[${p.outfit || 'left out'}|${lookLabel(p)}]`).join(' ')
        : 'scenery (no char=)';
    const maincharLabel = mainchar.problem === 'missing' ? 'none written'
        : !mainchar.drawn ? MAINCHAR_NOT_IN_PICTURE
            : !drawn.mainchar ? 'dropped (over the ceiling)'
                : `${drawn.mainchar.name ? `"${drawn.mainchar.name}"` : '(no entry named)'}[${drawn.mainchar.outfit || 'left out'}|${lookLabel(drawn.mainchar)}]`;
    const cameraLabel = camera.problem === 'missing' ? 'none written'
        : camera.problem === 'unknown' ? `"${camera.value}" (not a choice)`
            : `${camera.value} (${camera.wasAdded ? `"${camera.words}" added` : 'already in the composition'})`;
    const { type, width, height } = resolution;
    log.domain('imagegen', 'verbose',
        `${kind} [${type} ${width}x${height}] drawn=${drawnLabel} mainchar=${maincharLabel} camera=${cameraLabel} prefix="${prefixLabel}" bust=${bust === null ? 'off' : bust}\n` +
        `  composition: ${composition}\n` +
        `  → sent to /sd: ${sentPrompt}`);
}

async function runGeneration(job) {
    try {
        const sd = SlashCommandParser.commands['sd'] || SlashCommandParser.commands['imagine'];
        if (!sd || typeof sd.callback !== 'function') {
            log.warn('no /sd or /imagine slash command available — is Image Generation configured?');
            job.resolve(null);
            return;
        }
        // The look is built when the job RUNS, from the worn-outfit store as its tag sees it then.
        const { prompt: fullPrompt, drawn, camera, mainchar } = await assembleForReply(job.mesId, job.rawTag, job.prompt);
        const resolution = resolveResolution();
        const { width, height } = resolution;
        const bust = resolveBustStrength(drawn);
        await applyBustStrength(bust);
        logDrawnPicture('gen', { resolution, drawn, camera, mainchar, bust, composition: job.prompt, sentPrompt: fullPrompt });
        const result = await sd.callback(
            { quiet: job.quiet ? 'true' : 'false', width: String(width), height: String(height) },
            fullPrompt,
        );
        const url = typeof result === 'string' && result.trim().length > 0 ? result : null;
        if (!url) log.warn('/sd returned no image for tag', job.rawTag.slice(0, 120));
        job.fullPrompt = fullPrompt;
        job.resolve(url);
    } catch (e) {
        log.error('generation failed:', e);
        job.resolve(null);
    }
}

// Enqueue (or join) a generation for a tag. Returns { promise, key, joined, job }.
// `job` carries, after the run, `fullPrompt` (composition + each look) — used as the <img> title so the tooltip
// shows exactly what /sd received. The tracker stores the job WITH the promise so a JOINED caller gets it too:
// with streaming pre-gen the mid-stream detection owns the job and the final MESSAGE_RECEIVED pass always joins,
// so a promise alone would leave every streamed picture's title without its looks.
function enqueueGeneration(mesId, rawTag, prompt, quiet) {
    const key = jobKey(mesId, rawTag, prompt);
    const tracked = genTracker.get(key);
    if (tracked) return { promise: tracked.promise, key, joined: true, job: tracked.job };
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    // NEVER CACHE A FAILURE. Four paths resolve null — a cancelled queue job (swipe/delete), a missing
    // /sd command, /sd returning nothing, and a thrown generation. A swipe or regenerate reuses every part
    // of jobKey, so a settled-null promise left in genTracker would be "joined" by the retry, which sees
    // `!imageUrl` and skips the splice silently — no image, no error, forever. Evicting on null makes a
    // failure retryable; a SUCCESS still de-dupes the streaming pre-gen against the final pass, which is
    // all the tracker is for.
    // The eviction is ALSO what lets streaming pre-gen re-fire per token, so the same null parks the key in
    // pregenFailedThisStream (declared above) — retry stays open to the final pass and to a later generation,
    // but NOT to the next stream token.
    const job = { key, mesId, prompt, rawTag, quiet, resolve: (url) => { if (!url) { genTracker.delete(key); pregenFailedThisStream.add(key); } resolve(url); } };
    genTracker.set(key, { promise, job });
    genQueue.push(job);
    processQueue();
    return { promise, key, joined: false, job };
}

// A swipe or chat switch invalidates queued (not yet running) jobs.
function clearPendingQueue(reason) {
    if (!genQueue.length) return;
    log.lifecycle(`dropping ${genQueue.length} queued job(s) (${reason})`);
    for (const job of genQueue.splice(0)) job.resolve(null);
}
eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => { clearPendingQueue('swipe'); pregenChecking.clear(); pregenFailedThisStream.clear(); capWarnedFor.clear(); postHarvestParked.clear(); forgetRenderedImages(mesId); });
eventSource.on(event_types.CHAT_CHANGED, () => { clearPendingQueue('chat changed'); genTracker.clear(); pregenChecking.clear(); pregenFailedThisStream.clear(); capWarnedFor.clear(); postHarvestParked.clear(); renderedImagesThisTurn.clear(); });

// DELETING A MESSAGE RENUMBERS EVERY MESSAGE AFTER IT. Our per-message state is keyed by mesId, which
// is POSITIONAL (chat.length - 1) — not a durable identity. After a delete, the new last message
// inherits an index a DIFFERENT message already used, so:
//   • genTracker returns that older message's ALREADY-SETTLED promise as a "join" — if it had
//     resolved to null (dropped/failed), the caller sees `!imageUrl` and silently skips the
//     splice, so no <img> is ever attached; if it resolved to a URL, the STALE picture attaches.
//   • capWarnedFor already holds the reused id, suppressing a genuine cap warning.
//   • the lost-image detector audits the new reply against the old one's picture and warns about a
//     loss that never happened (a regenerate deletes first, so every regenerate hit this).
// Positional keys cannot survive renumbering, so drop the whole cache on any delete. Worst case
// we re-generate an image, or skip auditing a picture; the alternative is silently attaching the
// wrong one (or none), or a false alarm.
eventSource.on(event_types.MESSAGE_DELETED, () => {
    clearPendingQueue('message deleted');
    genTracker.clear();
    pregenChecking.clear();
    pregenFailedThisStream.clear();
    capWarnedFor.clear();
    renderedImagesThisTurn.clear();
    log.domain('imagegen', 'verbose', 'message deleted — cleared the generation cache and the lost-image records (mesId keys are positional and just shifted)');
});

// ── tag detection ─────────────────────────────────────────────────────────────
function getDetectionRegex() {
    const str = getImagegenProfile().promptRegex || DEFAULT_REGEX;
    try {
        const re = regexFromString(str);
        if (re instanceof RegExp) return re.global ? re : new RegExp(re.source, re.flags + 'g');
    } catch (e) {
        log.warn('invalid detection regex — using default:', e);
    }
    return regexFromString(DEFAULT_REGEX);
}

// A "tag" the detection regex should never have produced: it crossed out of one element into
// rendered HTML or another tag. The DEFAULT regex cannot do this (`[^"<]`, see default-template.js) —
// but the regex is a USER-EDITABLE stored setting, so an install that customized it (or saved an older
// default) can still run an unbounded scanner at DETECTION. This guard drops such a match before
// anything is generated from it, spliced, or swept: every later write in this file acts on the exact
// strings detection returned and never runs a scan of its own. A legitimate <pic> tag contains none of
// these.
function isSuspiciousTagMatch(m) {
    return m.length > 1500 || m.includes('auto-img') || m.includes('</');
}

// Every match the scanner ACCEPTS, in the reply and inside the narrator's thinking apart
// (partitionByReasoning: a <pic> drafted in <think>, <thinking> or <thinking_*> is never the reply's).
// `isTextComplete` is false while the reply streams in. `index` is only valid for the string passed in.
function scanTagsWithReasoning(mes, { isTextComplete = true } = {}) {
    const text = String(mes || '');
    const re = getDetectionRegex();
    const accepted = [...text.matchAll(re)]
        .map((m) => ({ rawTag: m[0], prompt: (m[1] || '').trim(), index: m.index }))
        .filter((t) => {
            if (!isSuspiciousTagMatch(t.rawTag)) return true;
            log.warn(`detection regex produced a suspicious ${t.rawTag.length}-char match (spans rendered HTML — a stale/custom Image-tab regex; reset it to default). Match ignored: ${t.rawTag.slice(0, 120)}…`);
            return false;
        });
    return partitionByReasoning(text, accepted, { isTextComplete });
}

// Every match in the REPLY the scanner accepts, UNCAPPED and unsorted by purpose — a draft inside the
// narrator's thinking is never one. `index` is only valid for the string passed in — see the
// re-anchoring note at the REPLACE splice; never persist it across an await. What each caller may do
// with the result is decided by partitionDetectedTags, which is where the drawable/disposable split is
// written down.
function scanTags(mes, opts) { return scanTagsWithReasoning(mes, opts).outside; }

// The DRAWABLE tags: a tag with no prompt has nothing to generate from.
function allTags(mes, opts) { return partitionDetectedTags(scanTags(mes, opts)).drawable; }

// The DISPOSABLE tags: every tag string the scanner accepted, prompt or not. A finalized reply
// must carry zero raw <pic>, and that is true of one the pass could never have drawn.
function allTagStrings(mes) { return partitionDetectedTags(scanTags(mes)).disposable; }

const imageCap = () => Math.max(1, parseInt(getImagegenProfile().maxImagesPerReply) || 1); // per-card

// Matches in mes, capped at maxImagesPerReply. SILENT by design: this runs on every streaming
// chunk (STREAM_TOKEN_RECEIVED pre-gen) and on read-only scans, so warning here emitted the same
// line ~70x per reply and drowned the console. The cap is a per-REPLY decision, so it is reported
// once, by warnOnCapOverflow, from the generating pass only.
function detectTags(mes, opts) {
    return allTags(mes, opts).slice(0, imageCap());
}

// Report cap overflow ONCE per message (no silent caps — but no storm either).
const capWarnedFor = new Set();
function warnOnCapOverflow(mes, mesId) {
    const total = allTags(mes).length;
    const cap = imageCap();
    if (total <= cap || capWarnedFor.has(mesId)) return;
    capWarnedFor.add(mesId);
    log.warn(`msg ${mesId} has ${total} image tags, cap is ${cap} — generating the first ${cap}, skipping the rest (raise "Max images per reply" on the Image tab)`);
}

// ── settings panel ───────────────────────────────────────────────────────────
// The panel lives in image-settings-ui.js; the barrel re-exports it from there. This file keeps the
// config it reads (imageDefaults / getImagegenProfile; the template is imagegen-profile-core.js) and the routed-task
// hooks it calls (CHARIMG_TASK_ID / PICTURES_TASK_ID / syncImageTaskRouting) — all exported, imported one-way by the UI.

// ── prompt injection (CHAT_COMPLETION_PROMPT_READY) ──────────────────────────
function getMesRole() {
    switch (getImagegenProfile().promptPosition) {
        case 'deep_system': return 'system';
        case 'deep_user': return 'user';
        case 'deep_assistant': return 'assistant';
        default: return 'system';
    }
}

// The outfits the main character's entry offers mainchar= ([] with no entry, or none to read).
async function maincharOutfits() {
    const key = String(getImagegenProfile().maincharRegistryKey || '').trim();
    if (!key) return [];
    const entry = await resolveCharEntry(key);
    return entry ? listOutfitVariants(entry.content) : [];
}

// The narrator's picture prompt (imageDuties): past pictures in its history read as <pic> tags while it writes the
// pictures, and are taken out while a POST call writes them; its picture rules go in only while it writes them. The
// <reply_cast> block the rules refer to is the roster's, asked for below (requestReplyCast). Where each part goes:
// prompt-assembly-core placeNarratorPictureParts.
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async function (eventData) {
    try {
        const duties = currentDuties();
        if (duties.historyPictures === HISTORY_PICTURES.AS_IS || !eventData || !Array.isArray(eventData.chat)) return;
        const parts = duties.sendsNarratorContract ? await narratorPictureParts(eventData) : {};
        const changed = placeNarratorPictureParts(eventData.chat, { historyPictures: duties.historyPictures, unescapeAttr: unescapeHtmlAttribute, ...parts });
        if (changed && duties.historyPictures === HISTORY_PICTURES.AS_TAGS) {
            log.child('context-swap').domain('imagegen', 'lifecycle', `${changed} rendered image wrap(s) → original <pic> in the outgoing prompt (model sees tag examples, not mimic-bait HTML)`);
        }
        if (changed && duties.historyPictures === HISTORY_PICTURES.REMOVED) {
            log.domain('imagegen', 'lifecycle', `${changed} past picture(s) taken out of the narrator's prompt — POST call "${duties.pictureCall}" writes the pictures, and a picture in the narrator's history invites one`);
        }
        if (parts.rules) {
            const prof = getImagegenProfile();
            log.domain('imagegen', 'verbose', `injecting image prompt: fixed rules first in the prompt (system); <scene_roster> ${parts.scene ? `role=${parts.role}, depth=${parts.depth}` : 'not sent'}; <picture_count> at the end (system, ${imageCap()} per reply); insertType=${prof.insertType}, max characters per image=${prof.maxCharactersPerImage}, looks via ${duties.lookTarget || 'nobody'}`);
        }
    } catch (error) {
        log.error('prompt injection error:', error);
        toast('error', `Prompt injection error: ${error}`);
    }
});

// The narrator's picture parts for this prompt (placeNarratorPictureParts): its rules, <scene_roster> with where it
// goes, and <picture_count>, each with its SillyTavern macros expanded (prompt-macros.js: nothing expands a block
// added at prompt-ready).
async function narratorPictureParts(eventData) {
    const prof = getImagegenProfile();
    const userOutfits = await maincharOutfitsOrNone();
    const gate = readExplicitGate(prof, { dryRun: eventData.dryRun === true });
    // MVU scene anchor: the game state's own list of who is on screen, so char= resolves to someone the
    // story has. It changes with who is on screen, so it goes where Position / Depth put it, after everything
    // a cache can reuse. Empty on a card with no usable presence field — then nothing is added. Said only
    // while looks are stored, because that is when an unverified char= gets PERSISTED as a registry key.
    const scene = sceneRosterText(readSceneRoster().present);
    if (!scene && !eventData.dryRun && currentDuties().stores) {
        log.domain('imagegen', 'lifecycle', 'scene roster EMPTY — no <scene_roster> anchor in this prompt, so char= values are '
            + 'whatever the narrator picks. Normal on a non-MVU card, on the turn a character debuts, or when Roster collection / '
            + 'Present flag are unset on the Roster tab.');
    }
    // The roster's keys are stat_data, so a template opener among them is broken (breakTemplateOpeners).
    const guardedScene = breakTemplateOpeners(expandPromptMacros(scene, 'imagegen'));
    if (guardedScene.broken && !eventData.dryRun) log.warn(`<scene_roster> carried ${guardedScene.broken} template opener(s) "<%" from its stat_data — sent as "< %" so the prompt's template pass runs none of it`);
    return {
        rules: expandPromptMacros(narratorPictureRules({ template: prof.promptTemplate, maxImages: imageCap(), maxCharactersPerImage: prof.maxCharactersPerImage, userOutfits, isExplicit: gate.inject }), 'imagegen'),
        scene: guardedScene.text,
        depth: Math.max(0, parseInt(prof.promptDepth, 10) || 0),
        role: getMesRole(),
        // <picture_count> ends the prompt: how many <pic> tags this reply carries, where they go and when to write
        // them, read near a preset's own reply template (default-template.js says why).
        count: expandPromptMacros(pictureCountRules(imageCap()), 'imagegen'),
    };
}

// The outfits mainchar= may name this time: the main character's entry's ([] with no entry or none to read).
async function maincharOutfitsOrNone() {
    try { return await maincharOutfits(); }
    catch (e) {
        log.warn("could not read the main character's entry for its outfits (mainchar= offers default/undressed only this time):", e);
        return [];
    }
}

// <explicit_rules> gate: the EXPLICIT/H composition floor, read from the state as it stands. The DECISION is pure and
// lives in decideExplicitBlock (prompt-assembly-core.js). readDeclaredFlag carries the ungated breakage warn (deduped);
// decideExplicitBlock carries the decision. Skipped when the checkbox forces always-on — there is no gate to read.
function readExplicitGate(prof, { dryRun = false } = {}) {
    const latchRead = prof.hBlockAlwaysOn ? { value: undefined, hasState: true } : readDeclaredFlag(prof.intimacyLatchPath,
        'intimacy latch', 'the EXPLICIT/H block is being WITHHELD (fail-closed)', { dryRun });
    const latch = latchRead.value;
    const gate = decideExplicitBlock({
        alwaysOn: prof.hBlockAlwaysOn, latchPath: prof.intimacyLatchPath, latchValue: latch, hasState: latchRead.hasState,
    });
    log.domain('imagegen', 'verbose', `<explicit_rules> ${gate.inject ? 'ON' : 'OFF'} (${gate.reason}, alwaysOn=${prof.hBlockAlwaysOn}, latch=${prof.hBlockAlwaysOn ? 'n/a' : JSON.stringify(latch)})`);
    return gate;
}

// The reader contract for reply `messageId` (default-template readerPictureContract): what a POST call that writes the
// pictures is asked, built when that call runs, so the latch, <scene_roster> and the ON FILE list read the state after
// the reply.
async function readerPictureContractFor(messageId) {
    const prof = getImagegenProfile();
    const userOutfits = await maincharOutfitsOrNone();
    const gate = readExplicitGate(prof);
    let onFile = '';
    try { onFile = await onFileListForPictureCall(); }
    catch (e) { log.warn(`msg ${messageId}: could not build the ON FILE list for the picture call — it is sent without one, so every slot reads as "newclothes" or "undressed":`, e); }
    return readerPictureContract({
        template: prof.promptTemplate, maxImages: imageCap(), maxCharactersPerImage: prof.maxCharactersPerImage, userOutfits,
        isExplicit: gate.inject, scene: sceneRosterText(readSceneRoster().present), onFile,
    });
}

// Pictures read each person's look from this reply's <cast> records, and harvest stores them: the roster
// sends its <reply_cast> block whenever either needs it. The main character's entry never takes a cast
// record (mainchar= draws him), so the ON FILE list never offers it one; its outfits are printed ON FILE on a line of
// their own for mainchar= (reply-cast-core userOutfitsOnFile), and its "same-as-last-picture" line names him for
// mainchar= when the store holds what he wore (reply-cast-core userLastPictureWear). The one-off clothes record is asked
// for inside that block on exactly the prompts that carry <outfit_rules>, which names outfit="newclothes"
// and points to it — the two blocks are never sent apart.
requestReplyCast('imagegen', () => currentDuties().needsReplyCast, {
    uncastKeys: () => [String(getImagegenProfile().maincharRegistryKey || '').trim()].filter(Boolean),
    recordAsks: () => castRecordAsks(currentDuties()),
});

// ── REPLACE-mode regenerate button ───────────────────────────────────────────
// Clicking the "regenerate" button next to an image draws it again from its stashed <pic> (every look
// re-resolved as it is now, the clothes of each person it is the last picture of in its reply as the reply saved
// them) and replaces that image's src; the lost-image record follows the swap (followImageSwap). Delegated (bound
// once to document) because updateMessageBlock rebuilds the message DOM.
// NB: ST's DOMPurify sanitizer PREFIXES every non-allowlisted class in message HTML
// with `custom-`, so our `auto-img-regen`/`auto-img-wrap` render as `custom-auto-img-*`.
// Match BOTH so the handler fires whether or not the prefix was applied.
$(document).on('click', '.auto-img-regen, .custom-auto-img-regen', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const $btn = $(this);
    if ($btn.hasClass('auto-img-regen--busy')) return; // already generating

    const $wrap = $btn.closest('.auto-img-wrap, .custom-auto-img-wrap');
    let $img = $wrap.find('img').first();
    if (!$img.length) $img = $btn.prevAll('img').first();
    if (!$img.length) $img = $btn.parent().find('img').first();

    const $mes = $btn.closest('.mes');
    const mesId = Number($mes.attr('mesid'));
    if (!Number.isInteger(mesId)) {
        toast('warning', 'Regenerate: could not find the message id.');
        return;
    }

    const context = getContext();
    const message = context.chat[mesId];
    if (!message) {
        toast('warning', 'Regenerate: message not found in chat.');
        return;
    }

    // Re-resolve each look FRESH at regen: a registry edit is a CORRECTION that must reach every image,
    // old scenes included. The stashed raw <pic> carries the slots, outfits and [Composition], the reply
    // still holds its <cast> records, and the chat the state before it, so assembleForReply rebuilds the
    // prompt as a first draw would now — not the snapshot baked into the title — except for the clothes of each
    // person this is the last picture of in its reply: those come from the worn-outfit store saved with the
    // reply (shownInReplyFor, D39), where an outfit the harvest saved is held by name and "Wearing now" edits
    // land, so both show at once. A wrap with no data-rawtag replays its title.
    const rawTag = String($wrap.attr('data-rawtag') || '').trim();
    const dims = resolveResolution();   // a regenerated picture keeps the card's image type, like the first draw
    let prompt;
    if (rawTag) {
        const composition = tagAttr(rawTag, 'prompt');
        const rebuilt = await assembleForReply(mesId, rawTag, composition, { shownFor: await shownInReplyFor(mesId, rawTag) });
        prompt = rebuilt.prompt.trim();
        const bust = resolveBustStrength(rebuilt.drawn);   // regen re-resolves the bust value too, same as the looks
        await applyBustStrength(bust);
        logDrawnPicture('regen', { resolution: dims, drawn: rebuilt.drawn, camera: rebuilt.camera, mainchar: rebuilt.mainchar, bust, composition, sentPrompt: prompt });
    } else {
        // The title is the reply's markup, so it goes to /sd the way a composed prompt does: without macro braces.
        prompt = withoutMacroBraces($img.attr('title') || '').trim();
        log.domain('imagegen', 'verbose', `regen msg ${mesId}: the picture holds no <pic> — its title is sent to /sd as it is: ${prompt}`);
    }
    if (!prompt) {
        toast('warning', 'Regenerate: no prompt found on the image.');
        return;
    }

    $btn.addClass('auto-img-regen--busy');
    try {
        toast('info', 'Regenerating image...');
        const sdArgs = { quiet: 'true', width: String(dims.width), height: String(dims.height) };
        // @ts-ignore
        const result = await SlashCommandParser.commands['sd'].callback(sdArgs, prompt);
        if (typeof result === 'string' && result.trim().length > 0) {
            // WHICH wrap, not "the first src= that matches": two images sharing a URL swapped the
            // wrong one, silently (F4). data-rawtag identifies it when unique; the clicked wrap's
            // ordinal among all wraps in THIS message settles duplicates — DOM order is text order.
            const $wraps = $mes.find('.auto-img-wrap, .custom-auto-img-wrap');
            const plan = planImageSrcSwap(message.mes, {
                rawTag: rawTag ? escapeHtmlAttribute(rawTag) : '',
                ordinal: $wraps.index($wrap),
                newSrcEscaped: escapeHtmlAttribute(result),
            });
            if (!plan.ok) {
                log.warn(`regenerate produced an image but could NOT identify which wrap to put it in (${plan.reason}) — the message is left untouched rather than swapping the wrong picture. The file is on disk: ${result}`);
                toast('warning', 'Regenerated, but the image could not be placed — see console. The file was kept.');
                return;
            }
            message.mes = plan.text;
            followImageSwap(mesId, plan, result);   // before the redraw: its render runs the lost-image audit
            await redrawReply(message, mesId, 'imagegen regen swap');
            toast('success', 'Image regenerated');
        }
    } catch (error) {
        toast('error', `Image regeneration error: ${error}`);
        log.error('Image regeneration error:', error);
    } finally {
        $btn.removeClass('auto-img-regen--busy');
    }
});

// ── streaming pre-generation ─────────────────────────────────────────────────
// Start /sd the moment a COMPLETE tag appears mid-stream; the MESSAGE_RECEIVED final pass joins the same
// tracker promise and does the attaching. A tag inside the narrator's thinking is never drawn, and while the
// reply streams a thinking block not yet closed holds the rest of the text (reasoningSpans).
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, function () {
    try {
        const s = extension_settings[EXTENSION_NAMESPACE];
        if (!s || !currentDuties().pregenerates || s.streamingPregen === false) return;
        const context = getContext();
        const mesId = context.chat.length - 1;
        const message = context.chat[mesId];
        if (!message || message.is_user) return;
        const tags = detectTags(message.mes, { isTextComplete: false });
        for (const [position, t] of tags.entries()) {
            const key = jobKey(mesId, t.rawTag, t.prompt);
            // Three guards, three different "already handled" states: tracker = a job exists (pending or
            // succeeded) · pregenChecking = a look check is in flight or this key is parked as deferred ·
            // pregenFailedThisStream = a job already ran and failed, so do NOT re-fire it once per token for
            // the rest of the stream (the final pass still retries it).
            if (genTracker.has(key) || pregenChecking.has(key) || pregenFailedThisStream.has(key)) continue;
            pregenChecking.add(key);
            void maybePregen(mesId, t, key, tags.slice(0, position).map((earlier) => earlier.rawTag));
        }
    } catch (e) {
        log.warn('streaming pre-generation error:', e);
    }
});

// Pre-gen LOOK GUARD: a tag is drawn mid-stream only when every slot it draws has a look it can build now
// (dna-core lookWaitsForReply). A look from this reply's <cast> records — someone with nothing stored,
// outfit="newclothes", an outfit not on file yet, or clothes an earlier tag of this same reply took from them
// — cannot exist mid-stream: the records are written after the story. Pre-generating would render without
// it, and the final pass would JOIN that wrong job, so such a tag waits for the final pass. `earlierTags` are
// this reply's tags ahead of `t`. The main character never waits: he has no <cast> record, so only his entry
// and his earlier pictures give him a look, and both are there or not now.
const pregenChecking = new Set();   // keys checked (or deferred) this stream — a DEFERRED key STAYS parked so per-token re-checks don't flood the lorebook read; cleared on swipe/chat-change (its sibling for keys that ran and FAILED is pregenFailedThisStream, near genTracker)
async function maybePregen(mesId, t, key, earlierTags = []) {
    try {
        const { slots } = fitPeopleToCeiling({ slots: picSlots(t.rawTag), mainchar: maincharOf(t.rawTag), ceiling: getImagegenProfile().maxCharactersPerImage });
        if (slots.length) {
            const entries = await listCharEntries();
            const earlierSlots = earlierTags.flatMap((raw) => picSlots(raw));
            for (const slot of slots) {
                const reason = lookWaitsForReply({ name: slot.key, outfit: slot.outfit, entries, earlierSlots });
                if (!reason) continue;
                log.child('pre-gen').domain('imagegen', 'verbose', `"${slot.key}" ${reason} — the final pass will generate`);
                return;                                          // key stays parked
            }
        }
        enqueueGeneration(mesId, t.rawTag, t.prompt, true);
        pregenChecking.delete(key);                              // tracked now — tracker owns dedup
    } catch (e) {
        log.warn('streaming pre-generation check error:', e);
        pregenChecking.delete(key);                              // error → allow a retry
    }
}


// ── the lost-image detector ──────────────────────────────────────────────────
// A writer that rewrites the reply from a copy read BEFORE the draw pass spliced a picture in replaces
// that picture with the raw <pic> tag, and nothing logs it: from the writer's side nothing failed.
//
// This records what the draw pass actually wrote, follows the regenerate button's swaps, and checks, later,
// whether it survived. It REPAIRS NOTHING: the defect belongs to the writer, and a second write from here
// would hide it from the module that owns it (L7). What it buys is that the loss is named instead of silent.
const renderedImagesThisTurn = new Map();   // mesId -> [{ wrap, rawTag, imageUrl, reported }]

function noteRenderedImage(mesId, rawTag, wrap, imageUrl) {
    const key = String(mesId);
    if (!renderedImagesThisTurn.has(key)) renderedImagesThisTurn.set(key, []);
    renderedImagesThisTurn.get(key).push({ wrap: String(wrap || ''), rawTag: String(rawTag || ''), imageUrl: String(imageUrl || ''), reported: false });
}

// Records must only ever be audited against the reply they were written into, and the key is a
// positional index, not an identity. So a record leaves whenever its index may now hold other text:
//   - a draw pass that splices into a message starts that message's list over (its first splice
//     calls forgetRenderedImages);
//   - a SWIPE drops the swiped message's list — it now shows another take;
//   - a DELETE clears every list — the regenerate's own delete, a delete + re-send, and any delete
//     that renumbers the messages after it (both listeners sit with the generation cache's).
// Without the last two, the new reply at that index was audited against the old take's picture until
// its own picture landed, and the detector warned about a loss that never happened.
function forgetRenderedImages(mesId) {
    renderedImagesThisTurn.delete(String(mesId));
}

// The regenerate button swapped the picture inside one wrap of `mesId` (`swap` = planImageSrcSwap's result):
// the record of that wrap now holds the new picture, so the audit checks what the reply holds instead of
// reporting this module's own write as a loss.
function followImageSwap(mesId, swap, imageUrl) {
    const key = String(mesId);
    const records = renderedImagesThisTurn.get(key);
    if (!records) return;
    renderedImagesThisTurn.set(key, recordsAfterImageSwap(records, { wrapBefore: swap.wrapBefore, wrapAfter: swap.wrapAfter, imageUrl }));
}

/**
 * Check every image this turn's draw pass spliced (as any regenerate since swapped it) against the reply's CURRENT text, and say so when
 * one did not survive. Call it on CHARACTER_MESSAGE_RENDERED: TavernHelper's setChatMessages ends in
 * refreshOneMessage, which emits that event, so every foreign write to the reply — MVU's announced
 * ones and its silent ones alike — is followed by one. Reports each loss ONCE and consumes nothing
 * else, so a picture spliced after an earlier pass is still audited by the next render.
 */
export async function auditRenderedImagesAfterForeignWrites() {
    if (!renderedImagesThisTurn.size) return;
    const ctx = typeof getContext === 'function' ? getContext() : null;
    const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
    for (const [key, records] of [...renderedImagesThisTurn.entries()]) {
        const mesId = Number(key);
        const message = chat && chat[mesId];
        if (!message || typeof message.mes !== 'string') continue;   // gone (deleted/reloaded) — nothing to judge
        // NOT consumed on a clean pass. Renders are frequent and most of them land while the picture
        // is still there; consuming on one of those would leave nothing to check at the render that
        // matters. Each record is re-checked on every render and REPORTED ONCE, so the first one after
        // the revert catches it.
        const pending = records.filter((r) => !r.reported);
        if (!pending.length) continue;
        const { revertedToTag, inReasoning, vanished } = auditRenderedImages(message.mes, pending, message.extra && message.extra.reasoning);
        // A picture that left with the thinking it was spliced into is THIS module's defect, not a foreign
        // write: the draw pass anchored inside a thinking block the reasoning rule did not recognise.
        for (const lost of inReasoning) {
            lost.reported = true;
            log.warn(`the finished picture in msg ${mesId} left the reply with the narrator's thinking: it was spliced into `
                + 'a thinking block that was then moved into the reply\'s reasoning (its Thinking panel), where it is now. '
                + 'The draw pass leaves a <pic> inside a closed <think>, <thinking> or <thinking_*> block alone, so this thinking '
                + 'was written another way: another tag, or a block never closed. '
                + `The image file is kept: ${lost.imageUrl}`);
        }
        // OBSERVATION ONLY — no verdict on WHO wrote. This runs after the write, not during it, so
        // the writer's identity is not among the things it can see; naming one would be a guess
        // printed as a fact. What it can see is the text, so it prints the text's shape and the one
        // question that separates the known causes: did the <pic> anchor come back?
        for (const lost of [...revertedToTag, ...vanished]) {
            lost.reported = true;
            const anchorBack = revertedToTag.includes(lost);
            log.warn(`the finished picture in msg ${mesId} is GONE from the reply — something rewrote the `
                + `message after the draw pass attached it. Its <pic> anchor ${anchorBack ? 'is back in the text' : 'is NOT in the text either'}. `
                + `The reply now holds ${(message.mes.match(/<img\b/g) || []).length} <img> and `
                + `${(message.mes.match(/<pic\b/g) || []).length} <pic> tag(s) in ${message.mes.length} chars. `
                + 'Known cause when the anchor is back: a writer that read the text before the splice and wrote that '
                + 'copy back. MVU did this before v0.189.0, so check the MVU version first; on v0.189.0+ it writes the '
                + 'current text unless a mag_before_message_update listener edited message_content. '
                + 'NOT repaired from here: another module\'s defect is reported, never written around from this side '
                + '(CLAUDE.md L7). '
                + `The image file is kept: ${lost.imageUrl}`);
        }
    }
}


// Ensure message.extra + a valid image_swipes array (idempotent). Must be called
// AFTER any await, because ST can replace message.extra while /sd runs.
function ensureImageExtra(message) {
    if (!message.extra) message.extra = {};
    if (!Array.isArray(message.extra.image_swipes)) message.extra.image_swipes = [];
    if (message.extra.image && !message.extra.image_swipes.includes(message.extra.image)) {
        message.extra.image_swipes.push(message.extra.image);
    }
}

// ── POST-harvest parking ─────────────────────────────────────────────────────
// mesId → { message, prof, tags }: <pic> tags naming someone with no stored look yet, while looks are
// stored through a POST call. That call registers newcomers AFTER this file draws (POST runs after
// MESSAGE_RECEIVED), so a newcomer drawn at once would render from the composition alone — or from the
// narrator's own description, when its record wrote one — and her first picture would disagree with the
// look stored seconds later. So such a tag is PARKED, and the look task's POST capture drains the park
// after it has stored this reply's registrations. A fallback timer drains anyway, so a dead POST call can
// never strand a tag forever; each person is then drawn from the reply's record, or the scene alone.
const postHarvestParked = new Map();
let postHarvestDrainTimer = null;
const POST_HARVEST_DRAIN_FALLBACK_MS = 120_000;

async function drainPostHarvestParked(trigger) {
    if (postHarvestDrainTimer) { clearTimeout(postHarvestDrainTimer); postHarvestDrainTimer = null; }
    if (!postHarvestParked.size) return;
    const entries = [...postHarvestParked.entries()];
    postHarvestParked.clear();
    // Announced before the first draw: the turn's write, still open while the POST capture drains, waits for
    // the parked pictures too.
    let settleDrain = null;
    const drained = new Promise((resolve) => { settleDrain = resolve; });
    for (const [mesId, rec] of entries) {
        announceReplyEdit(rec.message, mesId, { label: 'imagegen draw pass (parked pictures)', work: drained, allowanceMs: pictureWaitMs(rec.tags.length) });
    }
    try {
        for (const [mesId, rec] of entries) {
            // Same identity check as the attach path: swiped/regenerated away ⇒ the parked tags died
            // with their message.
            if (getContext().chat[mesId] !== rec.message) {
                log.domain('imagegen', 'verbose', `post-harvest drain (${trigger}): msg ${mesId} changed while parked — ${rec.tags.length} tag(s) dropped`);
                continue;
            }
            log.domain('imagegen', 'lifecycle', `post-harvest drain (${trigger}): generating ${rec.tags.length} parked pic(s) for msg ${mesId} now that registration has ${trigger === 'fallback timer' ? 'timed out' : 'completed'}`);
            await runDrawPass(mesId, rec.message, rec.prof, rec.tags, { sweepLeftovers: true });
        }
    } finally {
        settleDrain();
    }
}

// ── MESSAGE_RECEIVED: the draw pass ──────────────────────────────────────────
// How long the turn's one write waits for this reply's pictures (features/reply-redraw announceReplyEdit):
// one allowance per picture, since the queue draws them one after another, and never more than four minutes
// for a whole reply, however high its picture cap. A picture still drawing after that is written on its own
// when it lands. The Tags-only strip touches no backend and needs only a moment.
const PICTURE_WAIT_PER_IMAGE_MS = 60_000;
const PICTURE_WAIT_LONGEST_MS = 240_000;
const pictureWaitMs = (count) => Math.min(PICTURE_WAIT_PER_IMAGE_MS * count, PICTURE_WAIT_LONGEST_MS);
const NO_DRAW_STRIP_WAIT_MS = 5_000;

// What the reply's own <pic> tags are (imageDuties narratorTagAction): the narrator's pictures, drawn (or, with Tags
// only, logged and disposed of) — or, while a POST call writes the pictures, strays, and that call's pictures come at
// POST's capture (onPictureOutput).
async function handleIncomingMessage() {
    const s = extension_settings[EXTENSION_NAMESPACE];
    if (!s) return;
    const duties = currentDuties();
    // Disable sends no <pic> instruction, so a <pic> in the reply is not ours to draw or to dispose of.
    if (duties.narratorTagAction === NARRATOR_TAG_ACTION.IGNORE) return;

    const context = getContext();
    // RACE-SAFE: capture the target message NOW; verify identity at attach time.
    const mesId = context.chat.length - 1;
    const message = context.chat[mesId];
    if (!message || message.is_user) return;
    log.domain('imagegen', 'lifecycle', `msg ${mesId}: pictures written by ${duties.pictureCall ? `POST call "${duties.pictureCall}"` : 'the narrator'}`);

    // The look task's capture is NOT done here: the LLM-task router fires it on the same MESSAGE_RECEIVED
    // (narrate target) or on POST-done (POST target). eventSource.emit awaits listeners in turn and the
    // draw pass below is deferred (setTimeout), and every write to the message is by exact string on its
    // current text, so the stray-closer removal and this pass's <pic> splice never undo each other.
    if (duties.narratorTagAction === NARRATOR_TAG_ACTION.DISPOSE_AS_STRAY) {
        disposeStrayNarratorTags(message, mesId, duties.pictureCall);
        warnIfPictureCallCannotRun(duties.pictureCall);
        return;
    }
    await drawReplyTags(message, mesId, 'narrate');
}

// The reply's pictures: ONE draw flow for both writers (plans/executed/picture-writer-route.md D7) — the narrator's tags at
// MESSAGE_RECEIVED, a POST call's once they are placed. `writer` is 'narrate' or that call's name. The drawing is
// announced to the reply redraw before the first await, because the turn can end at any await; this resolves once the
// drawing is scheduled, or its tags parked for registration, and the drawing runs on.
async function drawReplyTags(message, mesId, writer) {
    const prof = getImagegenProfile();
    const duties = currentDuties();
    // <pic> DISPOSITION: a raw <pic> left in msg.mes pollutes galgame's parser — its beat-shaper holds back
    // scene binding while one lingers — and shows as literal text. So with Tags only the tags are still
    // disposed of per stripPicTag (strip = clean + galgame-safe · keep = visible for debug), and each prompt
    // is logged to log.domain('imagegen'). Only the GPU pass below needs drawing.
    // A <pic> the narrator drafted in its thinking is left exactly as written: it is not the reply's.
    const drafted = scanTagsWithReasoning(message.mes).inside.length;
    if (drafted) log.domain('imagegen', 'lifecycle', `msg ${mesId}: ${drafted} <pic> tag(s) inside the narrator's thinking (<think>, <thinking>, <thinking_*>) left alone — a draft is never drawn, counted or swept`);
    const tags = detectTags(message.mes);
    if (!tags.length) {
        // ZERO TAGS IS A CONTRACT BREACH, NOT A QUIET TURN. The contract makes one <pic> mandatory every
        // reply, so an empty reply means the narrator dropped the instruction — usually a card whose own
        // output format out-competes ours, or an edited/stale injection prompt.
        if (writer === 'narrate') log.domain('imagegen', 'lifecycle', `msg ${mesId} carries NO <pic> tag${drafted ? ' outside its thinking' : ''} — the narrator did not follow the image contract this reply (nothing to draw). Common causes: the card's own output format crowded it out, or a customised injection prompt on the Image tab.`);
        else log.domain('imagegen', 'lifecycle', `msg ${mesId}: none of POST call "${writer}"'s pictures is in the reply any more — nothing to draw`);
        return;
    }
    if (!duties.draws) {
        // Tags only. Deferred (like the draw path) so the message renders first, and announced so the turn's
        // one write carries the strip; that write's MESSAGE_UPDATED lets galgame's beat-shaper re-read a clean
        // message and shape it.
        const stripped = new Promise((resolve) => {
            setTimeout(() => {
                disposePicTagsNoDraw(message, mesId, prof, tags)
                    .catch((e) => log.warn('<pic> no-draw disposal failed:', e))
                    .finally(resolve);
            }, 0);
        });
        announceReplyEdit(message, mesId, { label: 'imagegen no-draw strip', work: stripped, allowanceMs: NO_DRAW_STRIP_WAIT_MS });
        return;
    }
    warnOnCapOverflow(message.mes, mesId);   // the ONE place the per-reply cap is reported
    // The reply's pictures join the turn's one write: announced here, before the first await below, because
    // the turn can end at any await. Settled when the draw pass ends, or at once when none is scheduled.
    let settleDraw = null;
    const drawn = new Promise((resolve) => { settleDraw = resolve; });
    announceReplyEdit(message, mesId, { label: 'imagegen draw pass', work: drawn, allowanceMs: pictureWaitMs(tags.length) });
    let isDrawScheduled = false;
    try {
        isDrawScheduled = await planDrawPass(message, mesId, prof, duties, tags, settleDraw);
    } finally {
        if (!isDrawScheduled) settleDraw();
    }
}

// A <pic> the narrator wrote while a POST call writes the pictures (D7): one writer per route, so it is never drawn. It
// is taken out of the reply whole, with no trace and no visible copy — the worn-outfit store and registration read every
// trace as a picture the reply drew — so no raw <pic> is left for galgame to wait on, and the line prints it.
// Synchronous: the edit joins the turn's one write.
function disposeStrayNarratorTags(message, mesId, pictureCall) {
    const strays = allTagStrings(message.mes);
    if (!strays.length) return;
    const res = removeTagsPinpoint(message.mes, strays);
    log.domain('imagegen', 'lifecycle', `msg ${mesId}: the narrator wrote ${strays.length} <pic> tag(s) although POST call "${pictureCall}" writes the pictures — taken out, never drawn: ${strays.join(' ')}`);
    if (res.text === message.mes) return;
    message.mes = res.text;
    redrawReply(message, mesId, 'imagegen stray narrator tags')
        .catch((e) => log.warn(`msg ${mesId}: the stray <pic> removal is in the reply's text but could not be handed to the reply redraw:`, e));
}

// The picture call does not run — turned off, deleted or without a connection profile in Extra LLM Calls, or Extra LLM
// Calls is off — so its replies get no picture; the narrator never takes the pictures back (hard line 6). Said every
// reply, with one toast per chat.
const pictureCallToastedChats = new Set();
function warnIfPictureCallCannotRun(pictureCall) {
    if (isTaskTargetAvailable(PICTURES_TASK_ID)) return;
    log.warn(`pictures are written by POST call "${pictureCall}", which does not run: it is turned off, deleted or has no connection profile in Extra LLM Calls, or Extra LLM Calls is off. This reply gets no picture.`);
    const chatId = String(getContext().chatId || '');
    if (pictureCallToastedChats.has(chatId)) return;
    pictureCallToastedChats.add(chatId);
    toast('warning', `Pictures are written by "${pictureCall}", which does not run, so replies get no picture. Turn it on in Extra LLM Calls, or pick another writer on the Image tab.`, 'MVU Helper — no pictures');
}

// What the draw pass does with each tag, then the pass itself (deferred so the message renders first). Returns
// whether a pass was scheduled; that pass calls `onDrawn` when it ends.
async function planDrawPass(message, mesId, prof, duties, tags, onDrawn) {
    // Which drawn names deserve a line, and what each one's look comes from. WHO gets a diagnostic is
    // decided in prompt-assembly-core (validateCharSlots), WHERE a look comes from in dna-core
    // (lookSourceFor) — both pure, both tested.
    //   • a RESERVED word as a name (an outfit= value, or "none") is a contract violation that costs the
    //     character any look: always a warn.
    //   • a name nothing knows, with no look in this reply either, is drawn from the scene alone. While
    //     looks are stored by the narrator, its NAME is minted as a name-only entry, so the Roster's Merge
    //     tool — which needs both entries to exist — can make this spelling an alias of the entry it
    //     duplicates. A name with a look in this reply needs none of that: harvest stores it.
    const sceneRoster = readSceneRoster();
    const replyRecords = readCastRecords(message.mes).records;
    let entries = [];
    try { entries = await listCharEntries(); }
    catch (e) { log.warn('could not read the registry to check the drawn names (checking against the game state only):', e); }
    const known = [...sceneRoster.all];
    const placeholderLc = new Set();
    for (const e of entries) {
        // ALIASES COUNT AS KNOWN: every look lookup resolves through them.
        known.push(e.key, ...listAliases(e.content));
        if (!hasStoredAppearance(e.content)) {
            placeholderLc.add(e.key.toLowerCase());
            for (const a of listAliases(e.content)) placeholderLc.add(a.toLowerCase());
        }
    }
    const slotNames = tags.flatMap((t) => picSlots(t.rawTag).map((slot) => slot.key));
    const rosterLabel = sceneRoster.all.length ? ` (roster: ${sceneRoster.all.join(', ')})` : '';
    // The name-only state, reported EVERY turn it still costs a picture: knowing her name is not knowing
    // what she looks like, which is a different question from validateCharSlots's "is this name known?".
    for (const name of new Set(slotNames)) {
        if (!placeholderLc.has(name.toLowerCase()) || lookSourceFor(name, entries, replyRecords) !== 'none') continue;
        log.warn(`<pic char="${name}"> resolves to a NAME-ONLY registry entry and this reply gives no look — `
            + 'the image is drawn from the composition alone. Open the Roster tab and either give that entry appearance text, '
            + 'or Merge it onto the entry it duplicates so this spelling resolves through an alias.');
    }
    for (const f of validateCharSlots(slotNames, RESERVED_OUTFIT_NAMES, known)) {
        if (f.kind === 'reserved') {
            log.warn(`<pic char="${f.name}"> uses a RESERVED word as a character name — "${f.name}" is an outfit= value or a word for nobody, never a char= value. Nobody can be registered under it, so this image renders without any look. Name the character${rosterLabel}.`);
            continue;
        }
        if (lookSourceFor(f.name, entries, replyRecords) !== 'none') continue;   // described in this reply
        if (duties.stores && duties.lookTarget === 'narrate') {
            const minted = await registerPlaceholderCharDna(f.name);
            log.warn(`<pic char="${f.name}"> matches no roster key${rosterLabel} and no registry entry, and this reply describes nobody by that name`
                + ' — drawn from the scene alone.'
                + (minted.ok
                    ? ` Added "${f.name}" to the character registry as a NAME-ONLY entry: open the Roster tab and either give it appearance text, or Merge it onto the entry it duplicates so this spelling becomes an alias.`
                    : ' Register them in the Roster tab, or add this spelling as an [Alias] on their existing entry.'));
        } else if (duties.stores) {
            // Stored through a POST call: its capture fires on POST-done, after this pass. Still a maybe.
            log.lifecycle(`<pic char="${f.name}"> matches no roster key${rosterLabel} and no registry entry yet — the POST call's registration has not run for this reply; if they are still unregistered next reply, that registration is failing.`);
        }
    }

    // Looks stored through a POST call ⇒ a tag naming someone with no STORED look yet waits for that call's
    // capture (see postHarvestParked above), even when this reply's own record describes them
    // (dna-core lookWaitsForRegistration says why). Everything else draws now.
    let readyTags = tags;
    let parkedTags = [];
    if (duties.stores && duties.lookTarget !== 'narrate') {
        parkedTags = tags.filter((t) => picSlots(t.rawTag).some((slot) => lookWaitsForRegistration(slot.key, entries)));
        readyTags = tags.filter((t) => !parkedTags.includes(t));
        if (parkedTags.length) {
            postHarvestParked.set(mesId, { message, prof, tags: parkedTags });
            if (postHarvestDrainTimer) clearTimeout(postHarvestDrainTimer);
            postHarvestDrainTimer = setTimeout(() => { void drainPostHarvestParked('fallback timer'); }, POST_HARVEST_DRAIN_FALLBACK_MS);
            log.child('post-harvest').domain('imagegen', 'lifecycle', `${parkedTags.length} of ${tags.length} pic(s) name someone with no stored look yet — parked until the "${duties.lookTarget}" call's registration capture lands (fallback ${POST_HARVEST_DRAIN_FALLBACK_MS / 1000}s).`);
        }
    }
    // While tags are parked the leftover sweep is held back too — sweeping would DELETE the parked
    // <pic> anchors from msg.mes, and the drain pass could never attach its images.
    const sweepLeftovers = parkedTags.length === 0;
    if (!readyTags.length) return false;
    // Defer so the message renders first.
    setTimeout(() => { void runDrawPass(mesId, message, prof, readyTags, { sweepLeftovers }).finally(onDrawn); }, 0);
    return true;
}

// The generation/attach pass, extracted from handleIncomingMessage so the post-harvest drain can
// re-run it for parked tags. `sweepLeftovers: false` = a partial pass that must leave un-drawn
// <pic> anchors in place for a later pass.
async function runDrawPass(mesId, message, prof, tags, { sweepLeftovers = true } = {}) {
        try {
            toast('info', `Generating ${tags.length} image(s)...`);
            const insertType = prof.insertType;
            // Every tag detection sees in the message NOW, uncapped — read before this pass awaits
            // anything. The leftover disposition below is derived from THIS list minus what the pass
            // consumed, by exact string; the finished message is never re-scanned (image-splice-core).
            // DISPOSABLE, not drawable: a `<pic prompt="">` is undrawable and must still not survive
            // into the finalized reply — reading the draw list here is what let one through.
            const detectedAtStart = allTagStrings(message.mes);

            ensureImageExtra(message);

            const quiet = insertType !== INSERT_TYPE.NEW_MESSAGE;
            const jobs = tags.map((t) => ({
                tag: t,
                entry: enqueueGeneration(mesId, t.rawTag, t.prompt, quiet),
            }));

            const replaceResults = [];
            const generatedTags = [];
            // One reset per pass, on the first splice that lands: a regenerate reuses the message id, so the
            // take before it must stop being audited against text it was never written into.
            let notedThisPass = false;
            const consumedTags = [];   // REPLACE tags whose splice actually landed — the sweep's exclusion list
            let okCount = 0;

            for (const { tag, entry } of jobs) {
                const imageUrl = await entry.promise;
                if (!imageUrl) continue;

                // RACE-SAFE verification: the captured message must still be the same
                // object at that index (not swiped away / regenerated / deleted).
                if (getContext().chat[mesId] !== message) {
                    log.warn(`message ${mesId} changed while generating — image dropped (not attached)`);
                    continue;
                }
                okCount++;

                // Full prompt (composition + each look) so a regen reproduces the SAME
                // character; falls back to the composition for a deduped/joined job.
                const fullPrompt = (entry.job && entry.job.fullPrompt) || tag.prompt;

                if (insertType === INSERT_TYPE.INLINE) {
                    // Re-ensure: ST finalizes the message during the /sd await and can
                    // REPLACE message.extra (with {api,model,reasoning,…}), clobbering the
                    // image_swipes array we set up before the await. Rebuild it here.
                    ensureImageExtra(message);
                    message.extra.image_swipes.push(imageUrl);
                    message.extra.image = imageUrl;
                    message.extra.title = fullPrompt;
                    message.extra.inline_image = true;
                    const messageElement = $(`.mes[mesid="${mesId}"]`);
                    appendMediaToMessage(message, messageElement);
                    generatedTags.push(tag.rawTag);
                } else if (insertType === INSERT_TYPE.REPLACE) {
                    // No `index` here on purpose: the splice re-anchors on rawTag (see below).
                    // A stored offset would be stale by then and is what caused the lost-image bug.
                    replaceResults.push({
                        imageUrl,
                        prompt: fullPrompt,
                        rawTag: tag.rawTag,   // the anchor AND stashed on the wrap so regen re-resolves every look
                    });
                } else if (insertType === INSERT_TYPE.NEW_MESSAGE) {
                    // /sd quiet=false already created the image message itself.
                    generatedTags.push(tag.rawTag);
                }
            }

            // REPLACE: RE-ANCHOR each splice by searching for the raw tag, never by the offset
            // captured at detection time.
            //
            // WHY: `tag.index` is taken from detectTags() BEFORE the `await entry.promise` above. During
            // that await the SAME message object is mutated by other passes on this reply — the stray-closer
            // removal, MVU's write-back. Any strip that lands before a `<pic>` shifts every later offset,
            // so splicing by offset puts the image at the wrong place AND deletes that many characters of
            // unrelated prose, leaving the real `<pic>` behind for the sweep to delete.
            //
            // indexOf is recomputed per iteration against the CURRENT text, so no ordering trick
            // (and no back-to-front sort) is needed; duplicate identical tags resolve left-to-right
            // because each replacement consumes the occurrence it found.
            if (replaceResults.length > 0) {
                for (const rep of replaceResults) {
                    const escapedUrl = escapeHtmlAttribute(rep.imageUrl);
                    const escapedPrompt = escapeHtmlAttribute(rep.prompt);
                    // data-rawtag = the ORIGINAL <pic> tag (slots, outfits, mainchar=, [Composition]).
                    // Survives ST's message sanitizer (its hook only rewrites `class`; data-* is
                    // left intact) → regen reads it back and rebuilds every look as it is NOW. The
                    // resolved prompt is stored once, in title (see buildRenderedImageWrap).
                    const escapedRawTag = escapeHtmlAttribute(rep.rawTag || '');
                    // Strip OFF (troubleshooting): REPLACE consumes the tag by definition, so
                    // "keep the tag" here means a VISIBLE ESCAPED copy under the image — readable
                    // placement + prompt, but &lt;pic…&gt; can't match the detection regex, so
                    // galgame's scene binding is never held back by it. Placed BEFORE the regen span so
                    // the context-swap wrap regex (…</span></span>) still swallows the whole wrap.
                    const debugTagLine = (prof.stripPicTag === false)
                        ? `<code class="auto-img-pictag" style="display:block;font-size:0.75em;opacity:0.65;overflow-wrap:anywhere;">${escapedRawTag}</code>`
                        : '';
                    const newImageTag = buildRenderedImageWrap({ escapedRawTag, escapedUrl, escapedPrompt, debugTagLine });
                    const res = spliceTagIntoMessage(message.mes, rep.rawTag, newImageTag);
                    if (!res.spliced) {
                        // The anchor is gone entirely — another pass rewrote the tag away while we
                        // generated. Never guess an offset: report it, leave the message intact.
                        log.error(`msg ${mesId} — the <pic> anchor disappeared while generating, so the finished image was NOT attached (image kept on disk: ${rep.imageUrl}). Tag: ${rep.rawTag.slice(0, 100)}`);
                        continue;
                    }
                    message.mes = res.text;
                    if (!notedThisPass) { forgetRenderedImages(mesId); notedThisPass = true; }
                    noteRenderedImage(mesId, rep.rawTag, newImageTag, rep.imageUrl);
                    consumedTags.push(rep.rawTag);
                }
            }

            // LEFTOVER <pic> DISPOSITION (REPLACE mode) — detectTags slices to maxImagesPerReply and
            // never revisits the overflow, and a failed generation is `continue`d past — so the cap and
            // gen failures both leave their <pic> un-replaced. A finalized reply must carry ZERO raw
            // <pic>: in plain ST it is invisible noise, but the galgame beat-shaper reads the RAW
            // message and holds its backdrop binding while one remains (4 pics over a cap of 2 leave 2
            // leftovers and a blank stage). Leftovers = what detection saw at pass START minus
            // what this pass spliced, each handled by exact string — never a re-scan of a message that
            // now holds our rendered HTML, and never a string this pass did not detect
            // (disposeLeftoverPicTags). Duplicate identical tags are a multiset: one drawn, one over
            // cap ⇒ one entry survives, and its indexOf can only hit the raw one.
            let sweptLeftover = false;
            if (sweepLeftovers && insertType === INSERT_TYPE.REPLACE) {
                const remaining = [...detectedAtStart];
                for (const used of consumedTags) {
                    const at = remaining.indexOf(used);
                    if (at !== -1) remaining.splice(at, 1);
                }
                if (remaining.length) {
                    const keepVisible = prof.stripPicTag === false;
                    const r = disposeLeftoverPicTags(message.mes, remaining, { keepVisible, escapeAttr: escapeHtmlAttribute });
                    if (r.swept.length) {
                        message.mes = r.text;
                        sweptLeftover = true;
                        log.lifecycle(keepVisible
                            ? `${r.swept.length} leftover un-rendered <pic> tag(s) kept VISIBLE as escaped text (strip OFF) — galgame-safe, readable in-chat`
                            : `${r.swept.length} leftover un-rendered <pic> tag(s) (over-cap / failed) replaced by their invisible trace, so the galgame beat-shaper can bind backdrops`);
                    }
                    if (r.missing.length) log.domain('imagegen', 'verbose', `${r.missing.length} leftover tag(s) already gone from msg ${mesId} by sweep time (another pass removed them) — nothing to do`);
                    if (r.skipped.length) log.domain('imagegen', 'verbose', `${r.skipped.length} un-drawn <img prompt=…> tag(s) left in msg ${mesId} as written — only a raw <pic> holds galgame back, and an <img> is not ours to remove`);
                }
            }

            // STRIP (checkbox): after successful INLINE/NEW generations, each consumed tag leaves the visible
            // reply and galgame's parser, and its invisible trace stays in its place — the record of who was
            // drawn in what clothes (buildTagTraceWrap), which the narrator sees again as its <pic>. OFF = the
            // tag stays visible for troubleshooting. Failed generations always keep their tag (visible failure +
            // regen path).
            let stripped = false;
            if (prof.stripPicTag !== false && insertType !== INSERT_TYPE.REPLACE) {
                const r = replaceTagsWithTraces(message.mes, generatedTags, escapeHtmlAttribute);
                if (r.traced.length) { message.mes = r.text; stripped = true; }
            }

            // The text changed ⇒ hand the edit to the reply redraw. An INLINE/NEW insert attaches its image
            // without touching `mes` at all, and that still has to persist, so it hands over a save alone.
            // While the turn runs, both are written with its other edits when it ends; afterwards, now.
            const textChanged = replaceResults.length > 0 || stripped || sweptLeftover;
            if (textChanged) await redrawReply(message, mesId, 'imagegen draw pass');
            else if (okCount > 0) await saveRedrawnReply(message, mesId, 'imagegen draw pass');

            // okCount already counts EVERY attached image (INLINE/REPLACE/NEW alike);
            // replaceResults is the REPLACE subset — summing would double-count REPLACE.
            if (okCount > 0) {
                toast('success', `${okCount} image(s) generated`);
            } else {
                toast('warning', 'Image generation produced no image — see console for details.');
            }
        } catch (error) {
            toast('error', `Image generation error: ${error}`);
            log.error('Image generation error:', error);
        }
}

// <pic> disposition when NOT drawing (Insert Type "Tags only"): no GPU, so we either STRIP the tags —
// each leaves its invisible trace, so the message is clean for galgame's parser + the display and still
// records who was drawn in what (stripPicTag !== false, default) — or KEEP them raw for in-chat debugging
// (stripPicTag === false). Either way each prompt is logged to
// log.domain('imagegen') — the always-on console debug channel, independent of the in-chat toggle. A
// strip goes to the reply redraw, whose write emits MESSAGE_UPDATED, so the galgame beat-shaper re-reads
// and shapes (its held-back scene binding runs once no raw <pic> remains).
async function disposePicTagsNoDraw(message, mesId, prof, tags) {
    for (const t of tags) log.domain('imagegen', 'verbose', `<pic> (not drawn) prompt: ${t.prompt}`);
    if (prof.stripPicTag === false) return;             // KEEP raw for debug — no write
    if (getContext().chat[mesId] !== message) return;   // swiped / regenerated away — leave it
    const r = replaceTagsWithTraces(message.mes, tags.map((t) => t.rawTag), escapeHtmlAttribute);
    if (!r.traced.length) return;
    message.mes = r.text;
    await redrawReply(message, mesId, 'imagegen no-draw strip');
}

eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);

// ── the picture task: who writes the reply's <pic> tags (plans/executed/picture-writer-route.md) ──
// A routed task of the LLM-task router, dormant while the narrator writes the pictures (imageDuties pictureCall
// is ''): the narrator's picture rules go in at prompt-ready above, in the two places they need, and its tags are
// drawn at MESSAGE_RECEIVED. While a POST call writes them, the router routes the reader contract to that call,
// has its input numbered and closed by <picture_count> here, and hands its output back here. No Off: Insert Type =
// Disable turns pictures off.
// Registered BEFORE the look task: the router hands a POST call's output to its tasks in registration order, and
// registration reads the drawn names from the message, so the pictures are placed first (D7).
export const PICTURES_TASK_ID = 'imagegen-pictures';

// The numbered copy the picture call read, per reply, until its output is placed (D4): message id → { message,
// swipe, lines }. Cleared on a chat change.
const numberedPictureCopies = new Map();

// What the picture call reads: the reply, after the call's own input filter, with its lines numbered
// (picture-placement-core numberReplyLines), then the reader <picture_count> (default-template readerPictureInput).
// The numbered copy is kept for the placement.
function pictureCallInput({ text, messageId, callName }) {
    const numbered = numberReplyLines(text);
    const chat = getContext().chat;
    const message = messageId != null && Array.isArray(chat) ? chat[messageId] : null;
    if (message) numberedPictureCopies.set(Number(messageId), { message, swipe: swipeOf(chat, messageId), lines: numbered.lines });
    log.domain('imagegen', 'lifecycle', `${callName}: ${numbered.lines.length} line(s) of msg ${messageId} numbered for the picture task, <picture_count> after them`);
    return readerPictureInput(numbered.text, imageCap(), (block) => expandPromptMacros(block, 'imagegen'));
}

// Why a picture was not placed (picture-placement-core placePictures), in the warning's words.
const PLACEMENT_MISS_WORDS = {
    'no-at': () => 'it names no line (no at=)',
    'not-a-number': (written) => `its at="${written}" is not a line number`,
    'out-of-range': (written, lineCount) => `its at="${written}" is outside the ${lineCount} numbered line(s) the call read`,
    'line-gone': (written) => `line ${written} is no longer in the reply: its text changed after the call read it`,
};

// The picture call's output (the router's POST capture, D6): its tags placed under the lines they name and its
// one-off clothes records beside the narrator's — read and written in one step, handed to the reply redraw — then the
// placed tags go through the one draw flow, which announces the drawing so the turn's write waits for it (D9). The
// drawing runs on: this returns once it is scheduled, or its tags parked for registration, whose capture comes next.
async function onPictureOutput(rawText, meta) {
    const mesId = Number(meta.messageId);
    const callName = meta.target;
    const copy = numberedPictureCopies.get(mesId);
    numberedPictureCopies.delete(mesId);
    if (!copy) {
        log.warn(`msg ${mesId}: POST call "${callName}" answered for the pictures, but no numbered copy of the reply was kept — its input was never numbered (a warning above says why). No picture this reply.`);
        return;
    }
    const chat = getContext().chat;
    if (!Array.isArray(chat) || chat[mesId] !== copy.message || swipeOf(chat, mesId) !== copy.swipe) {
        log.domain('imagegen', 'lifecycle', `msg ${mesId}: swiped, regenerated or deleted while POST call "${callName}" ran — its pictures are dropped`);
        return;
    }
    const tags = allTags(String(rawText || ''));
    if (!tags.length) {
        // ZERO TAGS IS A CONTRACT BREACH, as on the narrator route (drawReplyTags): every reply is asked for one. Said by
        // cause: a call that gave no text (the POST pass warns when it failed or timed out, and leaves an answer with no
        // text from a call carrying only tasks to its tasks, this one included), or one that answered without a tag.
        if (!String(rawText || '').trim()) log.domain('imagegen', 'lifecycle', `msg ${mesId}: the picture call "${callName}" gave no text — no picture this reply (a [POST] warning says so when the call failed or timed out)`);
        else log.domain('imagegen', 'lifecycle', `msg ${mesId}: the picture call "${callName}" answered without a <pic> — it did not follow the picture contract this reply (no picture)`);
        return;
    }
    const { records } = readCastRecords(rawText);
    const oneOffs = oneOffClothesRecords(records);
    if (oneOffs.length < records.length) {
        log.domain('imagegen', 'verbose', `msg ${mesId}: ${records.length - oneOffs.length} record(s) from POST call "${callName}" left out — it is asked only for one-off clothes (outfit="${OUTFIT_NEW_CLOTHES}")`);
    }
    const message = copy.message;
    const plan = placePictures(message.mes, { copyLines: copy.lines, rawTags: tags.map((t) => t.rawTag), records: oneOffs.map((r) => r.raw) });
    for (const miss of plan.misses) {
        log.warn(`msg ${mesId}: a picture from POST call "${callName}" was not placed — ${PLACEMENT_MISS_WORDS[miss.cause](miss.written, copy.lines.length)}: ${miss.rawTag}`);
    }
    if (!plan.placed.length) return;
    message.mes = plan.text;
    plan.placed.forEach((p, i) => log.domain('imagegen', 'lifecycle', `pic ${i + 1} at=${p.line} → under line ${p.line} 「${p.lineText}」`));
    redrawReply(message, mesId, 'imagegen picture placement')
        .catch((e) => log.warn(`msg ${mesId}: the placed pictures are in the reply's text but could not be handed to the reply redraw:`, e));
    await drawReplyTags(message, mesId, callName);
}

registerLlmTask({
    id: PICTURES_TASK_ID,
    label: 'Pictures written by',
    tag: 'picture_writing',
    allow: ['narrate', 'post'],       // PRE excluded — the story does not exist yet
    offersOff: false,
    instruction: ({ messageId }) => readerPictureContractFor(messageId),
    // getTarget = the stored choice (what the picker shows); the task runs only while that is a POST call.
    getTarget: () => getImagegenProfile().picturesVia || 'narrate',
    setTarget: (v) => { getImagegenProfile().picturesVia = String(v || '').trim() || 'narrate'; saveSettingsDebounced(); },
    getActiveTarget: () => currentDuties().pictureCall,
    isActive: () => currentDuties().pictureCall !== '',
    shapeInput: pictureCallInput,
    // R1: no POST call while Harvest via is the narrator (prompt-assembly-core isPictureWriterOffered).
    offers: (target) => isPictureWriterOffered(target, getImagegenProfile().charimgVia),
    onOutput: onPictureOutput,
});
eventSource.on(event_types.CHAT_CHANGED, () => { numberedPictureCopies.clear(); });

// ── the look task: who describes a character's look (plans/reply-cast.md §4) ──
// A routed task of the LLM-task router. Who runs it this turn is imageDuties's lookTarget: the "Harvest
// via" target while looks are stored, else the narrator while pictures need looks, else nobody. The
// dropdown shows the stored Harvest via preference, which getTarget returns. The narrator gets its text
// at prompt-ready; a POST call's routing entry carries a token the POST pass resolves per turn, so the
// POST text is built from THIS reply's cast against the registry (readerRegistrationContract). The chosen
// call's raw output comes back here; harvest.js stores its looks when looks are stored.
// The id and the `charimgVia` setting keep their persisted names: the id is the routing entry's needle
// in every card's lorebook, and charimgVia is stored in every profile.
export const CHARIMG_TASK_ID = 'imagegen-charimg';

// The reply message's text with rendered images reverted to their <pic> tags; '' when the message is gone.
function replyTextWithPicTags(messageId) {
    const message = messageId != null ? getContext().chat[messageId] : null;
    if (!message) return '';
    return revertRenderedImagesToPicTags(message.mes, unescapeHtmlAttribute).text;
}

// Every <pic> in a text as its drawn names: ONE ENTRY PER PIC, each holding that pic's slots in order — not
// a flat list, which cannot say how many pics were drawn (`<pic char=A char2=B>` plus `<pic char=A>`
// flattens to "A, A, B", which reads as three pics).
function drawnPicsOf(text) {
    return detectTags(text).map((t) => picSlots(t.rawTag).map((slot) => slot.key));
}

// The reply cast of reply `messageId` (its records plus everyone its <pic> tags draw) against the registry:
// { names, cast } (reply-cast-core classifyReplyCast). A name the user's own character goes by is nobody in
// it. A reply that is gone has the empty cast.
async function replyCastOf(messageId) {
    const text = replyTextWithPicTags(messageId);
    const { records } = readCastRecords(text);
    const names = replyCastNames(records, drawnPicsOf(text).flat());
    let entries = [];
    try { entries = await listCharEntries(); }
    catch (e) { log.child('registration').warn('could not read the registry — every name in the reply reads as new this turn:', e); }
    return { names, cast: classifyReplyCast(names, entries, uncastNamesFor(entries)) };
}

// The POST call's registration text for reply `messageId`, built from its reply cast: the call is never
// asked to register the user's own character or to add their outfits.
async function readerRegistrationFor(messageId) {
    const { names, cast } = await replyCastOf(messageId);
    log.child('registration').domain('roster', 'verbose', `msg ${messageId} cast ${names.length ? names.join(', ') : '(nobody)'} → `
        + `${cast.registered.length} registered, ${cast.newcomers.length} new${cast.newcomers.length ? ` (${cast.newcomers.join(', ')})` : ''}`
        + `${cast.uncast.length ? `, ${cast.uncast.length} the user's own character, not asked about (${cast.uncast.join(', ')})` : ''} — `
        + `${cast.newcomers.length ? 'full rules' : 'short rules'}`);
    return readerRegistrationContract(cast);
}

// `<charImage>` is retired (plans/reply-cast.md D11): nothing reads it. A model still writing one is
// following a stale instruction, so it is named once per chat instead of vanishing without a word.
const LEGACY_REGISTRATION_TAG = /<charImage\b/i;
const legacyTagWarnedChats = new Set();
function warnLegacyRegistrationTag(text) {
    if (!LEGACY_REGISTRATION_TAG.test(String(text || ''))) return;
    const chatId = String(getContext().chatId || '');
    if (legacyTagWarnedChats.has(chatId)) return;
    legacyTagWarnedChats.add(chatId);
    log.child('registration').warn('the output carries a retired <charImage> tag — it is IGNORED. Registration is now written as cast records; the model is following an old instruction (a stale custom prompt, or a routing entry not yet rewritten — changing chats rewrites it).');
}

// The chosen call's output. For a narrate target the records sit in the reply text and stay there as
// written; for a POST target they sit in the POST call's own output. Looks are stored only while the
// route is auto-harvest with a Harvest via target; otherwise they dress this reply's pictures, read straight
// from the reply, and only their clothes carry to later pictures (the worn-outfit store, "same-as-last-picture").
async function onRegistrationOutput(rawText, meta) {
    warnLegacyRegistrationTag(rawText);
    if (currentDuties().stores) {
        // The pics the reply drew. A narrate target's output IS the reply. A POST call's output is not, so
        // its pics are read off the reply message, with every image already rendered reverted to the <pic>
        // it came from — the draw pass may have landed some of them before this capture.
        const picText = meta.phase === 'narrate' ? rawText : replyTextWithPicTags(meta.messageId);
        await harvestCastRegistrations(rawText, {
            drawnPics: drawnPicsOf(picText),
            informedNames: informedNamesOfLastPrompt(),
            isChangeReport: meta.phase === 'post',
            oneOffNames: oneOffNamesOf(detectTags(picText).map((t) => t.rawTag)),
            // What each one-off picture drew, read as the store reads it: a record's clothes for her become these (D40).
            drawnOneOffs: drawnOneOffClothesOf(await wornReportsThrough(meta.messageId, allTagStrings(replyTextWithPicTags(meta.messageId)))),
            // Who the POST call was asked to register, read before anything this reply registers: the harvest warns
            // for each one it leaves without a look. Its answer may be empty when nobody needed anything.
            askedNewcomers: meta.phase === 'post' ? (await replyCastOf(meta.messageId)).cast.newcomers : [],
        });
        // On the POST route the narrator's own records stay in the reply: a character with only her [Body] on file
        // keeps her first clothes from them (D29), after the POST call's own registrations are on file. A failure
        // here is reported and never stops the parked pictures' drain below.
        if (meta.phase === 'post') {
            try { await keepFirstClothesFromReply(picText); }
            catch (e) { log.child('registration').error('keeping first clothes from the reply\'s own records failed:', e); }
        }
    } else {
        log.child('registration').domain('roster', 'verbose', `msg ${meta.messageId}: looks in this reply are not stored (Appearance route is "Predefined only", or Harvest via is Off) — they dress its pictures, and later pictures carry only their clothes.`);
    }
    await removeStrayCastClosers(meta.messageId);
    // POST capture done ⇒ every registration this reply produces is now on file. Drain the parked
    // pics — UNCONDITIONALLY, not only when something was stored: "no registration in the output" also
    // means no more looks are coming this turn, and a parked tag must then render from the scene alone
    // rather than hang until the fallback timer.
    if (meta.phase === 'post') void drainPostHarvestParked('registration capture');
}

// STRAY CLOSERS ONLY (D15), from the narrator's reply on either route. The narrator writes its records in the reply
// whichever call registers the looks, and a closer left there is in the next prompt's history, where the narrator
// copies it. Records stay in the text as written; a closer carries nothing, and an unfinished one swallows the page
// after it. The closers are read from the message as it is NOW, never from the call's output: on the narrate route
// that output was captured before the harvest's await, while the image splice writes this same message, and on the
// POST route it is not the reply at all. Removed by exact string.
async function removeStrayCastClosers(messageId) {
    if (messageId == null) return;
    try {
        const m = getContext().chat[messageId];
        if (!m || m.is_user) return;
        const { strayMarkup } = readCastRecords(m.mes);
        if (!strayMarkup.length) return;
        const cut = removeTagsPinpoint(m.mes, strayMarkup);
        if (!cut.removed.length) return;
        m.mes = cut.text;
        log.child('harvest').domain('roster', 'verbose', `msg ${messageId}: removed ${cut.removed.length} stray </cast> closer(s) — a record is self-contained and never takes one.`);
        await redrawReply(m, messageId, 'stray </cast> closer removal');
    } catch (e) { log.child('registration').error(`msg ${messageId}: removing stray </cast> closers failed — they stay in the reply:`, e); }
}

registerLlmTask({
    id: CHARIMG_TASK_ID,
    label: 'Character-image registration via',
    // The wrapper around the instruction in the prompt. Not `cast`: a paired <cast>…</cast> there would
    // teach the closer the record format forbids.
    tag: 'character_registration',
    allow: ['narrate', 'post'],       // PRE excluded — describing a look before the reply exists is nonsensical
    instruction: ({ phase, messageId }) => (phase === 'narrate'
        ? narrateRegistrationContract({ isStoring: currentDuties().stores })
        : readerRegistrationFor(messageId)),
    // getTarget = the STORED Harvest via preference (what the dropdown shows); '' = Off. getActiveTarget =
    // who runs it this turn, which can be the narrator while the preference is Off (pictures need looks).
    getTarget: () => getImagegenProfile().charimgVia || '',
    setTarget: (v) => { getImagegenProfile().charimgVia = String(v || ''); saveSettingsDebounced(); },
    getActiveTarget: () => currentDuties().lookTarget,
    // R1: not the narrator while a POST call writes the pictures (prompt-assembly-core isHarvestTargetOffered).
    offers: (target) => isHarvestTargetOffered(target, getImagegenProfile().picturesVia),
    onOutput: onRegistrationOutput,
});

initLlmTaskRouter();

// The roster owns the route setting; drawing owns the consequences of it changing. Registering here
// (instead of roster-ui calling us) is what keeps character-roster/ from importing imagegen/.
// The DROPDOWN repaint on route change is a UI concern and self-registers in image-settings-ui.js.
onRouteChange(() => {
    void syncImageTaskRouting();   // the look task's target follows the route: a POST target gains or loses its entry
});

// Re-sync both image tasks' routing entries after a state change that alters who runs them (route, Harvest via,
// Insert Type, Pictures written by). Exported so the settings handlers call it; safe no-op when the book isn't
// writable yet.
export function syncImageTaskRouting() {
    return Promise.all([applyTaskRouting(CHARIMG_TASK_ID), applyTaskRouting(PICTURES_TASK_ID)]);
}
