/**
 * MVU Helper — the PLATFORM GENRE-BLINDNESS gate (plans/platform-genre-blindness.md §5, item 1).
 *
 * THE INVARIANT: mvu-helper is a generic extension. It does not know the schema, the variables or the
 * logic of any consumer that uses the logic engine. School v4 is not "the" consumer — it is the FIRST
 * one, and every line of platform code must still make sense with it uninstalled.
 *
 * WHY A TEST AND NOT A REVIEW HABIT: this class of coupling does not fail loudly for the second
 * consumer. It fails silently and plausibly — a log line prints `-` for every channel, a default points
 * at a root that does not exist, an injected instruction names entities the new genre has never heard
 * of. Each looks like a content bug in the consumer's own repo, so the author debugs the wrong one.
 * A grep only catches it if somebody remembers to run it; a test catches it in the commit that adds it.
 *
 * WHAT IS AND IS NOT A VIOLATION — two scans, different rules, because the files differ in kind.
 *
 *   src/**.js — comments stripped, string literals KEPT. A comment saying `// School: "Classmate"` as
 *   a labelled EXAMPLE documents the contract and should stay; that is exactly how roster-scan-core.js
 *   explains why it resolves the collection name by SHAPE instead of hardcoding one. What may not
 *   appear is an executable mention: a default, a constant, a path, a literal in an enumerated list,
 *   or prose the platform SHIPS into a prompt.
 *
 *   every .html and .css under src/ + i18n/*.json — scanned RAW, no comment exemption. Every byte of these reaches the
 *   user, so there is no documentation half to spare. These were unscanned until 2026-09-07, and both
 *   were carrying "Classmate" — a word on the list below — in the Roster-collection help text, so the
 *   gate was green while a banned word shipped. A help string teaching that a field is card-named
 *   illustrates the RANGE ("Partner", "Familiar", "关系列表") and never needs the first consumer's real
 *   key to do it. Deliberately NO allow-list: one would grow by an entry per genre migration, which is
 *   the opposite of what this gate exists for.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesUnder, jsFilesUnder } from './code-scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

// Vocabulary that belongs to a CONSUMER. Each of these was, at some point before 2026-08-07, sitting in
// mvu-helper's executable code — this list is the audit, kept live.
const CONSUMER_VOCABULARY = [
    'World_Calc',        // School v4's catch-all state root — was card-sync's watermark + imagegen's two latches
    'EngineDerived',     // the four roots that replaced it when School v4 split its state tree by OWNER
    'PendingState',      // (2026-08-07). Listed because the risk moved here, not because they ever leaked.
    'WorldRecord',       // `Preferences` is deliberately ABSENT — too generic to ban; a platform may have its own.
    'Classmate',         // its heroine collection — was the `_pend` line's `newClassmate`/`armClassmate` labels
    'Mainchar',          // its player-character key — was imagegen's DEFAULT_MALE_REGISTRY_KEY
    'heroine',           // its cast noun — was in the [SAME_ROUND_EVENT] instruction shipped to narrate
    'H_Camera',          // its per-position camera recipe block — was named in imagegen's explicit-scene camera rule
    // LEAF names. These are the sharper guard: they survive a consumer renaming its roots, which is
    // exactly what School v4 did on 2026-08-07 without any of these moving.
    'EventArmed',
    'IntimacyActive',
    'ForceImageType',
    'DataSyncVer',
    // INTENT CHANNEL names — a third category, added 2026-08-11 with P7. The platform now ROUTES
    // around a consumer's channels (the POST relay), which makes their names newly tempting to write
    // down; and a channel is the easiest of the three to leak, because it reads like plain English.
    // Caught live: a `makeFirst`-unavailable warning ended "...without the initiative gate", shipping
    // School's word to every RPG/Love user in a message about a wholly generic ordering failure.
    // `relationship` is deliberately ABSENT — like `Preferences`, too generic to ban outright.
    'initiative',
    'Affection',
    // ENGINE FUNCTION and PRE FIELD names — a fourth category, added 2026-10-04 with the user's ruling that
    // mvu-helper calls no engine-specific function: its only calls into an engine are its own documented
    // hooks (resolveTurn, resolvePostRelay, preAssemblyPatch, preVerdictPatch, pickSameRoundEvent). The
    // same-round guard used to call the engine's candidate sweep and parse the card's own PRE field itself;
    // the engine owns both now, behind pickSameRoundEvent. The PRE field School's preVerdictPatch acts on
    // (its H-boundary flag) is the engine's in the same way. Its on-stage field is not listed: as a
    // substring it matches this repo's own `onStaged` handler.
    'sweepCandidateLines',
    'readyEvent',
    'eventReady',
    'hcue',
];

// Strip // line comments and /* */ blocks, keeping string/template literals intact — a literal IS code
// here: shipped prose and hardcoded paths are precisely what this test exists to catch.
//
// REGEX LITERALS get their own state. Without it a pattern containing an odd number of quotes (the real
// one that caught this: /"eventReady"\s*:\s*"([^"]*)"/ ) desyncs the string tracker, and from there the
// file is scanned in the wrong mode — which showed up as a plain `//` comment being reported as code.
// A scanner that mis-parses in the SAFE direction only wastes a minute; this one mis-parsed in both.
const REGEX_MAY_START_AFTER = '(,=:[!&|?{};+-*%~^<>';
function stripComments(source) {
    const out = [];
    let state = null;                       // null | '//' | '/*' | '/re' | a quote char
    let prevMeaningful = '';                // last non-space char emitted — decides regex vs division
    for (let i = 0; i < source.length; i++) {
        const c = source[i], next = source[i + 1];
        if (state === null) {
            if (c === '/' && next === '/') { state = '//'; i++; continue; }
            if (c === '/' && next === '*') { state = '/*'; i++; continue; }
            if (c === '/' && (prevMeaningful === '' || REGEX_MAY_START_AFTER.includes(prevMeaningful))) state = '/re';
            else if (c === '"' || c === "'" || c === '`') state = c;
            if (!/\s/.test(c)) prevMeaningful = c;
            out.push(c);
        } else if (state === '/re') {
            if (c === '\\') { out.push(c, next === undefined ? '' : next); i++; continue; }
            out.push(c);
            if (c === '/' || c === '\n') { state = null; prevMeaningful = c; }   // newline = unterminated ⇒ it was division
        } else if (state === '//') {
            if (c === '\n') { state = null; out.push(c); }
            else out.push(' ');             // keep offsets so reported line numbers stay true
        } else if (state === '/*') {
            if (c === '*' && next === '/') { state = null; i++; out.push('  '); continue; }
            out.push(c === '\n' ? '\n' : ' ');
        } else {                            // inside a string / template literal
            if (c === '\\') { out.push(c, next === undefined ? '' : next); i++; continue; }
            out.push(c);
            if (c === state) state = null;
        }
    }
    return out.join('');
}

// Everything shipped that is NOT JavaScript: the settings panel and every translation of it. They
// deploy verbatim, so they are scanned verbatim.
function shippedNonJsFiles() {
    const found = filesUnder(SRC, ['.html', '.css']);
    for (const name of readdirSync(path.join(ROOT, 'i18n'))) {
        if (name.endsWith('.json')) found.push(path.join(ROOT, 'i18n', name));
    }
    return found;
}

describe('platform genre-blindness — no consumer vocabulary in executable code', () => {
    const files = jsFilesUnder(SRC);

    it('finds the source tree (a passing scan of zero files would be a lie)', () => {
        expect(files.length).toBeGreaterThan(30);
    });

    it('no consumer schema, root, collection or cast noun appears outside a comment', () => {
        const violations = [];
        for (const file of files) {
            const code = stripComments(readFileSync(file, 'utf8'));
            code.split('\n').forEach((line, ix) => {
                for (const word of CONSUMER_VOCABULARY) {
                    if (line.includes(word)) {
                        violations.push(`${path.relative(SRC, file)}:${ix + 1}  [${word}]  ${line.trim().slice(0, 120)}`);
                    }
                }
            });
        }
        expect(violations).toEqual([]);
    });

    it('the stripper does not simply erase everything (it must still see a literal)', () => {
        // Guards the guard: a stripper bug that blanked string literals would make the scan above pass
        // for any code at all — the quiet failure mode this whole file is about.
        const sample = "// World_Calc in a comment\nconst p = 'World_Calc.Thing';   /* World_Calc block */\n";
        const stripped = stripComments(sample);
        expect(stripped).toContain("'World_Calc.Thing'");
        expect(stripped.split('\n')[0]).not.toContain('World_Calc');
        expect(stripped).not.toContain('block');
    });

    it('a regex literal holding an odd number of quotes does not desync the scan', () => {
        // The exact shape that broke it: the PRE-field regex extra-llm-calls-core.js once held. If the quotes inside
        // the pattern are read as string delimiters, everything after it is parsed in the wrong mode.
        const sample = 'const RE = /"eventReady"\\s*:\\s*"([^"]*)"/;\n// World_Calc in a comment\nconst q = 1;\n';
        const stripped = stripComments(sample);
        expect(stripped).toContain('eventReady');            // the regex itself survives
        expect(stripped).not.toContain('World_Calc');        // …and the comment after it is still stripped
    });

    it('division is not mistaken for a regex', () => {
        const stripped = stripComments('const half = total / 2;   // World_Calc\nconst x = 1;\n');
        expect(stripped).toContain('total / 2');
        expect(stripped).not.toContain('World_Calc');
    });
});

describe('platform genre-blindness — no consumer vocabulary in shipped UI or translations', () => {
    const files = shippedNonJsFiles();

    it('finds the shipped non-JS files (a passing scan of zero files would be a lie)', () => {
        expect(files.some((f) => f.endsWith('settings.html'))).toBe(true);
        expect(files.filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
    });

    it('no consumer schema, root, collection or cast noun reaches the panel or a translation', () => {
        const violations = [];
        for (const file of files) {
            readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, ix) => {
                for (const word of CONSUMER_VOCABULARY) {
                    if (line.includes(word)) {
                        violations.push(`${path.relative(ROOT, file)}:${ix + 1}  [${word}]  ${line.trim().slice(0, 120)}`);
                    }
                }
            });
        }
        expect(violations).toEqual([]);
    });
});
