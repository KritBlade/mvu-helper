/**
 * MVU Helper — imagegen template tests (imagegen/default-template.js).
 *
 * The <pic> detection contract: DEFAULT_REGEX (what counts as an image tag in a reply,
 * including the auto-close model slip) and tagAttr (attribute reading in any order).
 * Pure — no ST imports — so it loads under vitest.
 *
 * Run:  npm test
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as imageTemplate from '../src/features/imagegen/default-template.js';
import { tagAttr, DEFAULT_REGEX } from '../src/features/imagegen/default-template.js';
import { readCastRecords, NAME_RULES } from '../src/features/character-roster/cast-record-format-core.js';

describe('tag detection (<pic> only, attrs in any order)', () => {
    const strToRegex = (s) => {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(s);
        return new RegExp(m[1], m[2]);
    };
    it('DEFAULT_REGEX matches <pic> and captures the prompt', () => {
        const re = strToRegex(DEFAULT_REGEX);
        const mes = '<pic char="Mitsuki" prompt="p1"> and <pic prompt="p2" type="scene">';
        const matches = [...mes.matchAll(re)];
        expect(matches.map((m) => m[1])).toEqual(['p1', 'p2']);
    });
    it('MUTATION TARGET — <img> is NOT ours (alias retired 2026-08-29)', () => {
        // Owning that spelling meant the leftover disposition could not tell a card's tag from a
        // preset's, another extension's, or the prose's own real <img> — and it has to decide
        // whether to delete one. Nothing downstream needs it: the beat-shaper gates on /<pic\b/i.
        const re = strToRegex(DEFAULT_REGEX);
        const mes = '<img char="Mitsuki" prompt="p1"> and <img src="/a.png" prompt="p2">';
        expect([...mes.matchAll(re)]).toHaveLength(0);
    });
    // <camera> and [CAST] tell the narrator to write mainchar= after prompt=, so detection and tagAttr must read it there.
    it('MUTATION TARGET — an attribute written after prompt= is detected with the tag and read', () => {
        const re = strToRegex(DEFAULT_REGEX);
        const mes = '<pic char="Leila" outfit="default" camera="from-below" prompt="1girl, 1boy, leaning in" mainchar="town-casual"> next';
        const matches = [...mes.matchAll(re)];
        expect(matches.map((m) => m[1])).toEqual(['1girl, 1boy, leaning in']);
        expect(tagAttr(matches[0][0], 'mainchar')).toBe('town-casual');
    });
    it('tolerates the auto-close slip (<pic> prompt="...")', () => {
        const re = strToRegex(DEFAULT_REGEX);
        const matches = [...'<pic> prompt="rescued">'.matchAll(re)];
        expect(matches.length).toBe(1);
        expect(matches[0][1]).toBe('rescued');
    });
    it('tagAttr reads attributes regardless of order, missing → empty string', () => {
        const tag = '<pic type="closeup" outfit="gym" char="Mitsuki" prompt="x">';
        expect(tagAttr(tag, 'char')).toBe('Mitsuki');
        expect(tagAttr(tag, 'outfit')).toBe('gym');
        expect(tagAttr(tag, 'type')).toBe('closeup');
        expect(tagAttr(tag, 'scene')).toBe('');
    });
});

// ── QUALITY vs STYLE: exactly one layer emits each token ─────────────────────
// composeImagePrompt builds `<prefix>, <composition>`, so a token written into BOTH the contract and
// the card's /sd prefix preset reaches the image model twice. QUALITY and STYLE both belong to the
// preset, because the preset is per-card: a word placed in the contract rides along on every card,
// including one that deliberately picked a different checkpoint, and no setting can switch it off.
// The contract keeps NONE of them: it names what is in the picture, never how it is rendered.
// The preset's shipped text is read from SOURCE — sd-prompt-prefix-presets.js imports the ST settings
// store, so it cannot be imported under vitest.
describe('quality/style tokens have exactly one emitter', () => {
    const presetSource = readFileSync(new URL('../src/features/imagegen/sd-prompt-prefix-presets.js', import.meta.url), 'utf8');
    const preset = presetSource.match(/^\s*text: '([^']+)',/m)[1].toLowerCase();
    // EVERY exported block, DISCOVERED rather than listed: a block added later is swept without
    // anyone remembering to add it here, which is the only version of this guard that survives.
    // DEFAULT_REGEX is the detection pattern, not text sent to a model.
    const injected = Object.fromEntries(Object.entries(imageTemplate)
        .filter(([name, value]) => typeof value === 'string' && name !== 'DEFAULT_REGEX'));

    it('the sweep actually reaches every block — an empty set would pass every test below', () => {
        expect(Object.keys(injected).length).toBeGreaterThanOrEqual(7);
    });

    it('MUTATION TARGET — no token is emitted by both the contract and the built-in preset', () => {
        for (const token of ['masterpiece', 'best quality', 'highly detailed', 'anime screencap', 'very aesthetic']) {
            for (const [name, text] of Object.entries(injected)) {
                const both = text.toLowerCase().includes(token) && preset.includes(token);
                expect(both, `"${token}" is emitted by BOTH ${name} and the default preset — the model sees it twice`).toBe(false);
            }
        }
    });

    it('MUTATION TARGET — no injected block names a STYLE, so a realistic card stays realistic', () => {
        for (const style of ['anime', 'cel-shading', 'screencap', 'photoreal', 'oil painting']) {
            for (const [name, text] of Object.entries(injected)) {
                expect(text.toLowerCase(), `${name} must not name the "${style}" style — style is the per-card preset's`).not.toContain(style);
            }
        }
    });

    it('MUTATION TARGET — no injected block emits a standard render tag: every one belongs to the preset', () => {
        for (const token of ['masterpiece', 'best quality', 'highly detailed', 'ultra detailed', 'absurdres']) {
            for (const [name, text] of Object.entries(injected)) {
                expect(text.toLowerCase(), `${name} must not emit "${token}" — a card cannot switch it off from there`).not.toContain(token);
            }
        }
    });

    it('MUTATION TARGET — the built-in preset carries every standard tag: quality, detail and style', () => {
        expect(preset).toContain('masterpiece, best quality');
        expect(preset).toContain('highly detailed');
        expect(preset).toContain('anime screencap');
    });
});

// ── registration texts speak the record format, never a hand-spelled tag ─────
// Every example a registration text shows is built by writeCastRecord (cast-record-format-core.js), so
// changing the record format changes every instruction with it. MUTATION TARGET: hand-type an example
// with a closer or a stray attribute syntax and this fails.
describe('registration texts: every example is a readable cast record', () => {
    const texts = [
        imageTemplate.narrateRegistrationContract({ isStoring: true }),
        imageTemplate.narrateRegistrationContract({ isStoring: false }),
        imageTemplate.ONE_OFF_CLOTHES_ASK,
        imageTemplate.readerRegistrationContract({
            registered: [{ key: 'A', names: ['A'], outfits: ['default'], allowUpdate: true, clothes: { default: 'coat' } }],
            newcomers: ['B'],
        }),
    ];
    it('each <cast …> in the text reads back as a record with a name', () => {
        for (const text of texts) {
            const found = text.match(/<cast\b[^\n]*/g) || [];
            expect(found.length).toBeGreaterThan(0);
            for (const line of found) {
                const { records, invalid } = readCastRecords(line);
                expect(invalid).toEqual([]);
                expect(records.length).toBeGreaterThan(0);
            }
            expect(text).not.toMatch(/<\/cast/);
        }
    });
});

// Every picture renders at the card's Image type, so the narrator is never taught type=: a
// vocabulary the code ignores would only spend tokens and invite the model to argue with the setting.
describe('the narrator is not taught type=', () => {
    it('MUTATION TARGET — no shipped <pic> instruction mentions type=', () => {
        const texts = {
            DEFAULT_PROMPT: imageTemplate.DEFAULT_PROMPT,
            OUTFIT_RULES_PROMPT: imageTemplate.OUTFIT_RULES_PROMPT,
            ONE_OFF_CLOTHES_ASK: imageTemplate.ONE_OFF_CLOTHES_ASK,
            'castRules(1)': imageTemplate.castRules(1),
            'castRules(3)': imageTemplate.castRules(3, { userOutfits: ['default', 'gym'] }),
            'pictureCountRules(1)': imageTemplate.pictureCountRules(1),
            'pictureCountRules(3)': imageTemplate.pictureCountRules(3),
        };
        for (const [name, text] of Object.entries(texts)) {
            expect(text, name).toBeTypeOf('string');
            expect(text, name).not.toMatch(/\btype=/);
        }
    });
});

// ── the [CAST] rules are built from the card's own ceiling ───────────────────
// A CEILING, never a target: one person alone is a normal shot, and nobody is added to reach the number.
describe('castRules — who may be in one image', () => {
    it('states the card\'s own number as a ceiling, never a target', () => {
        for (const n of [2, 3, 5]) {
            const text = imageTemplate.castRules(n);
            expect(text).toContain(`Up to ${n} people with a stored look per image — a CEILING, never a target`);
            expect(text).toMatch(/One person alone \(one named character, or \{\{user\}\} alone\) is a normal shot/);
            expect(text).toContain(`never add someone to reach ${n}`);
        }
    });

    it('one: a named character OR {{user}}, never both', () => {
        const text = imageTemplate.castRules(1);
        expect(text).toContain('ONE person with a stored look per image: one named character (char=, with mainchar="not-in-picture") OR {{user}} (an outfit in mainchar=), never both');
        expect(text).not.toMatch(/char2=/);
    });

    // MUTATION TARGET: the image prompt says nowhere where anyone stands, so a rule tying the slots to
    // left and right hands the narrator a duty nothing reads, and its placeholders must not imply one.
    it('slots carry no position, each has its own outfit, and the two-person shape is shown', () => {
        const text = imageTemplate.castRules(3);
        expect(text).toMatch(/takes one slot: char=, then char2=, char3= …, each with its own outfit=/);
        expect(text).toContain('Any person may take any slot; where each one stands belongs in the composition.');
        expect(text).toContain('<pic char="CharName" outfit="CharOutfit" char2="Char2Name" outfit2="Char2Outfit"');
        expect(text).not.toMatch(/leftmost|left-to-right|from the LEFT|LeftKey|RightKey/);
    });

    // The shapes are what a narrator copies. With only the two-named-characters shape shown, a narrator drawing {{user}}
    // beside one girl copied the one-person shape and left mainchar= off (staging msgs 196-212): {{user}} was drawn
    // with no look, as a child for "1boy".
    it('MUTATION TARGET — the shapes show {{user}} in the tag: beside a named character, and alone on a one-person card', () => {
        const three = imageTemplate.castRules(3);
        expect(three).toContain('two named characters: <pic char="CharName" outfit="CharOutfit" char2="Char2Name" outfit2="Char2Outfit" camera="Camera" prompt="CompositionText" mainchar="not-in-picture">');
        expect(three).toContain('a named character with {{user}}: <pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="CompositionText" mainchar="UserOutfit">');
        expect(imageTemplate.castRules(1)).toContain('{{user}} alone is this shape:\n<pic camera="Camera" prompt="CompositionText" mainchar="UserOutfit">');
    });

    // The count tag is where the narrator reliably writes {{user}}; the rule ties every person it counts to the tag, and
    // says why: the look is attached from the tag, so a counted person missing from it is made up by the image model.
    it('MUTATION TARGET — every person the count tag counts is in the tag, unnamed strangers aside, and the rule says why', () => {
        expect(imageTemplate.castRules(3)).toContain('- EVERY PERSON YOUR COUNT TAG COUNTS IS IN THE TAG: a named character in a slot (char=, char2= …), {{user}} as an outfit in mainchar= — only an unnamed stranger stays out (scenery, below).');
        expect(imageTemplate.castRules(1)).toContain('- EVERY PERSON YOUR COUNT TAG COUNTS IS IN THE TAG: a named character in char=, {{user}} as an outfit in mainchar= — only an unnamed stranger stays out (scenery, below).');
        for (const ceiling of [1, 3]) {
            const text = imageTemplate.castRules(ceiling);
            expect(text).toContain('a person counted but missing from it gets no look and the image model makes one up from your words');
            expect(text).toContain('"1girl, 1boy, boy holding a helmet" with mainchar="not-in-picture" draws a stranger, often a child, where {{user}} should be.');
            expect(text).toContain('Drawing fewer people than the scene holds is fine — only the ones you draw are counted.');
        }
        const contract = imageTemplate.DEFAULT_PROMPT;
        expect(contract).toContain('— each one you count is in the tag ([CAST])');
        expect(contract).toContain('everyone the count tag counts is in the tag, unnamed strangers aside');
    });

    // [CAST] is the one home of who is in the tag; every other block names it. A restated rule drifts, and a weak model
    // argues the copies against each other. MUTATION TARGET: paste the count-tag consequence, the mainchar= rule or its
    // shapes back into <camera>, or the look/scenery restatements back into the contract, and this fails.
    it('MUTATION TARGET — who is in the tag is stated in [CAST] alone: <camera> and the contract point to it', () => {
        const camera = imageTemplate.CAMERA_RULES_PROMPT;
        expect(camera).not.toMatch(/mainchar="/);
        expect(camera).not.toMatch(/makes up a stranger|count tag/);
        expect(camera).toContain('mainchar= states ([CAST])');
        const contract = imageTemplate.DEFAULT_PROMPT;
        expect(contract).not.toMatch(/\[SHOT SCOPE\]/);
        expect(contract).not.toMatch(/spend zero words|never write anyone's look|Never borrow one person's look|never how they look/);
        expect(contract).not.toContain('everyone you count is in the tag: a slot, or an outfit in mainchar=');
    });

    // The values are <outfit_rules>'. An example that writes outfit="default" teaches the one value a
    // character whose outfits are all named does not have — and draws her with nothing attached.
    it('MUTATION TARGET — no shipped example writes an outfit value', () => {
        expect(imageTemplate.castRules(3)).not.toMatch(/\boutfit2?="default"/);
        expect(imageTemplate.DEFAULT_PROMPT).not.toMatch(/\boutfit="default"/);
        expect(imageTemplate.renderPictureTemplate('', { writer: 'narrate' })).toContain('<pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="CompositionText" mainchar="UserOutfit">');
        expect(imageTemplate.renderPictureTemplate('', { writer: 'reader' })).toContain('<pic at="LineNumber" char="CharName" outfit="CharOutfit" camera="Camera" prompt="CompositionText" mainchar="UserOutfit">');
    });

    // A model fills in a one-word placeholder and copies anything that reads as text: a sample prompt= opening
    // with "[Composition]" had a narrator open its real prompt= with that label. Real values (at= line numbers,
    // "not-in-picture") are the only other values a shape may hold.
    it('MUTATION TARGET — every sample value in every shape is one placeholder word', () => {
        const shapes = [
            imageTemplate.renderPictureTemplate('', { writer: 'narrate' }),
            imageTemplate.renderPictureTemplate('', { writer: 'reader' }),
            imageTemplate.castRules(1),
            imageTemplate.castRules(3),
            imageTemplate.pictureCountRules(2),
            imageTemplate.pictureCountRules(2, { writer: 'reader' }),
        ].flatMap((text) => text.match(/<pic\b[^>]*=[^>]*>/g) || []);
        expect(shapes).toHaveLength(9);
        const notPlaceholders = shapes.flatMap((shape) => [...shape.matchAll(/([\w-]+)="([^"]*)"/g)]
            .filter(([, name, value]) => !/^[A-Z][A-Za-z0-9]*$/.test(value)
                && value !== imageTemplate.MAINCHAR_NOT_IN_PICTURE
                && !(name === 'at' && /^\d+$/.test(value)))
            .map(([attribute]) => attribute));
        expect(notPlaceholders).toEqual([]);
    });

    // An observation, never a judgment of how much of {{user}} shows: any part in the frame puts {{user}} in the shot.
    // Every tag carries mainchar=: an attribute written only when a condition holds is one the narrator drops.
    it('MUTATION TARGET — mainchar= on every tag: an outfit whenever any part of {{user}} is in the frame, "not-in-picture" for no part or a pov shot', () => {
        const text = imageTemplate.castRules(3, { userOutfits: ['default', 'gym', 'swimsuit'] });
        expect(text).toContain("- mainchar= : on EVERY tag, written last, after prompt=, so the count tag you just wrote decides it. ANY part of {{user}}'s body in the frame (all of {{user}}, or only a chest, lap, arm or hand) ⇒ ");
        expect(text).toContain("one of {{user}}'s outfits (gym, swimsuit)");
        expect(text).toContain("No part of {{user}} in the frame, or a pov shot (the camera is {{user}}'s eyes; POV HANDS below) ⇒ mainchar=\"not-in-picture\".");
        expect(text).not.toMatch(/Leave it out/);
        expect(text).not.toMatch(/is visible in the shot|Not visible/);
        expect(text).toMatch(/counts toward the 3 but never takes a char slot/);
        expect(imageTemplate.castRules(3)).toContain('mainchar="default", "same-as-last-picture" when <reply_cast> offers it for {{user}}, or "undressed" when {{user}} is shown without clothes');
        for (const ceiling of [1, 3]) expect(imageTemplate.castRules(ceiling, { userOutfits: ['school-uniform'] })).not.toContain('"none"');
    });

    // MUTATION TARGET: offer "default" to an entry whose outfits are all named and he is drawn bare.
    it('mainchar= offers "default" only when his entry has one', () => {
        const named = imageTemplate.castRules(3, { userOutfits: ['school-uniform', 'school-gym'] });
        expect(named).toContain(`mainchar= one of {{user}}'s outfits (school-uniform, school-gym), "same-as-last-picture" when <reply_cast> offers it for {{user}}, or "undressed" when {{user}} is shown without clothes`);
        expect(named).not.toContain('mainchar="default"');
    });

    // Every shipped shape writes the same sample in mainchar=. A narrator wrote that sample on every picture of {{user}},
    // drawn with no clothes; the rule calls it a sample beside the list it must be picked from, naming the one the
    // shapes write.
    it('MUTATION TARGET — the mainchar= rule calls the shapes\' "UserOutfit" a sample, beside the list, at every ceiling', () => {
        const samplesIn = (text) => [...text.matchAll(/mainchar="([^"]+)">/g)].map((m) => m[1]).filter((v) => v !== 'not-in-picture');
        const shapes = [
            imageTemplate.renderPictureTemplate('', { writer: 'narrate' }),
            imageTemplate.renderPictureTemplate('', { writer: 'reader' }),
            imageTemplate.CAMERA_RULES_PROMPT,
            imageTemplate.pictureCountRules(3),
            imageTemplate.pictureCountRules(3, { writer: 'reader' }),
        ];
        for (const ceiling of [1, 3]) {
            for (const userOutfits of [[], ['school-uniform', 'town-casual']]) {
                const text = imageTemplate.castRules(ceiling, { userOutfits });
                expect([...new Set([text, ...shapes].flatMap(samplesIn))]).toEqual(['UserOutfit']);
                expect(text).toContain('or "undressed" when {{user}} is shown without clothes. Do NOT use the sample "UserOutfit" — it is a sample: pick from this list. No part of {{user}} in the frame');
            }
        }
    });

    // D30: what he wore in his last picture is a value of mainchar=, named here; WHAT it draws changes with the
    // story, so <reply_cast> prints it and this block, which opens the prompt for the cache, never does.
    // MUTATION TARGET: drop it and the narrator re-picks his outfit from the bare list after a picture without him.
    it('MUTATION TARGET — mainchar= takes "same-as-last-picture" as <reply_cast> offers it, at every ceiling', () => {
        for (const ceiling of [1, 3]) {
            const text = imageTemplate.castRules(ceiling, { userOutfits: ['school-uniform', 'town-casual'] });
            expect(text).toContain('"same-as-last-picture" when <reply_cast> offers it for {{user}}');
            expect(text).not.toMatch(/town-casual\)[^\n]*town-casual/);
        }
    });

    // The image model draws a whole body for every body part it is shown, and dresses one whose look is not attached
    // from the looks it was given: a chest she leaned on came out with her figure and her clothes.
    it('MUTATION TARGET — a body part in the frame brings its owner, and the rule says why', () => {
        const text = imageTemplate.castRules(3);
        expect(text).toContain('- A BODY PART BRINGS ITS OWNER: the image model draws a whole body for every body part it is shown, and a body whose look is not attached takes the look of whoever IS described.');
        expect(text).toContain("So anyone with any part in the frame — the chest she leans on, the hand on her shoulder — takes their slot (an outfit in mainchar= for {{user}}) and their count tag — all but {{user}}'s own hands in a pov shot (POV HANDS).");
        expect(text).not.toMatch(/NOT another person|keep the count|frame edge/);
    });

    it('MUTATION TARGET — with one person per image, each shot holds one person\'s body', () => {
        const text = imageTemplate.castRules(1);
        expect(text).toContain('- A BODY PART BRINGS ITS OWNER: the image model draws a whole body for every body part it is shown');
        expect(text).toContain("So frame each shot with ONE person's body in it: when two people touch, show one of them alone — or, when one of them is {{user}}, shoot it pov ({{user}}'s eyes), with {{user}}'s part in it as pov hands.");
        expect(text).not.toMatch(/NOT another person|keep the count|frame edge/);
    });

    // A pov shot keeps {{user}} out, yet {{user}}'s hands are in it: without this exception the body-part rule and the
    // mainchar= rule contradict each other, and a narrator settles it by leaving {{user}}'s action out of the picture
    // (staging msg 184: the act was dropped and only the heroine was drawn).
    it('MUTATION TARGET — pov hands are the one body part that brings no owner, and what {{user}} does is still written', () => {
        for (const ceiling of [1, 3]) {
            const text = imageTemplate.castRules(ceiling);
            expect(text).toContain('- POV HANDS: in a pov shot the camera is {{user}}\'s eyes, and {{user}}\'s own hands and arms reaching into the frame are written "pov hands" with what they do ("pov hands holding her shoulders", "pov hand offering a cup"). The image model draws pov hands coming from the camera with no body behind them, so they are the one body part that brings no owner: mainchar="not-in-picture", no count tag. What {{user}} does still goes in the composition, as what the pov hands do.');
            expect(text.indexOf('- POV HANDS:')).toBeGreaterThan(text.indexOf('- A BODY PART BRINGS ITS OWNER:'));
        }
    });

    // A template reset to the default reads the same rule in its count and its checklist, never the old exception.
    it('MUTATION TARGET — the default contract counts {{user}} whenever any part is in frame, and checks it', () => {
        const contract = imageTemplate.DEFAULT_PROMPT;
        expect(contract).toContain('{{user}} included whenever any part of {{user}} is in frame, pov aside (pov hands count as nobody)');
        expect(contract).toContain('mainchar= on every tag, last: an outfit exactly when any part of {{user}} is in frame, pov aside, else "not-in-picture"');
        expect(contract).toContain('a body part in frame brings its owner: their slot and their count tag, pov hands aside');
        expect(contract).toContain('{{user}}\'s action too if in frame — in a pov shot, as what the pov hands do.');
        expect(imageTemplate.CAMERA_RULES_PROMPT).toContain('pov is {{user}}\'s eyes, so a pov picture never has {{user}} in it — only pov hands.');
        expect(contract).not.toMatch(/included when visible|edge body parts|when \{\{user\}\} is visible/);
    });

    // In a first-person story a narrator illustrating "she pushes me against the wall" put the camera in {{user}}'s eyes
    // every time, so {{user}} was never drawn. The extension cannot know a card's point of view, so the line names first
    // and third person both and never claims one. <camera> ships from code, so a saved contract copy still printing
    // its own camera list gets it too.
    it('MUTATION TARGET — every <pic> must name camera=, one of the choices, each named by what it does; pov is one of them', () => {
        const camera = imageTemplate.CAMERA_RULES_PROMPT;
        expect(camera).toMatch(/^<camera>\n[\s\S]*\n<\/camera>$/);
        expect(camera).toContain('EVERY <pic> carries camera= — where the camera stands for that shot, one of these words, written exactly: ');
        expect(imageTemplate.CAMERA_CHOICES.map((c) => c.value)).toEqual(['eye-level', 'from-below', 'from-above', 'dutch-angle', 'close-up', 'wide-shot', 'pov']);
        for (const choice of ['eye-level (neutral)', 'from-below (low angle: the subject looks powerful)', 'from-above (high angle: the subject looks vulnerable)', 'dutch-angle (tilted horizon: tension)', 'close-up (a face, a touch)', 'wide-shot (the place, the distance between people)', 'pov ({{user}}\'s eyes']) {
            expect(camera).toContain(choice);
        }
        expect(camera).not.toContain('prompt="CompositionText">');
        expect(camera).toContain('The picture does not take the story\'s point of view, first person or third: pov is one choice among these, and "viewer" belongs in a composition only when camera="pov".');
        expect(camera).not.toMatch(/story is written in (first|third) person/);
        // It replaces an older copy's camera list, named by its opening words, so the current [COMPOSITION]'s framing
        // words are never read as what it replaces.
        expect(camera).toContain('A [COMPOSITION] line that opens "Camera, from:" is an older camera list, and this block replaces it.');
        expect(camera).not.toContain('replaces any camera list');
        expect(camera).toContain('pov ({{user}}\'s eyes)');
        expect(imageTemplate.DEFAULT_PROMPT).toContain('5. Camera: camera= on the tag (<camera>)');
        expect(imageTemplate.DEFAULT_PROMPT).toContain('· camera= on every tag ·');
        expect(imageTemplate.DEFAULT_PROMPT).not.toMatch(/5\. Camera, from:/);
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).toContain('(overrides <camera>)');
    });

    // Three narrator models planned mainchar= for a shot they counted as "1girl, 1boy", then wrote the tag without it,
    // while writing camera= on the same tags: an attribute written only when a condition holds is one they drop. So every
    // tag carries mainchar=, after prompt=, where the count tag that decides it is already written.
    it('MUTATION TARGET — <camera>: never {{user}} in pov; every <pic> carries mainchar=, an outfit or "not-in-picture", after prompt=', () => {
        const camera = imageTemplate.CAMERA_RULES_PROMPT;
        expect(camera).toContain('THE CAMERA DECIDES WHERE {{user}} CAN BE.');
        expect(camera).toContain('Every other camera stands apart from {{user}}, and whether {{user}} is in the picture is your choice, which the tag\'s mainchar= states ([CAST]).');
        expect(imageTemplate.MAINCHAR_NOT_IN_PICTURE).toBe('not-in-picture');
        for (const ceiling of [1, 3]) {
            const cast = imageTemplate.castRules(ceiling);
            expect(cast).toContain('- mainchar= : on EVERY tag, written last, after prompt=, so the count tag you just wrote decides it.');
            expect(cast).toContain('No part of {{user}} in the frame, or a pov shot (the camera is {{user}}\'s eyes; POV HANDS below) ⇒ mainchar="not-in-picture".');
        }
    });

    // A narrator wrote "leaning against user": a word no look in the prompt carries. The assembler tags his look
    // "[main character]", so the composition names him with those same words.
    it('MUTATION TARGET — <camera>: in prompt= {{user}} is "the main character", the name his look is tagged with', () => {
        expect(imageTemplate.MAINCHAR_PROMPT_NAME).toBe('main character');
        expect(imageTemplate.CAMERA_RULES_PROMPT).toContain('In prompt= {{user}} is always "the main character", the name the extension gives {{user}}\'s look — never {{user}}\'s own name, never "user": "CharName leaning against the main character".');
    });

    it('MUTATION TARGET — <camera> is sent with the fixed rules, right after <outfit_rules>', () => {
        const rules = imageTemplate.narratorPictureRules({ maxImages: 1, maxCharactersPerImage: 1 });
        expect(rules).toContain(`${imageTemplate.OUTFIT_RULES_PROMPT}\n${imageTemplate.CAMERA_RULES_PROMPT}`);
        const src = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8');
        // The picked camera reaches the image model, and a picture from another angle is another job.
        expect(src).toContain('const scene = withCamera(composition, camera.words);');
        expect(src).toContain('const assembled = await assemblePrompt(rawTag, scene, replyCastRecordsOf(mesId), worn, shownFor);');
        expect(src).toContain('::camera[${cameraOf(rawTag).value}]::');
        // The picture log line (gen and regen) lists every attribute of the picture; a camera missing from it reads as "no camera".
        expect(src).toContain('camera: { ...camera, wasAdded: scene !== withCamera(composition, \'\') }');
        expect(src).toMatch(/\$\{kind\} \[\$\{type\} \$\{width\}x\$\{height\}\] drawn=\$\{drawnLabel\} mainchar=\$\{maincharLabel\} camera=\$\{cameraLabel\}/);
        expect(src).toContain("'already in the composition'");
        // A tag with no mainchar= is warned, and the gen log tells "none written" from "not-in-picture".
        expect(src).toContain("if (mainchar.problem === 'missing') {");
        expect(src).toContain('the <pic> names no mainchar= — the main character is not drawn');
        expect(src).toMatch(/const maincharLabel = mainchar\.problem === 'missing' \? 'none written'\s*: !mainchar\.drawn \? MAINCHAR_NOT_IN_PICTURE/);
    });

    it('unnamed people are scenery and never a slot', () => {
        expect(imageTemplate.castRules(3)).toMatch(/Unnamed people \(a crowd, "people in background"\) are scenery words in the composition, never a slot/);
    });

    // "Count everyone in frame" with a crowd in the frame, beside "a crowd is never a slot" and "everyone you count is in
    // the tag", left a local narrator unable to tell whether a packed classroom needs a count tag (dev, ArtificKoi msg 14).
    it('MUTATION TARGET — the count step itself says a crowd is never counted', () => {
        expect(imageTemplate.DEFAULT_PROMPT).toContain('pov aside (pov hands count as nobody), a crowd never (scenery) — each one you count is in the tag');
    });

    // Every earlier <pic> is stripped from the prompt (a card's PromptDeTagPic), so the narrator never sees its last
    // camera: a rule about the previous camera can only be searched for and never obeyed.
    it('MUTATION TARGET — no rule asks for a camera other than the last one', () => {
        for (const text of [imageTemplate.DEFAULT_PROMPT, imageTemplate.CAMERA_RULES_PROMPT]) {
            expect(text).not.toMatch(/same camera|twice in a row|camera rotated/);
        }
    });

    // <scene_roster> calls the game state's spelling a REGISTRY KEY and says it is never what char= copies. A name
    // rule that also says "key" ("registry key if they have one", "char= IS A KEY") reads as the opposite instruction.
    it('MUTATION TARGET — the name rules and the shapes say "name", never "key"', () => {
        expect(imageTemplate.DEFAULT_PROMPT).toContain('- char= = who is drawn: the name the story gives them, written as Names in <reply_cast> says.');
        const texts = [
            imageTemplate.DEFAULT_PROMPT, imageTemplate.CAMERA_RULES_PROMPT, imageTemplate.EXPLICIT_RULES_PROMPT,
            imageTemplate.REGISTRATION_NAME_RULES, imageTemplate.castRules(1), imageTemplate.castRules(3),
            imageTemplate.pictureCountRules(1), imageTemplate.pictureCountRules(2), NAME_RULES,
        ];
        for (const text of texts) expect(text).not.toMatch(/key/i);
        expect(imageTemplate.SCENE_ROSTER_PROMPT).toContain('Each line is a REGISTRY KEY');
    });

    it('a broken ceiling reads as one', () => {
        expect(imageTemplate.castRules('x')).toMatch(/^\[CAST\] ONE person/);
    });
});

// ── <picture_count> is built from the card's "Max images per reply" ──────────
// An instruction, never a judgment: asked whether a beat "earns" a picture, every narrator answers one tag.
describe('pictureCountRules — every scene change gets another <pic>, up to the card\'s number', () => {
    it('MUTATION TARGET — a scene change is followed by another <pic>, up to the card\'s own number', () => {
        for (const n of [2, 3, 5]) {
            const text = imageTemplate.pictureCountRules(n);
            expect(text).toMatch(/^<picture_count>\n/);
            expect(text).toContain(`SCENE CHANGE ⇒ ANOTHER <pic>. Up to ${n} <pic> tags this reply — an instruction, not a choice.`);
            expect(text).toContain(`- The first scene gets its <pic>. EVERY scene change gets ANOTHER <pic>, under the new scene's first sentences — until ${n} tags are written.`);
        }
    });

    it('MUTATION TARGET — what changes the scene is something the story did', () => {
        expect(imageTemplate.pictureCountRules(2)).toContain('- The SCENE CHANGES when the story moves to another place · time jumps (later, that night, the next morning, falling asleep, a dream) · someone new arrives.');
    });

    it('MUTATION TARGET — more scenes than tags: the last scene always gets one', () => {
        expect(imageTemplate.pictureCountRules(2)).toContain('- The LAST scene ALWAYS gets one: with more scenes than 2, skip a middle scene, never the last.');
    });

    it('MUTATION TARGET — no scene change, no extra tag', () => {
        expect(imageTemplate.pictureCountRules(2)).toContain('- No scene change ⇒ no extra tag: a new pose or more talk in the same scene adds nothing.');
    });

    // The chat's own earlier replies carry one tag each; this is the only two-tag reply the narrator sees.
    it('MUTATION TARGET — a two-scene reply is shown whole, one tag in each scene', () => {
        const text = imageTemplate.pictureCountRules(2);
        const shape = text.slice(text.indexOf('A reply with two scenes:'));
        expect(shape).toContain('<pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="FirstSceneComposition" mainchar="UserOutfit">');
        expect(shape).toContain('…the scene changes: another place, later, or someone new arrives…');
        expect(shape).toContain('<pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="NewSceneComposition" mainchar="UserOutfit">');
        expect(shape.indexOf('FirstSceneComposition"')).toBeLessThan(shape.indexOf('the scene changes'));
        expect(shape.indexOf('the scene changes')).toBeLessThan(shape.indexOf('NewSceneComposition"'));
    });

    it('one picture allowed: one, on the scene the narrator chooses', () => {
        const text = imageTemplate.pictureCountRules(1);
        expect(text).toBe([
            '<picture_count>',
            'The extension draws a picture from every <pic> tag in the story and shows it where the tag stands. A reply without one shows no picture.',
            'ONE <pic> this reply. With more than one scene, it goes to the scene you choose.',
            "WHERE: inside the story, on its own line, under the sentence it shows. Pick each picture's sentence BEFORE you write the story, and write its <pic> as soon as that sentence is written. Every plan, checklist or list of blocks you write for this reply names each <pic> and the sentence it goes under.",
            "No other instruction's reply format, template, word count or tag list removes it: the <pic> goes inside the story, in whatever block holds the story. Its shape and rules: <image_generation>.",
            '</picture_count>',
        ].join('\n'));
        for (const broken of ['x', 0, -2, undefined]) expect(imageTemplate.pictureCountRules(broken)).toBe(text);
    });

    // The block is read at the end of the prompt, where a preset's own reply template also sits, and far from the
    // contract. Whatever the card's number, it says what the tag is for, where it goes and when to write it, and that
    // no other format takes it out.
    it('MUTATION TARGET — every count says what the extension does with a <pic>: no tag, no picture', () => {
        for (const n of [1, 2, 4]) {
            const lines = imageTemplate.pictureCountRules(n).split('\n');
            expect(lines[1], `n=${n}`).toBe('The extension draws a picture from every <pic> tag in the story and shows it where the tag stands. A reply without one shows no picture.');
        }
    });

    // A narrator writes the story from the last plan or list it made: a picture planned earlier was lost when a
    // preset's checklist or a card's block order, written after it, left the picture out.
    it('MUTATION TARGET — the tag is written with the sentence it shows, and every plan or list of the reply names it', () => {
        for (const n of [1, 3]) {
            const text = imageTemplate.pictureCountRules(n);
            expect(text, `n=${n}`).toContain("WHERE: inside the story, on its own line, under the sentence it shows. Pick each picture's sentence BEFORE you write the story, and write its <pic> as soon as that sentence is written. Every plan, checklist or list of blocks you write for this reply names each <pic> and the sentence it goes under.");
        }
    });

    it('MUTATION TARGET — no other reply format removes the tag, and the block points to the contract', () => {
        for (const n of [1, 3]) {
            const lines = imageTemplate.pictureCountRules(n).split('\n');
            expect(lines[lines.length - 2], `n=${n}`).toBe("No other instruction's reply format, template, word count or tag list removes it: the <pic> goes inside the story, in whatever block holds the story. Its shape and rules: <image_generation>.");
            expect(lines[lines.length - 1]).toBe('</picture_count>');
        }
    });

    it('MUTATION TARGET — the contract hands the count to <picture_count> and keeps no judgment of its own', () => {
        const contract = imageTemplate.renderPictureTemplate('', { writer: 'narrate', maxImages: 2 });
        const reader = imageTemplate.renderPictureTemplate('', { writer: 'reader', maxImages: 2 });
        expect(contract).toContain('MANDATORY, EVERY SINGLE REPLY: a <pic> for EVERY SCENE of the reply, up to 2 — see <picture_count>. NEVER zero.');
        expect(reader).toContain('MANDATORY: a <pic> for EVERY SCENE of the reply you read, up to 2 — see <picture_count>. NEVER zero');
        expect(contract).toContain('[CHECK] EVERY SCENE <picture_count> GIVES A TAG HAS ITS <pic> (≤2)');
        for (const text of [contract, reader, imageTemplate.pictureCountRules(2), imageTemplate.pictureCountRules(2, { writer: 'reader' })]) {
            expect(text).not.toMatch(/CEILING, not a quota|complete reply|EARN IT|genuine|none invented to fill|\bmoment/i);
        }
    });

    // A floor worded "at least ONE <pic> tag" is met by one tag, whatever <picture_count> says.
    it('MUTATION TARGET — no line of the contract asks for one tag on its own', () => {
        expect(imageTemplate.DEFAULT_PROMPT).not.toMatch(/at least ONE|AT LEAST ONE/i);
    });
});

// The narrator's picture rules open its prompt as one message, where a provider's prompt cache reuses them: the
// contract, <outfit_rules>, <camera>, then <explicit_rules>, which comes and goes with an explicit scene. <scene_roster>
// and <picture_count> are never part of them (prompt-assembly-core placeNarratorPictureParts places those).
describe('narratorPictureRules — the fixed image rules, in their order', () => {
    const rules = (options) => imageTemplate.narratorPictureRules({ maxImages: 3, maxCharactersPerImage: 2, ...options });

    it('MUTATION TARGET — contract, outfit rules, camera, then explicit rules, as one text', () => {
        const text = rules({ isExplicit: true });
        const at = ['<image_generation>', '<outfit_rules>', '<camera>', '<explicit_rules>'].map((open) => text.indexOf(open));
        expect(at[0]).toBe(0);
        expect(at[1]).toBeGreaterThan(at[0]);
        expect(at[2]).toBeGreaterThan(at[1]);
        expect(at[3]).toBeGreaterThan(at[2]);
    });

    it('MUTATION TARGET — <explicit_rules> only while the latch allows it', () => {
        expect(rules({ isExplicit: false })).not.toContain('<explicit_rules>');
        expect(rules({ isExplicit: true })).toContain(imageTemplate.EXPLICIT_RULES_PROMPT);
    });

    it("MUTATION TARGET — {{maxImages}} and {{castRules}} are filled from the card's numbers", () => {
        const text = rules({});
        expect(text).not.toMatch(/\{\{maxImages\}\}|\{\{castRules\}\}/);
        expect(text).toContain('up to 3 — see <picture_count>');
        expect(text).toContain(imageTemplate.castRules(2));
    });

    it("a card's own contract replaces the built-in one; the shipped blocks still follow it", () => {
        const text = rules({ template: 'CARD CONTRACT {{maxImages}}' });
        expect(text.startsWith('CARD CONTRACT 3\n<outfit_rules>')).toBe(true);
        expect(text).toContain(imageTemplate.CAMERA_RULES_PROMPT);
    });

    // The contract names both blocks in its text; neither block itself is in the rules.
    it('MUTATION TARGET — <scene_roster> and <picture_count> are never part of the fixed rules', () => {
        const text = rules({ isExplicit: true });
        expect(text).not.toMatch(/^<scene_roster>$/m);
        expect(text).not.toMatch(/^<picture_count>$/m);
        expect(text).not.toContain(imageTemplate.pictureCountRules(3));
    });
});

// The handler in the host-coupled image-gen.js only gathers the parts; what it hands over is gated as SOURCE.
describe("SOURCE GATE — the narrator's picture prompt is assembled by the pure functions", () => {
    const src = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

    // A card reads <picture_count>'s presence as "image generation is on", so it comes with the rules and never alone.
    it('MUTATION TARGET — the rules and <picture_count> come together, and only while the narrator writes the pictures', () => {
        expect(src).toContain('const parts = duties.sendsNarratorContract ? await narratorPictureParts(eventData) : {};');
        const partsFn = src.slice(src.indexOf('async function narratorPictureParts('), src.indexOf('// Pictures read each person'));
        expect(partsFn).toContain('rules: expandPromptMacros(narratorPictureRules({ template: prof.promptTemplate, maxImages: imageCap(),');
        expect(partsFn).toContain("count: expandPromptMacros(pictureCountRules(imageCap()), 'imagegen'),");
        expect(src.split('pictureCountRules(imageCap())').length - 1).toBe(1);
    });

    // The reader contract is built when the picture call runs, so the latch, <scene_roster> and the ON FILE list read
    // the state after the reply (plans/executed/picture-writer-route.md D5).
    it('MUTATION TARGET — the picture call is asked the reader contract, built from the state after the reply', () => {
        expect(src).toContain('    instruction: ({ messageId }) => readerPictureContractFor(messageId),');
        const fn = src.slice(src.indexOf('async function readerPictureContractFor('), src.indexOf('// Pictures read each person'));
        expect(fn).toContain('try { onFile = await onFileListForPictureCall(); }');
        expect(fn).toContain('return readerPictureContract({');
        expect(fn).toContain('isExplicit: gate.inject, scene: sceneRosterText(readSceneRoster().present), onFile,');
        expect(fn).toContain('const gate = readExplicitGate(prof);');
    });

    it('MUTATION TARGET — every part, and the history, go through placeNarratorPictureParts', () => {
        expect(src).toContain('placeNarratorPictureParts(eventData.chat, { historyPictures: duties.historyPictures, unescapeAttr: unescapeHtmlAttribute, ...parts });');
        expect(src).not.toMatch(/eventData\.chat\.(unshift|splice)\(/);
    });
});

// ── who writes the pictures (plans/executed/picture-writer-route.md R2, D5) ───────────
describe('the contract\'s writer placeholders — one text for the narrator and the reader', () => {
    const narrate = imageTemplate.renderPictureTemplate('', { writer: 'narrate', maxImages: 2, castRulesText: 'CAST' });
    const reader = imageTemplate.renderPictureTemplate('', { writer: 'reader', maxImages: 2, castRulesText: 'CAST' });

    it('MUTATION TARGET — the built-in contract holds every writer placeholder once, and both writers fill them all', () => {
        const names = Object.keys(imageTemplate.PICTURE_WRITER_WORDS.narrate);
        expect(Object.keys(imageTemplate.PICTURE_WRITER_WORDS.reader)).toEqual(names);
        for (const name of names) expect(imageTemplate.DEFAULT_PROMPT.split(`{{${name}}}`).length - 1, name).toBe(1);
        for (const name of [...names, 'maxImages', 'castRules']) {
            expect(narrate, name).not.toContain(`{{${name}}}`);
            expect(reader, name).not.toContain(`{{${name}}}`);
        }
    });

    // The narrator's words are the contract's own, word for word (the line each placeholder replaced).
    it('MUTATION TARGET — the narrator reads the contract as it always read', () => {
        expect(narrate).toContain('MANDATORY, EVERY SINGLE REPLY: a <pic> for EVERY SCENE of the reply, up to 2 — see <picture_count>. NEVER zero.');
        expect(narrate).toContain('THE TAG COSTS NO WORDS. It is machine-consumed markup, never prose');
        expect(narrate).toContain('\n<pic char="CharName" outfit="CharOutfit" camera="Camera" prompt="CompositionText" mainchar="UserOutfit">\n- PLACEMENT: inside the prose, own line, directly under the ONE sentence it illustrates.');
        expect(narrate).toContain("- BEAT ATTRIBUTION: char= = whoever acts/speaks in the sentence directly above the tag — never an earlier speaker, never the previous image's subject.");
        expect(narrate).toContain('until the scene clears it · the tag is machine-read — never mention it in prose.');
        expect(narrate).toContain("go back and add them ·each tag under its own sentence, none bunched/trailing · char= = that sentence's actor · every NAMED person");
        expect(narrate).not.toContain('at=');
    });

    it('MUTATION TARGET — the reader puts each picture by line number, and is never told to write prose', () => {
        expect(reader).toContain('<pic at="LineNumber" char="CharName"');
        expect(reader).toContain('- at= : the NUMBER of the line the picture shows');
        expect(reader).toContain('- BEAT ATTRIBUTION: char= = whoever acts/speaks in the line at= names');
        expect(reader).toContain("at= on every tag: the number of the line it shows · char= = that line's actor");
        expect(reader).toContain('up to 2 — see <picture_count>');
        for (const narratorOnly of ['MANDATORY, EVERY SINGLE REPLY', 'THE TAG COSTS NO WORDS', 'PLACEMENT: inside the prose', 'never mention it in prose', 'each tag under its own sentence']) {
            expect(reader, narratorOnly).not.toContain(narratorOnly);
        }
    });

    it('a card\'s edits to the shared rules reach both writers', () => {
        const card = 'CARD STYLE {{maxImages}}\n{{placement}}';
        expect(imageTemplate.renderPictureTemplate(card, { writer: 'narrate', maxImages: 1 })).toContain('CARD STYLE 1\n- PLACEMENT: inside the prose');
        expect(imageTemplate.renderPictureTemplate(card, { writer: 'reader', maxImages: 1 })).toContain('CARD STYLE 1\n- at= : the NUMBER');
    });
});

describe('pictureCountRules — the narrator\'s and the reader\'s <picture_count>', () => {
    it('MUTATION TARGET — the reader puts each picture by line number, and writes its tags beside whatever else the call is asked for', () => {
        const text = imageTemplate.pictureCountRules(3, { writer: 'reader' });
        expect(text.startsWith('<picture_count>\nThe extension draws a picture from every <pic> tag you write and shows it on its own line under the line its at= names.')).toBe(true);
        expect(text).not.toContain('shows it where the tag stands');
        expect(text.endsWith('\n</picture_count>')).toBe(true);
        expect(text).toContain("at= one of the new scene's first lines — until 3 tags are written");
        expect(text).toContain('<pic at="1" char="CharName"');
        expect(text).toContain('<pic at="5" char="CharName"');
        expect(text).toContain("WHERE: at= is the number of the line the picture shows — the [n] at that line's start.");
        expect(text).toContain('OUTPUT: each <pic> tag, and each record <reply_cast> asks for, on a line of its own, outside any other block, with no story or notes of yours around them.');
        expect(text).toContain('they sit beside anything else this prompt asks you to write: neither replaces the other.');
        expect(text).not.toContain('nothing else');
        expect(text).not.toContain('BEFORE you write the story');
        expect(text).toContain('The LAST scene ALWAYS gets one');
    });

    it('MUTATION TARGET — the narrator\'s keeps its own words', () => {
        const text = imageTemplate.pictureCountRules(3);
        expect(text).toContain("under the new scene's first sentences — until 3 tags are written");
        expect(text).toContain('Pick each picture\'s sentence BEFORE you write the story');
        expect(text).not.toContain('at=');
        expect(imageTemplate.pictureCountRules(3, { writer: 'narrate' })).toBe(text);
    });
});

describe('readerPictureContract — what a POST call that writes the pictures is asked (D5)', () => {
    const contract = (options) => imageTemplate.readerPictureContract({
        maxImages: 2, maxCharactersPerImage: 2, scene: '<scene_roster>\nSCENE\n</scene_roster>', onFile: 'ON FILE — LIST', ...options,
    });

    it('MUTATION TARGET — every block, in order: contract, outfit rules, camera, scene, then <reply_cast>', () => {
        const text = contract({});
        const at = ['<image_generation>', '<outfit_rules>', '<camera>', '<scene_roster>', '<reply_cast>'].map((open) => text.indexOf(`${open}\n`));
        expect(at[0]).toBe(0);
        for (let i = 1; i < at.length; i++) expect(at[i], `block ${i}`).toBeGreaterThan(at[i - 1]);
        expect(text.endsWith('</reply_cast>')).toBe(true);
    });

    // The card's POST entries follow the routed contract in the call's system block, so the count closes the reply the
    // call reads instead (readerPictureInput).
    it('MUTATION TARGET — <picture_count> is not part of it', () => {
        expect(contract({ isExplicit: true })).not.toMatch(/^<picture_count>$/m);
    });

    it('MUTATION TARGET — <explicit_rules> only while the latch reads on', () => {
        expect(contract({ isExplicit: false })).not.toContain('<explicit_rules>');
        expect(contract({ isExplicit: true })).toContain(imageTemplate.EXPLICIT_RULES_PROMPT);
    });

    it('MUTATION TARGET — its <reply_cast> holds the ON FILE list and the one record it writes, and the record format', () => {
        const text = contract({});
        const replyCast = text.slice(text.indexOf('<reply_cast>\n'), text.indexOf('</reply_cast>'));
        expect(replyCast).toContain('ON FILE — LIST');
        expect(replyCast).toContain('RECORDS for your pictures — one kind: a character your <pic> draws with outfit="newclothes"');
        expect(replyCast).toContain('outfit="newclothes" clothes="every garment they wear, each with its colour"');
        expect(replyCast).toContain('NEVER write a closing tag');
    });

    // The reader's contract points char= at Names in <reply_cast>, so its <reply_cast> must carry them. MUTATION
    // TARGET: drop NAME_RULES from the reader's <reply_cast> and a POST call that writes the pictures is told how to
    // spell char= nowhere.
    it('MUTATION TARGET — its <reply_cast> carries Names, which the contract\'s char= rule points to', () => {
        const text = contract({});
        const replyCast = text.slice(text.indexOf('<reply_cast>\n'), text.indexOf('</reply_cast>'));
        expect(replyCast).toContain(NAME_RULES);
        expect(text.slice(0, text.indexOf('</image_generation>'))).toContain('written as Names in <reply_cast> says');
    });

    it('MUTATION TARGET — it reads the reader\'s words, never the narrator\'s', () => {
        const text = contract({});
        expect(text).toContain('<pic at="LineNumber"');
        expect(text).toContain('- at= : the NUMBER of the line the picture shows');
        expect(text).not.toContain('MANDATORY, EVERY SINGLE REPLY');
        expect(text).not.toContain('Pick each picture\'s sentence BEFORE you write the story');
    });

    // A POST call may carry other duties (a card's own records, the look task), so no line of the contract claims the
    // call's whole answer or a slot in it.
    it('MUTATION TARGET — no line claims the call\'s whole answer: the tags sit beside its other duties', () => {
        const text = contract({ isExplicit: true });
        for (const claim of ['nothing else', 'one kind only', 'Your answer is', 'at the END']) expect(text, claim).not.toContain(claim);
        expect(text).toContain('The reply is finished: you read it to picture it, never to continue it.\n<pic at="LineNumber"');
    });

    it('no scene and no ON FILE list: neither is sent, and the rest stands', () => {
        const text = contract({ scene: '', onFile: '' });
        expect(text).not.toContain('<scene_roster>');
        expect(text).toContain('<reply_cast>\nRECORDS for your pictures — one kind');
    });
});

describe('readerPictureInput — what the picture call reads', () => {
    it('MUTATION TARGET — the numbered reply, then the reader <picture_count>, the last thing the call reads', () => {
        const reply = '[1] <p>She opens the door.</p>\n\n[2] <p>"Tea?"</p>';
        const text = imageTemplate.readerPictureInput(reply, 2);
        expect(text).toBe(`${reply}\n\n${imageTemplate.pictureCountRules(2, { writer: 'reader' })}`);
        expect(text.endsWith('\n</picture_count>')).toBe(true);
        expect(text).toContain('Up to 2 <pic> tags this reply');
    });

    it('MUTATION TARGET — the host\'s macro expansion runs on the count, never on the reply', () => {
        const reply = '[1] <p>{{user}} waves.</p>';
        const seen = [];
        const text = imageTemplate.readerPictureInput(reply, 1, (block) => { seen.push(block); return `EXPANDED ${block}`; });
        expect(seen).toEqual([imageTemplate.pictureCountRules(1, { writer: 'reader' })]);
        expect(text).toBe(`${reply}\n\nEXPANDED ${imageTemplate.pictureCountRules(1, { writer: 'reader' })}`);
    });
});

// ── the explicit block ───────────────────────────────────────────────────────
describe('<explicit_rules> — the explicit floor names no card and no pairing', () => {
    it('is one tagged block, like every other image block', () => {
        expect(imageTemplate.EXPLICIT_RULES_PROMPT.startsWith('<explicit_rules>\n')).toBe(true);
        expect(imageTemplate.EXPLICIT_RULES_PROMPT.endsWith('\n</explicit_rules>')).toBe(true);
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).not.toMatch(/\[EXPLICIT/);
    });

    it('defers to a card camera recipe without naming any card\'s block', () => {
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).toContain('POSITION CAMERA: if the card supplies a camera recipe for the established position, use its camera');
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).toContain('(the position lock)');
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).not.toMatch(/H_Camera|体位/);
    });

    it('carries nine position examples, two of them beyond one man and one woman', () => {
        const examples = imageTemplate.EXPLICIT_RULES_PROMPT.split('\n').filter((l) => l.trim().startsWith('·'));
        expect(examples).toHaveLength(9);
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).toContain('· two women ⇒ "CharName lying on her back');
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).toContain('· one man, two women ⇒ "CharName on hands and knees');
        expect(imageTemplate.EXPLICIT_RULES_PROMPT).not.toMatch(/vaginal ⇒|balls-deep ⇒/);
    });
});

// ── the look contract (narrate route) ────────────────────────────────────────
describe('narrateRegistrationContract — describe once, by the ON FILE list', () => {
    it('storing: every named character not ON FILE; drawing only: every DRAWN character not ON FILE', () => {
        expect(imageTemplate.narrateRegistrationContract({ isStoring: true })).toMatch(/every named character in this reply who is NOT ON FILE/);
        const drawingOnly = imageTemplate.narrateRegistrationContract({ isStoring: false });
        expect(drawingOnly).toMatch(/every character a <pic> in this reply draws \(any char= slot\) who is NOT ON FILE/);
        expect(drawingOnly).toMatch(/Nothing is stored/);
        // nothing stored ⇒ no saving rules to teach, and no outfit= on the record
        expect(drawingOnly).not.toContain(imageTemplate.REGISTRATION_OUTFIT_RULES);
        expect(drawingOnly).toMatch(/also write body= and clothes=\./);
    });

    it(`storing: a newcomer's record says where her clothes go, and the picture still says "newclothes"`, () => {
        const storing = imageTemplate.narrateRegistrationContract({ isStoring: true });
        expect(storing).toMatch(/also write body=, clothes= and outfit= \(Outfit, below\)/);
        expect(storing).toMatch(/The picture in the reply that describes them says outfit="newclothes", whatever their record's outfit= says: their clothes are ON FILE from the next reply\./);
        expect(storing).toContain(imageTemplate.REGISTRATION_OUTFIT_RULES);
    });
});

// A character's FIRST clothes are always saved; after that only STATIC clothes are, under a name that says which
// clothes they are — the name is all the narrator ever sees of an outfit (plans/reply-cast.md §1.4, D29).
describe('REGISTRATION_OUTFIT_RULES — which clothes a model saves', () => {
    const rules = imageTemplate.REGISTRATION_OUTFIT_RULES;

    // MUTATION TARGET: tell it "newclothes" keeps only the body and the narrator is taught a rule the registry no
    // longer follows. No judgement of whether a character comes from an existing work is asked for any more.
    it('MUTATION TARGET — a new character\'s clothes are always kept, "newclothes" as her "default"', () => {
        expect(rules).toMatch(/A NEW character's record always carries outfit= beside body= and clothes=, and her clothes are always kept: under that outfit name, or, with "newclothes", as her "default" outfit, which later pictures can name\./);
        expect(rules).not.toMatch(/known character|existing work|only the body is kept/);
    });

    it('MUTATION TARGET — static clothes take a <place or role>-<outfit> name, never a bare garment', () => {
        expect(rules).toMatch(/A place or role fixes it, the same for everyone there \(a café's waitress uniform, a police uniform\), or the story presents it as what this character always wears/);
        expect(rules).toMatch(/saved under a <place or role>-<outfit> name — "cafe-waitress", "police-uniform", "detective-coat" — never a bare garment \("swimsuit", "uniform", "casual"\)/);
    });

    // A one-off of a character with clothes on file is never saved — but the chat keeps it, so later pictures carry
    // it: "this reply's pictures only" would be a false promise.
    it('MUTATION TARGET — anything else is a one-off, never saved once she has clothes on file', () => {
        expect(rules).toMatch(/Anything else they wear is a one-off: outfit="newclothes"\./);
        expect(rules).toMatch(/Once a character has any clothes saved, a one-off is never saved, and she gains a saved outfit with a record like this:/);
        expect(rules).not.toMatch(/this reply's pictures only/);
    });

    it('offers no one-off as an outfit worth saving, and its example is a static name', () => {
        expect(rules).not.toMatch(/sleepwear|date dress|RECURRING|"sunday"|"pajama"/);
        expect(rules).toContain('<cast name="their name" outfit="cafe-waitress" clothes="');
    });

    it('the body form opens with what the character is', () => {
        const text = imageTemplate.narrateRegistrationContract();
        expect(text).toMatch(/WHAT THEY ARE — the FIRST tag of body=, never omitted/);
        expect(text).toMatch(/first tag: does body= open with what the character is/);
    });
});
