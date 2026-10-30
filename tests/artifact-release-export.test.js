// tests/artifact-release-export.test.js — W6, the release export (workflow plan §8).
//
// THE ROUND TRIP: export(install(A)) equals A, per lane, composed from the same PURE functions the
// activations call (planInstallEntries / planMenuEntries / planPluginEntries + the registry helpers)
// — the activation literals themselves are host-coupled and unit-blind (L6), so their glue is the
// live half. Equality is byte-exact for entries in TavernHelper's normalized form, which is what a
// pack file's entries[] ARE; the card adds uid/display_index and the export strips exactly those.
// THE ADDITIVE PROPERTY (§8.0): foreign rows beside the artifact never appear in the output —
// they are filtered by the registry's own list, never enumerated.
// THE REFUSALS (§8.3): a recorded piece the card lost refuses BY NAME; export never invents.

import { describe, it, expect } from 'vitest';
import {
    planInstallEntries, packStateRecord, buildPackExportFile, validatePack,
} from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import {
    planMenuEntries, buildMenuExportFile, MARKER_LAST_REGEX_NAME, liftMenuRegexRows,
} from '../src/features/statusmenu-pack/statusmenu-pack-core.js';
import { withMarkerLastRow } from '../src/features/statusmenu-pack/statusmenu-pack-marker-last.js';
import { wrapRenderedRegion } from '../src/shared/rendered-region.js';
import {
    planPluginEntries, planPluginEngineEntry, planPluginPanelEntry, buildPluginRecord,
    buildPluginExportFile, unsubstituteTokens, substituteTokens, pluginOwnRoot,
} from '../src/features/gamelogic-plugin/gamelogic-plugin-core.js';
import { artifactIdentityRecord } from '../src/shared/card-artifact-store.js';

// Foreign rows that must NEVER reach an export (§8.0) — a second artifact, hand-made rows, bookkeeping.
const FOREIGN_ENTRIES = [
    { comment: '[EventPack:seasons] spring festival', content: 'foreign', enabled: true, type: 'constant', keys: [] },
    { comment: 'hand-made worldbook note', content: 'mine', enabled: true, type: 'selective', keys: ['note'] },
    { comment: '[GameLogicPack:Registry]', content: '{}', enabled: false, type: 'constant', keys: [] },
];
const FOREIGN_REGEX = { id: 'zz', script_name: 'SomeoneElses', find_regex: '/q/', replace_string: '' };
const onCard = (entries) => entries.map((e, i) => ({ ...e, uid: 100 + i, display_index: i }));

// ── gamelogic ────────────────────────────────────────────────────────────────

const GAME = {
    format: '1.0', packType: 'gamelogic', id: 'rpg-artific', name: 'RPG Artific', description: 'the game',
    version: '2.0', builtWith: 'maker 1.0',
    engine: "// RPG Engine\nconst ENGINE_VERSION = 'v2.0';\nconst ENGINE_NAME = 'RPG';\nmodule.exports = { ENGINE_VERSION, ENGINE_NAME, resolveTurn() { return []; } };\n",
    schema: 'registerMvuSchema(z.looseObject({ GameLogicPlugin: z.record(z.any()) }));',
    entries: [
        { comment: 'A lore', content: 'lore text', enabled: true, type: 'constant', key: [], keys: [] },
        { comment: '[PRE] Check_Dice', content: 'routed', enabled: true, type: 'selective', key: [], keys: [] },
    ],
    panel: { kind: 'stat-grid', format: '1.0', rows: [] },
    regex: [{ script_name: 'RpgDisplay', find_regex: '/x/', replace_string: 'y', trim_strings: [] }],
    regexOrder: ['RpgDisplay'],
    state: { version: '4.0', force: { 'World.Weather': ['Clear', 'w'] }, forceFromInitVar: ['Cast.events'] },
    exposes: { 'cast@1': 'Cast' },
};

// The registry an install writes, composed from the SAME pure helpers the activation uses.
function gameRegistryOf(pack, plan) {
    return {
        activePackId: pack.id, ver: pack.version, installedComments: plan.installedComments,
        engineOwned: true, schemaOwned: true,
        installedRegexNames: pack.regex.map((r) => r.script_name),
        ...packStateRecord(pack),
        exposes: pack.exposes,
        ...artifactIdentityRecord(pack),
        ...(Array.isArray(pack.regexOrder) ? { regexOrder: pack.regexOrder } : {}),
        installedAt: '2026-09-03',
    };
}

describe('W6 gamelogic — export(install(A)) equals A', () => {
    const plan = planInstallEntries(GAME);
    const args = () => ({
        registry: gameRegistryOf(GAME, plan),
        entries: [...FOREIGN_ENTRIES, ...onCard(plan.entries)],
        engineText: GAME.engine, schemaText: GAME.schema,
        cardRegexes: [FOREIGN_REGEX, ...GAME.regex.map((r) => ({ ...r, id: 'inst-1' }))],
    });
    it('MUTATION TARGET — the full round trip, foreign rows present and never exported', () => {
        const { pack, errors } = buildPackExportFile(args());
        expect(errors).toEqual([]);
        expect(pack).toEqual(GAME);
        expect(validatePack(pack).ok).toBe(true);
    });
    it('a recorded entry the card lost REFUSES BY NAME (§8.3)', () => {
        const a = args();
        a.entries = a.entries.filter((e) => !String(e.comment).endsWith('A lore'));
        const { pack, errors } = buildPackExportFile(a);
        expect(pack).toBeNull();
        expect(errors.join(' ')).toContain('A lore');
    });
    it('owned engine unreadable REFUSES; a recorded regex missing REFUSES by name', () => {
        const a1 = { ...args(), engineText: null };
        expect(buildPackExportFile(a1).errors.join(' ')).toContain('engine ownership');
        const a2 = args(); a2.cardRegexes = [FOREIGN_REGEX];
        expect(buildPackExportFile(a2).errors.join(' ')).toContain('RpgDisplay');
    });
    it('a registry with no identity refuses and says how to fix it', () => {
        const a = args(); delete a.registry.name; delete a.registry.description; delete a.registry.format;
        expect(buildPackExportFile(a).errors.join(' ')).toMatch(/records no identity.*Repair the pack once/);
    });
    // LIVE 2026-09-03, School v4: A's file carried `state: { version, force: {} }` and the export
    // emitted `state: { version }`. NOT a defect and NOT fixable — packStateRecord normalizes an
    // ABSENT force and an EMPTY one to the same `{}`, so the registry cannot tell them apart and
    // either choice is wrong for the other case. Emitting nothing is the honest one: it invents no
    // field. install(export(A)) still equals install(A), which is the property that matters (§8.4's
    // one-way flattening, same class as engine/ collapsing to one file).
    it('an EMPTY state.force or forceFromInitVar is dropped, not emitted — the registry cannot tell absent from empty', () => {
        const withEmptyForce = { ...GAME, state: { version: '4.0', force: {}, forceFromInitVar: [] } };
        const p = planInstallEntries(withEmptyForce);
        const reg = gameRegistryOf(withEmptyForce, p);
        expect(reg.force).toEqual({});                       // install stored {} either way
        expect(reg.forceFromInitVar).toEqual([]);
        const { pack, errors } = buildPackExportFile({
            registry: reg, entries: onCard(p.entries),
            engineText: GAME.engine, schemaText: GAME.schema,
            cardRegexes: GAME.regex.map((r) => ({ ...r, id: 'x' })),
        });
        expect(errors).toEqual([]);
        expect(pack.state).toEqual({ version: '4.0' });
        expect('force' in pack.state).toBe(false);
        expect('forceFromInitVar' in pack.state).toBe(false);
    });
    it('sparse A: no engine, no schema, no regex, no state — nothing is invented', () => {
        const sparse = {
            format: '1.0', packType: 'gamelogic', id: 'tiny', name: 'Tiny', description: 'd', version: '1.0',
            entries: [{ comment: 'one', content: 'x', enabled: true, type: 'constant', key: [], keys: [] }],
        };
        const p = planInstallEntries(sparse);
        const reg = {
            activePackId: 'tiny', ver: '1.0', installedComments: p.installedComments,
            engineOwned: false, schemaOwned: false, installedRegexNames: [],
            ...packStateRecord(sparse), exposes: {}, ...artifactIdentityRecord(sparse), installedAt: '',
        };
        const { pack, errors } = buildPackExportFile({ registry: reg, entries: onCard(p.entries), engineText: null, schemaText: null, cardRegexes: [FOREIGN_REGEX] });
        expect(errors).toEqual([]);
        expect(pack).toEqual(sparse);
    });
});

// ── statusmenu ───────────────────────────────────────────────────────────────

const MENU = {
    format: '1.0', packType: 'statusmenu', id: 'artifickoi', name: 'ArtificKoi', description: 'the menu',
    version: '1.1', builtWith: 'MvuStatMenuBuilder 2.0', targetsPackId: 'school-v4',
    engine: "// ArtificKoi StatusMenu Engine\nconst ENGINE_VERSION = 'v1.1';\nmodule.exports = { ENGINE_VERSION, formatters: {}, actions: {} };\n",
    entries: [{ comment: 'menu prompt note', content: 'p', enabled: false, type: 'constant', key: [], keys: [] }],
    layout: { layoutKind: 'tabbed-grid', layoutFormat: '1.0', tabs: [] },
    regex: [
        { script_name: 'StatusMenu', find_regex: '/<StatusPlaceHolderImpl\\/>/', replace_string: 'shell', trim_strings: [] },
        { script_name: 'GameStartMenu', find_regex: '/<GameStartMenu\\/>/', replace_string: 'start', trim_strings: [] },
    ],
    regexOrder: ['StatusMenu', 'GameStartMenu'],
};

describe('W6 statusmenu — export(install(A)) equals A', () => {
    const plan = planMenuEntries(MENU);
    // The registry is composed the way ACTIVATION composes it, not the way the pack file reads: the
    // marker-last row rides in the same syncRegexes write and IS recorded in installedRegexNames
    // (so uninstall removes it), while regexOrder records only the pack's own declaration. A fixture
    // that listed MENU.regex here would model a registry install never writes — and would miss the
    // one row the export has to drop.
    const installedRegexes = withMarkerLastRow(MENU.regex, MENU.regexOrder).regexes;
    const onCardRegexes = installedRegexes.map((r, i) => ({ ...r, id: 'inst-' + i }));
    const registry = {
        activeMenuId: MENU.id, ver: MENU.version, installedComments: plan.installedComments,
        engineOwned: true, installedRegexNames: installedRegexes.map((r) => r.script_name), shellOwned: false,
        ...artifactIdentityRecord(MENU), regexOrder: MENU.regexOrder, installedAt: '2026-09-03',
    };
    it('MUTATION TARGET — layout re-parses from its entry; identity and targetsPackId ride the registry', () => {
        const { pack, errors } = buildMenuExportFile({
            registry, entries: [...FOREIGN_ENTRIES, ...onCard(plan.entries)],
            engineText: MENU.engine,
            cardRegexes: [FOREIGN_REGEX, ...onCardRegexes],
        });
        expect(errors).toEqual([]);
        expect(pack).toEqual(MENU);
        expect(validatePack(pack).ok).toBe(true);
    });
    it('the marker-last row is mvu-helper\'s, not the pack\'s — recorded, installed, and left behind', () => {
        expect(registry.installedRegexNames).toContain(MARKER_LAST_REGEX_NAME);
        expect(onCardRegexes.some((r) => r.script_name === MARKER_LAST_REGEX_NAME)).toBe(true);
        const { pack, errors } = buildMenuExportFile({
            registry, entries: onCard(plan.entries), engineText: MENU.engine, cardRegexes: onCardRegexes,
        });
        expect(errors).toEqual([]);
        // Shipping it would put a platform row inside a consumer artifact AND fail rule 14, because
        // regexOrder records the pack's declaration and never names it.
        expect(pack.regex.map((r) => r.script_name)).toEqual(MENU.regexOrder);
        expect(validatePack(pack).ok).toBe(true);
    });
    it('a (Layout) entry that no longer parses refuses naming the entry, not a stack trace', () => {
        const broken = onCard(plan.entries).map((e) => e.comment.endsWith('(Layout)') ? { ...e, content: '{ not json' } : e);
        const { pack, errors } = buildMenuExportFile({ registry, entries: broken, engineText: MENU.engine, cardRegexes: onCardRegexes });
        expect(pack).toBeNull();
        expect(errors.join(' ')).toContain('(Layout)');
    });
});

// The containment lift (plans/executed/statusmenu-containment.md M2): the card holds the menu row in MARKER
// form and the shipped row's text in [MVU_StatusMenuBody]; the export puts the text back VERBATIM.
// So export(lift(A)) equals A, byte for byte — and a card that lost the body refuses by name.
describe('W6 statusmenu — export(lift(A)) equals A', () => {
    const FENCE = String.fromCharCode(96).repeat(3);
    const document = '<!DOCTYPE html>\n<html>\n<body><script>const s = "</html>";</script></body>\n</html>';
    // Two wrapped documents in two regions, as School ships them: the menu and a game-start form.
    const SHIPPED = {
        ...MENU,
        regex: [
            { ...MENU.regex[0], replace_string: wrapRenderedRegion('statusmenu', FENCE + '\n' + document + '\n' + FENCE) },
            { ...MENU.regex[1], replace_string: wrapRenderedRegion('game-start-menu', FENCE + '\n<!DOCTYPE html>\n<html><body>form</body></html>\n' + FENCE) },
        ],
    };
    const plan = planMenuEntries(SHIPPED);
    const lift = liftMenuRegexRows(SHIPPED.regex, SHIPPED.id);
    const menuBodies = Object.fromEntries(lift.lifted.map((l) => [l.name, l.text]));
    const installedRegexes = withMarkerLastRow(lift.rows, SHIPPED.regexOrder).regexes;
    const onCardRegexes = installedRegexes.map((r, i) => ({ ...r, id: 'inst-' + i }));
    const registry = {
        activeMenuId: SHIPPED.id, ver: SHIPPED.version, installedComments: plan.installedComments,
        engineOwned: true, installedRegexNames: installedRegexes.map((r) => r.script_name), shellOwned: false,
        liftedRows: lift.lifted.map((l) => l.name),
        ...artifactIdentityRecord(SHIPPED), regexOrder: SHIPPED.regexOrder, installedAt: '2026-09-23',
    };
    it('the card holds every document in marker form, never the document', () => {
        expect(lift.ok).toBe(true);
        expect(lift.lifted.map((l) => l.name)).toEqual(['StatusMenu', 'GameStartMenu']);
        for (const name of ['StatusMenu', 'GameStartMenu']) {
            const row = onCardRegexes.find((r) => r.script_name === name);
            expect(row.replace_string).not.toContain(FENCE);
            expect(row.replace_string).toContain('data-mvu-helper-menu="artifickoi"');
            expect(row.replace_string).toContain('data-mvu-helper-menu-row="' + name + '"');
        }
    });
    it('MUTATION TARGET — the export restores every shipped row byte for byte from its body text', () => {
        const { pack, errors } = buildMenuExportFile({
            registry, entries: [...FOREIGN_ENTRIES, ...onCard(plan.entries)],
            engineText: SHIPPED.engine, cardRegexes: [FOREIGN_REGEX, ...onCardRegexes], menuBodies,
        });
        expect(errors).toEqual([]);
        expect(pack).toEqual(SHIPPED);
        expect(validatePack(pack).ok).toBe(true);
    });
    it('a card that lost one body entry refuses by name — export never invents a document', () => {
        const { pack, errors } = buildMenuExportFile({
            registry, entries: onCard(plan.entries), engineText: SHIPPED.engine, cardRegexes: onCardRegexes, menuBodies: { StatusMenu: menuBodies.StatusMenu },
        });
        expect(pack).toBeNull();
        expect(errors.join(' ')).toContain('[MVU_StatusMenuBody:GameStartMenu]');
        expect(errors.join(' ')).toContain('"GameStartMenu"');
    });
});

// ── plugin ───────────────────────────────────────────────────────────────────

const PLUGIN_FILE = {
    format: '1.0', packType: 'plugin', id: 'worldsim', name: 'World Sim', description: 'a plugin',
    version: '0.3', builtWith: 'hand 1.0',
    engine: "// worldsim plugin engine\nconst ENGINE_VERSION = 'v0.3';\nmodule.exports = { ENGINE_VERSION, resolveRelay() { return []; } };\n",
    // Rule 7: every plugin ships one, so the export round trip must carry it too.
    schema: 'registerMvuSchema(z.looseObject({ GameLogicPlugin: z.record(z.string(), z.any()) }));',
    entries: [
        { comment: '{PRE_CALL} worldsim request', content: 'read {OWN_ROOT}.ledger then call {PRE_CALL}', enabled: true, type: 'selective', key: [], keys: [] },
        { comment: 'worldsim narrate', content: 'untagged narrate entry', enabled: true, type: 'constant', key: [], keys: [] },
    ],
    panel: { kind: 'stat-grid', format: '1.0' },
    requires: ['cast@1'],
    optionalUses: ['equipment@1'],
};
const BINDINGS = { preCall: 'Check_DC_Dice', postCall: '', ownRoot: pluginOwnRoot('WorldSim') };

describe('W6 plugin — export(install(A)) equals A, tokens restored', () => {
    const plan = planPluginEntries(PLUGIN_FILE, BINDINGS);
    const engineEntry = planPluginEngineEntry(PLUGIN_FILE);
    const panelEntry = planPluginPanelEntry(PLUGIN_FILE);
    const installedComments = [...plan.installedComments, engineEntry.comment, panelEntry.comment];
    const record = buildPluginRecord({
        plugin: PLUGIN_FILE, stateName: 'WorldSim', preCall: BINDINGS.preCall, postCall: '',
        installedComments, installedAt: '2026-09-03',
    });
    it('MUTATION TARGET — substituted call names and OWN_ROOT come back as tokens', () => {
        const { pack, errors } = buildPluginExportFile({
            record,
            entries: [...FOREIGN_ENTRIES, ...onCard([...plan.entries, engineEntry, panelEntry])],
        });
        expect(errors).toEqual([]);
        expect(pack).toEqual(PLUGIN_FILE);
        expect(validatePack(pack).ok).toBe(true);
    });
    it('unsubstituteTokens is the exact inverse of substituteTokens on this record', () => {
        const text = 'call {PRE_CALL} then write {OWN_ROOT}.x';
        expect(unsubstituteTokens(substituteTokens(text, BINDINGS), BINDINGS)).toBe(text);
    });
    it('the recorded engine entry missing from the card refuses by name', () => {
        const { pack, errors } = buildPluginExportFile({ record, entries: onCard([...plan.entries, panelEntry]) });
        expect(pack).toBeNull();
        expect(errors.join(' ')).toContain(':Engine]');
    });
});
