// tests/schoolv4-artifact.mjs — locate the sibling School v4 checkout and read what its card CARRIES.
//
// ⚠ TEST SCOPE ONLY, deliberately. Nothing under src/ may learn a repo directory name: mvu-helper
// ships to users who check this repo out wherever they like, and the extension never reads the game
// repo at runtime anyway. This file exists so the suites that execute a REAL engine can find one on
// OUR machines; it must never be imported from src/.
//
// WHY A HELPER AND NOT A PATH. Every guard that runs a real engine needs the same three things — the
// engine text, the seed a chat starts from, and ONE answer to "is the sibling checkout usable". Spelled
// per test file, a repo rename or an artifact layout move breaks each guard separately and silently:
// a green suite that is not running the tests it claims. Hence one helper, and hence the rule
// `haveSchoolv4()` enforces: NO sibling checkout ⇒ skip (a contributor without the game repo keeps a
// green suite); a checkout that IS here but not shaped as these helpers expect ⇒ THROW, so a layout
// move fails the suite by name instead of turning guards into skips.
//
// WHY THE ENGINE COMES FROM THE ASSEMBLER. `pack.engine` is built by mvu-helper's OWN
// artifact-source-assembler, concatenating engine/ in the order the artifact's pack.json declares.
// So a drift guard proves the stamp matches the engine AS THIS CODE ASSEMBLES IT, rather than as a
// test re-implemented the concatenation — a second implementation being the drift these guards exist
// to catch. The retired `Archived/logicengine-bundle.cjs` is NOT a fallback: it is frozen at an older
// engine version and stamps fewer headers, so a guard reading it would pass while proving nothing.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleArtifactSource, splitWorkspaceSources } from '../src/shared/artifact-source-assembler.js';

// Checked in order. Extend this list rather than editing a path inside a test file — that is how
// the name got pinned to one machine in the first place.
const REPO_NAMES = [
    'MVU_Game_Maker-dev',   // OFFICE
    'MVU_Game_Maker',
    'MvuGameMaker',         // HOME — keep; dropping it would silently re-skip these suites there
];

const SUBPATH = join('maker-app', 'GameLogic', 'Schoolv4');
const SIBLINGS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Absolute path to the sibling School v4 folder.
 *
 * Returns the FIRST candidate that exists; when none do, returns the first candidate's path anyway
 * so the caller's own `existsSync` file checks fail normally and its `describe.skipIf` skips. That
 * keeps "repo absent" a skip (correct for a contributor without the game repo) rather than a throw.
 *
 * Override with MVU_GAME_MAKER_DIR=<path to the repo root> when your checkout uses another name.
 */
export function schoolv4Dir() {
    const override = process.env.MVU_GAME_MAKER_DIR;
    if (override) return join(override, SUBPATH);
    for (const name of REPO_NAMES) {
        const dir = join(SIBLINGS, name, SUBPATH);
        if (existsSync(dir)) return dir;
    }
    return join(SIBLINGS, REPO_NAMES[0], SUBPATH);
}

/** The artifact SOURCE folder — School's One Source Folder, the only thing these helpers read. */
export function schoolv4WorkspaceDir() {
    return join(schoolv4Dir(), 'workspace');
}

/** The sibling game-repo checkout root, or null when neither the override nor any REPO_NAMES entry exists. */
function siblingRepoRoot() {
    const override = process.env.MVU_GAME_MAKER_DIR;
    if (override) return existsSync(override) ? override : null;
    for (const name of REPO_NAMES) {
        const dir = join(SIBLINGS, name);
        if (existsSync(dir)) return dir;
    }
    return null;
}

/**
 * Is the sibling checkout present and shaped the way these guards need? The ONE skip condition.
 * No checkout ⇒ false (skip). A checkout without `workspace/gamelogic/pack.json` under SUBPATH ⇒ THROWS:
 * the artifact layout moved, and the fix is SUBPATH / schoolv4WorkspaceDir() here — never a skip.
 */
export function haveSchoolv4() {
    const root = siblingRepoRoot();
    if (!root) return false;
    const packJson = join(schoolv4WorkspaceDir(), 'gamelogic', 'pack.json');
    if (!existsSync(packJson)) {
        throw new Error(`sibling game repo found at ${root} but ${packJson} is missing — the artifact layout moved; ` +
            'fix tests/schoolv4-artifact.mjs (SUBPATH / schoolv4WorkspaceDir) rather than letting every real-engine guard skip');
    }
    return true;
}

// Every file under a directory as [{path, text}], forward-slash paths relative to `base` — the shape
// assembleArtifactSource takes. Line endings normalised: a checkout may hold CRLF (git autocrlf) and
// the engine text is matched against with regexes written for \n.
function readTree(dir, base = '') {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...readTree(p, base + name + '/'));
        else out.push({ path: base + name, text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') });
    }
    return out;
}

const cached = new Map();   // artifact folder name → its assembly

/**
 * One assembled artifact of the workspace, by its folder name (`gamelogic`, `statusmenu`, …) —
 * `{ pack, errors, warnings }` from mvu-helper's own assembler, or null when the sibling repo is absent
 * or has no such folder. Assembled ONCE per run: every guard reads the same object, so a suite cannot
 * accidentally compare two different reads of a folder being rebuilt.
 */
export function schoolv4Artifact(name) {
    if (!haveSchoolv4()) return null;
    if (!cached.has(name)) {
        const artifact = splitWorkspaceSources(readTree(schoolv4WorkspaceDir())).find((a) => a.name === name);
        cached.set(name, artifact ? assembleArtifactSource(artifact.files) : null);
    }
    return cached.get(name);
}

/** The assembled gamelogic artifact (schoolv4Artifact). */
export function schoolv4Gamelogic() {
    return schoolv4Artifact('gamelogic');
}

/** The engine text a card carries: engine/ concatenated in pack.json engineOrder. '' when absent. */
export function schoolv4EngineText() {
    const assembled = schoolv4Gamelogic();
    return (assembled && assembled.pack && assembled.pack.engine) || '';
}

/**
 * The stat_data a chat starts from — the `[InitVar]` entry's content, which is the seed the card
 * SHIPS rather than the genre's build input. {} when absent, so a caller can read it unconditionally
 * and let its own skip decide.
 */
export function schoolv4SeedStatData() {
    const assembled = schoolv4Gamelogic();
    const entries = (assembled && assembled.pack && assembled.pack.entries) || [];
    const seed = entries.find((e) => /^\[InitVar\]/.test(String(e.comment || '')));
    if (!seed) return {};
    const parsed = JSON.parse(seed.content);
    return parsed.stat_data || parsed;
}
