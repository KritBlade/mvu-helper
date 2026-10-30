// tools/check-named-exports.mjs — every `import { X } from './relative.js'` inside src/ must find X
// actually exported by that module.
//
// WHY THIS EXISTS (2026-08-16, GP2): `plugin-relay.js` imported `readActivePackIdFrom` from the
// gamelogic-pack barrel, which re-exported everything around it but not that name — and the whole
// extension died at load with a SyntaxError. No test could catch it: the importing file is
// host-coupled (its import chain reaches ST's script.js), so the suite never loads it, and
// check-host-imports.mjs verifies that host PATHS resolve, not that NAMED exports exist. The browser
// is the only place the miss could surface, which is exactly one place too late.
//
// Static and comment-stripped, so it shares the P7 blind spot honestly: specifiers built as strings
// at runtime (the Worker's moduleUrl) are invisible here, same as everywhere else.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const fp = path.join(dir, name);
        if (statSync(fp).isDirectory()) walk(fp);
        else if (name.endsWith('.js')) files.push(fp);
    }
})(root);

const exportsCache = new Map();
function exportsOf(fp) {
    if (exportsCache.has(fp)) return exportsCache.get(fp);
    const names = new Set();
    const text = stripComments(readFileSync(fp, 'utf8'));
    // export { a, b as c } [from '...']
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name) names.add(name);
        }
    }
    // export const/let/function/async function/class X
    for (const m of text.matchAll(/export\s+(?:const|let|var|function|async\s+function|class)\s+([A-Za-z0-9_$]+)/g)) {
        names.add(m[1]);
    }
    // export * from './x.js' — pull the re-exported module's names in
    const dir = path.dirname(fp);
    for (const m of text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
        const target = path.normalize(path.join(dir, m[1]));
        if (existsSync(target)) for (const n of exportsOf(target)) names.add(n);
    }
    exportsCache.set(fp, names);
    return names;
}

let bad = 0;
for (const fp of files) {
    const text = stripComments(readFileSync(fp, 'utf8'));
    const dir = path.dirname(fp);
    for (const m of text.matchAll(/import\s*(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        if (!m[2].startsWith('.')) continue;
        const target = path.normalize(path.join(dir, m[2]));
        if (!existsSync(target)) continue;              // outside the repo — check-host-imports.mjs owns those
        const names = exportsOf(target);
        for (const part of m[1].split(',')) {
            const want = part.trim().split(/\s+as\s+/)[0].trim();
            if (want && !names.has(want)) {
                console.error(`[named-exports] ${path.relative(root, fp)} imports { ${want} } from ${m[2]} — that module does not export it`);
                bad++;
            }
        }
    }
}

if (bad) {
    console.error(`[named-exports] FAIL — ${bad} import(s) name something their module never exports (the browser dies at load on the first one)`);
    process.exit(1);
}
console.log(`[named-exports] OK — every named import in src/ resolves (${files.length} files)`);
