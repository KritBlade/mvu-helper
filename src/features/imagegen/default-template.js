// imagegen/default-template.js — every piece of image-prompt TEXT the narrator and the registration call
// read, plus the <pic> detection regex and its attribute reader. Kept as one file of prompt text so the
// wording can be edited in one place; the code that decides WHEN each block is sent lives elsewhere
// (prompt-assembly-core.js, image-gen.js).
//
// THE NARRATOR WRITES ONLY THE [Composition]. Each person's look is attached by the extension from the
// registry or from the person's <cast> record (prompt-assembly-core.js), so the composition carries no
// appearance at all.
//
// TARGET MODELS: Anima (danbooru tags + natural language freely mixed; lowercase, spaces not
// underscores; the safe/nsfw/explicit safety tags are real signals), Krea 2 (natural language, concrete
// short clauses, 30-80 words) and Qwen-Image (structured SHORT PHRASES, subject FRONT-LOADED, hates
// vague or contradictory words). The shared shape: short comma-separated atomic phrases (read as tags
// on Anima, as clauses on Krea/Qwen), subject before scene, danbooru-compatible camera terms, no
// negations, no weighted parens, no underscores, 25-60 word compositions. The attached looks use the
// same comma-phrase style, and weights live ONLY in registry entries — the composition never writes
// them (hence FORBIDDEN below).
//
// QUALITY vs STYLE — each token is emitted by exactly ONE layer, never both, and the /sd prompt-prefix
// preset is that layer for BOTH kinds. It owns the style tokens that differ per checkpoint ("anime
// screencap", "2D anime style", realistic equivalents) AND the quality head ("masterpiece, best
// quality"): the preset is a GUI field edited per checkpoint, which is the axis quality tokens actually
// vary on. The prefix is prepended ahead of the composition (composeImagePrompt: `<prefix>,
// <composition>`), so a token written in both places reaches the model twice, and one written HERE
// cannot be turned off by a card that picked a different preset. This text names WHAT IS IN THE
// PICTURE and nothing about how it is rendered.
// Negative prompts are a BACKEND setting (SillyTavern's Image Generation panel), not taught here —
// Anima's recommended negative: "worst quality, low quality, score_1, score_2, score_3, artist name,
// blurry, jpeg artifacts, chromatic aberration".
//
// The EXPLICIT/H geometry is its own block (<explicit_rules>, EXPLICIT_RULES_PROMPT) and is injected only while
// the card's intimacy latch allows it (image-gen.js), so a SFW turn on a card that tracks intimacy carries none of it.
//
// `<pic>` is the ONLY tag this lane detects: `<img>` is a real HTML element — a malformed one corrupts
// the rendered story, and a real one written by a preset, another extension or the prose is not ours to
// remove — while `<pic>` is a tag nothing else in a chat produces.
//
// {{maxImages}} and {{castRules}} are substituted at injection time (image-gen.js). The fixed image rules open
// the prompt — the contract, <outfit_rules>, <camera>, then <explicit_rules> during an explicit scene — so a
// provider's prompt cache reuses them on every reply. <scene_roster> changes with who is on screen, so it goes
// where the Position / Depth settings put it, after everything a cache can reuse. <picture_count> goes at the end
// of the prompt (see its own note below).

// DEEP IMPORT, deliberate: the character-roster barrel pulls in SillyTavern host modules, which cannot
// load under vitest, and this file is pure. cast-record-format-core.js is that feature's pure half by
// the repo's filename convention, and it is the one place that knows how a cast record is written.
import { writeCastRecord, CAST_RECORD_FORMAT_RULES, NAME_RULES } from '../character-roster/cast-record-format-core.js';

// WORDING IS TOKEN-COMPRESSED, RULES ARE NOT. This text is read by a model, so it is written
// telegraphic — articles and rationale prose dropped, · and ⇒ as separators — while keeping the three
// things weak narrate models actually need: the section anchors, the GOOD/BAD examples, and
// one-rule-per-line structure. When editing, change RULES here and keep the style.
// EACH RULE IS STATED ONCE, in the block that reaches every card that needs it, and every other block names that
// block instead of restating it: a restated rule drifts, and a weak model argues the copies against each other. The
// homes: how a name is written — NAME_RULES in <reply_cast>; who is in the tag (count tag, mainchar=, a body part
// brings its owner, pov hands, unnamed people) — [CAST]; what outfit= may say — <outfit_rules>; camera= — <camera>;
// zero appearance — the prompt= rule. The narrator's opening duty (pictureDuty, tagCost) and [CHECK] restate them on
// purpose: trimmed, two local models left the picture, the records or the state update out of 4 replies in 10, against
// none in 10 with them (plans/reply-cast.md D44).
// THE WORD "KEY" BELONGS TO <scene_roster>, where it names the game state's spelling of a character, which is never
// what char= copies. The name rules and the placeholders (CharName) say "name" so the two never read as one thing.
// EVERY SAMPLE VALUE IN A SHAPE IS ONE CamelCase PLACEHOLDER WORD (CharName, Camera, CompositionText), the form a model
// fills in instead of copying: a sample prompt= that opened with a bracketed label had a narrator open its real
// prompt= with that label, which the image model then received as words.
// The mainchar= value for a picture {{user}} is not in, every pov shot included (<camera>).
export const MAINCHAR_NOT_IN_PICTURE = 'not-in-picture';
// What the image prompt calls {{user}}: the tag his look is wrapped in ("[main character] … [/main character]",
// prompt-assembly-core) and the words the narrator writes for him in a composition (<camera>). One name in both
// places is what lets the image model match "the main character" in the scene to the look it is given.
export const MAINCHAR_PROMPT_NAME = 'main character';

export const DEFAULT_PROMPT = `<image_generation>
{{pictureDuty}}
{{tagCost}}
<pic{{at}} char="CharName" outfit="CharOutfit" camera="Camera" prompt="CompositionText" mainchar="UserOutfit">
{{placement}}
- char= = who is drawn: the name the story gives them, written as Names in <reply_cast> says. Omit char= only for a shot with no named character. How many people per image, and {{user}}: [CAST].
{{beatAttribution}}
- prompt= holds ONLY the [Composition]: scene + what each person DOES. Each person's look is attached separately — write ZERO appearance: no hair colour/length/style, no eye colour, no skin/face, no body/figure/chest size, no species or animal features, no outfit. Every appearance word you write fights the attached look and corrupts the render. A STATE of clothing (pushed up, pulled aside, unbuttoned, torn, soaked) is not an outfit — it belongs in the composition.
  GOOD: "1girl, sitting, leaning forward, hands on desk, looking at viewer, playful smile"
  BAD: "1girl, cat ears, long violet hair, green eyes, slim, red dress"
- outfit= (outfit2=, outfit3= … for the other slots): what that person wears in this shot — values in <outfit_rules>.

{{castRules}}

[STYLE] short comma-separated phrases, lowercase, no underscores. Concrete VISIBLE facts only — no mood words ("tense atmosphere"), no metaphors, no off-camera story context. ATOMIC: one observable state per phrase ("kneeling", "hands on thighs", "head down") · ONE expression word per person (calm / tearful / flushed / blank / smiling). FORBIDDEN: negations ("no glasses" draws glasses) · weighted parens "(tag:1.2)" · schema labels ("Hair:", "Pose:").

[COMPOSITION — this order, subject first]
1. Count everyone in frame by their own tag ("1girl" · "2girls" · "1boy" · "1girl, 1boy" · "2boys" …), {{user}} included whenever any part of {{user}} is in frame, pov aside (pov hands count as nobody), a crowd never (scenery) — each one you count is in the tag ([CAST]) · sexual/nude beat +"nsfw" · penetration +"explicit".
2. Focal character: pose, action, expression — what they DO. {{user}}'s action too if in frame — in a pov shot, as what the pov hands do.
3. Bodies touching ⇒ ALL contact as owner-tagged GEOMETRY: where each part is, against/around/inside what ("her hand flat on HIS chest", "HIS arm around her waist"). Verb labels don't render — translate: kiss ⇒ "lips pressed together" (+"tongues touching" if deep) · punch ⇒ "fist against her jaw, head turned by impact" · stab ⇒ "blade in his chest, hilt at the wound, blood at entry" · draw ⇒ "hand on hilt, blade half out of the scabbard" · same pattern for any act.
4. Scene: place, time, lighting, 1-2 anchor objects ("kitchen, evening, warm lamplight, rain on the window").
5. Camera: camera= on the tag (<camera>), plus a framing when it helps (upper body · cowboy shot · full body · from side · from behind).
BUDGET 25-60 words.

[CONTINUITY] images have NO memory of each other: repeat every transient detail (sweat, blush, dishevelment, marks, fluids, exposure) in the same words across consecutive images until the scene clears it{{tagInProse}}.

[CHECK] EVERY SCENE <picture_count> GIVES A TAG HAS ITS <pic> (≤{{maxImages}}) — a reply with none is not finished; go back and add them ·{{placementCheck}} · every NAMED person in the shot has a slot (char=, char2= …) and nobody else does · mainchar= on every tag, last: an outfit exactly when any part of {{user}} is in frame, pov aside, else "${MAINCHAR_NOT_IN_PICTURE}" · everyone the count tag counts is in the tag, unnamed strangers aside · camera= on every tag · zero appearance words · contact = owner geometry, no verb labels · a body part in frame brings its owner: their slot and their count tag, pov hands aside · 25-60 words.
</image_generation>`;

// ── who writes the pictures: the template's writer placeholders ─────────────
// The narrator writes the pictures while it writes the story, or a POST call writes them after reading the finished
// reply with its lines numbered (plans/executed/picture-writer-route.md R2). The contract above is one text for both: each
// line that depends on the writer is a placeholder, filled per writer as {{maxImages}} and {{castRules}} are, so a
// card's edits to the shared rules ([STYLE], [COMPOSITION] …) reach both. The narrator's words are the contract's
// own as it always read; the reader's put the picture by line number (at=).
export const PICTURE_WRITER_WORDS = {
    narrate: {
        pictureDuty: 'MANDATORY, EVERY SINGLE REPLY: a <pic> for EVERY SCENE of the reply, up to {{maxImages}} — see <picture_count>. NEVER zero. A reply with zero <pic> tags is a FAILED reply, no matter how complete its prose or its other required blocks are. This is not optional and it is never skipped — not on a quiet turn, not on a dialogue-only turn, not when the reply already carries status/character/quest blocks.',
        tagCost: 'THE TAG COSTS NO WORDS. It is machine-consumed markup, never prose: it does not count toward ANY length, paragraph or word budget you have been given, and no such budget is ever a reason to omit it. If space feels tight, shorten the prose — never drop the tag. Any other visual/graphics protocol you carry is SEPARATE and does not satisfy this one; <pic> is the only tag that renders a character image here.',
        at: '',
        placement: '- PLACEMENT: inside the prose, own line, directly under the ONE sentence it illustrates. Never bunched at the end · never after a status/choices/structured block.',
        beatAttribution: '- BEAT ATTRIBUTION: char= = whoever acts/speaks in the sentence directly above the tag — never an earlier speaker, never the previous image\'s subject.',
        tagInProse: ' · the tag is machine-read — never mention it in prose',
        placementCheck: 'each tag under its own sentence, none bunched/trailing · char= = that sentence\'s actor',
    },
    reader: {
        pictureDuty: 'MANDATORY: a <pic> for EVERY SCENE of the reply you read, up to {{maxImages}} — see <picture_count>. NEVER zero: an answer with no <pic> tag leaves the reply without a picture.',
        tagCost: 'The reply is finished: you read it to picture it, never to continue it.',
        at: ' at="LineNumber"',
        placement: '- at= : the NUMBER of the line the picture shows — the [n] at the start of that line in the reply you read. The extension puts the picture on its own line under that line.',
        beatAttribution: '- BEAT ATTRIBUTION: char= = whoever acts/speaks in the line at= names — never an earlier speaker, never the previous image\'s subject.',
        tagInProse: '',
        placementCheck: 'at= on every tag: the number of the line it shows · char= = that line\'s actor',
    },
};

// The contract for one writer ('narrate' | 'reader'): its writer placeholders filled first (a writer's words may hold
// {{maxImages}}), then {{maxImages}} and {{castRules}}. A blank template is the built-in one.
export function renderPictureTemplate(template, { writer = 'narrate', maxImages = 1, castRulesText = '' } = {}) {
    const words = PICTURE_WRITER_WORDS[writer] || PICTURE_WRITER_WORDS.narrate;
    let text = String(template || DEFAULT_PROMPT);
    for (const [name, value] of Object.entries(words)) text = text.split(`{{${name}}}`).join(value);
    return text
        .replace(/\{\{maxImages\}\}/g, String(maxImages))
        .replace(/\{\{castRules\}\}/g, castRulesText);
}

// ── <picture_count> — how many <pic> tags a reply carries, and where ─────────
// Built from the card's "Max images per reply" and sent at the end of what the picture writer reads, on every prompt
// that carries the contract and on no other: the narrator's prompt (image-gen.js), or the reply a POST call reads
// (readerPictureInput). Shipped from code because a saved copy of the contract (a card's or its user's
// imagegen.promptTemplate) goes stale: a count rule kept only there never reaches a card that saved one.
//
// A POST CALL READS IT AFTER THE REPLY. Its system block is every entry routed to it in lorebook order, so the card's
// own POST rules come after the routed picture contract, and a model that does only the duty it read last writes
// the card's record alone. On School's POST call GPT-5.6 Luna wrote no <pic> in 14 of 15 replays with the count
// inside the contract, and the pictures beside the card's full record in 18 of 18 with the count after the reply or
// after the card's entries (2026-10-22, dev msg 210); Gemma 4 31B wrote both wherever the count stood.
//
// IT GOES AT THE END because a narrator follows what it read last. Every other block a reply must carry is asked
// for again near the end of the prompt, where a preset's own reply template also sits, while the contract opens the
// prompt — a hundred thousand characters back on a large card — and <pic> is the one required tag replies leave
// out. A narrator writes the story from its own block list or draft: a picture planned in its thinking can be lost
// when a later checklist (a preset's own planning steps) or a list of the reply's blocks (a card's block order)
// leaves it out. So this block says what the extension does with the tag, where the tag goes, when
// to write it (with the sentence it shows, never after the story), that every plan or list of the reply's parts
// names it, and that no other format removes it. A card can read the block's presence as "image generation is
// on": it is sent exactly when the contract is.
//
// AN INSTRUCTION, NEVER A JUDGMENT. Asked whether a beat "earns" a picture, every narrator model answers one
// tag. So nothing is left to decide: a scene change — another place, a jump in time, someone new arriving —
// is followed by another <pic>, until the card's number is reached. The draw pass enforces the number
// whatever the reply holds (detectTags). A new pose or more talk in the same scene adds nothing, so nothing
// is re-shot to fill the count.
//
// THE LAST SCENE ALWAYS GETS ONE when the scenes outnumber the tags: it is where the story now stands, the
// scene the next reply continues from. With one tag allowed, the narrator chooses the scene.
//
// The rule names where each tag goes in the prose, and a two-scene reply is shown whole: earlier replies in the
// chat hold one tag each at most (a card may strip them from the prompt), so this is the only two-tag reply the
// narrator sees. The contract's opening line and its [CHECK] point here, so nothing in it asks for one tag on its own.
const PICTURE_PURPOSE = 'The extension draws a picture from every <pic> tag in the story and shows it where the tag stands. A reply without one shows no picture.';
const PICTURE_PLACE = "WHERE: inside the story, on its own line, under the sentence it shows. Pick each picture's sentence BEFORE you write the story, and write its <pic> as soon as that sentence is written. Every plan, checklist or list of blocks you write for this reply names each <pic> and the sentence it goes under.";
const PICTURE_OVER_FORMATS = "No other instruction's reply format, template, word count or tag list removes it: the <pic> goes inside the story, in whatever block holds the story. Its shape and rules: <image_generation>.";
// The reader's (a POST call that writes the pictures after reading the numbered reply): the same count rule, each
// picture put by line number, and its tags and records written beside whatever else the call is asked for. A POST
// call may carry other duties too (a card's own records, the look task), and an answer told to be the tags alone must
// drop one of them. No position is claimed: the capture reads the tags and records wherever they stand.
const READER_PICTURE_PURPOSE = 'The extension draws a picture from every <pic> tag you write and shows it on its own line under the line its at= names. An answer without one leaves the reply without a picture.';
const READER_PICTURE_PLACE = "WHERE: at= is the number of the line the picture shows — the [n] at that line's start. char= is whoever acts or speaks in that line.";
const READER_PICTURE_OUTPUT = 'OUTPUT: each <pic> tag, and each record <reply_cast> asks for, on a line of its own, outside any other block, with no story or notes of yours around them. The extension reads them wherever they stand in your answer, so they sit beside anything else this prompt asks you to write: neither replaces the other. Their shape and rules: <image_generation> above.';
export function pictureCountRules(maxImages, { writer = 'narrate' } = {}) {
    const budget = Math.max(1, parseInt(maxImages) || 1);
    const isReader = writer === 'reader';
    const example = isReader ? [
        'A reply with two scenes:',
        '  [1] …the first scene…',
        '  [5] …the scene changes: another place, later, or someone new arrives…',
        'Your answer:',
        '  <pic at="1" char="CharName" outfit="CharOutfit" camera="Camera" prompt="FirstSceneComposition" mainchar="UserOutfit">',
        '  <pic at="5" char="CharName" outfit="CharOutfit" camera="Camera" prompt="NewSceneComposition" mainchar="UserOutfit">',
    ] : [
        'A reply with two scenes:',
        '  …the first scene…',
        '  <pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="FirstSceneComposition" mainchar="UserOutfit">',
        '  …the scene changes: another place, later, or someone new arrives…',
        '  <pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="NewSceneComposition" mainchar="UserOutfit">',
    ];
    const newScenePlace = isReader ? "at= one of the new scene's first lines" : "under the new scene's first sentences";
    const count = budget === 1 ? ['ONE <pic> this reply. With more than one scene, it goes to the scene you choose.'] : [
        `SCENE CHANGE ⇒ ANOTHER <pic>. Up to ${budget} <pic> tags this reply — an instruction, not a choice.`,
        '- The SCENE CHANGES when the story moves to another place · time jumps (later, that night, the next morning, falling asleep, a dream) · someone new arrives.',
        `- The first scene gets its <pic>. EVERY scene change gets ANOTHER <pic>, ${newScenePlace} — until ${budget} tags are written.`,
        `- The LAST scene ALWAYS gets one: with more scenes than ${budget}, skip a middle scene, never the last.`,
        '- No scene change ⇒ no extra tag: a new pose or more talk in the same scene adds nothing.',
        ...example,
    ];
    const ending = isReader ? [READER_PICTURE_PLACE, READER_PICTURE_OUTPUT] : [PICTURE_PLACE, PICTURE_OVER_FORMATS];
    return ['<picture_count>', isReader ? READER_PICTURE_PURPOSE : PICTURE_PURPOSE, ...count, ...ending, '</picture_count>'].join('\n');
}

// ── <camera> — where the camera stands ───────────────────────────────────────
// EVERY <pic> NAMES ITS CAMERA (camera=), picked from CAMERA_CHOICES: a value the narrator must write is a decision it
// makes, while a camera list it may consult is one it skips — in a first-person story a narrator left to choose put
// the camera in {{user}}'s eyes on every beat ("pressing viewer against the wall"), so {{user}} was never drawn. Each
// choice is named with what it does to the beat, so the narrator picks by meaning, and pov is one choice among them.
// The extension cannot know a card's point of view, so the sentence that sets the picture apart from the story's
// names first and third person both. The extension puts the choice's `words` at the front of the composition (prompt-assembly-core
// withCamera). `words` is what the image model follows, not the choice's name: "wide shot" alone left two people
// cropped at the thigh, so wide-shot sends a full-body framing.
//
// THE CAMERA DECIDES WHERE {{user}} CAN BE, because camera= is the decision the narrator now makes on every tag:
// only pov keeps {{user}} out (the camera is {{user}}'s eyes); every other camera leaves it to the narrator, whose
// mainchar= says which. The mainchar= rule itself is [CAST]'s (castRules), stated there once.
//
// IN THE COMPOSITION {{user}} IS "the main character" (MAINCHAR_PROMPT_NAME), the name his look is tagged with in the
// prompt. A narrator otherwise writes "user", or the persona's name, which no look in the prompt carries. Measured on
// Krea2 (2026-10-16, the staging two-girl bench scene, 12 seeds a variant): that name together with the look tags drew
// both girls and him in 11-12 of 12, against 8 of 12 before; either change alone did not.
//
// Shipped from code with <outfit_rules> and <picture_count>, because a saved copy of the contract goes stale: a
// camera rule kept only in its [COMPOSITION] never reaches a card that saved one. A copy saved before camera= existed
// still prints its own camera list ("5. Camera, from: close-up · upper body …"), and the block's last line names that
// list by its opening words, so the current [COMPOSITION]'s framing words (upper body, cowboy shot …) are never read
// as what it replaces.
export const CAMERA_CHOICES = [
    { value: 'eye-level', words: 'eye level', does: 'neutral' },
    { value: 'from-below', words: 'from below', does: 'low angle: the subject looks powerful' },
    { value: 'from-above', words: 'from above', does: 'high angle: the subject looks vulnerable' },
    { value: 'dutch-angle', words: 'dutch angle', does: 'tilted horizon: tension' },
    { value: 'close-up', words: 'close-up', does: 'a face, a touch' },
    { value: 'wide-shot', words: 'full body shot, camera pulled back, head-to-toe framing', does: 'the place, the distance between people' },
    { value: 'pov', words: 'pov', does: "{{user}}'s eyes" },
];
export const CAMERA_RULES_PROMPT = `<camera>
EVERY <pic> carries camera= — where the camera stands for that shot, one of these words, written exactly: ${CAMERA_CHOICES.map((c) => `${c.value} (${c.does})`).join(' · ')}.
THE CAMERA DECIDES WHERE {{user}} CAN BE. pov is {{user}}'s eyes, so a pov picture never has {{user}} in it — only pov hands. Every other camera stands apart from {{user}}, and whether {{user}} is in the picture is your choice, which the tag's mainchar= states ([CAST]).
In prompt= {{user}} is always "the ${MAINCHAR_PROMPT_NAME}", the name the extension gives {{user}}'s look — never {{user}}'s own name, never "user": "CharName leaning against the ${MAINCHAR_PROMPT_NAME}".
The picture does not take the story's point of view, first person or third: pov is one choice among these, and "viewer" belongs in a composition only when camera="pov". A [COMPOSITION] line that opens "Camera, from:" is an older camera list, and this block replaces it.
</camera>`;

// ── {{castRules}} — who may be in one image ──────────────────────────────────
// Built per card from "Max characters per image" (image-gen.js), so the narrator is told the card's own
// ceiling. A ceiling, never a target: one person alone is a normal shot, and every person with a stored
// look costs the image model a whole description, so nobody is added to reach the number.
//
// SLOT ORDER CARRIES NO POSITION: prompt-assembly-core gives each look its own sentence opened by the
// person's name ("CharName is: …") and never says where anyone stands, so the composition alone places
// them and the narrator never has to keep a slot order in step with its own description. Naming each
// person in their own clause is what makes the backend bind each look to its owner — a shared subject
// ("both smiling") is the shape that bleeds.
//
// A BODY PART BRINGS ITS OWNER: the image model draws a whole body for every body part it is shown, and dresses
// one whose look is not attached from the looks it was given. So any part of someone in the frame puts them in the
// shot, with a slot and a count tag, and only a pov shot keeps {{user}} out: the camera is {{user}}'s eyes. With one
// person per image, a shot where two people touch shows one of them alone, or is shot pov when one is {{user}}.
//
// POV HANDS are the one exception, and the rules say so where the body-part rule stands: in a pov shot {{user}}'s own
// hands reaching into the frame are written "pov hands" with what they do, and the image model draws them coming from
// the camera with no body behind them, so they take no slot and no count tag. Without the exception the two rules
// contradict each other on every pov shot that shows {{user}}'s hands, and a narrator resolves it by leaving
// {{user}}'s action out of the picture.
//
// EVERY PERSON THE COUNT TAG COUNTS IS IN THE TAG. The count tag ("1girl, 1boy") is where the narrator reliably writes
// {{user}} into a shot, so the rule ties the tag to it: each person it counts is a slot or mainchar=, and only an
// unnamed stranger stays out. Drawing fewer people than the scene holds is fine; whoever is drawn has their look. The
// shapes the narrator copies show {{user}} beside a named character as well as two named characters: with only the
// second shape shown, a narrator drawing {{user}} with one girl copied the one-person shape, left mainchar= off, and the
// image model drew a stranger (a child, for "1boy") in {{user}}'s place. Every shape writes mainchar= last, after
// prompt=: an outfit where {{user}} is in the shot, "not-in-picture" where not.
//
// EVERY <pic> CARRIES mainchar=, the same way it carries camera=, and this block is the rule's one home (<camera> and
// the contract point here). An attribute the narrator writes only when a condition holds is one it drops: three
// narrator models planned mainchar="town-casual" in their reasoning for a shot they counted as "1girl, 1boy", then
// wrote the tag without it — while writing camera= on the same tags. Required, it is part of the shape every tag
// copies, and writing it is a choice between an outfit and "not-in-picture". It is written AFTER prompt=, where the
// count tag that decides it is already written. Every detection regex ever shipped (DEFAULT_REGEX's tail `[^<>]*>`)
// and tagAttr read an attribute after prompt=.
//
// {{user}} is never a char= slot: the narrator names an outfit in mainchar= whenever any part of {{user}} is in the
// frame, a pov shot aside, and the card's main-character entry supplies the look. `userOutfits` are that entry's outfits ([] when the card has
// none), so mainchar= can name one. "default" is offered only when his entry has it (or names no entry
// at all, when nothing is attached either way): an entry whose outfits are all named has no default, and
// mainchar="default" would draw him with no clothes. "same-as-last-picture" is named here as a value; WHAT it draws
// changes with the story, so it is printed in <reply_cast>, never in this block, which opens the prompt and must
// read the same on every reply for a provider's prompt cache.
// THE SHAPES' mainchar="UserOutfit" IS A SAMPLE, and the rule says so beside the list it must be picked from: a
// narrator wrote "UserOutfit" on every picture of {{user}}, whose look then carried no clothes. Likely why: in [CAST]
// its shape stands next to one with the real value "not-in-picture".
export function castRules(maxCharacters, { userOutfits = [] } = {}) {
    const ceiling = Math.max(1, parseInt(maxCharacters) || 1);
    const offered = (Array.isArray(userOutfits) ? userOutfits : []).filter(Boolean);
    const outfits = offered.filter((o) => o !== 'default');
    const offersDefault = !offered.length || offered.includes('default');
    const maincharValues = [
        ...(offersDefault ? ['mainchar="default"'] : []),
        ...(outfits.length ? [`${offersDefault ? '' : 'mainchar= '}one of {{user}}'s outfits (${outfits.join(', ')})`] : []),
        '"same-as-last-picture" when <reply_cast> offers it for {{user}}',
        'or "undressed" when {{user}} is shown without clothes',
    ].join(', ');
    const mainchar = `- mainchar= : on EVERY tag, written last, after prompt=, so the count tag you just wrote decides it. ANY part of {{user}}'s body in the frame (all of {{user}}, or only a chest, lap, arm or hand) ⇒ ${maincharValues}. Do NOT use the sample "UserOutfit" — it is a sample: pick from this list. No part of {{user}} in the frame, or a pov shot (the camera is {{user}}'s eyes; POV HANDS below) ⇒ mainchar="${MAINCHAR_NOT_IN_PICTURE}".`;
    const scenery = '- Unnamed people (a crowd, "people in background") are scenery words in the composition, never a slot. Only who is in THIS beat: in the room ≠ in the shot.';
    const countIsTag = (slots) => `- EVERY PERSON YOUR COUNT TAG COUNTS IS IN THE TAG: a named character in ${slots}, {{user}} as an outfit in mainchar= — only an unnamed stranger stays out (scenery, below). The extension attaches each look from the tag, so a person counted but missing from it gets no look and the image model makes one up from your words: "1girl, 1boy, boy holding a helmet" with mainchar="${MAINCHAR_NOT_IN_PICTURE}" draws a stranger, often a child, where {{user}} should be. Drawing fewer people than the scene holds is fine — only the ones you draw are counted.`;
    const bodyPartWhy = '- A BODY PART BRINGS ITS OWNER: the image model draws a whole body for every body part it is shown, and a body whose look is not attached takes the look of whoever IS described.';
    const povHands = '- POV HANDS: in a pov shot the camera is {{user}}\'s eyes, and {{user}}\'s own hands and arms reaching into the frame are written "pov hands" with what they do ("pov hands holding her shoulders", "pov hand offering a cup"). The image model draws pov hands coming from the camera with no body behind them, so they are the one body part that brings no owner: mainchar="' + MAINCHAR_NOT_IN_PICTURE + '", no count tag. What {{user}} does still goes in the composition, as what the pov hands do.';
    if (ceiling === 1) {
        return [
            `[CAST] ONE person with a stored look per image: one named character (char=, with mainchar="${MAINCHAR_NOT_IN_PICTURE}") OR {{user}} (an outfit in mainchar=), never both. 1 is a ceiling, not a target. {{user}} alone is this shape:`,
            '<pic camera="Camera" prompt="CompositionText" mainchar="UserOutfit">',
            countIsTag('char='),
            mainchar,
            scenery,
            `${bodyPartWhy} So frame each shot with ONE person's body in it: when two people touch, show one of them alone — or, when one of them is {{user}}, shoot it pov ({{user}}'s eyes), with {{user}}'s part in it as pov hands.`,
            povHands,
        ].join('\n');
    }
    return [
        `[CAST] Up to ${ceiling} people with a stored look per image — a CEILING, never a target. One person alone (one named character, or {{user}} alone) is a normal shot; never add someone to reach ${ceiling}.`,
        countIsTag('a slot (char=, char2= …)'),
        '- Each named person in the shot takes one slot: char=, then char2=, char3= …, each with its own outfit=, outfit2=, outfit3= …. Any person may take any slot; where each one stands belongs in the composition. Copy THESE shapes for two people:',
        `two named characters: <pic char="CharName" outfit="CharOutfit" char2="Char2Name" outfit2="Char2Outfit" camera="Camera" prompt="CompositionText" mainchar="${MAINCHAR_NOT_IN_PICTURE}">`,
        'a named character with {{user}}: <pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="CompositionText" mainchar="UserOutfit">',
        `${mainchar} {{user}} counts toward the ${ceiling} but never takes a char slot.`,
        scenery,
        '- KEEP THEM SEPARABLE: each person their own clause, by name, what THEY do — "CharName leaning back on the desk, grinning, Char2Name standing beside CharName, hands clasped". Never one shared subject ("both smiling") unless they genuinely do the same thing.',
        `${bodyPartWhy} So anyone with any part in the frame — the chest she leans on, the hand on her shoulder — takes their slot (an outfit in mainchar= for {{user}}) and their count tag — all but {{user}}'s own hands in a pov shot (POV HANDS).`,
        povHands,
    ].join('\n');
}

// ── <outfit_rules> — what outfit= may say ────────────────────────────────────
// Shipped from code and appended whenever the <pic> contract is sent, because a saved copy of the contract
// itself (a card's or its user's imagegen.promptTemplate) goes stale: a rule that lives only there reaches
// nobody who saved one. The choices each character has are listed ON FILE in
// <reply_cast>, which the roster sends whenever images are on.
//
// EVERY SLOT NAMES WHAT THAT PERSON WEARS IN THIS SHOT, PICKED FROM A LIST: a choice on her ON FILE line (her
// outfits on file, and "same-as-last-picture" while the worn-outfit store holds what she wore), "newclothes" or
// "undressed". The narrator observes this shot; it never judges whether anything changed since her last picture,
// and nothing is left out to mean something. mvu-helper remembers: what each picture drew — an outfit on file, or a
// one-off it described — is kept in the card's state (stat_data.$mvuhelper.worn_outfit) and offered back as
// "same-as-last-picture", the outfit's name or the one-off's clothes listed on a line of their own under the ON FILE
// lines, so the narrator compares the story with them instead of recalling her last picture (a swimsuit offered for
// a classroom is visibly not what she wears). The main character's mainchar= takes it the same way, on a line of
// his own. "default" is only a name, listed for the characters who have one. A STATE of the clothes (pushed up, torn) changes nothing — it stays
// in the composition, where the explicit block's exposure rule puts it.
//
// UNDRESSED OUTRANKS EVERYTHING: "undressed" is legal for anyone, ON FILE or not — the explicit block's own
// exposure rule depends on it. The word is "undressed", never "none": models read "none" as nobody or no outfit.
//
// THE BLOCK LEADS WITH WHY: the extension dresses each person by the value of their slot, read word for word. A model
// told the mechanism picks the right value on its own, so the block explains it instead of listing examples. It also
// says why every value is written exactly as shown, in English, whatever language the story is in: no code can
// recognise every language's word for "undressed", and a translated value is a slip drawn in what the store holds.
// Names are the opposite — they stay in the story's own script.
//
// A ONE-OFF IS WRITTEN ON THE <cast> RECORD, and that record is asked for INSIDE <reply_cast>
// (ONE_OFF_CLOTHES_ASK, handed to the roster with requestReplyCast in image-gen.js), beside the records it goes
// on: this block names the value, and the record is described in one place. Every "newclothes" comes with it,
// and the replies after it pick "same-as-last-picture" instead.
export const ONE_OFF_CLOTHES_ASK = `A character drawn in a <pic> this reply whose slot says outfit="newclothes": their record carries what they wear — ${writeCastRecord({
    name: 'their name',
    attributes: { outfit: 'newclothes', clothes: 'every garment they wear, each with its colour' },
})}. The clothes are the ones the story has them in now: every garment the prose names, completed so nothing they wear is left unsaid, and never contradicting it. Every "newclothes" comes with this record; in the replies after it, ON FILE offers these clothes as "same-as-last-picture".`;
// What the pictures ask for on a <cast> record this prompt, given imageDuties' answer: the one-off, on
// exactly the narrator's prompts that carry <outfit_rules> (sendsNarratorContract — Tags only included), and
// nothing on a prompt that only stores looks or whose pictures a POST call writes (the ask travels with that
// call's own <outfit_rules>).
export function castRecordAsks(duties) {
    return duties && duties.sendsNarratorContract ? [ONE_OFF_CLOTHES_ASK] : [];
}
export const OUTFIT_RULES_PROMPT = `<outfit_rules>
WHY: the extension, not the image model, dresses each person in the picture. It reads the outfit= of their slot (outfit2=, outfit3= … for the others) word for word and draws the clothes that value names, so every slot needs one, written exactly as shown here — in English, whatever language the story is in. A value it cannot recognise draws the wrong clothes. Your prose may be in any language. mainchar= works the same way, with the values [CAST] lists for {{user}}.
The values:
- a choice on the ON FILE line in <reply_cast> that names THAT character: an outfit on file draws those stored clothes; "same-as-last-picture", when <reply_cast> offers it for them, draws what they wore in their last picture, the outfit or clothes it lists after their name — pick it only while the story still has them in those clothes. Never a choice from a line that does not name them.
- "newclothes" — they wear clothes that none of those choices are: the story changed their clothes, or they have no ON FILE line — whoever the list leaves out has nothing on file, however often the story has met them before. It draws the clothes on their record, as <reply_cast> asks.
- "undressed" — the shot shows them without their clothes. Legal for anyone, and it OUTRANKS every other value: the [Composition] then states the actual state of undress.
outfit= names WHICH clothes, never how they sit right now: pushed up, torn or soaked is still the same outfit, and the [Composition] states it.
</outfit_rules>`;

// ── <scene_roster> — who the game state says is on screen ────────────────────
// Sent only on a card whose state carries a presence field (image-gen.js). The keys are REGISTRY keys,
// which can differ from how the story names a character, so this block defers to Names in <reply_cast>
// (NAME_RULES) instead of competing with it: a consumer whose state keys are romanized but whose prose is
// CJK must still get the story's spelling in char=. The list is the game's tracked characters, never a limit on
// who can be drawn: anyone the story names in the scene may be drawn and gets a record, listed or not — a list read as
// the whole cast leaves a named newcomer undrawn and without a record. It says nothing about who is ON FILE — that
// list is in <reply_cast>, which is always sent with this block.
export const SCENE_ROSTER_PROMPT = `<scene_roster>
On-screen now (game state):
{{present}}
This list is the game's tracked characters, not a limit on who can be drawn: anyone the story names in this scene may be drawn, listed or not, and gets their record.
Each line is a REGISTRY KEY: the spelling this game files that character under internally. A key is NOT necessarily how the story names them, and it is NEVER a spelling to copy into char=.
char= follows Names in <reply_cast>, including for everyone on this list: if the story names them differently from their key — a different script, a different form of the name — write the STORY's name, never the key.
This list says who is ON SCREEN, not who is ON FILE — that is the list in <reply_cast>.
Only draw someone actually in the scene right now.
</scene_roster>`;

// ── <explicit_rules> — the EXPLICIT/H composition floor ──────────────────────
// Injected only while the card's intimacy latch allows it (decideExplicitBlock, prompt-assembly-core.js).
// It is the story-agnostic floor every card needs: geometry, exposure, plain anatomy. A card that keeps
// per-position camera recipes supplies them itself, gated on the same latch, and this block defers to
// them for the camera only.
export const EXPLICIT_RULES_PROMPT = `<explicit_rules>
Apply to any sexual or nude beat; ignore for a clothed or neutral beat in the same scene.
- Header +"nsfw" ("explicit" for penetration) — the safety tag is a real signal.
- EXPOSURE: the image model cannot infer nudity — name exactly what is bared ("fully nude", "breasts exposed, skirt pushed up", "panties pulled aside"). outfit="undressed" ⇒ [Composition] MUST state the undress.
- POSITION AS GEOMETRY (the position lock): render a position by body ARRANGEMENT, never its name — who is over/under/behind, which limb where, exact contact/insertion state. Translations (same pattern for any act):
  · from behind ⇒ "she on hands and knees, him kneeling behind her, penis inserted in her vulva, his hands on her hips"
  · anal ⇒ "penis inserted in her anus, base against her buttocks"
  · blowjob ⇒ "tip of penis between her lips, lips around the glans, shaft outside"
  · deepthroat ⇒ "penis fully in her mouth past her lips, shaft into her throat, lips sealed at the base, nose at his pubic hair"
  · fingering ⇒ "two fingers between her labia, knuckles at the entrance, palm on her inner thigh"
  · handjob ⇒ "her hand around the shaft, tip above her thumb"
  · ride ⇒ "she straddles his hips, his penis in her vulva, thighs either side, hands on his chest"
  · two women ⇒ "CharName lying on her back, thighs apart, Char2Name kneeling between CharName's thighs, mouth on CharName's vulva, hands on CharName's hips"
  · one man, two women ⇒ "CharName on hands and knees, him kneeling behind CharName, penis inserted in CharName's vulva, Char2Name kneeling beside them, kissing CharName, his hand on Char2Name's chest"
  Blowjob with no penis named · penetration with no orifice + insertion state · combat with no weapon-bodypart impact = broken.
- PLAIN ANATOMY: penis, vulva, breasts, nipples, testicles, clitoris — never slang (cock/pussy) or euphemism (manhood, "her flower").
- FINISH/AFTERMATH: fluids + location ("semen on her stomach and thigh", "saliva at the corner of her mouth") + after-state (flushed skin, sweat, mussed hair, half-removed clothing).
- POSITION CAMERA: if the card supplies a camera recipe for the established position, use its camera (overrides <camera>).
</explicit_rules>`;

// ── the narrator's picture rules, as one message ─────────────────────────────
// What opens the narrator's prompt while it writes the pictures (image-gen.js): the card's contract (blank = the
// built-in one) in the narrator's words, then <outfit_rules>, <camera>, and <explicit_rules> while the intimacy latch
// allows it (`isExplicit`). The fixed rules come first so a provider's prompt cache reuses them; <explicit_rules>
// comes and goes with an explicit scene, so it costs the cache only from its place.
export function narratorPictureRules({ template = '', maxImages = 1, maxCharactersPerImage = 1, userOutfits = [], isExplicit = false } = {}) {
    let rules = renderPictureTemplate(template, { writer: 'narrate', maxImages, castRulesText: castRules(maxCharactersPerImage, { userOutfits }) });
    rules += '\n' + OUTFIT_RULES_PROMPT;
    rules += '\n' + CAMERA_RULES_PROMPT;
    if (isExplicit) rules += '\n' + EXPLICIT_RULES_PROMPT;
    return rules;
}

// ── the reader contract: what a POST call that writes the pictures is asked ──
// Built per reply as the picture task's POST instruction (plans/executed/picture-writer-route.md D5): the contract in the
// reader's words, the same <outfit_rules> and <camera> the narrator gets, <explicit_rules> while the intimacy latch
// reads on after the reply, <scene_roster> as presence stands after it, and a <reply_cast>. The reader <picture_count>
// is not part of it: it closes the reply the call reads (readerPictureInput, and <picture_count>'s note says why).
// The shared blocks send the reader to <reply_cast> for the ON FILE list, for records and for Names, so it gets one
// too, holding the ON FILE list (`onFile`, the roster's), the one record its pictures need (a one-off's clothes) and
// NAME_RULES, which its char= follows. The ask is scoped to the pictures, because the look task may ask the same call
// for records of its own.
const READER_ONE_OFF_CLOTHES_ASK = `RECORDS for your pictures — one kind: a character your <pic> draws with outfit="newclothes" gets a record of what they wear, on its own line after your tags — ${writeCastRecord({
    name: 'their name',
    attributes: { outfit: 'newclothes', clothes: 'every garment they wear, each with its colour' },
})}. The clothes are the ones the story has them in now: every garment the prose names, completed so nothing they wear is left unsaid, and never contradicting it. Every "newclothes" comes with this record; in the replies after it, ON FILE offers these clothes as "same-as-last-picture".`;
export function readerPictureContract({ template = '', maxImages = 1, maxCharactersPerImage = 1, userOutfits = [], isExplicit = false, scene = '', onFile = '' } = {}) {
    const replyCast = ['<reply_cast>', ...(onFile ? [onFile] : []), READER_ONE_OFF_CLOTHES_ASK, NAME_RULES, CAST_RECORD_FORMAT_RULES, '</reply_cast>'].join('\n');
    return [
        renderPictureTemplate(template, { writer: 'reader', maxImages, castRulesText: castRules(maxCharactersPerImage, { userOutfits }) }),
        OUTFIT_RULES_PROMPT,
        CAMERA_RULES_PROMPT,
        ...(isExplicit ? [EXPLICIT_RULES_PROMPT] : []),
        ...(scene ? [scene] : []),
        replyCast,
    ].join('\n');
}

// What the picture call reads: the reply with its lines numbered (picture-placement-core numberReplyLines), then the
// reader <picture_count>, the last thing it reads. `expandBlock` is the host's macro expansion: it runs on the count,
// never on the reply, whose text is the story's.
export function readerPictureInput(numberedReply, maxImages, expandBlock = (block) => block) {
    return [numberedReply, expandBlock(pictureCountRules(maxImages, { writer: 'reader' }))].join('\n\n');
}

// ── character looks: the registration texts (plans/reply-cast.md §4) ──────────────────────────
// A look is a cast record carrying body= and clothes= (or an outfit): the same record the narrator
// writes for everyone present, so ONE protocol names people and describes them. How a record is written
// comes from cast-record-format-core.js — every example below is built by writeCastRecord, so no text
// here spells the syntax by hand.
//
// TWO CARRIERS, routed by the LLM-task router (image-gen.js):
//   • the narrator (narrateRegistrationContract): its reply does not exist when its prompt is built, so it
//     is shown the ON FILE list in <reply_cast> and describes everyone who is not on it, once.
//   • a POST call (readerRegistrationContract): it reads the finished reply, so its text is built per turn
//     from the reply cast against the registry — registered people get one line each and write nothing,
//     newcomers get the full rules, and a turn with nobody new gets the short rules only (D4). Its records
//     go at the END of its output: a record inside a POST call's JSON block breaks that block's parse.
//
// name= is copied from the story's own text in the story's own script, never translated or romanized: it
// becomes the entry's key, and a romanized one matches no state key, no <pic char=…> and no other entry. body= and
// clothes= are English danbooru tags whatever the story's language, because they feed the image model: that rule is in
// CAST_RECORD_FORMAT_RULES, which every record ask carries, the one-off clothes ask included.
//
// body= STARTS WITH WHAT THE CHARACTER IS (man, woman, girl, elf woman …). The image prompt names every
// person neutrally ("<name> is: …", "the person in the frame is <name>: …"), so this first tag is the
// only word that tells the image model who to draw.
//
// NO AGE SLOT, and re-adding one breaks the whole registration call: a literal age beside figure tags is
// read by Google's filter as a minor described by build, and it kills the RESPONSE, not the record —
// finish_reason content_filter / PROHIBITED_CONTENT, usage all zeros, and every block the call was going
// to emit AFTER the records (its <UpdateVariable> state ops included) is never generated. The renderer
// takes age off the face, skin, hair and build tags that are already required.

const REGISTRATION_EXAMPLE = writeCastRecord({
    name: "the character's own name",
    attributes: {
        body: 'what the character is FIRST (man / woman / girl / elf woman …), then identity danbooru tags — face, hair colour+length+style, eye colour, skin, body/figure. NO clothing.',
        clothes: 'outfit danbooru tags — every garment currently worn.',
    },
});
const OUTFIT_EXAMPLE = writeCastRecord({
    name: 'their name',
    attributes: { outfit: 'cafe-waitress', clothes: 'every garment of this outfit, each with its colour — same pinning rule as above' },
});
const CLOTHES_CHANGE_EXAMPLE = writeCastRecord({
    name: 'their name',
    attributes: { clothes: 'every garment they now wear, each with its colour' },
});

// Who may be registered, and how a name is written. Every registration text carries it.
export const REGISTRATION_NAME_RULES = `NAMED MEANS NAMED: the story must have given a proper name you can copy. Only a role/appearance to call them by ("the middle-aged mage", "a guard", "the old man") ⇒ NOT registerable, however important — wait for the story to name them. A role or description as name= creates an entry nothing can match.
- name= IS NEVER A TRANSLATION: copy the name character-for-character from the story's own text, in the story's own script. NEVER translate, romanize, transliterate, shorten, or reformat — Chinese/Japanese/Korean/Russian names STAY in that script. Same spelling every time. A <pic> naming them ⇒ name= matches that tag's char= exactly.`;

// A NEW character's look. Only a text that asks for one carries it.
export const REGISTRATION_BODY_RULES = `Describing a character (identity + current outfit), one record:
${REGISTRATION_EXAMPLE}
- PIN EVERY SLOT — this is DNA, not a description. The image model has NO memory: anything left out or vague is RE-INVENTED on every render and the character drifts. Spend tags where identity lives — WHAT THEY ARE comes first, then HAIR carries the most, then eyes, then figure:
  · WHAT THEY ARE — the FIRST tag of body=, never omitted: the plain noun for this character — "man" · "woman" · "girl" · "boy" · "elf woman" · "dwarf man" · "android". The image model draws the subject this word names; without it the character is drawn as whatever the style defaults to.
  · HAIR and EYES are the two slots registrations fail at most often, so they are not free-form: FILL THE FORM BELOW, one tag per numbered line, every line present, in this order. A missing line is a missing tag.
    HAIR — 6 lines, NEVER omitted (hair is the single strongest identity signal):
      1 <colour> hair            e.g. "plum-purple hair" · "ash-blonde hair" · "silver grey hair"
      2 <a SECOND, different shade of that same colour> hair   e.g. "pink-purple gradient hair" · "honey blonde hair" · "pale platinum hair"
      3 <length> hair            e.g. "long hair" · "short hair" · "shoulder-length hair"
      4 <how it falls>           e.g. "straight hair" · "wavy hair" · "layered hair" · "hair over one shoulder"
      5 <bangs>                  e.g. "center-parted bangs" · "blunt bangs" · "side-swept bangs" · "hair over one eye" · "no bangs"
      6 <tie / updo / sidelocks> e.g. "twin braids" · "high ponytail" · "hair bun" · "sidelocks" · "loose hair"
      Bald or shaved is itself a value: write it, then fill the remaining lines with what IS there (stubble colour, hairline).
    EYES — 3 lines:
      1 <colour> eyes            e.g. "amber eyes" · "cyan eyes"
      2 <a SECOND, different shade of that same colour> eyes  e.g. "warm honey-colored eyes" · "pale turquoise eyes"
      3 <shape / set> eyes       e.g. "almond eyes" · "deep-set eyes" · "sharp eyes" · "drooping eyes" · "tsurime"
      ("focused eyes" / "kind eyes" are EXPRESSIONS, not colours or shapes — they belong to the resting-expression slot.)
    WHY LINE 2 IS NOT REDUNDANT, and why you must not delete it: an image model weights a colour by how often it sees it. One mention of a colour is a suggestion the renderer may drift away from; two mentions in different words are an INSTRUCTION it holds. It reads as repetition to you and as emphasis to the renderer — that is the entire point, and it is the single most effective line in this whole contract. Never collapse lines 1 and 2 into one tag, and never drop line 2 because it "already said that".
  · FIGURE 4+ tags: HEIGHT (a number if the story gives one, else tall/short/petite/average) + build specifics — "slim" alone is not a build: narrow shoulders, broad shoulders, muscular, hourglass, slim waist, long legs, …
  · FACE 3+ tags: shape + concrete features (small delicate face, rounded chin, aquiline nose, hollow cheeks, nasolabial folds).
  · RESTING EXPRESSION 2+ tags — their DEFAULT face, part of who they are: "soft gentle expression, mild closed-mouth smile" · "cold flat stare, thin pressed lips". Not the mood of one scene; the look they wear by default.
  · plus: skin tone · any distinguishing mark shown (a scar, a mole, calluses).
  · NO AGE TAG, EVER. Not "17-year-old", not "40s", not "middle-aged", not "teenage" — no age in body=, no age anywhere in the tag. Age is not a tag the renderer needs: it already reads it off the slots you fill. Put it THERE instead — face ("smooth round cheeks" / "lined face" / "deep nasolabial folds"), skin, hair ("greying temples"), build ("petite" / "broad-shouldered"). Those render; a number does not.
  · body= carries NO clothing — that includes headwear and hair accessories. A maid cap, a hairpin, a ribbon, a crown belong in clothes=, never in body=.
- DENSITY FLOOR: body= 18+ tags TOTAL, allocated as above — 18 face tags with no hair is NOT DNA. clothes= 6+ garments/details. More pinned detail is always better; every extra tag is one less thing the renderer re-rolls.
- EVERY DESCRIBED CHARACTER GETS THE FULL FLOOR — a maid, a guard, a shopkeeper, a rival, a love interest, all identical. If someone is worth describing at all they are worth showing again, and a thin description re-rolls them into a different person every time they appear. Never spend less on a minor character.
- BEFORE YOU EMIT, COUNT — and check the first tag and the two restatements FIRST, they are the lines most often missing:
  first tag: does body= open with what the character is (man / woman / girl / …)?
  hair: are lines 1 AND 2 both present, naming the SAME colour two different ways? are all 6 lines there?
  eyes: are lines 1 AND 2 both present, same colour two ways? all 3 lines?
  then: figure ≥4 (height named?) · face ≥3 · resting expression ≥2 · SKIN TONE present · body ≥18 total · clothes ≥6, every one with a colour, every layer named · zero clothing or headwear inside body=.
  Any line short ⇒ fill it before emitting the tag. Do not emit a description that fails this count.
- BANNED tags: vibe/category words that pin nothing — "scholar appearance", "handsome", "ordinary looks", "sharp features". One visible attribute, one CONCRETE value, per tag.
- Story shows a detail ⇒ COPY it. Story silent on a required slot ⇒ CHOOSE a plausible value and COMMIT — this description becomes the canonical look.
- COMMIT MEANS BE SPECIFIC, NOT SAFE. When you invent a value, pick a DISTINCTIVE one over a generic one: "ash-blonde" over "blonde", "chipped front tooth" over "even teeth", "left eyebrow scar" over "thin eyebrows". Generic values make every character look like every other character — the registry exists to keep them apart, and a bland entry defeats it as surely as a vague one.
- WRITE TAGS THE IMAGE MODEL KNOWS. Prefer plain danbooru-style vocabulary over literary phrasing: "twin braids" not "hair bound in a pair of plaits", "hime cut" / "bob cut" / "messy hair" / "ahoge" / "blunt bangs" / "side ponytail" / "hair over one eye" for hair · "freckles" / "mole under eye" / "eyebags" / "sharp eyes" / "tsurime" / "tareme" for face · "petite" / "muscular" / "lanky" / "plump" for build. One concept per tag, lowercase, no underscores.
- ORDER MATTERS: write body= as what they are, then height/build, then face, then EYES, then HAIR LAST — trailing tags land closest to the render and the hair is what most distinguishes the character. clothes= runs head to toe.
- SEPARATE THE PERMANENT FROM THE TEMPORARY. body= holds only what is true of this person on ANY day: their face, hair, build, permanent marks. A wound taken this scene, tears, a blush, sweat, dirt, dishevelment, a temporary disguise — none of that belongs in the registry; it is written per-image in the composition instead. Registering "bleeding forehead" makes them bleed forever.
  GOOD body (what · hair 6 · eyes 3 · figure 4 · face 3 · expression 2 + skin): "man, tall, thin, narrow shoulders, straight posture, gaunt face, hollow cheeks, sharp jawline, pale skin, grey-streaked black hair, dark grey hair, short hair, swept back, side-parted, widow's peak, sharp grey eyes, grey-blue eyes, deep-set eyes, cold flat stare, thin pressed lips"
  BAD body (hair 5 lines not 6, eyes 2 not 3, NEITHER colour restated, no skin tone): "woman, 172cm tall, athletic build, muscular legs, defined abs, oval face, strong jawline, cold expression, thin pressed lips, cyan eyes, sharp eyes, silver grey hair, short hair, straight hair, layered hair, side-swept bangs"
  ↑ FIXED: add "pale skin" · eyes become "cyan eyes, pale turquoise eyes, sharp eyes" · hair becomes "silver grey hair, pale platinum hair, short hair, straight hair, layered hair, side-swept bangs"
  BAD body (hair 3, eyes 1, face 1 — and a maid cap is CLOTHING): "girl, 158cm, slim waist, petite build, delicate face, pale skin, grey hair, long hair, hair tied back, maid cap, light brown eyes, flat chest, slim legs"
  BAD body (11 tags but ZERO hair — density in the wrong slots): "man, tall, thin, slightly stooped, sallow skin, aquiline nose, sunken eye sockets, deep nasolabial folds, cold light blue eyes, thin eyebrows, stained fingertips"
  BAD body (no noun for what they are, and pins nothing): "scholar appearance, dark hair, focused eyes, serious expression"
- body = identity ONLY · clothes = the CURRENT outfit ONLY · one record per character.`;

// How to describe clothes — for a newcomer, a new outfit and a correction alike.
export const REGISTRATION_CLOTHES_RULES = `- clothes= : each WORN garment with its COLOUR (+ material/trim when shown), everything visible head to toe — headwear, top, bottom, legwear, footwear, accessories. "magician robe" re-rolls every image; "dark blue hooded robe, silver trim, black silk gloves, brown leather belt, black boots" does not. HELD items (staff, weapon, bag) are NOT clothing — leave them out, the per-image composition carries them.
- DRESS THE WHOLE BODY. Name something for every layer the camera can reach: headwear (or none), top, bottom, legwear, footwear, and at least one accessory. An unnamed layer is re-rolled — describe a skirt and no legwear and they get different stockings every image. If the story never showed their shoes, choose shoes and commit.
  GOOD clothes: "black maid dress, white lace-trimmed collar, white apron, black hair ribbon, white cotton stockings, round-toed black shoes, brass key ring at waist"
  BAD clothes (no colours, layers missing): "maid uniform, apron, stockings, shoes"`;

// Which clothes a model saves, and under what name (dna-core registrationClothesTarget). A character's FIRST
// clothes are always saved (D29): a new character's record keeps them under its outfit name when they are static,
// else as her "default". After that only STATIC clothes are saved, because an outfit's name is all the narrator is
// ever shown of it: the name has to say which clothes it is, and clothes that change from scene to scene have no
// name that could.
export const REGISTRATION_OUTFIT_RULES = `Outfit — what outfit= beside clothes= says:
- A place or role fixes it, the same for everyone there (a café's waitress uniform, a police uniform), or the story presents it as what this character always wears: saved under a <place or role>-<outfit> name — "cafe-waitress", "police-uniform", "detective-coat" — never a bare garment ("swimsuit", "uniform", "casual"). Lowercase latin words joined by "-", even when name= is another script. "undressed", "newclothes" and "same-as-last-picture" are never outfit names.
- Anything else they wear is a one-off: outfit="newclothes".
A NEW character's record always carries outfit= beside body= and clothes=, and her clothes are always kept: under that outfit name, or, with "newclothes", as her "default" outfit, which later pictures can name. Once a character has any clothes saved, a one-off is never saved, and she gains a saved outfit with a record like this:
${OUTFIT_EXAMPLE}`;

/**
 * The narrator's look contract (narrate route). The narrator is shown the ON FILE list in <reply_cast>
 * and describes everyone who is not on it, once.
 * @param {object} [options]
 * @param {boolean} [options.isStoring] true when the looks are stored (auto-harvest): every named character
 *        in the reply is described. false when they only dress this reply's pictures: only the drawn ones.
 */
export function narrateRegistrationContract({ isStoring = true } = {}) {
    const who = isStoring
        ? 'every named character in this reply who is NOT ON FILE'
        : 'every character a <pic> in this reply draws (any char= slot) who is NOT ON FILE';
    const after = isStoring
        ? 'The extension stores it, and from then on they are ON FILE. The picture in the reply that describes them says outfit="newclothes", whatever their record\'s outfit= says: their clothes are ON FILE from the next reply.'
        : 'Nothing is stored: a character who is not ON FILE is described again each reply that draws them.';
    const attributes = isStoring ? 'body=, clothes= and outfit= (Outfit, below)' : 'body= and clothes=';
    return [
        `You describe characters' looks so their pictures stay consistent. Your reply already carries a cast record for every named character present (<reply_cast>). On the record of ${who}, also write ${attributes}. ${after}`,
        'ON FILE IS THE ONLY EVIDENCE: the ON FILE list in <reply_cast> is what the extension holds. No other text shown to you is — not <scene_roster>, not your own earlier replies. Listed ⇒ the name only. Not listed ⇒ describe them, however familiar they feel. Describing someone already stored costs only tokens; leaving out someone who is NOT ON FILE is the ONLY failure with a cost — they are then drawn with no look at all.',
        'Never two records for the SAME character in one reply.',
        ...(isStoring ? ['A one-scene passer-by you did NOT draw (waiter, gate guard, face in a crowd) needs no description, however vivid.'] : []),
        REGISTRATION_NAME_RULES,
        REGISTRATION_BODY_RULES,
        REGISTRATION_CLOTHES_RULES,
        ...(isStoring ? [REGISTRATION_OUTFIT_RULES] : []),
        CAST_RECORD_FORMAT_RULES,
    ].join('\n');
}

// One registered character as the POST call sees them: every name they answer to and their outfits, plus
// their clothes on file when [AllowUpdate] lets the story correct them.
function registeredMemberLines(member) {
    const outfits = member.outfits.length ? member.outfits.join(', ') : 'none on file';
    const head = `- ${member.names.join(' / ')} — outfits: ${outfits}`;
    if (!member.allowUpdate) return head;
    const onFile = Object.entries(member.clothes || {}).map(([outfit, text]) => `${outfit}: ${text}`).join(' · ');
    return `${head}\n  clothes on file (may be corrected) — ${onFile || 'none'}`;
}

/**
 * The POST call's registration text, built per turn from the reply cast against the registry.
 * `registered` and `newcomers` are classifyReplyCast's result for this reply (character-roster).
 */
export function readerRegistrationContract({ registered = [], newcomers = [] } = {}) {
    const intro = 'You maintain the character-image registry: each character\'s visual DNA, kept so their art stays consistent. You did not write the reply you are given, and the registry draws nothing: it keeps looks. Everything you write for the registry is a cast record on a line of its own, outside any other block: the extension reads the records wherever they stand in your answer, beside anything else this prompt asks you to write.';
    if (!registered.length && !newcomers.length) {
        return `${intro}\nNobody in this reply needs anything from the registry: write no registry record this reply.`;
    }
    const parts = [intro];
    if (newcomers.length) {
        parts.push(`REGISTER these characters — one record each, with body=, clothes= and outfit= as this reply shows them (Outfit, below): ${newcomers.join(', ')}`);
    }
    if (registered.length) {
        parts.push(`ALREADY REGISTERED — the registry needs nothing for them, except a record for a static outfit (Outfit, below) this reply shows them wearing that is NOT in their list:
${registered.map(registeredMemberLines).join('\n')}`);
        if (registered.some((m) => m.allowUpdate)) {
            parts.push(`A character whose clothes on file are shown above: if this reply shows one of those outfits with different garments or colours, write it as the reply shows it — ${CLOTHES_CHANGE_EXAMPLE} for their default outfit, or an outfit record with that outfit's key. Clothes that are none of their outfits follow the Outfit rules. Same clothes ⇒ no registry record.`);
        }
    }
    parts.push(REGISTRATION_NAME_RULES);
    if (newcomers.length) parts.push(REGISTRATION_BODY_RULES);
    parts.push(REGISTRATION_CLOTHES_RULES, REGISTRATION_OUTFIT_RULES, CAST_RECORD_FORMAT_RULES);
    return parts.join('\n');
}

// Detection regex (string form — user-editable in settings, compiled via regexFromString). Matches
// `<pic ...>` ONLY. A user whose saved settings carry another pattern keeps it — the stored regex wins
// over this default, and "Reset detection regex" on the Image tab is the way back.
// The pre-prompt scanner `(?:"[^"]*"|[^"<])*?` consumes whole quoted attribute values as units, so
// attributes BEFORE prompt= (char="X" outfit="Y") are crossed correctly, and a stray `>` from the common
// auto-close slip (`<pic> prompt="..."`) is still bridged. Group 1 = the prompt.
// `[^"<]`, NOT `[^"]`: an unbounded bridge across `>` lets one match eat through a closing `>`, the
// escaped debug line, whole paragraphs of prose and the <UpdateVariable> JSON until it reaches the NEXT
// raw pic's `prompt="…"` — and the leftover sweep then escapes or deletes that entire span. Excluding `<`
// caps the bridge at the first other element: an anchor with no prompt= of its own dies the moment it
// would cross into one, while the auto-close slip (no `<` before its prompt=) keeps working. The tail is
// `[^<>]*>` for the same reason.
export const DEFAULT_REGEX = '/<pic\\b(?:"[^"]*"|[^"<])*?\\bprompt\\s*=\\s*"([^"]*)"[^<>]*>/gi';

// Attribute reader for the raw matched tag (match[0]). Attributes may appear in any order; all are
// optional. Values are double-quoted per the contract. `\b` keeps `char` from matching inside
// `mainchar`, and `outfit` from matching `outfit2` (the `=` must follow the name).
export function tagAttr(rawTag, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(rawTag || '');
    return m ? m[1].trim() : '';
}
