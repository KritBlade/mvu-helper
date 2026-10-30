// tools/check-error-handling.mjs — no catch in src/ may throw its error away in silence.
//
// WHY THIS EXISTS: a caught error that is neither logged, re-thrown, nor handed back to a caller is
// invisible — the operation just returns a wrong-but-plausible value and the real cause is gone. The
// cost is not paid at the catch, it is paid hours later by whoever is hunting the symptom.
//
// A catch passes this check by doing ONE of:
//   • logging it            — log.error / log.warn / log.lifecycle / log.verbose / log.trace / log.domain
//   • re-throwing           — the caller decides
//   • using the error       — any reference to the bound name: returned in `{ ok: false, error }`,
//                             pushed onto an `errors` array, interpolated into a message. The return
//                             value IS the surfacing, and it is visible at the call site.
//   • reporting it          — an injected onError / report* hook, for pure files with no logger
//   • declaring it EXPECTED — `// EXPECTED: <why it is safe>`, inside the block, trailing its closing
//                             brace, or in the three lines above it. This is the escape hatch for a
//                             throw that is genuinely routine and benign, and it is deliberately a
//                             SENTENCE: the next reader has to be told why, not just that.
//
// A bare `catch { }` with no binding can never reference the error, so it must log, re-throw, or
// carry an EXPECTED line.
//
// Promise `.catch(handler)` is judged the same way and by the same rules — `.catch(() => null)` is a
// swallow wearing different syntax. A handler passed by NAME (`.catch(reportIt)`) is taken as
// delegated: the rules apply where that function is written.
//
// SCOPE AND BLIND SPOTS, honestly: this reads text, not syntax. It sees `catch` inside a template
// literal (the engine Worker's source string) as real code, which it is. It cannot tell whether an
// EXPECTED sentence is TRUE — only that someone wrote one. It judges one catch block at a time and
// will not notice an error surfaced two frames up by other means.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const fp = path.join(dir, name);
        if (statSync(fp).isDirectory()) walk(fp);
        else if (name.endsWith('.js')) files.push(fp);
    }
})(root);

/** The catch block's own text, by brace matching from its opening brace. */
function catchBody(lines, lineIndex, fromColumn) {
    const text = lines.slice(lineIndex, lineIndex + 40).join('\n');
    const start = text.indexOf('{', fromColumn);
    if (start < 0) return { body: '', endOffset: fromColumn };
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) return { body: text.slice(start + 1, i), endOffset: i };
        }
    }
    return { body: text.slice(start + 1), endOffset: text.length };
}

/** A promise handler's argument list, by paren matching from its opening paren. */
function handlerArgument(lines, lineIndex, fromColumn) {
    const text = lines.slice(lineIndex, lineIndex + 40).join('\n');
    let depth = 0;
    for (let i = fromColumn; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') {
            depth--;
            if (depth === 0) return { argument: text.slice(fromColumn + 1, i), endOffset: i };
        }
    }
    return { argument: text.slice(fromColumn + 1), endOffset: text.length };
}

const LOGS = /\blog\.(error|warn|lifecycle|verbose|trace|domain)\b/;
const REPORTS = /\b(onError|report[A-Z][A-Za-z]*)\s*(\(|&&|\?)/;

let bad = 0;
let checked = 0;

for (const fp of files) {
    const lines = readFileSync(fp, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;   // a catch being TALKED about
        const match = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)?\s*\))?\s*\{/.exec(line);
        if (!match) continue;
        checked++;

        const bound = match[1] || '';
        const { body, endOffset } = catchBody(lines, i, match.index + match[0].length - 1);
        // The marker is allowed in three places: inside the block, trailing its closing brace, or in
        // the run-up above it. All three read naturally at the site, so all three count.
        const after = lines.slice(i, i + 40).join('\n').slice(endOffset, endOffset + 200).split('\n')[0];
        const above = lines.slice(Math.max(0, i - 3), i + 1).join('\n');

        const usesError = bound && new RegExp(`\\b${bound}\\b`).test(body);
        const surfaced = LOGS.test(body) || REPORTS.test(body) || /\bthrow\b/.test(body) || usesError;
        const declared = body.includes('EXPECTED') || after.includes('EXPECTED') || above.includes('EXPECTED');
        if (surfaced || declared) continue;

        const where = `${path.relative(root, fp).replace(/\\/g, '/')}:${i + 1}`;
        console.error(`[error-handling] ${where} — this catch discards ${bound ? `\`${bound}\`` : 'its error'} `
            + 'without logging it, re-throwing it, returning it, or saying why that is safe');
        bad++;
    }

    // ── promise .catch(handler) — the same swallow in different syntax ──────────
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        for (const m of [...line.matchAll(/\.catch\s*\(/g)]) {
            checked++;
            const open = m.index + m[0].length - 1;
            const { argument, endOffset } = handlerArgument(lines, i, open);
            const inline = /^\s*(?:async\s*)?(?:\(\s*([A-Za-z_$][\w$]*)?\s*\)|([A-Za-z_$][\w$]*))\s*=>/.exec(argument)
                || /^\s*(?:async\s*)?function\s*\(\s*([A-Za-z_$][\w$]*)?\s*\)/.exec(argument);
            if (!inline) continue;                          // handler passed by name — judged where it is written
            const bound = inline[1] || inline[2] || '';
            const usesError = bound && new RegExp(`\\b${bound}\\b`).test(argument.slice(inline[0].length));
            const surfaced = LOGS.test(argument) || REPORTS.test(argument) || /\bthrow\b/.test(argument) || usesError;
            const after = lines.slice(i, i + 40).join('\n').slice(endOffset, endOffset + 200).split('\n')[0];
            const above = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
            if (surfaced || argument.includes('EXPECTED') || after.includes('EXPECTED') || above.includes('EXPECTED')) continue;

            const where = `${path.relative(root, fp).replace(/\\/g, '/')}:${i + 1}`;
            console.error(`[error-handling] ${where} — this .catch() handler discards `
                + `${bound ? `\`${bound}\`` : 'the rejection'} without logging it, re-throwing it, returning it, `
                + 'or saying why that is safe');
            bad++;
        }
    }
}

if (bad) {
    console.error(`[error-handling] FAIL — ${bad} silent catch(es). Log it with a context message AND the error `
        + 'object, hand it back to a caller, or — only if the throw is genuinely routine — write '
        + '`// EXPECTED: <why it is safe>` at the site.');
    process.exit(1);
}
console.log(`[error-handling] OK — ${checked} catch block(s) in ${files.length} files all surface or declare their error`);
