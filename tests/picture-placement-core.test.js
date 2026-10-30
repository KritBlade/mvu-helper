// picture-placement-core — the pictures a POST call writes, placed by line number (plans/executed/picture-writer-route.md
// D4, D6): the numbered reply the call reads, and where each of its tags lands in the message. Source gates cover
// the host-side lines a unit test cannot open.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { numberReplyLines, lineTextOf, pictureLineOf, messageLineIndexOf, placePictures, withoutLineNumber, oneOffClothesRecords } from '../src/features/imagegen/picture-placement-core.js';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('numberReplyLines — the reply as the picture call reads it', () => {
    it('MUTATION TARGET — every line with text is numbered from 1, in order', () => {
        const { text, lines } = numberReplyLines('She opened the door.\nThe room was dark.');
        expect(text).toBe('[1] She opened the door.\n[2] The room was dark.');
        expect(lines).toEqual(['She opened the door.', 'The room was dark.']);
    });

    it('MUTATION TARGET — a line holding only tags or whitespace gets no number', () => {
        const { text, lines } = numberReplyLines('<gametxt>\n\n   \nShe sat.\n<cast name="Iori" outfit="default">\n</gametxt>');
        expect(text).toBe('<gametxt>\n\n   \n[1] She sat.\n<cast name="Iori" outfit="default">\n</gametxt>');
        expect(lines).toEqual(['She sat.']);
    });

    it('MUTATION TARGET — a numbered line keeps its markup; the kept text is the line with its tags stripped', () => {
        const { text, lines } = numberReplyLines('<p>She <b>smiled</b>.</p>');
        expect(text).toBe('[1] <p>She <b>smiled</b>.</p>');
        expect(lines).toEqual(['She smiled.']);
    });

    it('a Chinese story numbers its lines the same way', () => {
        const { text, lines } = numberReplyLines('「那獎品得在『屋子裡面』才能領取喔。」\n她笑了。');
        expect(text).toBe('[1] 「那獎品得在『屋子裡面』才能領取喔。」\n[2] 她笑了。');
        expect(lines).toEqual(['「那獎品得在『屋子裡面』才能領取喔。」', '她笑了。']);
    });

    it('nothing to read numbers nothing', () => {
        expect(numberReplyLines('')).toEqual({ text: '', lines: [] });
        expect(numberReplyLines(undefined)).toEqual({ text: '', lines: [] });
    });
});

describe('lineTextOf — what a numbered line is', () => {
    it('strips every tag and trims the ends', () => {
        expect(lineTextOf('  <p class="x">Hello <i>there</i></p>  ')).toBe('Hello there');
        expect(lineTextOf('<span class="auto-img-wrap" data-rawtag="&lt;pic&gt;"><span class="auto-img-trace"></span></span>')).toBe('');
    });
});

describe('pictureLineOf — the line a tag names', () => {
    it('MUTATION TARGET — a number within the numbered lines is the line', () => {
        expect(pictureLineOf('<pic at="3" prompt="p">', 5)).toEqual({ line: 3, problem: '', written: '3' });
        expect(pictureLineOf('<pic at="5" prompt="p">', 5).problem).toBe('');
    });

    it('MUTATION TARGET — each reason a tag cannot be placed is named', () => {
        expect(pictureLineOf('<pic prompt="p">', 5).problem).toBe('no-at');
        expect(pictureLineOf('<pic at="" prompt="p">', 5).problem).toBe('no-at');
        expect(pictureLineOf('<pic at="three" prompt="p">', 5)).toMatchObject({ problem: 'not-a-number', written: 'three' });
        expect(pictureLineOf('<pic at="2a" prompt="p">', 5).problem).toBe('not-a-number');
        expect(pictureLineOf('<pic at="0" prompt="p">', 5).problem).toBe('out-of-range');
        expect(pictureLineOf('<pic at="6" prompt="p">', 5).problem).toBe('out-of-range');
    });
});

describe('messageLineIndexOf — the numbered line in the message as it is now', () => {
    const copy = ['She sat.', 'He nodded.', 'She sat.'];

    it('MUTATION TARGET — the k-th equal line in the copy is the k-th equal line in the message', () => {
        const message = ['She sat.', 'He nodded.', 'She sat.'];
        expect(messageLineIndexOf(message, copy, 1)).toBe(0);
        expect(messageLineIndexOf(message, copy, 3)).toBe(2);
    });

    it('MUTATION TARGET — found by its text after galgame rewrote the message (envelope, <p> wrap, a roll line added)', () => {
        const message = ['<maintext>', '<p>She sat.</p>', '<p>🎲 roll: 14</p>', '<p>He nodded.</p>', '<p>She sat.</p>', '</maintext>'];
        expect(messageLineIndexOf(message, copy, 2)).toBe(3);
        expect(messageLineIndexOf(message, copy, 3)).toBe(4);
    });

    it('MUTATION TARGET — a line no longer in the message is -1', () => {
        expect(messageLineIndexOf(['She stood.', 'He nodded.'], copy, 1)).toBe(-1);
        expect(messageLineIndexOf(['She sat.', 'He nodded.'], copy, 3)).toBe(-1);
    });
});

describe('placePictures — the call\'s pictures in the message', () => {
    const copy = ['She opened the door.', 'The room was dark.', 'He lit a candle.'];
    const message = '<gametxt>\nShe opened the door.\nThe room was dark.\nHe lit a candle.\n</gametxt>\n<cast name="Iori">';
    const tagAt = (line, extra = '') => `<pic at="${line}" char="Iori" outfit="newclothes" camera="eye-level" prompt="1girl, standing${extra}" mainchar="not-in-picture">`;
    const tagOf = (extra = '') => `<pic char="Iori" outfit="newclothes" camera="eye-level" prompt="1girl, standing${extra}" mainchar="not-in-picture">`;
    const record = '<cast name="Iori" outfit="newclothes" clothes="red coat">';

    it('MUTATION TARGET — each tag goes on its own line under its line, without at=', () => {
        const res = placePictures(message, { copyLines: copy, rawTags: [tagAt(1), tagAt(3)] });
        expect(res.text).toBe(`<gametxt>\nShe opened the door.\n${tagOf()}\nThe room was dark.\nHe lit a candle.\n${tagOf()}\n</gametxt>\n<cast name="Iori">`);
        expect(res.placed.map((p) => [p.line, p.lineText])).toEqual([[1, 'She opened the door.'], [3, 'He lit a candle.']]);
        expect(res.misses).toEqual([]);
    });

    it('MUTATION TARGET — two tags under one line keep the call\'s order', () => {
        const res = placePictures(message, { copyLines: copy, rawTags: [tagAt(2, ', a'), tagAt(2, ', b')] });
        expect(res.text).toContain(`The room was dark.\n${tagOf(', a')}\n${tagOf(', b')}\nHe lit a candle.`);
    });

    it('MUTATION TARGET — the clothes records go after the narrator\'s last record, else at the end', () => {
        expect(placePictures(message, { copyLines: copy, rawTags: [tagAt(1)], records: [record] }).text.endsWith(`<cast name="Iori">\n${record}`)).toBe(true);
        const bare = 'She opened the door.\nThe room was dark.\nHe lit a candle.';
        expect(placePictures(bare, { copyLines: copy, rawTags: [tagAt(1)], records: [record] }).text).toBe(`She opened the door.\n${tagOf()}\nThe room was dark.\nHe lit a candle.\n${record}`);
        const twoRecords = `${message}\n<cast name="Kei">\nafter`;
        expect(placePictures(twoRecords, { copyLines: copy, rawTags: [tagAt(1)], records: [record] }).text.endsWith(`<cast name="Kei">\n${record}\nafter`)).toBe(true);
    });

    it('MUTATION TARGET — a tag that cannot be placed is reported by cause, and the rest are placed', () => {
        const res = placePictures(message, { copyLines: copy, rawTags: ['<pic prompt="x">', tagAt(9), tagAt(2)] });
        expect(res.misses.map((m) => m.cause)).toEqual(['no-at', 'out-of-range']);
        expect(res.placed).toHaveLength(1);
        const gone = placePictures('She opened the door.\nThe hall was lit.', { copyLines: copy, rawTags: [tagAt(2)] });
        expect(gone.misses.map((m) => m.cause)).toEqual(['line-gone']);
    });

    it('MUTATION TARGET — nothing placed: the message is left as it was, records and all', () => {
        const res = placePictures(message, { copyLines: copy, rawTags: ['<pic prompt="x">'], records: [record] });
        expect(res.text).toBe(message);
        expect(res.placed).toEqual([]);
    });

    it('withoutLineNumber takes at= out and nothing else', () => {
        expect(withoutLineNumber(tagAt(12))).toBe(tagOf());
        expect(withoutLineNumber('<pic char="Kat" prompt="cat">')).toBe('<pic char="Kat" prompt="cat">');
    });
});

// The call's input is shaped in the host-coupled small-llm and router; the order and the hook are gated as SOURCE.
describe('SOURCE GATE — the picture call reads its filtered input with numbered lines', () => {
    it('MUTATION TARGET — the call\'s own input filter runs first, then the tasks it carries shape what is left', () => {
        expect(read('src/features/small-llm/extra-llm-calls.js')).toContain('const userInput = shapeRoutedCallInput(call.name, applyInputFilter(userText, call.inputRegex),');
    });

    it('MUTATION TARGET — only an active task routed to that very call, in that phase, shapes its input', () => {
        const router = read('src/features/llm-task-router/llm-task-router.js');
        const fn = router.slice(router.indexOf('export function shapeRoutedCallInput('), router.indexOf('// Register (or replace) a task.'));
        expect(fn).toContain('if (!task.shapeInput || !safeIsActive(task)) continue;');
        expect(fn).toContain('if (target !== name || resolveTargetPhase(target, calls) !== phase) continue;');
    });

    it('MUTATION TARGET — the picture task numbers the lines, keeps the copy and closes them with <picture_count>', () => {
        const src = read('src/features/imagegen/image-gen.js');
        expect(src).toContain('    shapeInput: pictureCallInput,');
        const fn = src.slice(src.indexOf('function pictureCallInput('), src.indexOf('registerLlmTask({\n    id: PICTURES_TASK_ID'));
        expect(fn).toContain('const numbered = numberReplyLines(text);');
        expect(fn).toContain('numberedPictureCopies.set(Number(messageId), { message, swipe: swipeOf(chat, messageId), lines: numbered.lines });');
        expect(fn).toContain("return readerPictureInput(numbered.text, imageCap(), (block) => expandPromptMacros(block, 'imagegen'));");
    });
});
describe('oneOffClothesRecords — the only records a picture call adds', () => {
    it('MUTATION TARGET — one-off clothes are kept, every other record is left out', () => {
        const records = [
            { name: 'Iori', attributes: { outfit: 'newclothes', clothes: 'red coat' }, raw: 'a' },
            { name: 'Kei', attributes: { outfit: 'NewClothes', clothes: 'grey suit' }, raw: 'b' },
            { name: 'Mio', attributes: { body: 'tall' }, raw: 'c' },
            { name: 'Ren', attributes: { outfit: 'school' }, raw: 'd' },
        ];
        expect(oneOffClothesRecords(records).map((r) => r.raw)).toEqual(['a', 'b']);
        expect(oneOffClothesRecords(undefined)).toEqual([]);
    });
});

// The capture and the draw flow live in the host-coupled image-gen.js, so their load-bearing lines are gated as SOURCE.
describe('SOURCE GATE — the picture call\'s pictures are placed, then drawn by the one draw flow', () => {
    const src = read('src/features/imagegen/image-gen.js');
    const capture = src.slice(src.indexOf('async function onPictureOutput('), src.indexOf('registerLlmTask({\n    id: PICTURES_TASK_ID'));

    it('MUTATION TARGET — a reply swiped, regenerated or deleted while the call ran gets none of its pictures', () => {
        expect(capture).toContain('if (!Array.isArray(chat) || chat[mesId] !== copy.message || swipeOf(chat, mesId) !== copy.swipe) {');
    });

    it('MUTATION TARGET — an answer with no <pic> is said by cause: a call that gave no text, or one that broke the contract', () => {
        const none = capture.slice(capture.indexOf('if (!tags.length) {'), capture.indexOf('const { records } = readCastRecords(rawText);'));
        expect(none).toContain("if (!String(rawText || '').trim()) log.domain('imagegen', 'lifecycle', ");
        expect(none).toContain('gave no text — no picture this reply (a [POST] warning says so when the call failed or timed out)');
        expect(none).toContain('answered without a <pic> — it did not follow the picture contract this reply (no picture)`);');
        expect(none.trimEnd().endsWith('return;\n    }')).toBe(true);
    });

    it('MUTATION TARGET — the tags are placed by the kept copy, in one edit handed to the reply redraw, then drawn', () => {
        expect(capture).toContain('const plan = placePictures(message.mes, { copyLines: copy.lines, rawTags: tags.map((t) => t.rawTag), records: oneOffs.map((r) => r.raw) });');
        expect(capture).toContain('message.mes = plan.text;');
        expect(capture).toContain("redrawReply(message, mesId, 'imagegen picture placement')");
        expect(capture).toContain('await drawReplyTags(message, mesId, callName);');
        const read = capture.indexOf('const plan = placePictures(message.mes');
        expect(capture.slice(read, capture.indexOf('message.mes = plan.text;'))).not.toMatch(/\bawait\b/);
    });

    // The router hands a POST call's output to its tasks in registration order; registration reads the drawn names from
    // the message, so the pictures are placed first (plans/executed/picture-writer-route.md D7).
    it('MUTATION TARGET — the picture task is registered before the look task', () => {
        const pictures = src.indexOf('registerLlmTask({\n    id: PICTURES_TASK_ID');
        const looks = src.indexOf('registerLlmTask({\n    id: CHARIMG_TASK_ID');
        expect(pictures).toBeGreaterThan(-1);
        expect(looks).toBeGreaterThan(pictures);
    });

    it('MUTATION TARGET — at the reply\'s arrival: Disable ignores its tags, a POST writer disposes of them, the narrator\'s are drawn', () => {
        const arrival = src.slice(src.indexOf('async function handleIncomingMessage('), src.indexOf('async function drawReplyTags('));
        expect(arrival).toContain('if (duties.narratorTagAction === NARRATOR_TAG_ACTION.IGNORE) return;');
        expect(arrival).toContain('if (duties.narratorTagAction === NARRATOR_TAG_ACTION.DISPOSE_AS_STRAY) {\n        disposeStrayNarratorTags(message, mesId, duties.pictureCall);\n        warnIfPictureCallCannotRun(duties.pictureCall);\n        return;\n    }');
        expect(arrival).toContain("await drawReplyTags(message, mesId, 'narrate');");
    });

    it('MUTATION TARGET — the one draw flow announces the drawing before its first await', () => {
        const flow = src.slice(src.indexOf('async function drawReplyTags('), src.indexOf('function disposeStrayNarratorTags('));
        const announce = flow.indexOf("announceReplyEdit(message, mesId, { label: 'imagegen draw pass', work: drawn, allowanceMs: pictureWaitMs(tags.length) });");
        expect(announce).toBeGreaterThan(-1);
        expect(flow.slice(0, announce).replace(/\/\/.*$/gm, '')).not.toMatch(/\bawait\b/);
    });

    // A trace records a picture the reply drew (the worn-outfit store and registration read it), so a stray leaves none.
    it('MUTATION TARGET — a stray narrator tag is taken out whole, with no trace, synchronously', () => {
        const strays = src.slice(src.indexOf('function disposeStrayNarratorTags('), src.indexOf('const pictureCallToastedChats'));
        expect(strays).toContain('const res = removeTagsPinpoint(message.mes, strays);');
        expect(strays).not.toMatch(/disposeLeftoverPicTags|replaceTagsWithTraces|buildTagTraceWrap/);
        expect(strays).not.toMatch(/\bawait\b/);
    });

    it('MUTATION TARGET — a picture call that does not run is said, never handed back to the narrator', () => {
        const warn = src.slice(src.indexOf('function warnIfPictureCallCannotRun('), src.indexOf('// What the draw pass does with each tag'));
        expect(warn).toContain('if (isTaskTargetAvailable(PICTURES_TASK_ID)) return;');
        expect(warn).toContain("toast('warning', ");
    });
});
