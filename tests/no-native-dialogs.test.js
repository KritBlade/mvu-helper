/**
 * MVU Helper — no native browser dialogs.
 *
 * src/ never calls the browser's confirm(), alert() or prompt(). On the SillyTavern page they open
 * invisibly and block the page thread, freezing generation with no dialog to dismiss. Every question
 * goes through sillytavern/popup.js — confirmPopup, noticePopup, inputPopup — which also answers NO
 * when a dialog cannot open, so a broken popup never reads as consent.
 *
 * Code only: a call inside a comment or a string is not a call (the StatusMenu frame's srcdoc script
 * runs in its own sandboxed document and is a string here).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, jsFilesUnder } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// A bare call, or one on the global object. `obj.confirm(…)` and `myConfirm(…)` are other functions.
const NATIVE_DIALOG_CALL = /(?:^|[^\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?(confirm|alert|prompt)\s*\(/g;

function nativeDialogCalls(code) {
    return [...code.matchAll(NATIVE_DIALOG_CALL)].map((match) => match[1]);
}

describe('native browser dialogs', () => {
    it('no file in src/ calls confirm(), alert() or prompt()', () => {
        const offenders = [];
        for (const file of jsFilesUnder(SRC)) {
            codeOnly(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
                for (const name of nativeDialogCalls(line)) offenders.push(`${path.relative(SRC, file)}:${index + 1} ${name}()`);
            });
        }
        expect(offenders).toEqual([]);
    });

    it('sees a call in code, and ignores one in a comment, a string or on another object', () => {
        const scanned = codeOnly("if (!confirm('x')) return; // alert(1)\nconst s = 'prompt(2)'; obj.confirm(3); window.alert(4); myConfirm(5);\n");
        expect(nativeDialogCalls(scanned)).toEqual(['confirm', 'alert']);
    });
});
