/* ============================================================================
 * workspace_paths.cjs — WHERE the workspace's sources live, for every tool in tools/. v0.1
 *
 * Every tool asks THIS module instead of hard-coding a path, so moving a folder is one edit here.
 *
 * The workspace is the folder `npm run dev -- <workspace>` watches. Each immediate subfolder that
 * holds a pack.json is one artifact: a GameLogic Pack, a GameLogic Plugin, a StatusMenu Pack or an
 * Event Pack. Any folder layout under an artifact's entries/ works, so the entry walk is recursive.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const WORKSPACE = path.join(PROJECT_DIR, 'workspace');

// The assembler ignores these, so the tools do too: dot files, and README notes kept in the folder.
const isIgnored = (name) => name.startsWith('.') || name === 'README.txt' || name === 'README.md';

// Every artifact folder, with its parsed pack.json.
function artifacts() {
    if (!fs.existsSync(WORKSPACE)) return [];
    return fs.readdirSync(WORKSPACE).sort()
        .filter((name) => !isIgnored(name))
        .map((name) => ({ name, dir: path.join(WORKSPACE, name) }))
        .filter((artifact) => fs.existsSync(path.join(artifact.dir, 'pack.json')))
        .map((artifact) => ({
            ...artifact,
            pack: JSON.parse(fs.readFileSync(path.join(artifact.dir, 'pack.json'), 'utf8')),
        }));
}

// Every prompt entry of every artifact: its text file, its sidecar fields (null when the .json is
// missing) and a short display path relative to workspace/, like "gamelogic/entries/example-window.txt".
function entries() {
    const out = [];
    for (const artifact of artifacts()) {
        const entriesDir = path.join(artifact.dir, 'entries');
        if (!fs.existsSync(entriesDir)) continue;
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir).sort()) {
                if (isIgnored(name)) continue;
                const file = path.join(dir, name);
                if (fs.statSync(file).isDirectory()) { walk(file); continue; }
                if (!name.endsWith('.txt')) continue;
                const sidecar = file.slice(0, -4) + '.json';
                out.push({
                    artifact,
                    file,
                    display: path.relative(WORKSPACE, file).split(path.sep).join('/'),
                    entry: fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, 'utf8')) : null,
                });
            }
        };
        walk(entriesDir);
    }
    return out;
}

module.exports = { PROJECT_DIR, WORKSPACE, artifacts, entries };
