// character-roster/reply-cast-prompt.js — the reply cast's prompt half: the narrator's <reply_cast>
// block (who is present, and who is ON FILE), the presence scan and the lorebook activations it is built from, and
// the same ON FILE list for a POST call that writes the pictures. The pure halves are reply-cast-core.js (the list
// and the wording) and roster-scan-core.js (the scan).
//
// THE ROSTER OWNS THE CAST LINE, and features that read <cast> records ask for it. A feature declares
// when it needs the records and what it asks for on them (requestReplyCast); the block is sent on every
// prompt where any of them needs it, and on no other. That keeps this feature free of imports from the
// features that read it.

import { eventSource, event_types } from '../../../../../../../script.js';
import { createModuleLog } from '../../sillytavern/log.js';
import { chatContext } from '../../sillytavern/chat-context.js';
import { expandPromptMacros } from '../../sillytavern/prompt-macros.js';
import { getMvu, latestMsgId } from '../../sillytavern/mvu-bridge.js';
import { ownStatPart } from '../../sillytavern/mvu-bridge-core.js';
import { generationStartingState } from '../../shared/generation-floor.js';
import { breakTemplateOpeners } from '../../shared/rendered-region.js';
import { stripStatBoxFromText } from '../statbox/index.js';
import { stripLeadAndEndText } from '../logic-engine/index.js';
import { getRosterProfile } from './roster-settings.js';
import { presentCharKeys, allCharKeys } from './roster-scan-core.js';
import { listCharEntries } from './character-registry.js';
import { listOutfitVariants, listAliases, hasStoredAppearance, lastPictureOutfitsIn, WORN_OUTFIT_PART } from './dna-core.js';
import { onFileCast, onFileListText, namedKeysOf, activatedKeysOf, lorebookKeysOf, replyCastInstruction, uncastNamesOf, userLastPictureWear, userOutfitsOnFile, USER_MAINCHAR_LABEL } from './reply-cast-core.js';

const log = createModuleLog('character-roster');

// How many trailing chat messages count as "the story is with her" — the characters named in them (or present) are
// the only ones ON FILE offers "same-as-last-picture" (the user's own character aside: the story is always with him). Ten ≈ five exchanges: clothes she wore a scene ago are
// still worth offering, while a one-off from days of story earlier is not, and is not printed every turn. A
// constant, not a setting: a knob nobody needs is one more thing to misconfigure.
const RECENT_MESSAGES = 10;

// consumer id → { isNeeded, uncastKeys, recordAsks }: "this feature reads this reply's <cast> records".
const castConsumers = new Map();

/**
 * Declare that a feature reads the narrator's <cast> records. `isNeeded()` is asked on every prompt;
 * the block is sent when any consumer answers true. `uncastKeys()` names registry keys that never take a
 * cast record (the user's own character's entry): the ON FILE list never offers them a record — their outfits are
 * printed on a line of their own, for mainchar= — and the key and its entry's aliases are printed as names that
 * take no record (uncastNamesFor). `recordAsks()`
 * returns the attributes the feature asks for on a record this prompt, one line each; they are printed
 * inside <reply_cast>, whose format rules allow only what is asked for there. Registering the same id
 * again replaces it.
 */
export function requestReplyCast(consumerId, isNeeded, { uncastKeys = () => [], recordAsks = () => [] } = {}) {
    const id = String(consumerId || '').trim();
    if (!id || typeof isNeeded !== 'function') { log.warn(`a reply-cast consumer needs an id and a function — "${id}" ignored`); return; }
    castConsumers.set(id, {
        isNeeded,
        uncastKeys: typeof uncastKeys === 'function' ? uncastKeys : () => [],
        recordAsks: typeof recordAsks === 'function' ? recordAsks : () => [],
    });
}

// The consumers that need the block on this prompt. A throwing consumer is reported and counts as not
// needing it, so one broken feature never sends — or blocks — the block for the others.
function consumersNeedingCast() {
    const out = [];
    for (const [id, consumer] of castConsumers) {
        try { if (consumer.isNeeded()) out.push(id); }
        catch (e) { log.warn(`reply cast: consumer "${id}" threw while asked whether it needs the cast — counted as not needing it:`, e); }
    }
    return out;
}

// Every consumer's registry keys that never take a cast record. A throwing consumer is reported and adds none.
function uncastKeysOfConsumers() {
    const out = [];
    for (const [id, consumer] of castConsumers) {
        try { out.push(...(consumer.uncastKeys() || [])); }
        catch (e) { log.warn(`reply cast: consumer "${id}" threw while naming its uncast keys — none taken from it:`, e); }
    }
    return out;
}

/**
 * The names the user's own character goes by (reply-cast-core uncastNamesOf): the persona name, then every
 * consumer's uncast key with its entry's aliases in `entries` (the registry as [{ key, content }]). The
 * <reply_cast> block prints them; classifyReplyCast and the harvest drop a record under one of them.
 */
export function uncastNamesFor(entries) {
    const ctx = chatContext('reply-cast');
    return uncastNamesOf({ entries, uncastKeys: uncastKeysOfConsumers(), personaName: ctx ? ctx.name1 : '' });
}

// The record attributes asked for this prompt, by the consumers that need the block on it. A throwing
// consumer is reported and asks for nothing, so the block still goes out for the others.
function recordAsksOfConsumers(neededIds) {
    const out = [];
    for (const id of neededIds) {
        const consumer = castConsumers.get(id);
        if (!consumer) continue;
        try { out.push(...(consumer.recordAsks() || [])); }
        catch (e) { log.warn(`reply cast: consumer "${id}" threw while naming what it asks for on a record — nothing asked for it this prompt:`, e); }
    }
    return out;
}

// ── presence scan (the game state's own word on who is on screen) ────────────────────────────
// { present, all } character keys from the newest message's stat_data, by shape discovery
// (roster-scan-core). Empty on a card with no stat_data or no usable presence field.
export function readSceneRoster() {
    try {
        const Mvu = getMvu();
        const id = latestMsgId();
        if (!Mvu || typeof Mvu.getMvuData !== 'function' || id < 0) return { present: [], all: [] };
        const data = Mvu.getMvuData({ type: 'message', message_id: id });
        const sd = data && data.stat_data;
        if (!sd || typeof sd !== 'object') return { present: [], all: [] };
        const roster = getRosterProfile();
        const override = roster.charCollection || undefined;
        const field = roster.presenceField || undefined;   // undefined ⇒ core default 'Is_present'
        return { present: presentCharKeys(sd, override, field), all: allCharKeys(sd, override, field) };
    } catch (e) {
        log.child('readSceneRoster').warn('could not read stat_data (no presence this turn):', e);
        return { present: [], all: [] };
    }
}

// The chat open now, by SillyTavern's id; '' when there is none. What this file keeps for one chat is kept under it.
function currentChatId() {
    const ctx = chatContext('reply-cast');
    return String((ctx && typeof ctx.getCurrentChatId === 'function' && ctx.getCurrentChatId()) || '');
}

// THE MENTION SCAN, one answer per chat message: the registered characters each message names (namedKeysOf),
// kept per chat so a prompt build scans only the messages that are new or changed since the last build. Every
// prompt build runs this, dry runs included, and a whole-chat rescan costs ~55 ms per 200 messages and grows with
// the chat. A message's answer changes only when its text does, or when the registry's names do (an alias added, a
// character registered) — the names signature then drops the cache. [] on failure: listing nobody costs one extra
// description, while guessing at the chat would cost a wrong list. The stat box is stripped: it names every member
// whose stats moved, in the scene or not, and a name in a stat summary is not a mention. So is the engine's lead and
// end text, written from state (a venue label can carry a name) rather than by the narrator.
const mentionCache = { chatId: '', namesSignature: '', messages: [] };   // messages[i] = { mes, keys }
function namedKeysPerMessage(rosterEntries) {
    const ctx = chatContext('reply-cast');
    const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
    const chatId = currentChatId();
    const namesSignature = rosterEntries.map((e) => e.key + '=' + e.names.join('|')).join('\n');
    if (mentionCache.chatId !== chatId || mentionCache.namesSignature !== namesSignature) {
        mentionCache.chatId = chatId;
        mentionCache.namesSignature = namesSignature;
        mentionCache.messages = [];
    }
    if (mentionCache.messages.length > chat.length) mentionCache.messages.length = chat.length;
    return chat.map((m, i) => {
        const mes = String((m && m.mes) || '');
        const known = mentionCache.messages[i];
        if (known && known.mes === mes) return known.keys;
        const keys = namedKeysOf(rosterEntries, stripLeadAndEndText(stripStatBoxFromText(mes)));
        mentionCache.messages[i] = { mes, keys };
        return keys;
    });
}

// THE LOREBOOK ENTRIES ACTIVATED FOR THE GENERATION IN PROGRESS: their primary keys (lorebookKeysOf) and the chat they
// were scanned in. SillyTavern reports them when its lorebook scan is done (WORLD_INFO_ACTIVATED), before it assembles
// the prompt <reply_cast> joins, so they are this prompt's own. It reports nothing when no entry activates, so every
// real generation starts from none and never inherits the last one's. A dry run changes neither: SillyTavern reports
// nothing for it, and it only counts tokens. A POST call that writes the pictures reads the same keys after the reply,
// because mvu-helper's own calls run no lorebook scan. SillyTavern's entries are read here, never written.
let activatedLorebook = { chatId: '', keys: [] };
if (event_types.WORLD_INFO_ACTIVATED) {
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (activatedEntries) => {
        activatedLorebook = { chatId: currentChatId(), keys: lorebookKeysOf(activatedEntries) };
    });
} else {
    log.warn('this SillyTavern does not emit WORLD_INFO_ACTIVATED, so ON FILE never lists a character for a lorebook entry '
        + 'keyed on her name — only for being named in the chat or present.');
}

// The primary keys of the lorebook entries activated for this chat's generation in progress, or its last one; [] when
// they were scanned in another chat.
function activatedLorebookKeys() {
    return activatedLorebook.chatId === currentChatId() ? activatedLorebook.keys : [];
}

// The type of the generation the next prompt is built for (SillyTavern's GENERATION_STARTED type). A dry run is a
// token count, never a generation.
let generationType = '';
eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
    if (dryRun) return;
    generationType = String(type || '');
    activatedLorebook = { chatId: currentChatId(), keys: [] };
});

// What the worn-outfit store holds ([{ key, outfit, clothes }], lastPictureOutfitsIn), in the state this prompt's
// reply starts from (generationStartingState: a swipe never reads the take it replaces). [] when that state holds
// no store.
function lastPicturesAtReplyStart() {
    const ctx = chatContext('reply-cast');
    const chat = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
    const start = generationStartingState(chat, generationType);
    return start ? lastPictureOutfitsIn(ownStatPart(start.statData, WORN_OUTFIT_PART)) : [];
}

// The characters the LAST real prompt listed ON FILE — the INFORMED set (dna-core mayStoryReplaceClothes).
// null = no prompt has been measured, which a harvest reads as "everyone informed": unknown must never
// authorise overwriting stored clothes.
let informedThisPrompt = null;

/** The ON FILE keys of the last prompt that was sent, or null when none was measured. */
export function informedNamesOfLastPrompt() {
    return informedThisPrompt;
}

// The ON FILE cast as the chat stands now (onFileCast): who is listed, what "same-as-last-picture" offers each
// (the store as it stood when the reply began), and the user's own character's outfits. The narrator's prompt and a
// POST call that writes the pictures read the same list. `activatedKeys` are the registry keys an activated lorebook
// entry is keyed on, for the log.
async function onFileNow() {
    let entries = [];
    try { entries = await listCharEntries(); }
    catch (e) { log.warn('reply cast: could not read the registry — ON FILE is empty this time:', e); }
    const rosterEntries = entries.map((e) => ({ key: e.key, names: [e.key, ...listAliases(e.content)], variants: listOutfitVariants(e.content), hasLook: hasStoredAppearance(e.content) }));
    const perMessage = namedKeysPerMessage(rosterEntries);
    const activatedKeys = activatedKeysOf(rosterEntries, activatedLorebookKeys());
    const uncastKeys = uncastKeysOfConsumers();
    const lastPictures = lastPicturesAtReplyStart();
    const onFile = onFileCast({
        entries: rosterEntries,
        namedKeys: perMessage.flat(),
        recentKeys: perMessage.slice(-RECENT_MESSAGES).flat(),
        presentKeys: readSceneRoster().present,
        activatedKeys,
        uncastKeys,
        lastPictures,
    });
    const userWear = userLastPictureWear({ entries: rosterEntries, uncastKeys, lastPictures });
    const userOutfits = userOutfitsOnFile({ entries: rosterEntries, uncastKeys });
    return { entries, onFile, userWear, userOutfits, activatedKeys };
}

/**
 * The ON FILE list for a POST call that writes the pictures (plans/executed/picture-writer-route.md D5): the list the
 * narrator's <reply_cast> carries, read after the reply, so a character the reply names is on it.
 */
export async function onFileListForPictureCall() {
    const { onFile, userWear, userOutfits } = await onFileNow();
    return onFileListText(onFile, userWear, userOutfits);
}

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async function (eventData) {
    try {
        if (!eventData || !Array.isArray(eventData.chat)) return;
        const isDryRun = eventData.dryRun === true;
        const consumers = consumersNeedingCast();
        if (!consumers.length) {
            if (!isDryRun) informedThisPrompt = null;
            return;
        }
        const { entries, onFile, userWear, userOutfits, activatedKeys } = await onFileNow();
        const userNames = uncastNamesFor(entries);
        // Its {{user}} lines expanded (prompt-macros.js): nothing expands a block added at prompt-ready. The
        // outfits it lists are stat_data, so a template opener among them is broken (breakTemplateOpeners).
        const block = replyCastInstruction(onFile, recordAsksOfConsumers(consumers), userNames, userWear, userOutfits);
        const guarded = breakTemplateOpeners(expandPromptMacros(block, 'character-roster'));
        if (guarded.broken) log.warn(`the cast block carried ${guarded.broken} template opener(s) "<%" from its stat_data — sent as "< %" so the prompt's template pass runs none of it`);
        eventData.chat.push({ role: 'system', content: guarded.text });
        // DRY RUNS ARE NOT MEASUREMENTS. SillyTavern rebuilds this prompt with dryRun=true to count tokens,
        // and those rebuilds land AFTER the reply — its own prose is then in the mention scan, so every
        // character it named reads as listed, and the harvest at the end of the turn would judge a prompt
        // that was never sent. The block is still injected on a dry run, so the token count is honest.
        if (isDryRun) return;
        informedThisPrompt = onFile.map((e) => e.key);
        const withLook = entries.filter((e) => hasStoredAppearance(e.content)).length;
        const offered = onFile.filter((e) => e.lastPictureWear).map((e) => `${e.key} (${e.lastPictureWear})`);
        if (userWear) offered.push(`${USER_MAINCHAR_LABEL} (${userWear})`);
        log.domain('roster', 'verbose', `reply cast asked (for ${consumers.join(', ')}); ON FILE ${informedThisPrompt.length} of ${withLook} with a look on file`
            + (informedThisPrompt.length ? ` — ${informedThisPrompt.join(', ')}` : '')
            + (activatedKeys.length ? `; a lorebook entry in this prompt is keyed on a name of: ${activatedKeys.join(', ')}` : '')
            + (userOutfits.length ? `; ${USER_MAINCHAR_LABEL} on a line of his own: ${userOutfits.join(', ')}` : '')
            + (offered.length ? `; "same-as-last-picture" offered for ${offered.join(', ')}` : '')
            + `; the user's own character, never cast: ${userNames.length ? userNames.join(', ') : '(no name known)'}`
            + ` (ON FILE: named anywhere in this chat, present, or a lorebook entry in this prompt is keyed on a name of theirs; "same-as-last-picture": named in the last ${RECENT_MESSAGES} messages or present, and the user's own character whenever the store holds what he wore). A narrator registration of a listed character never replaces her clothes.`);
    } catch (e) {
        log.error('reply cast injection failed — this prompt carries no <reply_cast>:', e);
    }
});
