/**
 * MVU Helper — the LOG-TAG gate: every line mvu-helper prints names its source, structurally.
 *
 *   [mvu-helper] [<source>] [<sub-tag>]… message
 *
 * WHY A TEST AND NOT A HABIT: before this gate (2026-10-03) ~350 of ~600 log calls were off that
 * pattern — `image gen: …`, `[MVU_Event_Pack] …`, untagged lines, a raw `[mvu-squad]` prefix that
 * skipped `[mvu-helper]` — because every tag was hand-typed into its message and nothing checked it.
 * The tags now come from createModuleLog (sillytavern/log.js); this gate keeps them from being typed
 * again. It scans mvu-helper's OWN src/ only: card and engine authors are offered MvuHelper.log, never
 * held to it.
 *
 * THE FOUR RULES
 *   1. No `console.*` call outside sillytavern/log.js — a raw call skips the `[mvu-helper]` prefix and
 *      every gate. Text INSIDE a string is not a call: mvu-bootstrap writes a script for TavernHelper to
 *      run, and that script, with no createModuleLog to reach, types its own `[mvu-helper] [mvu-bootstrap]`.
 *   2. No file imports a bare logger from log.js — only createModuleLog, so a line cannot lack its source.
 *   3. createModuleLog is called with THIS file's source: its feature folder, or its host/shared file
 *      name without `-core`, or `startup` for src/index.js. Two relay sites print text mvu-helper did not
 *      write, under the name of who did: `card` (src/index.js — MvuHelper.log on the page) and
 *      `engine:<scope>` (engine-worker-host.js — engine text from the Worker).
 *   4. No message opens with a hand-typed tag — `[x] …` or `word: …`. A sub-tag is .child('x').
 *   5. A line about ONE small-llm call carries that call as its tag — .child(callLogLabel(call)), and
 *      its stage below it: `[small-llm] [<call>] [SIM] …`, `[small-llm] [<call>] [TEST] …` — never the
 *      call's name in its text (`call "${label}"`, `"${label}": …`, `[${label}]`). Phase-wide lines carry
 *      [PRE]/[POST]. With the name typed into the text, a call's input and its output printed under
 *      different tags (2026-10-03 live: `[small-llm] user: …` next to `[small-llm] [PRE] estimate …`).
 *      Scoped to features/small-llm: the names are matched by the variables a call travels under there.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly, jsFilesUnder } from './code-scan.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const LOG_JS = path.join('sillytavern', 'log.js');

export function expectedSource(relativePath) {
    const parts = relativePath.split(path.sep);
    if (relativePath === 'index.js') return 'startup';
    if (parts[0] === 'features') return parts[1];
    return parts[parts.length - 1].replace(/\.js$/, '').replace(/-core$/, '');
}

// The relay sites (rule 3): what they print was written by someone else.
const RELAY_SOURCES = {
    'index.js': [/^createModuleLog\('card'\)$/],
    [path.join('features', 'logic-engine', 'engine-worker-host.js')]: [/^createModuleLog\(`engine:\$\{[^}]+\}`\)$/],
};

// The first argument of a log method call, when it is a literal: log.warn('…'), log.child('X').warn(`…`),
// log.child(callLogLabel(c, calls)).warn(…) (one level of nested parentheses inside child), and
// log.domain('name', 'level', '…').
const CHILD_CHAIN = String.raw`(?:\.child\((?:[^()]|\([^()]*\))*\))*`;
const MESSAGE_RE = new RegExp(String.raw`\b\w*[lL]og` + CHILD_CHAIN + String.raw`\.(?:error|warn|lifecycle|verbose|trace)\(\s*([\`'"])((?:\\.|(?!\1)[^\\])*)\1`, 'g');
const DOMAIN_MESSAGE_RE = new RegExp(String.raw`\b\w*[lL]og` + CHILD_CHAIN + String.raw`\.domain\(\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*([\`'"])((?:\\.|(?!\1)[^\\])*)\1`, 'g');
const CALL_NAMED_IN_TEXT = /\bcall "\$\{|\$\{\s*(?:label|o\.label|call\.name|c\.name|callLogLabel\([^)]*\))\s*\}/;
const SMALL_LLM = path.join('features', 'small-llm') + path.sep;
const TYPED_TAG = /^\s*(?:\[[^\]]*\]|[A-Za-z][\w.-]*:\s)/;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

describe('log-tag gate — every line names its source, structurally', () => {
    const files = jsFilesUnder(SRC);

    it('finds the source tree (a passing scan of zero files would be a lie)', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('rule 1: no console.* call outside sillytavern/log.js', () => {
        const violations = [];
        for (const file of files) {
            const relative = path.relative(SRC, file);
            if (relative === LOG_JS) continue;
            const code = codeOnly(readFileSync(file, 'utf8'));
            for (const m of code.matchAll(/\bconsole\s*\.\s*\w+\s*\(/g)) violations.push(`${relative}:${lineOf(code, m.index)}`);
        }
        expect(violations).toEqual([]);
    });

    it('rule 2: no file imports a bare logger from log.js — only createModuleLog', () => {
        const violations = [];
        for (const file of files) {
            const relative = path.relative(SRC, file);
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/log\.js['"]/g)) {
                const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
                const bare = names.filter((n) => n !== 'createModuleLog' && n !== 'LOG_DOMAINS');
                if (bare.length) violations.push(`${relative}: imports ${bare.join(', ')}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('rule 3: createModuleLog names THIS file\'s source (or a relay site\'s writer)', () => {
        const violations = [];
        let calls = 0;
        for (const file of files) {
            const relative = path.relative(SRC, file);
            if (relative === LOG_JS) continue;
            const text = readFileSync(file, 'utf8');
            const code = codeOnly(text);
            for (const m of code.matchAll(/\bcreateModuleLog\s*\(/g)) {
                if (/import\s*\{[^}]*$/.test(code.slice(Math.max(0, m.index - 200), m.index))) continue;
                calls++;
                const close = text.indexOf(')', m.index);
                const call = text.slice(m.index, close + 1).replace(/\s+/g, '');
                if (call === `createModuleLog('${expectedSource(relative)}')`) continue;
                if ((RELAY_SOURCES[relative] || []).some((re) => re.test(call))) continue;
                violations.push(`${relative}:${lineOf(text, m.index)}  ${call}  (expected createModuleLog('${expectedSource(relative)}'))`);
            }
        }
        expect(calls).toBeGreaterThan(60);
        expect(violations).toEqual([]);
    });

    it('rule 4: no message opens with a hand-typed tag — a sub-tag is .child()', () => {
        const violations = [];
        for (const file of files) {
            const relative = path.relative(SRC, file);
            if (relative === LOG_JS) continue;
            const text = readFileSync(file, 'utf8');
            for (const re of [MESSAGE_RE, DOMAIN_MESSAGE_RE]) {
                for (const m of text.matchAll(re)) {
                    if (TYPED_TAG.test(m[2])) violations.push(`${relative}:${lineOf(text, m.index)}  ${m[2].slice(0, 70)}`);
                }
            }
        }
        expect(violations).toEqual([]);
    });
});

describe('log-tag gate — rule 5', () => {
    it('rule 5: a line about one small-llm call carries the call as its tag, never its name in the text', () => {
        const violations = [];
        let messages = 0;
        for (const file of jsFilesUnder(SRC)) {
            const relative = path.relative(SRC, file);
            if (!relative.startsWith(SMALL_LLM)) continue;
            const text = readFileSync(file, 'utf8');
            for (const re of [MESSAGE_RE, DOMAIN_MESSAGE_RE]) {
                for (const m of text.matchAll(re)) {
                    messages++;
                    if (CALL_NAMED_IN_TEXT.test(m[2])) violations.push(`${relative}:${lineOf(text, m.index)}  ${m[2].slice(0, 70)}`);
                }
            }
        }
        expect(messages).toBeGreaterThan(80);
        expect(violations).toEqual([]);
    });
});

describe('log-tag gate — the scanner itself', () => {
    it('blanks comments and string contents but keeps code (a scanner that erased everything would pass anything)', () => {
        const scanned = codeOnly("console.log(1); // console.warn(2)\nconst s = 'console.error(3)';\n/* console.info(4) */ x();\n");
        expect(scanned).toContain('console.log(1)');
        expect(scanned).not.toContain('console.warn');
        expect(scanned).not.toContain('console.error');
        expect(scanned).not.toContain('console.info');
        expect(scanned).toContain('x();');
    });
    it('a regex literal holding a quote does not desync the scan', () => {
        const scanned = codeOnly('const re = /"x/; console.log(1);\n');
        expect(scanned).toContain('console.log(1)');
    });
    it('maps files to their source the way the header says', () => {
        expect(expectedSource('index.js')).toBe('startup');
        expect(expectedSource(path.join('features', 'logic-engine', 'turn-runner.js'))).toBe('logic-engine');
        expect(expectedSource(path.join('sillytavern', 'tavern-regex-core.js'))).toBe('tavern-regex');
        expect(expectedSource(path.join('shared', 'card-artifact-library.js'))).toBe('card-artifact-library');
    });
    it('sees a message behind a child() whose argument is itself a call', () => {
        const line = "log.child(callLogLabel(c, calls)).warn(`call \"${c.name}\" failed`);";
        const found = [...line.matchAll(MESSAGE_RE)].map((m) => m[2]);
        expect(found).toEqual(['call "${c.name}" failed']);
        expect(CALL_NAMED_IN_TEXT.test('call "${label}" timed out')).toBe(true);
        expect(CALL_NAMED_IN_TEXT.test('"${label}": no changes this turn')).toBe(true);
        expect(CALL_NAMED_IN_TEXT.test('EJS render failed for [${label}]')).toBe(true);
        expect(CALL_NAMED_IN_TEXT.test('TEST "${call.name}" output:')).toBe(true);
        expect(CALL_NAMED_IN_TEXT.test('the call timed out')).toBe(false);
        expect(CALL_NAMED_IN_TEXT.test('the state at ${path} is missing')).toBe(false);
    });
    it('spots both typed-tag shapes and passes an ordinary sentence', () => {
        expect(TYPED_TAG.test('[RES] fired')).toBe(true);
        expect(TYPED_TAG.test('harvest: skipped')).toBe(true);
        expect(TYPED_TAG.test('could not read the file: ENOENT')).toBe(false);
        expect(TYPED_TAG.test('${key}: applied')).toBe(false);
    });
});
