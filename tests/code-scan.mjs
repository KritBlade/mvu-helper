// code-scan.mjs — what the source-scanning gates share: the list of src/ files, and a copy of a file
// with everything that is not code blanked out.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Every file under `dir`, recursively, whose name ends with one of `extensions` ('.js', '.css', …).
export function filesUnder(dir, extensions) {
    const found = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) found.push(...filesUnder(full, extensions));
        else if (extensions.some((extension) => name.endsWith(extension))) found.push(full);
    }
    return found;
}

// Every .js file under `dir`, recursively.
export function jsFilesUnder(dir) {
    return filesUnder(dir, ['.js']);
}

// Blank comments AND the contents of string/template/regex literals (quotes kept, line breaks kept),
// so a scan sees code only and its line numbers still match the file. Regex literals get their own
// state: an odd quote inside a pattern would otherwise desync the scan.
const REGEX_MAY_START_AFTER = '(,=:[!&|?{};+-*%~^<>';
export function codeOnly(source) {
    const out = [];
    let state = null;
    let prevMeaningful = '';
    for (let i = 0; i < source.length; i++) {
        const c = source[i], next = source[i + 1];
        if (state === null) {
            if (c === '/' && next === '/') { state = '//'; out.push('  '); i++; continue; }
            if (c === '/' && next === '*') { state = '/*'; out.push('  '); i++; continue; }
            if (c === '/' && (prevMeaningful === '' || REGEX_MAY_START_AFTER.includes(prevMeaningful))) state = '/re';
            else if (c === '"' || c === "'" || c === '`') state = c;
            if (!/\s/.test(c)) prevMeaningful = c;
            out.push(c);
        } else if (state === '/re') {
            if (c === '\\') { out.push(' ', ' '); i++; continue; }
            out.push(c === '\n' ? '\n' : ' ');
            if (c === '/' || c === '\n') { state = null; prevMeaningful = c; out[out.length - 1] = c; }
        } else if (state === '//') {
            if (c === '\n') { state = null; out.push(c); } else out.push(' ');
        } else if (state === '/*') {
            if (c === '*' && next === '/') { state = null; i++; out.push('  '); continue; }
            out.push(c === '\n' ? '\n' : ' ');
        } else {
            if (c === '\\') { out.push(' ', ' '); i++; continue; }
            if (c === state) { state = null; out.push(c); continue; }
            out.push(c === '\n' ? '\n' : ' ');
        }
    }
    return out.join('');
}
