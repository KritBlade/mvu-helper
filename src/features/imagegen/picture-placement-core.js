// imagegen/picture-placement-core.js — PURE: the pictures a POST call writes, placed by line number
// (plans/executed/picture-writer-route.md D4, D6). No ST imports, no logger; tested by tests/picture-placement-core.test.js.
//
// The call reads the finished reply with every line of text numbered and writes each picture as
// `<pic … at="<line number>">`. mvu-helper keeps the numbered copy, and when the call's output comes back it finds
// each numbered line in the message as it is then and puts the tag on its own line under it.

import { tagAttr } from './default-template.js';
// DEEP IMPORT, deliberate: the character-roster barrel pulls in SillyTavern host modules, which cannot load under
// vitest, and this file is pure. cast-record-format-core.js is that feature's pure half and the one definition of a
// cast record.
import { CAST_RECORD_PATTERN } from '../character-roster/cast-record-format-core.js';
import { OUTFIT_NEW_CLOTHES } from '../character-roster/dna-core.js';

// Every tag on a line, for "does this line hold any text": a story line keeps its text when its markup is stripped.
const ANY_TAG_RE = /<[^<>]*>/g;

// A line's text with its tags stripped and its ends trimmed — what a numbered line is, and what a placement
// matches against the message.
export function lineTextOf(line) {
    return String(line == null ? '' : line).replace(ANY_TAG_RE, '').trim();
}

// The reply as the picture call reads it: every line that still has text once its tags are stripped is prefixed
// "[n] ", counted from 1; a line holding only tags or whitespace gets no number. Returns the numbered text and each
// numbered line's text (`lines[n - 1]`), which the placement matches against the message later.
export function numberReplyLines(text) {
    const lines = [];
    const numbered = String(text == null ? '' : text).split('\n').map((line) => {
        const bare = lineTextOf(line);
        if (!bare) return line;
        lines.push(bare);
        return `[${lines.length}] ${line}`;
    });
    return { text: numbered.join('\n'), lines };
}

// The line a tag's at= names, against `lineCount` numbered lines: { line, problem, written }. problem is '' or why the
// tag cannot be placed — 'no-at', 'not-a-number', 'out-of-range'.
export function pictureLineOf(rawTag, lineCount) {
    const written = tagAttr(rawTag, 'at');
    if (!written) return { line: 0, problem: 'no-at', written };
    if (!/^\d+$/.test(written)) return { line: 0, problem: 'not-a-number', written };
    const line = Number(written);
    if (line < 1 || line > lineCount) return { line, problem: 'out-of-range', written };
    return { line, problem: '', written };
}

// Where numbered line `line` (1-based, of `copyLines`) stands in the message now: the index of the message line whose
// text, tags stripped, equals it — the k-th equal line in the copy is the k-th equal line in the message. On text,
// never an offset: galgame's beat-shaper may rewrite the message after the call read it (the envelope renamed, lines
// wrapped in <p>, its roll line added). -1 when the message no longer holds that line.
export function messageLineIndexOf(messageLines, copyLines, line) {
    const text = copyLines[line - 1];
    let occurrence = 0;
    for (let i = 0; i < line; i++) if (copyLines[i] === text) occurrence++;
    let seen = 0;
    for (let i = 0; i < messageLines.length; i++) {
        if (lineTextOf(messageLines[i]) !== text) continue;
        seen++;
        if (seen === occurrence) return i;
    }
    return -1;
}

// The records a picture call may add to the reply: one-off clothes (outfit="newclothes"), the only kind it is asked
// for. Any other record it writes is left out — the narrator's records already name everyone present.
export function oneOffClothesRecords(records) {
    return (Array.isArray(records) ? records : [])
        .filter((record) => String((record && record.attributes && record.attributes.outfit) || '').trim().toLowerCase() === OUTFIT_NEW_CLOTHES);
}

// A placed tag carries no at=: the drawing, the regenerate button and the worn-outfit store read it as any <pic>.
export function withoutLineNumber(rawTag) {
    return String(rawTag).replace(/\s+at\s*=\s*"[^"]*"/i, '');
}

/**
 * The pictures a POST call wrote, placed into the message (D6), PURE. Each tag, its at= removed, goes on its own line
 * under the message line its at= names, in the call's order; the call's clothes `records` (raw record strings) go
 * after the narrator's last record, else at the end, so every reader of a reply's records finds them as it finds the
 * narrator's — and the narrator's, read first, keep their values.
 * @returns {{text: string, placed: {tag: string, line: number, lineText: string}[], misses: {rawTag: string, cause: string, written: string}[]}}
 *   text is the message unchanged when no tag could be placed.
 */
export function placePictures(messageText, { copyLines = [], rawTags = [], records = [] } = {}) {
    const original = String(messageText == null ? '' : messageText);
    const lines = original.split('\n');
    const under = new Map();
    const placed = [];
    const misses = [];
    for (const rawTag of rawTags) {
        const at = pictureLineOf(rawTag, copyLines.length);
        if (at.problem) { misses.push({ rawTag, cause: at.problem, written: at.written }); continue; }
        const index = messageLineIndexOf(lines, copyLines, at.line);
        if (index < 0) { misses.push({ rawTag, cause: 'line-gone', written: at.written }); continue; }
        const tag = withoutLineNumber(rawTag);
        if (!under.has(index)) under.set(index, []);
        under.get(index).push(tag);
        placed.push({ tag, line: at.line, lineText: copyLines[at.line - 1] });
    }
    if (!placed.length) return { text: original, placed, misses };
    let lastRecordLine = -1;
    lines.forEach((line, i) => { CAST_RECORD_PATTERN.lastIndex = 0; if (CAST_RECORD_PATTERN.test(line)) lastRecordLine = i; });
    const out = [];
    lines.forEach((line, i) => {
        out.push(line, ...(under.get(i) || []));
        if (i === lastRecordLine) out.push(...records);
    });
    if (lastRecordLine < 0) out.push(...records);
    return { text: out.join('\n'), placed, misses };
}
