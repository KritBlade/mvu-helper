// tests/statusmenu-pack-core.test.js — the StatusMenu Pack lane's pure decisions (G3).
//
// What each block guards, and the mutation that proves the guard is one (run by hand, recorded in
// the suite comments where the case is not obvious from the assertion itself):
//   • the LAYOUT comment must be visible to the uninstall sweep, and it keeps the '] (Layout)'
//     spelling because MvuStatMenuBuilder's shipped shell reads it (see menuLayoutComment);
//   • the registry parse must THROW on malformed content, never read it as "no menu";
//   • a repeat of the activation decision's inputs must land the same action (pure);
//   • the patch guard refuses the WHOLE action on one malformed patch;
//   • the LED goes red when an OWNED engine entry is absent — and only then.

import { PATCH_VERBS } from '../src/shared/json-patch-ops.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedSweepNeedle, commentMatchesNeedle, slotFingerprint } from '../src/shared/card-artifact-store.js';
import { createEngineWorkerRuntime, nestedFunctionNames, resolveScopeExport } from '../src/features/logic-engine/logic-engine-core.js';
import { validatePack } from '../src/features/gamelogic-pack/gamelogic-pack-core.js';
import { wrapRenderedRegion, isTavernHelperFrontendText } from '../src/shared/rendered-region.js';
import { PLACEHOLDER_SHELL_REGEX } from '../src/shared/placeholder-menu-shell.js';
import { MARKER_LAST_REGEX } from '../src/features/statusmenu-pack/statusmenu-pack-marker-last.js';
import {
    STATUSMENU_TYPE,
    menuRegistryComment, menuLayoutComment,
    parseMenuRegistry, buildMenuRegistryContent,
    planMenuEntries, decideMenuActivation,
    layoutFormatterNames, missingFormatterNames, layoutActionNames, missingActionNames,
    menuPatchProblem, validateMenuPatches, deriveMenuLed, menuOwnedSlots,
    readMenuActionRequest, readMenuFormatterRequest, menuFormatterCalls, toMvuPatchOps, MENU_ACTION_MESSAGE, MENU_FORMATTER_MESSAGE,
    readMenuActionInputsRequest, menuInputProblem, validateMenuInputs, MENU_ACTION_INPUTS_MESSAGE, MENU_INPUT_KINDS,
    menuReloadReason,
    MENU_PLACEHOLDER, placeholderClaimants, shellInstallDisposition, MARKER_LAST_REGEX_NAME,
    MENU_MOUNT_ATTRIBUTE, MENU_MOUNT_ROW_ATTRIBUTE, menuMarkerRowText, menuMarkerRowName, isMenuMarkerRowText,
    liftMenuRegexRows, restoreLiftedMenuRows, auditMenuRows, menuBodyComment, menuBodyRowName, menuEngineStatusView,
} from '../src/features/statusmenu-pack/statusmenu-pack-core.js';

const LAYOUT = [
    {
        id: 'probe-tab',
        title: 'Lane Probe',
        cards: [
            { type: 'Text', mappedKey: 'Mainchar.Money', formatters: { text: 'moneyDisplay' } },
            { type: 'Image', mappedKey: 'World.MapImage', sourceType: 'lorebook', lorebookKey: 'Map', formatters: { lorebookKey: 'mapVariant' } },
            { type: 'Text', mappedKey: 'World.Weather', formatters: { text: 'missingFormatter' } },
            { type: 'Button', action: 'probeEquip' },
        ],
    },
];

const PACK = {
    format: '1.0', packType: 'statusmenu', id: 'lane-probe-menu', name: 'Probe', description: 'x',
    version: '1.0', layout: LAYOUT,
    regex: [{ script_name: 'LaneProbeMenu', find_regex: '/<LaneProbeMenu\\/>/g', replace_string: '' }],
};

const ACCESS = { isCardOpen: true, isChatStarted: true, areEntriesReadable: true };

describe('the layout entry comment survives the uninstall sweep', () => {
    it('keeps the published spelling AND is found by the REAL sweep', () => {
        const comment = menuLayoutComment('lane-probe-menu');
        expect(comment).toBe('[StatusMenuPack:lane-probe-menu] (Layout)');
        expect(commentMatchesNeedle(comment, installedSweepNeedle(STATUSMENU_TYPE, 'lane-probe-menu'))).toBe(true);
    });
    it('and one id cannot sweep a longer id\'s entry', () => {
        expect(commentMatchesNeedle(menuLayoutComment('rpg-artific'), installedSweepNeedle(STATUSMENU_TYPE, 'rpg'))).toBe(false);
    });
});

describe('registry round-trip', () => {
    const reg = {
        activeMenuId: 'lane-probe-menu', ver: '1.0',
        installedComments: ['[StatusMenuPack:lane-probe-menu] (Layout)'],
        engineOwned: true, engineFingerprint: 'k3x9z1', installedRegexNames: ['LaneProbeMenu'], shellOwned: false, liftedRows: [], installedAt: '2026-08-26',
        // W7 identity — parse always emits the three; builtWith/targetsPackId only when recorded.
        name: '', description: '', format: '',
    };
    it('build → parse is lossless', () => {
        const back = parseMenuRegistry(buildMenuRegistryContent(reg));
        expect(back).toEqual(reg);
    });
    // W7 — identity beside ownership: what the menu is CALLED survives the round trip, and
    // targetsPackId (the one statusmenu-only identity field) rides with it when declared.
    it('W7: identity and targetsPackId round-trip; absent optionals stay ABSENT', () => {
        const rich = { ...reg, name: 'ArtificKoi', description: 'menu', format: '1.0', builtWith: 'builder 2.0', targetsPackId: 'school-v4' };
        const back = parseMenuRegistry(buildMenuRegistryContent(rich));
        expect(back).toEqual(rich);
        const bare = parseMenuRegistry(buildMenuRegistryContent(reg));
        expect('builtWith' in bare).toBe(false);
        expect('targetsPackId' in bare).toBe(false);
    });
    it('THROWS on malformed JSON — a broken registry must never read as "no menu active"', () => {
        expect(() => parseMenuRegistry('{ not json')).toThrow();
    });
    it('throws on a record with no activeMenuId', () => {
        expect(() => parseMenuRegistry('{"ver":"1.0"}')).toThrow(/activeMenuId/);
    });
    it('an empty body parses as an error too (whenEmpty null → not an object)', () => {
        expect(() => parseMenuRegistry('')).toThrow();
    });
    it('the registry entry is its OWN comment, not the pack\'s (V17 separation)', () => {
        expect(menuRegistryComment()).toBe('[StatusMenuPack:Registry]');
    });
});

describe('planMenuEntries', () => {
    it('writes the layout as ONE silent entry plus prefixed generic entries', () => {
        const plan = planMenuEntries({ ...PACK, entries: [{ comment: 'menu css', content: 'x', enabled: false }] });
        expect(plan.entries).toHaveLength(2);
        const layout = plan.entries[0];
        expect(layout.comment).toBe('[StatusMenuPack:lane-probe-menu] (Layout)');
        expect(layout.enabled).toBe(false);
        expect(JSON.parse(layout.content)).toEqual(LAYOUT);
        expect(plan.entries[1].comment).toBe('[StatusMenuPack:lane-probe-menu] menu css');
        expect(plan.installedComments).toEqual(plan.entries.map((e) => e.comment));
    });
    it('a pack with no layout section plans no layout entry', () => {
        const { layout: _l, ...noLayout } = PACK;
        expect(planMenuEntries(noLayout).entries).toHaveLength(0);
    });
});

describe('decideMenuActivation', () => {
    it('refuses without a chat, and unreadable is a WAIT not an instruction', () => {
        expect(decideMenuActivation({ ...ACCESS, isChatStarted: false, pack: PACK }).action).toBe('no-chat');
        expect(decideMenuActivation({ ...ACCESS, areEntriesReadable: false, pack: PACK }).action).toBe('card-unreadable');
    });
    it('refuses the wrong packType, named', () => {
        const res = decideMenuActivation({ ...ACCESS, pack: { ...PACK, packType: 'gamelogic' } });
        expect(res.action).toBe('invalid');
        expect(res.reasons[0]).toContain('gamelogic');
    });
    it('a menu shipping regexes needs the regex API; one shipping none does not', () => {
        expect(decideMenuActivation({ ...ACCESS, pack: PACK, regexApiUp: false }).action).toBe('regex-api-down');
        const { regex: _r, ...noRegex } = PACK;
        expect(decideMenuActivation({ ...ACCESS, pack: noRegex, regexApiUp: false }).action).toBe('install');
    });
    it('no registry → install; same id → reinstall/upgrade/downgrade by version', () => {
        expect(decideMenuActivation({ ...ACCESS, pack: PACK, registry: null }).action).toBe('install');
        const reg = { activeMenuId: 'lane-probe-menu', ver: '1.0' };
        expect(decideMenuActivation({ ...ACCESS, pack: PACK, registry: reg }).action).toBe('reinstall');
        expect(decideMenuActivation({ ...ACCESS, pack: { ...PACK, version: '1.1' }, registry: reg }).action).toBe('upgrade');
        const down = decideMenuActivation({ ...ACCESS, pack: { ...PACK, version: '0.9' }, registry: reg });
        expect(down.action).toBe('downgrade');
        expect(down.reasons[0]).toContain('confirm');
        expect(down).toMatchObject({ installedVersion: '1.0', libraryVersion: '0.9' });
    });
    it('a DIFFERENT active id is a switch, and the reason names the one being replaced', () => {
        const res = decideMenuActivation({ ...ACCESS, pack: PACK, registry: { activeMenuId: 'other-menu', ver: '2.0' } });
        expect(res.action).toBe('switch');
        expect(res.reasons[0]).toContain('other-menu');
        expect(res.activeMenuId).toBe('other-menu');
    });
});

describe('formatter surfaces (§9.5/§10a)', () => {
    it('layoutFormatterNames collects every referenced name, deduped', () => {
        expect(layoutFormatterNames(LAYOUT)).toEqual(['mapVariant', 'missingFormatter', 'moneyDisplay']);
    });
    it('missingFormatterNames finds exactly the deliberate gap', () => {
        expect(missingFormatterNames(LAYOUT, ['moneyDisplay', 'mapVariant'])).toEqual(['missingFormatter']);
        expect(missingFormatterNames(LAYOUT, ['moneyDisplay', 'mapVariant', 'missingFormatter'])).toEqual([]);
    });
});

describe('action surfaces — what the layout PROMISES a button will post', () => {
    const withVerbs = [{
        id: 't', title: 'T', cards: [
            { type: 'Button', action: 'probeEquip' },
            { type: 'QuestList', mappedKey: 'Hero.Bag', rowActions: [{ title: 'x', action: 'equip' }, { title: 'y', action: 'drop' }] },
            { type: 'QuestList', mappedKey: 'Hero.Worn', rowActions: [{ title: 'z', action: 'equip' }] },
        ],
    }];

    it('collects every DECLARED name, from both sites, deduped and sorted', () => {
        expect(layoutActionNames(withVerbs)).toEqual(['drop', 'equip', 'probeEquip']);
    });
    it('MUTATION target — a VIEW-ONLY layout declares none, so nothing is ever checked or said', () => {
        const viewOnly = [{
            id: 't', title: 'T', cards: [
                { type: 'Text', mappedKey: 'Hero.Money', formatters: { text: 'moneyDisplay' } },
                { type: 'Checkbox', mappedKey: 'Hero.Flag' },
                { type: 'QuestList', mappedKey: 'Hero.Bag', allowEdit: true, allowDelete: true },
                { type: 'Image', mappedKey: 'Hero.Portrait' },
            ],
        }];
        // Every cell above CAN post something, but the name it posts is the RENDERER's wiring, not a
        // promise this layout wrote. Reading those out of cell shapes would put a renderer's private
        // contract inside the host, and a second layoutKind would wire the same cells differently.
        expect(layoutActionNames(viewOnly)).toEqual([]);
        expect(missingActionNames(viewOnly, [])).toEqual([]);
    });
    it('missingActionNames names exactly what the engine cannot serve, and nothing when it can', () => {
        expect(missingActionNames(withVerbs, ['equip'])).toEqual(['drop', 'probeEquip']);
        expect(missingActionNames(withVerbs, ['drop', 'equip', 'probeEquip'])).toEqual([]);
        // The live case that motivated it: an engine with an EMPTY actions block serves none of them.
        expect(missingActionNames(withVerbs, [])).toEqual(['drop', 'equip', 'probeEquip']);
    });
    it('MUTATION target - a static arg named "action" is NOT a promise: walkLayout descends everywhere', () => {
        const withArg = [{ id: 't', cards: [{ type: 'ActionButton', action: 'go', args: { action: 'attack', mode: 'x' } }] }];
        expect(layoutActionNames(withArg)).toEqual(['go']);
    });
    it('a malformed entry declares nothing rather than a blank name', () => {
        expect(layoutActionNames([{ cards: [{ rowActions: [{ title: 'x' }, { title: 'y', action: '  ' }, null] }, { action: 7 }] }])).toEqual([]);
    });
});

describe('the patch guard (§9.4 as revised — malformedness only, no path fence)', () => {
    it('accepts a well-formed set/delete list', () => {
        const res = validateMenuPatches([
            { op: 'delete', path: 'Mainchar.Inventory.Sword' },
            { op: 'set', path: 'Mainchar.Equipment.Sword', value: 'x' },
        ]);
        expect(res.ok).toBe(true);
        expect(res.patches).toHaveLength(2);
    });
    it('any root is writable — the §9.4 fence is deleted, the log is the audit', () => {
        expect(menuPatchProblem({ op: 'set', path: 'WorldRecord.Events.e1', value: 1 }, 0)).toBe('');
    });
    it('ONE malformed patch refuses the WHOLE action, naming the offender', () => {
        const res = validateMenuPatches([
            { op: 'set', path: 'Mainchar.ProbeFlag', value: true },
            { op: 'assign', path: 'Mainchar.ProbeFlag2', value: true },
        ]);
        expect(res.ok).toBe(false);
        expect(res.patches).toHaveLength(0);              // nothing survives to be half-applied
        expect(res.reason).toContain('patch[1]');
        expect(res.reason).toContain('assign');
    });
    it('refuses a non-array return, a malformed path, and a valueless set', () => {
        expect(validateMenuPatches(null).ok).toBe(false);
        for (const path of ['', 'Mainchar..X', '.Mainchar', 'Mainchar.', 42]) {
            expect(menuPatchProblem({ op: 'set', path, value: 1 }, 0)).toContain('malformed path');
        }
        expect(menuPatchProblem({ op: 'set', path: 'Mainchar.X' }, 0)).toContain('sets no value');
        expect(menuPatchProblem({ op: 'delete', path: 'Mainchar.X' }, 0)).toBe('');
    });
    it('refuses a prototype key anywhere in the path', () => {
        for (const path of ['__proto__.x', 'Mainchar.constructor.prototype', 'Mainchar.Skills.__proto__']) {
            expect(menuPatchProblem({ op: 'set', path, value: 1 }, 0)).toContain('prototype key');
        }
    });
    // MUTATION TARGET: restore the ASCII-only segment regex and these keys are refused again.
    it('accepts a key in any script — the edit of a skill named in the story\'s own language', () => {
        expect(menuPatchProblem({ op: 'set', path: 'Mainchar.Skills.專屬輔助模組.Desc', value: 'x' }, 0)).toBe('');
        expect(menuPatchProblem({ op: 'set', path: 'Mainchar.Skills.橘美月的眷顧：便當與歸處.Desc', value: 'x' }, 0)).toBe('');
        expect(menuPatchProblem({ op: 'delete', path: 'Mainchar.Inventory.Pink Underwear Set' }, 0)).toBe('');
        expect(menuPatchProblem({ op: 'set', path: 'Mainchar.Skills.常駐被動/領域型 ~α.Desc', value: 'x' }, 0)).toBe('');
    });
});

describe('the LED (G3.7) — the engine dimension only this lane has', () => {
    const base = {
        inLibrary: true, isActive: true,
        recordedComments: ['[StatusMenuPack:m] (Layout)'],
        presentComments: ['[StatusMenuPack:m] (Layout)'],
        recordedRegexNames: [], presentRegexNames: [],
    };
    const owned = { engineOwned: true, engineFingerprint: slotFingerprint('menu engine') };
    const slots = (registry, engineRead) => ({ ownedSlots: menuOwnedSlots(registry, engineRead) });
    it('an OWNED engine entry that is absent is red, and the missing list names it', () => {
        const led = deriveMenuLed({ ...base, ...slots(owned, { text: '', found: false }) });
        expect(led.state).toBe('red');
        expect(led.missing).toContain('[MVU_StatusMenuEngine]');
    });
    it('owned and present is green; unowned and absent is green (a dev upload is not ours to demand)', () => {
        expect(deriveMenuLed({ ...base, ...slots(owned, { text: 'menu engine', found: true }) }).state).toBe('green');
        expect(deriveMenuLed({ ...base, ...slots({ engineOwned: false }, { text: '', found: false }) }).state).toBe('green');
    });
    it('MUTATION TARGET — a dev upload over the owned engine has drifted: named, and the row still runs', () => {
        const led = deriveMenuLed({ ...base, ...slots(owned, { text: 'the dev upload', found: true }) });
        expect(led.state).toBe('green');
        expect(led.drifted).toEqual(['[MVU_StatusMenuEngine]']);
    });
    it('MUTATION TARGET — a book that did not answer (null) is could not look, never a missing engine', () => {
        expect(menuOwnedSlots(owned, null)[0].text).toBeUndefined();
        expect(deriveMenuLed({ ...base, ...slots(owned, null) })).toMatchObject({ state: 'green', missing: [], drifted: [] });
    });
    it('the shared dimensions still rule: missing entry red, library-gone amber', () => {
        expect(deriveMenuLed({ ...base, presentComments: [] }).state).toBe('red');
        expect(deriveMenuLed({ ...base, inLibrary: false }).state).toBe('amber');
    });
});

// ── the probe pack file (G3.1) — the lane's fixture, validated where the lane is tested ──────────
// THIS REPO OWNS IT. `lane-probe-menu` is a PLATFORM probe — it exercises mvu-helper's StatusMenu
// lane and carries no genre — so it lives here, beside the tests that read it, rather than in a
// consumer's checkout. It was read out of the sibling game repo until 2026-09-07, which made these
// three tests SKIP the moment that repo reorganised and moved the file; a fixture reachable only
// when an unrelated repo is checked out is a fixture that silently stops running. Frozen on purpose:
// it is a shape to validate against, not a build output to keep current.
const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'statusmenu-lane-probe.json');

describe('the StatusMenu lane probe (the G3 test vehicle)', () => {
    const text = readFileSync(PROBE, 'utf8');
    it('passes the shared §3 validator with zero errors and zero warnings', () => {
        const pack = JSON.parse(text);
        const res = validatePack(pack);
        expect(res.errors).toEqual([]);
        expect(res.warnings).toEqual([]);
        expect(pack.packType).toBe('statusmenu');
    });
    it('its layout references ONE formatter the engine does not export — the §10a warn fixture', () => {
        const pack = JSON.parse(text);
        // The engine's exports, read the honest way: evaluate the text the way the Worker will.
        const moduleShim = { exports: {} };
        new Function('module', 'exports', pack.engine)(moduleShim, moduleShim.exports);
        const exported = Object.keys(moduleShim.exports.formatters || {});
        expect(missingFormatterNames(pack.layout, exported)).toEqual(['missingFormatter']);
    });
    it('its actions exercise both sides of the patch guard', () => {
        const pack = JSON.parse(text);
        const moduleShim = { exports: {} };
        new Function('module', 'exports', pack.engine)(moduleShim, moduleShim.exports);
        const good = moduleShim.exports.actions.probeEquip({ itemKey: 'Sword' }, {});
        expect(validateMenuPatches(good).ok).toBe(true);
        const bad = moduleShim.exports.actions.probeMalformed();
        const res = validateMenuPatches(bad);
        expect(res.ok).toBe(false);
        expect(res.reason).toContain('patch[1]');
    });
});

// ── the Worker runtime's nested-export + batch extension (G3.4/G3.6) ─────────────────────────────
// The §9.5 engine shape is two plain-object namespaces, which the flat enumeration reports as
// nothing callable — these are the additive runtime pieces that make it reachable, proven pure.

describe('nested exports and the batch call (logic-engine-core runtime)', () => {
    const menuEngine = `module.exports = {
        actions: { equip(args) { return [{ op: 'set', path: 'A.B', value: args.k }]; } },
        formatters: { money(stat, root) { return 'Y ' + root.Money; }, boom() { throw new Error('kaput'); } },
        plainData: { rows: [1, 2] },
    };`;

    const boot = () => {
        const posts = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posts.push(m),
            execute: (code, host) => { const module_ = { exports: {} }; new Function('module', 'exports', 'window', 'globalThis', code)(module_, module_.exports, host, host); return module_.exports; },
            buildHost: () => ({}),
        });
        runtime.handle({ t: 'load', texts: [{ scope: 'statusmenu', code: menuEngine }], host: {} });
        return { runtime, posts };
    };

    it('enumerates ONE level of namespaced functions, separately from flat exports', () => {
        const { posts } = boot();
        const scope = posts[0].scopes.statusmenu;
        expect(scope.error).toBe('');
        expect(scope.exports).toEqual([]);                      // the flat list stays byte-identical: nothing flat here
        expect(scope.nestedExports.sort()).toEqual(['actions.equip', 'formatters.boom', 'formatters.money']);
        // data-object children are DATA, not API — 'plainData.rows' must not enumerate
        expect(scope.nestedExports).not.toContain('plainData.rows');
    });

    it('a dotted call reaches the nested function; a flat name resolves exactly as before', async () => {
        const { runtime, posts } = boot();
        runtime.handle({ t: 'call', id: 1, scope: 'statusmenu', name: 'formatters.money', args: [null, { Money: 7 }], host: {} });
        await new Promise((r) => setTimeout(r, 0));
        expect(posts.find((m) => m.id === 1).value).toBe('Y 7');
        expect(resolveScopeExport({ flat: () => 1 }, 'flat')).toBeTypeOf('function');
        expect(resolveScopeExport({ a: { b: { c: () => 1 } } }, 'a.b.c')).toBeUndefined();   // never deeper than one level
    });

    it('callBatch: ONE message answers all, with per-call containment (§10a)', async () => {
        const { runtime, posts } = boot();
        runtime.handle({ t: 'callBatch', id: 2, scope: 'statusmenu', host: {}, calls: [
            { name: 'formatters.money', args: [null, { Money: 3 }] },
            { name: 'formatters.nope', args: [] },
            { name: 'formatters.boom', args: [] },
        ] });
        await new Promise((r) => setTimeout(r, 0));
        const res = posts.find((m) => m.id === 2);
        expect(res.t).toBe('result');                           // the batch RESOLVES even with misses in it
        expect(res.value[0]).toEqual({ ok: true, value: 'Y 3' });
        expect(res.value[1]).toEqual({ ok: false, missing: true });
        expect(res.value[2].ok).toBe(false);
        expect(res.value[2].error).toContain('kaput');
    });

    it('nestedFunctionNames ignores arrays and non-objects', () => {
        expect(nestedFunctionNames({ a: [() => 1], b: 3, c: null, d: { e: () => 1, f: 2 } })).toEqual(['d.e']);
    });
});

describe('readMenuActionRequest - three outcomes, because two would lie', () => {
    // The window carries SillyTavern traffic, other extensions and every iframe on the page. "Not
    // addressed to us" must never be reported the same way as "addressed to us and wrong".
    it('ignores a message that is not ours, in silence', () => {
        expect(readMenuActionRequest({ type: 'something-else', action: 'probeEquip' }).mine).toBe(false);
        expect(readMenuActionRequest(null).mine).toBe(false);
        expect(readMenuActionRequest('a string').mine).toBe(false);
        expect(readMenuActionRequest([]).mine).toBe(false);
    });

    it('accepts a well-formed request and echoes the requestId verbatim', () => {
        const got = readMenuActionRequest({ type: MENU_ACTION_MESSAGE, action: 'probeEquip', args: { itemKey: 'Sword' }, requestId: 'r7' });
        expect(got).toEqual({ mine: true, ok: true, action: 'probeEquip', args: { itemKey: 'Sword' }, requestId: 'r7' });
    });

    it('normalises a missing or non-object args to {} so a destructuring action cannot throw', () => {
        expect(readMenuActionRequest({ type: MENU_ACTION_MESSAGE, action: 'a' }).args).toEqual({});
        expect(readMenuActionRequest({ type: MENU_ACTION_MESSAGE, action: 'a', args: 'nope' }).args).toEqual({});
        expect(readMenuActionRequest({ type: MENU_ACTION_MESSAGE, action: 'a', args: [1, 2] }).args).toEqual({});
    });

    it('refuses OURS-but-nameless loudly rather than ignoring it', () => {
        const got = readMenuActionRequest({ type: MENU_ACTION_MESSAGE });
        expect(got.mine).toBe(true);
        expect(got.ok).toBe(false);
        expect(got.reason).toMatch(/names no action/);
    });

    it('refuses a DOTTED action name - it would reach past actions. into another namespace', () => {
        for (const bad of ['formatters.moneyDisplay', 'actions.probeEquip', '../x', 'a b']) {
            const got = readMenuActionRequest({ type: MENU_ACTION_MESSAGE, action: bad });
            expect(got.ok, bad).toBe(false);
            expect(got.reason, bad).toMatch(/not a plain name/);
        }
    });
});

describe('the inputs request + guard (D8) — what a verb needs is the engine\'s answer, the host checks only the shape', () => {
    it('reads the inputs request under the same three outcomes as the action request', () => {
        expect(readMenuActionInputsRequest({ type: MENU_ACTION_MESSAGE, action: 'equip' }).mine).toBe(false);
        const got = readMenuActionInputsRequest({ type: MENU_ACTION_INPUTS_MESSAGE, action: 'equip', args: { itemKey: 'Sword' }, requestId: 'mi-3' });
        expect(got).toEqual({ mine: true, ok: true, action: 'equip', args: { itemKey: 'Sword' }, requestId: 'mi-3' });
        expect(readMenuActionInputsRequest({ type: MENU_ACTION_INPUTS_MESSAGE, action: 'actions.equip' }).reason).toMatch(/not a plain name/);
        expect(readMenuActionInputsRequest({ type: MENU_ACTION_INPUTS_MESSAGE }).reason).toMatch(/names no action/);
    });
    it('accepts each of the four kinds the form draws — a pick with bare or labelled scalar options', () => {
        const res = validateMenuInputs([
            { name: 'charPath', kind: 'pick', label: 'Give to', options: [{ value: 'Hero', label: 'The hero' }, 'Rival', 3, true] },
            { name: 'count', kind: 'number', value: 1 },
            { name: 'note', kind: 'text' },
            { name: 'wrap', kind: 'boolean' },
        ]);
        expect(res.ok).toBe(true);
        expect(res.inputs).toHaveLength(4);
    });
    it('MUTATION TARGET — an unknown kind refuses the WHOLE declaration, naming the input and the kinds it could have used', () => {
        const res = validateMenuInputs([{ name: 'ok', kind: 'text' }, { name: 'when', kind: 'date' }]);
        expect(res.ok).toBe(false);
        expect(res.inputs).toHaveLength(0);
        expect(res.reason).toContain('inputs[1] ("when")');
        expect(res.reason).toContain('pick, number, text, boolean');
    });
    it('refuses a pick with no options, an option with no scalar value, a reserved name, a dotted name, a non-array', () => {
        expect(menuInputProblem({ name: 'p', kind: 'pick', options: [] }, 0)).toContain('pick with no options');
        expect(menuInputProblem({ name: 'p', kind: 'pick', options: [{ label: 'x' }] }, 0)).toContain('option[0] has no scalar value');
        expect(menuInputProblem({ name: 'p', kind: 'pick', options: [{ value: { deep: 1 } }] }, 0)).toContain('option[0] has no scalar value');
        expect(menuInputProblem({ name: 'scopePath', kind: 'text' }, 0)).toContain('reserves');
        expect(menuInputProblem({ name: 'a.b', kind: 'text' }, 0)).toContain('no plain name');
        expect(menuInputProblem({ name: 'l', kind: 'text', label: 7 }, 0)).toContain('label must be a string');
        expect(validateMenuInputs({ name: 'x' }).ok).toBe(false);
    });
    it('the content is NOT judged — any label, any option meaning, any number of inputs', () => {
        expect(validateMenuInputs([]).ok).toBe(true);
        expect(menuInputProblem({ name: 'x', kind: 'pick', label: '', options: [{ value: 'anything', label: 'whatever the engine says' }] }, 0)).toBe('');
    });
    it('MENU_INPUT_KINDS is the closed list the form draws', () => {
        expect(MENU_INPUT_KINDS).toEqual(['pick', 'number', 'text', 'boolean']);
    });
});

describe('toMvuPatchOps - the menu vocabulary is not MVU vocabulary', () => {
    it('turns a dotted path into a JSON Pointer', () => {
        expect(toMvuPatchOps([{ op: 'set', path: 'Mainchar.Equipment.Sword', value: 'equipped' }]))
            .toEqual([{ op: 'add', path: '/Mainchar/Equipment/Sword', value: 'equipped' }]);
    });

    it('keeps a key in any script whole, and escapes "/" and "~" per RFC 6901 (MVU decodes the same two)', () => {
        expect(toMvuPatchOps([{ op: 'set', path: 'Mainchar.Skills.專屬輔助模組.Desc', value: 'x' }])[0].path)
            .toBe('/Mainchar/Skills/專屬輔助模組/Desc');
        // MUTATION TARGET: drop the escape and the "/" splits one key into two levels.
        expect(toMvuPatchOps([{ op: 'set', path: 'Mainchar.Skills.常駐被動/領域型 ~α.Desc', value: 'x' }])[0].path)
            .toBe('/Mainchar/Skills/常駐被動~1領域型 ~0α/Desc');
    });

    it('maps set to ADD, never replace - a menu legitimately creates a member', () => {
        // replace requires the member to exist; the probe equip writes a slot that may never have
        // been set. add covers create AND overwrite, replace covers half.
        const ops = toMvuPatchOps([{ op: 'set', path: 'A.B', value: 1 }]);
        expect(ops[0].op).toBe('add');
        expect(ops[0].op).not.toBe('replace');
    });

    it('maps delete to remove and carries NO value', () => {
        const ops = toMvuPatchOps([{ op: 'delete', path: 'Mainchar.Inventory.Sword' }]);
        expect(ops).toEqual([{ op: 'remove', path: '/Mainchar/Inventory/Sword' }]);
        expect('value' in ops[0]).toBe(false);
    });

    it('emits only verbs the shared op contract accepts', () => {
        const ops = toMvuPatchOps([{ op: 'set', path: 'A', value: 1 }, { op: 'delete', path: 'B' }]);
        for (const o of ops) expect(PATCH_VERBS).toContain(o.op);
    });

    it('preserves order and falsy values, and is empty for nothing', () => {
        const ops = toMvuPatchOps([{ op: 'set', path: 'A', value: 0 }, { op: 'set', path: 'B', value: false }, { op: 'set', path: 'C', value: '' }]);
        expect(ops.map((o) => o.path)).toEqual(['/A', '/B', '/C']);
        expect(ops.map((o) => o.value)).toEqual([0, false, '']);
        expect(toMvuPatchOps([])).toEqual([]);
        expect(toMvuPatchOps(null)).toEqual([]);
    });

    it('round-trips the probe equip action through validate -> translate', () => {
        const patches = [
            { op: 'delete', path: 'Mainchar.Inventory.ProbeItem' },
            { op: 'set', path: 'Mainchar.Equipment.ProbeItem', value: 'probe-equipped' },
        ];
        const verdict = validateMenuPatches(patches);
        expect(verdict.ok).toBe(true);
        expect(toMvuPatchOps(verdict.patches)).toEqual([
            { op: 'remove', path: '/Mainchar/Inventory/ProbeItem' },
            { op: 'add', path: '/Mainchar/Equipment/ProbeItem', value: 'probe-equipped' },
        ]);
    });
});

describe('readMenuFormatterRequest — the renderer-built batch (B2 seam)', () => {
    const req = (over) => ({ cellId: 'f:moneyDisplay@root', field: 'text', formatterName: 'moneyDisplay', scopePath: '', ...over });
    const msg = (over) => ({ type: MENU_FORMATTER_MESSAGE, requestId: 'pf-1', requests: [req()], ...over });

    it('not our message → mine:false, in silence', () => {
        expect(readMenuFormatterRequest({ type: 'someone-elses' }).mine).toBe(false);
        expect(readMenuFormatterRequest(null).mine).toBe(false);
        expect(readMenuFormatterRequest(['x']).mine).toBe(false);
    });
    it('a well-formed batch passes with its requestId echoed', () => {
        const r = readMenuFormatterRequest(msg());
        expect(r).toMatchObject({ mine: true, ok: true, requestId: 'pf-1' });
        expect(r.requests).toEqual([{ cellId: 'f:moneyDisplay@root', field: 'text', formatterName: 'moneyDisplay', scopePath: '' }]);
    });
    it('an absent scopePath normalises to "" (the whole snapshot)', () => {
        const r = readMenuFormatterRequest(msg({ requests: [{ cellId: 'c', field: 'text', formatterName: 'x' }] }));
        expect(r.ok).toBe(true);
        expect(r.requests[0].scopePath).toBe('');
    });
    it('an empty batch is ours and malformed, never silently fine', () => {
        const r = readMenuFormatterRequest(msg({ requests: [] }));
        expect(r.mine).toBe(true);
        expect(r.ok).toBe(false);
    });
    it('a missing field names the offender by index', () => {
        const r = readMenuFormatterRequest(msg({ requests: [req(), { cellId: 'c', field: 'text', formatterName: '' }] }));
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('requests[1]');
        expect(r.reason).toContain('formatterName');
    });
    it('a dotted formatter name is refused — the surface is formatters.<name> and nothing else', () => {
        const r = readMenuFormatterRequest(msg({ requests: [req({ formatterName: 'actions.probeEquip' })] }));
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('plain name');
    });
    it('a non-string scopePath is refused', () => {
        const r = readMenuFormatterRequest(msg({ requests: [req({ scopePath: 42 })] }));
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('scopePath');
    });
    it('the cap refuses the WHOLE batch rather than truncating it', () => {
        const many = Array.from({ length: 513 }, (_, i) => req({ cellId: 'c' + i }));
        const r = readMenuFormatterRequest(msg({ requests: many }));
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('513');
    });
    it('the wire constant is the one the builder ships', () => {
        expect(MENU_FORMATTER_MESSAGE).toBe('mvu-helper:statusmenu-formatters');
    });
    // The menu answers "did not answer" for any reply without a map; the page is the one place that
    // knows WHY it could not serve, so it says so (the dispatcher is host-coupled, so the guard reads it).
    it('MUTATION TARGET — a batch the page cannot serve is said with its reason, not only answered', () => {
        const dispatcher = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/features/statusmenu-pack/statusmenu-dispatcher.js'), 'utf8').replace(/\r/g, '');
        const lane = dispatcher.slice(dispatcher.indexOf('const batch = readMenuFormatterRequest('), dispatcher.indexOf('const asked = readMenuActionInputsRequest('));
        expect(lane).toMatch(/if \(!res\.ok\) \{\s*log\.lifecycle\('formatter batch from '/);
        expect(lane).toContain("' not served: ' + res.reason");
    });
});

describe('menuFormatterCalls — what a formatter is handed: (stat, root, scopePath)', () => {
    const state = { Mainchar: { Money: [5, 'coins'] }, Classmate: { Airi: { Name: ['Airi', 'Name'] }, Umi: { Name: ['Umi', 'Name'] } } };
    const request = (formatterName, scopePath) => ({ cellId: 'f:' + formatterName + '@' + (scopePath || 'root'), field: 'text', formatterName, scopePath });

    it('MUTATION TARGET — a collection cell gets its ITEM, the snapshot, and the path the item was read from', () => {
        const [call] = menuFormatterCalls(state, [request('profile', 'Classmate.Airi')]);
        expect(call.name).toBe('formatters.profile');
        expect(call.args[0]).toBe(state.Classmate.Airi);
        expect(call.args[1]).toBe(state);
        expect(call.args[2]).toBe('Classmate.Airi');
    });
    it('an empty scopePath hands the whole snapshot as stat and "" as the path', () => {
        const [call] = menuFormatterCalls(state, [request('money', '')]);
        expect(call.args[0]).toBe(state);
        expect(call.args[2]).toBe('');
    });
    it('stat stays RAW — a [value, label] pair reaches the formatter whole', () => {
        const [call] = menuFormatterCalls(state, [request('money', 'Mainchar.Money')]);
        expect(call.args[0]).toEqual([5, 'coins']);
    });
    it('one call per request, in request order', () => {
        const calls = menuFormatterCalls(state, [request('profile', 'Classmate.Airi'), request('profile', 'Classmate.Umi')]);
        expect(calls.map((c) => c.args[2])).toEqual(['Classmate.Airi', 'Classmate.Umi']);
    });
    it('a formatter in the Worker reads WHICH item it draws off the path', async () => {
        const posts = [];
        const runtime = createEngineWorkerRuntime({
            post: (m) => posts.push(m),
            execute: (code, host) => { const module_ = { exports: {} }; new Function('module', 'exports', 'window', 'globalThis', code)(module_, module_.exports, host, host); return module_.exports; },
            buildHost: () => ({}),
        });
        runtime.handle({ t: 'load', texts: [{ scope: 'statusmenu', code: `module.exports = { formatters: {
            profile(stat, root, scopePath) { return scopePath.split('.').pop() + ':' + stat.Name[0]; },
        } };` }], host: {} });
        runtime.handle({ t: 'callBatch', id: 9, scope: 'statusmenu', host: {}, calls: menuFormatterCalls(state, [request('profile', 'Classmate.Umi')]) });
        await new Promise((r) => setTimeout(r, 0));
        expect(posts.find((m) => m.id === 9).value[0]).toEqual({ ok: true, value: 'Umi:Umi' });
    });
});

describe('menuReloadReason — what a rendered menu shows is stale until the chat reloads', () => {
    it('MUTATION TARGET — a layout change alone asks for the reload, and says so', () => {
        expect(menuReloadReason({ layoutChanged: true })).toBe('the layout changed');
    });

    it('MUTATION TARGET — an engine change alone asks for it too: formatter values are computed at render time', () => {
        expect(menuReloadReason({ engineChanged: true })).toBe('the engine text changed');
    });

    it('nothing changed asks for NOTHING — an unchanged re-apply must cost no reload', () => {
        expect(menuReloadReason()).toBe('');
        expect(menuReloadReason({})).toBe('');
        expect(menuReloadReason({ layoutChanged: false, engineChanged: false, regexesChanged: false })).toBe('');
    });

    it('several changes are ONE reason, so the operation reloads once and the log names every cause', () => {
        expect(menuReloadReason({ layoutChanged: true, engineChanged: true, regexesChanged: true }))
            .toBe('the layout changed and the engine text changed and the regexes changed');
    });
});

describe('G4 — one placeholder owner per card (placeholderClaimants + shellInstallDisposition)', () => {
    const rx = (script_name, find_regex, enabled = true) => ({ script_name, find_regex, enabled });

    it('finds the literal shell trigger and any pattern that would fire on it, in apply order', () => {
        const names = placeholderClaimants([
            rx('StatusMenu', MENU_PLACEHOLDER),
            rx('HideAll', '/.*/s'),                       // matches everything — a claimant too
            rx('Unrelated', '/<GameStartMenu\\/>/'),
        ]);
        expect(names).toEqual(['StatusMenu', 'HideAll']);
    });
    it('a DISABLED claimant is not a claimant — disabling is how a user parks a second menu', () => {
        expect(placeholderClaimants([rx('Parked', MENU_PLACEHOLDER, false)])).toEqual([]);
    });
    it('an uncompilable pattern never fires in ST either, so it cannot claim', () => {
        expect(placeholderClaimants([rx('Broken', '/[unclosed/')])).toEqual([]);
    });
    it('no claimant ⇒ install; the shell alone ⇒ present', () => {
        expect(shellInstallDisposition({ claimants: [], shellName: 'StatusMenu' }).action).toBe('install');
        expect(shellInstallDisposition({ claimants: ['StatusMenu'], shellName: 'StatusMenu' }).action).toBe('present');
    });
    it('ONE foreign claimant is OWNED, not a conflict — nothing is installed and nothing is wrong', () => {
        const v = shellInstallDisposition({ claimants: ['MyHandmadeMenu'], shellName: 'StatusMenu' });
        expect(v.action).toBe('owned');
        expect(v.reasons[0]).toContain('MyHandmadeMenu');
        // A single owner is not first-wins, so the reader must not be told to remove anything.
        expect(v.reasons[0]).not.toContain('remove');
        expect(v.reasons[0]).not.toContain('MULTIPLE');
    });
    it('MUTATION target — the marker-last row is NOT a claimant: it renders nothing and WE wrote it', () => {
        // Live 2026-09-06: a pack shipping its own shell installed correctly and still reported
        // "MULTIPLE enabled claimants: StatusMenu Keep Last, StatusMenu", advising removal of the
        // ordering row this installer had just written. Counting it inflates every correct install.
        const v = shellInstallDisposition({ claimants: [MARKER_LAST_REGEX_NAME, 'StatusMenu'], shellName: 'StatusMenuPlaceholder' });
        expect(v.action).toBe('owned');
        expect(v.reasons[0]).not.toContain(MARKER_LAST_REGEX_NAME);
        // and alone it claims nothing at all
        expect(shellInstallDisposition({ claimants: [MARKER_LAST_REGEX_NAME], shellName: 'StatusMenuPlaceholder' }).action).toBe('install');
    });
    it('MUTATION target — TWO real claimants IS a conflict: first-wins is already deciding', () => {
        const v = shellInstallDisposition({ claimants: ['StatusMenu', 'SecondMenu'], shellName: 'StatusMenu' });
        expect(v.action).toBe('conflict');
        expect(v.reasons[0]).toContain('SecondMenu');
        expect(v.reasons[0]).toContain('MULTIPLE');
        // our own shell plus a foreign one still fires, marker row or not
        expect(shellInstallDisposition({ claimants: [MARKER_LAST_REGEX_NAME, 'A', 'B'], shellName: 'StatusMenu' }).action).toBe('conflict');
    });
    it('the registry round-trips shellOwned, and an older registry without it reads false', () => {
        const reg = { activeMenuId: 'm', ver: '1', installedComments: [], engineOwned: false, installedRegexNames: [], shellOwned: true, installedAt: '' };
        expect(parseMenuRegistry(buildMenuRegistryContent(reg)).shellOwned).toBe(true);
        expect(parseMenuRegistry('{"activeMenuId":"m"}').shellOwned).toBe(false);
    });
});

// This lane re-derived the ORDERING locally (`!isCardOpen || !isChatStarted` first), which put the
// message count ahead of the book — the same conflation card-access-core's header records. It now
// consumes the shared ordering AND the shared sentence.
describe('decideMenuActivation — book state outranks the message count', () => {
    const menu = { packType: 'statusmenu', id: 'm', version: '1' };

    it('an unreadable book on an UNSTARTED chat reports the book, not "open a chat"', () => {
        const r = decideMenuActivation({
            isCardOpen: true, isChatStarted: false, areEntriesReadable: false,
            bookBinding: 'embedded-not-imported', pack: menu, registry: null,
        });
        expect(r.action).toBe('card-unreadable');
        expect(r.reasons[0]).toContain('Import Card Lore');
    });

    it('the lobby is still no-chat, whatever the book facts say', () => {
        const r = decideMenuActivation({
            isCardOpen: false, isChatStarted: true, areEntriesReadable: false,
            bookBinding: 'no-book-bound', pack: menu, registry: null,
        });
        expect(r.action).toBe('no-chat');
    });

    it('a card open on an unstarted chat with a readable book is the classic no-chat', () => {
        const r = decideMenuActivation({
            isCardOpen: true, isChatStarted: false, areEntriesReadable: true,
            pack: menu, registry: null,
        });
        expect(r.action).toBe('no-chat');
    });

    it('a book that exists but has not answered keeps the honest wait', () => {
        const r = decideMenuActivation({
            isCardOpen: true, isChatStarted: true, areEntriesReadable: false,
            bookBinding: 'loading', pack: menu, registry: null,
        });
        expect(r.reasons[0]).toContain('Retry in a moment');
    });
});

// A regex fenced to OLD messages is not competing for the menu, which renders on the newest one.
// Live 2026-08-31: School's HideFarFloor (`/.*/s`, empty replacement, min_depth 10) matched the
// placeholder textually, so G4 called it a second claimant and stood its own install down over a row
// that can never touch depth 0. SillyTavern skips a script when `depth < minDepth` (regex/engine.js).
describe('placeholderClaimants — depth decides whether a match is a CONTEST', () => {
    const row = (extra) => ({ script_name: 'X', enabled: true, find_regex: '/.*/s', ...extra });

    it('a min_depth above 0 is NOT a claimant — it never runs where the menu draws', () => {
        expect(placeholderClaimants([row({ script_name: 'HideFarFloor', min_depth: 10 })])).toEqual([]);
        expect(placeholderClaimants([row({ min_depth: 1 })])).toEqual([]);
    });

    it('no floor, zero, or ST\'s ignored negatives all still claim', () => {
        for (const min_depth of [undefined, null, 0, -1, -5]) {
            expect(placeholderClaimants([row({ min_depth })])).toEqual(['X']);
        }
    });

    it('max_depth can never exclude the newest message, so it never excuses a claimant', () => {
        for (const max_depth of [0, 5, null, undefined]) {
            expect(placeholderClaimants([row({ max_depth })])).toEqual(['X']);
        }
    });

    it('reads the camelCase spelling too — the field arrives both ways', () => {
        expect(placeholderClaimants([row({ minDepth: 10 })])).toEqual([]);
        expect(placeholderClaimants([row({ minDepth: 0 })])).toEqual(['X']);
    });

    it('a junk depth is not a licence to ignore a real claimant', () => {
        expect(placeholderClaimants([row({ min_depth: 'later' })])).toEqual(['X']);
    });

    // The case that matters end to end: the real shell plus School's real hider is ONE claimant.
    it('the live pair reduces to the shell alone', () => {
        expect(placeholderClaimants([
            { script_name: 'StatusMenu', enabled: true, find_regex: '<StatusPlaceHolderImpl/>' },
            { script_name: 'HideFarFloor', enabled: true, find_regex: '/.*/s', min_depth: 10, replace_string: '' },
        ])).toEqual(['StatusMenu']);
    });
});

// ── the LIFT (plans/executed/statusmenu-containment.md M2) — nothing this lane writes reaches TavernHelper ──
//
// What each block guards, and the mutation that proves the guard is one (run by hand, recorded):
//   • the menu row leaves the card in MARKER form and its text goes to the body, verbatim;
//   • the transform is idempotent, so a re-apply compares equal and pays no chat reload;
//   • every written row is held to TavernHelper's OWN predicate — MUTATION: delete the invariant loop
//     in liftMenuRegexRows and the "<body outside a fence" case passes a row TavernHelper would render;
//   • a second fence, a bare fence, an empty fence each refuse BY NAME, never pass through warned.
describe('liftMenuRegexRows — every fenced row leaves the card in marker form', () => {
    const FENCE = String.fromCharCode(96).repeat(3);
    const document = '<!DOCTYPE html>\n<html lang="en">\n<head><title>m</title></head>\n<body><script>const s = "</html>";</script></body>\n</html>';
    const shipped = wrapRenderedRegion('statusmenu', FENCE + '\n' + document + '\n' + FENCE);
    // School ships a second wrapped document in its OWN region beside the menu — the game-start form.
    const startForm = wrapRenderedRegion('game-start-menu', FENCE + '\n<!DOCTYPE html>\n<html><body><form class="gs-card"></form></body></html>\n' + FENCE);
    const menuRow = { script_name: 'StatusMenu', find_regex: '<StatusPlaceHolderImpl/>', replace_string: shipped, enabled: true };
    const startRow = { script_name: '<GameStartMenu/>', find_regex: '<GameStartMenu/>', replace_string: startForm, enabled: true };
    const hider = { script_name: 'HideFarFloor', find_regex: '/.*/s', min_depth: 10, replace_string: '', enabled: true };

    it('lifts EACH fenced row into its own region\'s marker form and hands every text back verbatim', () => {
        const lift = liftMenuRegexRows([startRow, menuRow, hider], 'artifickoi');
        expect(lift.ok).toBe(true);
        expect(lift.lifted).toEqual([
            { name: '<GameStartMenu/>', regionName: 'game-start-menu', text: startForm },
            { name: 'StatusMenu', regionName: 'statusmenu', text: shipped },
        ]);
        expect(lift.rows[0].replace_string).toBe(menuMarkerRowText('artifickoi', 'game-start-menu', '<GameStartMenu/>'));
        expect(lift.rows[0].replace_string).toContain('data-mvu-helper="game-start-menu"');
        expect(lift.rows[1].replace_string).toBe(menuMarkerRowText('artifickoi', 'statusmenu', 'StatusMenu'));
        expect(lift.rows[1].replace_string).toContain(MENU_MOUNT_ATTRIBUTE + '="artifickoi"');
        expect(lift.rows[1].replace_string).toContain(MENU_MOUNT_ROW_ATTRIBUTE + '="StatusMenu"');
        expect(lift.rows[1].replace_string).not.toContain(FENCE);
        expect(lift.rows[1].find_regex).toBe(menuRow.find_regex);   // only replace_string moves
        expect(lift.rows[2]).toBe(hider);                             // a fence-less row passes through untouched
        // the marker names its row, escaped and recoverable — a script_name may carry < > /
        expect(menuMarkerRowName(lift.rows[0].replace_string)).toBe('<GameStartMenu/>');
        expect(menuMarkerRowName(lift.rows[1].replace_string)).toBe('StatusMenu');
    });

    it('is idempotent — lifting the written rows again changes nothing and lifts nothing', () => {
        const once = liftMenuRegexRows([startRow, menuRow, hider], 'artifickoi');
        const twice = liftMenuRegexRows(once.rows, 'artifickoi');
        expect(twice.ok).toBe(true);
        expect(twice.rows).toEqual(once.rows);
        expect(twice.lifted).toEqual([]);
    });

    it('a pack with no document (the placeholder shell + the marker-last row) lifts nothing and passes whole', () => {
        const lift = liftMenuRegexRows([PLACEHOLDER_SHELL_REGEX, MARKER_LAST_REGEX], 'blank');
        expect(lift.ok).toBe(true);
        expect(lift.lifted).toEqual([]);
        expect(lift.rows).toEqual([PLACEHOLDER_SHELL_REGEX, MARKER_LAST_REGEX]);
        // and both of mvu-helper's own rows are TavernHelper-inert by construction
        expect(isTavernHelperFrontendText(PLACEHOLDER_SHELL_REGEX.replace_string)).toBe(false);
        expect(isTavernHelperFrontendText(MARKER_LAST_REGEX.replace_string)).toBe(false);
    });

    it('every written row passes TavernHelper\'s predicate; none of the three tokens survives outside a lifted fence', () => {
        const lift = liftMenuRegexRows([startRow, menuRow, hider], 'artifickoi');
        for (const row of lift.rows) expect(isTavernHelperFrontendText(row.replace_string)).toBe(false);
    });

    it('MUTATION TARGET — "<body" outside any fence refuses the install by row name and token', () => {
        const sneaky = { script_name: 'Decor', find_regex: '/x/', replace_string: '<div><body class="x">hi</div>', enabled: true };
        const lift = liftMenuRegexRows([menuRow, sneaky], 'artifickoi');
        expect(lift.ok).toBe(false);
        expect(lift.reason).toContain('"Decor"');
        expect(lift.reason).toContain('"<body"');
    });

    it('a fenced row with NO region wrapper refuses — there is no boundary to lift by', () => {
        const bare = { ...menuRow, replace_string: FENCE + '\n' + document + '\n' + FENCE };
        const lift = liftMenuRegexRows([bare], 'artifickoi');
        expect(lift.ok).toBe(false);
        expect(lift.reason).toContain('"StatusMenu"');
        expect(lift.reason).toContain('mvu-helper:begin');
    });

    it('a wrapper that is not the ONE accepted shape refuses with the unwrap problem, not a guess', () => {
        const two = { ...menuRow, replace_string: wrapRenderedRegion('statusmenu', FENCE + '\nA\n' + FENCE + '\n' + FENCE + '\nB\n' + FENCE) };
        const lift = liftMenuRegexRows([two], 'artifickoi');
        expect(lift.ok).toBe(false);
        expect(lift.reason).toContain('fence');
        expect(lift.reason).toContain('MvuStatMenuBuilder');
    });

    it('the same row name twice refuses — the name is the document\'s identity on the card', () => {
        const lift = liftMenuRegexRows([menuRow, { ...menuRow }], 'artifickoi');
        expect(lift.ok).toBe(false);
        expect(lift.reason).toContain('twice');
    });

    it('an empty fence refuses — nothing to lift, nothing to render', () => {
        const empty = { ...menuRow, replace_string: wrapRenderedRegion('statusmenu', FENCE + '\n\n' + FENCE) };
        expect(liftMenuRegexRows([empty], 'artifickoi').ok).toBe(false);
        expect(liftMenuRegexRows([empty], 'artifickoi').reason).toContain('EMPTY');
    });

    it('no rows at all is a valid pack that lifts nothing', () => {
        expect(liftMenuRegexRows(undefined, 'x')).toEqual({ ok: true, rows: [], lifted: [] });
    });
});

describe('restoreLiftedMenuRows — the export puts every verbatim text back', () => {
    const FENCE = String.fromCharCode(96).repeat(3);
    const shipped = wrapRenderedRegion('statusmenu', FENCE + '\n<html><body>x</body></html>\n' + FENCE);
    const startForm = wrapRenderedRegion('game-start-menu', FENCE + '\n<html><body>form</body></html>\n' + FENCE);
    const menuRow = { script_name: 'StatusMenu', find_regex: '<StatusPlaceHolderImpl/>', replace_string: shipped };
    const startRow = { script_name: '<GameStartMenu/>', find_regex: '<GameStartMenu/>', replace_string: startForm };
    const other = { script_name: 'Other', find_regex: '/y/', replace_string: 'plain' };
    const bodiesOf = (lift) => Object.fromEntries(lift.lifted.map((l) => [l.name, l.text]));

    it('recognises exactly the marker form: mount attribute present, no fence', () => {
        expect(isMenuMarkerRowText(menuMarkerRowText('p', 'statusmenu', 'StatusMenu'))).toBe(true);
        expect(isMenuMarkerRowText(shipped)).toBe(false);
        expect(isMenuMarkerRowText(wrapRenderedRegion('statusmenu', ''))).toBe(false);   // no pack named: not ours
        expect(isMenuMarkerRowText(null)).toBe(false);
    });

    it('round-trips: restore(lift(rows)) equals rows, every row by its own name', () => {
        const lift = liftMenuRegexRows([startRow, menuRow, other], 'p');
        expect(restoreLiftedMenuRows(lift.rows, bodiesOf(lift))).toEqual({ rows: [startRow, menuRow, other], problem: null });
    });

    it('refuses by name when a marker row is on the card and its text is missing', () => {
        const lift = liftMenuRegexRows([startRow, menuRow, other], 'p');
        const res = restoreLiftedMenuRows(lift.rows, { StatusMenu: shipped });
        expect(res.problem).toContain('"<GameStartMenu/>"');
        expect(res.problem).toContain(menuBodyComment('<GameStartMenu/>'));
        expect(res.rows).toEqual(lift.rows);
    });

    it('rows with no marker form need no text and are returned as they are', () => {
        expect(restoreLiftedMenuRows([other], null)).toEqual({ rows: [other], problem: null });
    });

    it('the body entry comment carries the row name and gives it back, whatever the name holds', () => {
        expect(menuBodyComment('<GameStartMenu/>')).toBe('[MVU_StatusMenuBody:<GameStartMenu/>]');
        expect(menuBodyRowName('[mvu_statusmenubody:<GameStartMenu/>]')).toBe('<GameStartMenu/>');
        expect(menuBodyRowName('[MVU_StatusMenuEngine]')).toBe('');
        expect(menuBodyRowName(null)).toBe('');
    });
});

describe('the registry, the LED and the reload reason carry the lifted documents', () => {
    it('liftedRows round-trips, and an older registry without it reads as none', () => {
        const reg = { activeMenuId: 'm', ver: '1', installedComments: [], engineOwned: false, installedRegexNames: [], shellOwned: false, liftedRows: ['StatusMenu', '<GameStartMenu/>'], installedAt: '' };
        expect(parseMenuRegistry(buildMenuRegistryContent(reg)).liftedRows).toEqual(['StatusMenu', '<GameStartMenu/>']);
        expect(parseMenuRegistry('{"activeMenuId":"m"}').liftedRows).toEqual([]);
    });

    it('a RECORDED lifted row whose entry is absent is red and named; an unrecorded absence is not', () => {
        const base = { inLibrary: true, isActive: true, recordedComments: [], presentComments: [], recordedRegexNames: [], presentRegexNames: [] };
        const red = deriveMenuLed({ ...base, liftedRows: ['StatusMenu', '<GameStartMenu/>'], presentBodyRows: ['StatusMenu'] });
        expect(red.state).toBe('red');
        expect(red.missing).toContain('[MVU_StatusMenuBody:<GameStartMenu/>]');
        expect(red.missing).not.toContain('[MVU_StatusMenuBody:StatusMenu]');
        expect(deriveMenuLed({ ...base, liftedRows: [], presentBodyRows: [] }).state).not.toBe('red');
        expect(deriveMenuLed({ ...base, liftedRows: ['StatusMenu'], presentBodyRows: ['StatusMenu'] }).state).not.toBe('red');
        // both owned pieces missing are BOTH named — a count alone would let one hide the other
        const both = deriveMenuLed({ ...base, ownedSlots: menuOwnedSlots({ engineOwned: true }, { text: '', found: false }), liftedRows: ['StatusMenu'], presentBodyRows: [] });
        expect(both.missing).toEqual(expect.arrayContaining(['[MVU_StatusMenuEngine]', '[MVU_StatusMenuBody:StatusMenu]']));
    });

    it('a changed document is a reload reason of its own — the marker row is byte-stable, so nothing else would say so', () => {
        expect(menuReloadReason({ bodyChanged: true })).toBe('the menu document changed');
        expect(menuReloadReason({ regexesChanged: false, bodyChanged: false })).toBe('');
    });
});

describe('auditMenuRows — the gate\'s edge, named (M7)', () => {
    const FENCE = String.fromCharCode(96).repeat(3);
    const shipped = wrapRenderedRegion('statusmenu', FENCE + '\n<html><body>x</body></html>\n' + FENCE);
    const claimant = (script_name, replace_string, over = {}) => ({ script_name, find_regex: '<StatusPlaceHolderImpl/>', enabled: true, replace_string, ...over });

    it('an installed row still carrying a document is PRE-LIFT whatever it fires on; a foreign claimant is UNCONTAINED', () => {
        const startRow = { script_name: '<GameStartMenu/>', find_regex: '<GameStartMenu/>', enabled: true, replace_string: shipped };
        const rows = [claimant('StatusMenu', shipped), startRow, claimant('HandMade', shipped)];
        expect(auditMenuRows({ cardRegexes: rows, installedRegexNames: ['StatusMenu', '<GameStartMenu/>', MARKER_LAST_REGEX_NAME] })).toEqual([
            { name: 'StatusMenu', verdict: 'pre-lift' },
            { name: '<GameStartMenu/>', verdict: 'pre-lift' },
            { name: 'HandMade', verdict: 'uncontained' },
        ]);
    });
    it('a lifted card is silent: the marker form carries nothing TavernHelper renders', () => {
        const rows = [claimant('StatusMenu', menuMarkerRowText('artifickoi', 'statusmenu', 'StatusMenu')), MARKER_LAST_REGEX];
        expect(auditMenuRows({ cardRegexes: rows, installedRegexNames: ['StatusMenu', MARKER_LAST_REGEX_NAME] })).toEqual([]);
    });
    it('a DISABLED claimant renders nothing and is not named; neither is a frontend that is not a menu', () => {
        const parked = claimant('Parked', shipped, { enabled: false });
        const galgame = { script_name: 'Galgame', find_regex: '/<GalgameBoot\\/>/', enabled: true, replace_string: shipped };
        expect(auditMenuRows({ cardRegexes: [parked, galgame], installedRegexNames: [] })).toEqual([]);
    });
    it('no card, no registry — nothing to say', () => {
        expect(auditMenuRows({})).toEqual([]);
        expect(auditMenuRows({ cardRegexes: null, installedRegexNames: null })).toEqual([]);
    });
});

// The dev upload's status: the stored engine, or why there is none — and nothing while the card cannot be read.
describe('menuEngineStatusView', () => {
    // MUTATION TARGET: an unreadable lorebook often never answers, so a "Refresh tries again" here contradicts the notice.
    it('a card that cannot be read: nothing, since the tab notices say why', () => {
        expect(menuEngineStatusView({ isCardReadable: false, read: null })).toBeNull();
    });
    it('a lorebook not ready yet, and a card with no engine, each an empty state of its own', () => {
        expect(menuEngineStatusView({ isCardReadable: true, read: null })).toEqual({
            empty: { text: "The card's lorebook is not ready yet. Refresh tries again.", icon: 'fa-hourglass-half' },
        });
        expect(menuEngineStatusView({ isCardReadable: true, read: { found: false } })).toEqual({
            empty: { text: 'No StatusMenu Engine on this card.', icon: 'fa-file-circle-xmark' },
        });
    });
    it('a stored engine: its declared version and size, or ? for none declared', () => {
        const text = ['const ENGINE_VERSION = "v1.4";', 'x'.repeat(2000)].join(' ');
        expect(menuEngineStatusView({ isCardReadable: true, read: { found: true, text } }).row.sub).toEqual({ text: 'Installed', name: 'v1.4 · 2.0 KB' });
        expect(menuEngineStatusView({ isCardReadable: true, read: { found: true, text: 'module.exports = {}' } }).row.sub.name).toBe('? · 0.0 KB');
    });
});
