/**
 * MVU Helper — the card→save sync's pure core (card-sync/card-sync-core.js)
 *
 * The sync lets a RUNNING chat receive data a later card version adds to its [InitVar] (MVU reads it only at chat
 * creation). Coverage targets the load-bearing rules:
 *   - the seed is create-only at every depth (player edits survive) and runs every load; force overwrites wholesale,
 *     once per version (segment-wise numeric compare, 1.10 > 1.9, against the chat's watermark); forceFromInitVar
 *     pushes the card's own [InitVar] value under the same gate, a table row by row, never deleting a row
 *   - the re-seed under mvu-helper's own root: what the chat never changed follows the card
 *   - container creation for brand-new targets (the actual upgrade case)
 *   - a primitive in the path is never destroyed (blocked, rest continues)
 *   - every state a new generation can seed from takes the payload; the registered passes run on the newest
 *
 * Run:  npm test   (or:  npx vitest run --reporter=verbose)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSyncPayload, applyDataSync, syncFloorStates, watermarksOf, watermarkStamps, planSyncRetry, isRetryableSkip, isAwaitingMvuInit, SYNC_RETRY_MAX_ATTEMPTS, SYNC_RETRY_DELAY_MS, WATERMARK_FIELD, FORCE_FROM_INITVAR_WATERMARK_FIELD, seedPassSummary, differsFromSeedPrints } from '../src/features/card-sync/card-sync-core.js';
import { compareVersions } from '../src/shared/version-compare.js';

const freshSave = () => ({
    World_Calc: {
        EventTrigger: {
            leila_1: { cat: 'TRG', when: 'old-when' },
        },
        Lang: ['zh-TW', '顯示語言'],
    },
    Intent: { check: ['', ''] },
});

const payload = (over = {}) => ({
    version: '0.2.0',
    // A PLAIN stat_data subtree — exactly initmvu.json's own shape, which is the whole point of the fold.
    seed: {
        World_Calc: { EventTrigger: { lena_1: { cat: 'TRG', when: 'Loc=Cafe' } } },
        Intent: { newClassmate: {} },
    },
    force: {},
    ...over,
});

describe('compareVersions', () => {
    it('equal versions', () => expect(compareVersions('1.2.3', '1.2.3')).toBe(0));
    it('numeric segments, not parseFloat (1.10 > 1.9)', () => expect(compareVersions('1.10.0', '1.9.9')).toBe(1));
    it('revision bump compares higher', () => expect(compareVersions('0.1.1', '0.1.0')).toBe(1));
    it('next official minor beats user revision', () => expect(compareVersions('1.3.0', '1.2.7')).toBe(1));
    it('missing segments are zero', () => expect(compareVersions('1.2', '1.2.0')).toBe(0));
    it('junk segments are zero', () => expect(compareVersions('abc', '0')).toBe(0));
    it('lower returns -1', () => expect(compareVersions('0.1.0', '0.2.0')).toBe(-1));
});

describe('buildSyncPayload — assembling the two sources that now feed the apply', () => {
    // There is no parser here any more: the seed is the card's [InitVar], which is MVU's format
    // (JSON5, optional wrappers, macros, multi-entry merge), so MVU parses it and hands the tree in.
    it('assembles a payload from a seed tree and a force record', () => {
        const p = buildSyncPayload({ seed: { World: { Day: 1 } }, force: { 'A.b': 2 }, forceFromInitVar: ['World'], version: '4.3.0' });
        expect(p).toEqual({ version: '4.3.0', seed: { World: { Day: 1 } }, force: { 'A.b': 2 }, forceFromInitVar: ['World'] });
    });

    // A card with mvu-helper but NO pack has no force lane at all. It must still seed, and it must
    // never stamp — '0' is the version that no real version can fail to outrank.
    it('defaults the version to "0" so a card with no pack never forces and never stamps', () => {
        const p = buildSyncPayload({ seed: { A: 1 } });
        expect(p.version).toBe('0');
        expect(p.force).toEqual({});
    });

    it('coerces every non-object bucket to {}, and a forceFromInitVar that is not a list to [], instead of throwing', () => {
        for (const bad of [null, undefined, 'x', 42, ['a']]) {
            const p = buildSyncPayload({ seed: bad, force: bad });
            expect(p.seed).toEqual({});
            expect(p.force).toEqual({});
        }
        for (const bad of [null, undefined, 'World', 42, { World: 1 }]) {
            expect(buildSyncPayload({ forceFromInitVar: bad }).forceFromInitVar).toEqual([]);
        }
    });

    it('trims the version and survives being called with nothing', () => {
        expect(buildSyncPayload({ version: '  1.2.0  ' }).version).toBe('1.2.0');
        expect(buildSyncPayload()).toEqual({ version: '0', seed: {}, force: {}, forceFromInitVar: [] });
    });
});

describe('applyDataSync — seed runs EVERY load, force is gated', () => {
    it('seeds a missing key and reports it', () => {
        const sd = freshSave();
        const r = applyDataSync(sd, payload(), undefined);
        expect(sd.World_Calc.EventTrigger.lena_1.when).toBe('Loc=Cafe');
        expect(r.added).toContain('World_Calc.EventTrigger.lena_1');
    });

    it('never touches an existing key — a player edit survives every load', () => {
        const sd = freshSave();
        const p = payload();
        p.seed.World_Calc.EventTrigger.leila_1 = { cat: 'TRG', when: 'NEW-when' };
        applyDataSync(sd, p, undefined);
        expect(sd.World_Calc.EventTrigger.leila_1.when).toBe('old-when');
    });

    it('creates brand-new containers at any depth (the upgrade case)', () => {
        const sd = { World_Calc: {} };
        const r = applyDataSync(sd, payload(), undefined);
        expect(sd.World_Calc.EventTrigger.lena_1.cat).toBe('TRG');
        expect(sd.Intent.newClassmate).toEqual({});
        expect(r.added.length).toBeGreaterThan(0);
    });

    // THE POINT OF THE FOLD. `init` used to do this every load and the payload's create-only half was
    // watermark-gated, so the same job had two different gates. Seed is now the one that runs always.
    it('SEEDS EVEN WHEN THE WATERMARK ALREADY COVERS THE VERSION — that is what replaced `init`', () => {
        const sd = { World_Calc: {} };
        const r = applyDataSync(sd, payload(), '9.9.9');
        expect(sd.World_Calc.EventTrigger.lena_1.cat).toBe('TRG');
        expect(r.isForceSkipped).toBe(true);
        expect(r.applied).toBe(true);
    });

    it('a fully-seeded save takes ZERO writes on the every-load pass', () => {
        const sd = freshSave();
        applyDataSync(sd, payload(), undefined);
        const before = JSON.stringify(sd);
        const r = applyDataSync(sd, payload(), '0.2.0');
        expect(JSON.stringify(sd)).toBe(before);
        expect(r.added).toEqual([]);
    });

    it('no stat_data → skipped, not thrown', () => {
        expect(applyDataSync(null, payload(), undefined).skipped).toBe(true);
    });
});

describe('applyDataSync — the stamp flag', () => {
    // THE HAZARD THE FOLD INTRODUCED. `applied` is now true from SEED alone, so stamping on it would
    // mark this version done while force had never run — and, being watermarked, it never would.
    it('does NOT tell the caller to stamp on a seed-only load', () => {
        const sd = { World_Calc: {} };
        const r = applyDataSync(sd, payload(), '9.9.9');
        expect(r.applied).toBe(true);
        expect(r.shouldStamp).toBe(false);
    });

    it('tells the caller to stamp exactly when force RAN', () => {
        const r = applyDataSync(freshSave(), payload(), undefined);
        expect(r.shouldStamp).toBe(true);
    });

    it('stamps even when force had nothing to do — the version WAS processed', () => {
        const r = applyDataSync(freshSave(), { version: '9.0.0', seed: {}, force: {} }, '0.2.0');
        expect(r.shouldStamp).toBe(true);
        expect(r.forced).toEqual([]);
    });

    it('never stamps without stat_data', () => {
        expect(applyDataSync(null, payload(), undefined).shouldStamp).toBe(false);
    });
});

describe('applyDataSync — force is a FLAT path → value map', () => {
    it('overwrites an existing path wholesale, no deep merge', () => {
        const sd = freshSave();
        const r = applyDataSync(sd, payload({
            force: { 'World_Calc.EventTrigger.leila_1': { cat: 'TRG', when: 'FIXED-when' } },
        }), undefined);
        expect(sd.World_Calc.EventTrigger.leila_1).toEqual({ cat: 'TRG', when: 'FIXED-when' });
        expect(r.forced).toContain('World_Calc.EventTrigger.leila_1');
    });

    it('writes a LEAF, which the old two-level bucket could not address', () => {
        const sd = freshSave();
        applyDataSync(sd, payload({ force: { 'World_Calc.EventTrigger.leila_1.when': 'leaf-set' } }), undefined);
        expect(sd.World_Calc.EventTrigger.leila_1.when).toBe('leaf-set');
        expect(sd.World_Calc.EventTrigger.leila_1.cat).toBe('TRG');   // sibling untouched
    });

    it('creates the parent chain on the way', () => {
        const sd = {};
        applyDataSync(sd, payload({ seed: {}, force: { 'A.b.c': 7 } }), undefined);
        expect(sd.A.b.c).toBe(7);
    });

    it('force WINS over seed on a shared path — seed runs first, force overwrites', () => {
        const sd = { World_Calc: {} };
        applyDataSync(sd, {
            version: '1.0.0',
            seed: { World_Calc: { EventTrigger: { k: { v: 'from-seed' } } } },
            force: { 'World_Calc.EventTrigger.k': { v: 'from-force' } },
        }, undefined);
        expect(sd.World_Calc.EventTrigger.k.v).toBe('from-force');
    });

    it('a primitive in the way BLOCKS that path, never destroys it, and the rest continues', () => {
        const sd = freshSave();
        sd.World_Calc.EventTrigger = 'oops-a-string';
        const r = applyDataSync(sd, payload({ seed: {}, force: { 'World_Calc.EventTrigger.x.y': 1, 'Intent.ok': 2 } }), undefined);
        expect(sd.World_Calc.EventTrigger).toBe('oops-a-string');
        expect(r.blocked.some((b) => b.startsWith('World_Calc.EventTrigger'))).toBe(true);
        expect(sd.Intent.ok).toBe(2);
    });

    // SECURITY: force paths are card-supplied. ensurePath guards the parent chain, but the LAST segment
    // is assigned here — `container.__proto__ = value` would re-parent the container itself.
    it('a PROTOTYPE KEY anywhere in a force path BLOCKS it, and the rest continues', () => {
        const sd = { A: {} };
        const r = applyDataSync(sd, payload({ seed: {}, force: {
            '__proto__.pgForced': 1,
            'A.__proto__': { pgForced: 1 },
            'constructor.prototype.pgForced': 1,
            'A.ok': 2,
        } }), undefined);
        try {
            expect(({}).pgForced).toBe(undefined);
            expect(Object.getPrototypeOf(sd.A)).toBe(Object.prototype);
            expect(r.blocked).toHaveLength(3);
            expect(r.blocked.every((b) => /prototype key/.test(b))).toBe(true);
            expect(r.forced).toEqual(['A.ok']);
            expect(sd.A.ok).toBe(2);
        } finally {
            delete Object.prototype.pgForced;
        }
    });

    it('deep-clones written values — no shared reference with the payload', () => {
        const sd = freshSave();
        const p = payload({ force: { 'World_Calc.EventTrigger.lena_1': { when: 'Loc=Cafe' } } });
        applyDataSync(sd, p, undefined);
        p.force['World_Calc.EventTrigger.lena_1'].when = 'MUTATED';
        expect(sd.World_Calc.EventTrigger.lena_1.when).toBe('Loc=Cafe');
    });

    it('version gate still interleaves the official and hand-edit lanes', () => {
        const sd = freshSave();
        expect(applyDataSync(sd, payload({ version: '0.2.1' }), '0.2.0').shouldStamp).toBe(true);
        expect(applyDataSync(sd, payload({ version: '0.3.0' }), '0.2.1').shouldStamp).toBe(true);
        expect(applyDataSync(sd, payload({ version: '0.2.0' }), '0.3.0').shouldStamp).toBe(false);
    });

    it('GENRE-BLIND: it never writes a watermark into the card\'s stat_data', () => {
        const sd = { Ledger: { rows: {} } };
        const r = applyDataSync(sd, { version: '1.0.0', seed: { Ledger: { rows: { r1: { note: 'x' } } } }, force: {} }, undefined);
        expect(r.applied).toBe(true);
        expect(Object.keys(sd)).toEqual(['Ledger']);
        expect(JSON.stringify(sd)).not.toContain('1.0.0');
    });
});

// A chat that began before the card changed a row still holds the old row, because the seed is create-only: an event
// gated on the old date fires a day early. A pack that lists its table under forceFromInitVar pushes the card's rows,
// once per state version.
describe("applyDataSync — forceFromInitVar pushes the card's own [InitVar] value", () => {
    // A running chat's table: one row the card has since changed, one it has not — carrying the empty fields the card's
    // schema filled in, as every saved row does — and one only the chat holds: another developer's event pack installed it.
    const runningSave = () => ({
        EventPack: {
            triggers: {
                haruka_1: { cat: 'TRG', when: 'Date>=2026-04-16' },
                nemu_1: { cat: 'TRG', prereq: '', when: 'Date>=2026-04-16', check: '', fx: { scope: '', writes: [] } },
                paulk_beach_1: { cat: 'TRG', when: 'Wkd=Saturday' },
            },
            fired: { nemu_1: { state: 'done' } },
        },
    });
    const cardSeed = () => ({
        EventPack: {
            triggers: {
                haruka_1: { cat: 'TRG', when: 'Date>=2026-04-17' },
                nemu_1: { cat: 'TRG', when: 'Date>=2026-04-16' },
            },
            fired: {},
        },
    });
    const push = (over = {}) => ({ version: '0.2.0', seed: cardSeed(), force: {}, forceFromInitVar: ['EventPack.triggers'], ...over });

    it("MUTATION TARGET — a table goes row by row: a changed row takes the card's, an equal one is not rewritten", () => {
        const sd = runningSave();
        const r = applyDataSync(sd, push(), '0.1.0');
        expect(sd.EventPack.triggers.haruka_1.when).toBe('Date>=2026-04-17');
        expect(r.forcedFromInitVar).toEqual([{ path: 'EventPack.triggers', isTable: true, cardRows: 2, replaced: ['haruka_1'], keptRows: 1 }]);
        expect(r.shouldStamp).toBe(true);
    });

    // MUTATION TARGET — the empty fields are the schema's, not a difference; a field the card dropped is one.
    it('a row is the card\'s give or take the empty fields a schema fills in, and differs when the card dropped a field', () => {
        const sd = runningSave();
        sd.EventPack.triggers.haruka_1 = { cat: 'TRG', prereq: 'flag:leila_1', when: 'Date>=2026-04-17' };
        const seed = cardSeed();
        seed.EventPack.triggers.nemu_1.fx = { summary: '' };
        const r = applyDataSync(sd, push({ seed }), '0.1.0');
        expect(r.forcedFromInitVar[0].replaced).toEqual(['haruka_1']);
        expect(sd.EventPack.triggers.haruka_1).toEqual({ cat: 'TRG', when: 'Date>=2026-04-17' });
        expect(sd.EventPack.triggers.nemu_1.check).toBe('');
    });

    it("MUTATION TARGET — a row the card does not carry is never deleted: another developer's pack installed it", () => {
        const sd = runningSave();
        applyDataSync(sd, push(), '0.1.0');
        expect(sd.EventPack.triggers.paulk_beach_1).toEqual({ cat: 'TRG', when: 'Wkd=Saturday' });
    });

    it('a sibling the path does not name is untouched — fired events stay fired', () => {
        const sd = runningSave();
        applyDataSync(sd, push(), '0.1.0');
        expect(sd.EventPack.fired).toEqual({ nemu_1: { state: 'done' } });
    });

    it('MUTATION TARGET — it is watermark-gated: a save that already took this version for the push keeps its rows', () => {
        const sd = runningSave();
        const r = applyDataSync(sd, push(), '0.1.0', '0.2.0');
        expect(sd.EventPack.triggers.haruka_1.when).toBe('Date>=2026-04-16');
        expect(r.forcedFromInitVar).toEqual([]);
        expect(r.forceFromInitVarSkipReason).toBe('version 0.2.0 <= pushed 0.2.0');
        expect(r.shouldStampForceFromInitVar).toBe(false);
    });

    // An mvu-helper that predates forceFromInitVar takes the version for the literal map and never pushes. Had the two
    // lists shared one watermark, that version would read as pushed, and the push would never run in that save.
    it('MUTATION TARGET — a version taken for the map alone does not count as pushed', () => {
        const sd = runningSave();
        const r = applyDataSync(sd, push(), '0.2.0', '');
        expect(sd.EventPack.triggers.haruka_1.when).toBe('Date>=2026-04-17');
        expect(r.isForceSkipped).toBe(true);
        expect(r.shouldStamp).toBe(false);
        expect(r.shouldStampForceFromInitVar).toBe(true);
    });

    it('MUTATION TARGET — watermarkStamps advances each watermark only for the list that ran', () => {
        const sd = runningSave();
        expect(watermarkStamps(applyDataSync(sd, push(), '0.1.0', '0.1.0'))).toEqual({ [WATERMARK_FIELD]: '0.2.0', [FORCE_FROM_INITVAR_WATERMARK_FIELD]: '0.2.0' });
        expect(watermarkStamps(applyDataSync(runningSave(), push(), '0.2.0', '0.1.0'))).toEqual({ [FORCE_FROM_INITVAR_WATERMARK_FIELD]: '0.2.0' });
        expect(watermarkStamps(applyDataSync(runningSave(), push(), '0.1.0', '0.2.0'))).toEqual({ [WATERMARK_FIELD]: '0.2.0' });
        expect(watermarkStamps(applyDataSync(runningSave(), push(), '0.2.0', '0.2.0'))).toEqual({});
    });

    // card-sync.js writes watermarkStamps into the chat record and reads it back through watermarksOf: the field names
    // must agree, or every load would push again (read misses) or never again (write misses).
    it('MUTATION TARGET — what watermarkStamps writes, watermarksOf reads back, each list under its own field', () => {
        const pushOnly = applyDataSync(runningSave(), push(), '0.2.0', '0.1.0');
        expect(watermarksOf(watermarkStamps(pushOnly))).toEqual({ force: '', forceFromInitVar: '0.2.0' });
        const mapOnly = applyDataSync(runningSave(), push(), '0.1.0', '0.2.0');
        expect(watermarksOf(watermarkStamps(mapOnly))).toEqual({ force: '0.2.0', forceFromInitVar: '' });
        expect(watermarksOf(null)).toEqual({ force: '', forceFromInitVar: '' });
    });

    it('MUTATION TARGET — card-sync.js gates on the chat record through watermarksOf and stamps through watermarkStamps', () => {
        const glue = readFileSync(new URL('../src/features/card-sync/card-sync.js', import.meta.url), 'utf8');
        expect(glue).toMatch(/watermarksOf\(readChatRecord\(\)\)/);
        expect(glue).toMatch(/watermarkStamps\(report\)/);
    });

    it('an empty list has nothing to take, so it never stamps', () => {
        const r = applyDataSync(runningSave(), push({ forceFromInitVar: [] }), '0.1.0', '');
        expect(r.shouldStampForceFromInitVar).toBe(false);
        expect(r.forceFromInitVarSkipReason).toBe('');
    });

    it('a row the card adds arrives through the seed, and is not counted as replaced', () => {
        const sd = runningSave();
        const seed = cardSeed();
        seed.EventPack.triggers.yuki_1 = { cat: 'TRG', when: 'Date>=2026-04-20' };
        const r = applyDataSync(sd, push({ seed }), '0.1.0');
        expect(r.added).toContain('EventPack.triggers.yuki_1');
        expect(r.forcedFromInitVar[0].replaced).toEqual(['haruka_1']);
    });

    it('a value that is not a table is replaced whole', () => {
        const sd = { World: { Weather: ['Storm', 'Weather'] } };
        const r = applyDataSync(sd, { version: '1.0.0', seed: { World: { Weather: ['Clear', 'Weather'] } }, force: {}, forceFromInitVar: ['World.Weather'] }, undefined);
        expect(sd.World.Weather).toEqual(['Clear', 'Weather']);
        expect(r.forcedFromInitVar).toEqual([{ path: 'World.Weather', isTable: false, cardRows: 1, replaced: ['World.Weather'], keptRows: 0 }]);
    });

    it("a path the card's [InitVar] does not reach is blocked by name, and the rest continues", () => {
        const sd = runningSave();
        const r = applyDataSync(sd, push({ forceFromInitVar: ['EventPack.trigger', 'EventPack.triggers'] }), '0.1.0');
        expect(r.blocked).toEqual(["EventPack.trigger (the card's [InitVar] carries nothing there)"]);
        expect(sd.EventPack.triggers.haruka_1.when).toBe('Date>=2026-04-17');
    });

    it('a PROTOTYPE KEY anywhere in a listed path BLOCKS it', () => {
        const sd = runningSave();
        const r = applyDataSync(sd, push({ forceFromInitVar: ['__proto__.polluted', 'EventPack.constructor'] }), '0.1.0');
        expect(r.blocked).toHaveLength(2);
        expect(r.blocked.every((b) => /prototype key/.test(b))).toBe(true);
        expect(({}).polluted).toBe(undefined);
    });

    it('the literal force map runs after it, so a value written there wins on a shared path', () => {
        const sd = runningSave();
        applyDataSync(sd, push({ force: { 'EventPack.triggers.haruka_1': { cat: 'TRG', when: 'from-force' } } }), '0.1.0');
        expect(sd.EventPack.triggers.haruka_1.when).toBe('from-force');
    });

    it('deep-clones each row — no shared reference with the seed', () => {
        const sd = runningSave();
        const p = push();
        applyDataSync(sd, p, '0.1.0');
        p.seed.EventPack.triggers.haruka_1.when = 'MUTATED';
        expect(sd.EventPack.triggers.haruka_1.when).toBe('Date>=2026-04-17');
    });

    // The one line of host glue between the pack's registry and this apply. It hands the provider's record over whole,
    // so a list the provider adds reaches the payload without an edit there.
    it("MUTATION TARGET — card-sync.js hands the force provider's record to buildSyncPayload whole", () => {
        const glue = readFileSync(new URL('../src/features/card-sync/card-sync.js', import.meta.url), 'utf8');
        expect(glue).toMatch(/buildSyncPayload\(\{\s*\.\.\.forceRecord,\s*seed\s*\}\)/);
    });
});

// §12a.1 — the residual timing hole phase GE closes. Found by READING, never observed live: both
// fresh-chat shots can return a retryable not-ready, and before GE nothing mid-session re-ran them.
describe('planSyncRetry — a not-ready verdict schedules its own next attempt', () => {
    it('retries a not-ready verdict, with the shared delay', () => {
        expect(planSyncRetry({ retryable: true, attempt: 1 })).toEqual({ retry: true, delayMs: SYNC_RETRY_DELAY_MS, giveUp: false });
    });

    it('a REAL verdict is never retried — applied / version-skipped / no entry are answers, not races', () => {
        expect(planSyncRetry({ retryable: false, attempt: 1 })).toEqual({ retry: false, delayMs: 0, giveUp: false });
    });

    it('bounded: the last attempt gives up ONCE, and that transition is the only warnable one', () => {
        expect(planSyncRetry({ retryable: true, attempt: SYNC_RETRY_MAX_ATTEMPTS - 1 }).retry).toBe(true);
        expect(planSyncRetry({ retryable: true, attempt: SYNC_RETRY_MAX_ATTEMPTS })).toEqual({ retry: false, delayMs: 0, giveUp: true });
    });

    it('SUPERSEDED beats everything — a chat switch makes the old chain stop, and stop QUIETLY', () => {
        // The stale-target hazard across attempts: the new chat's sync is the authority now, and a
        // give-up warning from a chain nobody is waiting on would cry wolf on every chat switch.
        const p = planSyncRetry({ retryable: true, attempt: SYNC_RETRY_MAX_ATTEMPTS, superseded: true });
        expect(p).toEqual({ retry: false, delayMs: 0, giveUp: false });
    });

    it('the caller may tighten the budget without the policy changing shape', () => {
        expect(planSyncRetry({ retryable: true, attempt: 2, maxAttempts: 3, delayMs: 50 })).toEqual({ retry: true, delayMs: 50, giveUp: false });
        expect(planSyncRetry({ retryable: true, attempt: 3, maxAttempts: 3, delayMs: 50 }).giveUp).toBe(true);
    });
});

// The classifier bug, live 2026-08-15: "no stat_data" was filed as a RACE, so every brand-new chat
// burned 15 s of retries and then warned "this chat is running WITHOUT its card payload" — false.
// MVU initialises variables at the FIRST GENERATION (GENERATION_STARTED / MESSAGE_SENT), never on
// chat load, so a fresh chat having no variables is the normal state, not a lost race.
describe('skip classification — a race is retried, a wait is not', () => {
    const skip = (reason) => ({ skipped: true, reason });

    it('host-not-attached reasons are races', () => {
        for (const r of ['MVU not ready', 'lorebook not ready', 'chat changed mid-sync (msg 4 no longer latest)']) {
            expect(isRetryableSkip(skip(r))).toBe(true);
            expect(isAwaitingMvuInit(skip(r))).toBe(false);
        }
    });

    it('"no stat_data" is a WAIT — never retried, never warned about', () => {
        expect(isRetryableSkip(skip('no stat_data on msg 0'))).toBe(false);
        expect(isAwaitingMvuInit(skip('no stat_data on msg 0'))).toBe(true);
    });

    it('a real verdict is neither', () => {
        for (const r of ['version 0.1.0 <= watermark 0.1.0', 'no [MVU_Update_Data] entry', 'parse error', 'error']) {
            expect(isRetryableSkip(skip(r))).toBe(false);
            expect(isAwaitingMvuInit(skip(r))).toBe(false);
        }
        expect(isRetryableSkip({ applied: true, reason: '' })).toBe(false);   // not a skip at all
        expect(isAwaitingMvuInit(null)).toBe(false);
    });

    it('the two classes never overlap — otherwise behaviour would depend on check ORDER', () => {
        for (const r of ['MVU not ready', 'lorebook not ready', 'chat changed mid-sync', 'no stat_data on msg 0']) {
            expect([isRetryableSkip, isAwaitingMvuInit].filter((isClass) => isClass(skip(r))).length).toBe(1);
        }
    });

    // DRIFT GUARD (this is why the regexes used to live in the host file): a reason renamed on one
    // side only would silently turn a retryable race into "give up immediately". The classifiers are
    // in the pure core now, so the guard reads the glue and proves every class still matches a reason
    // that file actually produces.
    it('every classifier matches a reason card-sync.js really emits', () => {
        const glue = readFileSync(new URL('../src/features/card-sync/card-sync.js', import.meta.url), 'utf8');
        const emitted = [...glue.matchAll(/reason:\s*'([^']+)'/g)].map((m) => m[1]);
        expect(emitted.length).toBeGreaterThan(3);
        for (const [name, isClass] of [['retryable', isRetryableSkip], ['awaiting-mvu-init', isAwaitingMvuInit]]) {
            expect(emitted.some((r) => isClass(skip(r))), `no emitted reason matches the ${name} classifier`).toBe(true);
        }
    });
});

describe('constants', () => {
    // A FIELD name inside mvu-helper's own chat-metadata namespace — deliberately not a dotted path,
    // because there is no longer any tree of a consumer's for it to point into.
    it('watermark fields are the documented ones', () => {
        expect(WATERMARK_FIELD).toBe('dataSyncVer');
        expect(FORCE_FROM_INITVAR_WATERMARK_FIELD).toBe('forceFromInitVarVer');
    });
    it('watermark fields name no consumer root', () => {
        expect(WATERMARK_FIELD).not.toMatch(/\./);
        expect(FORCE_FROM_INITVAR_WATERMARK_FIELD).not.toMatch(/\./);
    });
});

// THE RE-SEED (plans/character-registry-in-state.md §4): under mvu-helper's own root, a value the card seeded and the
// chat never changed takes the card's newer value; game roots stay create-only. The fingerprints of what the seed last
// wrote live in the state, in a mirror of the seeded tree.
describe("applyDataSync — the re-seed of mvu-helper's own root", () => {
    const ROOT = '$mvuhelper';
    const registrySeed = (records) => ({ [ROOT]: { character_registry: records } });
    const sync = (state, seed, extra = {}) => applyDataSync(state, buildSyncPayload({ seed, ...extra }), '');
    const printsOf = (state) => state[ROOT].seed_fingerprints;

    it('MUTATION TARGET — a new chat: what MVU seeded equals the seed, so every leaf takes its fingerprint and nothing is replaced', () => {
        const seed = registrySeed({ Airi: { body: 'a', aliases: ['K'] } });
        const state = structuredClone(seed);
        const report = sync(state, seed);
        expect(report.reseeded).toEqual([]);
        expect(report.applied).toBe(true);   // the fingerprints moved, so the caller saves
        expect(Object.keys(printsOf(state).character_registry.Airi)).toEqual(['body', 'aliases']);
        expect(state[ROOT].character_registry.Airi).toEqual({ body: 'a', aliases: ['K'] });
    });

    it("MUTATION TARGET — a leaf the chat never changed takes the card's newer value, and its new fingerprint", () => {
        const state = registrySeed({ Airi: { body: 'old body' } });
        sync(state, registrySeed({ Airi: { body: 'old body' } }));
        const before = printsOf(state).character_registry.Airi.body;
        const report = sync(state, registrySeed({ Airi: { body: 'fixed body' } }));
        expect(state[ROOT].character_registry.Airi.body).toBe('fixed body');
        expect(report.reseeded).toEqual(['$mvuhelper.character_registry.Airi.body']);
        expect(printsOf(state).character_registry.Airi.body).not.toBe(before);
    });

    it('MUTATION TARGET — a leaf the chat changed is kept, with the fingerprint it had', () => {
        const state = registrySeed({ Airi: { body: 'old body' } });
        sync(state, registrySeed({ Airi: { body: 'old body' } }));
        const recorded = printsOf(state).character_registry.Airi.body;
        state[ROOT].character_registry.Airi.body = 'edited in the Roster tab';
        const report = sync(state, registrySeed({ Airi: { body: 'fixed body' } }));
        expect(state[ROOT].character_registry.Airi.body).toBe('edited in the Roster tab');
        expect(report.reseeded).toEqual([]);
        expect(printsOf(state).character_registry.Airi.body).toBe(recorded);
    });

    it("per leaf: an edited outfit stays while the card's body fix still lands", () => {
        const first = registrySeed({ Airi: { body: 'b1', clothes: { gym: 'g1' } } });
        const state = structuredClone(first);
        sync(state, first);
        state[ROOT].character_registry.Airi.clothes.gym = 'my own gym clothes';
        sync(state, registrySeed({ Airi: { body: 'b2', clothes: { gym: 'g2' } } }));
        expect(state[ROOT].character_registry.Airi).toEqual({ body: 'b2', clothes: { gym: 'my own gym clothes' } });
    });

    it('MUTATION TARGET — a value the chat had before the card seeded it is kept, and takes no fingerprint', () => {
        const state = registrySeed({ Mana: { body: 'registered in play' } });
        const report = sync(state, registrySeed({ Mana: { body: "the card's Mana" } }));
        expect(state[ROOT].character_registry.Mana.body).toBe('registered in play');
        expect(report.reseeded).toEqual([]);
        expect(printsOf(state)).toBeUndefined();
    });

    it("MUTATION TARGET — a leaf put back to the seed's value (Reset to the card's look) follows the card again", () => {
        const state = registrySeed({ Airi: { body: 'v1' } });
        sync(state, registrySeed({ Airi: { body: 'v1' } }));
        state[ROOT].character_registry.Airi.body = 'edited';
        sync(state, registrySeed({ Airi: { body: 'v2' } }));               // kept: changed in this chat
        state[ROOT].character_registry.Airi.body = 'v2';                    // the reset writes the card's record
        sync(state, registrySeed({ Airi: { body: 'v2' } }));
        sync(state, registrySeed({ Airi: { body: 'v3' } }));
        expect(state[ROOT].character_registry.Airi.body).toBe('v3');
    });

    it('a leaf the seed no longer carries is kept, and its fingerprint dropped', () => {
        const state = registrySeed({ Airi: { body: 'a', bust: 1.2 } });
        sync(state, registrySeed({ Airi: { body: 'a', bust: 1.2 } }));
        sync(state, registrySeed({ Airi: { body: 'a' } }));
        expect(state[ROOT].character_registry.Airi.bust).toBe(1.2);
        expect(Object.keys(printsOf(state).character_registry.Airi)).toEqual(['body']);
    });

    it('a character deleted while the card still seeds it comes back from the seed', () => {
        const seed = registrySeed({ Airi: { body: 'a' } });
        const state = structuredClone(seed);
        sync(state, seed);
        delete state[ROOT].character_registry.Airi;
        const report = sync(state, seed);
        expect(state[ROOT].character_registry.Airi).toEqual({ body: 'a' });
        expect(report.added).toEqual(['$mvuhelper.character_registry.Airi']);
    });

    it('a key holding a dot keeps its own fingerprint', () => {
        const seed = registrySeed({ 'Mr. Tanaka': { body: 't1' } });
        const state = structuredClone(seed);
        sync(state, seed);
        sync(state, registrySeed({ 'Mr. Tanaka': { body: 't2' } }));
        expect(state[ROOT].character_registry['Mr. Tanaka'].body).toBe('t2');
        expect(Object.keys(printsOf(state).character_registry)).toEqual(['Mr. Tanaka']);
    });

    it('MUTATION TARGET — a game root stays create-only: an untouched game value does not follow the card', () => {
        const state = { World: { Weather: 'Rain' } };
        sync(state, { World: { Weather: 'Rain' } });
        const report = sync(state, { World: { Weather: 'Clear' } });
        expect(state.World.Weather).toBe('Rain');
        expect(report.reseeded).toEqual([]);
        expect(state[ROOT]).toBeUndefined();   // no root created for a card that seeds none
    });

    it('MUTATION TARGET — a card cannot seed the fingerprints: refused, reported, never written', () => {
        const state = {};
        const report = sync(state, { [ROOT]: { seed_fingerprints: { forged: 'x' }, character_registry: { Airi: { body: 'a' } } } });
        expect(report.blocked).toEqual(["$mvuhelper.seed_fingerprints (mvu-helper's own bookkeeping, never seeded)"]);
        expect(printsOf(state)).toEqual({ character_registry: { Airi: { body: expect.any(String) } } });
    });

    it("MUTATION TARGET — a forced record takes the forced value's fingerprints, so the next pass reads it as the card's", () => {
        const state = registrySeed({ Airi: { body: 'edited' } });
        sync(state, registrySeed({ Airi: { body: 'v2' } }), { force: { '$mvuhelper.character_registry.Airi': { body: 'v2' } }, version: '1.1.0' });
        expect(state[ROOT].character_registry.Airi.body).toBe('v2');
        sync(state, registrySeed({ Airi: { body: 'v3' } }), { version: '1.1.0' });
        expect(state[ROOT].character_registry.Airi.body).toBe('v3');
    });
});

// What Re-import from card says about the seed pass it ran: counts a player can act on, never a claim of change when
// only fingerprints moved.
// One sync over the states a new generation can seed from, newest first (card-sync.js reads them from
// shared/generation-floor.js): a regenerate or swipe of the newest reply starts over from the state before it.
describe('syncFloorStates — one sync over the states a new generation can seed from', () => {
    const ROOT = '$mvuhelper';
    const seed = { [ROOT]: { character_registry: { Mitsuki: { body: 'b', aliases: ['美月'] } } } };
    const floors = () => [{ id: 210, statData: { World: {} } }, { id: 209, statData: { World: {} } }];
    const noPasses = () => ({ changed: false, reports: [] });
    const passChanged = () => ({ changed: true, reports: [] });

    it('MUTATION TARGET — the payload reaches every state, not only the newest', () => {
        const states = floors();
        const synced = syncFloorStates(states, buildSyncPayload({ seed }), {}, noPasses);
        expect(synced.map((f) => f.id)).toEqual([210, 209]);
        for (const { statData } of states) expect(statData[ROOT].character_registry.Mitsuki.aliases).toEqual(['美月']);
        expect(synced.map((f) => f.isChanged)).toEqual([true, true]);
    });

    it('MUTATION TARGET — the registered passes run on the newest state only', () => {
        const states = floors();
        const ran = [];
        syncFloorStates(states, buildSyncPayload({ seed }), {}, (statData) => { ran.push(statData); return noPasses(); });
        expect(ran).toEqual([states[0].statData]);
    });

    it('a state that already holds the seed is unchanged; a pass change alone marks the newest changed', () => {
        const states = floors();
        syncFloorStates(states, buildSyncPayload({ seed }), {}, noPasses);
        expect(syncFloorStates(states, buildSyncPayload({ seed }), {}, noPasses).map((f) => f.isChanged)).toEqual([false, false]);
        expect(syncFloorStates(states, buildSyncPayload({ seed }), {}, passChanged).map((f) => f.isChanged)).toEqual([true, false]);
    });

    it('force reaches every state, and each one reports the stamp', () => {
        const states = floors();
        const synced = syncFloorStates(states, buildSyncPayload({ seed, force: { 'World.Day': 3 }, version: '1.0.0' }), { force: '0.9.0' }, noPasses);
        expect(states.map(({ statData }) => statData.World.Day)).toEqual([3, 3]);
        expect(synced.map((f) => f.report.shouldStamp)).toEqual([true, true]);
    });

    it('forceFromInitVar reaches every state, gated on its own watermark', () => {
        const states = [{ id: 210, statData: { Table: { row: { v: 1 } } } }, { id: 209, statData: { Table: { row: { v: 1 } } } }];
        const payload = buildSyncPayload({ seed: { Table: { row: { v: 2 } } }, forceFromInitVar: ['Table'], version: '1.0.0' });
        syncFloorStates(states, payload, { force: '1.0.0', forceFromInitVar: '1.0.0' }, noPasses);
        expect(states.map(({ statData }) => statData.Table.row.v)).toEqual([1, 1]);
        syncFloorStates(states, payload, { force: '1.0.0', forceFromInitVar: '0.9.0' }, noPasses);
        expect(states.map(({ statData }) => statData.Table.row.v)).toEqual([2, 2]);
    });

    it('no [InitVar]: nothing is applied, and the passes still run on the newest', () => {
        const synced = syncFloorStates(floors(), null, {}, passChanged);
        expect(synced[0].report.reason).toBe('no [InitVar] entry');
        expect(synced.map((f) => f.isChanged)).toEqual([true, false]);
    });
});

describe('seedPassSummary — the sentence Re-import from card shows', () => {
    it('MUTATION TARGET — names each half that changed the state, by count', () => {
        expect(seedPassSummary({ applied: true, added: ['a', 'b'], reseeded: ['c'], forced: [] }))
            .toBe('Re-seeded this chat from the card: 2 added, 1 updated');
        expect(seedPassSummary({ applied: true, added: [], reseeded: [], forced: ['x'] })).toBe('Re-seeded this chat from the card: 1 forced');
        expect(seedPassSummary({ applied: true, added: [], reseeded: [], forced: [], forcedFromInitVar: [{ replaced: ['a', 'b'] }, { replaced: ['c'] }] }))
            .toBe('Re-seeded this chat from the card: 3 replaced');
    });

    it('MUTATION TARGET — says nothing when only fingerprints moved, or nothing ran', () => {
        expect(seedPassSummary({ applied: true, added: [], reseeded: [], forced: [], didFingerprintsMove: true })).toBe('');
        expect(seedPassSummary({ applied: false, skipped: true, reason: 'lorebook not ready' })).toBe('');
        expect(seedPassSummary(null)).toBe('');
    });
});

// The Roster tab offers "Reset to the card's look" only on a seeded character the chat changed.
describe('differsFromSeedPrints — has this chat changed a seeded record?', () => {
    const seed = { $mvuhelper: { character_registry: { Airi: { body: 'a', clothes: { gym: 'g' } } } } };
    const synced = () => { const state = structuredClone(seed); applyDataSync(state, buildSyncPayload({ seed }), ''); return state; };
    const printsOf = (state) => state.$mvuhelper.seed_fingerprints.character_registry.Airi;

    it("MUTATION TARGET — an untouched record is the card's", () => {
        const state = synced();
        expect(differsFromSeedPrints(state.$mvuhelper.character_registry.Airi, printsOf(state))).toBe(false);
    });

    it('MUTATION TARGET — an edited leaf, a removed leaf and an added leaf each make it differ', () => {
        const edited = synced(); edited.$mvuhelper.character_registry.Airi.body = 'b';
        expect(differsFromSeedPrints(edited.$mvuhelper.character_registry.Airi, printsOf(edited))).toBe(true);
        const removed = synced(); delete removed.$mvuhelper.character_registry.Airi.clothes.gym;
        expect(differsFromSeedPrints(removed.$mvuhelper.character_registry.Airi, printsOf(removed))).toBe(true);
        const added = synced(); added.$mvuhelper.character_registry.Airi.clothes.swim = 's';
        expect(differsFromSeedPrints(added.$mvuhelper.character_registry.Airi, printsOf(added))).toBe(true);
    });

    it('a record the card seeds nothing for never differs', () => {
        expect(differsFromSeedPrints({ body: 'x' }, undefined)).toBe(false);
    });
});
