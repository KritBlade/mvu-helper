// tools/check-derived-paths.mjs — no file in src/ may name the install folder. The path is DERIVED.
//
// WHY THIS EXISTS: SillyTavern names the install folder after the repo it was installed from, and
// this source ships from TWO — the public `mvu-helper` and the private `mvu-helper-dev`. A folder
// name written into the source 404s under the other one, and because that 404 lands on an `await`
// during boot, the extension dies with no UI and no obvious cause. That is exactly how it failed on
// staging, and the lesson is WHERE it failed: the hardcoded name was never in extension-paths.js, it
// was used to build settings.html and the logic-engine Worker URLs from OTHER files — where no unit
// test on extension-paths.js could ever have seen it.
//
// THE RULE: a same-origin URL is built from `extensionFolderPath` (sillytavern/extension-paths.js)
// or is module-relative. Two ways to break it, both checked here:
//
//   1. A CALL that fetches an absolute path literal — $.get / $.getJSON / fetch / new Worker /
//      new URL / import() whose FIRST argument is a string literal starting with `/`.
//   2. ANY line spelling `extensions/third-party`, which is the install path however it is
//      assembled — including into a variable that some later line fetches.
//
// EXEMPT, both real and both correct:
//   • `/api/…` — SillyTavern's REST API, not a file of ours (tavern-regex.js fetches /api/characters/get).
//   • a module-relative specifier (`./…`, `../…`) — resolved against import.meta.url, so it carries
//     no folder name that can go stale.
//
// NOT A RULE: the literal `'mvu-helper'` is NOT banned. It is the PINNED settings namespace
// (EXTENSION_NAMESPACE — card EJS and the galgame-companion bundle read it as a literal and cannot
// import it) and it is a provenance stamp in blank-pack-ui.js. This check is about URL
// CONSTRUCTION, never about the word.
//
// SCOPE AND BLIND SPOTS, honestly: this reads text, not syntax. A path assembled at runtime from a
// variable holding a bare folder name gets past rule 1, and only rule 2 catches it — and only if the
// `extensions/third-party` prefix is written down somewhere. It skips `//` and `*` comment lines, so
// a pattern DISCUSSED in prose is not a finding.

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

// Every call that turns its first argument into a URL the browser will go and fetch.
const FETCHERS = /(?:\$\.getJSON|\$\.get|\bfetch|new\s+Worker|new\s+URL|\bimport)\s*\(/g;

// The install path, however it is spelled. Rule 2.
const INSTALL_PATH = /extensions\/third-party/;

// A string literal opening on `/` — the absolute same-origin path rule 1 is about.
const ABSOLUTE_LITERAL = /^(['"`])\//;

/** The call's FIRST argument, by paren matching from its opening paren. */
function firstArgument(lines, lineIndex, fromColumn) {
    const text = lines.slice(lineIndex, lineIndex + 10).join('\n');
    let depth = 0;
    for (let i = fromColumn; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) return text.slice(fromColumn + 1, i); }
        else if (ch === ',' && depth === 1) return text.slice(fromColumn + 1, i);
    }
    return text.slice(fromColumn + 1);
}

let bad = 0;
let checked = 0;

for (const fp of files) {
    const lines = readFileSync(fp, 'utf8').split('\n');
    const where = (i) => `${path.relative(root, fp).split(path.sep).join('/')}:${i + 1}`;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;   // a path being TALKED about

        // ── rule 2: the install path spelled out anywhere ───────────────────
        if (INSTALL_PATH.test(line)) {
            console.error(`[derived-paths] ${where(i)} — this line writes the install path `
                + '`extensions/third-party` down. SillyTavern names that folder after the repo it was '
                + 'installed from, and this source ships from two of them — import `extensionFolderPath` '
                + 'from sillytavern/extension-paths.js instead');
            bad++;
        }

        // ── rule 1: a fetch of an absolute path literal ─────────────────────
        for (const m of [...line.matchAll(FETCHERS)]) {
            checked++;
            const argument = firstArgument(lines, i, m.index + m[0].length - 1).trim();
            if (!ABSOLUTE_LITERAL.test(argument)) continue;      // relative, or not a literal at all
            if (argument.slice(2).startsWith('api/')) continue;  // ST's REST API, not a file of ours
            if (argument.includes('extensionFolderPath')) continue;

            const call = m[0].replace(/\s*\($/, '');
            console.error(`[derived-paths] ${where(i)} — ${call} is given the absolute path `
                + `${argument.split('\n')[0].slice(0, 60)} . A same-origin file of ours must be addressed `
                + 'through `extensionFolderPath`, or relative to import.meta.url — a written-down folder '
                + 'name 404s on the other repo and kills the boot');
            bad++;
        }
    }
}

if (bad) {
    console.error(`[derived-paths] FAIL — ${bad} hardcoded path(s). Import { extensionFolderPath } from `
        + 'sillytavern/extension-paths.js and build the URL from it, or address the file relative to '
        + 'import.meta.url.');
    process.exit(1);
}
console.log(`[derived-paths] OK — ${checked} URL-building call(s) in ${files.length} files all derive their path`);
