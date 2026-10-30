/**
 * The prompt-claims gate (CLAUDE.md "No absolute position or count in prompt text"): every text mvu-helper hands
 * a model names a position relative to another block and scopes a count to its own instruction. A claim on the
 * whole answer ("nothing else", "your ONLY job", "at the very end", "after every other block") collides with
 * another instruction's claim, and the model silently drops one of the two blocks; even alone, it blocks another
 * extension's or preset's tag. Each text is rendered the way it reaches a model, in every shape it takes.
 */
import { describe, it, expect } from 'vitest';
import {
    narratorPictureRules, readerPictureContract, pictureCountRules, narrateRegistrationContract,
    readerRegistrationContract, ONE_OFF_CLOTHES_ASK,
} from '../src/features/imagegen/default-template.js';
import { sceneRosterText } from '../src/features/imagegen/prompt-assembly-core.js';
import { replyCastInstruction } from '../src/features/character-roster/reply-cast-core.js';
import { CAST_RECORD_FORMAT_RULES } from '../src/features/character-roster/cast-record-format-core.js';
import { buildOocCommandBlock } from '../src/features/small-llm/extra-llm-calls-core.js';

// Phrases that claim a slot in the model's answer, or the whole of it.
const WHOLE_ANSWER_CLAIMS = [
    /\bnothing else\b/i,
    /\bonly (job|task|output)\b/i,
    /\bvery (end|last|first)\b/i,
    /\bat the END\b/,
    /\b(at|to) the end of (your|the) (reply|output|answer|response)\b/i,
    /\b(start|end|close|open|finish) (your|the) (reply|output|answer|response) (with|on)\b/i,
    /\bafter (every|all) other (block|tag)s?\b/i,
    /\bbefore anything else\b/i,
    /\b(tags?|blocks?|anything)\b[^.]{0,30}\bnot listed\b/i,
    /\bexactly one (block|tag)\b/i,
    /\b(last|final|first) block\b/i,
    /\bat the end of this prompt\b/i,
    /\bnear the start of this prompt\b/i,
];

// The one sentence that names ANOTHER instruction's end-of-reply block, in order to yield to it: a relative position.
const YIELDS_TO_ANOTHER = 'The records never take another block\'s place: when another instruction puts its own block at the very end of the reply, write them just before that block.';

const member = (names, outfits, allowUpdate = false, clothes = {}) => ({ names, outfits, allowUpdate, clothes });
const SCENE = sceneRosterText(['Wren', 'Vey']);

const TEXTS = {
    'the narrator\'s picture rules': narratorPictureRules({ maxImages: 3, maxCharactersPerImage: 2, userOutfits: ['flightsuit'], isExplicit: true }),
    'the narrator\'s <picture_count>, one picture': pictureCountRules(1),
    'the narrator\'s <picture_count>, three pictures': pictureCountRules(3),
    'the reader\'s picture contract': readerPictureContract({ maxImages: 3, maxCharactersPerImage: 2, userOutfits: ['flightsuit'], isExplicit: true, scene: SCENE, onFile: 'ON FILE — Wren: default' }),
    'the reader\'s <picture_count>, one picture': pictureCountRules(1, { writer: 'reader' }),
    'registration on the narrator, storing': narrateRegistrationContract({ isStoring: true }),
    'registration on the narrator, dressing the pictures': narrateRegistrationContract({ isStoring: false }),
    'registration on a POST call, nobody to register': readerRegistrationContract({}),
    'registration on a POST call, registered and new': readerRegistrationContract({ registered: [member(['Vey'], ['default'], true, { default: 'grey flightsuit' })], newcomers: ['Wren'] }),
    '<reply_cast>': replyCastInstruction([{ key: 'Vey', variants: ['default'] }], [ONE_OFF_CLOTHES_ASK], ['Captain'], 'grey flightsuit', ['flightsuit']).replace(YIELDS_TO_ANOTHER, ''),
    'the record format': CAST_RECORD_FORMAT_RULES,
    '<ooc_commands>': buildOocCommandBlock(['(OOC: slow the pace down)']),
};

describe('the prompt-claims gate — no text mvu-helper hands a model claims a slot in its answer, or the whole of it', () => {
    for (const [name, text] of Object.entries(TEXTS)) {
        it(`MUTATION TARGET — ${name}`, () => {
            expect(text.length, name).toBeGreaterThan(0);
            for (const claim of WHOLE_ANSWER_CLAIMS) expect(text, `${name}: ${claim}`).not.toMatch(claim);
        });
    }

    it('the one sentence that yields to another block is still in <reply_cast>, word for word', () => {
        expect(replyCastInstruction([])).toContain(YIELDS_TO_ANOTHER);
    });
});
