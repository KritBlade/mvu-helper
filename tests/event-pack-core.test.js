/**
 * MVU Helper — [MVU_Event_Pack] pure-core tests (event-pack/event-pack-core.js)
 *
 * A community event pack = ONE lorebook entry (hidden <mvueventpack> JSON + self-gated prose bodies)
 * merged into the dedicated root stat_data.EventPack. Coverage targets the load-bearing rules
 * (plans/event-pack-plan.md):
 *   - parse: comment filter (registry entry excluded), block extraction, per-entry error isolation
 *   - validate (§4): meta / key-prefix namespace / collision fence / size caps / one-series rule =
 *     ERRORS; row-field + DSL-shape + fx-shape + body-coverage lints = WARNINGS (permissive-biased)
 *   - apply (§3.3): per-pack currency gate, wholesale row replace on upgrade (dropped rows deleted),
 *     installed bookkeeping, armed-key keep/clear, §3.1a format compat gate (major hard-skip,
 *     minor soft-warn), and the §5 fence — only the EventPack root is ever written
 *
 * Run:  npm test   (or:  npx vitest run --reporter=verbose)
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    PACK_ENTRY_MATCH, REGISTRY_ENTRY_MATCH, SUPPORTED_FORMAT, MAX_ROWS_PER_PACK,
    slug, packId, keyPrefix, installedRootOf, firedRootOf, armedPointerShapeProblem, FIRE_INTENT,
    requiredFormat, packWritePaths, unallowedWritePaths, unstampedWritePaths, undeclaredScopeRows,
    packRewardKinds, unallowedRewardKinds, mismatchedRewardShapes,
    parseEventPacks, parseRegistry, validateEventPack, applyEventPacks as applyEventPacksRaw,
    pruneEventPack as pruneEventPackRaw, reconcileEventPacks as reconcileEventPacksRaw,
    lintPackEjs as lintPackEjsRaw, decideInstall, decideMerge, packRowsMatch, packSyncToasts,
    buildRegistryContent, packEntryComment, packEntryWrite,
    parseUploadFile, duplicatePackIds, duplicateTriggerKeys,
    extractArmedBody, findArmedBody, planScanRefusalNotice, installedPacksToEnsure,
} from '../src/features/event-pack/event-pack-core.js';

// P4b — triggerRoot/armedPath are REQUIRED opts now (they were a hardcoded stub, a third spelling of
// what globalLogic's adapter owns). In production the sync pass and the tab read them off the card
// engine's stamped header. The suite injects the School values through these wrappers so the ~50
// existing cases stay about what they were testing; the REQUIRED-ness itself is covered explicitly by
// its own describe block below, against the raw (unwrapped) exports.
const PATHS = { triggerRoot: 'EventPack.triggers', armedPath: 'World_Calc.EventArmed' };
const applyEventPacks = (sd, packs, opts) => applyEventPacksRaw(sd, packs, { ...PATHS, ...opts });
const pruneEventPack = (sd, id, opts) => pruneEventPackRaw(sd, id, { ...PATHS, ...opts });
const reconcileEventPacks = (sd, reg, entries, opts) => reconcileEventPacksRaw(sd, reg, entries, { ...PATHS, ...opts });
const lintPackEjs = (text, opts) => lintPackEjsRaw(text, { ...PATHS, ...opts });

// ── fixtures ─────────────────────────────────────────────────────────────────

const row = (over = {}) => ({
    cat: 'TRG', series: 'BeachArc', prereq: 'Quest(BeachArc).Step==0',
    when: 'Wkd=Saturday & T>=10:00 & Aff(Yuki)>=40',
    fx: { summary: 'Beach day begins.', scope: 'arc', writes: [{ path: 'Mainchar.Quests', key: 'paulk_beacharc_quest', set: { Step: 1, Title: 'Beach Arc', Status: 'On-going' } }] },
    ...over,
});

// A parsed-pack fixture (what parseEventPacks emits) — prose carries the matching gate + eventFire.
const pack = (over = {}) => {
    const triggers = over.triggers || { paulk_beacharc_1: row() };
    const prose = over.prose !== undefined ? over.prose
        : Object.keys(triggers).map((k) => `<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@${k}') { _%>\n  DO …\n  FIRE emit /Intent/eventFire "${k}" → …\n<%_ } _%>`).join('\n');
    return {
        packId: 'paulk.beacharc', format: '1.0', creator: 'paulK', event: 'BeachArc', version: '1.0',
        entrySize: 500, comment: '[MVU_Event_Pack] paulk.beacharc',
        ...over, triggers, prose,
    };
};

const entryText = (json, bodies = '') =>
    `<%_ if (false) { _%>\n<mvueventpack>\n${JSON.stringify(json, null, 2)}\n</mvueventpack>\n<%_ } _%>\n${bodies}`;

const freshSave = () => ({
    World_Calc: { EventArmed: ['', 'armed event'], Events: { leila_1: { state: 'done' } } },
    EventPack: {
        triggers: { leila_1: row({ series: 'Leila' }) },   // official base row (un-owned)
        installed: {},
    },
    Mainchar: { Quests: {} },
});

// ── identity ─────────────────────────────────────────────────────────────────

describe('slug / packId / keyPrefix', () => {
    it('lowercases, spaces→_, strips the rest', () => expect(slug('Beach Arc!')).toBe('beach_arc'));
    it('packId joins slugs with a dot', () => expect(packId({ creator: 'paulK', event: 'BeachArc' })).toBe('paulk.beacharc'));
    it('keyPrefix joins slugs with underscores', () => expect(keyPrefix({ creator: 'paulK', event: 'BeachArc' })).toBe('paulk_beacharc_'));
});

// ── P4b: the paths are REQUIRED, and the refusal is a THROW, not a default ───────────────────
// The old `getEventPackConfig()` stub returned School's two paths as a constant, which made this
// module a third independent copy of what globalLogic's adapter already owns. The dangerous part
// was never the duplication — it was that a disagreement is SILENT: rows merge into a table the
// engine never reads, so the pack reports installed, the LED is green, and no event can ever fire.
// A missing path therefore has to be impossible to ignore.
describe('the scanner paths are REQUIRED opts (P4b)', () => {
    const sd = () => ({ EventPack: { triggers: {}, installed: {} } });
    const cases = {
        'no opts at all': undefined,
        'empty opts': {},
        'triggerRoot only': { triggerRoot: 'EventPack.triggers' },
        'armedPath only': { armedPath: 'World_Calc.EventArmed' },
        'an empty string path': { triggerRoot: '', armedPath: 'World_Calc.EventArmed' },
        'a non-string path': { triggerRoot: 42, armedPath: 'World_Calc.EventArmed' },
    };
    for (const [label, opts] of Object.entries(cases)) {
        it(`applyEventPacks THROWS with ${label}`, () =>
            expect(() => applyEventPacksRaw(sd(), [], opts)).toThrow(/REQUIRED \(P4b\)/));
    }
    it('names the field that is missing, so the fix is obvious', () =>
        expect(() => applyEventPacksRaw(sd(), [], { triggerRoot: 'EventPack.triggers' })).toThrow(/opts\.armedPath/));
    // The library keeps its install record and fired markers BESIDE the trigger table, so a root with
    // no dot has nowhere to put them: the record would land on stat_data itself.
    it('THROWS on a trigger root with no dot — its sibling stores would have no parent', () =>
        expect(() => applyEventPacksRaw(sd(), [], { triggerRoot: 'Triggers', armedPath: 'State.Armed' })).toThrow(/must be a dotted path/));
    it('reconcileEventPacks, pruneEventPack and lintPackEjs refuse the same way', () => {
        expect(() => reconcileEventPacksRaw(sd(), {}, [])).toThrow(/REQUIRED \(P4b\)/);
        expect(() => pruneEventPackRaw(sd(), 'x')).toThrow(/REQUIRED \(P4b\)/);
        expect(() => lintPackEjsRaw('just text')).toThrow(/REQUIRED \(P4b\)/);
    });
    it('accepts a NON-School root, which is the whole point of reading it from the card', () => {
        const alt = { Story: { events: {}, installed: {} }, State: { Armed: '' } };
        const res = applyEventPacksRaw(alt, [pack()], { triggerRoot: 'Story.events', armedPath: 'State.Armed' });
        expect(res.reports[0].applied).toBe(true);
        expect(Object.keys(alt.Story.events)).toContain('paulk_beacharc_1');
        expect(alt.EventPack).toBeUndefined();          // nothing leaked back to the hardcoded root
    });
});

describe('installedRootOf / firedRootOf — the library stores sit beside the trigger table (P4b)', () => {
    it('derives the sibling root instead of respelling it', () => {
        expect(installedRootOf('EventPack.triggers')).toBe('EventPack.installed');
        expect(installedRootOf('Story.deep.events')).toBe('Story.deep.installed');
        expect(firedRootOf('EventPack.triggers')).toBe('EventPack.fired');
        expect(firedRootOf('Story.deep.events')).toBe('Story.deep.fired');
    });
    // Same answer as eventpack.cjs's siblingRoot: no dot, no sibling. '' is what makes the fired
    // count read "unknown" instead of "0 fired" when the card declares no trigger root.
    it('a root with no dot (or none at all) has no sibling', () => {
        for (const root of ['Triggers', '', undefined]) {
            expect(installedRootOf(root)).toBe('');
            expect(firedRootOf(root)).toBe('');
        }
    });
});

// THE ONE SHAPE of the armed pointer: MVU's [value, label] pair, the way MvuStatMenuBuilder builds the
// variable. Its body gates read `[0]`, which never matches on any other shape.
describe('armedPointerShapeProblem — the armed pointer is an MVU [value, label] pair', () => {
    const at = (value) => ({ State: { Armed: value } });
    it('a pair whose value is a string is the shape — armed or empty', () => {
        expect(armedPointerShapeProblem(at(['@k_1', 'Current Event']), 'State.Armed')).toBe('');
        expect(armedPointerShapeProblem(at(['', 'Current Event']), 'State.Armed')).toBe('');
    });
    it('an absent slot says nothing about the shape — the engine creates it on its first arm', () => {
        expect(armedPointerShapeProblem({}, 'State.Armed')).toBe('');
        expect(armedPointerShapeProblem(null, 'State.Armed')).toBe('');
    });
    it('a plain string is named, with why the gate can never open on it', () => {
        const problem = armedPointerShapeProblem(at('@k_1'), 'State.Armed');
        expect(problem).toMatch(/stat_data\.State\.Armed holds the string "@k_1"/);
        expect(problem).toMatch(/not the MVU \[value, label\] pair/);
        expect(problem).toContain("getvar('stat_data.State.Armed[0]')");
    });
    it('every other shape is named too', () => {
        expect(armedPointerShapeProblem(at(null), 'State.Armed')).toMatch(/holds null/);
        expect(armedPointerShapeProblem(at({ key: '@k_1' }), 'State.Armed')).toMatch(/holds an object/);
        expect(armedPointerShapeProblem(at([null, 'label']), 'State.Armed')).toMatch(/an array whose first item is null/);
        expect(armedPointerShapeProblem(at([]), 'State.Armed')).toMatch(/an array whose first item is nothing/);
    });
});

// ── parseEventPacks ──────────────────────────────────────────────────────────

describe('parseEventPacks', () => {
    const good = { format: '1.0', creator: 'paulK', event: 'BeachArc', version: '1.0', triggers: { paulk_beacharc_1: row() } };

    it('extracts the <mvueventpack> block from a matching entry', () => {
        const { packs, errors } = parseEventPacks([{ comment: '[MVU_Event_Pack] paulk.beacharc', content: entryText(good, 'BODY') }]);
        expect(errors).toEqual([]);
        expect(packs).toHaveLength(1);
        expect(packs[0].packId).toBe('paulk.beacharc');
        expect(packs[0].triggers.paulk_beacharc_1.cat).toBe('TRG');
        expect(packs[0].prose).toContain('BODY');
        expect(packs[0].prose).not.toContain('<mvueventpack>');
    });

    it('comment match is case-insensitive', () => {
        const { packs } = parseEventPacks([{ comment: '[mvu_EVENT_pack] x', content: entryText(good) }]);
        expect(packs).toHaveLength(1);
    });

    it('ignores non-matching entries — including the registry entry', () => {
        const { packs, errors } = parseEventPacks([
            { comment: '[MVU_Event_Pack_Registry]', content: '{"paulk.beacharc":{"ver":"1.0"}}' },
            { comment: '[MVU_Update_Data] sync', content: '<mvuupdatedata>{}</mvuupdatedata>' },
            { comment: 'Event_Schedule', content: 'prose' },
        ]);
        expect(packs).toEqual([]);
        expect(errors).toEqual([]);
    });

    // ▲ WAS "format defaults to 1.0 when absent" (P9 §5a.9). It no longer defaults: the coalescing made
    // an omission indistinguishable from a deliberate "1.0", so the field could never be enforced. It
    // borrowed §3.1a's ENGINE rationale ("an unstamped engine PREDATES the marker") into a case where it
    // does not hold — a pack is written by someone who could always have declared it.
    it('an ABSENT format survives as undefined, so the validator can refuse it', () => {
        const { format, ...noFmt } = good;
        const { packs } = parseEventPacks([{ comment: '[MVU_Event_Pack] x', content: entryText(noFmt) }]);
        expect(packs[0].format).toBeUndefined();
        expect(validateEventPack(packs[0], []).errors.join()).toMatch(/"format" is REQUIRED/);
    });

    it('one malformed entry does not sink the others', () => {
        const { packs, errors } = parseEventPacks([
            { comment: '[MVU_Event_Pack] broken', content: '<mvueventpack>{oops</mvueventpack>' },
            { comment: '[MVU_Event_Pack] no-block', content: 'just prose' },
            { comment: '[MVU_Event_Pack] good', content: entryText(good) },
        ]);
        expect(packs).toHaveLength(1);
        expect(packs[0].packId).toBe('paulk.beacharc');
        expect(errors).toHaveLength(2);
        expect(errors[1].error).toMatch(/carries no <mvueventpack>/);
        expect(errors[1].error).toMatch(/must sit inside that wrapper/);   // says the FIX, not just the fault
    });
});

// ── validateEventPack — ERRORS ───────────────────────────────────────────────

describe('validateEventPack: errors', () => {
    it('a fully valid pack passes with no errors or warnings', () => {
        const v = validateEventPack(pack(), ['leila_1']);
        expect(v.errors).toEqual([]);
        expect(v.warnings).toEqual([]);
        expect(v.ok).toBe(true);
    });

    it('rejects missing/unsluggable creator and event', () => {
        const v = validateEventPack(pack({ creator: '!!!', event: undefined }), []);
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/creator/);
        expect(v.errors.join()).toMatch(/event/);
    });

    // "official" is the CARD's word. A pack can never hold the engine's owner value (`Official.Card`,
    // and slug() emits lowercase only), so this is about what a PLAYER reads, not about permission.
    it('rejects a creator carrying "official", whatever its case', () => {
        for (const creator of ['Official', 'OFFICIAL', 'official', 'The Official Pack']) {
            const v = validateEventPack(pack({ creator }), []);
            expect(v.ok, creator).toBe(false);
            expect(v.errors.join()).toMatch(/may not contain "official"/);
        }
    });

    it('MUTATION TARGET — the ban is on the CREATOR, so an ordinary name still passes', () => {
        expect(validateEventPack(pack({ creator: 'PaulK' }), ['leila_1']).errors.join()).not.toMatch(/official/i);
    });

    it('rejects a malformed version and a malformed format', () => {
        const v = validateEventPack(pack({ version: 'v1', format: '2' }), []);
        expect(v.errors.join()).toMatch(/version/);
        expect(v.errors.join()).toMatch(/format/);
    });

    it('rejects empty triggers', () => {
        const v = validateEventPack(pack({ triggers: {} }), []);
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/the object is empty/);
    });

    // EMPTY and WRONG-TYPE are different mistakes with different fixes, so they get different
    // messages — `"triggers": []` used to report "must be a non-empty object", which says nothing
    // about the brackets being the problem.
    it('a wrong-typed triggers names what it actually got', () => {
        // NOTE the fixture coalesces a falsy `triggers` to its default, so null/undefined are set
        // explicitly AFTER it — otherwise those two cases quietly test a valid pack.
        for (const [bad, expected] of [[[], /got an array/], ['x', /got the string/], [null, /got null/], [undefined, /the field is absent/]]) {
            const p = pack();
            p.triggers = bad;
            const v = validateEventPack(p, []);
            expect(v.ok, `triggers = ${JSON.stringify(bad)}`).toBe(false);
            expect(v.errors.join()).toMatch(expected);
            expect(v.errors.join()).toMatch(/must be an OBJECT keyed by trigger key/);
        }
    });

    it('rejects keys without the pack prefix and illegal key characters', () => {
        const v = validateEventPack(pack({ triggers: { leila_99: row(), 'paulk_beacharc_UPPER': row() } }), []);
        expect(v.errors.join()).toMatch(/prefix "paulk_beacharc_"/);
        expect(v.errors.join()).toMatch(/legal stat_data key/);
    });

    it('collision fence: rejects a key the pack does not own', () => {
        // a hostile pack claiming an official key — the prefix check catches it too (defense in depth);
        // here the collision path itself, via a foreign key that HAS the prefix (another install's row)
        const v = validateEventPack(pack(), ['paulk_beacharc_1']);
        expect(v.errors.join()).toMatch(/collides/);
    });

    it('rejects more than 20 rows', () => {
        const triggers = {};
        for (let i = 1; i <= MAX_ROWS_PER_PACK + 1; i++) triggers['paulk_beacharc_' + i] = row();
        const v = validateEventPack(pack({ triggers, prose: '' }), []);
        expect(v.errors.join()).toMatch(/21 trigger rows/);
    });

    it('rejects an oversized row and an oversized entry', () => {
        const fat = row({ when: 'x'.repeat(5000) });
        const v = validateEventPack(pack({ triggers: { paulk_beacharc_1: fat }, entrySize: 70000, prose: '' }), []);
        expect(v.errors.join()).toMatch(/row cap/);
        expect(v.errors.join()).toMatch(/65536-byte cap/);   // 64 KB entry cap
    });

    it('one series per pack: two series values is an error', () => {
        const v = validateEventPack(pack({
            triggers: { paulk_beacharc_1: row(), paulk_beacharc_2: row({ series: 'OtherArc' }) },
            prose: '',
        }), []);
        expect(v.errors.join()).toMatch(/one series per pack/);
    });
});

// ── validateEventPack — WARNINGS (consumable, but tell the author) ──────────

describe('validateEventPack: warnings', () => {
    const okKeys = (p) => validateEventPack(p, ['leila_1']);

    it('unknown row field (the preqreq typo) warns, does not block', () => {
        const v = okKeys(pack({ triggers: { paulk_beacharc_1: row({ preqreq: 'oops' }) } }));
        expect(v.ok).toBe(true);
        expect(v.warnings.join()).toMatch(/unknown field "preqreq"/);
    });

    it('cat outside TRG/TIME warns', () => {
        const v = okKeys(pack({ triggers: { paulk_beacharc_1: row({ cat: 'EVT' }) } }));
        expect(v.warnings.join()).toMatch(/cat "EVT"/);
    });

    it('DSL shapes: every legal token form passes', () => {
        const v = okKeys(pack({
            triggers: {
                paulk_beacharc_1: row({
                    prereq: '-',
                    when: 'Wkd in {Saturday,Sunday} & Present(Yuki) & flag:met_leila=done & Mainchar.Money>=500 & T>=10:00',
                }),
            },
        }));
        expect(v.warnings).toEqual([]);
    });

    // A chain ordered on anything but the engine's own fired-marker is a chain the engine cannot keep
    // closed: the genre may delete the record it reads (School sweeps a completed quest at the settle).
    it('a series with TWO flag-less rows warns — it is ordering on state the engine cannot keep', () => {
        const v = okKeys(pack({
            triggers: {
                paulk_beacharc_1: row({ prereq: 'Quest(BeachArc).Step==0' }),
                paulk_beacharc_2: row({ prereq: 'Quest(BeachArc).Step==1' }),
            },
        }));
        expect(v.ok).toBe(true);
        const w = v.warnings.filter((x) => /series "BeachArc"/.test(x));
        expect(w).toHaveLength(1);
        expect(w[0]).toMatch(/2 rows carry no flag: token in prereq \(paulk_beacharc_1, paulk_beacharc_2\)/);
    });

    it('a series whose later beats gate on flag:<previous key> does not warn — the opener alone may be flag-less', () => {
        const v = okKeys(pack({
            triggers: {
                paulk_beacharc_1: row({ prereq: undefined }),
                paulk_beacharc_2: row({ prereq: 'flag:paulk_beacharc_1' }),
                paulk_beacharc_3: row({ prereq: '!flag:paulk_beacharc_9 & flag:paulk_beacharc_2 & DaysSince(EventPack.fired.paulk_beacharc_2.at)>=1' }),
            },
        }));
        expect(v.warnings.filter((x) => /series "BeachArc"/.test(x))).toEqual([]);
    });

    it('a malformed token warns (and an op-only token is not mistaken for a comparison)', () => {
        const v = okKeys(pack({ triggers: { paulk_beacharc_1: row({ when: 'Aff(Yuki) 40 & >=40' }) } }));
        expect(v.warnings.filter((w) => /matches no known shape/.test(w))).toHaveLength(2);
    });

    // A write's FIELD NAMES are the card's own schema — the builder read that schema to emit them, and
    // mvu-helper has no business knowing it. Any scope string, any field name, any path spelling.
    it('fx.writes FIELD NAMES are OPAQUE — the card\'s schema, never this installer\'s', () => {
        const v = okKeys(pack({
            triggers: {
                paulk_beacharc_1: row({
                    fx: {
                        summary: 's', scope: 'forever',                 // any scope string — the engine never interprets it
                        writes: [
                            { path: 'Ship.Cargo', key: 'paulk_beacharc_loot', set: { rarity: 'epic', table: 'wreck' } },   // a genre School does not have
                            { path: 'Mainchar.Quests', key: 'paulk_beacharc_b', set: { Step: 1, whateverField: 1 }, add: { Gold: 5 } },
                            { path: 'Mainchar.Inventory', key: 'paulk_beacharc_key', remove: true },
                        ],
                    },
                }),
            },
        }));
        expect(v.errors).toEqual([]);
        expect(v.warnings).toEqual([]);
    });

    it('…but a write\'s SHAPE is the format\'s own and is checked, and a stray fx key is named', () => {
        const v = okKeys(pack({
            triggers: {
                paulk_beacharc_1: row({ fx: { summary: 42, scope: [], loot: { rarity: 'epic' }, writes: 'not-an-array' } }),
            },
        }));
        expect(v.warnings.join()).toMatch(/fx\.summary should be a string/);
        expect(v.warnings.join()).toMatch(/fx\.scope should be a string/);
        // The level is READ, not spelled: the message names the module's own SUPPORTED_FORMAT, so a
        // version bump would otherwise look like a broken refusal (it did, at 1.1 -> 1.2).
        expect(v.warnings.join()).toContain('fx.loot is not a field of format '
            + SUPPORTED_FORMAT + ' (summary, scope, writes, reward)');
        expect(v.errors.join()).toMatch(/fx\.writes must be an ARRAY/);
    });

    it('a pack carrying a payout but declaring 1.0 is caught by the declared-vs-derived cross-check', () => {
        const v = okKeys(pack({ format: '1.0', triggers: { paulk_beacharc_1: row({ fx: { summary: 's', reward: { stat: { Cha: 5 } } } }) } }));
        const said = v.errors.join() + v.warnings.join();
        expect(said).toMatch(/1\.1/);
        expect(said).toMatch(/fx\.reward/);
    });

    it('fx.reward is { kind: { field: amount } } — anything else is an ERROR that names the kind', () => {
        const v = okKeys(pack({
            triggers: {
                paulk_beacharc_1: row({ fx: { summary: 's', reward: 'five' } }),
                paulk_beacharc_2: row({ fx: { summary: 's', reward: { stat: 5 } } }),
                paulk_beacharc_3: row({ fx: { summary: 's', reward: { stat: { Cha: true } } } }),
            },
        }));
        expect(v.errors.join()).toMatch(/fx\.reward must be an object of kind: \{ field: amount \}/);
        expect(v.errors.join()).toMatch(/fx\.reward\.stat: must be an object of field: amount pairs/);
        expect(v.errors.join()).toMatch(/fx\.reward\.stat\.Cha: an amount must be a number, or text for a prose reward/);
    });

    it('a STRING is a prose payout, not an error — whether THIS card pays prose is the installer\'s question', () => {
        const v = okKeys(pack({ format: '1.1', triggers: { paulk_beacharc_1: row({ fx: { summary: 's', reward: { appearance: { Cup_Size: 'F Cup' } } } }) } }));
        expect(v.errors).toEqual([]);
        const blank = okKeys(pack({ format: '1.1', triggers: { paulk_beacharc_1: row({ fx: { summary: 's', reward: { appearance: { Cup_Size: '  ' } } } }) } }));
        expect(blank.errors).toEqual([]);
        expect(blank.warnings.join()).toMatch(/fx\.reward\.appearance\.Cup_Size: a blank pays nothing/);
    });

    it('a KEYED payout validates as a shape, with the member named in the message', () => {
        const v = okKeys(pack({
            format: '1.1',
            triggers: {
                paulk_beacharc_1: row({ fx: { summary: 's', reward: { heroine: { Mitsuki: { Cha: 5, Lewdness: true } } } } }),
                paulk_beacharc_2: row({ fx: { summary: 's', reward: { heroine: { Mitsuki: {} } } } }),
            },
        }));
        expect(v.errors.join()).toMatch(/fx\.reward\.heroine\.Mitsuki\.Lewdness: an amount must be a number, or text for a prose reward/);
        expect(v.warnings.join()).toMatch(/fx\.reward\.heroine\.Mitsuki: pays no field/);
        expect(v.errors.join()).not.toMatch(/Cha/);            // the good field beside it is untouched
    });

    it('a payout that pays nothing is a WARNING — it installs and does nothing, which the author should hear', () => {
        const v = okKeys(pack({
            format: '1.1',
            triggers: {
                paulk_beacharc_1: row({ fx: { summary: 's', reward: { stat: {} } } }),
                paulk_beacharc_2: row({ fx: { summary: 's', reward: { stat: { Cha: 0 } } } }),
            },
        }));
        expect(v.errors).toEqual([]);
        expect(v.warnings.join()).toMatch(/fx\.reward\.stat: pays no field/);
        expect(v.warnings.join()).toMatch(/fx\.reward\.stat\.Cha: an amount of 0 pays nothing/);
    });

    it('an AMOUNT is never judged here — the ceiling belongs to the card\'s own engine', () => {
        const v = okKeys(pack({ format: '1.1', triggers: { paulk_beacharc_1: row({ fx: { summary: 's', reward: { stat: { Cha: 9999 } } } }) } }));
        expect(v.errors).toEqual([]);
        expect(v.warnings.join()).not.toMatch(/9999/);
    });

    it('each write is { path, key?, set?, add?, remove? } — anything else is an ERROR that names the write', () => {
        const v = okKeys(pack({
            triggers: {
                paulk_beacharc_1: row({ fx: { writes: [
                    'a string',
                    { key: 'paulk_beacharc_x', set: { a: 1 } },                       // no path
                    { path: 'bad path!', key: 'paulk_beacharc_x', set: { a: 1 } },
                    { path: 'Mainchar.Quests', key: 'paulk_beacharc_a.b', set: { a: 1 } },   // a delimiter in the key
                    { path: 'Mainchar.Quests', key: 'paulk_beacharc_x', set: 'nope' },
                    { path: 'Mainchar.Quests', key: 'paulk_beacharc_x', remove: 'yes' },
                    { path: 'Mainchar.Quests', key: 'paulk_beacharc_x' },                    // writes nothing
                ] } }),
            },
        }));
        const e = v.errors.join('\n');
        expect(e).toMatch(/fx\.writes\[0\]: must be an object/);
        expect(e).toMatch(/fx\.writes\[1\]: "path" must be a dotted stat_data path/);
        expect(e).toMatch(/fx\.writes\[2\]: "path" must be a dotted stat_data path/);
        expect(e).toMatch(/fx\.writes\[3\]: key "paulk_beacharc_a\.b" contains/);
        expect(e).toMatch(/fx\.writes\[4\]: "set" must be an object/);
        expect(e).toMatch(/fx\.writes\[5\]: "remove" must be exactly true/);
        expect(v.warnings.join()).toMatch(/fx\.writes\[6\]: carries no set, add or remove/);
    });

    // OWNERSHIP is not judged here, and cannot be anywhere at install time: a pack may name any record
    // key nobody has claimed, so the engine's owner gate reads the save at fire. The only install-time
    // half is whether the card's path can record ownership at all — unstampedWritePaths, below.
    it('a key naming a record another pack owns passes SHAPE validation — ownership is decided at fire', () => {
        const v = okKeys(pack({
            triggers: { paulk_beacharc_1: row({ fx: { writes: [{ path: 'Mainchar.Quests', key: 'Leila', set: { Step: 9 } }] } }) },
        }));
        expect(v.ok).toBe(true);
        expect(v.errors.join()).not.toMatch(/owner/i);
    });
});

// ── body coverage — ERROR (▲ user 2026-08-05: both halves ship together, contiguous) ────────────────
// Escalated from warn: a row without its body is not a consumable-with-a-note pack, it is an event that
// arms and renders nothing. The builder emits both halves by construction, so a violation is a bug in
// the producer, not an author preference to be tolerated.

// ── unstampedWritePaths — D2's install-time half ──────────────────────────────────────────
// WHICH record a pack may overwrite is the engine's call at fire (it reads who made the one that is
// there). What IS knowable here is whether the card's path can record ownership at all: a path with no
// `ownerStamp` refuses every keyed pack write on it, fail-closed, so a pack asking for one is broken on
// this card however the key is spelled — and the message has to say so, or an author renames keys forever.
// A `fillOnly` path is the exception: a SHARED registry where first capture wins for every field, so a
// pack naming the world's own room key only fills blanks and needs no ownership to do it.
describe('unstampedWritePaths (can this card record who made a record?)', () => {
    const w = (path, key) => ({ path, key, set: { X: 1 } });
    const packWith = (writes) => ({ creator: "PaulK", event: "BeachArc", triggers: { paulk_beacharc_1: { fx: { writes } } } });
    const card = [{ path: 'Mainchar.Quests', ownerStamp: 'GrantedBy' }, { path: 'Mainchar.Belongings' },
                  { path: 'WorldRecord.Locations', fillOnly: true }];

    it('names a row writing a record onto a path that cannot say who made it', () => {
        expect(unstampedWritePaths(packWith([w('Mainchar.Belongings', 'Ruinblade')]), card))
            .toEqual([{ key: 'paulk_beacharc_1', path: 'Mainchar.Belongings' }]);
    });
    it('a path declaring an ownerStamp is fine — and the KEY is never judged here', () => {
        expect(unstampedWritePaths(packWith([w('Mainchar.Quests', 'Leila')]), card)).toEqual([]);
        expect(unstampedWritePaths(packWith([w('Mainchar.Quests', 'paulk_beacharc_quest')]), card)).toEqual([]);
    });
    it('a fillOnly path is SHARED — no ownership needed to fill a blank', () => {
        expect(unstampedWritePaths(packWith([w('WorldRecord.Locations', 'School_Cafeteria')]), card)).toEqual([]);
    });
    it('an empty ownerStamp is no ownerStamp — a blank field name stamps nothing', () => {
        expect(unstampedWritePaths(packWith([w('Mainchar.Quests', 'Leila')]), [{ path: 'Mainchar.Quests', ownerStamp: '' }]))
            .toEqual([{ key: 'paulk_beacharc_1', path: 'Mainchar.Quests' }]);
    });
    it('a path the card never declared belongs to unallowedWritePaths, not here', () => {
        expect(unstampedWritePaths(packWith([w('Ship.Cargo', 'anything')]), card)).toEqual([]);
    });
    it('an unknown card ⇒ no claim, like every other card-aware check', () => {
        expect(unstampedWritePaths(packWith([w('Mainchar.Belongings', 'Ruinblade')]), undefined)).toEqual([]);
        expect(unstampedWritePaths(packWith([w('Mainchar.Belongings', 'Ruinblade')]), null)).toEqual([]);
    });
    it('a keyless write (the whole collection) is not an ownership question', () => {
        expect(unstampedWritePaths(packWith([{ path: 'Mainchar.Belongings', set: { X: 1 } }]), card)).toEqual([]);
    });
});

describe('validateEventPack: body coverage is an ERROR, not a warning', () => {
    const okKeys = (p) => validateEventPack(p, ['leila_1']);

    it('a row with NO gate and NO eventFire blocks the pack', () => {
        const v = okKeys(pack({ prose: 'no gates here' }));
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/no === '@paulk_beacharc_1' gate/);
        expect(v.errors.join()).toMatch(/no eventFire "paulk_beacharc_1"/);
    });

    it('a gate WITHOUT its eventFire still blocks — the body would play but never apply fx', () => {
        const v = okKeys(pack({ prose: `<%_ if (getvar('x') === '@paulk_beacharc_1') { _%>\nDO …\n<%_ } _%>` }));
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/no eventFire/);
        expect(v.errors.join()).not.toMatch(/gate/);
    });

    it('the halves must be CONTIGUOUS: a body under ANOTHER pack\'s block does not count', () => {
        // parseUploadFile hands each pack only the prose between its own block and the next, so pack 2's
        // body sitting in pack 1's segment leaves pack 2 with a row and no body. That is the whole
        // mechanism behind "contiguous" — it is enforced by the SPLIT, not by a separate check.
        const two = [
            `<%_ if (false) { _%>\n<mvueventpack>\n${JSON.stringify({ format: '1.0', creator: 'paulk', event: 'A', version: '1.0', triggers: { paulk_a_1: row({ fx: { summary: 's' } }) } })}\n</mvueventpack>\n<%_ } _%>`,
            `<%_ if (getvar('x') === '@paulk_a_1') { _%>\nDO …\nFIRE emit /Intent/eventFire "paulk_a_1"\n<%_ } _%>`,
            `<%_ if (getvar('x') === '@paulk_b_1') { _%>\nDO …\nFIRE emit /Intent/eventFire "paulk_b_1"\n<%_ } _%>`,   // ← B's body, filed under A
            `<%_ if (false) { _%>\n<mvueventpack>\n${JSON.stringify({ format: '1.0', creator: 'paulk', event: 'B', version: '1.0', triggers: { paulk_b_1: row({ fx: { summary: 's' } }) } })}\n</mvueventpack>\n<%_ } _%>`,
        ].join('\n');
        const r = parseUploadFile(two);
        expect(validateEventPack(r.packs[0], []).ok).toBe(true);           // A is whole
        expect(validateEventPack(r.packs[1], []).ok).toBe(false);          // B's body is not B's
        expect(validateEventPack(r.packs[1], []).errors.join()).toMatch(/paulk_b_1/);
    });

    it('a pack built by the tab (both halves, one block) passes', () => {
        expect(okKeys(pack()).ok).toBe(true);
    });
});

// ── applyEventPacks ──────────────────────────────────────────────────────────

describe('applyEventPacks', () => {
    it('fresh install: rows merged, installed bookkeeping written, official rows untouched', () => {
        const sd = freshSave();
        const { changed, reports } = applyEventPacks(sd, [pack()]);
        expect(changed).toBe(true);
        expect(reports[0].applied).toBe(true);
        expect(reports[0].added).toEqual(['paulk_beacharc_1']);
        expect(sd.EventPack.triggers.paulk_beacharc_1.series).toBe('BeachArc');
        expect(sd.EventPack.triggers.leila_1).toBeDefined();                       // official base row survives
        expect(sd.EventPack.installed['paulk.beacharc']).toEqual({ ver: '1.0', keys: ['paulk_beacharc_1'] });   // keys: how the engine learns which pack a firing row belongs to
    });

    it('merged rows are clones — later pack-object mutation does not leak into stat_data', () => {
        const sd = freshSave();
        const p = pack();
        applyEventPacks(sd, [p]);
        p.triggers.paulk_beacharc_1.when = 'MUTATED';
        expect(sd.EventPack.triggers.paulk_beacharc_1.when).not.toBe('MUTATED');
    });

    // ── the currency gate (decideMerge / packRowsMatch) ──────────────────────
    // It replaced a VERSION gate plus a dev-loop arm. That pair could not tell a rebuilt pack from an
    // already-merged one, so the arm — once set — re-merged every sync and toasted each time.

    it('MUTATION TARGET — a second merge of an unchanged pack is a no-op', () => {
        const sd = freshSave();
        expect(applyEventPacks(sd, [pack()]).changed).toBe(true);
        const { changed, reports } = applyEventPacks(sd, [pack()]);
        expect(changed).toBe(false);
        expect(reports[0].skipped).toBe(true);
        expect(reports[0].reason).toMatch(/already current/);
    });

    it('MUTATION TARGET — a SAME-version rebuild whose rows changed still merges', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack()]);
        const rebuilt = pack();
        rebuilt.triggers.paulk_beacharc_1.when = 'Loc=Beach';
        const { changed, reports } = applyEventPacks(sd, [rebuilt]);
        expect(changed).toBe(true);
        expect(reports[0].applied).toBe(true);
        expect(sd.EventPack.triggers.paulk_beacharc_1.when).toBe('Loc=Beach');
    });

    it('a version bump alone rewrites the record, even with identical rows', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack()]);
        expect(applyEventPacks(sd, [pack({ version: '1.1' })]).changed).toBe(true);
        expect(sd.EventPack.installed['paulk.beacharc'].ver).toBe('1.1');
    });

    it('a save whose record claims rows it does not carry is HEALED, not skipped', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack()]);
        delete sd.EventPack.triggers.paulk_beacharc_1;        // the row went missing under the record
        expect(applyEventPacks(sd, [pack()]).changed).toBe(true);
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeDefined();
    });

    it('a DOWNGRADE merges — the card entry is the truth, and install policy is what guarded it', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack({ version: '2.0' })]);
        const { changed, reports } = applyEventPacks(sd, [pack({ version: '1.0' })]);
        expect(changed).toBe(true);
        expect(reports[0].applied).toBe(true);
        expect(sd.EventPack.installed['paulk.beacharc'].ver).toBe('1.0');
    });

    it('packRowsMatch is PER PACK — another pack being current says nothing about this one', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack()]);
        const other = pack({ creator: 'mia', event: 'CityArc', packId: 'mia.cityarc', triggers: { mia_cityarc_1: row() }, prose: undefined });
        const { reports } = applyEventPacks(sd, [pack(), other]);
        expect(reports[0].skipped).toBe(true);
        expect(reports[1].applied).toBe(true);
    });

    it('upgrade: wholesale replace — dropped rows deleted, new rows written, record updated', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack({ version: '1.0', triggers: { paulk_beacharc_1: row(), paulk_beacharc_2: row() }, prose: undefined })]);
        const v11 = pack({ version: '1.1', triggers: { paulk_beacharc_2: row({ when: 'T>=12:00' }), paulk_beacharc_3: row() }, prose: undefined });
        const { reports } = applyEventPacks(sd, [v11]);
        expect(reports[0].applied).toBe(true);
        expect(reports[0].removed).toEqual(['paulk_beacharc_1']);
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();
        expect(sd.EventPack.triggers.paulk_beacharc_2.when).toBe('T>=12:00');
        expect(sd.EventPack.installed['paulk.beacharc']).toEqual({ ver: '1.1', keys: ['paulk_beacharc_2', 'paulk_beacharc_3'] });
    });

    it('upgrade-while-armed: keeps the armed key if the new version still has it', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack()]);
        sd.World_Calc.EventArmed[0] = '@paulk_beacharc_1';
        applyEventPacks(sd, [pack({ version: '1.1' })]);
        expect(sd.World_Calc.EventArmed[0]).toBe('@paulk_beacharc_1');
    });

    it('upgrade-while-armed: clears the armed key if the new version dropped it', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack({ version: '1.0', triggers: { paulk_beacharc_1: row(), paulk_beacharc_2: row() }, prose: undefined })]);
        sd.World_Calc.EventArmed[0] = '@paulk_beacharc_1';
        const { reports } = applyEventPacks(sd, [pack({ version: '1.1', triggers: { paulk_beacharc_2: row() }, prose: undefined })]);
        expect(sd.World_Calc.EventArmed[0]).toBe('');
        expect(reports[0].warnings.join()).toMatch(/cleared World_Calc.EventArmed/);
    });

    it('never clears an armed key another pack (or the official base) owns', () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack({ version: '1.0', triggers: { paulk_beacharc_1: row(), paulk_beacharc_2: row() }, prose: undefined })]);
        sd.World_Calc.EventArmed[0] = '@leila_1';
        applyEventPacks(sd, [pack({ version: '1.1', triggers: { paulk_beacharc_2: row() }, prose: undefined })]);
        expect(sd.World_Calc.EventArmed[0]).toBe('@leila_1');
    });

    it('collision fence: a pack claiming a foreign key is skipped entirely, never partial', () => {
        const sd = freshSave();
        sd.EventPack.triggers.paulk_beacharc_2 = row();       // foreign row wearing this pack's prefix
        const twoRows = pack({ triggers: { paulk_beacharc_1: row(), paulk_beacharc_2: row() }, prose: undefined });
        const { changed, reports } = applyEventPacks(sd, [twoRows]);
        expect(changed).toBe(false);
        expect(reports[0].skipped).toBe(true);
        expect(reports[0].errors.join()).toMatch(/collides/);
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();   // row 1 NOT applied either
        expect(sd.EventPack.installed['paulk.beacharc']).toBeUndefined();
    });

    it('format gate: MAJOR ahead of the card is a hard skip', () => {
        const sd = freshSave();
        const { changed, reports } = applyEventPacks(sd, [pack({ format: '2.0' })], { cardFormat: '1.0' });
        expect(changed).toBe(false);
        expect(reports[0].skipped).toBe(true);
        expect(reports[0].reason).toMatch(/needs a newer engine/);
    });

    it('format gate: MINOR ahead installs with a soft warning', () => {
        const sd = freshSave();
        const { reports } = applyEventPacks(sd, [pack({ format: '1.1' })], { cardFormat: '1.0' });
        expect(reports[0].applied).toBe(true);
        expect(reports[0].warnings.join()).toMatch(/newer optional features/);
    });

    it('default cardFormat is SUPPORTED_FORMAT', () => {
        const sd = freshSave();
        const major = String(parseInt(SUPPORTED_FORMAT, 10) + 1) + '.0';
        const { reports } = applyEventPacks(sd, [pack({ format: major })]);
        expect(reports[0].skipped).toBe(true);
    });

    it('creates the EventPack root on a save that lacks it (fresh-chat path)', () => {
        const sd = { World_Calc: { EventArmed: ['', ''] } };
        const { reports } = applyEventPacks(sd, [pack()]);
        expect(reports[0].applied).toBe(true);
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeDefined();
        expect(sd.EventPack.installed['paulk.beacharc'].ver).toBe('1.0');
    });

    it('writes ONLY under the EventPack root — live state and other roots untouched', () => {
        const sd = freshSave();
        const before = JSON.stringify({ wc: sd.World_Calc, mc: sd.Mainchar });
        applyEventPacks(sd, [pack()]);
        expect(JSON.stringify({ wc: sd.World_Calc, mc: sd.Mainchar })).toBe(before);
    });

    it('one bad pack among several: good ones apply, bad one reports', () => {
        const sd = freshSave();
        const bad = pack({ packId: 'eve.hijack', creator: 'eve', event: 'hijack', triggers: { leila_1: row() }, prose: '' });
        const good = pack();
        const { changed, reports } = applyEventPacks(sd, [bad, good]);
        expect(changed).toBe(true);
        expect(reports[0].skipped).toBe(true);
        expect(reports[1].applied).toBe(true);
        expect(sd.EventPack.triggers.leila_1.series).toBe('Leila');   // official row not overwritten
    });

    it(`PACK_ENTRY_MATCH is the documented comment marker`, () =>
        expect(PACK_ENTRY_MATCH).toBe('[mvu_event_pack]'));
});

// ── parseRegistry ────────────────────────────────────────────────────────────

describe('parseRegistry', () => {
    it('parses bare JSON and normalizes ver to a string', () =>
        expect(parseRegistry('{"paulk.beacharc":{"ver":"1.0"}}')).toEqual({ 'paulk.beacharc': { ver: '1.0' } }));

    it('tolerates #-comment header lines', () =>
        expect(parseRegistry('# tab-owned registry — do not hand-edit\n{"a.b":{"ver":"2.1"}}')).toEqual({ 'a.b': { ver: '2.1' } }));

    it('empty content parses as an empty registry', () => expect(parseRegistry('')).toEqual({}));

    it('a non-object record normalizes to ver 0', () =>
        expect(parseRegistry('{"a.b": true}')).toEqual({ 'a.b': { ver: '0' } }));

    it('throws on malformed JSON and on a non-object root', () => {
        expect(() => parseRegistry('{oops')).toThrow();
        expect(() => parseRegistry('[1,2]')).toThrow(/must be a JSON OBJECT keyed by packId/);
        expect(() => parseRegistry('[1,2]')).toThrow(/got an array \(2 items\)/);   // names what it found
    });

    it(`the registry marker does not collide with the pack marker`, () => {
        expect(REGISTRY_ENTRY_MATCH.includes(PACK_ENTRY_MATCH)).toBe(false);
        expect(REGISTRY_ENTRY_MATCH).toBe('[mvu_event_pack_registry]');
    });
});

// ── install-lane helpers (P3b tab) ───────────────────────────────────────────

describe('lintPackEjs (§5 tab-lane EJS gate)', () => {
    it('the canonical pack shape passes', () => {
        const text = entryText({ creator: 'p', event: 'e', version: '1.0', triggers: {} },
            `<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@paulk_beacharc_1') { _%>\nDO … FIRE …\n<%_ } _%>`);
        expect(lintPackEjs(text)).toEqual({ ok: true, errors: [] });
    });

    it('any other EJS is rejected (code-free by construction)', () => {
        const v = lintPackEjs(`<%_ if (false) { _%>\n{}\n<%_ } _%>\n<%_ getvar('x'); doEvil() _%>`);
        expect(v.ok).toBe(false);
        expect(v.errors[0]).toMatch(/EJS not allowed/);
        expect(v.errors[0]).toContain("doEvil()");                      // quotes the offending chunk
        expect(v.errors[0]).toMatch(/allowed forms are exactly/);       // and CARRIES the answer
    });

    // The rejection has to be usable, not just correct: strict acceptance is paid for with a message
    // that shows the three legal forms, spelled against THIS card's own armed path.
    it('the rejection lists the three legal forms, using the card\'s real armedPath', () => {
        const v = lintPackEjs('<%_ doEvil() _%>', { triggerRoot: 'Story.events', armedPath: 'Story.armed' });
        expect(v.errors[0]).toContain("<%_ if (false) { _%>");
        expect(v.errors[0]).toContain("getvar('stat_data.Story.armed[0]')");   // not the School default
        expect(v.errors[0]).toContain('<%_ } _%>');
    });

    it('a NEAR-MISS gate gets its own diagnosis, not the generic one', () => {
        const v = lintPackEjs(`<%_ if (getvar('stat_data.Wrong.Path[0]') === '@k') { _%>`);
        expect(v.ok).toBe(false);
        expect(v.errors[0]).toMatch(/looks like an armed-event gate/);
        expect(v.errors[0]).toContain("getvar('stat_data.World_Calc.EventArmed[0]')");
    });

    it('a dangling open tag counts both sides so the mismatch is obvious', () => {
        const v = lintPackEjs('prose <%_ if (false) { oops');
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/1 opening tag but only 0 complete ones/);
    });

    it('a gate on a non-armed path is rejected', () => {
        const v = lintPackEjs(`<%_ if (getvar('stat_data.Mainchar.Money[0]') === '@k') { _%><%_ } _%>`);
        expect(v.ok).toBe(false);
    });

    it("a dangling '<%' is rejected", () => {
        const v = lintPackEjs('prose <%_ if (false) { oops');
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/dangling/);
    });

    it('plain prose with no EJS passes', () => expect(lintPackEjs('just text').ok).toBe(true));
});

describe('decideInstall (§3.3 duplicate guard)', () => {
    const reg = { 'paulk.beacharc': { ver: '1.1' } };
    it('unregistered → install', () => expect(decideInstall(pack(), {})).toEqual({ action: 'install', installedVer: '' }));
    it('newer → upgrade', () => expect(decideInstall(pack({ version: '1.2' }), reg)).toEqual({ action: 'upgrade', installedVer: '1.1' }));
    it('same → reject-same', () => expect(decideInstall(pack({ version: '1.1' }), reg)).toEqual({ action: 'reject-same', installedVer: '1.1' }));
    it('older → reject-downgrade (no downgrade path)', () => expect(decideInstall(pack({ version: '1.0' }), reg)).toEqual({ action: 'reject-downgrade', installedVer: '1.1' }));
});

describe('buildRegistryContent / packEntryComment', () => {
    it('registry content round-trips through parseRegistry', () => {
        const reg = { 'paulk.beacharc': { ver: '1.0' } };
        expect(parseRegistry(buildRegistryContent(reg))).toEqual(reg);
    });
    it('pack entry comment follows the §3 convention and matches both scan needles', () => {
        const c = packEntryComment('paulk.beacharc');
        expect(c).toBe('[MVU_Event_Pack] paulk.beacharc');
        expect(c.toLowerCase().includes(PACK_ENTRY_MATCH)).toBe(true);
        expect(c.toLowerCase().includes('paulk.beacharc')).toBe(true);
    });
});

// ── packEntryWrite — the worldbook entry an installed pack becomes ───────────
describe('packEntryWrite', () => {
    const pack = {
        packId: 'paulk.riverarc',
        triggers: { paulk_riverarc_1: {}, paulk_riverarc_2: {} },
        entryContent: "<%_ if (false) { _%>\n<mvueventpack>\n{}\n</mvueventpack>\n<%_ } _%>\n",
    };
    const ARMED = 'Derived.Armed';
    // ST-Prompt-Template strips a leading `@@if <condition>` and evaluates the condition with getvar.
    const gateOf = (content) => content.split('\n')[0].replace(/^@@if /, '');
    const opens = (content, armed) => !!new Function('getvar', 'return (' + gateOf(content) + ');')(
        (p) => (p === 'stat_data.' + ARMED + '[0]' ? armed : undefined));

    it('MUTATION TARGET — the entry opens with an @@if true for exactly the pack\'s own armed keys', () => {
        const { content } = packEntryWrite(pack, { armedPath: ARMED, bodyEntry: null });
        expect(content.startsWith('@@if ')).toBe(true);
        expect(opens(content, '@paulk_riverarc_1')).toBe(true);
        expect(opens(content, '@paulk_riverarc_2')).toBe(true);
        expect(opens(content, '@someone_else_1')).toBe(false);
        expect(opens(content, '@paulk_riverarc_10'), 'a prefix is not a key').toBe(false);
        expect(opens(content, '')).toBe(false);
        expect(opens(content, undefined)).toBe(false);
    });

    it('the pack\'s own content follows the @@if line untouched', () => {
        const { content } = packEntryWrite(pack, { armedPath: ARMED, bodyEntry: null });
        expect(content.slice(content.indexOf('\n') + 1)).toBe(pack.entryContent);
    });

    it('MUTATION TARGET — the slot the card declares lands on the entry', () => {
        const entry = packEntryWrite(pack, { armedPath: ARMED, bodyEntry: { position: 'at_depth_as_system', depth: 0, order: 750 } });
        expect(entry).toMatchObject({ position: 'at_depth_as_system', depth: 0, order: 750 });
    });

    it('no declared slot ⇒ no placement fields, so the entry keeps the host\'s default (or its current) slot', () => {
        const entry = packEntryWrite(pack, { armedPath: ARMED, bodyEntry: null });
        for (const field of ['position', 'depth', 'order']) expect(entry[field], field).toBeUndefined();
    });

    it('is the constant, keyless, enabled entry the scan needles find', () => {
        expect(packEntryWrite(pack, { armedPath: ARMED, bodyEntry: null })).toMatchObject({
            comment: packEntryComment('paulk.riverarc'), enabled: true, type: 'constant', keys: [],
        });
    });

    it('refuses to build without the card\'s armed path', () => {
        expect(() => packEntryWrite(pack, { bodyEntry: null })).toThrow(/armedPath is REQUIRED/);
    });

    it('the content still parses back as the same pack, the @@if line notwithstanding', () => {
        const json = JSON.stringify({ creator: 'paulk', event: 'riverarc', version: '1.0', triggers: {} });
        const real = { ...pack, entryContent: "<%_ if (false) { _%>\n<mvueventpack>\n" + json + "\n</mvueventpack>\n<%_ } _%>\n" };
        const entry = packEntryWrite(real, { armedPath: ARMED, bodyEntry: null });
        expect(parseEventPacks([entry]).packs.map((p) => p.packId)).toEqual(['paulk.riverarc']);
    });
});

// ── pruneEventPack ───────────────────────────────────────────────────────────

describe('pruneEventPack', () => {
    const installedSave = () => {
        const sd = freshSave();
        applyEventPacks(sd, [pack({ triggers: { paulk_beacharc_1: row(), paulk_beacharc_2: row() }, prose: undefined })]);
        return sd;
    };

    it('removes owned rows, drops the record, leaves official rows and fired state', () => {
        const sd = installedSave();
        const p = pruneEventPack(sd, 'paulk.beacharc');
        expect(p.changed).toBe(true);
        expect(p.removed).toEqual(['paulk_beacharc_1', 'paulk_beacharc_2']);
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();
        expect(sd.EventPack.installed['paulk.beacharc']).toBeUndefined();
        expect(sd.EventPack.triggers.leila_1).toBeDefined();
        expect(sd.World_Calc.Events.leila_1.state).toBe('done');   // history untouched
    });

    it('clears the armed slot when it holds an owned key', () => {
        const sd = installedSave();
        sd.World_Calc.EventArmed[0] = '@paulk_beacharc_2';
        const p = pruneEventPack(sd, 'paulk.beacharc');
        expect(p.clearedArmed).toBe('paulk_beacharc_2');
        expect(sd.World_Calc.EventArmed[0]).toBe('');
    });

    it('leaves a foreign armed key alone', () => {
        const sd = installedSave();
        sd.World_Calc.EventArmed[0] = '@leila_1';
        const p = pruneEventPack(sd, 'paulk.beacharc');
        expect(p.clearedArmed).toBe(null);
        expect(sd.World_Calc.EventArmed[0]).toBe('@leila_1');
    });

    it('no per-chat record → no-op', () => {
        const sd = freshSave();
        const p = pruneEventPack(sd, 'paulk.beacharc');
        expect(p).toEqual({ changed: false, removed: [], clearedArmed: null });
    });

    // ONE shape (armedPointerShapeProblem). Anything else is left exactly as found: the sync pass
    // names it every chat load, and writing a shape the format does not have would be a silent fix.
    it('a plain-string armed slot is never written, even when it names an owned key', () => {
        const sd = installedSave();
        sd.World_Calc.EventArmed = '@paulk_beacharc_2';
        const p = pruneEventPack(sd, 'paulk.beacharc');
        expect(p.clearedArmed).toBe(null);
        expect(sd.World_Calc.EventArmed).toBe('@paulk_beacharc_2');
        expect(p.removed).toEqual(['paulk_beacharc_1', 'paulk_beacharc_2']);   // the rows still go
    });
});

// ── reconcileEventPacks (§5.5 scan) ──────────────────────────────────────────

describe('reconcileEventPacks', () => {
    const goodJson = { format: '1.0', creator: 'paulK', event: 'BeachArc', version: '1.0', triggers: { paulk_beacharc_1: row() } };
    const bodies = `<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@paulk_beacharc_1') { _%>\nDO … FIRE emit /Intent/eventFire "paulk_beacharc_1"\n<%_ } _%>`;
    const packEntry = (over = {}) => ({ comment: '[MVU_Event_Pack] paulk.beacharc', content: entryText(goodJson, bodies), enabled: true, ...over });
    const registry = { 'paulk.beacharc': { ver: '1.0' } };

    it('registered + enabled entry merges (fresh chat auto-apply)', () => {
        const sd = freshSave();
        const { changed, reports } = reconcileEventPacks(sd, registry, [packEntry()]);
        expect(changed).toBe(true);
        expect(reports[0].action).toBe('merged');
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeDefined();
        expect(sd.EventPack.installed['paulk.beacharc'].ver).toBe('1.0');
    });

    it('second scan is the version-gate fast path (no writes, action skipped)', () => {
        const sd = freshSave();
        reconcileEventPacks(sd, registry, [packEntry()]);
        const { changed, reports } = reconcileEventPacks(sd, registry, [packEntry()]);
        expect(changed).toBe(false);
        expect(reports[0].action).toBe('skipped');
    });

    it('disabled entry prunes rows; re-enable re-merges (record was dropped, not version-blocked)', () => {
        const sd = freshSave();
        reconcileEventPacks(sd, registry, [packEntry()]);
        const r2 = reconcileEventPacks(sd, registry, [packEntry({ enabled: false })]);
        expect(r2.reports[0].action).toBe('disabled');
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();
        const r3 = reconcileEventPacks(sd, registry, [packEntry()]);
        expect(r3.reports[0].action).toBe('merged');
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeDefined();
    });

    it('registered but entry hand-deleted → auto-disable prune, action missing', () => {
        const sd = freshSave();
        reconcileEventPacks(sd, registry, [packEntry()]);
        sd.World_Calc.EventArmed[0] = '@paulk_beacharc_1';
        const { reports } = reconcileEventPacks(sd, registry, []);
        expect(reports[0].action).toBe('missing');
        expect(reports[0].removed).toEqual(['paulk_beacharc_1']);
        expect(reports[0].clearedArmed).toBe('paulk_beacharc_1');
        expect(sd.EventPack.installed['paulk.beacharc']).toBeUndefined();
    });

    it('registered entry that no longer parses → report only, NO destructive action', () => {
        const sd = freshSave();
        reconcileEventPacks(sd, registry, [packEntry()]);
        const broken = packEntry({ content: '<mvueventpack>{oops</mvueventpack>' });
        const { changed, reports } = reconcileEventPacks(sd, registry, [broken]);
        expect(changed).toBe(false);
        expect(reports[0].action).toBe('malformed');
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeDefined();   // live rows survive a typo mid-edit
        expect(sd.EventPack.installed['paulk.beacharc']).toBeDefined();
    });

    it('per-chat record with no registry record → uninstall propagation prune', () => {
        const sd = freshSave();
        reconcileEventPacks(sd, registry, [packEntry()]);
        const { reports } = reconcileEventPacks(sd, {}, [packEntry()]);   // registry record gone (uninstalled elsewhere)
        expect(reports[0].action).toBe('uninstalled');
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();
        expect(sd.EventPack.installed['paulk.beacharc']).toBeUndefined();
    });

    it('unregistered [MVU_Event_Pack] entries are ignored entirely', () => {
        const sd = freshSave();
        const { changed, reports } = reconcileEventPacks(sd, {}, [packEntry()]);
        expect(changed).toBe(false);
        expect(reports).toEqual([]);
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();
    });

    it('upgrade propagates: newer entry version re-merges over the per-chat record', () => {
        const sd = freshSave();
        reconcileEventPacks(sd, registry, [packEntry()]);
        const v11 = { ...goodJson, version: '1.1', triggers: { paulk_beacharc_1: row({ when: 'T>=12:00' }) } };
        const { reports } = reconcileEventPacks(sd, { 'paulk.beacharc': { ver: '1.1' } },
            [packEntry({ content: entryText(v11, bodies) })]);
        expect(reports[0].action).toBe('merged');
        expect(sd.EventPack.triggers.paulk_beacharc_1.when).toBe('T>=12:00');
        expect(sd.EventPack.installed['paulk.beacharc'].ver).toBe('1.1');
    });

    it('validation-error pack reports action error, nothing applied', () => {
        const sd = freshSave();
        const hijack = { creator: 'paulK', event: 'BeachArc', version: '1.0', triggers: { leila_1: row() } };
        const { changed, reports } = reconcileEventPacks(sd, registry, [packEntry({ content: entryText(hijack) })]);
        expect(changed).toBe(false);
        expect(reports[0].action).toBe('error');
        expect(sd.EventPack.triggers.leila_1.series).toBe('Leila');
    });
});

// ── P8 §6.6 actor-3: same-round body extraction (extractArmedBody / findArmedBody) ──────────────
// The PRE→narrate seam pulls the `=== '@<key>'`-gated DO body from a body entry (official
// event_schedule.txt OR a community pack's prose half — identical gate). Coverage: the flat-gate
// boundary, prefix-collision safety (@leila_1 vs @leila_10), delimiter tolerance, and entry search.
describe('extractArmedBody / findArmedBody (same-round body delivery)', () => {
    // a body entry with a truthy-armed PREAMBLE gate ahead of its per-@key gates.
    const schedule = [
        "<%_ if (getvar('stat_data.World_Calc.EventArmed[0]')) { _%>",
        '# An EVENT is ARMED — play the @KEY body below.',
        '<%_ } _%>',
        "<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@leila_1') { _%>",
        '@leila_1  Goddess of Love & Lust ·1',
        '  DO  Deep in the ruins, Leila manifests. FIRST meeting only.',
        '  FIRE  emit /Intent/eventFire "leila_1"',
        '<%_ } _%>',
        "<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@leila_10') { _%>",
        '@leila_10  decoy step ten',
        '  DO  should never be pulled by a leila_1 query.',
        '<%_ } _%>',
    ].join('\n');

    it('extracts exactly the @key body, gate wrapper stripped', () => {
        const body = extractArmedBody(schedule, 'leila_1');
        expect(body).toContain('Deep in the ruins');
        expect(body).toContain('/Intent/eventFire "leila_1"');
        expect(body.startsWith('@leila_1')).toBe(true);   // trimmed to the block
    });
    it('stops at the flat close — never bleeds into the next gate', () => {
        const body = extractArmedBody(schedule, 'leila_1');
        expect(body).not.toContain('decoy step ten');
        expect(body).not.toContain('@leila_10');
        expect(body).not.toContain('An EVENT is ARMED');   // the preamble (no === gate) is not a @key body
    });
    it('is prefix-collision safe (@leila_1 does not match inside @leila_10)', () => {
        expect(extractArmedBody(schedule, 'leila_10')).toContain('decoy step ten');   // the real @leila_10 body
        expect(extractArmedBody(schedule, 'leila_1')).not.toContain('decoy');          // not the leila_10 one
    });
    it('returns "" for a key with no gated body', () => {
        expect(extractArmedBody(schedule, 'leila_2')).toBe('');
        expect(extractArmedBody('', 'leila_1')).toBe('');
        expect(extractArmedBody(schedule, '')).toBe('');
    });
    it('tolerates non-trim EJS delimiters (<% … %>)', () => {
        const nonTrim = "<% if (getvar('stat_data.World_Calc.EventArmed[0]') === '@yuki_1') { %>\n@yuki_1  hi\n  DO  a beat.\n<% } %>";
        expect(extractArmedBody(nonTrim, 'yuki_1')).toContain('a beat.');
    });

    const entry = (content, over = {}) => ({ comment: '[EVENT_SCHEDULE]', content, enabled: true, ...over });
    it('findArmedBody locates the entry carrying the gate', () => {
        const hit = findArmedBody([entry('no gates here'), entry(schedule)], 'leila_1');
        expect(hit).not.toBeNull();
        expect(hit.body).toContain('Deep in the ruins');
        expect(hit.entry.content).toBe(schedule);
    });
    it('findArmedBody skips disabled entries (matches the live render gate)', () => {
        expect(findArmedBody([entry(schedule, { enabled: false })], 'leila_1')).toBeNull();
        const hit = findArmedBody([entry(schedule, { enabled: false }), entry(schedule)], 'leila_1');
        expect(hit && hit.entry.enabled).toBe(true);
    });
    it('findArmedBody returns null when no entry has the key', () => {
        expect(findArmedBody([entry('nope'), entry(schedule)], 'nobody_9')).toBeNull();
        expect(findArmedBody([], 'leila_1')).toBeNull();
    });
});

// P4a gate tests appended below.
describe('applyEventPacks — the format gate against the CARD engine (§3.1a)', () => {
    // Reuses the file's own pack()/freshSave() fixtures — the gate is about `format`, and a
    // hand-rolled pack here would be testing the fixture, not the gate.
    it('HARD SKIPS a pack whose MAJOR exceeds the card engine — never installed-and-dead', () => {
        const sd = freshSave();
        const res = applyEventPacks(sd, [pack({ format: '2.0' })], { cardFormat: '1.0' });
        const r = res.reports[0];
        expect(r.applied).toBe(false);
        expect(r.reason).toContain('needs a newer engine');
        expect(res.changed).toBe(false);
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();   // nothing landed
    });

    it('INSTALLS with a soft warn when only the MINOR is newer — additive, so it degrades', () => {
        const res = applyEventPacks(freshSave(), [pack({ format: '1.3' })], { cardFormat: '1.0' });
        expect(res.reports[0].applied).toBe(true);
        expect(res.reports[0].warnings.join(' ')).toContain('newer optional features');
    });

    it('installs clean at the same level, and when the CARD is ahead of the pack', () => {
        expect(applyEventPacks(freshSave(), [pack({ format: '1.0' })], { cardFormat: '1.0' }).reports[0].applied).toBe(true);
        expect(applyEventPacks(freshSave(), [pack({ format: '1.0' })], { cardFormat: '2.0' }).reports[0].applied).toBe(true);
    });

    it('a 2.0 card runs 2.0 packs — the gate must not block the case P7 creates', () => {
        expect(applyEventPacks(freshSave(), [pack({ format: '2.0' })], { cardFormat: '2.0' }).reports[0].applied).toBe(true);
    });

    it('reconcileEventPacks passes cardFormat through — the sync pass is the real caller', () => {
        const sd = freshSave();
        const entries = [{ comment: '[MVU_Event_Pack] paulk.beacharc', content: entryText(pack({ format: '2.0' })) }];
        const res = reconcileEventPacks(sd, { 'paulk.beacharc': { ver: '1.0' } }, entries, { cardFormat: '1.0' });
        // Its OWN action, not 'error' and not a plain 'skipped'. Before P4a a format hard-skip
        // reported as 'skipped' with changed:false, which falls through every branch of the sync
        // pass's report loop -- no log, no toast, the pack silently never installing. `reason`
        // alone cannot carry this: an already-installed version sets it too, and that one is a
        // legitimately quiet no-op.
        expect(res.reports[0].action).toBe('incompatible');
        expect(res.reports[0].reason).toContain('needs a newer engine');
        expect(sd.EventPack.triggers.paulk_beacharc_1).toBeUndefined();
    });

    it('an ordinary already-installed no-op stays QUIET — only a real incompatibility speaks', () => {
        const sd = freshSave();
        const bodies = `<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@paulk_beacharc_1') { _%>
DO … FIRE emit /Intent/eventFire "paulk_beacharc_1"
<%_ } _%>`;
        const entries = [{ comment: '[MVU_Event_Pack] paulk.beacharc', content: entryText(pack({ format: '1.0' }), bodies) }];
        const registry = { 'paulk.beacharc': { ver: '1.0' } };
        expect(reconcileEventPacks(sd, registry, entries, { cardFormat: '1.0' }).reports[0].action).toBe('merged');
        const res = reconcileEventPacks(sd, registry, entries, { cardFormat: '1.0' });
        expect(res.reports[0].action).toBe('skipped');
        expect(res.reports[0].incompatible).toBeFalsy();
    });
});

// ── format 2.0 (P7): the validator's view of `whenAny` ───────────────────────
describe('validateEventPack — whenAny, the OR form (§4b)', () => {
    const rowWith = (over) => ({ cat: 'TRG', series: 'BeachArc', prereq: 'Quest(BeachArc).Step==0', fx: { summary: 's' }, ...over });
    const packWith = (row) => pack({ format: '1.0', triggers: { paulk_beacharc_1: row } });
    const v = (row) => validateEventPack(packWith(row), []);

    it('accepts whenAny as a non-empty array of AND-chains', () => {
        const r = v(rowWith({ whenAny: ['Aff(Yuki)>10', 'Aff(Yuki)>5 & Present(Yuki)'] }));
        expect(r.errors).toEqual([]);
        expect(r.warnings.filter((w) => /matches no known shape/.test(w))).toEqual([]);
    });

    it('LINTS every alternative, naming which one is malformed', () => {
        const r = v(rowWith({ whenAny: ['Aff(Yuki)>10', 'garbage('] }));
        expect(r.warnings.join(' ')).toContain('whenAny[1]');
    });

    it('ERRORS on both when and whenAny — the engine takes whenAny, so `when` would vanish silently', () => {
        const r = v(rowWith({ when: 'Aff(Yuki)>10', whenAny: ['Aff(Yuki)>20'] }));
        expect(r.errors.join(' ')).toContain('BOTH "when" and "whenAny"');
    });

    it('ERRORS on an empty or non-string whenAny — "no alternative can hold" means never fires', () => {
        expect(v(rowWith({ whenAny: [] })).errors.join(' ')).toContain('non-empty array');
        expect(v(rowWith({ whenAny: 'Aff(Yuki)>10' })).errors.join(' ')).toContain('non-empty array');
        expect(v(rowWith({ whenAny: [5] })).errors.join(' ')).toContain('non-empty array');
    });

    it('accepts contains/has/! in a plain when-chain', () => {
        const r = v(rowWith({ when: '!Present(Yuki) & has(Classmate.*.Equipment, "camera") & contains(Mainchar.Notes, "beach")' }));
        expect(r.warnings.filter((w) => /matches no known shape/.test(w))).toEqual([]);
    });

    it('still warns on a NEGATED typo — `!` must not launder garbage into a valid token', () => {
        const r = v(rowWith({ when: '!garbage(' }));
        expect(r.warnings.join(' ')).toContain('matches no known shape');
    });
});

// ── MULTI-PACK UPLOAD FILES (spec change 2026-08-05) ────────────────────────
// An author writing a long chain reaches for ONE file, and so does an author writing two heroines.
// Both used to fail SILENTLY: the block regex was non-global, so only the first pack was read AND
// only the first was stripped from prose — every later block's raw JSON survived into the prose and
// was injected into the prompt as story text. Storage is unchanged: one entry per pack.
describe('parseUploadFile — several packs in one upload file', () => {
    const blk = (event, key, series = 'Leila') => `<%_ if (false) { _%>
<mvueventpack>
${JSON.stringify({ format: '1.0', creator: 'paulk', event, version: '1.0', triggers: { [key]: row({ series }) } })}
</mvueventpack>
<%_ } _%>
<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@${key}') { _%>
BODY ${key}
<%_ } _%>`;

    it('parses EVERY block, in order', () => {
        const r = parseUploadFile([blk('Leila1', 'paulk_leila1_1'), blk('Leila2', 'paulk_leila2_1')].join('\n\n'));
        expect(r.errors).toEqual([]);
        expect(r.packs.map((p) => p.packId)).toEqual(['paulk.leila1', 'paulk.leila2']);
    });

    it('gives each pack ONLY its own prose — the leak that made this silent', () => {
        const r = parseUploadFile([blk('Leila1', 'paulk_leila1_1'), blk('Leila2', 'paulk_leila2_1')].join('\n\n'));
        expect(r.packs[0].prose).toContain('BODY paulk_leila1_1');
        expect(r.packs[0].prose).not.toContain('BODY paulk_leila2_1');
        expect(r.packs[0].prose).not.toContain('mvueventpack');      // ← no raw JSON reaching the prompt
        expect(r.packs[1].prose).toContain('BODY paulk_leila2_1');
        expect(r.packs[1].prose).not.toContain('BODY paulk_leila1_1');
    });

    it('each entryContent holds one pack and re-reads as that pack', () => {
        const r = parseUploadFile([blk('Leila1', 'paulk_leila1_1'), blk('Leila2', 'paulk_leila2_1')].join('\n\n'));
        for (const p of r.packs) {
            const back = parseEventPacks([{ comment: packEntryComment(p.packId), content: p.entryContent, enabled: true }]);
            expect(back.errors).toEqual([]);
            expect(back.packs[0].packId).toBe(p.packId);
        }
        expect(r.packs[0].entryContent).not.toContain('Leila2');
        expect(r.packs[1].entryContent).not.toContain('Leila1');
    });

    it('a SINGLE-pack file still parses exactly as before', () => {
        const r = parseUploadFile(blk('Solo', 'paulk_solo_1'));
        expect(r.packs).toHaveLength(1);
        expect(r.packs[0].packId).toBe('paulk.solo');
    });

    it('two blocks may share a SERIES — that is how a 40-beat arc is written', () => {
        const r = parseUploadFile([blk('Leila1', 'paulk_leila1_1', 'Leila'), blk('Leila2', 'paulk_leila2_1', 'Leila')].join('\n'));
        expect(duplicatePackIds(r.packs)).toEqual([]);
    });

    it('but NEVER a packId — the later block would read as an UPGRADE and overwrite the first', () => {
        const r = parseUploadFile([blk('Leila', 'paulk_leila_1'), blk('Leila', 'paulk_leila_2')].join('\n'));
        expect(duplicatePackIds(r.packs)).toEqual([{ packId: 'paulk.leila', first: 0, second: 1 }]);
    });

    it('two blocks claiming ONE trigger key collide, named by BLOCK, not "an existing trigger"', () => {
        // Reachable only via a malformed key (a well-formed key carries its own packId as a prefix),
        // which is why it must be caught here: the two things that make it silent — a bad key and a
        // duplicate row — arrive together, and the later pack would overwrite the earlier one's row.
        const r = parseUploadFile([blk('Leila1', 'shared_key'), blk('Leila2', 'shared_key')].join('\n'));
        expect(duplicateTriggerKeys(r.packs)).toEqual([{ key: 'shared_key', first: 0, second: 1 }]);
    });

    it('distinct keys across blocks do NOT collide', () => {
        const r = parseUploadFile([blk('Leila1', 'paulk_leila1_1'), blk('Leila2', 'paulk_leila2_1')].join('\n'));
        expect(duplicateTriggerKeys(r.packs)).toEqual([]);
        expect(duplicateTriggerKeys([])).toEqual([]);
        expect(duplicateTriggerKeys([{ packId: 'a.b' }])).toEqual([]);   // triggers absent ⇒ not a crash
    });

    it('names WHICH block failed to parse, and reports no packs for an empty file', () => {
        const r = parseUploadFile([blk('Ok', 'paulk_ok_1'), '<mvueventpack>{ nope ]</mvueventpack>'].join('\n'));
        expect(r.errors[0].index).toBe(1);
        expect(parseUploadFile('no blocks here').errors[0].error).toContain('no <mvueventpack> block');
    });

    it('an INSTALLED entry holding two blocks is REFUSED, not half-read', () => {
        // Only reachable by hand-editing an entry, since install splits. Reading the first and
        // injecting the rest as prose is the exact failure this change removes, so it must not survive.
        const r = parseEventPacks([{ comment: '[MVU_Event_Pack] x', content: [blk('A', 'paulk_a_1'), blk('B', 'paulk_b_1')].join('\n'), enabled: true }]);
        expect(r.packs).toEqual([]);
        expect(r.errors[0].error).toContain('one pack per entry');
    });
});

// ── P9: pack METADATA — format REQUIRED, derived cross-check, builtWith (§5a.9) ──────────────
// The last silent default in pack parsing, and the hole the compat gate does not watch.
describe('pack metadata (P9 §5a.9)', () => {
    const meta = (over) => ({
        packId: 'demo.a', creator: 'demo', event: 'A', version: '1.0', entrySize: 100, comment: '',
        triggers: { demo_a_1: { cat: 'TRG', when: 'Aff(X)>=10', fx: { summary: 's' } } },
        prose: `=== '@demo_a_1' ... eventFire "demo_a_1"`,
        ...over,
    });

    it('format is REQUIRED — an omitted one is an ERROR, not a silent 1.0', () => {
        const v = validateEventPack(meta({ format: undefined }), []);
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/"format" is REQUIRED/);
        expect(v.errors.join()).toContain(SUPPORTED_FORMAT);      // tells them a number they can use
    });

    it('a declared format still validates its SHAPE', () => {
        const v = validateEventPack(meta({ format: '2' }), []);
        expect(v.errors.join()).toMatch(/"format" must be an M\.m string/);
    });

    // 1.0 is the whole grammar (eventpack_revisit D4): every form a pack can write is a 1.0 form, so a
    // pack declaring 1.0 may use them all. The cross-check's MECHANISM stays for the next format bump.
    const everyForm = {
        'contains()': { when: 'contains(Loc,"Ruins")' },
        'has()': { when: 'has(Bag,"camera")' },
        '! negation': { when: '!Present(Mitsuki)' },
        '* wildcard path': { when: 'Classmate.*.Equipment=camera' },
        'whenAny (OR groups)': { whenAny: ['Aff(X)>10', 'Aff(Y)>10'] },
        'DaysSince()': { when: 'DaysSince(Mainchar.Quests.X.LastUpdated)>=1' },
        'fx.writes': { when: 'Aff(X)>10', fx: { summary: 's', writes: [{ path: 'Mainchar.Quests', key: 'demo_a_q', set: { Step: 1 } }] } },
    };
    for (const [label, rowOver] of Object.entries(everyForm)) {
        it(`declaring 1.0 while using ${label} passes — it is a 1.0 form`, () => {
            const p = meta({ format: '1.0',
                triggers: { demo_a_1: { cat: 'TRG', fx: { summary: 's' }, ...rowOver } } });
            const v = validateEventPack(p, []);
            expect(v.errors).toEqual([]);
            expect(requiredFormat(p)).toEqual({ format: '1.0', reasons: [] });
        });
    }
    it('OVER-declaring is fine — it only narrows which cards accept the pack', () => {
        expect(validateEventPack(meta({ format: '2.0' }), []).ok).toBe(true);
    });

    it('requiredFormat reports 1.0 with no reasons for a plain 1.0 pack', () => {
        expect(requiredFormat(meta({}))).toEqual({ format: '1.0', reasons: [] });
    });

    it('builtWith is carried but NEVER gates — it is a receipt', () => {
        const withStamp = meta({ format: '1.0', builtWith: 'MvuStatMenuBuilder 1.2.0' });
        expect(validateEventPack(withStamp, []).ok).toBe(true);
        const noStamp = meta({ format: '1.0' });
        expect(validateEventPack(noStamp, []).ok).toBe(true);        // hand-authored is equally valid
    });

    it('a non-string builtWith WARNS but never blocks', () => {
        const v = validateEventPack(meta({ format: '1.0', builtWith: 42 }), []);
        expect(v.ok).toBe(true);
        expect(v.warnings.join()).toMatch(/"builtWith" should be a string/);
    });

    it('the parser preserves an OMITTED format as undefined — it no longer coalesces to 1.0', () => {
        const text = (fmt) => `<%_ if (false) { _%>\n<mvueventpack>\n{ ${fmt}"creator":"demo","event":"A","version":"1.0",` +
            `"builtWith":"Builder 9","triggers":{"demo_a_1":{"cat":"TRG","when":"Aff(X)>=10","fx":{"summary":"s"}}} }\n` +
            `</mvueventpack>\n<%_ } _%>\n=== '@demo_a_1' ... eventFire "demo_a_1"`;
        const absent = parseUploadFile(text('')).packs[0];
        expect(absent.format).toBeUndefined();          // the omission survives, so it can be REFUSED
        expect(absent.builtWith).toBe('Builder 9');
        expect(validateEventPack(absent, []).ok).toBe(false);
        const given = parseUploadFile(text('"format":"2.0",')).packs[0];
        expect(given.format).toBe('2.0');
    });

    it('an absent format still reads as 1.0 for the §3.1a MAJOR gate — the refusal comes from validate', () => {
        // fmtMajor/fmtMinor default internally, so dropping the parser's coalescing did not change the
        // gate's arithmetic; it only stopped an omission from impersonating a deliberate "1.0".
        const sd = { EventPack: { triggers: {}, installed: {} }, World_Calc: {} };
        const res = applyEventPacks(sd, [meta({ format: undefined })], { cardFormat: '2.0' });
        expect(res.reports[0].incompatible).toBeUndefined();     // not a MAJOR mismatch…
        expect(res.reports[0].applied).toBe(false);              // …but still refused
        expect(res.reports[0].errors.join()).toMatch(/"format" is REQUIRED/);
    });
});

// ── the WRITE-PATH gate (eventpack_revisit §4) ─────────────────────────────────────────────
// mvu-helper never learns what a path MEANS — it compares the paths a pack writes against the list the
// card's engine stamps (EventPack-Writes). The fixtures use paths no genre uses.
describe('write-path compatibility (eventpack_revisit)', () => {
    const packWithWrites = (writes, extraFx = {}) => ({
        packId: 'demo.a', format: '1.0', creator: 'demo', event: 'A', version: '1.0',
        entrySize: 100, comment: '',
        triggers: { demo_a_1: { cat: 'TRG', when: 'Aff(X)>=10', fx: { summary: 's', scope: 'arc', ...extraFx, writes } } },
        prose: `=== '@demo_a_1' ... eventFire "demo_a_1"`,
    });
    const w = (path) => ({ path, key: 'demo_a_k', set: { a: 1 } });

    // ── the payout twin: which KINDS a pack asks for, and which this card pays ───────────────
    const packWithReward = (reward) => ({
        id: 'demo.a', creator: 'demo', event: 'a', version: '1.0', format: '1.1',
        entrySize: 100, comment: '',
        triggers: { demo_a_1: { cat: 'TRG', when: 'Aff(X)>=10', fx: { summary: 's', scope: 'arc', reward } } },
        prose: `=== '@demo_a_1' ... eventFire "demo_a_1"`,
    });

    it('packRewardKinds collects KIND NAMES and never looks at a field or an amount', () => {
        expect(packRewardKinds(packWithReward({ stat: { Cha: 5 }, coin: { Money: 200 } })).sort())
            .toEqual(['coin', 'stat']);
        expect(packRewardKinds(packWithReward({}))).toEqual([]);
    });

    it('names the kinds THIS card does not pay', () => {
        const card = [{ name: 'stat', path: 'Mainchar', fields: ['Cha'], max: 8 }];
        expect(unallowedRewardKinds(packWithReward({ stat: { Cha: 5 }, coin: { Money: 200 } }), card)).toEqual(['coin']);
        expect(unallowedRewardKinds(packWithReward({ stat: { Cha: 5 } }), card)).toEqual([]);
    });

    it('a card that declares NO kinds pays nothing — an empty list is an answer, not "unknown"', () => {
        expect(unallowedRewardKinds(packWithReward({ stat: { Cha: 5 } }), [])).toEqual(['stat']);
    });

    it('an UNKNOWN card list reports nothing — the same rule the write paths follow', () => {
        expect(unallowedRewardKinds(packWithReward({ stat: { Cha: 5 } }), undefined)).toEqual([]);
        expect(unallowedRewardKinds(packWithReward({ stat: { Cha: 5 } }), null)).toEqual([]);
    });

    it('a row carrying a payout needs format 1.1, and one without it still needs only 1.0', () => {
        expect(requiredFormat(packWithReward({ stat: { Cha: 5 } })).format).toBe('1.1');
        expect(requiredFormat(packWithReward({ stat: { Cha: 5 } })).reasons).toContain('fx.reward');
        expect(requiredFormat(packWithReward({})).format).toBe('1.0');
        expect(requiredFormat(packWithWrites([w('Ship.Cargo')])).format).toBe('1.0');
    });

    it('a KEYED kind is collected by its kind name, not by the member it pays', () => {
        expect(packRewardKinds(packWithReward({ heroine: { Mitsuki: { Cha: 5 } } }))).toEqual(['heroine']);
    });

    it('names a payout asked for in the wrong SHAPE — the card says which kinds are keyed', () => {
        const card = [{ name: 'heroine', path: 'Classmate', keyed: true, fields: ['Cha'], max: 8 },
                      { name: 'stat', path: 'Mainchar', fields: ['Cha'], max: 8 }];
        expect(mismatchedRewardShapes(packWithReward({ heroine: { Cha: 5 } }), card)[0].problem)
            .toMatch(/this card pays one member of it — the row must name who/);
        expect(mismatchedRewardShapes(packWithReward({ stat: { Mitsuki: { Cha: 5 } } }), card)[0].problem)
            .toMatch(/this card pays Mainchar itself — there is nobody to name/);
        expect(mismatchedRewardShapes(packWithReward({ heroine: { Mitsuki: { Cha: 5 } }, stat: { Cha: 5 } }), card))
            .toEqual([]);
    });

    it('a payout typed against what the card declares — prose where it adds, a number where it writes', () => {
        const card = [{ name: 'appearance', path: 'Classmate', keyed: true, text: true, maxLength: 40, fields: ['Cup_Size'] },
                      { name: 'stat', path: 'Mainchar', fields: ['Cha'], max: 8 }];
        expect(mismatchedRewardShapes(packWithReward({ appearance: { Mitsuki: { Cup_Size: 5 } } }), card)[0].problem)
            .toMatch(/this card writes TEXT for that kind/);
        expect(mismatchedRewardShapes(packWithReward({ stat: { Cha: 'lots' } }), card)[0].problem)
            .toMatch(/this card adds a NUMBER for that kind/);
        expect(mismatchedRewardShapes(packWithReward({ appearance: { Mitsuki: { Cup_Size: 'F Cup' } }, stat: { Cha: 5 } }), card))
            .toEqual([]);
    });

    it('a kind the card does not declare at all is the KIND gate\'s finding, not the shape one\'s', () => {
        const card = [{ name: 'stat', path: 'Mainchar', fields: ['Cha'], max: 8 }];
        expect(mismatchedRewardShapes(packWithReward({ coin: { Money: 5 } }), card)).toEqual([]);
        expect(unallowedRewardKinds(packWithReward({ coin: { Money: 5 } }), card)).toEqual(['coin']);
    });

    it('an UNKNOWN card list reports no shape problems either', () => {
        expect(mismatchedRewardShapes(packWithReward({ heroine: { Cha: 5 } }), undefined)).toEqual([]);
    });

    it('packWritePaths collects PATHS and ignores the record\'s own fields and the field names', () => {
        expect(packWritePaths(packWithWrites([w('Ship.Cargo'), w('Mainchar.Quests'), w('Ship.Cargo')])).sort())
            .toEqual(['Mainchar.Quests', 'Ship.Cargo']);
    });

    it('names the paths THIS card does not allow', () => {
        const card = [{ path: 'Crew.Members', fillOnly: true }, { path: 'Ship.Cargo' }];
        expect(unallowedWritePaths(packWithWrites([w('Ship.Cargo'), w('Mainchar.Quests')]), card)).toEqual(['Mainchar.Quests']);
        expect(unallowedWritePaths(packWithWrites([w('Ship.Cargo')]), card)).toEqual([]);
    });

    it('an UNKNOWN card list reports nothing — we refuse only what we could actually ask', () => {
        expect(unallowedWritePaths(packWithWrites([w('Mainchar.Quests')]), undefined)).toEqual([]);
        expect(unallowedWritePaths(packWithWrites([w('Mainchar.Quests')]), null)).toEqual([]);
    });

    it('applyEventPacks WARNS on a mismatch but still installs — the rows arm and play, the writes are refused at fire', () => {
        const sd = { EventPack: { triggers: {}, installed: {} }, World_Calc: {} };
        const res = applyEventPacks(sd, [packWithWrites([w('Mainchar.Quests')])], { cardWrites: [{ path: 'Ship.Cargo' }, { path: 'Crew.Members' }] });
        expect(res.reports[0].applied).toBe(true);
        expect(res.reports[0].warnings.join()).toMatch(/allows no writes into Mainchar\.Quests/);
        expect(res.reports[0].warnings.join()).toMatch(/Ship\.Cargo, Crew\.Members/);      // names what it DOES allow
    });

    it('no mismatch ⇒ no warning', () => {
        const sd = { EventPack: { triggers: {}, installed: {} }, World_Calc: {} };
        const res = applyEventPacks(sd, [packWithWrites([w('Ship.Cargo')])], { cardWrites: [{ path: 'Ship.Cargo' }] });
        expect(res.reports[0].warnings.filter((x) => /allows no writes/.test(x))).toEqual([]);
    });
});
// ── scope vocabulary compatibility (pack-authoring §A.7 #4) ─────────────────────────────────
// The scope half of the fx gate. Nothing here knows what any scope MEANS — the fixtures use words no
// genre uses, and the check is "did the card spell it", never "is it the right one".
describe('scope vocabulary compatibility (pack-authoring §A.7 #4)', () => {
    const packWithRows = (scopes) => ({
        packId: 'demo.b', format: '1.0', creator: 'demo', event: 'B', version: '1.0',
        entrySize: 100, comment: '',
        triggers: Object.fromEntries(scopes.map((scope, i) => [`demo_b_${i + 1}`,
            { cat: 'TRG', when: 'Aff(X)>=10', fx: scope === undefined ? { summary: 's' } : { summary: 's', scope } }])),
        prose: scopes.map((_, i) => `=== '@demo_b_${i + 1}' ... eventFire "demo_b_${i + 1}"`).join('\n'),
    });

    it('names the rows whose scope the card never declared, and passes the rest', () => {
        expect(undeclaredScopeRows(packWithRows(['once', 'Once', 'always']), ['once', 'always']))
            .toEqual([{ key: 'demo_b_2', scope: 'Once' }]);
    });

    it('a blank or absent scope defers to the engine default and is not a claim to check', () => {
        expect(undeclaredScopeRows(packWithRows(['', undefined]), ['once'])).toEqual([]);
    });

    it('an UNKNOWN card vocabulary reports nothing — only what we could actually ask', () => {
        expect(undeclaredScopeRows(packWithRows(['Once']), undefined)).toEqual([]);
        expect(undeclaredScopeRows(packWithRows(['Once']), null)).toEqual([]);
    });

    it('applyEventPacks WARNS naming the row and the card list, and still installs', () => {
        const sd = { EventPack: { triggers: {}, installed: {} }, World_Calc: {} };
        const res = applyEventPacks(sd, [packWithRows(['Once'])], { cardScopes: ['once', 'always'] });
        expect(res.reports[0].applied).toBe(true);
        expect(res.reports[0].warnings.join()).toMatch(/"Once" \(row demo_b_1\)/);
        expect(res.reports[0].warnings.join()).toMatch(/it declares: once, always/);
    });

    it('a declared scope ⇒ no warning', () => {
        const sd = { EventPack: { triggers: {}, installed: {} }, World_Calc: {} };
        const res = applyEventPacks(sd, [packWithRows(['once'])], { cardScopes: ['once', 'always'] });
        expect(res.reports[0].warnings.filter((w) => /scope/.test(w))).toEqual([]);
    });
});

// ── P9: B1 (the fire verb) · C (the [0] tuple index) · #7a (a one-shot is not a series) ──────
describe('P9 format-level fixes (§5a.6, §5a.8)', () => {
    const base = (over) => ({
        packId: 'demo.a', format: '1.0', creator: 'demo', event: 'A', version: '1.0',
        entrySize: 100, comment: '', ...over,
    });

    it('B1: the fire verb is a NAMED format constant, not a magic string', () => {
        expect(FIRE_INTENT).toBe('eventFire');
    });

    it('B1: a body with no emit is refused, and the message says what breaks', () => {
        const v = validateEventPack(base({
            triggers: { demo_a_1: { cat: 'TRG', when: '-', fx: { summary: 's' } } },
            prose: `=== '@demo_a_1' ... (no emit here)`,
        }), []);
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/no eventFire "demo_a_1" emit/);
        expect(v.errors.join()).toMatch(/re-fires every turn/);
    });

    // The armed pointer is MVU's [value, label] pair, so the gate must read [0]. The bare spelling
    // compares the whole pair to a string and can never open, and MvuStatMenuBuilder never writes it.
    it('C: the gate must read [0]; the bare spelling is refused with the pair rule', () => {
        const P = { triggerRoot: 'EventPack.triggers', armedPath: 'World_Calc.EventArmed' };
        const tuple = `<%_ if (getvar('stat_data.World_Calc.EventArmed[0]') === '@demo_a_1') { _%>x<%_ } _%>`;
        const bare = `<%_ if (getvar('stat_data.World_Calc.EventArmed') === '@demo_a_1') { _%>x<%_ } _%>`;
        expect(lintPackEjsRaw(tuple, P).ok).toBe(true);
        const v = lintPackEjsRaw(bare, P);
        expect(v.ok).toBe(false);
        expect(v.errors).toHaveLength(1);
        expect(v.errors[0]).toMatch(/an MVU \[value, label\] pair, so the gate must read its value at \[0\]/);
        expect(v.errors[0]).toContain("getvar('stat_data.World_Calc.EventArmed[0]')");
    });

    it('C: the fence is UNCHANGED — a gate on a DIFFERENT variable is still refused', () => {
        const P = { triggerRoot: 'EventPack.triggers', armedPath: 'World_Calc.EventArmed' };
        const wrong = `<%_ if (getvar('stat_data.Mainchar.Money') === '@demo_a_1') { _%>x<%_ } _%>`;
        expect(lintPackEjsRaw(wrong, P).ok).toBe(false);
    });

    it('#7a: an arc PLUS a standalone one-shot is valid — a series-less row is not "a series"', () => {
        const v = validateEventPack(base({
            triggers: {
                demo_a_1: { cat: 'TRG', series: 'Arc', when: '-', fx: { summary: 's' } },
                demo_a_2: { cat: 'TRG', when: '-', fx: { summary: 's' } },        // no series = one-shot
            },
            prose: `=== '@demo_a_1' ... eventFire "demo_a_1"\n=== '@demo_a_2' ... eventFire "demo_a_2"`,
        }), []);
        expect(v.errors.filter((e) => /series/.test(e))).toEqual([]);
    });

    it('#7a: two GENUINE series are still refused (the rule stands)', () => {
        const v = validateEventPack(base({
            triggers: {
                demo_a_1: { cat: 'TRG', series: 'S1', when: '-', fx: { summary: 's' } },
                demo_a_2: { cat: 'TRG', series: 'S2', when: '-', fx: { summary: 's' } },
            },
            prose: `=== '@demo_a_1' ... eventFire "demo_a_1"\n=== '@demo_a_2' ... eventFire "demo_a_2"`,
        }), []);
        expect(v.errors.join()).toMatch(/spans 2 series \(S1, S2\)/);
    });

    it('the retired `check` field now warns as an ordinary unknown field — which is the truth', () => {
        const v = validateEventPack(base({
            triggers: { demo_a_1: { cat: 'TRG', when: '-', check: 'BONDING', fx: { summary: 's' } } },
            prose: `=== '@demo_a_1' ... eventFire "demo_a_1"`,
        }), []);
        expect(v.ok).toBe(true);                                   // never blocks
        expect(v.warnings.join()).toMatch(/unknown field "check"/);
    });
});

// The engine refusal ITSELF is not in question here (a pack that cannot be placed must never look
// installed) — only who hears about it. Two live wrongs, both from 2026-08-15:
//   • uninstalling the last pack leaves the registry entry holding `{}`, and the card red-toasted
//     forever about packs it no longer had;
//   • the scan runs several times per chat load, so ONE unchanging fault spoke several times.
describe('planScanRefusalNotice — the refusal stands, the shouting does not', () => {
    const REASON = 'this card exposes no engine bundle — host one in the LogicEngine tab, or …';

    it('paths resolved → says nothing AND clears the latch, so a later break still speaks', () => {
        expect(planScanRefusalNotice({ packCount: 2, refusal: null, lastAnnounced: 'a|' + REASON }))
            .toEqual({ level: null, toast: false, lastAnnounced: null });
    });

    it('ZERO packs → console only, never a toast: a card with no packs owes no engine', () => {
        const n = planScanRefusalNotice({ packCount: 0, refusal: '\n' + REASON });
        expect(n.toast).toBe(false);
        expect(n.level).toBe('verbose');
        expect(n.lastAnnounced).toBeNull();   // nothing was announced, so nothing to suppress next pass
    });

    it('packs installed + a NEW fault → toasts once and latches it', () => {
        const n = planScanRefusalNotice({ packCount: 1, refusal: 'a|' + REASON, lastAnnounced: null });
        expect(n).toEqual({ level: 'error', toast: true, lastAnnounced: 'a|' + REASON });
    });

    it('the SAME fault again → console keeps logging, the toast stays quiet', () => {
        const n = planScanRefusalNotice({ packCount: 1, refusal: 'a|' + REASON, lastAnnounced: 'a|' + REASON });
        expect(n.level).toBe('error');        // the console is the record — it never goes quiet
        expect(n.toast).toBe(false);
    });

    it('a DIFFERENT fault on the same packs → speaks again (the fix changed)', () => {
        expect(planScanRefusalNotice({ packCount: 1, refusal: 'a|typo in triggerRoot', lastAnnounced: 'a|' + REASON }).toast).toBe(true);
    });

    it('the same words on a DIFFERENT card → speaks: the pack IDs are folded into the key', () => {
        // This pass never learns which card it runs against, so identical wording is not identical news.
        expect(planScanRefusalNotice({ packCount: 1, refusal: 'b|' + REASON, lastAnnounced: 'a|' + REASON }).toast).toBe(true);
    });

    it('no arguments at all is a stand-down, not a throw', () => {
        expect(planScanRefusalNotice()).toEqual({ level: null, toast: false, lastAnnounced: null });
    });
});

describe('installedPacksToEnsure — what the before-generation ensure carries onto a floor', () => {
    const pack = (packId, enabled = true) => ({ packId, enabled, triggers: {} });

    it('carries every INSTALLED pack, because a card can run several at once', () => {
        const registry = { 'a.one': { ver: '1.0' }, 'b.two': { ver: '2.0' }, 'c.three': { ver: '1.0' } };
        const got = installedPacksToEnsure(registry, [pack('a.one'), pack('b.two'), pack('c.three')]);
        expect(got.map((p) => p.packId)).toEqual(['a.one', 'b.two', 'c.three']);
    });

    it('MUTATION TARGET — a DISABLED entry is never re-merged; chat load prunes it and this would put it back every turn', () => {
        const registry = { 'a.one': { ver: '1.0' }, 'b.two': { ver: '1.0' } };
        const got = installedPacksToEnsure(registry, [pack('a.one', false), pack('b.two')]);
        expect(got.map((p) => p.packId)).toEqual(['b.two']);
    });

    it('MUTATION TARGET — a parsed pack the registry does not list was never installed, and is skipped', () => {
        const got = installedPacksToEnsure({ 'a.one': { ver: '1.0' } }, [pack('a.one'), pack('hand.pasted')]);
        expect(got.map((p) => p.packId)).toEqual(['a.one']);
    });

    it('a registry record of {} still counts as installed — the record IS the install marker', () => {
        expect(installedPacksToEnsure({ 'a.one': {} }, [pack('a.one')]).map((p) => p.packId)).toEqual(['a.one']);
    });

    it('junk in, empty out — never a throw on a card with nothing', () => {
        expect(installedPacksToEnsure(null, null)).toEqual([]);
        expect(installedPacksToEnsure({}, [pack('a.one')])).toEqual([]);
        expect(installedPacksToEnsure({ 'a.one': { ver: '1' } }, [])).toEqual([]);
    });
});

// ── what a sync pass says out loud ───────────────────────────────────────────

describe('packSyncToasts — one line per outcome, never one per pack', () => {
    const merged = (packId, added) => ({ action: 'merged', packId, version: '1.0', added });

    it('a single merge keeps the message that NAMES the pack', () => {
        const [t] = packSyncToasts([merged('paulk.beacharc', ['paulk_beacharc_1'])]);
        expect(t).toEqual({ level: 'success', message: 'Event pack paulk.beacharc v1.0 installed (1 event)' });
    });

    it('MUTATION TARGET — a hundred merges are ONE toast, not a hundred', () => {
        const rows = Array.from({ length: 100 }, (_, i) => merged(`p.${i}`, ['a', 'b']));
        const got = packSyncToasts(rows);
        expect(got).toHaveLength(1);
        expect(got[0].message).toBe('100 event packs installed (200 events)');
    });

    it('outcomes do not merge into each other — each class gets its own line', () => {
        const got = packSyncToasts([
            merged('a.one', ['k']),
            { action: 'error', packId: 'b.two', reason: 'bad row' },
            { action: 'incompatible', packId: 'c.three', reason: 'pack format 2.0 needs a newer engine' },
            { action: 'malformed', packId: 'd.four' },
        ]);
        expect(got.map((t) => t.level)).toEqual(['success', 'error', 'warning', 'error']);
        expect(got[2].message).toContain('needs a newer card');
    });

    it('MUTATION TARGET — a quiet outcome says NOTHING; this is the whole point of the gate above it', () => {
        expect(packSyncToasts([
            { action: 'skipped', packId: 'a.one', reason: 'v1.0 rows are already current' },
            { action: 'uninstalled', packId: 'b.two', changed: true },
        ])).toEqual([]);
    });

    it('junk in, empty out — never a throw on a report list from a broken pass', () => {
        expect(packSyncToasts(undefined)).toEqual([]);
        expect(packSyncToasts([null, {}, { action: 'merged', packId: 'x', version: '1' }]))
            .toEqual([{ level: 'success', message: 'Event pack x v1 installed (0 events)' }]);
    });
});

// ── the two verdicts, asked directly ─────────────────────────────────────────

describe('decideMerge / packRowsMatch — fact, not policy', () => {
    const recFor = (p) => ({ ver: p.version, keys: Object.keys(p.triggers) });

    it('no record at all is an install, whatever the rows look like', () => {
        expect(decideMerge(pack(), undefined, {}).action).toBe('install');
    });

    it('record + matching rows is current; a changed row is a refresh at the same version', () => {
        const p = pack();
        const triggers = { paulk_beacharc_1: row() };
        expect(decideMerge(p, recFor(p), triggers).action).toBe('current');
        triggers.paulk_beacharc_1 = row({ when: 'Loc=Beach' });
        expect(decideMerge(p, recFor(p), triggers).action).toBe('refresh');
    });

    it('a newer pack over an older record is an upgrade, not a refresh', () => {
        const p = pack({ version: '2.0' });
        expect(decideMerge(p, { ver: '1.0', keys: ['paulk_beacharc_1'] }, { paulk_beacharc_1: row() }).action)
            .toBe('upgrade');
    });

    it('MUTATION TARGET — a record claiming MORE keys than the pack has is not current', () => {
        const p = pack();
        const rec = { ver: '1.0', keys: ['paulk_beacharc_1', 'paulk_beacharc_2'] };
        expect(packRowsMatch(p, rec, { paulk_beacharc_1: row(), paulk_beacharc_2: row() })).toBe(false);
    });

    it('an unreadable trigger table is never called current — it merges rather than guessing', () => {
        const p = pack();
        expect(packRowsMatch(p, recFor(p), undefined)).toBe(false);
        expect(packRowsMatch(p, recFor(p), 'not an object')).toBe(false);
    });
});

// The install writes each pack entry through packEntryWrite, with the slot the card's engine declares; the
// write lives in a host file no unit test can open. MUTATION TARGETS: build the entry inline again and the
// @@if and the slot are gone; drop the refusal and a malformed slot installs into the host's default.
describe('SOURCE GATE — the install writes the entry packEntryWrite builds, in the slot the card declares', () => {
    const install = readFileSync(new URL('../src/features/event-pack/event-pack-install.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

    it('MUTATION TARGET — every pack entry is written as packEntryWrite builds it', () => {
        expect(install).toContain('await upsertLorebookEntryFields(packEntryComment(id).toLowerCase(), packEntryWrite(p.pack, validated.entryPlacement));');
        expect(install).not.toMatch(/content: p\.pack\.entryContent/);
    });

    it('MUTATION TARGET — a malformed slot refuses the file, and a good one rides to the write', () => {
        expect(install).toContain("if (!bodyEntry.ok) { out.errors.push(`${bodyEntry.reason}. This is the CARD's gap, not the pack's.`); return out; }");
        expect(install).toContain('out.entryPlacement = { armedPath: cfg.armedPath, bodyEntry: bodyEntry.entry };');
    });
});
