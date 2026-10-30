// tools/check-mvu-writes.mjs — MVU's two write calls may be CALLED in exactly one file,
// src/sillytavern/mvu-bridge.js: `Mvu.parseMessage` (everything else goes through its parseMvuBlock)
// and `Mvu.replaceMvuData` (everything else goes through its saveMessageMvuData).
//
// WHY. Each door does one thing a direct call skips without a sound. parseMvuBlock labels the parse for
// the turn's op attribution (mvu-bridge-core.js): a direct `Mvu.parseMessage` fires the same
// VARIABLE_UPDATE_ENDED with no label on the stack, and its ops are collected as 'message', i.e.
// attributed to the MODEL — a false accusation nothing at runtime can tell apart. saveMessageMvuData
// announces the save (MVU_STATE_SAVED_EVENT): a direct `Mvu.replaceMvuData` stores the state and tells
// no reader, so the side panel and the StatusMenu frames keep showing the state from before it. Both
// fail open, so the bypass is refused at build time, here.
//
// Same honest blind spot as its siblings: static and comment-stripped, so a call built out of strings
// at runtime is invisible. Nothing in this repo does that to MVU, and a gate that catches the ordinary
// spelling is what keeps it that way.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ALLOWED = path.join(root, 'sillytavern', 'mvu-bridge.js');

// The CALL shape only — `typeof Mvu.parseMessage` (feature detection) carries no paren.
const DOORS = [
    { call: /\.parseMessage\s*\(/, name: 'Mvu.parseMessage', door: 'parseMvuBlock (and name its `writer`)' },
    { call: /\.replaceMvuData\s*\(/, name: 'Mvu.replaceMvuData', door: 'saveMessageMvuData (and name its `writer`)' },
];

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const fp = path.join(dir, name);
        if (statSync(fp).isDirectory()) walk(fp);
        else if (name.endsWith('.js')) files.push(fp);
    }
})(root);

const violations = [];
for (const fp of files) {
    if (fp === ALLOWED) continue;
    const lines = stripComments(readFileSync(fp, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
        for (const door of DOORS) {
            if (door.call.test(lines[i])) violations.push({ door, at: path.relative(root, fp) + ':' + (i + 1) + '  ' + lines[i].trim() });
        }
    }
}

if (violations.length) {
    console.error('[mvu-writes] FAIL — an MVU write is called outside sillytavern/mvu-bridge.js:');
    for (const v of violations) console.error('  ' + v.door.name + ' → route it through ' + v.door.door + ': ' + v.at);
    process.exit(1);
}
console.log(`[mvu-writes] OK — parseMessage and replaceMvuData are called only inside the bridge (${files.length} files checked)`);
