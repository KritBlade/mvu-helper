// tests/gamelogic-pack-core.test.js — the §3 pack-file validator + §2 naming (GameLogic Pack plan G1).
//
// Every rule is exercised by the SMALLEST file that breaks exactly it, so a failure names the rule that
// regressed. V5 (format cross-check) and the round-trip half of G1's "done when" live here; V21's CJK
// slug is the AUTHORING tool's job — this side only proves the validator accepts/refuses ids correctly.

import { describe, it, expect } from 'vitest';
import {
    PACK_TYPES,
    libraryEntryComment,
    parsePackFile, validatePack, judgePack, judgePackFile,
    requiredFormat, supportedFormat, isKebabCaseId, findCustomLogicSites, SECTION_MIN_FORMAT,
    isInterfaceName, declaredCallBindings, unknownPluginTokens, PLUGIN_TOKENS,
    packStateRecord, packForcePayload, parsePackRegistry, buildPackRegistryContent, planInstallEntries, decideMvuSchemaLag,
    planPanelEntry, decideActivation,
} from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { LIBRARY_BOOK_NAME, libraryEntryMatch, parseLibraryComment, installedSweepNeedle, commentMatchesNeedle, panelEntryComment } from '../src/shared/card-artifact-store.js';

// Rule 7 makes a schema REQUIRED of a plugin — on a card with no GameLogic Pack nothing else
// declares GameLogicPlugin open — so the per-type baseline gives that ONE type its one extra section.
const OPEN_PLUGIN_ROOT = 'registerMvuSchema(z.looseObject({ GameLogicPlugin: z.record(z.string(), z.any()) }));';

// Minimal VALID file per type — the baseline every rule-breaking case perturbs.
const base = (packType, extra = {}) => ({
    format: '1.0',
    packType,
    id: 'rpg-artific',
    name: 'Artific Realm RPG',
    description: 'Fantasy RPG engine and worldview',
    version: '1.0',
    ...(packType === 'plugin' ? { schema: OPEN_PLUGIN_ROOT } : {}),
    // An eventpack IS its events/ directory (rule 2b), so a file with none is not a minimal VALID
    // one — it is the empty pack that installs nothing.
    ...(packType === 'eventpack' ? { events: [{ name: 'route.txt', text: '<mvueventpack>{}</mvueventpack>' }] } : {}),
    ...extra,
});

const ENGINE = "// my engine — resolver bundle\nconst ENGINE_VERSION = 'v1.2.0';\nmodule.exports = { ENGINE_VERSION };";

describe('validatePack — rule 1: required header', () => {
    it('accepts the minimal valid file of every packType', () => {
        for (const t of PACK_TYPES) {
            const res = validatePack(base(t));
            expect(res.ok, t + ': ' + res.errors.join(' · ')).toBe(true);
            expect(res.errors).toEqual([]);
        }
    });

    it.each(['format', 'packType', 'id', 'name', 'description'])('refuses a file missing "%s", naming rule 1', (field) => {
        const pack = base('gamelogic');
        delete pack[field];
        const res = validatePack(pack);
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 1:') && e.includes('"' + field + '"'))).toBe(true);
    });

    it('refuses a format that is not <major>.<minor> — no silent default', () => {
        expect(validatePack(base('gamelogic', { format: 'v1' })).ok).toBe(false);
        expect(validatePack(base('gamelogic', { format: 1.0 })).ok).toBe(false);
    });

    // MUTATION TARGET — install, upgrade and the card row's Upgrade button order versions number by number,
    // so a version that is not numbers would compare wrong ("v2.0" reads as older than "v1.9").
    it('refuses a version that does not compare, on every packType', () => {
        for (const t of PACK_TYPES) {
            for (const version of ['v1.2', '1.2-beta', '2', '1.2.3.4', '', 1.2]) {
                const res = validatePack(base(t, { version }));
                expect(res.ok, t + ' ' + JSON.stringify(version)).toBe(false);
                expect(res.errors.join()).toMatch(/rule 1: "version".*M\.m or M\.m\.r/);
            }
        }
    });

    it('accepts M.m and M.m.r, and warns (never refuses) when version is absent', () => {
        expect(validatePack(base('gamelogic', { version: '5.116.3' })).ok).toBe(true);
        expect(validatePack(base('plugin', { version: '0.14' })).ok).toBe(true);
        const pack = base('gamelogic');
        delete pack.version;
        const res = validatePack(pack);
        expect(res.ok).toBe(true);
        expect(res.warnings.join()).toMatch(/"version" is absent/);
    });

    it('refuses an unknown packType, naming every valid one', () => {
        const res = validatePack(base('layout'));
        expect(res.ok).toBe(false);
        expect(res.errors[0]).toContain('"gamelogic" | "statusmenu" | "plugin" | "eventpack"');
    });

    it('refuses a non-kebab id and says where the id rides', () => {
        for (const bad of ['RPG Artific', '人光學園', 'rpg_artific', '-lead', 'trail-', 'a--b', '']) {
            const res = validatePack(base('gamelogic', { id: bad }));
            expect(res.ok, JSON.stringify(bad)).toBe(false);
        }
        expect(isKebabCaseId('rpg-artific-2')).toBe(true);
    });

    it('warns (never refuses) on a missing version — the §6 upgrade compare goes blind', () => {
        const pack = base('gamelogic');
        delete pack.version;
        const res = validatePack(pack);
        expect(res.ok).toBe(true);
        expect(res.warnings.some((w) => w.includes('"version"'))).toBe(true);
    });

    it('refuses an entry without a comment — uninstall could never find it', () => {
        const res = validatePack(base('gamelogic', { entries: [{ content: 'orphan' }] }));
        expect(res.ok).toBe(false);
        expect(res.errors[0]).toContain('entries[0]');
    });
});

describe('validatePack — rule 2: sections match the packType', () => {
    it('refuses a gamelogic file carrying "layout", naming the owning type', () => {
        const res = validatePack(base('gamelogic', { layout: { rows: [] } }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2:') && e.includes('"layout"') && e.includes('"statusmenu"'))).toBe(true);
    });

    it('refuses a statusmenu file carrying "exposes"', () => {
        const res = validatePack(base('statusmenu', { exposes: { cast: 'Classmate' } }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2:') && e.includes('"exposes"'))).toBe(true);
    });

    it('refuses a plugin file carrying "schema" or "layout"', () => {
        expect(validatePack(base('plugin', { schema: 'x' })).ok).toBe(false);
        expect(validatePack(base('plugin', { layout: { rows: [] } })).ok).toBe(false);
    });

    it('refuses a gamelogic file carrying "events", naming the owning type', () => {
        const res = validatePack(base('gamelogic', { events: [{ name: 'a.txt', text: 'x' }] }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2:') && e.includes('"events"') && e.includes('"eventpack"'))).toBe(true);
    });

    it('allows every type its OWN sections', () => {
        expect(validatePack(base('gamelogic', { engine: ENGINE, state: { version: '1.0.0', force: {} }, exposes: {}, schema: 'registerMvuSchema(...)' })).ok).toBe(true);
        expect(validatePack(base('statusmenu', { engine: ENGINE, layout: { rows: [] }, targetsPackId: 'rpg-artific' })).ok).toBe(true);
        expect(validatePack(base('plugin', { engine: ENGINE, requires: [], optionalUses: [] })).ok).toBe(true);
    });

    // A plugin declares no state shape: its own root is extensible at chat init (§22), so it creates keys
    // as it needs them. A `state` section would install and then silently never be applied, so it is NAMED.
    it('refuses a plugin file carrying "state", and says where it belongs', () => {
        const res = validatePack(base('plugin', { state: { version: '1.0.0', force: {} } }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2:') && e.includes('"state"') && e.includes('gamelogic'))).toBe(true);
    });

    it('warns on an unknown section instead of refusing — a future format lands here first', () => {
        const res = validatePack(base('gamelogic', { holograms: true }));
        expect(res.ok).toBe(true);
        expect(res.warnings.some((w) => w.includes('"holograms"'))).toBe(true);
    });
});

// Forward compatibility, and the reason a later format can add a section with NO migration: the
// unknown one is named and left out, every other section installs. The warning splits by CAUSE
// because the two readers need opposite advice — update the helper, or move the field down a level.
describe('validatePack — an unknown section is named, never refused', () => {
    it('reports the section and BOTH version numbers, structured as well as prose', () => {
        const res = validatePack(base('gamelogic', { locale: { 'zh-cn': {} } }));
        expect(res.ok).toBe(true);
        expect(res.unknownSections).toEqual(['locale']);
        expect(res.declaredFormat).toBe('1.0');
        expect(res.supportedFormat).toBe(supportedFormat());
        const warn = res.warnings.find((w) => w.includes('"locale"'));
        expect(warn).toContain('declares format "1.0"');
        expect(warn).toContain('understands 1.0');
        expect(warn).toContain('NOT installed; every other section is');
    });

    it('a file from a NEWER helper is told to update — not told it misplaced the field', () => {
        const res = validatePack(base('gamelogic', { format: '1.1', locale: {} }));
        expect(res.ok).toBe(true);
        const warn = res.warnings.find((w) => w.includes('"locale"'));
        expect(warn).toContain('built for a NEWER mvu-helper');
        expect(warn).not.toContain('HOST namespace');
    });

    it('an unknown section at the SAME format reads as misplaced, not as a version gap', () => {
        const res = validatePack(base('gamelogic', { onRender: 'x' }));
        const warn = res.warnings.find((w) => w.includes('"onRender"'));
        expect(warn).toContain('HOST namespace');
        expect(warn).not.toContain('NEWER mvu-helper');
    });

    it('every OTHER section still installs — the unknown one costs the file nothing else', () => {
        const res = validatePack(base('statusmenu', { format: '1.1', layout: { rows: [] }, locale: {} }));
        expect(res.ok).toBe(true);
        expect(res.unknownSections).toEqual(['locale']);
    });

    it('a newer format carrying only KNOWN sections warns once about redefinition', () => {
        const res = validatePack(base('gamelogic', { format: '1.1' }));
        expect(res.ok).toBe(true);
        expect(res.unknownSections).toEqual([]);
        expect(res.warnings.some((w) => w.includes('REDEFINED at the newer format'))).toBe(true);
    });

    it('does not report the same news twice when a newer format ALSO carries an unknown section', () => {
        const res = validatePack(base('gamelogic', { format: '1.1', locale: {} }));
        expect(res.warnings.filter((w) => w.includes('REDEFINED at the newer format'))).toEqual([]);
    });

    it('supportedFormat is the table max — a section added at a new number raises it in one edit', () => {
        expect(supportedFormat()).toBe('1.0');
        expect(supportedFormat({ ...SECTION_MIN_FORMAT, locale: '1.1' })).toBe('1.1');
    });
});

describe('validatePack — rule 2b: an eventpack IS its events/ directory', () => {
    it('refuses one with no events at all — it would install and do nothing', () => {
        const res = validatePack({ ...base('eventpack'), events: undefined });
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2b:') && e.includes('at least one file in events/'))).toBe(true);
    });

    it('MUTATION TARGET — an EMPTY events array is refused the same way an absent one is', () => {
        const res = validatePack({ ...base('eventpack'), events: [] });
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2b:'))).toBe(true);
    });

    it('refuses "entries" beside them — the entries are DERIVED from the files at install', () => {
        const res = validatePack(base('eventpack', { entries: [{ comment: 'x', content: 'y' }] }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2b:') && e.includes('"entries"'))).toBe(true);
    });

    it('accepts one carrying events and nothing else', () => {
        expect(validatePack(base('eventpack')).ok).toBe(true);
    });

    it('rule 1 names eventpack among the choices, so a typo is told the whole set', () => {
        const res = validatePack(base('eventpak'));
        expect(res.errors.some((e) => e.startsWith('rule 1:') && e.includes('"eventpack"'))).toBe(true);
    });
});

describe('validatePack — rule 3: the engine DECLARES its version', () => {
    it('refuses an engine that declares no version', () => {
        const res = validatePack(base('gamelogic', { engine: 'module.exports = {};   // no version anywhere' }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 3:'))).toBe(true);
    });

    // A banner comment used to satisfy this rule, which is exactly how a stated version and a
    // running one drifted apart: the comment was a second copy nothing kept in step.
    it('a version in a COMMENT is NOT a declaration', () => {
        const res = validatePack(base('gamelogic', { engine: '// my engine v1.2.0\nmodule.exports = {};' }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 3:'))).toBe(true);
    });

    it('accepts a declaration wherever in the file it sits', () => {
        expect(validatePack(base('gamelogic', { engine: ENGINE })).ok).toBe(true);
        const late = 'x'.repeat(9000) + "\nconst ENGINE_VERSION = 'v2.0';\nmodule.exports = { ENGINE_VERSION };";
        expect(validatePack(base('gamelogic', { engine: late })).ok).toBe(true);
    });
});

describe('validatePack — rule 4: the installer owns control prefixes, ANYWHERE in a comment', () => {
    it.each(['[MVU_Whatever] note', '[GameLogicPack:x] spoof', '[StatusMenuPack:y] spoof', '[GameLogicPlugin:z] spoof'])(
        'refuses entry comment "%s"', (comment) => {
            const res = validatePack(base('gamelogic', { entries: [{ comment, content: '' }] }));
            expect(res.ok).toBe(false);
            expect(res.errors.some((e) => e.startsWith('rule 4:'))).toBe(true);
        });

    // Needles match anywhere, so a control token mid-comment would spoof another artifact's sweep —
    // and this is what RESERVES the installer's section entries without a marker list: nothing an
    // author can write contains `[GameLogicPlugin:x:Engine]`, because it contains `[GameLogicPlugin:`.
    it.each([
        'notes on [GameLogicPlugin:worldsim:Engine] internals',
        'see [GameLogicPack:rpg:Panel] for the slot',
        'compare [StatusMenuPack:m] (Layout)',
        'a [mvu_LogicEngine] mention',
    ])('refuses a control prefix MID-comment: "%s"', (comment) => {
        const res = validatePack(base('plugin', { entries: [{ comment, content: '' }] }));
        expect(res.ok).toBe(false);
        expect(res.errors.join()).toMatch(/rule 4:.*contains a control prefix/);
    });

    it('accepts a plainly named entry', () => {
        expect(validatePack(base('gamelogic', { entries: [{ comment: 'Worldview', content: '…', enabled: true }] })).ok).toBe(true);
    });

    // Nothing is reserved by WORD: a section name only means something inside the ownership bracket.
    it.each(['{PRE_CALL} Engine room briefing', 'the (Engine) room briefing', 'notes on the (Panel) slot', 'Layout notes'])(
        'accepts ordinary prose "%s" — there is no marker list to collide with', (comment) => {
            const res = validatePack(base('plugin', { entries: [{ comment, content: 'x' }] }));
            expect(res.errors.filter((e) => e.startsWith('rule 4:'))).toEqual([]);
        });
});

describe('validatePack — rule 15: a plugin entry routed to a call stays out of the narrator\'s prompt', () => {
    const routed = (fields) => validatePack(base('plugin', { entries: [{ comment: '{POST_CALL} record', content: 'x', ...fields }] }));
    const rule15 = (res) => res.errors.filter((e) => e.startsWith('rule 15:'));

    it('MUTATION TARGET — enabled and constant is refused: SillyTavern would inject it into the narrator\'s prompt', () => {
        const res = routed({ enabled: true, type: 'constant' });
        expect(res.ok).toBe(false);
        expect(rule15(res).join()).toMatch(/entries\[0\] \("\{POST_CALL\} record"\) is routed to a call.*it is enabled and constant.*disable it, or make it "selective" with no keys/);
    });

    it('MUTATION TARGET — enabled with keys is refused: a key match would inject it', () => {
        expect(rule15(routed({ enabled: true, type: 'selective', keys: ['rain'] })).join()).toMatch(/it is enabled and has keys/);
        expect(rule15(routed({ enabled: true, key: ['rain'] })).join()).toMatch(/it is enabled and has keys/);
    });

    it('MUTATION TARGET — disabled is valid whatever its type: the call reads it either way', () => {
        expect(rule15(routed({ enabled: false, type: 'constant' }))).toEqual([]);
        expect(rule15(routed({ enabled: false, type: 'selective', keys: ['rain'] }))).toEqual([]);
    });

    it('enabled, selective and keyless is valid: SillyTavern never fires it', () => {
        expect(rule15(routed({ enabled: true, type: 'selective', keys: [] }))).toEqual([]);
        expect(rule15(routed({ enabled: true, type: 'selective', keys: ['', '  '] }))).toEqual([]);
    });

    it('the PRE token routes too', () => {
        const res = validatePack(base('plugin', { entries: [{ comment: '{PRE_CALL} weather pre', content: 'x', enabled: true, type: 'constant' }] }));
        expect(rule15(res)).toHaveLength(1);
    });

    it('an entry with no call token is a narrator entry, which constant is for', () => {
        expect(rule15(routed({ comment: 'weather narrate', enabled: true, type: 'constant' }))).toEqual([]);
    });

    it('a GameLogic Pack is not judged: its tags are call names this validator does not know', () => {
        const res = validatePack(base('gamelogic', { entries: [{ comment: '[POST] {POST_CALL} record', content: 'x', enabled: true, type: 'constant' }] }));
        expect(rule15(res)).toEqual([]);
    });
});

describe('validatePack — rule 5: derived-format cross-check (V5)', () => {
    // No real section needs >1.0 yet, so the gate is proven with an injected table — the event-pack
    // P4a lesson: a gate nothing can reach ships broken. This test IS the reachability.
    const future = { ...SECTION_MIN_FORMAT, layout: '2.0' };

    it('refuses a 1.0 file carrying a section the table says needs 2.0, naming both numbers', () => {
        const res = validatePack(base('statusmenu', { layout: { rows: [] } }), { sectionMinFormat: future });
        expect(res.ok).toBe(false);
        const err = res.errors.find((e) => e.startsWith('rule 5:'));
        expect(err).toContain('"layout"');
        expect(err).toContain('needs format 2.0');
        expect(err).toContain('declares 1.0');
    });

    it('passes once the file declares the derived format', () => {
        const res = validatePack(base('statusmenu', { format: '2.0', layout: { rows: [] } }), { sectionMinFormat: future });
        expect(res.errors.filter((e) => e.startsWith('rule 5:'))).toEqual([]);
    });

    it('requiredFormat derives the max over present sections', () => {
        expect(requiredFormat(base('statusmenu', { layout: {} }), future)).toBe('2.0');
        expect(requiredFormat(base('statusmenu'), future)).toBe('1.0');
    });
});

// `packRoots` was removed (2026-08-14, L7): a GameLogic Pack IS the engine and its schema spans every
// root, so a root list could only mean "all of stat_data" — and uninstall does not decide a card's
// state. A file still carrying the old section must WARN, never refuse: refusing would make a pack
// authored last week un-installable over a field nothing reads.
describe('validatePack — packRoots is no longer a section', () => {
    it('treats packRoots as an unknown section: a warning, not an error', () => {
        const res = validatePack(base('gamelogic', { packRoots: ['World', 'Mainchar'] }));
        expect(res.ok).toBe(true);
        expect(res.warnings.some((w) => w.includes('"packRoots"'))).toBe(true);
    });

    it('does not refuse even the once-banned GameLogicPlugin root — the schema rule is the real fence', () => {
        expect(validatePack(base('gamelogic', { packRoots: ['GameLogicPlugin'] })).ok).toBe(true);
    });
});

describe('validatePack — rule 6: the layout is 100% declarative', () => {
    it('refuses customLogic at ANY depth, naming every site', () => {
        const res = validatePack(base('statusmenu', {
            layout: { rows: [{ cells: [{ customLogic: 'x' }] }], footer: { customLogic: 'y' } },
        }));
        expect(res.ok).toBe(false);
        const sites = res.errors.filter((e) => e.startsWith('rule 6:'));
        expect(sites).toHaveLength(2);
        expect(sites[0]).toContain('rows.0.cells.0.customLogic');
        expect(sites[1]).toContain('footer.customLogic');
    });

    it('findCustomLogicSites returns [] for a clean layout', () => {
        expect(findCustomLogicSites({ rows: [{ cells: [{ mappedKey: 'World.Day' }] }] })).toEqual([]);
    });
});

// Rule 7b is a DIFFERENT question from rule 7: that one asks about the plugin drawer INSIDE the root,
// this one about the root itself. A `z.object` root strips every key it was never told about, so it
// deletes the state of every artifact it does not describe on the next write. mvu_zod's rewrap was
// supposed to prevent it and does not fire on a `.prefault({})` root (zod 4.4.3) — hence the rule.
describe('validatePack — rule 7b: the registered ROOT must be open', () => {
    const rooted = (text) => base('gamelogic', { schema: text });
    const rule7b = (pack) => validatePack(pack).errors.filter((e) => e.startsWith('rule 7b:'));

    it('refuses an INLINE z.object root', () => {
        expect(rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }))'))).toHaveLength(1);
    });

    it('refuses a root registered BY NAME and declared closed elsewhere', () => {
        const v = rule7b(rooted('const StatDataSchema = z\n  .object({ World: worldSchema })\n  .prefault({});\nregisterMvuSchema(StatDataSchema);'));
        expect(v).toHaveLength(1);
        expect(v[0]).toMatch(/z\.looseObject/);           // says what to write instead
        expect(v[0]).toMatch(/prefault/);                  // and why the bridge did not save it
    });

    it('refuses z.strictObject too — the other form that strips', () => {
        expect(rule7b(rooted('registerMvuSchema(z.strictObject({ World: worldSchema }))'))).toHaveLength(1);
    });

    it('accepts z.looseObject, inline or by name', () => {
        expect(rule7b(rooted('registerMvuSchema(z.looseObject({ World: worldSchema }))'))).toEqual([]);
        expect(rule7b(rooted('const StatDataSchema = z.looseObject({ World: worldSchema });\nregisterMvuSchema(StatDataSchema);'))).toEqual([]);
    });

    it('a looseObject root wrapped in .prefault({}) is still fine — the BASE form is what strips', () => {
        expect(rule7b(rooted('const StatDataSchema = z\n  .looseObject({ World: worldSchema })\n  .prefault({});\nregisterMvuSchema(StatDataSchema);'))).toEqual([]);
    });

    it('says NOTHING when the text does not name the root plainly — a wrong refusal blocks a working pack', () => {
        expect(rule7b(rooted('const S = buildSchema();\nregisterMvuSchema(S);'))).toEqual([]);
        expect(rule7b(rooted('registerMvuSchema(() => makeIt())'))).toEqual([]);
    });

    it('an open form ELSEWHERE cannot vouch for a closed root', () => {
        expect(rule7b(rooted('const inner = z.looseObject({});\nconst StatDataSchema = z.object({ inner });\nregisterMvuSchema(StatDataSchema);'))).toHaveLength(1);
    });
    // A generated schema commonly reopens a closed base form with `.passthrough()` rather than declaring
    // looseObject outright. Reading the base form alone refused such a schema, so the rule reads the
    // root's OWN chain past its closing paren.
    const generatedRoot = "const worldSchema = z\n  .object({ Date: z.string().prefault('') })\n  .passthrough()\n  .prefault({});\nexport const StatDataSchema = z\n  .object({\n    World: worldSchema,\n  })";
    const registerTail = '\nregisterMvuSchema(StatDataSchema);';

    it('accepts a generated root — z.object({…}) reopened with .passthrough()', () => {
        expect(rule7b(rooted(generatedRoot + '\n  .passthrough()\n  .prefault({});' + registerTail))).toEqual([]);
    });

    it('still refuses the SAME root with the opener dropped \u2014 that is the only difference', () => {
        expect(rule7b(rooted(generatedRoot + '\n  .prefault({});' + registerTail))).toHaveLength(1);
    });

    it('accepts .passthrough() chained inline too', () => {
        expect(rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }).passthrough())'))).toEqual([]);
    });

    it('a nested .passthrough() cannot vouch for the root \u2014 the chain is read past the root\'s own close', () => {
        expect(rule7b(rooted(generatedRoot + '\n  .prefault({});' + registerTail))).toHaveLength(1);
        expect(rule7b(rooted('registerMvuSchema(z.object({ inner: z.object({}).passthrough() }))'))).toHaveLength(1);
    });

    // A root reaches this validator from any authoring tool or from a hand-written file, so every Zod
    // spelling that reopens an object counts, not only the one a generator happens to emit. Measured on
    // zod 4.4.3: passthrough / loose / catchall(<schema>) all keep an undeclared root; catchall(z.never())
    // refuses it instead of keeping it, so it is NOT an opener.
    it('accepts .catchall(<schema>) \u2014 an unknown key is kept by being VALIDATED', () => {
        expect(rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }).catchall(z.any()))'))).toEqual([]);
        expect(rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }).catchall(z.unknown()))'))).toEqual([]);
        expect(rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }).catchall(labeledValue))'))).toEqual([]);
    });

    it('accepts .loose(), the method spelling of looseObject', () => {
        expect(rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }).loose())'))).toEqual([]);
    });

    it('refuses .catchall(z.never()) \u2014 it rejects an unknown key rather than keeping it', () => {
        expect(rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }).catchall(z.never()))'))).toHaveLength(1);
    });

    // The two closed forms fail DIFFERENTLY and an author fixing one needs to be told which: a plain
    // z.object drops the root and says nothing, z.strictObject refuses the whole write.
    it('names the form\'s OWN failure \u2014 a silent strip for z.object, a refused write for z.strictObject', () => {
        const [stripped] = rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }))'));
        expect(stripped).toMatch(/STRIPS every root it does not name, silently/);
        const [refused] = rule7b(rooted('registerMvuSchema(z.strictObject({ World: worldSchema }))'));
        expect(refused).toMatch(/REFUSES every write/);
    });

    // mvu_zod re-wraps a registered root as looseObject while it is `instanceof z.ZodObject`, and a BARE
    // closed root is one \u2014 so the bridge rescues it and nothing is lost yet. The refusal stands, because
    // the rule reads the schema as written, but it must not claim a loss that has not happened.
    it('words the refusal as fragility, not as a loss already happening', () => {
        const [said] = rule7b(rooted('registerMvuSchema(z.object({ World: worldSchema }))'));
        expect(said).toMatch(/one edit away from not being/);
        expect(said).toMatch(/only.*while the root is `instanceof z\.ZodObject`/);
    });

    it('MUTATION TARGET — an apostrophe or a paren in a comment inside the root does not hide its shape', () => {
        const commented = "const StatDataSchema = z\n  .object({\n    // the player's own root (kept)\n    /* a block ( comment */\n    World: worldSchema,\n  })\n  .prefault({});";
        expect(rule7b(rooted(commented + registerTail))).toHaveLength(1);
        expect(rule7b(rooted(commented.replace('.prefault', '.passthrough()\n  .prefault') + registerTail))).toEqual([]);
    });

    it('an unbalanced root says nothing rather than accusing a schema it could not read', () => {
        expect(rule7b(rooted('const StatDataSchema = z.object({ World: worldSchema' + registerTail))).toEqual([]);
    });
});

describe('validatePack — rule 7: the schema must not CLOSE GameLogicPlugin (V22)', () => {
    const withSchema = (decl) => base('gamelogic', {
        schema: 'registerMvuSchema(z.looseObject({ World: worldSchema, ' + decl + ' }))',
    });

    it('refuses a CLOSED declaration — Zod would strip every plugin state on the next write', () => {
        const res = validatePack(withSchema('GameLogicPlugin: z.object({})'));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 7:'))).toBe(true);
    });

    it('the refusal names the open forms, so an author is told what to write', () => {
        const res = validatePack(withSchema('GameLogicPlugin: z.object({})'));
        const rule7 = res.errors.find((e) => e.startsWith('rule 7:'));
        expect(rule7).toMatch(/z\.record/);
        expect(rule7).toMatch(/passthrough/);
    });

    // The game DECLARES the root on purpose now — tooling reads it, and the init seed beside it is what
    // makes MVU treat the root as extensible. An open shape validates nothing away, so it is allowed.
    it('accepts every OPEN declaration', () => {
        for (const decl of [
            'GameLogicPlugin: z.record(z.string(), z.any()).prefault({})',
            'GameLogicPlugin: z.any()',
            'GameLogicPlugin: z.looseObject({})',
            'GameLogicPlugin: z.object({}).passthrough()',
        ]) {
            expect(validatePack(withSchema(decl)).ok).toBe(true);
        }
    });

    // ONE open test for the field and the root: every reopener the root accepts, the field accepts too.
    it('MUTATION TARGET — accepts a closed form reopened by .loose() or .catchall(z.any()), as the root check does', () => {
        for (const decl of [
            'GameLogicPlugin: z.object({}).loose()',
            'GameLogicPlugin: z.object({}).catchall(z.any())',
            'GameLogicPlugin: z.object({}).catchall(z.unknown()).prefault({})',
        ]) {
            expect(validatePack(withSchema(decl)).ok).toBe(true);
        }
    });

    it('MUTATION TARGET — .catchall(z.never()) refuses unknown keys, so it is no opener', () => {
        const res = validatePack(withSchema('GameLogicPlugin: z.object({}).catchall(z.never())'));
        expect(res.errors.some((e) => e.startsWith('rule 7:'))).toBe(true);
    });

    it('the refusal names every open form the schema allow-list keeps', () => {
        const rule7 = validatePack(withSchema('GameLogicPlugin: z.object({})')).errors.find((e) => e.startsWith('rule 7:'));
        for (const form of ['z.record(...)', 'z.any()', 'z.looseObject(...)', '.passthrough()', '.catchall(z.any())']) {
            expect(rule7).toContain(form);
        }
        // `.loose()` opens a shape too, but the allow-list removes it — the refusal must not advise it.
        expect(rule7).not.toContain('.loose()');
    });

    it('accepts a schema that leaves the root out', () => {
        expect(validatePack(base('gamelogic', { schema: 'registerMvuSchema(z.looseObject({ World: z.object({}) }))' })).ok).toBe(true);
    });

    // An open form somewhere ELSE in a big schema must not vouch for a closed root — only the root's own
    // declaration is read.
    it('is not fooled by an open form elsewhere in the file', () => {
        const res = validatePack(base('gamelogic', {
            schema: ['const loose = z.record(z.string(), z.any());',
                'registerMvuSchema(z.looseObject({ GameLogicPlugin: z.object({}) }))'].join('\n'),
        }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 7:'))).toBe(true);
    });
});

describe('validatePack — rule 7: $mvuhelper, mvu-helper\'s own root, is a platform root too', () => {
    const withSchema = (decl) => base('gamelogic', {
        schema: 'registerMvuSchema(z.looseObject({ World: worldSchema, ' + decl + ' }))',
    });
    const rule7 = (pack) => validatePack(pack).errors.filter((e) => e.startsWith('rule 7:'));

    it('MUTATION TARGET — refuses a closed declaration, bare or quoted as a generator writes a $ key', () => {
        for (const decl of ['$mvuhelper: z.object({ worn_outfit: z.record(z.string(), z.any()) })', "'$mvuhelper': z.object({})", '"$mvuhelper": z.object({})']) {
            const said = rule7(withSchema(decl));
            expect(said).toHaveLength(1);
            expect(said[0]).toMatch(/"\$mvuhelper" with a CLOSED shape/);
        }
    });

    it('accepts the open form, bare or quoted', () => {
        expect(validatePack(withSchema('$mvuhelper: z.record(z.string(), z.any()).prefault({})')).ok).toBe(true);
        expect(validatePack(withSchema("'$mvuhelper': z.record(z.string(), z.any()).prefault({})")).ok).toBe(true);
    });

    it('MUTATION TARGET — a deliberately closed root must declare BOTH platform roots open, or rule 7b refuses', () => {
        const locked = (decls) => base('gamelogic', { schema: 'registerMvuSchema(z.object({ World: worldSchema,\n' + decls.join(',\n') + ' }))' });
        const open = (name) => name + ': z.record(z.string(), z.any()).prefault({})';
        const only = validatePack(locked([open('GameLogicPlugin')]));
        expect(only.errors.filter((e) => e.startsWith('rule 7b:'))).toHaveLength(1);
        const both = validatePack(locked([open('GameLogicPlugin'), open('$mvuhelper')]));
        expect(both.errors.filter((e) => e.startsWith('rule 7b:'))).toEqual([]);
        expect(both.warnings.filter((w) => w.startsWith('rule 7b:'))).toHaveLength(1);
    });

    it('the old name, mvuhelper without the $, is not a platform root', () => {
        expect(rule7(withSchema('mvuhelper: z.object({})'))).toEqual([]);
    });
});

describe('parsePackFile / judgePackFile — the text lane', () => {
    it('reports non-JSON as its own error, not a rule', async () => {
        const res = await judgePackFile('<mvueventpack> not json');
        expect(res.ok).toBe(false);
        expect(res.pack).toBeNull();
        expect(res.errors[0]).toContain('not valid JSON');
    });

    it('refuses a JSON array — one object per file', () => {
        expect(parsePackFile('[1,2]').error).toContain('one JSON object');
    });

    it('round-trips a valid file of each type through text', async () => {
        for (const t of PACK_TYPES) {
            const original = base(t);
            const text = JSON.stringify(original, null, 2);
            const res = await judgePackFile(text);
            expect(res.ok, t).toBe(true);
            expect(res.pack).toEqual(original);   // parse(text) is the file — nothing added or dropped
        }
    });
});

// D: every door into the library runs the source gates too, not only the folder import and the dev loop.
describe('judgePack — the validator and the source gates, one judgement for every door', () => {
    const MENU_ENGINE = "// menu engine\nconst ENGINE_VERSION = 'v1.0.0';\nmodule.exports = { ENGINE_VERSION, formatters: {} };";
    const menu = (layout) => base('statusmenu', { engine: MENU_ENGINE, layout });

    it('MUTATION TARGET — a gate finding refuses the pack even when the validator passes', async () => {
        const pack = menu({ kind: 'slot-list', format: '1.0', formatters: { 'Mainchar.Money': 'money' }, tabs: [] });
        expect(validatePack(pack).ok).toBe(true);
        const res = await judgePack(pack, { readMenuEngine: async () => ({ ok: true, error: '', formatters: [], actions: [] }) });
        expect(res.ok).toBe(false);
        expect(res.errors.join()).toMatch(/formatter "money"/);
    });

    it('MUTATION TARGET — a menu that ships an engine cannot be judged without a Worker read: it throws, never passes', async () => {
        const pack = menu({ kind: 'slot-list', format: '1.0', tabs: [] });
        await expect(judgePack(pack)).rejects.toThrow(/no readMenuEngine was given/);
    });

    it('a pack with no menu engine needs no reader', async () => {
        expect((await judgePack(base('plugin'))).ok).toBe(true);
    });
});

describe('§2 naming — comments and needles', () => {
    it('builds the frozen comment per type and round-trips through parseLibraryComment', () => {
        expect(libraryEntryComment('gamelogic', 'rpg-artific')).toBe('[GameLogicPack:rpg-artific]');
        expect(libraryEntryComment('statusmenu', 'rpg-menu')).toBe('[StatusMenuPack:rpg-menu]');
        expect(libraryEntryComment('plugin', 'npc-sim')).toBe('[GameLogicPlugin:npc-sim]');
        for (const t of PACK_TYPES) {
            const parsed = parseLibraryComment(libraryEntryComment(t, 'some-id'));
            expect(parsed).toEqual({ packType: t, id: 'some-id' });
        }
    });

    it('parseLibraryComment rejects non-library comments — a user note in the book is not an artifact', () => {
        expect(parseLibraryComment('Worldview')).toBeNull();
        expect(parseLibraryComment('[MVU_LogicEngine]')).toBeNull();
        expect(parseLibraryComment('[GameLogicPack:no-close')).toBeNull();
        expect(parseLibraryComment('[GameLogicPlugin:rpg:Engine]')).toBeNull();   // a SECTION entry, never an artifact with id "rpg:Engine"
    });

    it('needles are lowercase (the event-pack convention) and the book name is the §2 one', () => {
        expect(libraryEntryMatch('gamelogic', 'RPG')).toBe('[gamelogicpack:rpg]');
        expect(LIBRARY_BOOK_NAME).toBe('MVU_GameLogic_Library');
    });
});

// ═══ GP0 — the PLUGIN half of the format (§20) ═══════════════════════════════
//
// Rules 1–7 already covered plugins (they route by packType), so these two are the delta GP0 adds.
// Both exist because of the same failure shape the rest of this plan keeps closing: a fault that
// every layer accepts and that surfaces far from its cause.

// Every plugin carries a schema — rule 7 requires one, because on a card with no GameLogic Pack
// nothing else declares `GameLogicPlugin` open and MVU's derived schema freezes the plugin's drawer
// shut. The fixture spells the minimum that satisfies it.
const plugin = (extra = {}) => ({
    format: '1.0', packType: 'plugin', id: 'worldsim', name: 'Living World Simulation',
    description: 'Simulates the world between scenes.', version: '1.0',
    entries: [{ comment: '{PRE_CALL} worldsim request', content: 'read {OWN_ROOT} and report', order: 250 }],
    schema: 'registerMvuSchema(z.looseObject({ GameLogicPlugin: z.record(z.string(), z.any()) }));',
    ...extra,
});

describe('rule 8 — requires / optionalUses are interface names (§25)', () => {
    it('accepts well-formed names', () => {
        expect(isInterfaceName('cast@1')).toBe(true);
        expect(isInterfaceName('world-clock@2')).toBe(true);
        expect(validatePack(plugin({ requires: ['cast@1'], optionalUses: ['calendar@1'] })).ok).toBe(true);
    });

    it('refuses every shape that could never match', () => {
        for (const bad of ['Cast@1', 'cast@1.0', 'cast', '@1', 'cast@', '', 'cast @1', '1cast@1']) {
            expect(isInterfaceName(bad)).toBe(false);
        }
    });

    it('a BARE STRING is refused — the field is a list, and a string would iterate as characters', () => {
        const v = validatePack(plugin({ requires: 'cast@1' }));
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/rule 8: "requires".*must be an ARRAY/);
    });

    it('names the OFFENDING INDEX and quotes the value — the author has to find it in a list', () => {
        const v = validatePack(plugin({ requires: ['cast@1', 'Calendar@1'] }));
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/requires\[1\] is "Calendar@1"/);
        expect(v.errors.join()).toMatch(/lowercase name/);
    });

    it('a non-string element is caught too — JSON makes 123 as easy to write as "123"', () => {
        expect(validatePack(plugin({ optionalUses: [123] })).ok).toBe(false);
    });

    // WHY THIS IS AN ERROR AND NOT A WARNING: the §25 broker is a blind string match, so a malformed
    // name cannot match anything. Left to install time it reads as "the active game does not expose
    // Cast@1" — which blames the GAME for the plugin author's capital C.
    it('absent fields are fine — both are optional', () => {
        expect(validatePack(plugin()).ok).toBe(true);
    });
});

// §25/GP3 — the GAME side of the interface contract. Same reasoning as rule 8 one describe up: the
// broker is blind, so a malformed entry here would surface at install time blaming the PLUGIN.
describe('rule 13 — exposes maps interface names to the pack\'s own dotted paths', () => {
    it('accepts a well-formed map, single and dotted paths both', () => {
        expect(validatePack(base('gamelogic', { exposes: { 'cast@1': 'CastRoot', 'world-clock@1': 'Derived.Clock' } })).ok).toBe(true);
    });

    it('absent is fine — exposing nothing is a valid game', () => {
        expect(validatePack(base('gamelogic')).ok).toBe(true);
    });

    it('an ARRAY (or any non-object) is refused naming the rule', () => {
        const v = validatePack(base('gamelogic', { exposes: ['cast@1'] }));
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/rule 13: "exposes".*must be an OBJECT/);
    });

    it('a malformed interface KEY is refused with rule 8\'s name shape', () => {
        const v = validatePack(base('gamelogic', { exposes: { 'Cast@1': 'CastRoot' } }));
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/rule 13: exposes key "Cast@1"/);
    });

    it('a malformed PATH is refused — empty, non-string, and stray-dot shapes all', () => {
        for (const badPath of ['', 42, '.Lead', 'Trail.', 'a..b']) {
            const v = validatePack(base('gamelogic', { exposes: { 'cast@1': badPath } }));
            expect(v.ok).toBe(false);
            expect(v.errors.join()).toMatch(/rule 13: exposes\["cast@1"\] must be a dotted stat_data path/);
        }
    });
});

describe('rule 9 + declaredCallBindings — token presence IS the declaration (§20)', () => {
    it('derives the binding needs from the entries, with no manifest field to drift from them', () => {
        expect(declaredCallBindings(plugin())).toEqual({ pre: true, post: false });
        expect(declaredCallBindings(plugin({
            entries: [{ comment: '{POST_CALL} record', content: 'x' }, { comment: '{PRE_CALL} ask', content: 'y' }],
        }))).toEqual({ pre: true, post: true });
        expect(declaredCallBindings(plugin({ entries: [{ comment: 'plain', content: 'no tokens' }] })))
            .toEqual({ pre: false, post: false });
    });

    it('reads CONTENT as well as comment — §20 says "appearing anywhere"', () => {
        expect(declaredCallBindings(plugin({ entries: [{ comment: 'note', content: 'goes to {POST_CALL}' }] })))
            .toEqual({ pre: false, post: true });
    });

    it('survives a missing/blank entries array instead of throwing', () => {
        expect(declaredCallBindings({})).toEqual({ pre: false, post: false });
        expect(unknownPluginTokens({})).toEqual([]);
    });

    it('an unknown token WARNS and is quoted — it would reach the prompt verbatim', () => {
        const v = validatePack(plugin({ entries: [{ comment: 'x', content: 'read {OWNROOT} now' }] }));
        expect(v.ok).toBe(true);                       // never blocks: the prose is the author's, not ours
        expect(v.warnings.join()).toMatch(/\{OWNROOT\}/);
        expect(v.warnings.join()).toMatch(/prompt verbatim/);
    });

    it('deduplicates, and does not warn about the tokens we DO substitute', () => {
        expect(unknownPluginTokens(plugin({
            entries: [{ comment: '{PRE_CALL} a', content: '{OWN_ROOT} {NOPE} {NOPE}' }],
        }))).toEqual(['{NOPE}']);
        for (const t of PLUGIN_TOKENS) {
            expect(unknownPluginTokens(plugin({ entries: [{ comment: 'c', content: t }] }))).toEqual([]);
        }
    });

    it('lowercase braces are PROSE, not a token — no false alarm on {{macros}} or {name}', () => {
        expect(unknownPluginTokens(plugin({ entries: [{ comment: 'c', content: 'hi {{user}} and {name}' }] }))).toEqual([]);
    });

    it('a NON-plugin file is never token-scanned — its prompt prose is not ours to police', () => {
        const v = validatePack(base('gamelogic', { entries: [{ comment: 'c', content: 'say {SOMETHING}' }] }));
        expect(v.warnings.join()).not.toMatch(/rule 9/);
    });
});

describe('rule 10 — the regex section (§11)', () => {
    const base = { format: '1.0', packType: 'gamelogic', id: 'g', name: 'G', description: 'd', version: '1.0' };
    // The real School v4 pattern, escaped as it appears in the pack JSON: backslashes are literal here.
    const ok = { script_name: 'HideChoices', find_regex: String.raw`/<choices>[\s\S]*?<\/choices>/gm` };
    const run = (regex) => validatePack({ ...base, regex });

    it('accepts a well-formed array', () => {
        const res = run([ok]);
        expect(res.ok).toBe(true);
        expect(res.warnings).toEqual([]);
    });

    it('refuses a non-array', () => {
        expect(run({ a: 1 }).errors.join()).toMatch(/rule 10.*must be an ARRAY/);
    });

    it('refuses an element that is not an object', () => {
        expect(run(['nope']).errors.join()).toMatch(/rule 10: regex\[0\] must be an object/);
    });

    // script_name is the IDENTITY on this surface — without it uninstall has no handle at all.
    it('refuses a missing or blank script_name, naming why it matters', () => {
        expect(run([{ find_regex: '/x/g' }]).errors.join()).toMatch(/needs a non-empty string "script_name"/);
        expect(run([{ script_name: '   ', find_regex: '/x/g' }]).errors.join()).toMatch(/script_name/);
    });

    it('refuses two regexes sharing a script_name, naming both indices', () => {
        const errs = run([ok, { ...ok, find_regex: '/y/g' }]).errors.join();
        expect(errs).toMatch(/repeats script_name "HideChoices" \(already at regex\[0\]\)/);
    });

    it('refuses a missing find_regex', () => {
        expect(run([{ script_name: 'A' }]).errors.join()).toMatch(/needs a non-empty string "find_regex"/);
    });

    // WARN, not refuse: this re-implements ST's /pattern/flags parse, so a refusal could be OUR limit.
    it('WARNS on a pattern that does not compile, and still installs', () => {
        const res = run([{ script_name: 'A', find_regex: '/([unclosed/g' }]);
        expect(res.ok).toBe(true);
        expect(res.warnings.join()).toMatch(/did not compile as \/pattern\/flags/);
    });

    // ST's regexFromString makes the delimiters OPTIONAL, so a bare pattern is valid — and it is what the
    // School v4 menu regexes actually use. An earlier version of this check demanded /pattern/flags and
    // warned on every one of them; the warning was the bug, not the pattern.
    it('does NOT warn on a bare pattern — ST accepts them and the menu regexes rely on it', () => {
        const res = run([{ script_name: 'StatusMenu', find_regex: '<StatusPlaceHolderImpl/>' }]);
        expect(res.ok).toBe(true);
        expect(res.warnings).toEqual([]);
    });

    // destination.prompt edits what the MODEL reads. Legitimate, but never something to discover from a
    // turn that behaves strangely.
    it('warns when a regex rewrites the prompt rather than the display', () => {
        const res = run([{ ...ok, destination: { prompt: true } }]);
        expect(res.ok).toBe(true);
        expect(res.warnings.join()).toMatch(/rewrite text on its way to the MODEL/);
        expect(res.warnings.join()).toMatch(/prompt_rewrite_intended/);   // the warning teaches the answer
    });

    // The author's answer to "Intended?" — a declaration the platform reads without learning WHY,
    // and normalizeTavernRegex never ships (it rebuilds from an explicit field list).
    it('prompt_rewrite_intended: true answers the question and the warning retires', () => {
        const res = run([{ ...ok, destination: { prompt: true }, prompt_rewrite_intended: true }]);
        expect(res.ok).toBe(true);
        expect(res.warnings).toEqual([]);
    });
    it('a declaration outliving its destination is named as stale, never silently ignored', () => {
        const res = run([{ ...ok, prompt_rewrite_intended: true }]);
        expect(res.ok).toBe(true);
        expect(res.warnings.join()).toMatch(/answers a question nothing is asking/);
    });

    // Ownership decides, not mechanism: a statusmenu pack's regexes ARE the menu, so it carries them too.
    it('a statusmenu file MAY carry "regex" — the menu regexes are its own surface', () => {
        const res = validatePack({ ...base, packType: 'statusmenu', regex: [{ script_name: 'StatusMenu', find_regex: '/<StatusPlaceHolderImpl\\/>/gm' }] });
        expect(res.ok).toBe(true);
    });

    // A plugin has no card surface of its own — a regex there reaches into someone else's output with
    // nothing to arbitrate it.
    it('rule 2 — a plugin file may NOT carry "regex"', () => {
        const asPlugin = validatePack({ ...base, packType: 'plugin', regex: [ok] });
        expect(asPlugin.errors.join()).toMatch(/rule 2: a "plugin" file may not carry "regex"/);
    });

    // TavernHelper renders any message text carrying one of its frontend tokens as an unsandboxed iframe
    // with the page's full reach, so a GameLogic row that would render a document is pack code on the page.
    describe('a GameLogic row may hide or restyle, never render a document', () => {
        const rendering = (replaceString) => run([{ ...ok, replace_string: replaceString }]);

        it.each([
            ['html>', '```html\n<!DOCTYPE html><html><body><script>parent.SillyTavern</script></body></html>\n```'],
            ['<head>', '<head><script src="x.js"></script></head>'],
            ['<body', '<body onload="1">'],
        ])('refuses a replace_string carrying %s, naming the row and the token', (token, text) => {
            const res = rendering(text);
            expect(res.ok).toBe(false);
            expect(res.errors.join()).toContain('rule 10: regex[0] ("HideChoices") — "replace_string" carries ' + JSON.stringify(token));
            expect(res.errors.join()).toMatch(/ship it in a StatusMenu Pack/);
        });

        it('accepts the styling HTML a display regex really ships (School\'s stat box shape)', () => {
            const res = rendering('<div style="border: 1px solid #3e4047"><details><summary>Stats</summary>$1</details></div>');
            expect(res.ok).toBe(true);
            expect(res.errors).toEqual([]);
        });

        // A destination flag is the card owner's to flip after install, so it never exempts a row.
        it('refuses whatever the row\'s destination flags say', () => {
            const res = run([{ ...ok, destination: { display: false, prompt: true }, prompt_rewrite_intended: true, replace_string: '<html><body></body></html>' }]);
            expect(res.ok).toBe(false);
            expect(res.errors.join()).toMatch(/carries "html>"/);
        });

        it('names every offending row, not just the first', () => {
            const res = run([
                { ...ok, replace_string: '<html>' },
                { script_name: 'Second', find_regex: '/y/g', replace_string: '<body>' },
            ]);
            expect(res.errors.filter((e) => e.includes('"replace_string" carries')).length).toBe(2);
        });

        // A statusmenu pack's fenced rows are its menu: its own install lifts each into the contained
        // frame and refuses what is left (statusmenu-pack-core liftMenuRegexRows), so rule 10 leaves them.
        it('leaves a statusmenu pack\'s fenced row to its own lift', () => {
            const res = validatePack({ ...base, packType: 'statusmenu', regex: [{ script_name: 'StatusMenu', find_regex: '/<StatusPlaceHolderImpl\\/>/gm', replace_string: '```html\n<html><body>menu</body></html>\n```' }] });
            expect(res.errors.join()).not.toMatch(/"replace_string" carries/);
        });
    });
});

describe('rule 11 — `state` carries version, force and forceFromInitVar; the seed is the card\'s [InitVar]', () => {
    const run = (state) => validatePack(base('gamelogic', { state }));

    it('accepts a well-formed section', () => {
        expect(run({ version: '4.3.0', force: { 'World.Weather': ['Clear', 'x'] } }).ok).toBe(true);
        expect(run({ version: '1.0.0' }).ok).toBe(true);          // force is optional
    });

    // version gates the FORCE half. Without it a correction re-applies on every load, overwriting the
    // player's save each time — the one thing the watermark exists to stop.
    it('REFUSES a missing version, and says what it gates', () => {
        const res = run({ force: { 'A.b': 1 } });
        expect(res.ok).toBe(false);
        expect(res.errors.join()).toMatch(/rule 11.*state\.version.*REQUIRED/);
        expect(res.errors.join()).toMatch(/watermark/);
    });

    it('refuses a non-object section or force bucket', () => {
        expect(run('nope').ok).toBe(false);
        expect(run({ version: '1.0.0', force: 'x' }).ok).toBe(false);
        expect(run({ version: '1.0.0', force: [1] }).ok).toBe(false);
    });

    // MUTATION TARGET — the watermark compares numbers, so a version that is not numbers cannot gate.
    it('REFUSES a state.version that does not compare: "v1.0", "1.0-beta", "1"', () => {
        for (const version of ['v1.0', '1.0-beta', '1', '1.0.0.0', ' 1.0']) {
            const res = run({ version, force: { 'A.b': 1 } });
            expect(res.ok).toBe(false);
            expect(res.errors.join()).toMatch(/state\.version.*M\.m or M\.m\.r/);
        }
    });

    it('a dotted key in force is exactly right and passes', () => {
        expect(run({ version: '1.0.0', force: { 'World.Weather.0': 'Storm' } }).ok).toBe(true);
    });

    it('accepts forceFromInitVar as a list of dotted paths', () => {
        expect(run({ version: '1.0.0', forceFromInitVar: ['EventPack.triggers'] }).ok).toBe(true);
        expect(run({ version: '1.0.0', force: { 'A.b': 1 }, forceFromInitVar: ['EventPack.triggers', 'World.Weather'] }).ok).toBe(true);
    });

    // MUTATION TARGET — a path that names nothing would push nothing, silently, on every card that installs the pack.
    it('REFUSES a forceFromInitVar that is not a list, or holds something that is not a dotted path', () => {
        const notList = run({ version: '1.0.0', forceFromInitVar: 'EventPack.triggers' });
        expect(notList.ok).toBe(false);
        expect(notList.errors.join()).toMatch(/state\.forceFromInitVar.*list of absolute dotted paths/);
        for (const bad of [[''], ['EventPack..triggers'], ['.EventPack'], [42], [null]]) {
            const res = run({ version: '1.0.0', forceFromInitVar: bad });
            expect(res.ok).toBe(false);
            expect(res.errors.join()).toMatch(/state\.forceFromInitVar\[0\] must be an absolute dotted path/);
        }
    });

    // Refused rather than dropped: a `seed` silently ignored would look applied.
    it('REFUSES state.seed, naming [InitVar] as where the seed lives', () => {
        const res = run({ version: '1.0.0', seed: { World: { Day: 1 } } });
        expect(res.ok).toBe(false);
        expect(res.errors.join()).toMatch(/state\.seed.*not a state field/);
        expect(res.errors.join()).toMatch(/\[InitVar\]/);
    });

    it('refuses a `data` bucket too, naming force', () => {
        const res = run({ version: '1.0.0', data: { A: 1 } });
        expect(res.ok).toBe(false);
        expect(res.errors.join()).toMatch(/state\.force/);
    });

    it('refuses a file carrying `init`, naming [InitVar]', () => {
        const res = validatePack(base('gamelogic', { init: { World: { Day: 1 } } }));
        expect(res.ok).toBe(false);
        expect(res.errors.join()).toMatch(/\[InitVar\]/);
    });
});

describe('packStateRecord — `state` is RECORDED in the registry, never written as an entry', () => {
    const pack = { packType: 'gamelogic', id: 'school-v4', state: { version: '4.3.0', force: { 'A.b': 2 }, forceFromInitVar: ['EventPack.triggers'] } };

    it('returns the version and both force lists for the registry', () => {
        expect(packStateRecord(pack)).toEqual({ stateVersion: '4.3.0', force: { 'A.b': 2 }, forceFromInitVar: ['EventPack.triggers'] });
    });

    it('is inert for a pack that ships no state', () => {
        expect(packStateRecord({ packType: 'gamelogic', id: 'x' })).toEqual({ stateVersion: '', force: {}, forceFromInitVar: [] });
    });

    it('coerces a non-object force to {} and a non-list forceFromInitVar to []', () => {
        expect(packStateRecord({ state: { version: '1.0.0', force: 'nope' } }).force).toEqual({});
        expect(packStateRecord({ state: { version: '1.0.0', forceFromInitVar: 'EventPack.triggers' } }).forceFromInitVar).toEqual([]);
    });

    // The chain card-sync relies on: what the pack file declares is what the sync is handed, through the registry
    // install writes on the card.
    it("MUTATION TARGET — packForcePayload hands card-sync the pack's state whole: pack file → registry → payload", () => {
        const record = { activePackId: 'school-v4', ver: '5.151.1', ...packStateRecord(pack) };
        const registry = parsePackRegistry(buildPackRegistryContent('gamelogic', record));
        expect(packForcePayload(registry)).toEqual({ version: '4.3.0', force: { 'A.b': 2 }, forceFromInitVar: ['EventPack.triggers'] });
    });

    it('packForcePayload is null when no pack is active', () => {
        expect(packForcePayload(null)).toBe(null);
        expect(packForcePayload({ activePackId: '' })).toBe(null);
    });

    // THE POINT OF THE RETIREMENT: install writes the pack's own entries and NOTHING else. A card that
    // installs a pack gains no mvu-helper-specific lorebook entry at all.
    it('planInstallEntries writes no state entry — the card gains only the pack own entries', () => {
        const plan = planInstallEntries({ ...pack, entries: [{ comment: 'Worldview', content: 'w' }] });
        expect(plan.entries).toHaveLength(1);
        expect(plan.installedComments).toEqual(plan.entries.map((e) => e.comment));
        expect(plan.installedComments.some((c) => c.toLowerCase().includes('[mvu_update_data]'))).toBe(false);
    });
});

describe('decideMvuSchemaLag — MVU derived its schema before the pack existed', () => {
    // A pack that DOES ship [InitVar] and does NOT ship a Zod schema — the only shape that can lag.
    const withInitVar = { packType: 'gamelogic', id: 'school-v4', state: { version: '1.0.0', seed: { World: {} } },
        entries: [{ comment: '[InitVar] MVU Init', content: '{}' }] };
    const base = {
        pack: withInitVar,
        bookName: 'ArtificKoi',
        initializedBooks: { ArtificKoi: [] },
        schemaPropertyCount: 0,
    };
    const run = (over = {}) => decideMvuSchemaLag({ ...base, ...over });

    // THE CASE THAT MADE THIS GUARD LIE ON ITS FIRST DAY (measured live 2026-08-16). A `schema` section
    // registers Zod, and mvu_zod.js empties MVU's command list and overwrites MVU's schema with MVU's own
    // disable sentinel on every update. A lagged chat and a fresh one are then IDENTICAL, so warning
    // about the difference describes one that does not exist. Checked BEFORE every other condition.
    it('stays silent when the pack ships a Zod schema, whatever else is true', () => {
        const v = run({ pack: { ...withInitVar, schema: 'registerMvuSchema(...)' } });
        expect(v.lagged).toBe(false);
        expect(v.reason).toMatch(/Zod schema/);
        expect(v.reason).toMatch(/moot/);
    });

    // The case the normal upgrade workflow produces EVERY time: import a card (which opens a chat, so
    // MVU runs), THEN install the pack. MVU has already stamped the book and derived from an empty save.
    it('flags the stamped-book + empty-schema case, and names the book', () => {
        const v = run();
        expect(v.lagged).toBe(true);
        expect(v.reason).toContain('ArtificKoi');
        expect(v.reason).toMatch(/before this pack was installed/);
    });

    it('stays quiet once MVU has actually derived a schema', () => {
        expect(run({ schemaPropertyCount: 12 }).lagged).toBe(false);
    });

    // Not-yet-read is the GOOD case, and it must not be confused with the bad one: MVU will read the
    // pack's [InitVar] when it initialises, which is exactly what we want.
    it('stays quiet when MVU has not read the book yet — it will pick the entry up', () => {
        const v = run({ initializedBooks: {} });
        expect(v.lagged).toBe(false);
        expect(v.reason).toMatch(/has not read this book yet/);
    });

    it('a DIFFERENT book being stamped says nothing about ours', () => {
        expect(run({ initializedBooks: { SomeOtherCard: [] } }).lagged).toBe(false);
    });

    // A pack with no [InitVar] gives MVU nothing to derive FROM, so the whole question is moot — warning
    // there would fire on every plugin and every pack that only ships prose.
    it('stays quiet when the pack ships no [InitVar]', () => {
        expect(run({ pack: { packType: 'gamelogic', id: 'x', entries: [{ comment: 'Worldview', content: 'w' }] } }).lagged).toBe(false);
    });

    // UNREADABLE IS NOT THE SAME AS EMPTY, and conflating them is how a log starts lying: absent-but-
    // readable is `{}` / `0`, which are real answers; undefined means we could not look.
    it('claims NOTHING when what it needs is unreadable', () => {
        for (const over of [
            { initializedBooks: undefined }, { initializedBooks: null },
            { schemaPropertyCount: undefined }, { bookName: '' },
        ]) {
            const v = run(over);
            expect(v.lagged).toBe(false);
            expect(v.reason).toMatch(/unreadable|no book name|has no schema/);
        }
    });

    it('survives being called with nothing at all', () => {
        expect(decideMvuSchemaLag().lagged).toBe(false);
        expect(decideMvuSchemaLag({}).lagged).toBe(false);
    });
});

// plans/executed/plugin-sidepanel.md §3 — the plugin's display half, declared the way a layout is: carried
// verbatim, `kind` + `format` read, `customLogic` refused. Plugin-only by §3's table.
describe('panel — the side-panel declaration (plugin-sidepanel.md §3)', () => {
    const PANEL = { kind: 'slot-list', format: '1.0', title: 'NPC Outfits', tabs: [] };

    it('a plugin AND a gamelogic pack may each carry one — both own state worth showing', () => {
        expect(validatePack(base('plugin', { panel: PANEL })).ok).toBe(true);
        expect(validatePack(base('gamelogic', { panel: PANEL })).ok).toBe(true);
    });

    // The menu IS the display artifact and declares `layout`. A second display declaration beside it
    // would be two answers to "what does this draw" with nothing to arbitrate them.
    it('rule 2 refuses it on a StatusMenu Pack, naming a type that may carry it', () => {
        const res = validatePack(base('statusmenu', { panel: PANEL, engine: ENGINE, targetsPackId: 't' }));
        expect(res.ok).toBe(false);
        expect(res.errors.some((e) => e.startsWith('rule 2:') && e.includes('"panel"'))).toBe(true);
    });

    it('rule 1: it must be an object carrying string kind and format — the two things the host reads', () => {
        expect(validatePack(base('plugin', { panel: 'x' })).errors.join()).toMatch(/rule 1.*"panel".*object/);
        expect(validatePack(base('plugin', { panel: [] })).errors.join()).toMatch(/rule 1.*"panel".*object/);
        expect(validatePack(base('plugin', { panel: { format: '1.0' } })).errors.join()).toMatch(/rule 1.*"kind"/);
        expect(validatePack(base('plugin', { panel: { kind: 'slot-list' } })).errors.join()).toMatch(/rule 1.*"format"/);
        expect(validatePack(base('plugin', { panel: { kind: '  ', format: '1.0' } })).errors.join()).toMatch(/rule 1.*"kind"/);
    });

    it('rule 6: customLogic anywhere inside is refused, naming the site', () => {
        const res = validatePack(base('plugin', { panel: { ...PANEL, tabs: [{ blocks: [{ customLogic: 'x' }] }] } }));
        expect(res.ok).toBe(false);
        expect(res.errors.join()).toMatch(/rule 6: panel carries "customLogic" at tabs\.0\.blocks\.0\.customLogic/);
    });

    // The panel entry is reserved by rule 4 (its comment is inside the control prefix), not by a
    // marker word: "(Panel)" in prose is ordinary, and `[GameLogicPack:x:Panel]` in prose is refused.
    it('prose mentioning a panel is accepted; the section entry\'s own spelling is refused by rule 4', () => {
        for (const type of ['plugin', 'gamelogic']) {
            const prose = validatePack(base(type, { entries: [{ comment: 'notes on the (Panel) slot', content: 'x' }] }));
            expect(prose.errors.filter((e) => e.startsWith('rule 4:'))).toEqual([]);
            const spoof = validatePack(base(type, { entries: [{ comment: 'see [GameLogicPack:x:Panel]', content: 'x' }] }));
            expect(spoof.ok).toBe(false);
            expect(spoof.errors.join()).toMatch(/rule 4:/);
        }
    });

    it('is a format-1.0 section, so the rule-5 cross-check has a row for it', () => {
        expect(SECTION_MIN_FORMAT.panel).toBe('1.0');
    });

    // The declaration installs AS AN ENTRY, which is what makes upgrade's pre-delete, uninstall's
    // needle sweep and the exactness count carry it with no branch of their own.
    it('planInstallEntries emits it as a silent entry the REAL sweep catches', () => {
        const plan = planInstallEntries({ packType: 'gamelogic', id: 'rpg-artific', panel: PANEL, entries: [{ comment: 'Reply_Request', content: 'x' }] });
        expect(plan.entries[0].comment).toBe('[GameLogicPack:rpg-artific:Panel]');
        expect(plan.entries[0].enabled).toBe(false);
        expect(plan.entries[0].type).toBe('constant');
        expect(JSON.parse(plan.entries[0].content)).toEqual(PANEL);
        expect(plan.installedComments).toContain('[GameLogicPack:rpg-artific:Panel]');
        expect(commentMatchesNeedle(plan.entries[0].comment, installedSweepNeedle('gamelogic', 'rpg-artific'))).toBe(true);
        expect(commentMatchesNeedle(plan.entries[0].comment, installedSweepNeedle('gamelogic', 'rpg'))).toBe(false);
    });

    it('a pack with no panel plans no such entry — a pack with no display half is the ordinary case', () => {
        const plan = planInstallEntries({ packType: 'gamelogic', id: 'rpg-artific', entries: [{ comment: 'Reply_Request', content: 'x' }] });
        expect(plan.entries.some((e) => e.comment.includes(':Panel]'))).toBe(false);
    });

    it('the two lanes write DIFFERENT comments — one contract, per-artifact ownership', () => {
        expect(panelEntryComment('gamelogic', 'x')).toBe('[GameLogicPack:x:Panel]');
        expect(panelEntryComment('plugin', 'x')).toBe('[GameLogicPlugin:x:Panel]');
        expect(planPanelEntry('gamelogic', 'x', null)).toBeNull();
        expect(planPanelEntry('gamelogic', 'x', [])).toBeNull();
    });
});

// The unreadable SENTENCE is shared (card-access-core's cardUnreadableReason) and this lane must
// PASS the book facts into it. Pinned because the pass-through is invisible when it is missing: the
// generic "retry in a moment" is a perfectly plausible-looking string for a card whose book will
// never answer, which is exactly how the live 2026-08-31 bug read as a transient.
describe('decideActivation — the unreadable reason is the SPECIFIC one', () => {
    const unreadable = (bookBinding, bookName) => decideActivation({
        isCardOpen: true, isChatStarted: true, areEntriesReadable: false,
        bookBinding, bookName,
        pack: { packType: 'gamelogic', id: 'x', version: '1' }, registry: null,
    });

    it('an embedded-but-unimported book is told to Import Card Lore, not to wait', () => {
        const r = unreadable('embedded-not-imported');
        expect(r.action).toBe('card-unreadable');
        expect(r.reasons[0]).toContain('Import Card Lore');
        expect(r.reasons[0]).not.toContain('Retry in a moment');
    });

    it('a card with no book linked is told to link one', () => {
        expect(unreadable('no-book-bound').reasons[0]).toContain('Link to World Info');
    });

    it('a dangling bind names the book', () => {
        expect(unreadable('dangling-bind', 'Ghost Book').reasons[0]).toContain('"Ghost Book"');
    });

    it('a book that exists but has not answered keeps the honest wait', () => {
        expect(unreadable('loading').reasons[0]).toContain('Retry in a moment');
    });
});
