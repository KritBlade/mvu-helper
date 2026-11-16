// eventpack-genre-copies.test.js — every genre beside this repo carries the CURRENT event-pack engine.
//
// eventpack_lib/eventpack.cjs is the master. Each genre in the Dev tree's Genre/ folder holds a copy of it in an
// artifact's engine/ folder, and that genre's own `npm test` rewrites the copy from this master (its
// Tools/sync_engine_copies.cjs writes a one-line COPY banner above the master's text). So an edit to the master
// reaches a genre only when the genre's npm test runs. This suite fails while any copy differs from the master and
// names the genre whose npm test to run; amending the master means running this suite, so the reminder comes then.
//
// No Genre/ folder beside this repo ⇒ skip: a cloner of the public repo has none. A Genre/ folder that holds no
// copy ⇒ FAIL: a layout move must fail by name, never turn this suite into a skip.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = path.join(REPO, 'eventpack_lib', 'eventpack.cjs');
const GENRES = path.join(REPO, '..', 'Genre');

const toLf = (text) => text.replace(/\r\n/g, '\n');
const isDirectory = (p) => existsSync(p) && statSync(p).isDirectory();
const subdirectories = (dir) => readdirSync(dir).filter((name) => isDirectory(path.join(dir, name))).sort();

// Every <genre>/workspace/<artifact>/engine/eventpack.cjs under `genresDir`, as { genre, file }, `file` relative to
// the genre's folder.
function genreCopies(genresDir) {
    const copies = [];
    for (const genre of subdirectories(genresDir)) {
        const workspace = path.join(genresDir, genre, 'workspace');
        if (!isDirectory(workspace)) continue;
        for (const artifact of subdirectories(workspace)) {
            if (existsSync(path.join(workspace, artifact, 'engine', 'eventpack.cjs'))) {
                copies.push({ genre, file: 'workspace/' + artifact + '/engine/eventpack.cjs' });
            }
        }
    }
    return copies;
}

// Why one copy is not the master under its one-line COPY banner, or null when it is.
function copyProblem(copyText, masterText) {
    const copy = toLf(copyText);
    if (!copy.startsWith('// COPY')) return 'its first line is no COPY banner';
    return copy.slice(copy.indexOf('\n') + 1) === toLf(masterText) ? null : 'its text differs from the master';
}

// One line per copy that is not the master, naming the genre whose npm test fixes it.
function laggingCopies(genresDir, masterText) {
    return genreCopies(genresDir)
        .map((c) => ({ ...c, problem: copyProblem(readFileSync(path.join(genresDir, c.genre, c.file), 'utf8'), masterText) }))
        .filter((c) => c.problem)
        .map((c) => 'Genre/' + c.genre + '/' + c.file + ': ' + c.problem + '. Run npm test in Genre/' + c.genre
            + ': it rewrites a copy whose master changed, and names a hand edit instead of overwriting it.');
}

describe('the copy check, on a made-up Genre/ folder', () => {
    const MASTER_TEXT = '/* master */\nconst answer = 1;\n';
    const BANNER = '// COPY — do not edit here. Master: mvu-helper/eventpack_lib/eventpack.cjs (sha256 000000000000).\n';
    let root;
    const put = (genre, artifact, text) => {
        const dir = path.join(root, genre, 'workspace', artifact, 'engine');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'eventpack.cjs'), text);
    };
    beforeAll(() => {
        root = mkdtempSync(path.join(tmpdir(), 'eventpack-genre-copies-'));
        put('Behind', 'gamelogic', BANNER + '/* master */\nconst answer = 0;\n');
        put('Current', 'gamelogic', BANNER + MASTER_TEXT);
        put('CurrentCrlf', 'gamelogic', toLf(BANNER + MASTER_TEXT).replace(/\n/g, '\r\n'));
        put('NoBanner', 'gamelogic', MASTER_TEXT);
        mkdirSync(path.join(root, 'NoWorkspace'));
        mkdirSync(path.join(root, 'NoEventpack', 'workspace', 'statusmenu', 'engine'), { recursive: true });
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('finds the engine/ copy of every genre that has one', () => {
        expect(genreCopies(root).map((c) => c.genre)).toEqual(['Behind', 'Current', 'CurrentCrlf', 'NoBanner']);
    });

    it('names exactly the copies that are not the master, each with the genre whose npm test fixes it', () => {
        const lagging = laggingCopies(root, MASTER_TEXT);
        expect(lagging).toHaveLength(2);
        expect(lagging[0]).toMatch(/^Genre\/Behind\/workspace\/gamelogic\/engine\/eventpack\.cjs: its text differs from the master\. Run npm test in Genre\/Behind:/);
        expect(lagging[1]).toMatch(/^Genre\/NoBanner\/workspace\/gamelogic\/engine\/eventpack\.cjs: its first line is no COPY banner\. Run npm test in Genre\/NoBanner:/);
    });
});

describe.skipIf(!isDirectory(GENRES))('every genre in the Genre/ folder beside this repo carries the current eventpack.cjs', () => {
    it('finds a copy: Genre/ is here, so finding none means the genre layout moved', () => {
        expect(genreCopies(GENRES).length, 'no genre in ' + GENRES + ' holds workspace/<artifact>/engine/eventpack.cjs').toBeGreaterThan(0);
    });

    it('every copy is eventpack_lib/eventpack.cjs under its COPY banner', () => {
        expect(laggingCopies(GENRES, readFileSync(MASTER, 'utf8'))).toEqual([]);
    });
});
