// imagegen/prompt-assembly-core.js — the image pipeline's PURE decisions and wording (no ST imports, no
// logger, no lorebook reads): what a card's settings make the pipeline do, who a <pic> draws, and the
// exact string sent to /sd. The caller resolves each person's look and hands the pieces in.
// Tested by tests/prompt-assembly-core.test.js.
//
// ONE SHAPE FOR EVERY PROMPT: the scene, then each person's look (body, then clothes) opened by their name and
// wrapped in a tag of that name, then the main character's look last, wrapped in his:
//     <prefix>, <composition>. The person in the frame is <name>: [<name>] <body>, <clothes> [/<name>] The main character in the frame is [main character] <tags> [/main character]
// Several people read "<name> is: [<name>] <body>, <clothes> [/<name>]" one after another. The image backends
// encode text with an LLM, not 77-token CLIP, so they bind attributes to their subject: a naive concatenation
// of two looks bleeds (one person's leggings on the other, one face for both). Naming each look's owner is what
// keeps it apart, and the tag marks where it ENDS: measured on Krea2 (2026-10-16, ComfyUI, the staging two-girl
// bench scene, 12 seeds a variant), the tags with the composition calling him "the main character" (<camera>)
// drew both girls and him in 11-12 of 12, against 8 of 12 for the named sentences alone. A period inside a card's
// look text never ends that look early (lookText). The wording names no gender: what each person is comes from
// the first tag of their own look.
//
// POSITION IS THE COMPOSITION'S ALONE: these sentences name each person and never say where they stand.
// The narrator's composition places everyone by name, and a position here would be a second claim that
// contradicts it whenever the slot order differs ("Mitsuki in the middle" beside "the person on the LEFT
// is Mitsuki"). Slot order is only the order the sentences come in.
//
// HOW MANY PEOPLE: each drawn person's look is copied whole into the prompt, so each one is paid for in
// full (measured on a production card, ~300 tokens a person), and a Qwen3-class encoder binds attributes
// to subjects dependably for roughly a thousand tokens. The ceiling is the card's own setting ("Max
// characters per image"), with no limit in code, so a larger image model can take more.

import { CAMERA_CHOICES, MAINCHAR_NOT_IN_PICTURE, MAINCHAR_PROMPT_NAME, SCENE_ROSTER_PROMPT, tagAttr } from './default-template.js';
// DEEP IMPORT, deliberate: the character-roster barrel pulls in SillyTavern host modules, which cannot
// load under vitest, and this file is pure. dna-core.js is that feature's pure half and the one place the
// outfit= vocabulary is defined.
import { OUTFIT_NEW_CLOTHES } from '../character-roster/dna-core.js';
import { mentionsName } from '../../shared/name-mention.js';
import { isPrototypeKey } from '../../shared/object-path.js';
import { revertRenderedImagesToPicTags, removePastPictures } from './image-splice-core.js';

// ── what a card's settings make the pipeline do ──────────────────────────────────────────────
// Image Insert Type. Disabled sends nothing and draws nothing; every other value sends the <pic>
// instruction. Tags only logs and disposes of the tags without drawing — the way to see what the
// narrator writes with no GPU.
export const INSERT_TYPE = {
    DISABLED: 'disabled',
    TAGS_ONLY: 'tags',
    INLINE: 'inline',
    NEW_MESSAGE: 'new',
    REPLACE: 'replace',
};

// What the MESSAGE_RECEIVED pass does with a <pic> the narrator wrote (imageDuties narratorTagAction).
export const NARRATOR_TAG_ACTION = Object.freeze({
    DRAW: 'draw',                  // the narrator writes the pictures, and they are drawn
    DISPOSE: 'dispose',            // Tags only: each picture's prompt is logged, and the tag is disposed of
    DISPOSE_AS_STRAY: 'stray',     // a POST call writes the pictures: the narrator's tag is disposed of, unread
    IGNORE: 'ignore',              // no picture contract is sent, so a <pic> in the reply is not ours
});

// What the narrator's outgoing history shows of past pictures (imageDuties historyPictures). Prompt only: the
// messages are never changed.
export const HISTORY_PICTURES = Object.freeze({
    AS_TAGS: 'as-tags',            // rendered images turned back into their <pic> tags: the narrator sees examples
    REMOVED: 'removed',            // rendered images and <pic> tags removed: the narrator writes none, and one in its
                                   // history invites one
    AS_IS: 'as-is',                // no picture contract: the history is left as it is
});

// PURE, and the one place every image gate is decided. Image generation and harvest are independent:
// neither setting needs the other.
//   insertType   the Image tab's Insert Type.
//   route, via   the Roster tab's Appearance route and Harvest via: looks are STORED when the route is
//                auto-harvest and Harvest via names a target, whatever the Image tab says.
//   picturesVia  the Image tab's "Pictures written by": 'narrate' (the default, also when unset) or the name of
//                the POST call that writes the reply's <pic> tags.
// Returns:
//   sendsImageContract     the picture contract and its blocks are sent, to whoever writes the pictures
//   pictureWriter          who writes the reply's <pic> tags: 'narrate', the POST call's name, or '' (nobody)
//   pictureCall            the POST call that writes them, or '' (the narrator does, or nobody)
//   sendsNarratorContract  the narrator's prompt carries the picture rules, and its <reply_cast> the one-off
//                          clothes ask (default-template castRecordAsks)
//   historyPictures        what the narrator's outgoing history shows of past pictures (HISTORY_PICTURES)
//   narratorTagAction      what the MESSAGE_RECEIVED pass does with a <pic> the narrator wrote (NARRATOR_TAG_ACTION)
//   pregenerates           streaming pre-generation draws the narrator's tags while the reply streams; never
//                          with New message, where /sd itself creates the image message, so the final pass
//                          makes the job
//   draws                  the GPU pass runs
//   stores                 harvest stores the looks the story describes
//   needsReplyCast         the narrator writes <cast> records (pictures read looks from them; harvest stores them)
//   lookTarget             who describes looks: the Harvest via target while storing, else the narrator while
//                          pictures need looks, else '' (nobody)
export function imageDuties({ insertType, route, via, picturesVia } = {}) {
    const type = Object.values(INSERT_TYPE).includes(insertType) ? insertType : INSERT_TYPE.DISABLED;
    const target = String(via || '').trim();
    const sendsImageContract = type !== INSERT_TYPE.DISABLED;
    const draws = sendsImageContract && type !== INSERT_TYPE.TAGS_ONLY;
    const stores = route === 'harvest' && !!target;
    const chosenWriter = String(picturesVia || '').trim() || 'narrate';
    const pictureWriter = sendsImageContract ? chosenWriter : '';
    const sendsNarratorContract = pictureWriter === 'narrate';
    const pictureCall = sendsNarratorContract ? '' : pictureWriter;
    let narratorTagAction = NARRATOR_TAG_ACTION.IGNORE;
    if (pictureCall) narratorTagAction = NARRATOR_TAG_ACTION.DISPOSE_AS_STRAY;
    else if (sendsNarratorContract) narratorTagAction = draws ? NARRATOR_TAG_ACTION.DRAW : NARRATOR_TAG_ACTION.DISPOSE;
    let historyPictures = HISTORY_PICTURES.AS_IS;
    if (pictureCall) historyPictures = HISTORY_PICTURES.REMOVED;
    else if (sendsNarratorContract) historyPictures = HISTORY_PICTURES.AS_TAGS;
    return {
        sendsImageContract,
        pictureWriter,
        pictureCall,
        sendsNarratorContract,
        historyPictures,
        narratorTagAction,
        pregenerates: draws && sendsNarratorContract && type !== INSERT_TYPE.NEW_MESSAGE,
        draws,
        stores,
        needsReplyCast: sendsImageContract || stores,
        lookTarget: stores ? target : (sendsImageContract ? 'narrate' : ''),
    };
}

// WHICH PICTURE WRITER GOES WITH WHICH "HARVEST VIA" (plans/executed/picture-writer-route.md R1), PURE: pictures on a POST call
// need registration on a POST call or Off. Registration on the narrator reads the reply's <pic> tags when the reply
// arrives — to warn about a drawn name with no look on file, and to keep a one-off outfit from replacing the clothes
// on file — and a POST call writes its pictures after that, so both checks would find nothing. Each picker leaves out
// what the other's stored value rules out (its own current value stays shown); neither changes the other's value.
const isHarvestOnNarrator = (harvestVia) => String(harvestVia || '').trim() === 'narrate';
const isPictureCallChosen = (picturesVia) => (String(picturesVia || '').trim() || 'narrate') !== 'narrate';
export function isPictureWriterOffered(target, harvestVia) {
    return String(target || '').trim() === 'narrate' || !isHarvestOnNarrator(harvestVia);
}
export function isHarvestTargetOffered(target, picturesVia) {
    return String(target || '').trim() !== 'narrate' || !isPictureCallChosen(picturesVia);
}
// What each picker leaves out now, for its hint line.
export function writerPairRuledOut({ harvestVia, picturesVia } = {}) {
    return { arePictureCallsHidden: isHarvestOnNarrator(harvestVia), isHarvestNarratorHidden: isPictureCallChosen(picturesVia) };
}

// The narrator's outgoing prompt with its picture parts in place, PURE. `chat` is the prompt-ready message list,
// changed in place as the host hands it over; the messages themselves are never touched. Past pictures in it follow
// `historyPictures` (imageDuties): rendered images turned back into their <pic> tags (a narrator that sees only the
// rendered HTML mimics it, fabricating image files and wrap markup instead of writing a tag), taken out, or left as
// they are. Then, while the narrator writes the pictures: `rules` (narratorPictureRules) open the prompt as one system
// message, `scene` (<scene_roster>) goes `depth` messages from the end as `role`, and `count` (<picture_count>) ends
// it, after everything a provider's prompt cache can reuse. Returns how many past pictures were changed.
export function placeNarratorPictureParts(chat, { historyPictures, unescapeAttr, rules = '', scene = '', depth = 0, role = 'system', count = '' } = {}) {
    let historyChanged = 0;
    for (const entry of chat) {
        if (!entry || typeof entry.content !== 'string') continue;
        if (historyPictures === HISTORY_PICTURES.AS_TAGS && entry.content.includes('auto-img-wrap')) {
            const res = revertRenderedImagesToPicTags(entry.content, unescapeAttr);
            if (res.reverted) { entry.content = res.text; historyChanged += res.reverted; }
        } else if (historyPictures === HISTORY_PICTURES.REMOVED) {
            const res = removePastPictures(entry.content, { removesRawTags: entry.role === 'assistant' });
            if (res.removed) { entry.content = res.text; historyChanged += res.removed; }
        }
    }
    if (rules) chat.unshift({ role: 'system', content: rules });
    if (scene) {
        if (depth === 0) chat.push({ role, content: scene });
        else chat.splice(-depth, 0, { role, content: scene });
    }
    if (count) chat.push({ role: 'system', content: count });
    return historyChanged;
}

// ── who a <pic> draws ────────────────────────────────────────────────────────────────────────
// Every person a <pic> names, in slot order: char= / outfit=, char2= / outfit2=, char3= / outfit3= …,
// ordered by number. THE ONE READER every consumer of a <pic>'s people uses — the prompt, the job key,
// the char= check, pre-generation, the reply cast and the harvest. Returns [{ key, outfit }], empty
// names skipped. The main character is never a slot (maincharOf).
const SLOT_ATTRIBUTE = /\bchar(\d*)\s*=\s*"([^"]*)"/gi;
export function picSlots(rawTag) {
    const tag = String(rawTag || '');
    const found = [];
    for (const m of tag.matchAll(SLOT_ATTRIBUTE)) {
        const number = m[1] ? parseInt(m[1], 10) : 1;
        const key = m[2].trim();
        if (!key || !(number >= 1)) continue;
        found.push({ number, key, outfit: tagAttr(tag, number === 1 ? 'outfit' : `outfit${number}`) });
    }
    return found.sort((a, b) => a.number - b.number).map(({ key, outfit }) => ({ key, outfit }));
}

// The camera a <pic> names (camera=), PURE: { value, words, problem }. The value is one of CAMERA_CHOICES, matched in
// any case, with a space or underscore read as its hyphen. problem: '' | 'missing' | 'unknown' — the caller warns, and
// the picture is drawn from the composition as written.
export function cameraOf(rawTag) {
    const written = tagAttr(rawTag, 'camera');
    if (!written) return { value: '', words: '', problem: 'missing' };
    const folded = written.toLowerCase().replace(/[\s_]+/g, '-');
    const choice = CAMERA_CHOICES.find((c) => c.value === folded);
    return choice ? { value: choice.value, words: choice.words, problem: '' } : { value: written, words: '', problem: 'unknown' };
}

// The composition with the camera's words at its START, PURE. The image model settles the framing from the opening
// words: a distance at the end (close-up, wide shot) was ignored, while an angle held wherever it stood. Words the
// composition already holds are not repeated — written with hyphens or spaces alike, since a narrator echoes the
// camera= value ("eye-level") as often as its words.
export function withCamera(composition, words) {
    const scene = String(composition || '').trim().replace(/,\s*$/, '');
    const add = String(words || '').trim();
    const spaced = (text) => text.replace(/[-_]+/g, ' ');
    if (!add || mentionsName(spaced(scene), spaced(add))) return scene;
    return scene ? `${add}, ${scene}` : add;
}

// The names a reply's <pic> tags draw in a one-off (their slot says outfit="newclothes"), each once, as
// written. PURE. The story changed their clothes that reply, so harvest lets nothing written about them
// replace clothes on file.
export function oneOffNamesOf(rawTags) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawTags) ? rawTags : []) {
        for (const slot of picSlots(raw)) {
            if (String(slot.outfit || '').trim().toLowerCase() !== OUTFIT_NEW_CLOTHES) continue;
            const folded = slot.key.toLowerCase();
            if (seen.has(folded)) continue;
            seen.add(folded);
            out.push(slot.key);
        }
    }
    return out;
}

// The main character in a <pic>, PURE. Every <pic> carries mainchar= (<camera>): one of his outfits draws him in it
// ('' — a slip — draws him in what the worn-outfit store holds for him); MAINCHAR_NOT_IN_PICTURE leaves him out,
// folded like cameraOf (case, space, underscore). `problem` is 'missing' when the tag has no mainchar=: he is not
// drawn, and the caller warns.
export function maincharOf(rawTag) {
    const tag = String(rawTag || '');
    if (!/\bmainchar\s*=\s*"/i.test(tag)) return { drawn: false, outfit: '', problem: 'missing' };
    const outfit = tagAttr(tag, 'mainchar');
    if (outfit.toLowerCase().replace(/[\s_]+/g, '-') === MAINCHAR_NOT_IN_PICTURE) return { drawn: false, outfit: '', problem: '' };
    return { drawn: true, outfit, problem: '' };
}

// The main character named in a composition whose <pic> does not draw him, PURE. The image model draws a whole
// body for every person or body part a composition shows, and dresses one whose look is not attached from the
// looks it was given — so a composition that names him on a tag whose mainchar= draws nobody ("not-in-picture", or
// none written) puts him in the picture in someone else's look. `names` are his persona name and his entry's key; MAINCHAR_WORDS are the words a narrator
// writes for him in a composition. Returns the first of them the composition mentions (mentionsName), or '' when
// the tag's mainchar= draws him, the shot is pov (the camera is his eyes), or nothing names him. The caller warns and
// adds nobody: drawing him is the narrator's mainchar=.
const MAINCHAR_WORDS = [MAINCHAR_PROMPT_NAME, 'mainchar', '{{user}}'];
export function maincharNamedButNotDrawn(rawTag, composition, names = []) {
    if (maincharOf(rawTag).drawn) return '';
    const scene = String(composition || '');
    if (/\bpov\b/i.test(scene)) return '';
    const candidates = [...(Array.isArray(names) ? names : []), ...MAINCHAR_WORDS];
    return candidates.map((n) => String(n || '').trim()).find((n) => n && mentionsName(scene, n)) || '';
}

// Every person a reply's <pic> tags draw, in text order, each with the outfit= its slot wrote: each tag's slots
// in slot order, then the main character under his entry's key `maincharKey` when the tag's mainchar= draws him (no
// key ⇒ he is left out: he has no entry to dress). PURE. What each one wears after the reply follows from it
// (character-roster wornReportsOf).
export function drawnPeopleOf(rawTags, maincharKey = '') {
    const key = String(maincharKey || '').trim();
    const people = [];
    for (const raw of Array.isArray(rawTags) ? rawTags : []) {
        for (const slot of picSlots(raw)) people.push({ name: slot.key, outfit: slot.outfit });
        const main = maincharOf(raw);
        if (main.drawn && key) people.push({ name: key, outfit: main.outfit });
    }
    return people;
}

// Is `rawTag` the last of a reply's <pic> tags (`rawTags`, in text order) to draw her? PURE. `isHer(name)` says whether
// a name a tag draws means her — her entry's key or one of its aliases, which only the registry knows — and the main
// character is drawn under `maincharKey` through mainchar= (drawnPeopleOf). False when the reply no longer holds the
// tag. A regen reads her clothes from the store saved with the reply only for her last picture in it (D39).
export function isLastPictureOf(rawTags, rawTag, isHer, maincharKey = '') {
    const tags = Array.isArray(rawTags) ? rawTags : [];
    const at = tags.indexOf(rawTag);
    if (at < 0) return false;
    return !drawnPeopleOf(tags.slice(at + 1), maincharKey).some((person) => isHer(person.name));
}

// ── a card-declared state path ────────────────────────────────────────────────
// Resolve a card-declared dot-path under stat_data (e.g. "PendingState.IntimacyActive", "World.Date"; a leading
// "stat_data." and [n] indexes allowed); a #tuple [value, "label"] is unwrapped to its value. PURE. undefined when
// the path reads nothing, and for a prototype key (shared/object-path.js says why).
export function resolveStatPath(statData, rawPath) {
    const path = String(rawPath || '').trim().replace(/^stat_data\./, '');
    if (!path) return undefined;
    let cur = statData;
    for (const seg of path.split('.')) {
        const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/);
        if (!m) return undefined;
        if (m[1]) {
            if (cur == null || typeof cur !== 'object' || isPrototypeKey(m[1])) return undefined;
            cur = cur[m[1]];
        }
        for (const ix of (m[2] || '').match(/\d+/g) || []) {
            if (!Array.isArray(cur)) return undefined;
            cur = cur[parseInt(ix, 10)];
        }
    }
    // auto-unwrap a #tuple [value, "label"] when the path didn't already index into it
    if (Array.isArray(cur) && cur.length === 2 && typeof cur[1] === 'string') cur = cur[0];
    return cur;
}

// Who a <pic> actually draws, PURE: its slots with repeats dropped (one name twice is one person), plus
// the main character, cut to the card's ceiling. Over the ceiling the main character goes first — he is
// then drawn from the scene alone — then the last slots.
// Returns { slots, mainchar, dropped: [names], repeated: [names] } so the caller can say what it left out.
export function fitPeopleToCeiling({ slots = [], mainchar = null, ceiling = 1 } = {}) {
    const max = Math.max(1, parseInt(ceiling) || 1);
    const seen = new Set();
    const kept = [];
    const repeated = [];
    for (const slot of (Array.isArray(slots) ? slots : [])) {
        const folded = String(slot.key || '').toLowerCase();
        if (seen.has(folded)) { repeated.push(slot.key); continue; }
        seen.add(folded);
        kept.push(slot);
    }
    const dropped = [];
    let drawsMainCharacter = !!(mainchar && mainchar.drawn);
    if (drawsMainCharacter && kept.length + 1 > max) { drawsMainCharacter = false; dropped.push('mainchar'); }
    while (kept.length > max) dropped.push(kept.pop().key);
    return { slots: kept, mainchar: drawsMainCharacter ? mainchar : { drawn: false, outfit: '' }, dropped, repeated };
}

// The bust variable for one picture, PURE: only people whose look declares [Bust] count. Nobody ⇒ the
// neutral default; one ⇒ theirs; two or more ⇒ the shared value, because the LoRA is one model-wide
// strength and cannot be set per person. null when the feature is off — the caller then sends nothing.
export function bustValueFor(people, settings) {
    if (!settings || !settings.enabled) return null;
    const declared = (Array.isArray(people) ? people : []).filter((p) => p && Number.isFinite(p.bust));
    if (!declared.length) return settings.defaultValue;
    if (declared.length === 1) return declared[0].bust;
    return settings.sharedValue;
}

// ── the composition cleanup ──────────────────────────────────────────────────────────────────
// The contract tells the narrator to write ZERO appearance; each person's look is attached as their own
// sentence. A FIXED ATTRIBUTE the narrator writes anyway is a second, competing copy: a wrong one ("red
// hair" against a stored plum-purple) makes the model mix both, and a right one in a two-person shot
// sits in the scene sentence, belongs to nobody, and can land on the other person.
//
// So it removes only a fixed attribute stated about a feature — a colour on hair or eyes, a size, a
// build-only figure word — and keeps everything else: plain mentions of hair or skin, contact ("his hand
// in her hair"), states ("hair blowing in the wind", "wet hair", "flushed skin", "tail wagging", "wings
// spread wide"), every species feature, and every garment (exposure states like "skirt pushed up" are
// required by the explicit block). A state belongs to this one picture, and no stored look can know it.
// Removal is per comma-separated tag, and every removed tag is reported, never silent.
const COLOUR = 'purple|violet|amber|gold|golden|blonde|platinum|silver|blue|cyan|turquoise|teal|green|olive|mint|red|crimson|ruby|scarlet|pink|magenta|rose|brown|hazel|honey|black|white|grey|gray|orange|lavender|ash';

// Each entry is [why, pattern]. `why` is what the caller reports.
const FIXED_ATTRIBUTE_PATTERNS = [
    ['hair/eye colour', new RegExp(`\\b(?:${COLOUR})(?:[\\s-]+[a-z]+)?[\\s-]+(?:hair(?:ed)?|eyes?|eyed)\\b|\\bheterochromia\\b`, 'i')],
    // Cup letters are case-SENSITIVE on the spaced form, so "a cup of tea" is never a size.
    ['size', /\b(?:[a-kA-K]-|[A-K]\s|[a-kA-K])cups?\b/],
    ['size', /\b(?:huge|large|big|giant|massive|enormous|small|tiny|flat|modest)\s+(?:breasts?|boobs|bust|chest|tits)\b/i],
    ['build', /\b(?:hourglass|voluptuous|busty|petite|curvaceous)\b/i],
];

/**
 * Remove fixed appearance attributes from the narrator-authored composition.
 * @param {string} composition
 * @returns {{ text: string, removed: Array<{tag: string, why: string}> }}
 */
export function sanitizeComposition(composition) {
    const source = String(composition || '');
    if (!source.trim()) return { text: source, removed: [] };
    const removed = [];
    const kept = [];
    // Comma-separated tags is how every /sd composition is written. A weighted group like `(thin
    // thighs:1.4)` holds no comma, so a plain split is safe; anything unsplittable stays one tag.
    for (const raw of source.split(',')) {
        const tag = raw.trim();
        if (!tag) continue;
        const hit = FIXED_ATTRIBUTE_PATTERNS.find(([, pattern]) => pattern.test(tag));
        if (hit) removed.push({ tag, why: hit[0] });
        else kept.push(tag);
    }
    // An all-appearance composition would leave nothing to place anyone in. Keep the original rather
    // than send a prompt with no scene — the report still names every offending tag.
    if (!kept.length) return { text: source, removed };
    return { text: kept.join(', '), removed };
}

// ── the /sd prompt ───────────────────────────────────────────────────────────────────────────
function sentenceEnd(text) {
    const trimmed = String(text || '').trim().replace(/[,;]+$/, '');
    if (!trimmed) return '';
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// The opening of one person's sentence: "the person in the frame" when they are alone, else their name
// alone. Never a position — where each one stands is the composition's to say.
function personOpening(name, count) {
    return count === 1 ? `The person in the frame is ${name}` : `${name} is`;
}

// Shared clothing is stated ONCE: when every person wears the exact same text (a card's shared uniform
// expands into each entry identically), one sentence replaces a duplicated garment list — and the
// duplicate was itself a bleed source, two copies of one skirt for the model to assign.
function sharedClothesOf(people) {
    const first = people[0].clothes;
    if (!first) return '';
    return people.every((p) => p.clothes === first) ? first : '';
}

// One piece of a look as one run of tags. A period inside it becomes a comma, so a card's look text that reads
// "(high ponytail:1.2). (dark purple hair:1.3)" or ends its clothes in ". White underclothes" never closes the
// look before its last tag; a decimal ("8.5 heads tall", "(x:1.4)") has no space after its point and is kept.
function lookText(text) {
    return String(text || '').trim()
        .replace(/\.+\s*,/g, ',')
        .replace(/\.+\s+/g, ', ')
        .replace(/[\s,;.]+$/, '');
}

function traitsOf(body, clothes) {
    return [lookText(body), lookText(clothes)].filter(Boolean).join(', ');
}

// A look wrapped in its owner's tag: "[Mana] … [/Mana]".
function ownedLook(owner, traits) {
    return `[${owner}] ${traits} [/${owner}]`;
}

// Text with every `{{` and `}}` taken out, so SillyTavern's macro expansion finds no macro in it — for the
// model's words on their way to /sd, where a macro would run (setvar and its kin change state as they expand).
export function withoutMacroBraces(text) {
    return String(text == null ? '' : text).replace(/\{\{|\}\}/g, '');
}

/**
 * Compose the exact string sent to /sd.
 * @param {object} input
 * @param {string} input.prefix       the /sd prompt-prefix preset text ('' for none)
 * @param {string} input.composition  what the narrator authored (scene, pose, action)
 * @param {Array<{name: string, body: string, clothes: string}>} input.people  each drawn person WITH a
 *        look, in slot order; a person with none is left out by the caller and drawn from the scene.
 * @param {{body: string, clothes: string}|null} [input.mainchar]  the main character's look, null when
 *        he is not drawn or has none — his sentence closes the prompt.
 * @param {boolean} [input.cleanup]   true only when EVERYONE in the shot has a look: otherwise the
 *        composition may be someone's only description, and it is left untouched.
 * @param {(removed: Array<{tag: string, why: string}>) => void} [input.onRemoved]  told what the cleanup
 *        dropped. Optional so this file stays pure; image-gen.js passes a logger.
 * @returns {string}
 *
 * Everything but the prefix passes through withoutMacroBraces: SillyTavern's /sd expands macros across the
 * whole prompt it is handed, and the composition and a look this reply's <cast> record wrote are the model's
 * own words. The prefix is the user's and keeps any macro it was written with.
 */
export function composeImagePrompt({ prefix, composition, people, mainchar = null, cleanup = false, onRemoved }) {
    // The prefix is the user's preset text, followed by ", " here: a closing comma or period of its own would
    // read ",," or "., ".
    const head = String(prefix || '').trim().replace(/[\s,;.]+$/, '');
    const lead = head ? `${head}, ` : '';
    const cast = (Array.isArray(people) ? people : [])
        .filter((p) => p && (p.body || p.clothes))
        .map((p) => ({ ...p, name: withoutMacroBraces(p.name), body: withoutMacroBraces(p.body), clothes: withoutMacroBraces(p.clothes) }));
    const maincharTraits = mainchar ? traitsOf(withoutMacroBraces(mainchar.body), withoutMacroBraces(mainchar.clothes)) : '';
    let scene = withoutMacroBraces(composition).trim();
    if (cleanup && (cast.length || maincharTraits)) {
        const clean = sanitizeComposition(scene);
        if (clean.removed.length && typeof onRemoved === 'function') onRemoved(clean.removed);
        scene = clean.text.trim();
    }
    const closing = maincharTraits
        ? `The ${MAINCHAR_PROMPT_NAME} in the frame is ${ownedLook(MAINCHAR_PROMPT_NAME, maincharTraits)}`
        : '';
    // Pure scenery: the composition alone, byte-for-byte.
    if (!cast.length && !closing) return lead + scene;

    const parts = [sentenceEnd(lead + scene)];
    const shared = cast.length > 1 ? sharedClothesOf(cast) : '';
    if (shared) parts.push(sentenceEnd(`${cast.length === 2 ? 'Both wear' : `All ${cast.length} wear`}: ${lookText(shared)}`));
    cast.forEach((person) => {
        const traits = traitsOf(person.body, shared ? '' : person.clothes);
        parts.push(`${personOpening(person.name, cast.length)}: ${ownedLook(person.name, traits)}`);
    });
    parts.push(closing);
    return parts.filter(Boolean).join(' ');
}

// ── the scene anchor ─────────────────────────────────────────────────────────────────────────
// The <scene_roster> block for the on-screen keys, or '' when the card's state names nobody on screen.
export function sceneRosterText(presentKeys) {
    const present = (Array.isArray(presentKeys) ? presentKeys : []).map((k) => String(k || '').trim()).filter(Boolean);
    if (!present.length) return '';
    return SCENE_ROSTER_PROMPT.replace(/\{\{present\}\}/g, present.map((k) => `- ${k}`).join('\n'));
}

// ── char= slot validation (which names deserve a diagnostic) ─────────────────────────────────
// PURE. `slotNames` = every slot name drawn this reply; `reservedNames` = the words that can never be a
// character — the outfit= values and "none" (the caller passes RESERVED_OUTFIT_NAMES, injected to keep this
// file dependency-free); `knownNames` = every name that resolves: presence keys AND registered keys AND their
// aliases, mixed case fine.
//   • 'reserved' needs NO roster of any kind: a reserved word as a name is a contract violation on any card,
//     so it is never gated on a consumer field.
//   • 'unknown' needs something to check against, and is SUPPRESSED when nothing at all is known — with
//     an empty registry every name is unknown every turn, and a diagnostic that always fires is noise.
export function validateCharSlots(slotNames, reservedNames, knownNames) {
    const reservedLc = new Set((Array.isArray(reservedNames) ? reservedNames : []).map((n) => String(n).toLowerCase()));
    const knownLc = new Set((Array.isArray(knownNames) ? knownNames : []).map((n) => String(n).toLowerCase()));
    const findings = [];
    for (const raw of (Array.isArray(slotNames) ? slotNames : [])) {
        const name = String(raw || '').trim();
        if (!name) continue;
        if (reservedLc.has(name.toLowerCase())) findings.push({ name, kind: 'reserved' });
        else if (knownLc.size && !knownLc.has(name.toLowerCase())) findings.push({ name, kind: 'unknown' });
    }
    return findings;
}

// ── THE EXPLICIT-BLOCK GATE ──────────────────────────────────────────────────────────────────
// Whether the EXPLICIT/H composition block is appended, over a latch path the CARD declares. A path that
// does not resolve must not read as "inject": undefined is not false, and a broken gate that injects the
// most sensitive block on every reply, silently, is the wrong way round.
//
// THE FOUR STATES:
//   • no gate        — path blank: inject. A card that tracks no such flag (any non-MVU card) has claimed
//                      nothing about its turns, and must work with zero setup.
//   • gate readable  — path resolves: inject unless it reads an explicit `false`. Deliberately `!== false`
//                      rather than a truthiness test: the value is a consumer's, and we do not
//                      reinterpret it.
//   • no state       — path configured, no game state to read yet (MVU not started, no chat, no message
//                      holds stat_data): withheld; the path is not at fault.
//   • gate BROKEN    — path configured, state present, path missing from it: FAILS CLOSED. A configured
//                      path is an author saying "gate this", and fail-closed is the VISIBLE failure (an
//                      intimate beat renders without the explicit floor and the warn names the path).
//
// PLATFORM TIER: takes a path STRING and an already-resolved value, so no consumer field name can reach
// this file. `reason` names which state decided it.
export function decideExplicitBlock({ alwaysOn = false, latchPath = '', latchValue, hasState = true } = {}) {
    if (alwaysOn) return { inject: true, reason: 'always-on' };
    if (!String(latchPath || '').trim()) return { inject: true, reason: 'no-gate' };
    if (!hasState) return { inject: false, reason: 'no-state' };
    if (latchValue === undefined) return { inject: false, reason: 'gate-unresolvable' };
    return { inject: latchValue !== false, reason: latchValue === false ? 'gate-closed' : 'gate-open' };
}

// Classify one read of a CARD-DECLARED stat_data path. 'unset', 'no-state' and 'unresolvable' all
// hand the caller `undefined`, but only 'unresolvable' is a defect of the path: state exists and the
// path is not in it — a root renamed while the card's [Initmvuhelper] kept the old path, or a path typed
// in the panel — and its feature silently stops working. 'no-state' means there
// was nothing to read yet (MVU not started, no chat, no message holding stat_data) — the path may be
// fine. `hasState` is the caller's report of whether any stat_data was found. Platform tier: takes a
// string and a value, learns nothing about what the path names.
export function classifyDeclaredPathRead({ path = '', value, hasState = true } = {}) {
    if (!String(path || '').trim()) return 'unset';
    if (!hasState) return 'no-state';
    return value === undefined ? 'unresolvable' : 'resolved';
}

// Which warning one read deserves. A path missing from state that EXISTS is the author's defect
// ('path-missing', said on every build). No state at all is not the path's fault: it is said on a
// real reply ('no-state') and stays silent on a practice build — SillyTavern's Prompt Manager runs a
// dry run on every chat load to count tokens, usually before MVU has started, and nothing it builds
// is sent. Returns null when nothing is worth saying.
export function declaredPathWarning({ read, dryRun = false } = {}) {
    if (read === 'unresolvable') return 'path-missing';
    if (read === 'no-state' && !dryRun) return 'no-state';
    return null;
}
