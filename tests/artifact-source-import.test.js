// tests/artifact-source-import.test.js — the G5 source import (authority §28): the zip reader,
// workspace-root normalization, and buildWorkspaceArtifacts — the ONE pipeline the import UI and
// the dev server share (same-assembler invariant, workflow plan §4.1). The fixtures are the W8
// skeletons: real artifacts of all three types, built by the same code a user's cold start runs.

import { describe, it, expect } from 'vitest';
import { buildStoredZip, readZip, crc32 } from '../src/shared/stored-zip.js';
import { normalizeWorkspaceRoot, splitWorkspaceSources } from '../src/shared/artifact-source-assembler.js';
import { buildWorkspaceArtifacts } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { readMenuEngineExportsInProcess } from '../tools/menu-engine-exports-in-process.mjs';

// The reader the dev server passes; the page passes the engine frame's throwaway Worker instead.
const BUILD_OPTIONS = { readMenuEngine: readMenuEngineExportsInProcess };
import { buildBlankArtifactMembers, BLANK_ARTIFACT_TYPES } from '../src/shared/artifact-skeletons.js';

const IDENTITY = { name: 'My Game', description: 'A blank artifact', builtWith: 'mvu-helper 0.0.0-test' };
const workspaceMembers = () => BLANK_ARTIFACT_TYPES.flatMap(({ packType }) =>
    buildBlankArtifactMembers({ packType, id: 'my-game', ...IDENTITY }).members);
const decode = (bytes) => new TextDecoder().decode(bytes);

// A method-8 (deflate) single-member zip, built by hand: what any normal zip tool produces, which
// the STORED-only writer never will — so the reader's deflate path needs its own fixture.
async function buildDeflatedZip(path, text) {
    const enc = new TextEncoder();
    const name = enc.encode(path);
    const data = enc.encode(text);
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    const crc = crc32(data);
    const bytes = [];
    const p16 = (v) => bytes.push(v & 0xff, (v >>> 8) & 0xff);
    const p32 = (v) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    p32(0x04034b50); p16(20); p16(0x0800); p16(8); p16(0); p16(0);
    p32(crc); p32(packed.length); p32(data.length); p16(name.length); p16(0);
    for (const b of name) bytes.push(b);
    for (const b of packed) bytes.push(b);
    const cdStart = bytes.length;
    p32(0x02014b50); p16(20); p16(20); p16(0x0800); p16(8); p16(0); p16(0);
    p32(crc); p32(packed.length); p32(data.length); p16(name.length); p16(0); p16(0);
    p16(0); p16(0); p32(0); p32(0);
    for (const b of name) bytes.push(b);
    const cdSize = bytes.length - cdStart;
    p32(0x06054b50); p16(0); p16(0); p16(1); p16(1); p32(cdSize); p32(cdStart); p16(0);
    return new Uint8Array(bytes);
}

describe('readZip — the reader half of stored-zip', () => {
    it('round-trips what buildStoredZip wrote, byte for byte', async () => {
        const members = workspaceMembers();
        const back = await readZip(buildStoredZip(members));
        expect(back.map((m) => m.path)).toEqual(members.map((m) => m.path));
        for (let i = 0; i < members.length; i++) expect(decode(back[i].bytes)).toBe(members[i].text);
    });
    it('reads a DEFLATE-compressed member — the shape every normal zip tool emits', async () => {
        const zip = await buildDeflatedZip('pack.json', '{"hello":"world"}');
        const back = await readZip(zip);
        expect(back).toHaveLength(1);
        expect(back[0].path).toBe('pack.json');
        expect(decode(back[0].bytes)).toBe('{"hello":"world"}');
    });
    it('refuses non-zip bytes naming the defect', async () => {
        await expect(readZip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('no end-of-central-directory');
    });
    it('a damaged member fails its CRC check BY PATH — never a silent truncation', async () => {
        const zip = buildStoredZip([{ path: 'pack.json', text: '{"a":1}' }]);
        // flip one byte inside the stored data (the local header is 30 bytes + 9 name bytes)
        zip[30 + 'pack.json'.length + 2] ^= 0xff;
        await expect(readZip(zip)).rejects.toThrow('pack.json');
        await expect(readZip(zip)).rejects.toThrow('CRC');
    });
    it('an encrypted entry is refused, not decoded into garbage', async () => {
        const zip = buildStoredZip([{ path: 'pack.json', text: '{}' }]);
        // set encryption bit (flag bit 0) in the CENTRAL directory copy, which the reader trusts
        const cdStart = zip.length - 22 - (46 + 'pack.json'.length);
        zip[cdStart + 8] |= 0x01;
        await expect(readZip(zip)).rejects.toThrow('encrypted');
    });
});

describe('normalizeWorkspaceRoot — the container the developer pointed at is not source', () => {
    const wrap = (files, top) => files.map((f) => ({ path: top + '/' + f.path, text: f.text }));
    it('a directory pick arrives prefixed with the picked folder and still resolves', () => {
        const doubly = wrap(workspaceMembers(), 'ws');   // ws/gamelogic/pack.json …
        const found = splitWorkspaceSources(normalizeWorkspaceRoot(doubly));
        expect(found.map((a) => a.name).sort()).toEqual(['gamelogic', 'plugin-my-game', 'statusmenu']);
    });
    it('stops the moment artifacts are findable — a resolvable tree is untouched', () => {
        const members = workspaceMembers();
        expect(normalizeWorkspaceRoot(members)).toEqual(members.map((f) => ({ path: f.path, text: f.text })));
    });
    it('a tree with no pack.json anywhere comes back unchanged, so the error names what was given', () => {
        const junk = [{ path: 'a/b/readme.txt', text: 'x' }, { path: 'a/c/notes.txt', text: 'y' }];
        expect(splitWorkspaceSources(normalizeWorkspaceRoot(junk))).toEqual([]);
    });
    it('never strips past a top-level FILE', () => {
        const one = [{ path: 'orphan.txt', text: 'x' }];
        expect(normalizeWorkspaceRoot(one)).toEqual(one);
    });
});

describe('buildWorkspaceArtifacts — assembler + validator + gates, ONE call (§4.1)', async () => {
    it('judges all three skeleton types clean from one workspace', async () => {
        const out = await buildWorkspaceArtifacts(workspaceMembers(), BUILD_OPTIONS);
        expect(out).toHaveLength(3);
        for (const a of out) {
            expect(a.errors).toEqual([]);
            expect(a.warnings).toEqual([]);
            expect(a.pack).toBeTruthy();
        }
        expect(out.map((a) => a.pack.packType).sort()).toEqual(['gamelogic', 'plugin', 'statusmenu']);
    });
    it('an assembly defect fails ITS artifact and leaves the others clean', async () => {
        const members = workspaceMembers()
            .filter((m) => !(m.path.startsWith('gamelogic/') && m.path.endsWith('.json') && m.path.includes('entries/')));
        const out = await buildWorkspaceArtifacts(members, BUILD_OPTIONS);
        const bad = out.find((a) => a.name === 'gamelogic');
        const good = out.filter((a) => a.name !== 'gamelogic');
        expect(bad.errors.length).toBeGreaterThan(0);          // .txt with no sidecar (§28.2)
        expect(bad.errors.join(' ')).toContain('.txt');
        for (const a of good) expect(a.errors).toEqual([]);
    });
    it('the §7 content gates RUN here — a broken EJS entry is an import error, not a runtime lie', async () => {
        const members = workspaceMembers().map((m) =>
            m.path.startsWith('gamelogic/entries/') && m.path.endsWith('.txt')
                ? { ...m, text: '<% if (broken { %>' }
                : m);
        const out = await buildWorkspaceArtifacts(members, BUILD_OPTIONS);
        const bad = out.find((a) => a.name === 'gamelogic');
        expect(bad.errors.join(' ')).toContain('scriptlets do not compile');
    });
    it('engine members concatenate in DECLARED order — the same-assembler proof needs a 2-member engine', async () => {
        // The skeletons ship one engine member each, which is order-blind: a reversed-concat
        // assembler mutation survived this suite until this fixture existed (2026-09-03).
        const members = workspaceMembers().flatMap((m) => {
            if (m.path !== 'gamelogic/pack.json') return [m];
            const declared = JSON.parse(m.text);
            declared.engineOrder = [...declared.engineOrder, 'zz-second.cjs'];
            return [{ path: m.path, text: JSON.stringify(declared) },
                { path: 'gamelogic/engine/zz-second.cjs', text: '// SECOND MEMBER\n' }];
        });
        const out = await buildWorkspaceArtifacts(members, BUILD_OPTIONS);
        const game = out.find((a) => a.name === 'gamelogic');
        expect(game.errors).toEqual([]);
        const first = game.pack.engine.indexOf('module.exports');
        const second = game.pack.engine.indexOf('// SECOND MEMBER');
        expect(first).toBeGreaterThanOrEqual(0);
        expect(second).toBeGreaterThan(first);
    });
    it('§3 validation RUNS here — a wrong packType is an import error', async () => {
        const members = workspaceMembers().map((m) =>
            m.path === 'gamelogic/pack.json'
                ? { ...m, text: m.text.replace('"gamelogic"', '"no-such-type"') }
                : m);
        const out = await buildWorkspaceArtifacts(members, BUILD_OPTIONS);
        const bad = out.find((a) => a.name === 'gamelogic');
        expect(bad.errors.length).toBeGreaterThan(0);
    });
});

describe('buildWorkspaceArtifacts reads a menu engine only through the reader it is given', () => {
    it('a workspace with a menu engine and NO reader throws — nothing falls back to running it here', async () => {
        await expect(buildWorkspaceArtifacts(workspaceMembers())).rejects.toThrow(/no readMenuEngine was given/);
    });
    it('the reader is asked once, with the ASSEMBLED menu engine text, and its answer is what the gate judges', async () => {
        const asked = [];
        const out = await buildWorkspaceArtifacts(workspaceMembers(), {
            readMenuEngine: async (text) => { asked.push(text); return { ok: false, error: 'reader says no', formatters: [], actions: [] }; },
        });
        const menu = out.find((a) => a.pack && a.pack.packType === 'statusmenu');
        expect(asked).toEqual([menu.pack.engine]);
        expect(menu.errors.join(' ')).toContain('failed to load: reader says no');
    });
});
