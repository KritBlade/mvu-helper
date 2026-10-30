import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    composeImagePrompt, sanitizeComposition, validateCharSlots, decideExplicitBlock, classifyDeclaredPathRead, declaredPathWarning,
    imageDuties, placeNarratorPictureParts, isPictureWriterOffered, isHarvestTargetOffered, writerPairRuledOut, INSERT_TYPE, NARRATOR_TAG_ACTION, HISTORY_PICTURES, picSlots, maincharOf, fitPeopleToCeiling, bustValueFor, sceneRosterText, oneOffNamesOf, drawnPeopleOf, isLastPictureOf,
    resolveStatPath, maincharNamedButNotDrawn, cameraOf, withCamera,
} from '../src/features/imagegen/prompt-assembly-core.js';
import { DEFAULT_REGEX, SCENE_ROSTER_PROMPT, OUTFIT_RULES_PROMPT, ONE_OFF_CLOTHES_ASK, EXPLICIT_RULES_PROMPT, REGISTRATION_OUTFIT_RULES, REGISTRATION_NAME_RULES, castRecordAsks, readerPictureContract, narrateRegistrationContract, readerRegistrationContract } from '../src/features/imagegen/default-template.js';
import { replyCastInstruction } from '../src/features/character-roster/reply-cast-core.js';
import { buildRenderedImageWrap } from '../src/features/imagegen/image-splice-core.js';
import { escapeHtmlAttribute, unescapeHtmlAttribute } from '../src/shared/html-escape.js';

const IORI = {
    name: 'Iori',
    body: 'woman, short messy crimson-red bob, amber-orange eyes, athletic build',
    clothes: 'brown school uniform, black athletic leggings, white sneakers',
};
const MITSUKI = {
    name: 'Mitsuki',
    body: 'woman, long straight plum-purple hair, golden amber eyes, slim hourglass figure',
    clothes: 'brown school uniform, dark knee-high socks, brown loafers',
};
const ARIA = { name: 'Aria', body: 'elf woman, silver hair, green eyes', clothes: 'plate armor, red cape' };
const BRAM = { name: 'Bram', body: 'dwarf man, braided red beard', clothes: 'leather apron' };
const MAINCHAR = { body: 'man, short dark hair, lean athletic build', clothes: 'grey hoodie, jeans' };

describe('composeImagePrompt — one person', () => {
    it('gives them a named sentence after the scene: body, then clothes', () => {
        const out = composeImagePrompt({ prefix: 'masterpiece, very aesthetic', composition: '1girl, sitting', people: [IORI] });
        expect(out).toBe(`masterpiece, very aesthetic, 1girl, sitting. The person in the frame is Iori: [Iori] ${IORI.body}, ${IORI.clothes} [/Iori]`);
    });

    // The wording names no gender: what each person is comes from the first tag of their own look.
    it('MUTATION TARGET — the subject is neutral, whoever is drawn', () => {
        for (const person of [IORI, BRAM]) {
            const out = composeImagePrompt({ prefix: '', composition: 'standing', people: [person] });
            expect(out).toContain(`The person in the frame is ${person.name}: [${person.name}] ${person.body}`);
            expect(out).not.toMatch(/\b(girl|man) (in|on) the\b/i);
        }
    });

    it('no bare [Body] / [Clothes] label reaches the encoder', () => {
        const out = composeImagePrompt({ prefix: 'p', composition: '1girl, sitting', people: [IORI] });
        expect(out).not.toContain('[Body]');
        expect(out).not.toContain('[Clothes]');
    });

    it('leaves clothes out when they wear none', () => {
        const out = composeImagePrompt({ prefix: '', composition: '1girl, lying on bed', people: [{ ...IORI, clothes: '' }] });
        expect(out).toBe(`1girl, lying on bed. The person in the frame is Iori: [Iori] ${IORI.body} [/Iori]`);
    });

    it('drops the body\'s own closing period so the join never reads ".,"', () => {
        const out = composeImagePrompt({ prefix: '', composition: '1girl', people: [{ ...IORI, body: 'jade ring on 4th finger.' }] });
        expect(out).toContain('jade ring on 4th finger, brown school uniform');
        expect(out).not.toContain('.,');
    });

    it('normalizes a trailing comma in the prefix so we never emit ",,"', () => {
        const out = composeImagePrompt({ prefix: 'score_9, ', composition: '1girl', people: [IORI] });
        expect(out.startsWith('score_9, 1girl')).toBe(true);
        expect(out).not.toContain(',,');
    });

    it('a person with clothes but no body still gets their sentence', () => {
        const out = composeImagePrompt({ prefix: '', composition: 'standing', people: [{ name: 'Ren', body: '', clothes: 'red coat' }] });
        expect(out).toBe('standing. The person in the frame is Ren: [Ren] red coat [/Ren]');
    });

    it('a person with no look at all adds nothing — they are drawn from the scene', () => {
        const out = composeImagePrompt({ prefix: 'p', composition: '1girl, waving', people: [{ name: 'Ghost', body: '', clothes: '' }] });
        expect(out).toBe('p, 1girl, waving');
    });

    it('no people at all = pure scenery, byte for byte', () => {
        expect(composeImagePrompt({ prefix: 'p', composition: 'empty classroom', people: [] })).toBe('p, empty classroom');
    });
});

describe('composeImagePrompt — several people, by name', () => {
    it('two: each in their own sentence, opened by the name, in slot order', () => {
        const out = composeImagePrompt({ prefix: 'p', composition: '2girls, in a classroom', people: [IORI, MITSUKI] });
        expect(out).toContain(`Iori is: [Iori] ${IORI.body}`);
        expect(out).toContain(`Mitsuki is: [Mitsuki] ${MITSUKI.body}`);
        expect(out.indexOf('Iori is:')).toBeLessThan(out.indexOf('Mitsuki is:'));
    });

    it('keeps each person\'s clothes inside their own sentence', () => {
        const out = composeImagePrompt({ prefix: '', composition: '2girls', people: [IORI, MITSUKI] });
        const iori = out.slice(out.indexOf('Iori is:'), out.indexOf('Mitsuki is:'));
        expect(iori).toContain('black athletic leggings');
        expect(iori).not.toContain('brown loafers');
    });

    // MUTATION TARGET: the composition alone says where anyone stands. A position here contradicts it
    // whenever the slot order differs ("Mitsuki in the middle" beside "the person on the LEFT is Mitsuki").
    it('says nowhere where anyone stands, for any number of people', () => {
        const people = [IORI, ARIA, BRAM, MITSUKI];
        for (let count = 2; count <= people.length; count++) {
            const out = composeImagePrompt({ prefix: '', composition: 'Mitsuki in the middle', people: people.slice(0, count) });
            const sentences = out.slice('Mitsuki in the middle.'.length);
            expect(sentences).not.toMatch(/\b(left|right|middle|center|centre)\b/i);
            expect(sentences).not.toMatch(/\b\d+(st|nd|rd|th)\b/i);
            for (const person of people.slice(0, count)) expect(out).toContain(`${person.name} is: [${person.name}] ${person.body}`);
        }
    });

    it('states identical clothing ONCE instead of per person', () => {
        const gymA = { ...IORI, clothes: 'gym uniform, navy shorts' };
        const gymB = { ...MITSUKI, clothes: 'gym uniform, navy shorts' };
        const two = composeImagePrompt({ prefix: '', composition: '2girls', people: [gymA, gymB] });
        expect(two).toContain('Both wear: gym uniform, navy shorts.');
        expect(two.match(/navy shorts/g)).toHaveLength(1);
        const three = composeImagePrompt({ prefix: '', composition: '3girls', people: [gymA, gymB, { ...ARIA, clothes: 'gym uniform, navy shorts' }] });
        expect(three).toContain('All 3 wear: gym uniform, navy shorts.');
        expect(three.match(/navy shorts/g)).toHaveLength(1);
    });

    it('does not share when only one of them is undressed', () => {
        const out = composeImagePrompt({ prefix: '', composition: '2girls', people: [{ ...IORI, clothes: '' }, MITSUKI] });
        expect(out).not.toContain('wear:');
        expect(out).toContain('brown loafers');
    });

    it('never leaves a doubled or dangling separator between sentences', () => {
        const out = composeImagePrompt({ prefix: 'p,', composition: '2girls, in a classroom,', people: [IORI, MITSUKI] });
        expect(out).not.toMatch(/,\s*\./);
        expect(out).not.toContain('..');
        expect(out.endsWith('[/Mitsuki]')).toBe(true);
    });
});

describe('composeImagePrompt — the main character', () => {
    const TAGS = `${MAINCHAR.body}, ${MAINCHAR.clothes}`;

    it('closes the prompt with his own sentence, after everyone else', () => {
        const out = composeImagePrompt({ prefix: '', composition: '2girls, 1boy', people: [IORI, MITSUKI], mainchar: MAINCHAR });
        expect(out.endsWith(`The main character in the frame is [main character] ${TAGS} [/main character]`)).toBe(true);
        expect(out.indexOf('Mitsuki is:')).toBeLessThan(out.indexOf('The main character'));
    });

    it('one person and him: scene, their sentence, then his', () => {
        const out = composeImagePrompt({ prefix: '', composition: '1girl, 1boy', people: [IORI], mainchar: MAINCHAR });
        expect(out).toBe(`1girl, 1boy. The person in the frame is Iori: [Iori] ${IORI.body}, ${IORI.clothes} [/Iori] The main character in the frame is [main character] ${TAGS} [/main character]`);
    });

    it('him alone', () => {
        expect(composeImagePrompt({ prefix: '', composition: '1boy, standing', people: [], mainchar: MAINCHAR }))
            .toBe(`1boy, standing. The main character in the frame is [main character] ${TAGS} [/main character]`);
    });

    it('not drawn, or no look ⇒ no sentence, and the prompt is unchanged', () => {
        const without = composeImagePrompt({ prefix: 'p', composition: '1girl', people: [IORI] });
        expect(composeImagePrompt({ prefix: 'p', composition: '1girl', people: [IORI], mainchar: null })).toBe(without);
        expect(composeImagePrompt({ prefix: 'p', composition: '1girl', people: [IORI], mainchar: { body: '', clothes: '' } })).toBe(without);
        expect(without).not.toContain('main character');
    });

    it('he is never part of the shared-clothes sentence', () => {
        const same = { body: 'man', clothes: 'gym uniform' };
        const out = composeImagePrompt({ prefix: '', composition: 'x', people: [{ ...IORI, clothes: 'gym uniform' }, { ...MITSUKI, clothes: 'gym uniform' }], mainchar: same });
        expect(out).toContain('Both wear: gym uniform.');
        expect(out).toContain('The main character in the frame is [main character] man, gym uniform [/main character]');
    });
});

// ── each look tagged with its owner ──────────────────────────────────────────────────────────
// Measured on Krea2 (2026-10-16, the staging two-girl bench scene, 12 seeds a variant): each look in a tag of its
// owner's name, with the composition calling him "the main character", drew both girls and him in 11-12 of 12,
// against 8 of 12 for the named sentences alone. The staging look texts below carried a period mid-look.
describe('composeImagePrompt — each look in its owner\'s tag', () => {
    const MANA = {
        name: 'Mana',
        body: 'woman, 8.5 to 9 heads tall, (thin thighs:1.4), subtle confident teasing smile,  (high ponytail:1.2). (dark purple hair:1.3),  long hair in the back',
        clothes: 'brown plaid pleated skirt, delicate red bracelet on one wrist. Black underclothes.',
    };

    it('MUTATION TARGET — every look sits between its owner\'s opening and closing tag, his in [main character]', () => {
        const out = composeImagePrompt({ prefix: '', composition: '2girls, 1boy, bench', people: [MANA, MITSUKI], mainchar: MAINCHAR });
        const mana = out.slice(out.indexOf('[Mana]'), out.indexOf('[/Mana]'));
        expect(mana).toContain('red bracelet');
        expect(mana).not.toContain('brown loafers');
        expect(out).toContain('Mitsuki is: [Mitsuki] ');
        expect(out.indexOf('[/Mana]')).toBeLessThan(out.indexOf('Mitsuki is:'));
        expect(out).toMatch(/The main character in the frame is \[main character\] man, .* \[\/main character\]$/);
    });

    it('MUTATION TARGET — a period inside a look never ends it: it reads as a comma', () => {
        const out = composeImagePrompt({ prefix: '', composition: '1girl', people: [MANA] });
        expect(out).toContain('(high ponytail:1.2), (dark purple hair:1.3)');
        expect(out).toContain('red bracelet on one wrist, Black underclothes [/Mana]');
        expect(out.slice(out.indexOf('[Mana]'))).not.toMatch(/\.\s/);
    });

    it('a decimal inside a look is kept', () => {
        const out = composeImagePrompt({ prefix: '', composition: '1girl', people: [MANA] });
        expect(out).toContain('8.5 to 9 heads tall');
        expect(out).toContain('(thin thighs:1.4)');
    });

    it('the shared-clothes sentence reads its text the same way', () => {
        const uniform = 'school uniform. White underclothes.';
        const out = composeImagePrompt({ prefix: '', composition: '2girls', people: [{ ...IORI, clothes: uniform }, { ...MITSUKI, clothes: uniform }] });
        expect(out).toContain('Both wear: school uniform, White underclothes.');
    });

    it('MUTATION TARGET — a prefix ending in a period joins with no ".,"', () => {
        const out = composeImagePrompt({ prefix: 'anime screencap, very aesthetic.', composition: '1girl', people: [IORI] });
        expect(out.startsWith('anime screencap, very aesthetic, 1girl')).toBe(true);
        expect(out).not.toContain('.,');
    });
});

// ── the composition cleanup ──────────────────────────────────────────────────────────────────
// The live case it exists for: the narrator copied a girl's look into the composition, so the prompt
// carried both its copy and her stored look.
const THE_REAL_COMPOSITION = '1girl, standing, walking into a classroom, looking at camera, gentle smile, '
    + 'huge breasts, H-cup, tight shirt, school uniform, purple hair, high ponytail, sunlight, cherry blossoms outside';

describe('sanitizeComposition — only a fixed attribute stated about a feature', () => {
    it('removes the colour, the sizes — and nothing else from the live case', () => {
        const { text, removed } = sanitizeComposition(THE_REAL_COMPOSITION);
        expect(removed).toEqual([
            { tag: 'huge breasts', why: 'size' },
            { tag: 'H-cup', why: 'size' },
            { tag: 'purple hair', why: 'hair/eye colour' },
        ]);
        expect(text).toBe('1girl, standing, walking into a classroom, looking at camera, gentle smile, tight shirt, school uniform, high ponytail, sunlight, cherry blossoms outside');
    });

    it('MUTATION TARGET — each kind of fixed attribute goes', () => {
        const cases = {
            'hair/eye colour': ['purple hair', 'golden amber eyes', 'cyan eyes', 'silver-haired', 'blue-eyed', 'heterochromia', 'dark purple hair'],
            size: ['huge breasts', 'H-cup', 'D cup', 'flat chest', 'small chest', 'Huge Breasts'],
            build: ['hourglass figure', 'voluptuous', 'busty', 'petite', 'curvaceous'],
        };
        for (const [why, tags] of Object.entries(cases)) {
            for (const tag of tags) expect(sanitizeComposition(`standing, ${tag}`).removed, tag).toEqual([{ tag, why }]);
        }
    });

    // Every one of these was removed by the old word lists. They are states, contact, species or
    // garments — the per-picture facts the contract and the explicit block REQUIRE.
    it('MUTATION TARGET — keeps states, contact, species features and garments', () => {
        for (const line of [
            '1girl, 1boy, kneeling on the bed, skirt pushed up, panties pulled aside, shirt unbuttoned, flushed',
            'his hand in her hair, hair blowing in the wind, wet hair',
            'tail wagging, elf ears twitching, wings spread wide, small horns',
            'flushed skin, goosebumps on her skin',
            'holding a cup of tea, closed eyes, half-lidded eyes, looking at viewer, playful smile',
            'bare breasts, cleavage visible, red dress, plate armor',
        ]) {
            const { text, removed } = sanitizeComposition(line);
            expect(removed, line).toEqual([]);
            expect(text).toBe(line);
        }
    });

    it('returns the original rather than an empty scene when EVERYTHING was an attribute', () => {
        const { text, removed } = sanitizeComposition('purple hair, H-cup');
        expect(text).toBe('purple hair, H-cup');
        expect(removed).toHaveLength(2);
    });
});

describe('composeImagePrompt — the cleanup runs only when everyone in the shot has a look', () => {
    it('everyone has a look ⇒ the copy is removed and reported', () => {
        const seen = [];
        const out = composeImagePrompt({ prefix: '', composition: THE_REAL_COMPOSITION, people: [MITSUKI], cleanup: true, onRemoved: (r) => seen.push(...r) });
        expect(out).not.toMatch(/H-cup/);
        expect(seen.map((r) => r.tag)).toContain('purple hair');
    });

    // Someone drawn from the scene alone has the composition as their only description.
    // MUTATION TARGET: clean regardless and that person loses it.
    it('anyone without a look ⇒ the composition is left untouched', () => {
        const out = composeImagePrompt({ prefix: '', composition: 'standing, purple hair', people: [MITSUKI], cleanup: false });
        expect(out).toContain('standing, purple hair.');
    });

    it('pure scenery is never cleaned — there is no look to contradict', () => {
        const scenery = 'empty classroom, purple curtains, school uniform on a hook';
        expect(composeImagePrompt({ prefix: '', composition: scenery, people: [], cleanup: true })).toBe(scenery);
    });
});

// ── who a <pic> draws ────────────────────────────────────────────────────────────────────────
describe('picSlots — the one reader of a <pic>\'s people', () => {
    it('reads char=, char2=, char3= … with their outfits, left to right', () => {
        const tag = '<pic char3="Bram" outfit3="apron" char="Iori" char2="Aria" outfit="gym" prompt="x">';
        expect(picSlots(tag)).toEqual([
            { key: 'Iori', outfit: 'gym' },
            { key: 'Aria', outfit: '' },
            { key: 'Bram', outfit: 'apron' },
        ]);
    });

    it('a gap in the numbering loses nobody', () => {
        expect(picSlots('<pic char="A" char3="C" prompt="x">').map((s) => s.key)).toEqual(['A', 'C']);
    });

    // MUTATION TARGET: a reader that matched "char=" inside "mainchar=" would draw the main character
    // as a named person.
    it('mainchar= is never a slot, and outfit= never reads outfit2=', () => {
        const tag = '<pic mainchar="undressed" char2="B" outfit2="x" prompt="y">';
        expect(picSlots(tag)).toEqual([{ key: 'B', outfit: 'x' }]);
        expect(picSlots('<pic char="A" outfit2="x" prompt="y">')).toEqual([{ key: 'A', outfit: '' }]);
    });

    it('empty names are skipped; junk is nobody', () => {
        expect(picSlots('<pic char="" char2="B" prompt="x">')).toEqual([{ key: 'B', outfit: '' }]);
        expect(picSlots(null)).toEqual([]);
        expect(picSlots('<pic prompt="x">')).toEqual([]);
    });
});

describe('maincharOf — the main character is drawn exactly when the tag says so', () => {
    it('an outfit ⇒ drawn in it, before or after prompt=', () => {
        expect(maincharOf('<pic char="A" mainchar="default" prompt="x">')).toEqual({ drawn: true, outfit: 'default', problem: '' });
        expect(maincharOf('<pic mainchar="undressed" prompt="x">')).toEqual({ drawn: true, outfit: 'undressed', problem: '' });
        expect(maincharOf('<pic char="A" camera="eye-level" prompt="1girl, 1boy" mainchar="town-casual">')).toEqual({ drawn: true, outfit: 'town-casual', problem: '' });
        expect(maincharOf('<pic mainchar="" prompt="x">')).toEqual({ drawn: true, outfit: '', problem: '' });
    });

    // Every <pic> carries mainchar=; "not-in-picture" is the narrator saying he is not in it.
    it('MUTATION TARGET — "not-in-picture" ⇒ not drawn, no problem; any case, a space or underscore reads as the hyphen', () => {
        for (const written of ['not-in-picture', 'Not-In-Picture', 'not in picture', 'not_in_picture']) {
            expect(maincharOf(`<pic char="A" prompt="1girl" mainchar="${written}">`)).toEqual({ drawn: false, outfit: '', problem: '' });
        }
    });

    // A "1boy" in the composition draws nobody: the tag decides, and a tag without mainchar= is the narrator's slip.
    it('MUTATION TARGET — absent ⇒ not drawn, and the problem is "missing", whatever the composition counts', () => {
        expect(maincharOf('<pic char="A" prompt="1girl, 1boy, 2boys">')).toEqual({ drawn: false, outfit: '', problem: 'missing' });
    });
});

describe('cameraOf / withCamera — the camera a <pic> names reaches the image model', () => {
    it('MUTATION TARGET — a listed camera= gives its image words; any case, a space or underscore reads as the hyphen', () => {
        expect(cameraOf('<pic char="A" outfit="x" camera="from-below" prompt="p">')).toEqual({ value: 'from-below', words: 'from below', problem: '' });
        expect(cameraOf('<pic char="A" camera="Eye Level" prompt="p">')).toEqual({ value: 'eye-level', words: 'eye level', problem: '' });
        expect(cameraOf('<pic char="A" camera="dutch_angle" prompt="p">').words).toBe('dutch angle');
        expect(cameraOf('<pic char="A" camera="pov" prompt="p">').words).toBe('pov');
        // "wide shot" alone was ignored; the full-body framing pulled the camera back far enough to show both people whole.
        expect(cameraOf('<pic char="A" camera="wide-shot" prompt="p">').words).toBe('full body shot, camera pulled back, head-to-toe framing');
    });

    it('MUTATION TARGET — a missing or unknown camera= is a problem for the caller to warn, never a guessed angle', () => {
        expect(cameraOf('<pic char="A" outfit="x" prompt="p">')).toEqual({ value: '', words: '', problem: 'missing' });
        expect(cameraOf('<pic char="A" camera="" prompt="p">').problem).toBe('missing');
        expect(cameraOf('<pic char="A" camera="over the shoulder" prompt="p">')).toEqual({ value: 'over the shoulder', words: '', problem: 'unknown' });
    });

    // The image model settles the framing from the opening words: "wide shot" or "close-up" closing the composition
    // was ignored (staging msg 302: two people cropped at the thigh, his named sneaker drawn in his hand).
    it('MUTATION TARGET — the camera words open the composition, never repeated', () => {
        expect(withCamera('1girl, leila, leaning on a pillar', 'from below')).toBe('from below, 1girl, leila, leaning on a pillar');
        expect(withCamera('1girl, leila, leaning on a pillar,', 'eye level')).toBe('eye level, 1girl, leila, leaning on a pillar');
        expect(withCamera('1girl, close-up, leila smiling', 'close-up')).toBe('1girl, close-up, leila smiling');
        // the narrator echoing the camera= value itself: hyphen or space, the same words (live: "wide-shot, wide shot")
        expect(withCamera('empty ruins, late light, wide-shot', 'wide shot')).toBe('empty ruins, late light, wide-shot');
        expect(withCamera('1girl, leila, close up', 'close-up')).toBe('1girl, leila, close up');
        expect(withCamera('1girl, leila, eye_level', 'eye level')).toBe('1girl, leila, eye_level');
        expect(withCamera('1girl, leila', '')).toBe('1girl, leila');
        expect(withCamera('', 'wide shot')).toBe('wide shot');
    });
});

// She leans on his chest in a close-up; the tag counts 1girl and its mainchar= draws nobody, so his look is not attached
// and the image model builds his body from hers. The check names that cause; it never adds him.
describe('maincharNamedButNotDrawn — the main character named on a tag that does not draw him', () => {
    const LEANING = '1girl, mitsuki, sitting very close on carpet, leaning against mainchar\'s chest, blushing deeply, hands pressed against his chest, cozy room, soft afternoon light, close-up, from front';
    const TAG = `<pic char="Mitsuki" outfit="school-uniform" prompt="${LEANING}">`;

    it('MUTATION TARGET — the word a narrator writes for him, on a tag with no mainchar=', () => {
        expect(maincharNamedButNotDrawn(TAG, LEANING, ['Goten', 'Mainchar'])).toBe('Mainchar');
        expect(maincharNamedButNotDrawn(TAG, LEANING, [])).toBe('mainchar');
        expect(maincharNamedButNotDrawn(TAG, "1girl, ume, hand on {{user}}'s shoulder, upper body", null)).toBe('{{user}}');
        expect(maincharNamedButNotDrawn(TAG, '1girl, ume, leaning against the main character, upper body', [])).toBe('main character');
    });

    it('MUTATION TARGET — a tag that says mainchar="not-in-picture" does not draw him either', () => {
        const left = `<pic char="Mitsuki" outfit="school-uniform" prompt="${LEANING}" mainchar="not-in-picture">`;
        expect(maincharNamedButNotDrawn(left, LEANING, ['Goten', 'Mainchar'])).toBe('Mainchar');
    });

    it('his persona name, in the story\'s script', () => {
        expect(maincharNamedButNotDrawn('<pic char="Ume" prompt="x">', "1girl, ume, hugging Goten's arm, street, from side", ['Goten', 'Mainchar'])).toBe('Goten');
        expect(maincharNamedButNotDrawn('<pic char="Ume" prompt="x">', "1girl, ume, leaning on 悟天's shoulder, upper body", ['悟天'])).toBe('悟天');
    });

    it('MUTATION TARGET — a tag that carries mainchar= draws him: nothing to say', () => {
        const drawn = '<pic char="Mitsuki" outfit="school-uniform" mainchar="school-uniform" prompt="x">';
        expect(maincharNamedButNotDrawn(drawn, LEANING, ['Goten', 'Mainchar'])).toBe('');
    });

    // The camera is his eyes: his own hands in the frame need no look.
    it('MUTATION TARGET — a pov shot keeps him out', () => {
        expect(maincharNamedButNotDrawn(TAG, "1girl, pov, mitsuki leaning against Goten's chest, looking up at viewer", ['Goten'])).toBe('');
        expect(maincharNamedButNotDrawn(TAG, "1girl, POV, Goten's hand on her head", ['Goten'])).toBe('');
    });

    it('MUTATION TARGET — a name inside another word is no mention', () => {
        expect(maincharNamedButNotDrawn(TAG, '1girl, mitsuki, pointing at the mainchart, library', ['Goten'])).toBe('');
        expect(maincharNamedButNotDrawn(TAG, '1girl, mitsuki, Gotenburg street, from side', ['Goten'])).toBe('');
    });

    it('nobody named, or nothing written, is nothing', () => {
        expect(maincharNamedButNotDrawn(TAG, '1girl, mitsuki, sitting, classroom', ['Goten', 'Mainchar'])).toBe('');
        expect(maincharNamedButNotDrawn(TAG, '', ['Goten'])).toBe('');
        expect(maincharNamedButNotDrawn('', undefined, undefined)).toBe('');
    });
});

// The check runs in the host-coupled image-gen.js, so its hand-off is gated as SOURCE: every picture's prompt is built
// through assembleForReply, which checks the composition against his persona name and his entry's key, warns, and
// draws the tag as written.
describe('SOURCE GATE — every picture checks its composition for the main character', () => {
    const src = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8');

    it('MUTATION TARGET — assembleForReply warns with his persona name and his entry\'s key, and adds nobody', () => {
        const at = src.indexOf('async function assembleForReply(mesId, rawTag, composition, { shownFor = null } = {}) {');
        expect(at).toBeGreaterThan(-1);
        const body = src.slice(at, at + src.slice(at).search(/\r?\n\}\r?\n/));
        expect(body).toContain('const named = maincharNamedButNotDrawn(rawTag, composition, [getContext().name1, getImagegenProfile().maincharRegistryKey]);');
        expect(body).toMatch(/if \(named\) \{\s*log\.warn\(/);
        expect(body).toContain('const assembled = await assemblePrompt(rawTag, scene, replyCastRecordsOf(mesId), worn, shownFor);');
        // assemblePrompt is defined once and called only from here, so no picture skips the check
        expect(src.match(/assemblePrompt\(/g)).toHaveLength(2);
    });
});

describe('fitPeopleToCeiling — the card\'s ceiling, and nothing more', () => {
    const slots = (...keys) => keys.map((key) => ({ key, outfit: '' }));

    it('under the ceiling, everyone is drawn', () => {
        const fit = fitPeopleToCeiling({ slots: slots('A', 'B'), mainchar: { drawn: true, outfit: '' }, ceiling: 3 });
        expect(fit.slots.map((s) => s.key)).toEqual(['A', 'B']);
        expect(fit.mainchar.drawn).toBe(true);
        expect(fit.dropped).toEqual([]);
    });

    // He counts toward the ceiling, and goes first: the named characters are the story's subjects.
    it('MUTATION TARGET — over the ceiling the main character goes first, then the rightmost slots', () => {
        const fit = fitPeopleToCeiling({ slots: slots('A', 'B', 'C'), mainchar: { drawn: true, outfit: '' }, ceiling: 3 });
        expect(fit.mainchar.drawn).toBe(false);
        expect(fit.slots.map((s) => s.key)).toEqual(['A', 'B', 'C']);
        expect(fit.dropped).toEqual(['mainchar']);
        const tight = fitPeopleToCeiling({ slots: slots('A', 'B', 'C'), ceiling: 1 });
        expect(tight.slots.map((s) => s.key)).toEqual(['A']);
        expect(tight.dropped).toEqual(['C', 'B']);
    });

    it('no code ceiling: a card may allow more than three', () => {
        expect(fitPeopleToCeiling({ slots: slots('A', 'B', 'C', 'D', 'E'), ceiling: 5 }).slots).toHaveLength(5);
    });

    it('one name twice is one person', () => {
        const fit = fitPeopleToCeiling({ slots: slots('Mia', 'mia'), ceiling: 3 });
        expect(fit.slots.map((s) => s.key)).toEqual(['Mia']);
        expect(fit.repeated).toEqual(['mia']);
    });

    it('a broken ceiling reads as 1, never as unlimited', () => {
        expect(fitPeopleToCeiling({ slots: slots('A', 'B'), ceiling: 'x' }).slots).toHaveLength(1);
    });
});

describe('bustValueFor — only people who declare [Bust] count', () => {
    const SETTINGS = { enabled: true, defaultValue: 1, sharedValue: 1.5 };

    it('nobody declares ⇒ the default; one ⇒ theirs; two or more ⇒ the shared value', () => {
        expect(bustValueFor([{ bust: null }, { bust: null }], SETTINGS)).toBe(1);
        expect(bustValueFor([{ bust: 2.4 }, { bust: null }], SETTINGS)).toBe(2.4);
        expect(bustValueFor([{ bust: 2.4 }, { bust: 3 }, { bust: null }], SETTINGS)).toBe(1.5);
    });

    // A look from the reply never declares one, so a newcomer beside her does not dilute her value.
    it('MUTATION TARGET — a person without [Bust] does not turn one value into the shared one', () => {
        expect(bustValueFor([{ bust: 2.4 }, { bust: null }, { bust: null }], SETTINGS)).toBe(2.4);
    });

    it('off ⇒ null, so nothing is sent', () => {
        expect(bustValueFor([{ bust: 2 }], { ...SETTINGS, enabled: false })).toBeNull();
        expect(bustValueFor([], null)).toBeNull();
    });
});

// ── what a card's settings make the pipeline do ──────────────────────────────────────────────
describe('imageDuties — image generation and harvest are independent', () => {
    const duties = (insertType, route, via) => imageDuties({ insertType, route, via });

    it('Disable sends nothing and draws nothing', () => {
        expect(duties('disabled', 'predefined', '')).toEqual({
            sendsImageContract: false, pictureWriter: '', pictureCall: '', sendsNarratorContract: false,
            historyPictures: HISTORY_PICTURES.AS_IS, narratorTagAction: NARRATOR_TAG_ACTION.IGNORE, pregenerates: false,
            draws: false, stores: false, needsReplyCast: false, lookTarget: '',
        });
    });

    it('Tags only sends the instruction and draws nothing', () => {
        expect(duties(INSERT_TYPE.TAGS_ONLY, 'predefined', '')).toMatchObject({ sendsImageContract: true, draws: false, needsReplyCast: true, lookTarget: 'narrate' });
    });

    it('a drawing insert type sends and draws', () => {
        for (const type of ['inline', 'new', 'replace']) expect(duties(type, 'predefined', '')).toMatchObject({ sendsImageContract: true, draws: true });
    });

    // The defect this ends: harvest used to need the image switch, and the image switch used to need harvest.
    it('MUTATION TARGET — harvest stores with images off, and only on its own two settings', () => {
        expect(duties('disabled', 'harvest', 'narrate')).toMatchObject({ stores: true, needsReplyCast: true, lookTarget: 'narrate', sendsImageContract: false });
        expect(duties('disabled', 'harvest', 'POST2')).toMatchObject({ stores: true, lookTarget: 'POST2' });
        expect(duties('replace', 'harvest', '')).toMatchObject({ stores: false, lookTarget: 'narrate' });
        expect(duties('replace', 'predefined', 'POST2')).toMatchObject({ stores: false, lookTarget: 'narrate' });
    });

    it('while storing, Harvest via decides who describes — the narrator otherwise', () => {
        expect(duties('replace', 'harvest', 'POST2').lookTarget).toBe('POST2');
        expect(duties('replace', 'harvest', 'narrate').lookTarget).toBe('narrate');
    });

    it('an unknown insert type reads as Disable', () => {
        expect(duties('teach', 'predefined', '')).toMatchObject({ sendsImageContract: false, draws: false });
    });
});

// "Pictures written by" (plans/executed/picture-writer-route.md D1, D3): the narrator, or a POST call that reads the
// finished reply. Every gate that depends on the writer is answered here.
describe('imageDuties — who writes the pictures', () => {
    const SENDING_TYPES = [INSERT_TYPE.TAGS_ONLY, INSERT_TYPE.INLINE, INSERT_TYPE.NEW_MESSAGE, INSERT_TYPE.REPLACE];
    const REGISTRATION_ROUTES = [['predefined', ''], ['predefined', 'POST1'], ['harvest', ''], ['harvest', 'narrate'], ['harvest', 'POST1']];
    const writerFields = (d) => ({
        pictureWriter: d.pictureWriter, pictureCall: d.pictureCall, sendsNarratorContract: d.sendsNarratorContract,
        historyPictures: d.historyPictures, narratorTagAction: d.narratorTagAction, pregenerates: d.pregenerates,
    });

    it('MUTATION TARGET — unset, blank or "narrate": the narrator writes them, as it always has', () => {
        for (const picturesVia of [undefined, '', '  ', 'narrate', ' narrate ']) {
            expect(writerFields(imageDuties({ insertType: INSERT_TYPE.TAGS_ONLY, picturesVia })), String(picturesVia)).toEqual({
                pictureWriter: 'narrate', pictureCall: '', sendsNarratorContract: true,
                historyPictures: HISTORY_PICTURES.AS_TAGS, narratorTagAction: NARRATOR_TAG_ACTION.DISPOSE, pregenerates: false,
            });
            for (const insertType of [INSERT_TYPE.INLINE, INSERT_TYPE.REPLACE]) {
                expect(writerFields(imageDuties({ insertType, picturesVia })), `${insertType} ${picturesVia}`).toEqual({
                    pictureWriter: 'narrate', pictureCall: '', sendsNarratorContract: true,
                    historyPictures: HISTORY_PICTURES.AS_TAGS, narratorTagAction: NARRATOR_TAG_ACTION.DRAW, pregenerates: true,
                });
            }
        }
    });

    it('MUTATION TARGET — New message draws the narrator\'s tags but never pre-generates them', () => {
        expect(imageDuties({ insertType: INSERT_TYPE.NEW_MESSAGE })).toMatchObject({ draws: true, narratorTagAction: NARRATOR_TAG_ACTION.DRAW, pregenerates: false });
    });

    it('MUTATION TARGET — a POST call: the narrator gets no picture rules, and a tag it writes anyway is a stray', () => {
        for (const insertType of SENDING_TYPES) {
            expect(writerFields(imageDuties({ insertType, picturesVia: 'POST2' })), insertType).toEqual({
                pictureWriter: 'POST2', pictureCall: 'POST2', sendsNarratorContract: false,
                historyPictures: HISTORY_PICTURES.REMOVED, narratorTagAction: NARRATOR_TAG_ACTION.DISPOSE_AS_STRAY, pregenerates: false,
            });
        }
        expect(imageDuties({ insertType: INSERT_TYPE.TAGS_ONLY, picturesVia: 'POST2' }).draws).toBe(false);
        expect(imageDuties({ insertType: INSERT_TYPE.REPLACE, picturesVia: 'POST2' }).draws).toBe(true);
        expect(imageDuties({ insertType: INSERT_TYPE.REPLACE, picturesVia: ' POST2 ' }).pictureCall).toBe('POST2');
    });

    it('MUTATION TARGET — Disable: nobody writes pictures, whoever is chosen', () => {
        for (const picturesVia of [undefined, 'narrate', 'POST2']) {
            expect(writerFields(imageDuties({ insertType: INSERT_TYPE.DISABLED, picturesVia })), String(picturesVia)).toEqual({
                pictureWriter: '', pictureCall: '', sendsNarratorContract: false,
                historyPictures: HISTORY_PICTURES.AS_IS, narratorTagAction: NARRATOR_TAG_ACTION.IGNORE, pregenerates: false,
            });
        }
    });

    // image-gen.js is host-coupled, so the two lines that hand its gates to this decision are gated as SOURCE.
    it('MUTATION TARGET — the host passes the picture writer, and pre-generation asks pregenerates', () => {
        const src = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8');
        expect(src).toContain('return imageDuties({ insertType: prof.insertType, route: getRosterProfile().route, via: prof.charimgVia, picturesVia: prof.picturesVia });');
        expect(src).toContain('if (!s || !currentDuties().pregenerates || s.streamingPregen === false) return;');
    });

    // The picture task (image-gen.js): dormant while the narrator writes the pictures, so the router injects and
    // captures nothing for it (D2), and never off (D1).
    it('MUTATION TARGET — the picture task runs only while a POST call writes the pictures, and offers no Off', () => {
        const src = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8');
        const task = src.slice(src.indexOf('    id: PICTURES_TASK_ID,'), src.indexOf('initLlmTaskRouter();'));
        expect(task).toContain("allow: ['narrate', 'post'],");
        expect(task).toContain('offersOff: false,');
        expect(task).toContain("isActive: () => currentDuties().pictureCall !== '',");
        expect(task).toContain('getActiveTarget: () => currentDuties().pictureCall,');
    });

    // The writer moves who writes the tags, never what is drawn or who describes looks: the narrator's <cast>
    // records are where pictures read looks on both routes (D3).
    it('MUTATION TARGET — every other answer is the same on both routes, for every Insert Type and registration route', () => {
        for (const insertType of [...Object.values(INSERT_TYPE), 'teach']) {
            for (const [route, via] of REGISTRATION_ROUTES) {
                const narrator = imageDuties({ insertType, route, via });
                const post = imageDuties({ insertType, route, via, picturesVia: 'POST2' });
                for (const field of ['sendsImageContract', 'draws', 'stores', 'needsReplyCast', 'lookTarget']) {
                    expect(post[field], `${insertType} ${route} ${via} ${field}`).toBe(narrator[field]);
                }
            }
        }
    });
});

// The narrator's outgoing prompt (image-gen.js hands the parts over at prompt-ready; plans/executed/picture-writer-route.md D2,
// D3): the narrator route keeps today's layout, and the POST route sends no picture part and no past picture.
describe('placeNarratorPictureParts — the picture parts of the narrator\'s prompt', () => {
    const tag = '<pic char="Iori" camera="eye-level" prompt="1girl, sitting" mainchar="not-in-picture">';
    const rendered = buildRenderedImageWrap({ escapedRawTag: escapeHtmlAttribute(tag), escapedUrl: 'img/a.png', escapedPrompt: 'p' });
    const chatOf = () => [
        { role: 'system', content: 'card rules: a <pic char="Example" prompt="shown as an example"> line' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: `She sat.\n${rendered}\nEnd.` },
        { role: 'assistant', content: `She stood.\n${tag}\nEnd.` },
        { role: 'user', content: 'go on' },
    ];
    const parts = { rules: 'RULES', scene: 'SCENE', count: 'COUNT' };

    it('MUTATION TARGET — narrator route: rules open the prompt, <scene_roster> at its depth, <picture_count> ends it', () => {
        const atEnd = chatOf();
        placeNarratorPictureParts(atEnd, { historyPictures: HISTORY_PICTURES.AS_TAGS, unescapeAttr: unescapeHtmlAttribute, ...parts, depth: 0 });
        expect(atEnd.map((m) => m.content).filter((c) => ['RULES', 'SCENE', 'COUNT'].includes(c))).toEqual(['RULES', 'SCENE', 'COUNT']);
        expect(atEnd[0]).toEqual({ role: 'system', content: 'RULES' });
        expect(atEnd[atEnd.length - 2].content).toBe('SCENE');
        expect(atEnd[atEnd.length - 1]).toEqual({ role: 'system', content: 'COUNT' });
        const deeper = chatOf();
        placeNarratorPictureParts(deeper, { historyPictures: HISTORY_PICTURES.AS_TAGS, unescapeAttr: unescapeHtmlAttribute, ...parts, depth: 2, role: 'user' });
        // two story messages from the end, then those two, then <picture_count>
        expect(deeper.slice(-4).map((m) => m.content)).toEqual(['SCENE', chatOf()[3].content, 'go on', 'COUNT']);
        expect(deeper[deeper.length - 4].role).toBe('user');
    });

    it('MUTATION TARGET — narrator route: a rendered image in the history reads as its <pic> tag', () => {
        const chat = chatOf();
        const changed = placeNarratorPictureParts(chat, { historyPictures: HISTORY_PICTURES.AS_TAGS, unescapeAttr: unescapeHtmlAttribute });
        expect(changed).toBe(1);
        expect(chat[2].content).toBe(`She sat.\n${tag}\nEnd.`);
        expect(chat).toHaveLength(5);
    });

    it('MUTATION TARGET — POST route: no part is added, and no past picture is left in the history', () => {
        const chat = chatOf();
        const changed = placeNarratorPictureParts(chat, { historyPictures: HISTORY_PICTURES.REMOVED, unescapeAttr: unescapeHtmlAttribute });
        expect(changed).toBe(2);
        expect(chat).toHaveLength(5);
        expect(chat[2].content).toBe('She sat.\n\nEnd.');
        expect(chat[3].content).toBe('She stood.\n\nEnd.');
        expect(chat[0].content).toBe(chatOf()[0].content);   // an instruction's example is not a past picture
    });

    it('MUTATION TARGET — no picture contract: the prompt is left as it is', () => {
        const chat = chatOf();
        expect(placeNarratorPictureParts(chat, { historyPictures: HISTORY_PICTURES.AS_IS, unescapeAttr: unescapeHtmlAttribute })).toBe(0);
        expect(chat).toEqual(chatOf());
    });
});

// R1 (plans/executed/picture-writer-route.md): pictures on a POST call need registration on a POST call or Off.
describe('the writer pickers — which Harvest via goes with which picture writer (R1)', () => {
    const HARVEST = ['', 'narrate', 'POST1'];
    const PICTURES = ['narrate', 'POST2'];

    it('MUTATION TARGET — the table: Harvest via on the narrator offers no picture call; every other pair is offered', () => {
        for (const harvestVia of HARVEST) {
            expect(isPictureWriterOffered('narrate', harvestVia), `narrate with ${harvestVia}`).toBe(true);
            expect(isPictureWriterOffered('POST2', harvestVia), `POST2 with ${harvestVia}`).toBe(harvestVia !== 'narrate');
        }
    });

    it('MUTATION TARGET — read the other way: pictures on a POST call offer no narrator registration', () => {
        for (const picturesVia of [...PICTURES, '', undefined]) {
            const isPictureCall = picturesVia === 'POST2';
            expect(isHarvestTargetOffered('narrate', picturesVia), `narrate with ${picturesVia}`).toBe(!isPictureCall);
            expect(isHarvestTargetOffered('POST1', picturesVia), `POST1 with ${picturesVia}`).toBe(true);
            expect(isHarvestTargetOffered('', picturesVia), `Off with ${picturesVia}`).toBe(true);
        }
    });

    it('MUTATION TARGET — each picker\'s hint line shows exactly while it leaves an option out', () => {
        for (const harvestVia of HARVEST) {
            for (const picturesVia of PICTURES) {
                const ruledOut = writerPairRuledOut({ harvestVia, picturesVia });
                expect(ruledOut.arePictureCallsHidden, `${harvestVia}/${picturesVia}`).toBe(!isPictureWriterOffered('POST2', harvestVia));
                expect(ruledOut.isHarvestNarratorHidden, `${harvestVia}/${picturesVia}`).toBe(!isHarvestTargetOffered('narrate', picturesVia));
            }
        }
        expect(writerPairRuledOut({ harvestVia: 'narrate', picturesVia: 'narrate' })).toEqual({ arePictureCallsHidden: true, isHarvestNarratorHidden: false });
        expect(writerPairRuledOut({ harvestVia: 'POST1', picturesVia: 'POST2' })).toEqual({ arePictureCallsHidden: false, isHarvestNarratorHidden: true });
    });

    // The pickers are painted by the host-coupled router and settings UI; their wiring is gated as SOURCE.
    it('MUTATION TARGET — each task\'s picker uses the rule, and a change to either repaints both', () => {
        const engine = readFileSync(new URL('../src/features/imagegen/image-gen.js', import.meta.url), 'utf8');
        expect(engine).toContain('offers: (target) => isPictureWriterOffered(target, getImagegenProfile().charimgVia),');
        expect(engine).toContain('offers: (target) => isHarvestTargetOffered(target, getImagegenProfile().picturesVia),');
        const ui = readFileSync(new URL('../src/features/imagegen/image-settings-ui.js', import.meta.url), 'utf8');
        expect(ui).toContain("$('#mvuh_img_pictures_via_rule').toggle(ruledOut.arePictureCallsHidden);");
        expect(ui).toContain("$('#mvuh_img_charimg_via_rule').toggle(ruledOut.isHarvestNarratorHidden);");
        expect(ui).toContain("$('#mvuh_img_pictures_via, #mvuh_img_charimg_via').on('change', () => { queueMicrotask(() => updateImageUI()); });");
    });
});

describe('sceneRosterText — the on-screen anchor', () => {
    it('lists the present keys, and says nothing about who is ON FILE', () => {
        const text = sceneRosterText(['Vasquez', 'Okonkwo']);
        expect(text).toContain('<scene_roster>');
        expect(text).toContain('- Vasquez\n- Okonkwo');
        expect(text).not.toContain('(outfits:');
    });

    it('nobody present ⇒ no block', () => {
        expect(sceneRosterText([])).toBe('');
        expect(sceneRosterText(undefined)).toBe('');
    });
});

describe('validateCharSlots — which drawn names deserve a diagnostic', () => {
    const RESERVED = ['default', 'undressed', 'newclothes', 'none'];

    it('THE REGRESSION GUARD: a reserved word is flagged with NOTHING known — no cast, no registry', () => {
        // This check was gated on the cast being non-empty, which switched it off on exactly the
        // cards (non-MVU, presence-less) where char="none" has no other guard.
        expect(validateCharSlots(['none'], RESERVED, [])).toEqual([{ name: 'none', kind: 'reserved' }]);
    });

    it('a typo is caught against the DNA registry ALONE — no cast needed', () => {
        expect(validateCharSlots(['Yuzuki'], RESERVED, ['柚月', 'ViscountArmand']))
            .toEqual([{ name: 'Yuzuki', kind: 'unknown' }]);
    });

    it('a name that resolves — cast key, DNA key, or alias, any case — is silent', () => {
        expect(validateCharSlots(['薇歐拉', 'GOTEN'], RESERVED, ['Goten', '薇歐拉·杜茲', '薇歐拉'])).toEqual([]);
    });

    it('unknown is SUPPRESSED when nothing at all is known — an always-firing diagnostic is noise', () => {
        expect(validateCharSlots(['柚月'], RESERVED, [])).toEqual([]);
    });

    it('reserved outranks unknown, empty slots are skipped, junk degrades', () => {
        expect(validateCharSlots(['NewClothes', '', null, '柚月'], RESERVED, ['柚月']))
            .toEqual([{ name: 'NewClothes', kind: 'reserved' }]);
        expect(validateCharSlots(undefined, RESERVED, undefined)).toEqual([]);
    });
});

describe('DEFAULT_REGEX — the <pic> scanner must not cross into other elements', () => {
    const compile = () => {
        const i = DEFAULT_REGEX.lastIndexOf('/');
        return new RegExp(DEFAULT_REGEX.slice(1, i), DEFAULT_REGEX.slice(i + 1));
    };
    const PIC = '<pic char="Mia" outfit="default" type="portrait" prompt="1girl, sitting">';

    it('matches a plain <pic> and captures the prompt', () => {
        const ms = [...PIC.matchAll(compile())];
        expect(ms).toHaveLength(1);
        expect(ms[0][1]).toBe('1girl, sitting');
    });

    it('MUTATION TARGET — the <img> alias is gone: a real <img> is never a detected tag', () => {
        const ms = [...'<img char="Mia" prompt="1girl, standing">'.matchAll(compile())];
        expect(ms).toHaveLength(0);
    });

    it('still bridges the auto-close slip (<pic> prompt="…">)', () => {
        const ms = [...'<pic char="Mia"> prompt="1girl, waving">'.matchAll(compile())];
        expect(ms).toHaveLength(1);
        expect(ms[0][1]).toBe('1girl, waving');
    });

    it('THE REGRESSION GUARD (live corruption 2026-08-09): a rendered <img> before a leftover <pic> anchors NOTHING — the match is the <pic> alone', () => {
        // Old regex: the scan anchored on the spliced <img> (no prompt= of its own), bridged its
        // closing > and everything after — prose, escaped debug line, JSON — until the leftover
        // pic's prompt=", producing ONE match spanning the lot. The sweep then escaped or deleted
        // that whole span of real message text.
        const rendered = '<span class="auto-img-wrap" data-rawtag="&lt;pic char=&quot;Mia&quot; prompt=&quot;x&quot;&gt;">'
            + '<img src="/img/a.png" title="masterpiece, 1girl" alt="masterpiece, 1girl">'
            + '<code class="auto-img-pictag">&lt;pic char=&quot;Mia&quot; prompt=&quot;x&quot;&gt;</code></span>';
        const prose = '\nShe turned away. "Fine," she said.\n{ "op": "insert", "path": "/x" }\n';
        const text = rendered + prose + PIC;
        const ms = [...text.matchAll(compile())];
        expect(ms).toHaveLength(1);
        expect(ms[0][0]).toBe(PIC);              // exactly the leftover tag, nothing spanned
        expect(ms[0].index).toBe(text.indexOf(PIC));
    });
});

describe('decideExplicitBlock — the EXPLICIT/H gate', () => {
    it('always-on checkbox wins and never consults the latch', () => {
        expect(decideExplicitBlock({ alwaysOn: true, latchPath: 'A.B', latchValue: false }))
            .toEqual({ inject: true, reason: 'always-on' });
    });

    it('blank path = no gate = inject (the non-MVU card default)', () => {
        expect(decideExplicitBlock({ latchPath: '' })).toEqual({ inject: true, reason: 'no-gate' });
        expect(decideExplicitBlock({ latchPath: '   ' })).toEqual({ inject: true, reason: 'no-gate' });
        expect(decideExplicitBlock({})).toEqual({ inject: true, reason: 'no-gate' });
    });

    it('a readable gate injects unless it reads an explicit false', () => {
        expect(decideExplicitBlock({ latchPath: 'A.B', latchValue: true })).toEqual({ inject: true, reason: 'gate-open' });
        expect(decideExplicitBlock({ latchPath: 'A.B', latchValue: false })).toEqual({ inject: false, reason: 'gate-closed' });
    });

    it('does NOT reinterpret a consumer value: only boolean false closes the gate', () => {
        // 0 / '' / null are falsy but are not `false`; the consumer owns what its flag means.
        for (const v of [0, '', null, 'no', 'false']) {
            expect(decideExplicitBlock({ latchPath: 'A.B', latchValue: v }).inject).toBe(true);
        }
    });

    // THE REGRESSION. Live 2026-08-09: a stored profile still pointed at a state root that a
    // downstream rename had deleted, so the path resolved to undefined and the OLD `latch !== false`
    // injected the explicit block into every prompt on every reply, silently, for weeks.
    it('a configured path that does not resolve FAILS CLOSED and reports why', () => {
        expect(decideExplicitBlock({ latchPath: 'DeletedRoot.SomeFlag', latchValue: undefined }))
            .toEqual({ inject: false, reason: 'gate-unresolvable' });
    });

    it('MUTATION TARGET — no game state to read yet: withheld, and named as no-state, not a broken path', () => {
        expect(decideExplicitBlock({ latchPath: 'A.B', latchValue: undefined, hasState: false }))
            .toEqual({ inject: false, reason: 'no-state' });
    });

    it('a card with no gate still injects when there is no state (the non-MVU card default)', () => {
        expect(decideExplicitBlock({ latchPath: '', hasState: false })).toEqual({ inject: true, reason: 'no-gate' });
    });

    it('distinguishes "no gate" from "broken gate" — both once collapsed to inject:true', () => {
        const none = decideExplicitBlock({ latchPath: '', latchValue: undefined });
        const broken = decideExplicitBlock({ latchPath: 'DeletedRoot.SomeFlag', latchValue: undefined });
        expect(none.inject).toBe(true);
        expect(broken.inject).toBe(false);
        expect(none.reason).not.toBe(broken.reason);
    });

    it('stays genre-blind: no consumer field name appears in any reason', () => {
        const reasons = [
            decideExplicitBlock({ alwaysOn: true }).reason,
            decideExplicitBlock({ latchPath: '' }).reason,
            decideExplicitBlock({ latchPath: 'PendingState.IntimacyActive', latchValue: true }).reason,
            decideExplicitBlock({ latchPath: 'PendingState.IntimacyActive', latchValue: false }).reason,
            decideExplicitBlock({ latchPath: 'World_Calc.IntimacyActive', latchValue: undefined }).reason,
            decideExplicitBlock({ latchPath: 'PendingState.IntimacyActive', hasState: false }).reason,
        ];
        for (const r of reasons) {
            expect(r).not.toMatch(/Intimacy|World_Calc|PendingState|Classmate|Mainchar/i);
        }
    });
});

describe('classifyDeclaredPathRead — is a card-declared path unset, readable, BROKEN, or not readable yet', () => {
    it('blank/absent path is unset, not broken — a card that declares nothing is not misconfigured', () => {
        expect(classifyDeclaredPathRead({ path: '', value: undefined })).toBe('unset');
        expect(classifyDeclaredPathRead({ path: '   ', value: undefined })).toBe('unset');
        expect(classifyDeclaredPathRead({})).toBe('unset');
    });

    it('a path that yields any defined value is resolved — including falsy ones', () => {
        for (const v of [true, false, 0, '', null]) {
            expect(classifyDeclaredPathRead({ path: 'A.B', value: v })).toBe('resolved');
        }
    });

    // THE POINT OF THE FUNCTION: 'unset' and 'unresolvable' both arrive as undefined at the caller.
    it('a configured path yielding undefined is unresolvable — the state a bare undefined hides', () => {
        expect(classifyDeclaredPathRead({ path: 'DeletedRoot.Flag', value: undefined })).toBe('unresolvable');
        expect(classifyDeclaredPathRead({ path: '', value: undefined })).not
            .toBe(classifyDeclaredPathRead({ path: 'DeletedRoot.Flag', value: undefined }));
    });

    it('MUTATION TARGET — no state to read is no-state, never unresolvable', () => {
        expect(classifyDeclaredPathRead({ path: 'A.B', value: undefined, hasState: false })).toBe('no-state');
        expect(classifyDeclaredPathRead({ path: '', value: undefined, hasState: false })).toBe('unset');
    });

    it('agrees with decideExplicitBlock on which reads are broken', () => {
        const cases = [
            { path: '', value: undefined },
            { path: 'A.B', value: false },
            { path: 'A.B', value: true },
            { path: 'DeletedRoot.Flag', value: undefined },
            { path: 'A.B', value: undefined, hasState: false },
        ];
        for (const c of cases) {
            const broken = classifyDeclaredPathRead(c) === 'unresolvable';
            const gate = decideExplicitBlock({ latchPath: c.path, latchValue: c.value, hasState: c.hasState });
            expect(gate.reason === 'gate-unresolvable').toBe(broken);
        }
    });
});

describe('declaredPathWarning — which reads of a declared path are worth a warn', () => {
    it('a path missing from state that exists is always said, practice build or not', () => {
        expect(declaredPathWarning({ read: 'unresolvable', dryRun: false })).toBe('path-missing');
        expect(declaredPathWarning({ read: 'unresolvable', dryRun: true })).toBe('path-missing');
    });

    it('MUTATION TARGET — no state on a practice build is silent (the chat-load dry run)', () => {
        expect(declaredPathWarning({ read: 'no-state', dryRun: true })).toBeNull();
    });

    it('no state on a real reply is said, as no-state', () => {
        expect(declaredPathWarning({ read: 'no-state', dryRun: false })).toBe('no-state');
        expect(declaredPathWarning({ read: 'no-state' })).toBe('no-state');
    });

    it('a readable or unset path says nothing', () => {
        for (const read of ['resolved', 'unset']) {
            expect(declaredPathWarning({ read, dryRun: false })).toBeNull();
            expect(declaredPathWarning({ read, dryRun: true })).toBeNull();
        }
    });
});

// ── the prompt blocks: outfit rules and the scene anchor ─────────────────────────────────────
describe('OUTFIT_RULES_PROMPT — what outfit= may say', () => {
    // UNDRESSED OUTRANKS EVERYTHING: "undressed" is legal for anyone, or a stored character in an H scene has
    // no legal value at all.
    it('"undressed" is legal for anyone and outranks every other value', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/"undressed" — the shot shows them without their clothes\. Legal for anyone, and it OUTRANKS every other value/);
    });

    // MUTATION TARGET: offer "none" again and models write it for a clothed character and an absent {{user}}.
    it('"none" is offered as no outfit= value', () => {
        expect(OUTFIT_RULES_PROMPT).not.toMatch(/"none"/);
        expect(EXPLICIT_RULES_PROMPT).not.toMatch(/"none"/);
        expect(EXPLICIT_RULES_PROMPT).toMatch(/outfit="undressed" ⇒ \[Composition\] MUST state the undress/);
        expect(REGISTRATION_OUTFIT_RULES).toContain('"undressed", "newclothes" and "same-as-last-picture" are never outfit names.');
    });

    // EVERY SLOT NAMES WHAT THAT PERSON WEARS IN THIS SHOT. Leaving outfit= out to mean "nothing changed" asked the
    // narrator to compare across replies — a judgement — and a dressed character left out with nothing stored was
    // drawn nude. A value picked from a list is an observation of this shot. "default" is only a name some characters
    // have on file, never a value to reach for.
    it('MUTATION TARGET — outfit= is required on every slot, picked from a list; nothing is left out to mean something', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/It reads the outfit= of their slot \(outfit2=, outfit3= … for the others\) word for word and draws the clothes that value names, so every slot needs one/);
        expect(OUTFIT_RULES_PROMPT).not.toMatch(/leave it out|left out|nothing changed/i);
        expect(OUTFIT_RULES_PROMPT).not.toMatch(/"default"/);
        expect(OUTFIT_RULES_PROMPT).not.toMatch(/normal clothes|usual clothes/i);
    });

    // What her last picture showed is a choice on her line, so a one-off is described once and picked after; the
    // outfit or clothes it draws are listed after her name, so the pick is the story compared with them, never a memory.
    it('MUTATION TARGET — "same-as-last-picture" is offered by <reply_cast>, as what she wore in her last picture', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/a choice on the ON FILE line in <reply_cast> that names THAT character: an outfit on file draws those stored clothes; "same-as-last-picture", when <reply_cast> offers it for them, draws what they wore in their last picture, the outfit or clothes it lists after their name — pick it only while the story still has them in those clothes\./);
    });

    // An observation of its own story, never a comparison with outfits it cannot see.
    it('MUTATION TARGET — "newclothes" is clothes that none of their choices are', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/"newclothes" — they wear clothes that none of those choices are: the story changed their clothes, or they have no ON FILE line/);
    });

    // The ON FILE list is scoped by mention: a character brought back after a gap is off it while the narrator
    // remembers her, and an outfit= copied from earlier replies draws her with no clothes.
    it('MUTATION TARGET — whoever the ON FILE list leaves out has nothing on file, however familiar', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/whoever the list leaves out has nothing on file, however often the story has met them before\./);
    });

    // A state is no change: an explicit beat keeps the outfit it has and states the exposure in the
    // composition, as the explicit block's EXPOSURE rule asks.
    it('MUTATION TARGET — a state of the clothes changes nothing', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/outfit= names WHICH clothes, never how they sit right now: pushed up, torn or soaked is still the same outfit, and the \[Composition\] states it\./);
    });

    // ONE HOME FOR THE RECORD: this block names the value and points at the record; ONE_OFF_CLOTHES_ASK, printed
    // inside <reply_cast> beside the records it goes on, is the only place the record is spelled.
    it('MUTATION TARGET — points to the record <reply_cast> asks for, never spelling it here', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/It draws the clothes on their record, as <reply_cast> asks/);
        expect(OUTFIT_RULES_PROMPT).not.toContain('clothes="');
        expect(OUTFIT_RULES_PROMPT).not.toMatch(/<cast\b/);
    });

    // The code reads a value by its exact words, and no code can recognise every language's word for "undressed".
    // MUTATION TARGET: drop the line and a narrator writing in another language translates the values.
    it('MUTATION TARGET — every value is written exactly as shown, in English, whatever the story\'s language', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/written exactly as shown here — in English, whatever language the story is in\. A value it cannot recognise draws the wrong clothes\. Your prose may be in any language\./);
        expect(OUTFIT_RULES_PROMPT).toMatch(/mainchar= works the same way, with the values \[CAST\] lists for \{\{user\}\}\./);
    });

    it('a choice is that character\'s own', () => {
        expect(OUTFIT_RULES_PROMPT).toMatch(/Never a choice from a line that does not name them\./);
        expect(OUTFIT_RULES_PROMPT).not.toContain('"custom"');
    });
});

// Who one reply's pictures draw, in text order — what the worn-outfit store learns from the reply.
describe('drawnPeopleOf — everyone a reply\'s pictures draw, with the outfit each slot wrote', () => {
    it('MUTATION TARGET — each tag\'s slots in order, tag after tag', () => {
        expect(drawnPeopleOf([
            '<pic char="Mitsuki" outfit="newclothes" char2="Yuki" prompt="x">',
            '<pic char="Yuki" outfit="school-gym" prompt="y">',
        ])).toEqual([{ name: 'Mitsuki', outfit: 'newclothes' }, { name: 'Yuki', outfit: '' }, { name: 'Yuki', outfit: 'school-gym' }]);
    });

    // He never has a record, so his outfit is all a picture tells about him — under his entry's key.
    it('MUTATION TARGET — the main character joins under his entry\'s key, and only when the card names one', () => {
        const tag = '<pic char="Mitsuki" mainchar="school-uniform" prompt="x">';
        expect(drawnPeopleOf([tag], 'Mainchar')).toEqual([{ name: 'Mitsuki', outfit: '' }, { name: 'Mainchar', outfit: 'school-uniform' }]);
        expect(drawnPeopleOf([tag])).toEqual([{ name: 'Mitsuki', outfit: '' }]);
        expect(drawnPeopleOf(['<pic char="Mitsuki" prompt="x">'], 'Mainchar')).toEqual([{ name: 'Mitsuki', outfit: '' }]);
    });

    it('nothing drawn ⇒ nobody', () => {
        expect(drawnPeopleOf([])).toEqual([]);
        expect(drawnPeopleOf(null)).toEqual([]);
    });
});

describe('isLastPictureOf — which picture of a reply is a person\'s last (D39)', () => {
    const tags = [
        '<pic char="Mitsuki" outfit="newclothes" prompt="a" mainchar="not-in-picture">',
        '<pic char="Yuki" outfit="school-gym" prompt="b" mainchar="town-casual">',
        '<pic char="美月" outfit="school-uniform" prompt="c" mainchar="not-in-picture">',
    ];
    const isMitsuki = (name) => name === 'Mitsuki' || name === '美月';

    it('MUTATION TARGET — a later tag drawing her under an alias ends it', () => {
        expect(isLastPictureOf(tags, tags[0], isMitsuki)).toBe(false);
        expect(isLastPictureOf(tags, tags[2], isMitsuki)).toBe(true);
        expect(isLastPictureOf(tags, tags[0], (name) => name === 'Yuki')).toBe(false);
        expect(isLastPictureOf(tags, tags[1], (name) => name === 'Yuki')).toBe(true);
    });

    it('MUTATION TARGET — the main character counts through mainchar= under his entry\'s key', () => {
        const isHim = (name) => name === 'Critblade';
        expect(isLastPictureOf(tags, tags[0], isHim, 'Critblade')).toBe(false);
        expect(isLastPictureOf(tags, tags[1], isHim, 'Critblade')).toBe(true);
    });

    it('a tag the reply no longer holds is nobody\'s last picture', () => {
        expect(isLastPictureOf(tags, '<pic char="Mitsuki" prompt="gone">', isMitsuki)).toBe(false);
        expect(isLastPictureOf(null, tags[0], isMitsuki)).toBe(false);
    });
});

// A card-declared stat_data path, read: the intimacy latch.
describe('resolveStatPath — a card-declared dot-path under stat_data', () => {
    const sd = { World: { Date: ['2026-04-13', 'the civil date'], Day: 7, Log: ['a', 'b', 'c'] }, Flags: { Intimate: false } };

    it('MUTATION TARGET — walks the path, a leading "stat_data." allowed, a [value, "label"] tuple unwrapped', () => {
        expect(resolveStatPath(sd, 'World.Date')).toBe('2026-04-13');
        expect(resolveStatPath(sd, ' stat_data.World.Day ')).toBe(7);
        expect(resolveStatPath(sd, 'Flags.Intimate')).toBe(false);
    });

    it('an index reads into an array, and a tuple indexed explicitly is not unwrapped again', () => {
        expect(resolveStatPath(sd, 'World.Log[1]')).toBe('b');
        expect(resolveStatPath(sd, 'World.Date[0]')).toBe('2026-04-13');
    });

    it('a blank or missing path reads nothing', () => {
        expect(resolveStatPath(sd, '')).toBeUndefined();
        expect(resolveStatPath(sd, 'World.Nope.Deeper')).toBeUndefined();
        expect(resolveStatPath(sd, 'World.Day.Deeper')).toBeUndefined();
        expect(resolveStatPath(null, 'World.Date')).toBeUndefined();
    });
});

// The names a reply draws in a one-off: harvest lets nothing written about them that reply replace
// clothes on file.
describe('oneOffNamesOf — who a reply draws in a one-off', () => {
    it('MUTATION TARGET — every slot whose outfit is "newclothes", each name once, as written', () => {
        const tags = [
            '<pic char="Mitsuki" outfit="newclothes" char2="Mana" outfit2="school-uniform" prompt="x">',
            '<pic char="Ann" outfit="school-gym" char2="mitsuki" outfit2="NewClothes" prompt="y">',
            '<pic char="Mana" outfit="newclothes" prompt="z">',
        ];
        expect(oneOffNamesOf(tags)).toEqual(['Mitsuki', 'Mana']);
    });

    it('nothing drawn in a one-off ⇒ nobody', () => {
        expect(oneOffNamesOf(['<pic char="A" outfit="default" prompt="x">', '<pic char="B" prompt="y">'])).toEqual([]);
        expect(oneOffNamesOf(null)).toEqual([]);
    });
});

describe('ONE_OFF_CLOTHES_ASK — the one-off record, asked for inside <reply_cast>', () => {
    it('a one-off is written on the <cast> record', () => {
        expect(ONE_OFF_CLOTHES_ASK).toContain('<cast name="their name" outfit="newclothes" clothes="');
    });

    // <outfit_rules> defines the value; the ask only follows it, and never brings back a comparison with
    // outfits the narrator cannot see.
    it('MUTATION TARGET — asked by the slot\'s value, never by comparing with what is on file', () => {
        expect(ONE_OFF_CLOTHES_ASK).toMatch(/whose slot says outfit="newclothes"/);
        expect(ONE_OFF_CLOTHES_ASK).not.toMatch(/not one of their outfits/i);
    });

    // The story changed the clothes, so the record carries the story's clothes — never a group's uniform
    // or a job's working clothes the story took them out of.
    it('MUTATION TARGET — the clothes are the ones the story has them in, completed, never contradicting it', () => {
        expect(ONE_OFF_CLOTHES_ASK).toMatch(/The clothes are the ones the story has them in now/);
        expect(ONE_OFF_CLOTHES_ASK).toMatch(/completed so nothing they wear is left unsaid, and never contradicting it/);
        expect(ONE_OFF_CLOTHES_ASK).not.toMatch(/uniform|working clothes/i);
        expect(ONE_OFF_CLOTHES_ASK).not.toMatch(/student|school/i);
    });

    // The store keeps it and her ON FILE line offers it back, so after the reply that describes it the one-off is
    // picked by name — never described again every reply.
    it('MUTATION TARGET — every "newclothes" comes with the record, and the replies after it pick "same-as-last-picture"', () => {
        expect(ONE_OFF_CLOTHES_ASK).toMatch(/Every "newclothes" comes with this record; in the replies after it, ON FILE offers these clothes as "same-as-last-picture"\./);
        expect(ONE_OFF_CLOTHES_ASK).not.toMatch(/leave outfit= out|left out|writes it again|every reply/);
    });

    it('lands INSIDE <reply_cast>, ahead of its record format rules', () => {
        const block = replyCastInstruction([{ key: 'A', variants: ['default'] }], [ONE_OFF_CLOTHES_ASK]);
        const ask = block.indexOf('outfit="newclothes" clothes="');
        expect(ask).toBeGreaterThan(block.indexOf('<reply_cast>'));
        expect(ask).toBeLessThan(block.indexOf('Record format:'));
        expect(ask).toBeLessThan(block.indexOf('</reply_cast>'));
    });

    // A one-off's clothes feed the image model like a newcomer's look, so they are asked in English too. The rule lives in
    // the format rules every record ask carries, never in one ask: kept in the look text alone, it never reaches a
    // narrator whose looks a POST call registers, and that narrator writes a one-off in the story's language.
    // MUTATION TARGET: take the line out of CAST_RECORD_FORMAT_RULES and every prompt below fails.
    it('MUTATION TARGET — every prompt that asks for a record asks its body= and clothes= in English', () => {
        const english = 'When a record carries body= or clothes=, those values are English danbooru tags, whatever language the story is in';
        const prompts = {
            "the narrator's <reply_cast>, asking for the one-off": replyCastInstruction([{ key: 'A', variants: ['default'] }], [ONE_OFF_CLOTHES_ASK]),
            "the reader's picture contract": readerPictureContract({ onFile: 'ON FILE — A: default' }),
            'registration on the narrator, storing': narrateRegistrationContract({ isStoring: true }),
            'registration on the narrator, dressing the pictures': narrateRegistrationContract({ isStoring: false }),
            'registration on a POST call, a newcomer': readerRegistrationContract({ newcomers: ['B'] }),
            'registration on a POST call, registered only': readerRegistrationContract({ registered: [{ names: ['A'], outfits: ['default'], allowUpdate: false, clothes: {} }] }),
        };
        for (const [name, text] of Object.entries(prompts)) expect(text, name).toContain(english);
        expect(REGISTRATION_NAME_RULES).not.toMatch(/English|danbooru/);
    });
});

// The ask follows <outfit_rules>: sent on exactly the narrator's prompts that carry the <pic> contract (Tags only
// included), never on a prompt that only stores looks — there the value is not taught, and the ask would
// name a word the narrator was never given — and never to the narrator while a POST call writes the pictures.
describe('castRecordAsks — when the pictures ask for the one-off record', () => {
    it('MUTATION TARGET — asked while the <pic> contract is sent, in every Insert Type that sends it', () => {
        for (const insertType of [INSERT_TYPE.TAGS_ONLY, INSERT_TYPE.INLINE, INSERT_TYPE.NEW_MESSAGE, INSERT_TYPE.REPLACE]) {
            expect(castRecordAsks(imageDuties({ insertType, route: 'predefined', via: '' })), insertType).toEqual([ONE_OFF_CLOTHES_ASK]);
        }
    });

    it('MUTATION TARGET — not asked when images are off, even while looks are stored', () => {
        const storingOnly = imageDuties({ insertType: INSERT_TYPE.DISABLED, route: 'harvest', via: 'post' });
        expect(storingOnly.needsReplyCast).toBe(true);
        expect(castRecordAsks(storingOnly)).toEqual([]);
        expect(castRecordAsks(imageDuties({ insertType: INSERT_TYPE.DISABLED }))).toEqual([]);
    });

    it('MUTATION TARGET — not asked of the narrator while a POST call writes the pictures', () => {
        for (const insertType of [INSERT_TYPE.TAGS_ONLY, INSERT_TYPE.REPLACE]) {
            expect(castRecordAsks(imageDuties({ insertType, route: 'harvest', via: 'POST1', picturesVia: 'POST2' })), insertType).toEqual([]);
        }
    });

    it('no duties ⇒ nothing asked', () => {
        expect(castRecordAsks(undefined)).toEqual([]);
        expect(castRecordAsks(null)).toEqual([]);
    });
});

describe('SCENE_ROSTER_PROMPT — who is on screen, never who is on file', () => {
    it('says the list is presence, and points to the ON FILE list for the rest', () => {
        expect(SCENE_ROSTER_PROMPT).toMatch(/This list says who is ON SCREEN, not who is ON FILE/);
        expect(SCENE_ROSTER_PROMPT).toContain('<reply_cast>');
        expect(SCENE_ROSTER_PROMPT).not.toMatch(/not on the list has no registered outfits/i);
    });

    // <reply_cast> is the roster's, sent whenever the image contract is (imageDuties: needsReplyCast is
    // true whenever sendsImageContract is), so this reference is never to a block that is absent.
    it('MUTATION TARGET — the block it points at is always sent with it', () => {
        for (const type of Object.values(INSERT_TYPE)) {
            for (const route of ['predefined', 'harvest']) {
                for (const via of ['', 'narrate', 'POST2']) {
                    for (const picturesVia of ['narrate', 'POST3']) {
                        const d = imageDuties({ insertType: type, route, via, picturesVia });
                        if (d.sendsImageContract) expect(d.needsReplyCast).toBe(true);
                    }
                }
            }
        }
    });
});
