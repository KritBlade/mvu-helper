/**
 * MVU Helper — one door to the browser's file picker.
 *
 * The settings panel lives in a SillyTavern popup, and the popup closes on any `cancel` event that reaches its
 * <dialog>. Dismissing a file picker fires one at the file input, and it bubbles: an input anywhere in the panel closed
 * the whole panel. So no file input lives in the markup or a renderer; every picker opens through
 * src/shared/pick-files.js, whose input never joins the page.
 *
 * Comments are not uses.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesUnder } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const THE_DOOR = path.join('shared', 'pick-files.js');

// type="file" in markup, or `.type = 'file'` in code.
const FILE_INPUT = /\btype\s*=\s*(["'])file\1/g;

// The source with its comments blanked (HTML comments, block comments, line comments), line breaks kept.
function withoutComments(source) {
    const blank = (match) => match.replace(/[^\n]/g, ' ');
    return source.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, blank);
}

function fileInputs(source) {
    return withoutComments(source).split('\n').flatMap((line, index) => [...line.matchAll(FILE_INPUT)].map(() => index + 1));
}

describe('file picker boundary', () => {
    it('no file input lives in src outside shared/pick-files.js', () => {
        const offenders = [];
        for (const file of filesUnder(SRC, ['.js', '.html'])) {
            const relative = path.relative(SRC, file);
            if (relative === THE_DOOR) continue;
            for (const line of fileInputs(readFileSync(file, 'utf8'))) offenders.push(`${relative}:${line}`);
        }
        expect(offenders).toEqual([]);
    });

    it('sees a file input in markup and in code, and ignores comments', () => {
        const source = '<input type="file" id="a">\n// input.type = "file"\nconst i = x; i.type = \'file\';\n'
            + '<!-- <input type="file"> -->\n/* type="file" */ <input type=\'text\'>\n';
        expect(fileInputs(source)).toEqual([1, 3]);
    });
});
